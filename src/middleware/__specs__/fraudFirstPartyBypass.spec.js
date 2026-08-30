/**
 * Exemption anti-fraude des clients officiels (app mobile, desktop Windows).
 *
 * L'exemption dispense du SCORING COMPORTEMENTAL (rate limit, réputation IP,
 * vélocité) qui bannissait à tort le trafic normal de l'app. Elle ne doit
 * JAMAIS dispenser de la détection d'injection, ni s'appliquer sans JWT
 * vérifié, ni sur les routes d'authentification et de paiement.
 */
// `config` lit JWT_SECRET au chargement du module : le poser AVANT le require,
// sinon `jwt.sign` échoue sur « secretOrPrivateKey must have a value » et toute
// la suite tombe. Aucun fichier de setup Jest global n'existe sur ce dépôt.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'first-party-bypass-spec-secret';

const jwt = require('jsonwebtoken');
const config = require('../../config/config');

// Le préfixe `mock` est requis : jest.mock est hissé au-dessus des déclarations.
const mockState = { analyzeCalls: 0 };

jest.mock('../../services/fraudDetectionService', () => ({
  isReady: () => true,
  isIpBlocked: async () => false,
  analyzeRequest: async () => { mockState.analyzeCalls++; return null; },
  analyzeLogin: async () => null,
}));
jest.mock('../../utils/logger', () => ({
  info() {}, warn() {}, error() {}, debug() {},
}));

const fraud = require('../fraudMiddleware');

const validJwt = jwt.sign({ id: 'user-1', username: 'u1' }, config.jwt.secret, {
  expiresIn: '1h',
});

const MOBILE_HEADERS = {
  'x-twitninf-client': 'mobile-expo',
  'user-platform': 'android',
  'x-device-id': 'abcdef0123456789',
  'x-app-version': '1.0.0',
  authorization: `Bearer ${validJwt}`,
};

// Ce que `twitninf-web/src/lib/api.ts` pose sur chaque requête.
const WEB_HEADERS = {
  'x-twitninf-client': 'twitninf-web',
  'user-platform': 'web',
  'x-app-ownership': 'standalone',
  'x-device-id': 'web-1f0c8f6a-2b4e-4c1d-9a3e-77a1c0b5d2e8',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0',
  authorization: `Bearer ${validJwt}`,
};

function mkReq(overrides = {}) {
  const path = overrides.path || '/api/tweets';
  return {
    method: 'GET',
    params: {},
    query: {},
    body: {},
    ip: '1.2.3.4',
    socket: { remoteAddress: '1.2.3.4' },
    headers: {},
    ...overrides,
    path,
    originalUrl: overrides.originalUrl || path,
    url: overrides.url || path,
  };
}

/** Exécute checkApiRequest et rapporte s'il a bloqué. */
function run(req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ blocked: true, status: this.statusCode, payload }); },
      setHeader() {},
    };
    fraud.checkApiRequest(req, res, () => resolve({ blocked: false }));
  });
}

beforeEach(() => { mockState.analyzeCalls = 0; });

describe('reconnaissance du client', () => {
  it('reconnaît le transport de l’app mobile', () => {
    expect(fraud.hasMobileAppTransport(mkReq({ headers: MOBILE_HEADERS }))).toBe(true);
  });

  it('accorde sa confiance à un client mobile authentifié', () => {
    expect(fraud.isTrustedFirstPartyClient(mkReq({ headers: MOBILE_HEADERS }))).toBe(true);
  });

  it('refuse sa confiance à des en-têtes sans JWT (falsifiables)', () => {
    const headers = { ...MOBILE_HEADERS };
    delete headers.authorization;
    expect(fraud.isTrustedFirstPartyClient(mkReq({ headers }))).toBe(false);
  });

  it('refuse sa confiance à un JWT signé avec un autre secret', () => {
    const forged = jwt.sign({ id: 'x' }, 'mauvais-secret');
    const headers = { ...MOBILE_HEADERS, authorization: `Bearer ${forged}` };
    expect(fraud.isTrustedFirstPartyClient(mkReq({ headers }))).toBe(false);
  });

  it.each([
    '/api/auth/login',
    '/api/payments/charge',
    '/api/premium/subscribe',
    '/api/new-economy/purchase',
  ])('n’exempte jamais %s', (path) => {
    expect(fraud.isTrustedFirstPartyClient(mkReq({ headers: MOBILE_HEADERS, path }))).toBe(false);
    expect(fraud.isTrustedFirstPartyClient(mkReq({ headers: WEB_HEADERS, path }))).toBe(false);
  });

  it('reconnaît le transport du client web', () => {
    expect(fraud.hasWebAppTransport(mkReq({ headers: WEB_HEADERS }))).toBe(true);
  });

  it('accorde sa confiance à un client web authentifié', () => {
    expect(fraud.isTrustedFirstPartyClient(mkReq({ headers: WEB_HEADERS }))).toBe(true);
  });

  it.each([
    ['sans JWT', 'authorization'],
    ['sans identifiant d’appareil', 'x-device-id'],
    ['sans en-tête de propriété', 'x-app-ownership'],
  ])('refuse sa confiance à un client web %s', (_label, missing) => {
    const headers = { ...WEB_HEADERS };
    delete headers[missing];
    expect(fraud.isTrustedFirstPartyClient(mkReq({ headers }))).toBe(false);
  });

  it('ne confond pas un navigateur ordinaire avec le client web', () => {
    // Un onglet qui appelle l'API sans les en-têtes maison reste scoré : c'est
    // le quadruplet qui identifie le client, pas le fait d'être un navigateur.
    const headers = { authorization: `Bearer ${validJwt}`, 'user-agent': WEB_HEADERS['user-agent'] };
    expect(fraud.isTrustedFirstPartyClient(mkReq({ headers }))).toBe(false);
  });
});

describe('scoring comportemental', () => {
  it('laisse passer le trafic mobile légitime sans le scorer', async () => {
    const res = await run(mkReq({ headers: MOBILE_HEADERS }));

    expect(res.blocked).toBe(false);
    expect(mockState.analyzeCalls).toBe(0);
  });

  it('laisse passer le trafic web légitime sans le scorer', async () => {
    const res = await run(mkReq({ headers: WEB_HEADERS }));

    expect(res.blocked).toBe(false);
    expect(mockState.analyzeCalls).toBe(0);
  });

  it('score toujours le trafic qui n’est pas first-party', async () => {
    const res = await run(mkReq({
      method: 'POST',
      path: '/api/tweets/create',
      headers: { 'user-agent': 'curl/8' },
    }));

    expect(res.blocked).toBe(false);
    expect(mockState.analyzeCalls).toBe(1);
  });
});

describe('détection d’injection — jamais exemptée', () => {
  it.each([
    ['SQL', { search: "' OR 1=1--" }],
    ['SQL union', { q: 'union select password from users' }],
    ['XSS', { bio: '<script>alert(1)</script>' }],
  ])('bloque une injection %s venant d’un client de confiance', async (_label, query) => {
    const res = await run(mkReq({ headers: MOBILE_HEADERS, query }));

    expect(res.blocked).toBe(true);
    expect(res.status).toBe(403);
    expect(res.payload.code).toMatch(/^ATTACK_/);
  });

  it('bloque une injection dans le body d’un POST de confiance', async () => {
    const res = await run(mkReq({
      method: 'POST',
      headers: MOBILE_HEADERS,
      body: { content: "x'; DROP TABLE users; --" },
    }));

    expect(res.blocked).toBe(true);
    expect(res.status).toBe(403);
  });

  it('scanne aussi les routes classées « bruit de navigation »', async () => {
    const res = await run(mkReq({
      path: '/api/users/search',
      query: { q: "' OR 1=1--" },
    }));

    expect(res.blocked).toBe(true);
    expect(res.status).toBe(403);
  });
});
