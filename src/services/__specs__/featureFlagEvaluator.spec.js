'use strict';

/**
 * Le moteur d'évaluation décide qui voit quoi. Quatre propriétés portent tout
 * le système ; si l'une casse, un déploiement progressif devient ingérable :
 *
 *   1. La décision est STABLE : même utilisateur, même drapeau, même réponse.
 *   2. Monter le palier n'ENLÈVE jamais la fonctionnalité à quelqu'un.
 *   3. Deux drapeaux au même palier ne ciblent pas les mêmes personnes.
 *   4. L'ordre de priorité (coupe-circuit > blocklist > allowlist > segments
 *      > palier global) est respecté.
 */

const {
  evaluate,
  bucketOf,
  compareSemver,
  matchCondition,
} = require('../featureFlagEvaluator');

function makeFlag(overrides = {}) {
  return {
    key: 'feed.new_ranker',
    enabled: true,
    rollout_percentage: 0,
    rules: [],
    variants: [],
    allowlist: [],
    blocklist: [],
    bucket_by: 'user',
    salt: 'v1',
    payload: null,
    start_at: null,
    end_at: null,
    archived_at: null,
    ...overrides,
  };
}

const users = Array.from({ length: 500 }, (_, i) => ({ user_id: `user-${i}` }));

describe('stabilité du tirage', () => {
  it('rend la même décision pour le même utilisateur', () => {
    const flag = makeFlag({ rollout_percentage: 37 });
    for (const context of users.slice(0, 50)) {
      const first = evaluate(flag, context);
      const second = evaluate(flag, context);
      expect(second.enabled).toBe(first.enabled);
      expect(second.bucket).toBe(first.bucket);
    }
  });

  it('ne retire la fonctionnalité à personne quand le palier monte', () => {
    let included = new Set();
    for (const percentage of [1, 5, 10, 25, 50, 100]) {
      const flag = makeFlag({ rollout_percentage: percentage });
      const next = new Set(users.filter((c) => evaluate(flag, c).enabled).map((c) => c.user_id));
      for (const id of included) {
        expect(next.has(id)).toBe(true);
      }
      included = next;
    }
    expect(included.size).toBe(users.length);
  });

  it('approche le palier demandé sur un échantillon', () => {
    const flag = makeFlag({ rollout_percentage: 20 });
    const hits = users.filter((c) => evaluate(flag, c).enabled).length;
    expect(hits / users.length).toBeGreaterThan(0.12);
    expect(hits / users.length).toBeLessThan(0.28);
  });

  it('ne superpose pas les cohortes de deux drapeaux au même palier', () => {
    const a = new Set(
      users.filter((c) => evaluate(makeFlag({ key: 'flag.a', rollout_percentage: 20 }), c).enabled).map((c) => c.user_id)
    );
    const b = new Set(
      users.filter((c) => evaluate(makeFlag({ key: 'flag.b', rollout_percentage: 20 }), c).enabled).map((c) => c.user_id)
    );
    const overlap = [...a].filter((id) => b.has(id)).length;
    // Si les deux drapeaux hachaient la même chose, l'intersection vaudrait
    // exactement `a.size`. On vérifie qu'elle reste proche du produit des
    // probabilités (~4 % de la population), pas de 20 %.
    expect(overlap).toBeLessThan(a.size * 0.6);
  });

  it('change de cohorte quand le sel change', () => {
    const before = users.filter((c) => evaluate(makeFlag({ rollout_percentage: 30 }), c).enabled).length;
    const after = users.filter(
      (c) => evaluate(makeFlag({ rollout_percentage: 30, salt: 'v2' }), c).enabled
    ).length;
    const sameSet = users.every(
      (c) =>
        evaluate(makeFlag({ rollout_percentage: 30 }), c).enabled ===
        evaluate(makeFlag({ rollout_percentage: 30, salt: 'v2' }), c).enabled
    );
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(0);
    expect(sameSet).toBe(false);
  });
});

describe('ordre de priorité', () => {
  const context = { user_id: 'user-1', username: 'kospor', role: 'admin' };

  it('le coupe-circuit prime sur tout', () => {
    const flag = makeFlag({ enabled: false, rollout_percentage: 100, allowlist: ['user-1'] });
    expect(evaluate(flag, context)).toMatchObject({ enabled: false, reason: 'kill_switch' });
  });

  it('la blocklist prime sur l\'allowlist', () => {
    const flag = makeFlag({ rollout_percentage: 100, allowlist: ['user-1'], blocklist: ['kospor'] });
    expect(evaluate(flag, context)).toMatchObject({ enabled: false, reason: 'blocklist' });
  });

  it('l\'allowlist passe même à 0 %', () => {
    const flag = makeFlag({ rollout_percentage: 0, allowlist: ['@Kospor'] });
    expect(evaluate(flag, context)).toMatchObject({ enabled: true, reason: 'allowlist' });
  });

  it('un segment à 0 % n\'est pas rattrapé par le palier global', () => {
    const flag = makeFlag({
      rollout_percentage: 100,
      rules: [{ id: 'pro', percentage: 0, conditions: [{ attribute: 'role', operator: 'eq', value: 'admin' }] }],
    });
    expect(evaluate(flag, context)).toMatchObject({ enabled: false, reason: 'rule_rollout_excluded' });
  });

  it('respecte la fenêtre de dates', () => {
    const future = makeFlag({ rollout_percentage: 100, start_at: '2099-01-01T00:00:00Z' });
    expect(evaluate(future, context).reason).toBe('before_start');
    const past = makeFlag({ rollout_percentage: 100, end_at: '2000-01-01T00:00:00Z' });
    expect(evaluate(past, context).reason).toBe('after_end');
  });

  it('reste éteint sans unité de tirage', () => {
    const flag = makeFlag({ rollout_percentage: 100 });
    expect(evaluate(flag, { device_id: 'abc' })).toMatchObject({ enabled: false, reason: 'no_bucket_unit' });
  });

  it('tire sur l\'appareil quand c\'est demandé', () => {
    const flag = makeFlag({ rollout_percentage: 100, bucket_by: 'device' });
    expect(evaluate(flag, { device_id: 'abc' }).enabled).toBe(true);
  });
});

describe('conditions de ciblage', () => {
  it('compare les versions sémantiquement, pas alphabétiquement', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
    expect(matchCondition({ attribute: 'app_version', operator: 'semver_gte', value: '1.3.0' }, { app_version: '1.10.2' })).toBe(true);
    expect(matchCondition({ attribute: 'app_version', operator: 'semver_gte', value: '1.3.0' }, { app_version: '1.2.9' })).toBe(false);
  });

  it('exclut un attribut absent d\'une comparaison', () => {
    expect(matchCondition({ attribute: 'app_version', operator: 'semver_gte', value: '1.0.0' }, {})).toBe(false);
    expect(matchCondition({ attribute: 'country', operator: 'not_in', value: 'FR,BE' }, {})).toBe(false);
  });

  it('exige que TOUTES les conditions d\'un segment passent', () => {
    const flag = makeFlag({
      rules: [
        {
          id: 'ios-verifies',
          percentage: 100,
          conditions: [
            { attribute: 'platform', operator: 'eq', value: 'ios' },
            { attribute: 'verified', operator: 'eq', value: true },
          ],
        },
      ],
    });
    expect(evaluate(flag, { user_id: 'u1', platform: 'ios', verified: true }).enabled).toBe(true);
    expect(evaluate(flag, { user_id: 'u1', platform: 'ios', verified: false }).enabled).toBe(false);
  });
});

describe('variantes', () => {
  const flag = makeFlag({
    rollout_percentage: 100,
    variants: [
      { key: 'a', weight: 1, payload: { color: 'indigo' } },
      { key: 'b', weight: 1, payload: { color: 'gold' } },
    ],
  });

  it('répartit les variantes sans coller au bucket de rollout', () => {
    const counts = { a: 0, b: 0 };
    for (const context of users) counts[evaluate(flag, context).variant] += 1;
    expect(counts.a).toBeGreaterThan(users.length * 0.35);
    expect(counts.b).toBeGreaterThan(users.length * 0.35);
  });

  it('sert la charge utile de la variante', () => {
    const decision = evaluate(flag, { user_id: 'user-3' });
    expect(decision.payload).toEqual(expect.objectContaining({ color: expect.any(String) }));
  });

  it('n\'inverse pas les variantes des premiers entrants du rollout', () => {
    // Les utilisateurs à bucket bas sont ceux qui entrent en premier dans le
    // rollout. Sans sel dédié, ils tomberaient tous sur la même variante.
    const early = users
      .map((c) => ({ ...c, bucket: bucketOf(flag.key, flag.salt, c.user_id) }))
      .sort((x, y) => x.bucket - y.bucket)
      .slice(0, 40);
    const variants = new Set(early.map((c) => evaluate(flag, c).variant));
    expect(variants.size).toBe(2);
  });
});

/**
 * Le boost sert le cas « les abonnés d'abord, mais pas qu'eux ». Un segment
 * ordinaire est exclusif ; un boost est relatif au palier global, donc il
 * donne de l'avance et sature à 100 % en même temps que tout le monde.
 */
describe('segments boostés', () => {
  const premium = (boost) => ({
    id: 'premium',
    label: 'Abonnés',
    boost,
    conditions: [{ attribute: 'premium', operator: 'eq', value: true }],
  });

  function shareOf(flag, context, count = 4000) {
    let seen = 0;
    for (let i = 0; i < count; i += 1) {
      if (evaluate(flag, { ...context, user_id: `u${i}` }).enabled) seen += 1;
    }
    return seen / count;
  }

  test('sert plus d’abonnés que d’autres comptes, sans exclure personne', () => {
    const flag = makeFlag({ rollout_percentage: 20, rules: [premium(2)] });

    const withPremium = shareOf(flag, { premium: true });
    const withoutPremium = shareOf(flag, { premium: false });

    expect(withPremium).toBeGreaterThan(0.35);
    expect(withPremium).toBeLessThan(0.45);
    // Le point de tout l'exercice : les non-abonnés avancent aussi.
    expect(withoutPremium).toBeGreaterThan(0.15);
    expect(withoutPremium).toBeLessThan(0.25);
  });

  test('sature à 100 % : le boost donne de l’avance, jamais l’exclusivité', () => {
    const flag = makeFlag({ rollout_percentage: 100, rules: [premium(2)] });

    expect(shareOf(flag, { premium: true })).toBe(1);
    expect(shareOf(flag, { premium: false })).toBe(1);
  });

  test('suit le palier global sans qu’on ait à toucher au segment', () => {
    const at = (base) =>
      shareOf(makeFlag({ rollout_percentage: base, rules: [premium(3)] }), { premium: true });

    expect(at(5)).toBeGreaterThan(at(2));
    expect(at(20)).toBeGreaterThan(at(5));
  });

  test('n’enlève la fonctionnalité à personne quand le palier monte', () => {
    const kept = (base) => {
      const flag = makeFlag({ rollout_percentage: base, rules: [premium(2)] });
      const inside = new Set();
      for (let i = 0; i < 2000; i += 1) {
        if (evaluate(flag, { user_id: `u${i}`, premium: true }).enabled) inside.add(`u${i}`);
      }
      return inside;
    };

    const before = kept(10);
    const after = kept(25);
    for (const user of before) expect(after.has(user)).toBe(true);
  });

  test('un palier global à 0 % ne sert personne, même boosté', () => {
    const flag = makeFlag({ rollout_percentage: 0, rules: [premium(5)] });
    expect(shareOf(flag, { premium: true })).toBe(0);
  });
});
