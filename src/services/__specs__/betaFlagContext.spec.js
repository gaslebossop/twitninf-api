const assert = require('node:assert');

/**
 * LE défaut silencieux du programme beta.
 *
 * L'attribut de ciblage `is_beta` est mis en cache Redis cinq minutes, dans la
 * même entrée que `country` et `nf_balance` (`feature-flags:ctx:<user_id>`).
 * Approuver un compte sans purger cette entrée le laisse jusqu'à cinq minutes
 * sur l'ancien fil : aucune erreur, aucun log, et une interface qui lui
 * affiche déjà le badge BETA. C'est invisible en développement, où le cache
 * est froid, et systématique en production.
 *
 * Ces tests fixent les deux moitiés du contrat :
 *   1. `is_beta` ne vaut vrai QUE pour un membre `approved` ;
 *   2. toute écriture de statut purge l'entrée de cache du compte concerné.
 */

jest.mock('../../utils/logger', () => ({ info: () => {}, warn: () => {}, error: () => {} }));

const mockRedisStore = new Map();
const mockDeleted = [];

jest.mock('redis', () => ({
  createClient: () => ({
    isReady: true,
    connect: async () => {},
    on: () => {},
    get: async (key) => (mockRedisStore.has(key) ? mockRedisStore.get(key) : null),
    set: async (key, value) => {
      mockRedisStore.set(key, value);
    },
    del: async (key) => {
      mockDeleted.push(key);
      mockRedisStore.delete(key);
    },
    publish: async () => {},
    subscribe: async () => {},
  }),
}));

/** Membres en mémoire, indexés par identifiant. */
const mockMembers = new Map();

function mockFakeMember(userId, status) {
  const row = {
    user_id: userId,
    status,
    applied_at: new Date('2026-08-01T00:00:00Z'),
    approved_at: null,
    revoked_at: null,
    reviewed_at: null,
    reviewed_by: null,
    review_note: null,
    motivation: null,
    async update(fields) {
      Object.assign(this, fields);
      return this;
    },
  };
  mockMembers.set(userId, row);
  return row;
}

/** Drapeau servi par le faux `FeatureFlag.findAll`. Rempli par les tests. */
const mockFlagRows = [];

jest.mock('../../models', () => ({
  sequelize: { query: async () => [] },
  User: { findByPk: async () => null, findOne: async () => null },
  FeatureFlag: {
    findAll: async () => mockFlagRows,
  },
  BetaMember: {
    findByPk: async (id) => mockMembers.get(id) || null,
    findOne: async ({ where }) => {
      const row = mockMembers.get(where.user_id);
      return row && row.status === where.status ? row : null;
    },
    count: async ({ where }) =>
      [...mockMembers.values()].filter((m) => m.status === where.status).length,
    create: async (fields) => mockFakeMember(fields.user_id, fields.status),
  },
  BetaSettings: {
    load: async () => ({
      id: 1,
      is_open: true,
      capacity: null,
      headline: 'La beta TwitNinf',
      pitch: null,
      async update(fields) {
        Object.assign(this, fields);
        return this;
      },
    }),
  },
}));

beforeEach(() => {
  mockMembers.clear();
  mockRedisStore.clear();
  mockDeleted.length = 0;
});

// ───────────────── 1. Qui vaut `is_beta = true` ─────────────────

describe('is_beta', () => {
  const cases = [
    ['approved', true],
    ['pending', false],
    ['rejected', false],
    ['revoked', false],
    ['left', false],
  ];

  test.each(cases)('un compte %s → is_beta = %s', async (status, expected) => {
    jest.resetModules();
    mockFakeMember('u1', status);
    const flags = require('../featureFlagService');
    const context = await flags.resolveLazyAttributes(
      { user_id: 'u1' },
      { beta: { key: 'x', rules: [{ conditions: [{ attribute: 'is_beta', operator: 'eq', value: true }] }] } }
    );
    assert.strictEqual(context.is_beta, expected);
  });

  test('un compte sans ligne du tout → is_beta = false', async () => {
    jest.resetModules();
    const flags = require('../featureFlagService');
    const context = await flags.resolveLazyAttributes(
      { user_id: 'inconnu' },
      { beta: { key: 'x', rules: [{ conditions: [{ attribute: 'is_beta', operator: 'eq', value: true }] }] } }
    );
    assert.strictEqual(context.is_beta, false);
  });

  test("l'attribut n'est PAS résolu si aucun drapeau ne le référence", async () => {
    jest.resetModules();
    mockFakeMember('u1', 'approved');
    const flags = require('../featureFlagService');
    const context = await flags.resolveLazyAttributes(
      { user_id: 'u1' },
      { autre: { key: 'autre', rules: [] } }
    );
    // Ne pas payer une requête pour un attribut que personne ne cible.
    assert.strictEqual(context.is_beta, undefined);
  });
});

// ───── 1bis. Les deux chemins d'évaluation disent la même chose ─────

/**
 * `resolveAll` (ce que lit l'app via `/resolve`) et `evaluateFlag`/`isEnabled`
 * (ce que lit le middleware `requireFlag` et toute garde serveur) doivent
 * rendre le MÊME verdict.
 *
 * Ce n'était pas le cas : seul `resolveAll` résolvait les attributs coûteux.
 * Un ciblage sur `is_beta`, `country` ou `nf_balance` évaluait donc côté
 * serveur comme si l'attribut n'existait pas — le segment ne matchait jamais
 * et le drapeau retombait sur son palier global. L'app disait « oui », la
 * garde serveur « non », sans la moindre erreur.
 */
describe('les deux chemins d’évaluation concordent', () => {
  const FLAG = {
    key: 'fil.refonte2b',
    enabled: true,
    rollout_percentage: 0,
    rules: [
      {
        id: 'beta',
        percentage: 100,
        conditions: [{ attribute: 'is_beta', operator: 'eq', value: true }],
      },
    ],
    variants: [],
    allowlist: [],
    blocklist: [],
    bucket_by: 'user',
    salt: 'v1',
  };

  async function bothPaths(status) {
    jest.resetModules();
    mockMembers.clear();
    mockRedisStore.clear();
    if (status) mockFakeMember('u1', status);

    const flags = require('../featureFlagService');
    // Le service lit ses définitions en base ; on court-circuite au plus près.
    jest.spyOn(flags, 'getDefinitions');
    const definitions = { [FLAG.key]: FLAG };

    const viaResolveAll = await (async () => {
      const context = await flags.resolveLazyAttributes({ user_id: 'u1' }, definitions);
      return require('../featureFlagEvaluator').evaluate(FLAG, context);
    })();

    const viaEvaluate = await (async () => {
      const context = await flags.resolveLazyAttributes({ user_id: 'u1' }, { [FLAG.key]: FLAG });
      return require('../featureFlagEvaluator').evaluate(FLAG, context);
    })();

    return { viaResolveAll, viaEvaluate };
  }

  test('un membre est allumé par les deux chemins', async () => {
    const { viaResolveAll, viaEvaluate } = await bothPaths('approved');
    assert.strictEqual(viaResolveAll.enabled, true);
    assert.strictEqual(viaEvaluate.enabled, true);
    assert.strictEqual(viaEvaluate.rule, 'beta');
  });

  test('un non-membre est éteint par les deux chemins', async () => {
    const { viaResolveAll, viaEvaluate } = await bothPaths('pending');
    assert.strictEqual(viaResolveAll.enabled, false);
    assert.strictEqual(viaEvaluate.enabled, false);
  });

  test('`evaluateFlag` résout bien l’attribut coûteux du drapeau visé', async () => {
    jest.resetModules();
    mockMembers.clear();
    mockRedisStore.clear();
    mockFlagRows.length = 0;
    // Le service lit ses définitions via `FeatureFlag.findAll().toDefinition()` :
    // écraser `getDefinitions` sur l'export ne servirait à rien, l'appel interne
    // ne passe pas par le module.
    mockFlagRows.push({ key: FLAG.key, toDefinition: () => FLAG });
    mockFakeMember('u1', 'approved');

    const flags = require('../featureFlagService');
    const decision = await flags.evaluateFlag(FLAG.key, { user_id: 'u1' });

    // Sans résolution paresseuse dans `evaluateFlag`, `reason` vaudrait
    // « rollout_excluded » (palier global à 0) au lieu de « rule ».
    assert.strictEqual(decision.enabled, true);
    assert.strictEqual(decision.reason, 'rule');
  });

  test('`isEnabled` suit — c’est ce que lit le middleware `requireFlag`', async () => {
    jest.resetModules();
    mockMembers.clear();
    mockRedisStore.clear();
    mockFlagRows.length = 0;
    mockFlagRows.push({ key: FLAG.key, toDefinition: () => FLAG });
    mockFakeMember('u1', 'approved');

    const flags = require('../featureFlagService');
    assert.strictEqual(await flags.isEnabled(FLAG.key, { user_id: 'u1' }), true);
  });

});

// ───────────────── 2. La purge du cache ─────────────────

describe('purge du cache après changement de statut', () => {
  const CACHE_KEY = 'feature-flags:ctx:u1';

  test('approuver purge l’entrée de cache du compte', async () => {
    jest.resetModules();
    mockFakeMember('u1', 'pending');
    mockRedisStore.set(CACHE_KEY, JSON.stringify({ is_beta: false }));

    const beta = require('../betaService');
    await beta.approve('u1', 'admin-1');

    assert.ok(mockDeleted.includes(CACHE_KEY), `clé non purgée (purgées: ${mockDeleted.join(', ')})`);
    assert.strictEqual(mockRedisStore.has(CACHE_KEY), false);
  });

  test('après approbation, une résolution immédiate voit is_beta = true', async () => {
    jest.resetModules();
    mockFakeMember('u1', 'pending');
    mockRedisStore.set(CACHE_KEY, JSON.stringify({ is_beta: false }));

    const beta = require('../betaService');
    const flags = require('../featureFlagService');

    await beta.approve('u1', 'admin-1');
    const context = await flags.resolveLazyAttributes(
      { user_id: 'u1' },
      { beta: { key: 'x', rules: [{ conditions: [{ attribute: 'is_beta', operator: 'eq', value: true }] }] } }
    );

    // Sans purge, cette assertion échoue : le cache rendrait encore `false`.
    assert.strictEqual(context.is_beta, true);
  });

  test.each([
    ['reject', 'pending'],
    ['revoke', 'approved'],
    ['leave', 'approved'],
  ])('%s purge aussi le cache', async (action, from) => {
    jest.resetModules();
    mockFakeMember('u1', from);
    mockRedisStore.set(CACHE_KEY, JSON.stringify({ is_beta: from === 'approved' }));

    const beta = require('../betaService');
    if (action === 'leave') await beta.leave('u1');
    else await beta[action]('u1', 'admin-1');

    assert.ok(mockDeleted.includes(CACHE_KEY), `${action} n'a pas purgé le cache`);
  });

  test('candidater purge le cache, y compris à la toute première ligne', async () => {
    jest.resetModules();
    mockRedisStore.set(CACHE_KEY, JSON.stringify({ is_beta: false }));

    const beta = require('../betaService');
    await beta.apply('u1', { source: 'mobile' });

    assert.ok(mockDeleted.includes(CACHE_KEY));
  });
});
