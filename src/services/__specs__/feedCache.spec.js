'use strict';

/**
 * Le cache de feed porte du contenu masqué selon les achats du lecteur. Deux
 * invariants ne doivent jamais casser, et ce sont eux qu'on teste ici :
 *
 *   1. Une réponse cachée pour un utilisateur n'est JAMAIS servie à un autre.
 *   2. Une panne de Redis ralentit le feed, elle ne le casse pas.
 */

// Le cache est désactivé par défaut depuis la mesure du 2026-08-07 (voir
// l'en-tête de feedCache.js). Les tests vérifient son comportement quand il est
// explicitement activé, donc ils posent le drapeau avant de charger le module.
process.env.FEED_CACHE_ENABLED = 'true';

const mockStore = new Map();
const mockSets = new Map();
let mockFailMode = false;

jest.mock('redis', () => ({
  createClient: () => {
    const client = {
      isReady: true,
      on: () => {},
      connect: async () => {},
      get: async (key) => {
        if (mockFailMode) throw new Error('redis down');
        return mockStore.has(key) ? mockStore.get(key) : null;
      },
      del: async (keys) => {
        for (const key of [].concat(keys)) mockStore.delete(key);
      },
      sMembers: async (key) => Array.from(mockSets.get(key) || []),
      multi: () => {
        const ops = [];
        const chain = {
          set: (key, value) => { ops.push(() => mockStore.set(key, value)); return chain; },
          sAdd: (key, value) => {
            ops.push(() => {
              if (!mockSets.has(key)) mockSets.set(key, new Set());
              mockSets.get(key).add(value);
            });
            return chain;
          },
          expire: () => chain,
          exec: async () => { ops.forEach((run) => run()); },
        };
        return chain;
      },
    };
    return client;
  },
}));

jest.mock('../../utils/logger', () => ({ warn: () => {}, info: () => {}, error: () => {} }));

const { withFeedCache, invalidateUserFeed } = require('../feedCache');

// L'écriture dans le cache est volontairement lancée sans être attendue, pour
// ne pas retarder la réponse. Les tests laissent donc la boucle tourner un tour.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('feedCache', () => {
  beforeEach(() => {
    mockStore.clear();
    mockSets.clear();
    mockFailMode = false;
  });

  it("ne sert jamais la réponse d'un utilisateur à un autre", async () => {
    const params = { limit: 10, offset: 0 };

    const alice = await withFeedCache({ scope: 'reco', userId: 'alice', params }, async () => 'feed-d-alice');
    await settle();
    expect(alice.payload).toBe('feed-d-alice');
    expect(alice.hit).toBe(false);

    // Mêmes paramètres, autre utilisateur : le producteur DOIT être rappelé.
    let bobProduced = false;
    const bob = await withFeedCache({ scope: 'reco', userId: 'bob', params }, async () => {
      bobProduced = true;
      return 'feed-de-bob';
    });
    await settle();

    expect(bobProduced).toBe(true);
    expect(bob.payload).toBe('feed-de-bob');
    expect(bob.hit).toBe(false);
  });

  it('sert bien un hit au même utilisateur, sans rappeler le producteur', async () => {
    const params = { limit: 10, offset: 0 };
    await withFeedCache({ scope: 'reco', userId: 'alice', params }, async () => 'feed');
    await settle();

    let produced = false;
    const second = await withFeedCache({ scope: 'reco', userId: 'alice', params }, async () => {
      produced = true;
      return 'recalcule';
    });

    expect(second.hit).toBe(true);
    expect(second.payload).toBe('feed');
    expect(produced).toBe(false);
  });

  it('sépare les pages et les portées', async () => {
    await withFeedCache({ scope: 'reco', userId: 'alice', params: { offset: 0 } }, async () => 'page0');
    await settle();
    const page1 = await withFeedCache({ scope: 'reco', userId: 'alice', params: { offset: 10 } }, async () => 'page1');
    const autre = await withFeedCache({ scope: 'neural', userId: 'alice', params: { offset: 0 } }, async () => 'neural');
    await settle();

    expect(page1.payload).toBe('page1');
    expect(page1.hit).toBe(false);
    expect(autre.payload).toBe('neural');
    expect(autre.hit).toBe(false);
  });

  it('invalide toutes les entrées d\'un utilisateur, et seulement les siennes', async () => {
    await withFeedCache({ scope: 'reco', userId: 'alice', params: { offset: 0 } }, async () => 'a0');
    await withFeedCache({ scope: 'reco', userId: 'alice', params: { offset: 10 } }, async () => 'a1');
    await withFeedCache({ scope: 'reco', userId: 'bob', params: { offset: 0 } }, async () => 'b0');
    await settle();

    await invalidateUserFeed('alice');

    const alice = await withFeedCache({ scope: 'reco', userId: 'alice', params: { offset: 0 } }, async () => 'recalcule');
    expect(alice.hit).toBe(false);

    const bob = await withFeedCache({ scope: 'reco', userId: 'bob', params: { offset: 0 } }, async () => 'jamais');
    expect(bob.hit).toBe(true);
    expect(bob.payload).toBe('b0');
  });

  it('sert le feed normalement quand Redis tombe', async () => {
    mockFailMode = true;
    const result = await withFeedCache({ scope: 'reco', userId: 'alice', params: {} }, async () => 'calcule-sans-cache');
    expect(result.payload).toBe('calcule-sans-cache');
    expect(result.hit).toBe(false);
  });

  it('ne cache rien sans utilisateur identifié', async () => {
    let calls = 0;
    const producer = async () => { calls += 1; return 'anonyme'; };
    await withFeedCache({ scope: 'reco', userId: null, params: {} }, producer);
    await withFeedCache({ scope: 'reco', userId: null, params: {} }, producer);
    expect(calls).toBe(2);
  });
});
