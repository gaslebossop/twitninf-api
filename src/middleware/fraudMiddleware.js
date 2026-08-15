const fraudService = require('../services/fraudDetectionService');
const authService = require('../services/authService');
const logger = require('../utils/logger');
const crypto = require('crypto');

// L'exemption des clients first-party (desktop Windows, app mobile) reste
// volontairement étroite. Les en-têtes seuls sont falsifiables : ils doivent
// être accompagnés d'un JWT signé, non expiré et contenant un identifiant
// utilisateur. Les routes d'authentification et de paiement conservent
// systématiquement les contrôles FraudShield spécialisés.
//
// ⚠️ L'exemption ne porte JAMAIS sur la détection d'injection (`quickScan`) :
// elle ne fait sauter que le scoring comportemental (rate limit, réputation
// IP, vélocité) qui est calibré pour du trafic web et bannit à tort les
// clients natifs, qui pollent et préchargent par conception.
const FRAUD_BYPASS_EXCLUDED_PATHS = [
  '/api/auth/login',
  '/api/payments',
  '/api/new-economy/purchase',
  '/api/premium/subscribe',
  '/api/users/purchase-subscription',
  '/api/users/purchase-premium',
];

const APP_NAVIGATION_NOISE_PATHS = [
  '/auth/me',
  '/track',
  '/behavior',
  '/functional-events',
  '/neural-rank/recommendations',
  '/users/search',
  '/tweets/views/increment',
  // Polling périodique des clients natifs : appelé en boucle par conception
  // (badges de la tab bar), il n'a aucune valeur de signal anti-fraude.
  '/notifications/unread-count',
  '/messages/conversations',
];

/**
 * Ressources de fond de la Carte NF.
 *
 * ── Pourquoi elles font bannir des gens ──
 * Une SEULE ouverture de carte demande la page, le moteur MapLibre (1 Mo), le
 * style, une centaine de tuiles vectorielles, les glyphes de chaque police, le
 * sprite, puis jusqu'à deux cents images d'épingles. Plusieurs centaines de
 * requêtes en quelques secondes, depuis une IP : c'est exactement la forme
 * d'un pilonnage, et la réputation d'IP les comptait comme tel. Des comptes
 * parfaitement normaux se retrouvaient en 403 sur toute l'API pour avoir
 * regardé la carte.
 *
 * ── Pourquoi c'est sûr de les exempter ──
 * Elles sont toutes en GET, sans jeton par conception (le chargeur d'images
 * natif et les sous-ressources d'une `WebView` ne portent pas l'en-tête
 * `Authorization`), sans effet de bord, et ne rendent AUCUNE donnée
 * d'utilisateur : de la cartographie publique et des avatars déjà publics.
 * Elles gardent par ailleurs leur propre limiteur de débit dans
 * `nfMapRoutes` — l'exemption porte sur le SCORE de fraude, pas sur la
 * cadence.
 *
 * ⚠️ Liste EXPLICITE, jamais un préfixe `/nf-map/` : le même routeur sert
 * aussi `/position` (écrit une position), `/invite` (crée une notification),
 * `/nearby` et `/friends` (rendent des données d'utilisateur). Ceux-là doivent
 * rester surveillés. Le filtre sur GET ne suffirait pas — `/nearby` et
 * `/friends` sont des GET.
 */
const NF_MAP_ASSET_PATHS = new Set([
  '/nf-map/view',
  '/nf-map/bridge.js',
  '/nf-map/maplibre.js',
  '/nf-map/maplibre-worker.js',
  '/nf-map/maplibre.css',
  '/nf-map/style.json',
  '/nf-map/cluster.png',
]);

const NF_MAP_ASSET_PREFIXES = ['/nf-map/tiles/', '/nf-map/glyphs/', '/nf-map/pin/'];

/** `sprite.json`, `sprite.png`, `sprite@2x.json`, `sprite@2x.png`. */
const NF_MAP_SPRITE = /^\/nf-map\/sprite(@2x)?\.(json|png)$/;

function isNfMapAsset(req) {
  if (String(req.method || 'GET').toUpperCase() !== 'GET') return false;
  const path = getApiScopedPath(req);
  if (NF_MAP_ASSET_PATHS.has(path)) return true;
  if (NF_MAP_SPRITE.test(path)) return true;
  return NF_MAP_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function getRequestPath(req) {
  return String(req.originalUrl || req.url || req.path || '').split('?')[0].toLowerCase();
}

function getApiScopedPath(req) {
  const path = String(req.path || '').split('?')[0].toLowerCase();
  return path.startsWith('/api/') ? path.slice(4) : path;
}

/**
 * Routes qui reçoivent des fichiers, et pour lesquelles un corps volumineux
 * est le fonctionnement normal.
 *
 * Le plafond générique de 5 Mo plus bas vise les corps de requête anormaux
 * (bourrage de champs, tentative de saturation). Appliqué à un envoi de
 * vidéo, il rejetait en 413 CHAQUE upload dépassant quelques secondes de
 * captation — la vidéo brute arrive ici avant d'être transcodée, elle pèse
 * par nature bien plus que 5 Mo.
 */
const MEDIA_UPLOAD_PATTERNS = [
  // POST /api/tweets/video
  /^\/tweets\/video$/,
  // POST /api/stories
  /^\/stories$/,
  // POST /api/users/me/avatar — et bannière
  /^\/users\/[^/]+\/(avatar|banner)$/,
  // POST /api/messages/conversations/:id/messages/attachment
  /^\/messages\/conversations\/[^/]+\/messages\/attachment$/,
];

function isMediaUploadRoute(req) {
  if (String(req.method || 'GET').toUpperCase() !== 'POST') return false;
  const path = getApiScopedPath(req);
  return MEDIA_UPLOAD_PATTERNS.some((pattern) => pattern.test(path));
}

function isAppNavigationNoise(req) {
  const path = getApiScopedPath(req);
  const method = String(req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS' || method === 'HEAD') return true;

  const isReadMethod = method === 'GET';
  const isTelemetryMethod = method === 'POST' && (
    path === '/track' ||
    path.startsWith('/behavior') ||
    path === '/tweets/views/increment'
  );

  if (!isReadMethod && !isTelemetryMethod) return false;

  return APP_NAVIGATION_NOISE_PATHS.some((safePath) => (
    path === safePath || path.startsWith(`${safePath}/`)
  )) || /^\/users\/[0-9a-f-]{36}$/.test(path);
}

function isFraudBypassExcluded(req) {
  const path = getRequestPath(req);
  return FRAUD_BYPASS_EXCLUDED_PATHS.some((excluded) => (
    path === excluded || path.startsWith(`${excluded}/`)
  ));
}

function getVerifiedBearerUserId(req) {
  const authorization = String(req.headers?.authorization || '').trim();
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return null;

  const token = match[1];
  // Un JWT doit avoir exactement trois segments avant même la vérification.
  if (token.split('.').length !== 3) return null;

  const decoded = authService.verifyToken(token);
  if (!decoded?.id) return null;
  return String(decoded.id);
}

function hasWindowsElectronTransport(req) {
  const userAgent = String(req.headers?.['user-agent'] || '').toLowerCase();
  const platform = String(req.headers?.['user-platform'] || '').trim().toLowerCase();
  const ownership = String(req.headers?.['x-app-ownership'] || '').trim().toLowerCase();
  const client = String(req.headers?.['x-twitninf-client'] || '').trim().toLowerCase();

  if (!userAgent.includes('twitninf-windows')) return false;
  if (platform !== 'windows') return false;
  if (ownership !== 'standalone') return false;
  if (client !== 'windows-electron') return false;

  return true;
}

// Transport de l'app mobile Expo (iOS / Android). Même niveau d'exigence que
// le desktop : un triplet d'en-têtes propriétaires cohérent, qui ne devient
// digne de confiance qu'accompagné d'un JWT dont la signature est vérifiée.
function hasMobileAppTransport(req) {
  const platform = String(req.headers?.['user-platform'] || '').trim().toLowerCase();
  const client = String(req.headers?.['x-twitninf-client'] || '').trim().toLowerCase();
  const deviceId = String(req.headers?.['x-device-id'] || '').trim();

  if (client !== 'mobile-expo') return false;
  if (platform !== 'ios' && platform !== 'android') return false;
  if (deviceId.length < 8) return false;

  return true;
}

// Client officiel (desktop Windows ou app mobile) authentifié par un JWT valide.
function isTrustedFirstPartyClient(req) {
  if (isFraudBypassExcluded(req)) return false;
  if (!hasWindowsElectronTransport(req) && !hasMobileAppTransport(req)) return false;

  return Boolean(getVerifiedBearerUserId(req));
}

// Conservé comme alias : d'anciens appelants/tests référencent encore ce nom.
const isTrustedWindowsElectronRequest = isTrustedFirstPartyClient;

// ─── Pré-filtre synchrone (Node.js, sans passer par Rust) ────────────────────
// Détecte les patterns d'injection évidents AVANT d'envoyer la requête au contrôleur.
// Rust analyse en background pour les cas ambigus.
//
// `urlOnly: true` → la règle ne s'applique qu'à l'URL/params/query (jamais au body),
// pour éviter les faux positifs sur du texte légitime (tweets, messages…).
const QUICK_BLOCK = [
  // SQL injection basique OR/AND + opérateur || (pipe SQL = OR)
  { name: 'sql_basic',    re: /\b(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+|\b(or|and)\s+['"][^'"]{0,40}['"]\s*=\s*['"]|\b(or|and)\s+\d+\s*(--|#)|['"]\s*\|\||\|\|\s*['"]/i },
  // SQL injection avancée — suppression de la limite .{0,40} (trop courte, contournable)
  { name: 'sql_union',    re: /\bunion\b[\s\S]{0,500}\bselect\b|\bdrop\s+table|\binsert\s+into|\bdelete\s+from|\bexec\s*\(|\bxp_cmdshell|\bwaitfor\s+delay|\bpg_sleep\s*\(|\bsleep\s*\(\s*\d/i },
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
  // XSS — balises, handlers d'événements (TOUS les on* dans n'importe quel tag), schémas dangereux
  { name: 'xss',          re: /<script[\s>]|<\/script>|<iframe[\s>]|<svg[\s>/]|<\w[^>]{0,500}\bon\w+\s*=|javascript\s*:|vbscript\s*:|data:text\/html|on(?:load|error)\s*=/i },
  // XXE
  { name: 'xxe',          re: /<!entity\s|<!doctype\s[^>]+system\s|expect:\/\/|php:\/\/|jar:\/\/|netdoc:\/\//i },
  // Template injection (SSTI)
  { name: 'tpl_inject',   re: /\{\{.{1,60}\}\}|\$\{.{1,60}\}|#\{.{1,60}\}|<%.{1,60}%>|\{%.{1,60}%\}/i },
  // NoSQL / operator injection — liste étendue avec opérateurs manquants
  { name: 'nosql_inject', re: /(["'\[]\s*)\$(ne|gt|gte|lt|lte|in|nin|eq|where|regex|expr|exists|elemmatch|function|or|and|nor|not|jsonschema|mod|size|type|all|comment|slice|set|unset|push|pull|addToSet)\b|\bmapreduce\b/i },
  // Prototype pollution
  { name: 'proto_pollut', re: /__proto__|constructor\s*\[\s*['"]?prototype|prototype\s*\[\s*['"]?__proto__/i },
  // Log4Shell / JNDI — inclut les bypasses nested ${${lower:j}ndi:...}
  { name: 'jndi_inject',  re: /\$\{jndi:(ldaps?|rmi|dns|iiop|nis|corba):|\$\{[\s\S]{0,60}jndi:/i },
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

// Déneste les lookups Log4j imbriqués pour détecter les bypasses JNDI.
// Ex: ${${lower:j}ndi:ldap://x} → après 3 passes → "jndi:ldap://x"
function stripLog4jLookups(str) {
  let out = str;
  for (let i = 0; i < 4; i++) {
    const prev = out;
    // Remplace ${lower:X} → X, ${upper:X} → X, ${::-X} → X, etc.
    out = out.replace(/\$\{(?:[a-z:_-]{0,20}:)?([^{}]{0,40})\}/gi, '$1');
    if (out === prev) break;
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

  // Surface normalisée pour détecter les bypasses JNDI nested
  const urlNorm  = stripLog4jLookups(urlTarget);
  const bodyNorm = bodyTarget ? stripLog4jLookups(bodyTarget) : '';

  for (const { name, re, urlOnly } of QUICK_BLOCK) {
    if (re.test(urlTarget) || re.test(urlNorm)) return name;
    if (!urlOnly && bodyTarget && (re.test(bodyTarget) || re.test(bodyNorm))) return name;
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

// Les benchmarks admin emettent uniquement des GET depuis 127/8 sur le VPS A.
// Le secret empeche un client externe de fabriquer cette exemption et le garde
// loopback la rend inutilisable meme si le secret fuitait dans un journal.
function isTrustedCapacityRequest(req) {
  if (String(req.method || '').toUpperCase() !== 'GET') return false;
  const ip = getIp(req);
  if (!ip.startsWith('127.') && ip !== '::1') return false;
  const runId = String(req.headers?.['x-twitninf-capacity-run'] || '');
  if (!/^capacity-\d{8}T\d{6}-[a-f0-9]{6}$/.test(runId)) return false;
  if (!String(req.headers?.['user-agent'] || '').startsWith('TwitninfClusterCapacity/')) return false;
  const expected = String(process.env.INTERNAL_SECRET || '');
  const received = String(req.headers?.['x-internal-secret'] || '');
  if (!expected || expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
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
  if (isTrustedCapacityRequest(req)) return next();
  if (!fraudService.isReady()) return next();
  if (isAppNavigationNoise(req) && getVerifiedBearerUserId(req)) return next();
  // Sans jeton par conception : la garde du porteur ci-dessus ne peut pas
  // s appliquer, et une carte grise sans explication est le pire des retours.
  if (isNfMapAsset(req)) return next();

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
  if (isTrustedFirstPartyClient(req)) return next();
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
  // ⚠️ Ce scan s'exécute AVANT toute exemption : ni un client first-party de
  // confiance ni le bruit de navigation ne peuvent y échapper. Un client
  // officiel compromis ou un JWT volé reste une source d'injection crédible.
  // Ne JAMAIS déplacer les early-return d'exemption au-dessus de ce bloc.
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

  // ── 2. Exemptions du scoring comportemental (jamais de l'injection) ─────────
  // Les clients officiels authentifiés et le bruit de navigation ne sont pas
  // envoyés au moteur Rust : leurs cadences (polling, préchargement, tracking
  // de vues) dépassent des seuils calibrés pour du trafic web et provoquaient
  // des bans d'IP sur du trafic parfaitement légitime.
  if (isTrustedFirstPartyClient(req)) return next();
  if (isTrustedCapacityRequest(req)) return next();
  if (isAppNavigationNoise(req)) return next();
  if (isNfMapAsset(req)) return next();

  if (!fraudService.isReady()) return next();

  // ── 3. IP block check (Redis GET, ~1ms) ─────────────────────────────────────
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

  // ── 4. Large payload — vérification synchrone ────────────────────────────────
  // Les routes d'upload ont leur propre plafond, bien plus haut : ce sont les
  // seules où un corps de plusieurs dizaines de Mo est attendu. Leur taille
  // reste bornée par `client_max_body_size` côté nginx et par les limites
  // multer de chaque route — ce contrôle-ci n'est pas le dernier rempart.
  const payloadSize = parseInt(req.headers['content-length'] || '0');
  const payloadCeiling = isMediaUploadRoute(req) ? 200_000_000 : 5_000_000;
  if (payloadSize > payloadCeiling) {
    logger.warn(`[fraud] Large payload blocked: ${payloadSize} bytes from ${ip}`);
    return res.status(413).json({
      success: false,
      message: 'Payload trop volumineux.',
      code: 'PAYLOAD_TOO_LARGE',
    });
  }

  // ── 5. Background analysis pour les autres cas (rate limit, patterns subtils) ─
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
  isTrustedFirstPartyClient,
  isTrustedWindowsElectronRequest, // alias rétrocompatible
  hasWindowsElectronTransport,
  hasMobileAppTransport,
  isAppNavigationNoise,
  isTrustedCapacityRequest,
};
