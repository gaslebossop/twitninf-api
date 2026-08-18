const { UserBehaviorData } = require('../../models');
const BehaviorDataCollector = require('../behaviorDataCollector');

/**
 * Appele via le PROTOTYPE, sans instancier : le constructeur demarre un
 * `setInterval` de traitement par lots (30 s) qui empeche Jest de rendre la
 * main. La methode n'utilise pas `this`, donc l'appeler ainsi teste exactement
 * le code qui tourne en production.
 */
const collector = {
  toKnownActionType: BehaviorDataCollector.prototype.toKnownActionType,
};

/**
 * Regression : `trackCustomAction()` cote mobile envoie une chaine LIBRE en
 * `action_type`. Toute valeur absente de l'enum PostgreSQL faisait echouer
 * l'INSERT entier — l'action n'etait pas degradee, elle etait PERDUE, et
 * l'erreur ne remontait qu'en log serveur. 145 ouvertures de tweet depuis la
 * grille Explorer et 20 reponses au controle d'algorithme ont disparu ainsi.
 */
describe('toKnownActionType', () => {
  const knownValues = UserBehaviorData.rawAttributes.action_type.values;

  it('laisse passer une valeur connue, sans toucher au contexte', () => {
    const context = {};

    expect(collector.toKnownActionType('tab_change', context)).toBe('tab_change');
    expect(context.original_action_type).toBeUndefined();
  });

  it('ramene une valeur inconnue a custom_action en gardant le nom d origine', () => {
    // Le nom d'origine doit survivre dans le contexte : sans lui, l'action
    // serait enregistree mais deviendrait indistinguable des autres.
    const context = {};

    expect(collector.toKnownActionType('geste_invente_par_le_client', context))
      .toBe('custom_action');
    expect(context.original_action_type).toBe('geste_invente_par_le_client');
  });

  it('accepte desormais les deux valeurs qui echouaient en production', () => {
    for (const value of ['open_tweet', 'algo_check_answer']) {
      expect(knownValues).toContain(value);
      expect(collector.toKnownActionType(value, {})).toBe(value);
    }
  });

  it('expose custom_action, cible du repli', () => {
    // Si cette valeur disparaissait de l'enum, le repli ecrirait lui-meme une
    // valeur invalide et le remede deviendrait le probleme.
    expect(knownValues).toContain('custom_action');
  });
});
