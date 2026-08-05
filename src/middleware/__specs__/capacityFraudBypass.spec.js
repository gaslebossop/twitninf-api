'use strict';

process.env.INTERNAL_SECRET = 'capacity-test-secret';

const mockState = { analyzeCalls: 0 };

jest.mock('../../services/fraudDetectionService', () => ({
  isReady: () => true,
  isIpBlocked: async () => true,
  analyzeRequest: async () => { mockState.analyzeCalls += 1; return null; },
}));
jest.mock('../../utils/logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));

const fraud = require('../fraudMiddleware');

const capacityHeaders = {
  'x-twitninf-capacity-run': 'capacity-20260805T120000-a1b2c3',
  'x-internal-secret': 'capacity-test-secret',
  'user-agent': 'TwitninfClusterCapacity/1.0',
};

function request(overrides = {}) {
  return {
    method: 'GET', path: '/api/tweets', originalUrl: '/api/tweets', url: '/api/tweets',
    ip: '127.100.1.1', socket: { remoteAddress: '127.100.1.1' },
    headers: capacityHeaders, params: {}, query: {}, body: {}, ...overrides,
  };
}

function invoke(middleware, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ blocked: true, status: this.statusCode, payload }); },
      setHeader() {},
    };
    middleware(req, res, () => resolve({ blocked: false }));
  });
}

describe('exemption anti-fraude du benchmark admin', () => {
  beforeEach(() => { mockState.analyzeCalls = 0; });

  it('traverse la blocklist et le scoring avec secret exact depuis 127/8', async () => {
    const req = request();
    expect(fraud.isTrustedCapacityRequest(req)).toBe(true);
    expect((await invoke(fraud.blockBannedIp, req)).blocked).toBe(false);
    expect((await invoke(fraud.checkApiRequest, req)).blocked).toBe(false);
    expect(mockState.analyzeCalls).toBe(0);
  });

  it('refuse le bypass hors loopback ou avec un secret incorrect', () => {
    expect(fraud.isTrustedCapacityRequest(request({ ip: '8.8.8.8' }))).toBe(false);
    expect(fraud.isTrustedCapacityRequest(request({
      headers: { ...capacityHeaders, 'x-internal-secret': 'incorrect' },
    }))).toBe(false);
  });

  it('conserve le blocage des injections avant toute exemption', async () => {
    const result = await invoke(fraud.checkApiRequest, request({ query: { q: "' OR 1=1--" } }));
    expect(result.blocked).toBe(true);
    expect(result.payload.code).toMatch(/^ATTACK_/);
  });
});
