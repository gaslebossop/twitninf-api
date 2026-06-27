const fraudService = require('../services/fraudDetectionService');
const logger = require('../utils/logger');

// ─── Pré-filtre synchrone (Node.js, sans passer par Rust) ────────────────────
// Détecte les patterns d'injection évidents AVANT d'envoyer la requête au contrôleur.
// Rust analyse en background pour les cas ambigus.
//
// `urlOnly: true` → la règle ne s'applique qu'à l'URL/params/query (jamais au body),
// pour éviter les faux positifs sur du texte légitime (tweets, messages…).
const QUICK_BLOCK = [
  // SQL injection basique OR/AND
  { name: 'sql_basic',    re: /\b(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+|\b(or|and)\s+['"][^'"]{0,40}['"]\s*=\s*['"]|\b(or|and)\s+\d+\s*(--|#)/i },
  // SQL injection avancée
  { name: 'sql_union',    re: /\bunion\b.{0,40}\bselect\b|\bdrop\s+table|\binsert\s+into|\bdelete\s+from|\bexec\s*\(|\bxp_cmdshell|\bwaitfor\s+delay|\bpg_sleep\s*\(|\bsleep\s*\(\s*\d/i },
  // Command injection — semicolon before shell command, pipes, subshells, sensitive paths
  { name: 'cmd_inject',   re: /;\s*(cat|ls|id|whoami|wget|curl|bash|sh|nc|python|perl|ruby|php)\b|\|\s*(bash|sh|cmd|powershell)\b|`[^`]{2,}`|\$\([^)]{2,}\)|\/bin\/(ba)?sh|\/etc\/(passwd|shadow)|cmd\.exe|powershell\s+-/i },
  // Path traversal (inclut double/triple encodage)
  { name: 'path_trav',    re: /\.\.(\/|\\|%2f|%5c)|%252e%252e|%c0%ae|\.\.%c0%af/i, urlOnly: true },
  // Null byte injection
  { name: 'null_byte',    re: /%00|\x00/, urlOnly: true },
  // CRLF / HTTP response splitting / header injection (URL uniquement)
  { name: 'crlf_inject',  re: /%0d%0a|%0a%0d|\r\n/i, urlOnly: true },
  // SSRF — métadonnées cloud, loopback (IPv4/IPv6), IP décimale/hex, schémas internes
  { name: 'ssrf',         re: /169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200|metadata\.azure|fd00:ec2|127\.\d+\.\d+\.\d+(?:[:/])|0x7f[0-9a-f]{6}|\b2130706433\b|\[?::1\]?[:/]|localhost(?:[:/])|0\.0\.0\.0|file:\/\/|gopher:\/\/|dict:\/\/|ftp:\/\//i },
  // XSS — balises, handlers d'événements, schémas dangereux
  { name: 'xss',          re: /<script[\s>]|<\/script>|<iframe[\s>]|<svg[\s>/]|<img[\s>][^>]*\bon\w+\s*=|javascript\s*:|vbscript\s*:|data:text\/html|on(?:load|error|click|mouseover|focus|toggle|animationstart|begin)\s*=/i },
  // XXE
  { name: 'xxe',          re: /<!entity\s|<!doctype\s[^>]+system\s|expect:\/\/|php:\/\/|jar:\/\/|netdoc:\/\//i },
  // Template injection (SSTI)
  { name: 'tpl_inject',   re: /\{\{.{1,60}\}\}|\$\{.{1,60}\}|#\{.{1,60}\}|<%.{1,60}%>|\{%.{1,60}%\}/i },
  // NoSQL / operator injection ($ne, $gt, $where, $regex…)
  { name: 'nosql_inject', re: /(["'\[]\s*)\$(ne|gt|gte|lt|lte|in|nin|eq|where|regex|expr|exists|elemmatch|function|or|and|nor|not|jsonschema)\b|\bmapreduce\b/i },
  // Prototype pollution
  { name: 'proto_pollut', re: /__proto__|constructor\s*\[\s*['"]?prototype|prototype\s*\[\s*['"]?__proto__/i },
  // Log4Shell / JNDI lookup
  { name: 'jndi_inject',  re: /\$\{jndi:(ldaps?|rmi|dns|iiop|nis|corba):/i },
];

// Décode jusqu'à `passes` fois les séquences %xx pour contrer le multi-encodage.
function multiDecode(str, passes = 2) {
  let out = str;
  for (let i = 0; i < passes; i++) {
    if (!/%[0-9a-f]{2}/i.test(out)) break;
    try { out = decodeURIComponent(out); } catch { break; }
  }
  return out;
}

function quickScan(req) {
  // ── Surface URL : path + url brut + params de route ──────────────────────────
  const urlRaw = [
    req.path || '',
    req.originalUrl || req.url || '',
    req.params ? Object.values(req.params).join(' ') : '',
  ].join(' ');
  // Décodage multi-passes + conversion '+' → espace (form-urlencoded) pour
  // démasquer les injections espacées (ex: "OR 1=1") encodées dans l'URL.
  const urlDecoded = multiDecode(urlRaw).replace(/\+/g, ' ');
  // req.query est déjà décodé par Express : on le sérialise tel quel (espaces réels).
  let queryStr = '';
  try { queryStr = JSON.stringify(req.query || {}); } catch {}
  const urlTarget = (urlRaw + ' ' + urlDecoded + ' ' + queryStr).slice(0, 8192);

  // ── Surface body : sérialisée (les vrais sauts de ligne y sont échappés) ──
  let bodyTarget = '';
  if (typeof req.body === 'string') bodyTarget = req.body.slice(0, 8192);
  else if (req.body && typeof req.body === 'object') {
    try { bodyTarget = JSON.stringify(req.body).slice(0, 8192); } catch {}
  }

  for (const { name, re, urlOnly } of QUICK_BLOCK) {
    if (re.test(urlTarget)) return name;
    if (!urlOnly && bodyTarget && re.test(bodyTarget)) return name;
  }
  return null;
}

// ─── Extraction sûre de l'IP cliente ─────────────────────────────────────────
// On NE fait PLUS confiance aux en-têtes X-Forwarded-For / X-Real-IP bruts :
// ils sont falsifiables par le client et permettraient de contourner le blocage
// d'IP, la réputation et le rate-limit. On s'appuie sur req.ip d'Express, qui est
// fiable une fois `trust proxy` correctement configuré (server.js).
function normalizeIp(ip) {
  if (!ip) return null;
  ip = String(ip).trim();
  // IPv4 mappée en IPv6 : ::ffff:1.2.3.4 → 1.2.3.4
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // Retirer un éventuel port sur une IPv4 : 1.2.3.4:5678 → 1.2.3.4
  const m = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
  if (m) ip = m[1];
  return ip || null;
}

function getIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress;
  return normalizeIp(ip) || '0.0.0.0';
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

// Lit le userId depuis req.user (si auth déjà passée) ou depuis le JWT brut
// (si le middleware fraude tourne avant l'auth). Pas de vérification de signature —
// on veut juste identifier l'appelant pour scorer par user plutôt que par IP.
function getUserId(req) {
  if (req.user?.id) return req.user.id.toString();
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = JSON.parse(
        Buffer.from(auth.slice(7).split('.')[1], 'base64url').toString()
      );
      if (payload?.id) return payload.id.toString();
    } catch {}
  }
  return 'anonymous';
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
      const userId = getUserId(req);
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
  const userId   = getUserId(req);
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
  // Exposés pour les tests unitaires / la réutilisation
  quickScan,
  getIp,
};
