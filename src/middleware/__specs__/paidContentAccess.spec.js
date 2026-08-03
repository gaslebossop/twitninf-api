'use strict';

/**
 * Le masquage à la lecture ne protège que l'affichage. Ces tests portent sur
 * les ÉCRITURES : liker, retweeter, répondre, traduire un contenu qu'on n'a
 * pas acheté. Un retweet en particulier republie le contenu — le laisser
 * passer revenait à offrir la marchandise à tous les abonnés de l'acheteur.
 */

const mockTweets = new Map();
const mockLocks = [];
const mockPurchases = [];

jest.mock('../../models', () => ({
  Tweet: {
    findByPk: jest.fn(async (id) => mockTweets.get(String(id)) || null),
  },
  PaidContent: {
    findAll: jest.fn(async ({ where }) => {
      const wanted = where.content_id[Object.getOwnPropertySymbols(where.content_id)[0]] || [];
      const ids = new Set(wanted.map(String));
      return mockLocks.filter((l) => ids.has(String(l.content_id)));
    }),
  },
  ContentPurchase: {
    findAll: jest.fn(async ({ where }) => mockPurchases.filter(
      (p) => String(p.buyer_id) === String(where.buyer_id),
    )),
  },
  Story: {},
  User: {},
  Notification: {},
}));

jest.mock('../../database/index', () => ({ sequelize: { transaction: jest.fn() } }));
jest.mock('../../economy', () => ({
  EconomyLedger: {},
  roundTWC: (v) => Math.round(Number(v) * 100) / 100,
  toAmount: (v) => Number(v) || 0,
}));
jest.mock('../../economy/platformCurrency', () => ({ getPlatformCurrency: jest.fn() }));

const { requireContentAccess } = require('../paidContentAccess');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function runGuard(guard, req) {
  const res = fakeRes();
  return new Promise((resolve) => {
    let called = false;
    guard(req, res, () => { called = true; resolve({ passed: true, res }); })
      .then(() => { if (!called) resolve({ passed: false, res }); });
  });
}

beforeEach(() => {
  mockTweets.clear();
  mockLocks.length = 0;
  mockPurchases.length = 0;
});

describe('requireContentAccess', () => {
  test('laisse passer un tweet libre', async () => {
    mockTweets.set('t1', { id: 't1', original_tweet_id: null });

    const { passed } = await runGuard(requireContentAccess(), {
      params: { id: 't1' },
      user: { id: 'viewer-1' },
    });

    expect(passed).toBe(true);
  });

  test('refuse un tweet verrouillé non acheté', async () => {
    mockTweets.set('t2', { id: 't2', original_tweet_id: null });
    mockLocks.push({ id: 'lock-t2', content_type: 'tweet', content_id: 't2', creator_id: 'creator-1', is_active: true });

    const { passed, res } = await runGuard(requireContentAccess(), {
      params: { id: 't2' },
      user: { id: 'viewer-1' },
    });

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('PAID_CONTENT_LOCKED');
  });

  test('refuse quand c\'est l\'ORIGINAL du retweet qui est vendu', async () => {
    mockTweets.set('rt1', { id: 'rt1', original_tweet_id: 'src1' });
    mockLocks.push({ id: 'lock-src1', content_type: 'tweet', content_id: 'src1', creator_id: 'creator-1', is_active: true });

    const { passed, res } = await runGuard(requireContentAccess(), {
      params: { id: 'rt1' },
      user: { id: 'viewer-1' },
    });

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test('laisse passer un acheteur', async () => {
    mockTweets.set('t3', { id: 't3', original_tweet_id: null });
    mockLocks.push({ id: 'lock-t3', content_type: 'tweet', content_id: 't3', creator_id: 'creator-1', is_active: true });
    mockPurchases.push({ paid_content_id: 'lock-t3', buyer_id: 'viewer-1' });

    const { passed } = await runGuard(requireContentAccess(), {
      params: { id: 't3' },
      user: { id: 'viewer-1' },
    });

    expect(passed).toBe(true);
  });

  test('laisse passer l\'auteur sur son propre contenu', async () => {
    mockTweets.set('t4', { id: 't4', original_tweet_id: null });
    mockLocks.push({ id: 'lock-t4', content_type: 'tweet', content_id: 't4', creator_id: 'creator-1', is_active: true });

    const { passed } = await runGuard(requireContentAccess(), {
      params: { id: 't4' },
      user: { id: 'creator-1' },
    });

    expect(passed).toBe(true);
  });

  test('refuse un visiteur anonyme (route publique de traduction)', async () => {
    mockTweets.set('t5', { id: 't5', original_tweet_id: null });
    mockLocks.push({ id: 'lock-t5', content_type: 'tweet', content_id: 't5', creator_id: 'creator-1', is_active: true });

    const { passed, res } = await runGuard(requireContentAccess(), {
      params: { id: 't5' },
      user: undefined,
    });

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test('refuse une réponse quand le PARENT est verrouillé', async () => {
    mockTweets.set('parent1', { id: 'parent1', original_tweet_id: null });
    mockLocks.push({ id: 'lock-parent1', content_type: 'tweet', content_id: 'parent1', creator_id: 'creator-1', is_active: true });

    const { passed, res } = await runGuard(
      requireContentAccess({ param: null, bodyField: 'parent_tweet_id' }),
      { params: {}, body: { parent_tweet_id: 'parent1' }, user: { id: 'viewer-1' } },
    );

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test('laisse passer un tweet racine (aucun parent dans le corps)', async () => {
    const { passed } = await runGuard(
      requireContentAccess({ param: null, bodyField: 'parent_tweet_id' }),
      { params: {}, body: { content: 'Bonjour' }, user: { id: 'viewer-1' } },
    );

    expect(passed).toBe(true);
  });

  test('refuse en cas d\'erreur — jamais d\'échec ouvert sur une écriture', async () => {
    const { Tweet } = require('../../models');
    Tweet.findByPk.mockRejectedValueOnce(new Error('base indisponible'));

    const { passed, res } = await runGuard(requireContentAccess(), {
      params: { id: 't6' },
      user: { id: 'viewer-1' },
    });

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(500);
  });
});
