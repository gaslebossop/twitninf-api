const assert = require('node:assert');

/**
 * Drapeaux de type `beta` — la fonctionnalité appartient au programme beta.
 *
 * Ce type remplace le bricolage précédent (un segment `is_beta eq true` écrit
 * à la main, doublé d'un palier global resté actif derrière). Le défaut de ce
 * bricolage n'était pas théorique : le palier continuait de servir la
 * fonctionnalité à un pourcentage du trafic, et le relever depuis l'écran
 * mobile la sortait de la beta sans que rien ne le signale.
 *
 * Les tests ci-dessous fixent les trois propriétés qui font la valeur du type :
 *   1. seul un membre est servi ;
 *   2. le palier global n'est PLUS consulté, quelle que soit sa valeur ;
 *   3. `is_beta` est déclaré comme attribut référencé, sans quoi la résolution
 *      paresseuse ne partirait jamais et la porte se refermerait sur tout le
 *      monde — y compris les membres.
 */

const evaluator = require('../featureFlagEvaluator');

/** Drapeau de type beta, palier global volontairement NON nul. */
function betaFlag(overrides = {}) {
  return {
    key: 'fil.refonte2b',
    enabled: true,
    audience: 'beta',
    rollout_percentage: 100,
    rules: [],
    variants: [],
    allowlist: [],
    blocklist: [],
    bucket_by: 'user',
    salt: 'v1',
    ...overrides,
  };
}

const MEMBRE = { user_id: 'u-membre', is_beta: true };
const QUIDAM = { user_id: 'u-quidam', is_beta: false };

describe('audience `beta`', () => {
  test('un membre est servi', () => {
    const decision = evaluator.evaluate(betaFlag(), MEMBRE);
    assert.strictEqual(decision.enabled, true);
    assert.strictEqual(decision.reason, 'beta');
  });

  test('un non-membre ne l’est pas, même à 100 % de palier', () => {
    const decision = evaluator.evaluate(betaFlag({ rollout_percentage: 100 }), QUIDAM);
    assert.strictEqual(decision.enabled, false);
    assert.strictEqual(decision.reason, 'not_beta');
  });

  test('le palier global n’est plus consulté du tout', () => {
    // Le même compte, les deux paliers extrêmes : la décision ne bouge pas.
    for (const rollout of [0, 50, 100]) {
      assert.strictEqual(
        evaluator.evaluate(betaFlag({ rollout_percentage: rollout }), MEMBRE).enabled,
        true,
        `membre exclu à ${rollout} %`
      );
      assert.strictEqual(
        evaluator.evaluate(betaFlag({ rollout_percentage: rollout }), QUIDAM).enabled,
        false,
        `non-membre servi à ${rollout} %`
      );
    }
  });

  test('`is_beta` absent vaut « pas membre » — un contexte incomplet FERME la porte', () => {
    // C'est le sens de sécurité qui compte : un attribut non résolu ne doit
    // jamais ouvrir. L'inverse servirait la beta à tout le monde dès qu'une
    // lecture échoue.
    const decision = evaluator.evaluate(betaFlag(), { user_id: 'u-inconnu' });
    assert.strictEqual(decision.enabled, false);
    assert.strictEqual(decision.reason, 'not_beta');
  });

  test('`is_beta` est déclaré référencé, sans qu’aucune condition ne l’écrive', () => {
    // LE piège du dispositif. `resolveLazyAttributes` ne résout que les
    // attributs qu'un drapeau référence ; un drapeau `beta` n'a pas de
    // condition, donc sans cette ligne l'attribut resterait `undefined` et
    // TOUS les membres seraient refusés.
    const referenced = evaluator.referencedAttributes(betaFlag());
    assert.ok(referenced.has('is_beta'), '`is_beta` non annoncé par le drapeau beta');
  });

  test('un drapeau `rollout` n’annonce pas `is_beta`', () => {
    const referenced = evaluator.referencedAttributes(betaFlag({ audience: 'rollout' }));
    assert.strictEqual(referenced.has('is_beta'), false);
  });
});

describe('ce que l’audience `beta` ne change pas', () => {
  test('le coupe-circuit prime — même sur un membre', () => {
    const decision = evaluator.evaluate(betaFlag({ enabled: false }), MEMBRE);
    assert.strictEqual(decision.enabled, false);
    assert.strictEqual(decision.reason, 'kill_switch');
  });

  test('la blocklist prime sur l’appartenance', () => {
    const decision = evaluator.evaluate(betaFlag({ blocklist: ['u-membre'] }), MEMBRE);
    assert.strictEqual(decision.enabled, false);
    assert.strictEqual(decision.reason, 'blocklist');
  });

  test('l’allowlist sert un testeur interne qui n’est PAS membre', () => {
    // Volontaire : la liste d'accès existe pour voir la fonctionnalité sans
    // faire partie de la cohorte. La porte beta est posée après elle.
    const decision = evaluator.evaluate(betaFlag({ allowlist: ['u-quidam'] }), QUIDAM);
    assert.strictEqual(decision.enabled, true);
    assert.strictEqual(decision.reason, 'allowlist');
  });

  test('la fenêtre de dates prime aussi', () => {
    const decision = evaluator.evaluate(
      betaFlag({ start_at: '2099-01-01T00:00:00Z' }),
      MEMBRE
    );
    assert.strictEqual(decision.enabled, false);
    assert.strictEqual(decision.reason, 'before_start');
  });

  test('un drapeau `rollout` garde exactement son comportement', () => {
    const flag = betaFlag({ audience: 'rollout', rollout_percentage: 100 });
    assert.strictEqual(evaluator.evaluate(flag, QUIDAM).enabled, true);
    assert.strictEqual(
      evaluator.evaluate({ ...flag, rollout_percentage: 0 }, QUIDAM).enabled,
      false
    );
  });

  test('audience absente vaut `rollout` — les drapeaux existants ne bougent pas', () => {
    const flag = betaFlag({ rollout_percentage: 100 });
    delete flag.audience;
    assert.strictEqual(evaluator.evaluate(flag, QUIDAM).enabled, true);
  });
});
