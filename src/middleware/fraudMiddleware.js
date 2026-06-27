const fraudService = require('../services/fraudDetectionService');
const logger = require('../utils/logger');

// ─── Pré-filtre synchrone (Node.js, sans passer par Rust) ────────────────────
// Détecte les patterns d'injection évidents AVANT d'envoyer la requête au contrôleur.
// Rust analyse en background pour les cas ambigus.
const QUICK_BLOCK = [
  // SQL injection basique OR/AND
  { name: 'sql_basic',    re: /('|"|\b1\b)\s+(or|and)\s+('|"|\b1\b|\d+)\s*(=\s*|--|#)/i },
  // SQL injection avancée
  { name: 'sql_union',    re: /\bunion\b.{0,40}\bselect\b|\bdrop\s+table|\bexec\s*\(/i },
  // Command injection — semicolon before shell command
  { name: 'cmd_inject',   re: /;\s*(cat|ls|id|whoami|wget|curl|bash|sh|nc|python|perl)\b|`[^`]{2,}`|\$\([^)]{2,}\)/i },
  // Path traversal
  { name: 'path_trav',    re: /\.\.(\/|\\|%2f|%5c)|%252e%252e/i },
  // SSRF — known internal metadata endpoints
  { name: 'ssrf',         re: /169\.254\.169\.254|metadata\.google\.internal|127\.\d+\.\d+\.\d+(?:[:/])|file:\/\/|gopher:\/\//i },
  // XSS — script/event handlers
  { name: 'xss',          re: /<script[\s>]|javascript\s*:|on(?:load|error|click|mouse\w+)\s*=/i },
  // XXE
  { name: 'xxe',          re: /<!entity\s|<!doctype\s.+system\s|expect:\/\/|php:\/\//i },
  // Template injection
  { name: 'tpl_inject',   re: /\{\{.{1,40}\}\}|\$\{.{1,40}\}|#\{.{1,40}\}/i },
];

function quickScan(req) {
  const parts = [
    req.path || '',
    req.url  || '',
    new URLSearchParams(req.query || {}).toString(),
  ];
  // Inclure body texte si disponible (parsed avant ce middleware)
  if (typeof req.body === 'string') parts.push(req.body.slice(0, 1024));
  else if (req.body && typeof req.body === 'object') {
    try { parts.push(JSON.stringify(req.body).slice(0, 1024)); } catch {}
  }

  const target = parts.join(' ');
  for (const { name, re } of QUICK_BLOCK) {
    if (re.test(target)) return name;
  }
  return null;
}

// Helper: extract client IP through proxy headers
function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    '0.0.0.0'
  );
}

// Helper: extract device fingerprint from headers
function getDeviceId(req) {
  return (
    req.headers['x-device-id'] ||
    req.headers['x-fingerprint'] ||
    req.headers['user-agent']?.slice(0, 64) ||
    'unknown'
  );
}

// ─── Middleware 1: Check if IP is blocked (fast, before any processing) ────────
const blockBannedIp = async (req, res, next) => {
  if (!fraudService.isReady()) return next();

  const ip = getIp(req);
  try {
    const blocked = await fraudService.isIpBlocked(ip);
    if (blocked) {
      logger.warn(`[fraud] Blocked IP attempted request: ${ip} → ${req.path}`);
      return res.status(403).json({
        success: false,
        message: 'Accès refusé.',
        code: 'IP_BLOCKED',
      });
    }
  } catch (e) {
    // Fail open — never block legit traffic due to our own error
    logger.debug('[fraud] blockBannedIp error (fail open):', e.message);
  }
  next();
};

// ─── Middleware 2: Login fraud check ──────────────────────────────────────────
// Use BEFORE the controller on POST /auth/login.
// Attaches `req.fraudResult` so the controller can use it.
const checkLogin = (successField = null) => async (req, res, next) => {
  if (!fraudService.isReady()) return next();

  const ip = getIp(req);
  const userId = req.body.username || req.body.email || ip;

  try {
    const result = await fraudService.analyzeLogin({
      userId,
      ip,
      country:   req.headers['x-country']  || '',
      city:      req.headers['x-city']     || '',
      latitude:  parseFloat(req.headers['x-latitude'])  || 0,
      longitude: parseFloat(req.headers['x-longitude']) || 0,
      deviceId:  getDeviceId(req),
      userAgent: req.headers['user-agent'] || '',
      success:   false, // We don't know yet — will report outcome separately
      mfaUsed:   false,
    });

    if (!result) return next(); // Timeout/unavailable → fail open

    req.fraudResult = result;

    if (result.blocked) {
      logger.warn(`[fraud] Login blocked for ${userId} from ${ip} — score ${result.score}`);
      return res.status(429).json({
        success: false,
        message: result.alert?.message || 'Trop de tentatives. Réessayez plus tard.',
        code: result.alert?.type || 'FRAUD_BLOCK',
        retry_after: 900,
      });
    }

    if (result.risk_level === 'Critical' || result.risk_level === 'High') {
      logger.warn(`[fraud] High-risk login attempt — user: ${userId} ip: ${ip} score: ${result.score}`);
      // We still allow the request through but flag it
      req.fraudHighRisk = true;
    }
  } catch (e) {
    logger.debug('[fraud] checkLogin error (fail open):', e.message);
  }

  next();
};

// ─── Middleware 3: Report login outcome (after auth succeeded or failed) ───────
// Call after the controller responds to update Rust's behavioral baseline.
const reportLoginOutcome = (success) => async (req, _res, next) => {
  if (!fraudService.isReady()) return next();

  const ip = getIp(req);
  const userId = req.body.username || req.body.email || ip;

  // Fire-and-forget — don't await, don't block the response
  fraudService.analyzeLogin({
    userId,
    ip,
    country:   req.headers['x-country']  || '',
    city:      req.headers['x-city']     || '',
    latitude:  parseFloat(req.headers['x-latitude'])  || 0,
    longitude: parseFloat(req.headers['x-longitude']) || 0,
    deviceId:  getDeviceId(req),
    userAgent: req.headers['user-agent'] || '',
    success,
    mfaUsed: false,
  }).catch((e) => logger.debug('[fraud] reportLoginOutcome error:', e.message));

  next();
};

// ─── Middleware 4: Payment fraud check ────────────────────────────────────────
// Use BEFORE processing any payment route.
const checkTransaction = async (req, res, next) => {
  if (!fraudService.isReady()) return next();

  const ip = getIp(req);
  const userId = req.user?.id?.toString() || req.user?.username || ip;
  const body = req.body || {};

  try {
    const result = await fraudService.analyzeTransaction({
      userId,
      ip,
      amount:          parseFloat(body.amount) || 0,
      currency:        body.currency || 'EUR',
      merchantId:      body.merchantId || body.currencyId || '',
      merchantName:    body.merchantName || '',
      merchantCountry: body.country || 'FR',
      category:        body.category || 'payment',
      cardToken:       body.cardToken || body.deviceToken || '',
      billingZip:      body.billingZip || '',
      shippingZip:     body.shippingZip || null,
      isOnline:        true,
    });

    if (!result) return next();

    req.fraudResult = result;

    if (result.blocked) {
      logger.warn(`[fraud] Transaction blocked — user: ${userId} ip: ${ip} score: ${result.score}`);
      return res.status(402).json({
        success: false,
        message: result.alert?.message || 'Transaction refusée pour des raisons de sécurité.',
        code: result.alert?.type || 'TRANSACTION_BLOCKED',
        fraud_score: result.score,
      });
    }

    if (result.risk_level === 'High') {
      // Add a fraud warning header visible to frontend
      res.setHeader('X-Fraud-Warning', 'true');
      logger.warn(`[fraud] High-risk transaction — user: ${userId} score: ${result.score}`);
    }
  } catch (e) {
    logger.debug('[fraud] checkTransaction error (fail open):', e.message);
  }

  next();
};

// ─── Middleware 5: Global request check (synchrone sur injections, async sinon) ─
const checkApiRequest = async (req, res, next) => {
  const ip = getIp(req);

  // ── 1. Pré-filtre synchrone ultra-rapide (regex Node.js, ~0.1ms) ────────────
  const attackName = quickScan(req);
  if (attackName) {
    logger.warn(`[fraud] Quick-block [${attackName}] ip=${ip} path=${req.path}`);

    // Reporter à Rust en background pour mise à jour de la réputation IP
    if (fraudService.isReady()) {
      const userId = req.user?.id?.toString() || 'anonymous';
      fraudService.analyzeRequest({
        userId, ip,
        endpoint:     req.path || '/',
        method:       req.method,
        userAgent:    req.headers['user-agent'] || '',
        responseCode: 400,
        payloadSize:  parseInt(req.headers['content-length'] || '0'),
        queryParams:  new URLSearchParams(req.query || {}).toString(),
        bodySample:   typeof req.body === 'string' ? req.body.slice(0, 512) : '',
      }).catch(() => {});
    }

    return res.status(403).json({
      success: false,
      message: 'Requête refusée.',
      code:    `ATTACK_${attackName.toUpperCase()}`,
    });
  }

  if (!fraudService.isReady()) return next();

  // ── 2. IP block check (Redis GET, ~1ms) ─────────────────────────────────────
  try {
    const blocked = await fraudService.isIpBlocked(ip);
    if (blocked) {
      return res.status(403).json({
        success: false,
        message: 'Accès refusé.',
        code: 'IP_BLOCKED',
      });
    }
  } catch { /* fail open */ }

  // ── 3. Large payload — vérification synchrone ────────────────────────────────
  const payloadSize = parseInt(req.headers['content-length'] || '0');
  if (payloadSize > 5_000_000) {
    logger.warn(`[fraud] Large payload blocked: ${payloadSize} bytes from ${ip}`);
    return res.status(413).json({
      success: false,
      message: 'Payload trop volumineux.',
      code: 'PAYLOAD_TOO_LARGE',
    });
  }

  // ── 4. Background analysis pour les autres cas (rate limit, patterns subtils) ─
  const userId   = req.user?.id?.toString() || 'anonymous';
  const endpoint = req.path || '/';
  const query    = new URLSearchParams(req.query || {}).toString();
  const body     = typeof req.body === 'string' ? req.body.slice(0, 512) : '';

  fraudService.analyzeRequest({
    userId, ip, endpoint,
    method:       req.method,
    userAgent:    req.headers['user-agent'] || '',
    responseCode: res.statusCode || 200,
    payloadSize,
    queryParams:  query,
    bodySample:   body,
  }).then((result) => {
    if (result?.blocked) {
      logger.warn(`[fraud] Background analysis → IP blocked: ${ip} (score ${result.score})`);
    }
  }).catch(() => {});

  next();
};

module.exports = {
  blockBannedIp,
  checkLogin,
  reportLoginOutcome,
  checkTransaction,
  checkApiRequest,
};
