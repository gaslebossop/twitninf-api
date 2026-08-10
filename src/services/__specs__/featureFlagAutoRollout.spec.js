'use strict';

/**
 * La montée automatique élargit la portée d'une fonctionnalité sans personne
 * derrière le volant. Trois propriétés la rendent sûre ; sans elles, on ne
 * pourrait pas l'armer sur autre chose qu'un drapeau sans importance :
 *
 *   1. Elle ne fait QUE monter, un cran à la fois, jamais deux d'un coup.
 *   2. Un geste humain (extinction, palier changé à la main) l'arrête, et elle
 *      ne repart jamais toute seule.
 *   3. Elle écrit le palier là où il est réellement lu — sur le segment quand
 *      le drapeau est ciblé, sinon sur le palier global.
 */

const auto = require('../featureFlagAutoRollout');

const T0 = new Date('2026-08-10T12:00:00.000Z');
const minutes = (from, count) => new Date(from.getTime() + count * 60000);

function makeFlag(overrides = {}) {
  return {
    key: 'fil.nouveau_classement',
    enabled: true,
    rollout_percentage: 0,
    rules: [],
    archived_at: null,
    auto_rollout: null,
    ...overrides,
  };
}

/** Arme un drapeau sans passer par la base : `buildPlan` est pure. */
function armed(flag, options = {}) {
  return { ...flag, auto_rollout: auto.buildPlan(flag, options, T0) };
}

describe('featureFlagAutoRollout — armement', () => {
  test('le premier cran n’est pas immédiat : on observe le palier de départ', () => {
    const plan = auto.buildPlan(makeFlag(), { interval_minutes: 60 }, T0);

    expect(plan.next_at).toBe(minutes(T0, 60).toISOString());
    expect(plan.last_step_at).toBeNull();
    expect(auto.isDue(plan, T0)).toBe(false);
  });

  test('refuse d’armer un drapeau déjà au sommet de son échelle', () => {
    const flag = makeFlag({ rollout_percentage: 100 });
    expect(() => auto.buildPlan(flag, { steps: [50, 100] }, T0)).toThrow(/déjà à 100/);
  });

  test('refuse un ciblage à plusieurs segments : le palier à monter serait ambigu', () => {
    const flag = makeFlag({
      rules: [
        { id: 'a', percentage: 10, conditions: [] },
        { id: 'b', percentage: 50, conditions: [] },
      ],
    });
    expect(() => auto.buildPlan(flag, {}, T0)).toThrow(/plusieurs segments/);
  });

  test('borne l’intervalle plutôt que d’accepter une montée toutes les secondes', () => {
    expect(auto.buildPlan(makeFlag(), { interval_minutes: 1 }, T0).interval_minutes)
      .toBe(auto.MIN_INTERVAL_MINUTES);
    expect(auto.buildPlan(makeFlag(), { interval_minutes: 999999 }, T0).interval_minutes)
      .toBe(auto.MAX_INTERVAL_MINUTES);
  });

  test('nettoie l’échelle : triée, dédoublonnée, bornée à 100', () => {
    const plan = auto.buildPlan(makeFlag(), { steps: [50, 5, 5, 300, -2, 100] }, T0);
    expect(plan.steps).toEqual([5, 50, 100]);
  });
});

describe('featureFlagAutoRollout — trajectoire', () => {
  test('monte d’un seul cran par échéance, même après un long silence', () => {
    const flag = armed(makeFlag(), { steps: [5, 25, 100], interval_minutes: 60 });

    // Quatre heures plus tard : trois crans seraient « dus », un seul est pris.
    const changes = auto.computeAdvance(flag, minutes(T0, 240));

    expect(changes.rollout_percentage).toBe(5);
    expect(changes.auto_rollout.next_at).toBe(minutes(T0, 300).toISOString());
  });

  test('parcourt l’échelle jusqu’au sommet, puis se marque terminée', () => {
    let flag = armed(makeFlag(), { steps: [5, 25, 100], interval_minutes: 60 });
    const seen = [];

    for (let hour = 1; hour <= 5; hour += 1) {
      const changes = auto.computeAdvance(flag, minutes(T0, hour * 60));
      if (!changes) continue;
      const { __from, __to, ...persisted } = changes;
      flag = { ...flag, ...persisted };
      seen.push(flag.rollout_percentage);
    }

    expect(seen).toEqual([5, 25, 100]);
    expect(flag.auto_rollout.completed_at).toBe(minutes(T0, 180).toISOString());
    expect(flag.auto_rollout.next_at).toBeNull();
    expect(auto.isActive(flag.auto_rollout)).toBe(false);
  });

  test('rien à faire tant que l’échéance n’est pas passée', () => {
    const flag = armed(makeFlag(), { interval_minutes: 60 });
    expect(auto.computeAdvance(flag, minutes(T0, 59))).toBeNull();
  });

  test('écrit sur le segment quand le drapeau est ciblé, pas sur le palier global', () => {
    const flag = armed(
      makeFlag({
        rollout_percentage: 0,
        rules: [{ id: 'audience', label: 'Comptes certifiés', percentage: 5, conditions: [] }],
      }),
      { steps: [5, 25, 100], interval_minutes: 60 }
    );

    const changes = auto.computeAdvance(flag, minutes(T0, 60));

    expect(changes.rules[0].percentage).toBe(25);
    expect(changes.rules[0].label).toBe('Comptes certifiés');
    expect(changes.rollout_percentage).toBeUndefined();
  });

  test('reprend l’échelle au-dessus du palier courant, pas depuis le début', () => {
    const flag = armed(makeFlag({ rollout_percentage: 25 }), {
      steps: [5, 25, 50, 100],
      interval_minutes: 60,
    });

    expect(auto.computeAdvance(flag, minutes(T0, 60)).rollout_percentage).toBe(50);
  });
});

describe('featureFlagAutoRollout — arrêts', () => {
  test('un drapeau éteint entre-temps arrête la montée au lieu de l’élargir', () => {
    const flag = { ...armed(makeFlag(), { interval_minutes: 60 }), enabled: false };
    const changes = auto.computeAdvance(flag, minutes(T0, 60));

    expect(changes.rollout_percentage).toBeUndefined();
    expect(changes.auto_rollout.halted_reason).toBe('flag_off');
  });

  test('un plan arrêté ne repart jamais tout seul', () => {
    const flag = armed(makeFlag(), { interval_minutes: 60 });
    const halted = { ...flag, auto_rollout: auto.haltPlan(flag.auto_rollout, 'manual_override', T0) };

    expect(auto.computeAdvance(halted, minutes(T0, 600))).toBeNull();
    expect(auto.computeAdvance(halted, minutes(T0, 100000))).toBeNull();
  });

  test('un palier changé à la main arrête le plan en cours', () => {
    const flag = armed(makeFlag(), { interval_minutes: 60 });
    const fields = auto.haltFieldsOnManualChange(flag, 'manual_override', T0);

    expect(fields.auto_rollout.halted_reason).toBe('manual_override');
    expect(fields.auto_rollout.next_at).toBeNull();
  });

  test('sans plan actif, un changement manuel n’écrit rien', () => {
    expect(auto.haltFieldsOnManualChange(makeFlag())).toEqual({});
  });

  test('un ciblage redécoupé en plusieurs segments arrête la montée', () => {
    const flag = armed(makeFlag(), { interval_minutes: 60 });
    const split = {
      ...flag,
      rules: [
        { id: 'a', percentage: 10, conditions: [] },
        { id: 'b', percentage: 10, conditions: [] },
      ],
    };

    expect(auto.computeAdvance(split, minutes(T0, 60)).auto_rollout.halted_reason)
      .toBe('targeting_changed');
  });
});

/**
 * Un segment boosté est relatif au palier global : le plan doit donc faire
 * monter le palier GLOBAL et laisser le boost suivre. Le faire grimper aussi
 * élargirait la portée deux fois par cran.
 */
describe('featureFlagAutoRollout — segments boostés', () => {
  const boosted = (boost = 2) => ({
    id: 'premium',
    boost,
    conditions: [{ attribute: 'premium', operator: 'eq', value: true }],
  });

  test('fait monter le palier global, pas le boost', () => {
    const flag = armed(makeFlag({ rollout_percentage: 5, rules: [boosted()] }), {
      steps: [5, 25, 100],
      interval_minutes: 60,
    });

    const changes = auto.computeAdvance(flag, minutes(T0, 60));

    expect(changes.rollout_percentage).toBe(25);
    expect(changes.rules).toBeUndefined();
  });

  test('accepte plusieurs segments tant qu’ils sont tous des boosts', () => {
    const flag = makeFlag({ rules: [boosted(2), { id: 'verifies', boost: 1.5, conditions: [] }] });
    expect(() => auto.buildPlan(flag, {}, T0)).not.toThrow();
  });

  test('refuse toujours deux paliers figés : lequel monterait ?', () => {
    const flag = makeFlag({
      rules: [
        { id: 'a', percentage: 10, conditions: [] },
        { id: 'b', percentage: 50, conditions: [] },
      ],
    });
    expect(() => auto.buildPlan(flag, {}, T0)).toThrow(/plusieurs segments/);
  });

  test('un boost à côté d’un segment figé laisse monter le segment figé', () => {
    const flag = armed(
      makeFlag({
        rollout_percentage: 0,
        rules: [boosted(), { id: 'audience', percentage: 5, conditions: [] }],
      }),
      { steps: [5, 25, 100], interval_minutes: 60 }
    );

    const changes = auto.computeAdvance(flag, minutes(T0, 60));

    expect(changes.rules[1].percentage).toBe(25);
    expect(changes.rules[0].boost).toBe(2);
    expect(changes.rollout_percentage).toBeUndefined();
  });
});
