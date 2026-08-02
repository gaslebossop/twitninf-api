#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          TWITNINF API — SECURITY AUDIT SCRIPT               ║
 * ║  Analyse de vulnérabilités sur TA propre API locale          ║
 * ║  Usage: node security-audit.js [BASE_URL]                   ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * ⚠️  Ce script est UNIQUEMENT destiné à tester TON PROPRE serveur.
 *    Ne jamais utiliser sur des serveurs tiers sans autorisation.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ─── Configuration ───────────────────────────────────────────────────────────
const BASE_URL = process.argv[2] || 'http://localhost:3000';
const TIMEOUT  = 8000; // ms
const DELAY_MS = 120;  // délai entre requêtes (ms)

// Couleurs terminal
const C = {
  reset : '\x1b[0m',
  red   : '\x1b[31m',
  green : '\x1b[32m',
  yellow: '\x1b[33m',
  cyan  : '\x1b[36m',
  bold  : '\x1b[1m',
  dim   : '\x1b[2m',
  magenta: '\x1b[35m',
};

// ─── Résultats ────────────────────────────────────────────────────────────────
const results = {
  critical : [],
  warning  : [],
  info     : [],
  passed   : [],
};

let testCount = 0;
let authToken = null;
let userId    = null;
let testUserCreated = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(level, msg, detail = '') {
  const icons = { critical: '💀', warning: '⚠️ ', info: 'ℹ️ ', passed: '✅' };
  const colors = {
    critical: C.red + C.bold,
    warning : C.yellow,
    info    : C.cyan,
    passed  : C.green,
  };
  const prefix = colors[level] || '';
  console.log(`  ${icons[level] || '  '} ${prefix}${msg}${C.reset}${detail ? C.dim + '  → ' + detail + C.reset : ''}`);
  results[level]?.push({ msg, detail });
}

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port    : url.port || (isHttps ? 443 : 80),
      path    : url.pathname + url.search,
      method,
      headers : {
        'Content-Type'  : 'application/json',
        'User-Agent'    : 'SecurityAudit/1.0',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: TIMEOUT,
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
      });
    });

    req.on('error',   () => resolve({ status: 0,   headers: {}, body: null, raw: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 408, headers: {}, body: null, raw: '' }); });

    if (payload) req.write(payload);
    req.end();
  });
}

function authHeader() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

// ─── Section header ───────────────────────────────────────────────────────────
function section(name) {
  console.log(`\n${C.bold}${C.magenta}━━━ ${name} ━━━${C.reset}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// 1. Connectivité de base
async function testConnectivity() {
  section('1. CONNECTIVITÉ & HEALTH CHECK');
  testCount++;

  const res = await request('GET', '/api/health');
  if (res.status === 0) {
    log('critical', 'Serveur injoignable', `${BASE_URL}`);
    process.exit(1);
  }

  if (res.status === 200) {
    log('passed', 'Serveur accessible', `status=${res.status}`);
    if (res.body?.environment) {
      log('info', `Environnement: ${res.body.environment}`);
    }
    if (res.body?.memory) {
      log('info', 'Health endpoint expose les infos mémoire RAM (peut être utile à un attaquant)', '/api/health');
    }
  } else {
    log('warning', `Health check: status ${res.status}`);
  }
}

// 2. Headers de sécurité HTTP
async function testSecurityHeaders() {
  section('2. HEADERS HTTP DE SÉCURITÉ');
  testCount++;

  const res = await request('GET', '/api/health');
  const h = res.headers;

  const checks = [
    ['x-powered-by',              false, 'Le header X-Powered-By révèle la technologie (Express)'],
    ['x-frame-options',           true,  'X-Frame-Options manquant (clickjacking)'],
    ['x-content-type-options',    true,  'X-Content-Type-Options: nosniff manquant'],
    ['strict-transport-security', true,  'HSTS manquant (HTTPS non forcé)'],
    ['x-xss-protection',          true,  'X-XSS-Protection manquant'],
    ['content-security-policy',   true,  'Content-Security-Policy manquant'],
  ];

  for (const [header, shouldExist, msg] of checks) {
    const exists = !!h[header];
    if (shouldExist && !exists) {
      log('warning', `Header manquant: ${header}`, msg);
    } else if (!shouldExist && exists) {
      log('warning', `Header sensible exposé: ${header}`, msg);
    } else {
      log('passed', `Header OK: ${header}`);
    }
    await sleep(30);
  }
}

// 3. Inscription & Authentification
async function testAuth() {
  section('3. AUTHENTIFICATION');
  testCount++;

  const testUser = `audit_${Date.now()}`;
  const testPass = 'AuditPass123!';

  // Inscription normale
  const reg = await request('POST', '/api/auth/register', {
    username: testUser,
    fullName: 'Audit Bot',
    password: testPass,
    platform: 'web',
  });

  if (reg.status === 200 || reg.status === 201) {
    authToken = reg.body?.data?.token || null;
    userId    = reg.body?.data?.user?.id || null;
    testUserCreated = true;
    log('passed', `Inscription réussie (user: ${testUser})`);
  } else {
    log('warning', `Inscription échouée: ${reg.status}`, JSON.stringify(reg.body)?.slice(0, 120));
  }

  await sleep(DELAY_MS);

  // Mot de passe trop court (validation)
  const weak = await request('POST', '/api/auth/register', {
    username: `audit_w_${Date.now()}`,
    fullName: 'Weak Pass',
    password: '123',
    platform: 'web',
  });
  if (weak.status === 400) {
    log('passed', 'Validation mot de passe faible fonctionne (400)');
  } else {
    log('critical', 'Mot de passe faible "123" ACCEPTÉ à l\'inscription', `status=${weak.status}`);
  }

  await sleep(DELAY_MS);

  // Login avec les bonnes credentials
  if (testUserCreated) {
    const login = await request('POST', '/api/auth/login', {
      username: testUser,
      password: testPass,
    });
    if (login.status === 200) {
      authToken = login.body?.data?.token || authToken;
      log('passed', 'Login avec bonnes credentials réussi');
    } else {
      log('warning', `Login échoué: ${login.status}`);
    }
  }

  await sleep(DELAY_MS);

  // Login avec mauvais mot de passe (timing attack)
  const t1 = Date.now();
  await request('POST', '/api/auth/login', { username: testUser, password: 'MAUVAIS_MDP_123' });
  const t2 = Date.now();
  await request('POST', '/api/auth/login', { username: `userqui_nexiste_pas_${Date.now()}`, password: 'MAUVAIS_MDP_123' });
  const t3 = Date.now();
  const diffValid   = t2 - t1;
  const diffInvalid = t3 - t2;
  const timingDiff  = Math.abs(diffValid - diffInvalid);
  if (timingDiff > 500) {
    log('warning', `Timing Attack possible: ${timingDiff}ms de différence user/password entre user valide et invalide`);
  } else {
    log('passed', `Timing homogène entre user valide/invalide (±${timingDiff}ms)`);
  }

  await sleep(DELAY_MS);

  // Vérifier si les messages d'erreur révèlent "user n'existe pas" vs "mauvais mdp"
  const r1 = await request('POST', '/api/auth/login', { username: testUser, password: 'WRONGPASS' });
  const r2 = await request('POST', '/api/auth/login', { username: 'userquinexistepas9999', password: 'WRONGPASS' });
  if (r1.body?.message === r2.body?.message) {
    log('passed', 'Messages d\'erreur login identiques (pas d\'user enumeration)');
  } else {
    log('warning', 'User enumeration: messages login différents selon que l\'user existe ou non',
      `valide="${r1.body?.message}" | invalide="${r2.body?.message}"`);
  }
}

// 4. Brute force / Rate limiting
async function testRateLimiting() {
  section('4. BRUTE FORCE & RATE LIMITING');
  testCount++;

  let blocked = false;
  let attempts = 0;

  for (let i = 0; i < 20; i++) {
    const res = await request('POST', '/api/auth/login', {
      username: 'bruteforce_test',
      password: `wrong${i}`,
    });
    attempts++;
    if (res.status === 429) {
      blocked = true;
      log('passed', `Rate limit login déclenché après ${attempts} tentatives (429)`);
      break;
    }
    await sleep(50);
  }

  if (!blocked) {
    log('warning', `Rate limit login NON déclenché après ${attempts} tentatives consécutives`,
      'authLimiter configuré à 100 req/15min — difficile à tester rapidement mais vérifier en prod');
  }

  await sleep(DELAY_MS);

  // Test rate limit général /api/
  let globalBlocked = false;
  for (let i = 0; i < 30; i++) {
    const res = await request('GET', '/api/health');
    if (res.status === 429) {
      globalBlocked = true;
      log('passed', `Rate limit global déclenché après ${i + 1} req (429)`);
      break;
    }
    await sleep(20);
  }
  if (!globalBlocked) {
    log('info', 'Rate limit global non déclenché sur /api/health (normal si < 1000 req/15min)');
  }
}

// 5. JWT Security
async function testJWTSecurity() {
  section('5. SÉCURITÉ JWT');
  testCount++;

  // Accès sans token
  const noToken = await request('GET', '/api/auth/me');
  if (noToken.status === 401) {
    log('passed', 'Route protégée rejette les requêtes sans token (401)');
  } else {
    log('critical', `Route /api/auth/me accessible SANS token! (status=${noToken.status})`);
  }

  await sleep(DELAY_MS);

  // Token malformé
  const badToken = await request('GET', '/api/auth/me', null, { Authorization: 'Bearer INVALIDTOKEN' });
  if (badToken.status === 401) {
    log('passed', 'Token JWT invalide rejeté (401)');
  } else {
    log('critical', `Token JWT invalide ACCEPTÉ! (status=${badToken.status})`);
  }

  await sleep(DELAY_MS);

  // Token expiré simulé (JWT signé avec mauvaise clé)
  const fakeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEiLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZSI6InN1cGVyYWRtaW4iLCJpYXQiOjE2MDAwMDAwMDAsImV4cCI6OTk5OTk5OTk5OX0.FAKE_SIGNATURE';
  const fakeRes = await request('GET', '/api/auth/me', null, { Authorization: `Bearer ${fakeToken}` });
  if (fakeRes.status === 401) {
    log('passed', 'JWT forgé (mauvaise signature) rejeté correctement');
  } else {
    log('critical', `JWT avec mauvaise signature ACCEPTÉ! VULNÉRABILITÉ CRITIQUE (status=${fakeRes.status})`);
  }

  await sleep(DELAY_MS);

  // Algorithm confusion: "alg: none"
  const noneToken = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJpZCI6IjEiLCJ1c2VybmFtZSI6ImFkbWluIiwicm9sZSI6InN1cGVyYWRtaW4iLCJpYXQiOjE2MDAwMDAwMDAsImV4cCI6OTk5OTk5OTk5OX0.';
  const noneRes = await request('GET', '/api/auth/me', null, { Authorization: `Bearer ${noneToken}` });
  if (noneRes.status === 401) {
    log('passed', 'JWT alg:none rejeté (pas de vulnerability JWT none)');
  } else {
    log('critical', `JWT alg:none ACCEPTÉ! Vulnérabilité critique "algorithm confusion" (status=${noneRes.status})`);
  }
}

// 6. Autorisation & IDOR
async function testAuthorization() {
  section('6. AUTORISATION & IDOR (BROKEN ACCESS CONTROL)');
  testCount++;

  if (!authToken) {
    log('warning', 'Pas de token auth disponible, tests d\'autorisation limités');
    return;
  }

  // Tenter d'accéder aux routes admin sans être admin
  const adminRoutes = [
    '/api/admin/economy',
    '/api/admin/policiercongo',
    '/api/moderation/reports',
    '/api/developer',
  ];

  for (const route of adminRoutes) {
    const res = await request('GET', route, null, authHeader());
    if (res.status === 403 || res.status === 401) {
      log('passed', `Route admin protégée: ${route} (${res.status})`);
    } else if (res.status === 404) {
      log('info', `Route admin retourne 404 (route peut ne pas exister): ${route}`);
    } else {
      log('critical', `Route admin accessible sans droits admin: ${route}`, `status=${res.status}`);
    }
    await sleep(DELAY_MS);
  }

  // IDOR: Tenter d'accéder au profil d'un autre user
  const otherUserId = '00000000-0000-0000-0000-000000000001'; // UUID fictif
  const idor = await request('GET', `/api/users/${otherUserId}`, null, authHeader());
  if (idor.status === 404 || idor.status === 403) {
    log('passed', `IDOR profile: user inexistant retourne ${idor.status} (OK)`);
  } else if (idor.status === 200) {
    // Normal si l'endpoint renvoie des profils publics — vérifier ce qui est exposé
    const exposed = JSON.stringify(idor.body).slice(0, 200);
    if (exposed.includes('password') || exposed.includes('reset_password') || exposed.includes('email')) {
      log('critical', 'Données sensibles (password/email) exposées dans le profil public', exposed);
    } else {
      log('info', `GET /api/users/:id retourne 200 (profil public) — vérifier les champs exposés`);
    }
  }

  await sleep(DELAY_MS);

  // IDOR: Essayer de modifier le profil d'un autre user
  const idor2 = await request('PUT', `/api/users/${otherUserId}`, { full_name: 'HACKED' }, authHeader());
  if (idor2.status === 403 || idor2.status === 401 || idor2.status === 404) {
    log('passed', `IDOR update: impossible de modifier un autre profil (${idor2.status})`);
  } else {
    log('critical', `IDOR: Modification d'un autre profil possible! status=${idor2.status}`);
  }

  await sleep(DELAY_MS);

  // Privilege Escalation: Tenter de changer son propre rôle
  if (userId) {
    const privEsc = await request('PUT', '/api/auth/profile', { role: 'superadmin', verified: true, premium: true }, authHeader());
    if (privEsc.status === 400 || privEsc.status === 403) {
      log('passed', 'Privilege escalation via profile update bloqué');
    } else if (privEsc.status === 200) {
      const newRole = privEsc.body?.data?.role;
      if (newRole === 'superadmin') {
        log('critical', 'PRIVILEGE ESCALATION: Rôle superadmin auto-assigné via PUT /api/auth/profile!');
      } else {
        log('passed', 'PUT /api/auth/profile: champs role/verified ignorés correctement');
      }
    }
  }
}

// 7. Injection SQL / NoSQL
async function testInjection() {
  section('7. INJECTION SQL & NOSQL');
  testCount++;

  const sqlPayloads = [
    "' OR '1'='1",
    "'; DROP TABLE users; --",
    "' UNION SELECT username, password FROM users --",
    "1; SELECT * FROM users",
    "admin'--",
  ];

  for (const payload of sqlPayloads) {
    const res = await request('POST', '/api/auth/login', {
      username: payload,
      password: 'test',
    });

    if (res.status === 500) {
      log('critical', `Injection SQL possible — erreur 500 avec payload: ${payload}`,
        `Réponse: ${JSON.stringify(res.body)?.slice(0, 100)}`);
    } else if (res.status === 200) {
      log('critical', `Injection SQL réussie! Login accepté avec payload: ${payload}`);
    } else {
      log('passed', `Injection rejetée (${res.status}): ${payload.slice(0, 40)}`);
    }
    await sleep(DELAY_MS);
  }

  // Test dans les paramètres GET
  const sqlGet = await request('GET', `/api/tweets?limit=1; DROP TABLE tweets; --`);
  if (sqlGet.status === 500) {
    log('critical', 'Injection SQL via paramètre GET retourne 500');
  } else {
    log('passed', `Paramètre GET malformé géré (${sqlGet.status})`);
  }
}

// 8. XSS (Cross-Site Scripting)
async function testXSS() {
  section('8. XSS (CROSS-SITE SCRIPTING)');
  testCount++;

  if (!authToken) {
    log('warning', 'Pas de token, test XSS limité');
    return;
  }

  const xssPayloads = [
    '<script>alert("XSS")</script>',
    '"><img src=x onerror=alert(1)>',
    'javascript:alert(1)',
    '<svg onload=alert(1)>',
  ];

  for (const payload of xssPayloads) {
    // Tenter d'injecter dans un tweet
    const res = await request('POST', '/api/tweets', { content: payload }, authHeader());

    if (res.status === 201 || res.status === 200) {
      const returnedContent = res.body?.data?.content || '';
      if (returnedContent === payload) {
        log('warning', 'Payload XSS stocké tel quel dans les tweets (pas d\'échappement côté serveur)',
          'L\'API REST stocke du HTML brut — vérifier que le frontend l\'échappe');
      } else if (returnedContent.includes('<script>')) {
        log('critical', 'XSS Stocké détecté! Balise script préservée dans la réponse');
      } else {
        log('passed', `XSS filtré/échappé pour: ${payload.slice(0, 40)}`);
      }
    } else if (res.status === 400) {
      log('passed', `XSS payload rejeté par validation (400): ${payload.slice(0, 40)}`);
    }
    await sleep(DELAY_MS);
  }
}

// 9. Endpoints non authentifiés / exposés
async function testUnauthenticatedEndpoints() {
  section('9. ENDPOINTS SENSIBLES SANS AUTH');
  testCount++;

  const sensitivePaths = [
    '/api/policiercongo/status',
    '/api/policiercongo/analyze',
    '/api/policiercongo/reset-memory',
    '/api/admin/economy',
    '/api/admin/policiercongo',
    '/api/moderation',
    '/api/behavior',
    '/api/developer',
  ];

  for (const path of sensitivePaths) {
    const res = await request('GET', path); // Sans token
    if (res.status === 200) {
      log('critical', `Endpoint sensible accessible SANS token: ${path}`, `status=${res.status}`);
    } else if (res.status === 401 || res.status === 403) {
      log('passed', `Endpoint protégé correctement: ${path} (${res.status})`);
    } else if (res.status === 404) {
      log('info', `Endpoint retourne 404 (route inexistante ou non montée): ${path}`);
    } else {
      log('warning', `Endpoint: ${path} retourne ${res.status} sans token`);
    }
    await sleep(DELAY_MS);
  }

  // Tester POST aussi pour /api/policiercongo/analyze et reset-memory
  const postPaths = [
    { method: 'POST', path: '/api/policiercongo/analyze' },
    { method: 'POST', path: '/api/policiercongo/reset-memory' },
  ];

  for (const { method, path } of postPaths) {
    const res = await request(method, path);
    if (res.status === 200 || res.status === 201) {
      log('critical', `${method} ${path} accessible SANS auth — peut déclencher des actions!`, `status=${res.status}`);
    } else if (res.status === 401 || res.status === 403) {
      log('passed', `${method} ${path} protégé (${res.status})`);
    } else {
      log('warning', `${method} ${path}: status=${res.status} (vérifier si auth requise)`);
    }
    await sleep(DELAY_MS);
  }
}

// 10. Mass Assignment / Field Pollution
async function testMassAssignment() {
  section('10. MASS ASSIGNMENT & FIELD POLLUTION');
  testCount++;

  if (!authToken) {
    log('warning', 'Pas de token, test mass assignment limité');
    return;
  }

  // Tenter de s'auto-vérifier / se rendre premium via register
  const massReg = await request('POST', '/api/auth/register', {
    username: `mass_${Date.now()}`,
    fullName: 'Mass Assignment Test',
    password: 'TestPass123!',
    platform: 'web',
    role     : 'superadmin',
    verified : true,
    premium  : true,
    is_admin : true,
  });

  if (massReg.status === 200 || massReg.status === 201) {
    const user = massReg.body?.data?.user;
    if (user?.role === 'superadmin' || user?.verified === true || user?.premium === true) {
      log('critical', 'Mass Assignment lors de l\'inscription! Champs role/verified/premium auto-définis',
        `role=${user?.role} verified=${user?.verified} premium=${user?.premium}`);
    } else {
      log('passed', 'Inscription: champs sensibles (role/verified/premium) ignorés');
    }
  }

  await sleep(DELAY_MS);

  // Tenter via update profile
  const massUpdate = await request('PUT', '/api/auth/profile', {
    role     : 'superadmin',
    verified : true,
    premium  : true,
    is_admin : true,
    is_active: true,
  }, authHeader());

  if (massUpdate.status === 200) {
    const user = massUpdate.body?.data;
    if (user?.role === 'superadmin' || user?.verified === true) {
      log('critical', 'Mass Assignment via PUT /api/auth/profile! Champs sensibles modifiés',
        `role=${user?.role} verified=${user?.verified}`);
    } else {
      log('passed', 'Update profile: champs sensibles ignorés (whitelist correcte)');
    }
  }
}

// 11. Déni de Service / Payload oversized
async function testDoSVectors() {
  section('11. VECTEURS D\'ABUS / DOS');
  testCount++;

  // Payload très long (upload de données massives)
  const hugeContent = 'A'.repeat(100_000);
  const res = await request('POST', '/api/tweets', { content: hugeContent }, authHeader());
  if (res.status === 413) {
    log('passed', 'Payload trop grand rejeté (413)');
  } else if (res.status === 400) {
    log('passed', 'Payload trop grand rejeté par validation (400)');
  } else if (res.status === 200 || res.status === 201) {
    log('warning', 'Payload massif (100KB) accepté dans le contenu d\'un tweet — vérifier la validation');
  } else {
    log('info', `Payload large: status=${res.status}`);
  }

  await sleep(DELAY_MS);

  // QueryString gigantesque (crash potentiel)
  const bigQuery = 'A'.repeat(10_000);
  const r2 = await request('GET', `/api/tweets?q=${bigQuery}&limit=100`);
  if (r2.status === 414 || r2.status === 400) {
    log('passed', 'QueryString géant rejeté correctement');
  } else {
    log('info', `QueryString très long: status=${r2.status}`);
  }

  await sleep(DELAY_MS);

  // Prototype Pollution
  const pollutionPayload = { '__proto__': { admin: true }, constructor: { prototype: { admin: true } } };
  const r3 = await request('POST', '/api/auth/login', {
    username: 'test',
    password: 'test',
    ...pollutionPayload,
  });
  log('info', `Prototype Pollution test: status=${r3.status} (vérifier avec des outils dédiés comme --pp-tester)`);
}

// 12. CORS
async function testCORS() {
  section('12. CONFIGURATION CORS');
  testCount++;

  const res = await request('OPTIONS', '/api/health', null, {
    Origin: 'https://evil.hacker.com',
    'Access-Control-Request-Method': 'GET',
  });

  const acao = res.headers['access-control-allow-origin'];
  if (acao === '*') {
    log('warning', 'CORS: Access-Control-Allow-Origin: * (toutes les origines autorisées)',
      'Acceptable pour une API publique, mais vérifier les routes sensibles');
  } else if (acao === 'https://evil.hacker.com') {
    log('critical', 'CORS: Origine malveillante acceptée! Wildcard dynamique dangereuse');
  } else if (!acao) {
    log('passed', 'Origine malveillante non reflétée dans CORS');
  } else {
    log('info', `CORS origin: ${acao}`);
  }

  const acac = res.headers['access-control-allow-credentials'];
  if (acac === 'true' && acao === '*') {
    log('critical', 'CORS: credentials=true avec wildcard origin — configuration invalide & dangereuse');
  }
}

// 13. Disclosure d'informations
async function testInfoDisclosure() {
  section('13. DIVULGATION D\'INFORMATIONS');
  testCount++;

  // Stack trace exposée en cas d'erreur
  const r1 = await request('GET', '/api/tweets/INVALID-UUID-FORMAT!!');
  if (r1.raw?.includes('at ') && r1.raw?.includes('.js:')) {
    log('critical', 'Stack trace Node.js exposée dans la réponse d\'erreur', r1.raw.slice(0, 200));
  } else if (r1.status === 400 || r1.status === 404) {
    log('passed', 'Erreur tweet ID invalide gérée proprement (400/404)');
  }

  await sleep(DELAY_MS);

  // Route inexistante — vérifier si la liste des routes est exposée
  const r2 = await request('GET', '/api/nonexistent_route_xyz');
  const body = JSON.stringify(r2.body || '');
  if (body.includes('available_endpoints') || body.includes('routes')) {
    log('warning', 'Le 404 expose la liste des endpoints disponibles', body.slice(0, 200));
  } else {
    log('passed', '404 ne divulgue pas la liste des routes internes');
  }

  await sleep(DELAY_MS);

  // /api/health expose trop d'infos
  const healthRes = await request('GET', '/api/health');
  if (healthRes.body?.memory) {
    log('warning', 'Health endpoint expose l\'utilisation mémoire RAM (info utile pour DOS planning)',
      JSON.stringify(healthRes.body.memory).slice(0, 100));
  }
  if (healthRes.body?.version) {
    log('info', `Version de l'API exposée: ${healthRes.body.version}`);
  }

  // Test si /test expose des infos de structure
  const testRoute = await request('GET', '/test');
  if (testRoute.status === 200) {
    log('warning', 'Route /test accessible publiquement et expose la structure des endpoints',
      JSON.stringify(testRoute.body?.routes)?.slice(0, 150));
  }

  // Vérifier env.example si servi en static
  const envFile = await request('GET', '/env.example');
  const envFile2 = await request('GET', '/.env');
  if (envFile.status === 200 && envFile.raw.includes('JWT_SECRET')) {
    log('critical', 'Fichier env.example accessible publiquement! Contient des secrets');
  }
  if (envFile2.status === 200 && envFile2.raw.includes('JWT_SECRET')) {
    log('critical', 'Fichier .env accessible publiquement! FUITE DE SECRETS CRITIQUE');
  } else {
    log('passed', 'Fichiers .env non accessibles publiquement');
  }
}

// 14. Upload de fichiers
async function testFileUpload() {
  section('14. UPLOAD DE FICHIERS');
  testCount++;

  if (!authToken) {
    log('warning', 'Pas de token disponible pour les tests d\'upload');
    return;
  }

  // Tenter un upload avec un type MIME malveillant (multipart/form-data simulé)
  log('info', 'Test upload: vérifier manuellement que multer limite les types MIME (images/vidéos seulement)');
  log('info', 'Test upload: vérifier que les fichiers sont stockés hors du webroot et non exécutables');
  log('info', 'Test upload: vérifier l\'absence de traversée de répertoire dans les noms de fichiers');

  // Path traversal dans les paramètres de fichiers statiques
  const traversal = await request('GET', '/static/avatars/../../src/config/config.js');
  if (traversal.status === 200 && (traversal.raw?.includes('jwt') || traversal.raw?.includes('secret'))) {
    log('critical', 'Path Traversal détecté sur /static/avatars/');
  } else {
    log('passed', 'Path traversal sur /static/avatars/ bloqué');
  }

  await sleep(DELAY_MS);
  const traversal2 = await request('GET', '/storage/../src/config/config.js');
  if (traversal2.status === 200 && traversal2.raw?.includes('secret')) {
    log('critical', 'Path Traversal détecté sur /storage/');
  } else {
    log('passed', 'Path traversal sur /storage/ bloqué');
  }
}

// 15. Sécurité des tokens de reset password
async function testPasswordReset() {
  section('15. SÉCURITÉ RESET PASSWORD');
  testCount++;

  // Tenter de réinitialiser avec un token forgé
  const fakeResetToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEiLCJ0eXBlIjoicmVzZXQiLCJpYXQiOjE2MDAwMDAwMDAsImV4cCI6OTk5OTk5OTk5OX0.FAKE';
  const resetRes = await request('POST', `/api/auth/reset-password/${fakeResetToken}`, {
    password: 'NewHackedPass1!',
  });

  if (resetRes.status === 401 || resetRes.status === 400) {
    log('passed', 'Token de reset forgé rejeté correctement');
  } else if (resetRes.status === 200) {
    log('critical', 'Token de reset forgé ACCEPTÉ! Vulnérabilité de réinitialisation de mot de passe');
  } else {
    log('info', `Reset avec token forgé: status=${resetRes.status}`);
  }

  await sleep(DELAY_MS);

  // Vérifier que forgot-password ne divulgue pas si l'email existe
  const fp1 = await request('POST', '/api/auth/forgot-password', { email: 'exists@real.com' });
  const fp2 = await request('POST', '/api/auth/forgot-password', { email: 'nonexistent99999@fake.com' });
  if (fp1.body?.message === fp2.body?.message) {
    log('passed', 'Forgot password: réponse identique qu\'email existe ou non (pas d\'enumeration)');
  } else {
    log('warning', 'Forgot password: messages différents selon que l\'email existe ou non',
      `exists="${fp1.body?.message}" | not_exists="${fp2.body?.message}"`);
  }
}

// ─── Rapport final ────────────────────────────────────────────────────────────
function printReport() {
  const line = '═'.repeat(62);
  console.log(`\n${C.bold}${C.magenta}${line}${C.reset}`);
  console.log(`${C.bold}${C.magenta}        RAPPORT DE SÉCURITÉ — TWITNINF API${C.reset}`);
  console.log(`${C.bold}${C.magenta}${line}${C.reset}\n`);

  const total = results.critical.length + results.warning.length + results.info.length + results.passed.length;

  console.log(`  Tests exécutés     : ${C.bold}${testCount} catégories${C.reset}`);
  console.log(`  Points analysés    : ${C.bold}${total}${C.reset}`);
  console.log(`  ✅ Passés          : ${C.green}${C.bold}${results.passed.length}${C.reset}`);
  console.log(`  ⚠️  Avertissements  : ${C.yellow}${C.bold}${results.warning.length}${C.reset}`);
  console.log(`  💀 Critiques       : ${C.red}${C.bold}${results.critical.length}${C.reset}`);

  if (results.critical.length > 0) {
    console.log(`\n${C.red}${C.bold}💀 VULNÉRABILITÉS CRITIQUES À CORRIGER EN PRIORITÉ:${C.reset}`);
    results.critical.forEach((r, i) => {
      console.log(`  ${i + 1}. ${C.red}${r.msg}${C.reset}`);
      if (r.detail) console.log(`     ${C.dim}${r.detail}${C.reset}`);
    });
  }

  if (results.warning.length > 0) {
    console.log(`\n${C.yellow}${C.bold}⚠️  AVERTISSEMENTS (à examiner):${C.reset}`);
    results.warning.forEach((r, i) => {
      console.log(`  ${i + 1}. ${C.yellow}${r.msg}${C.reset}`);
      if (r.detail) console.log(`     ${C.dim}${r.detail}${C.reset}`);
    });
  }

  console.log(`\n${C.bold}📋 RECOMMANDATIONS SPÉCIFIQUES À TON API:${C.reset}`);
  console.log(`  • [corrigé 2026-08-01] JWT_SECRET était codé en dur et faible — remplacé par une valeur aléatoire forte, plus de fallback en dur dans config.js`);
  console.log(`  • Le JWT_SECRET est le même pour access ET refresh tokens — utilise 2 secrets différents`);
  console.log(`  • Les endpoints /api/policiercongo/* n'ont pas de middleware d'auth apparent — vérifier`);
  console.log(`  • Le header X-Powered-By: Express expose la technologie — désactiver avec app.disable('x-powered-by')`);
  console.log(`  • /api/health expose la mémoire RAM et la version — restreindre en production`);
  console.log(`  • Ajouter un compte-rendu d'IP dans les logs de login pour détecter les attaques`);
  console.log(`  • La route /test expose la structure interne de l'API`);
  console.log(`  • Implémenter un blacklist de tokens JWT révoqués (Redis) pour invalider les sessions`);

  const score = Math.max(0, 100 - results.critical.length * 20 - results.warning.length * 5);
  const scoreColor = score >= 80 ? C.green : score >= 50 ? C.yellow : C.red;
  console.log(`\n${C.bold}Score de sécurité estimé: ${scoreColor}${score}/100${C.reset}`);
  console.log(`\n${C.dim}Audit réalisé le ${new Date().toLocaleString('fr-FR')} contre ${BASE_URL}${C.reset}`);
  console.log(`${C.bold}${C.magenta}${line}${C.reset}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║       🔐 TWITNINF API — SECURITY AUDIT SCRIPT            ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  Cible: ${C.bold}${BASE_URL}${C.reset}`);
  console.log(`  ${C.dim}Utilisation: node security-audit.js [BASE_URL]${C.reset}\n`);

  try {
    await testConnectivity();
    await sleep(DELAY_MS);
    await testSecurityHeaders();
    await sleep(DELAY_MS);
    await testAuth();
    await sleep(DELAY_MS);
    await testRateLimiting();
    await sleep(DELAY_MS);
    await testJWTSecurity();
    await sleep(DELAY_MS);
    await testAuthorization();
    await sleep(DELAY_MS);
    await testInjection();
    await sleep(DELAY_MS);
    await testXSS();
    await sleep(DELAY_MS);
    await testUnauthenticatedEndpoints();
    await sleep(DELAY_MS);
    await testMassAssignment();
    await sleep(DELAY_MS);
    await testDoSVectors();
    await sleep(DELAY_MS);
    await testCORS();
    await sleep(DELAY_MS);
    await testInfoDisclosure();
    await sleep(DELAY_MS);
    await testFileUpload();
    await sleep(DELAY_MS);
    await testPasswordReset();
  } catch (err) {
    console.error(`\n${C.red}Erreur inattendue durant l'audit:${C.reset}`, err.message);
  }

  printReport();
}

main();
