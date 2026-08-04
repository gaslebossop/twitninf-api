'use strict';

/**
 * Le cœur risqué du paiement multi-monnaies, c'est l'ARITHMÉTIQUE : couvrir un
 * manque au centime près, en enchaînant des cours qui n'ont aucune raison de
 * tomber juste. Un centime manquant après avoir déjà vendu la monnaie de
 * quelqu'un, c'est un achat échoué ET un portefeuille entamé.
 *
 * `planConversions` est pure exprès : tout se teste ici, sans base ni
 * portefeuille. Les tests sont écrits en INVARIANTS (« le crédit couvre
 * toujours le manque ») plutôt qu'en valeurs attendues, pour rester valables si
 * la stratégie de sélection change.
 */

const {
  ceilTWC,
  planConversions
} = require('../multiCurrencyPayment');

const source = (currencyId, symbol, balance, priceEur, isStable = false) => ({
  currencyId,
  symbol,
  balance,
  priceEur,
  isStable,
  valueEur: balance * priceEur
});

/** L'invariant central : ce qui est crédité couvre le manque, sans excès absurde. */
function couvre(plan, shortfall) {
  const credite = plan.steps.reduce((total, step) => total + step.credit, 0);
  return plan.missing === 0 && credite >= shortfall - 1e-9;
}

describe('planConversions', () => {
  test('le cas de tous les jours : 50 NF + 100 KOSP pour un contenu à 60 NF', () => {
    // NF à 10 €, KOSP à 2 € : il manque 10 NF, soit 100 € — donc 50 KOSP.
    const plan = planConversions(10, [source('c-kosp', 'KOSP', 100, 2)], 10);

    expect(couvre(plan, 10)).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].symbol).toBe('KOSP');
    expect(plan.steps[0].debit).toBe(50);
    expect(plan.steps[0].credit).toBe(10);
  });

  test('ne convertit que l’appoint, pas tout le portefeuille', () => {
    const plan = planConversions(10, [source('c-kosp', 'KOSP', 100, 2)], 10);
    // 50 KOSP suffisent : les 50 autres ne doivent pas être vendues.
    expect(plan.steps[0].debit).toBeLessThan(100);
  });

  test('l’EUR interne est mobilisé avant les monnaies communautaires', () => {
    // Son cours est fixe : le convertir ne déplace aucun marché. Il passe donc
    // devant, même quand une monnaie communautaire pèse bien plus lourd.
    const plan = planConversions(10, [
      source('c-kosp', 'KOSP', 10000, 2),
      source('c-eur', 'EUR', 500, 1, true)
    ], 10);

    expect(plan.steps[0].symbol).toBe('EUR');
    expect(couvre(plan, 10)).toBe(true);
  });

  test('à cours égal, la plus grosse réserve d’abord — pour convertir une seule fois', () => {
    const plan = planConversions(10, [
      source('c-petite', 'PETI', 10, 2),
      source('c-grosse', 'GROS', 500, 2)
    ], 10);

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].symbol).toBe('GROS');
  });

  test('enchaîne plusieurs monnaies quand aucune ne suffit seule', () => {
    const plan = planConversions(10, [
      source('c-a', 'AAA', 20, 2),   // vaut 40 € = 4 NF
      source('c-b', 'BBB', 20, 2),   // vaut 40 € = 4 NF
      source('c-c', 'CCC', 30, 2)    // vaut 60 € = 6 NF
    ], 10);

    expect(couvre(plan, 10)).toBe(true);
    expect(plan.steps.length).toBeGreaterThan(1);
  });

  test('signale ce qui manque quand tout converti ne suffit pas', () => {
    const plan = planConversions(100, [source('c-kosp', 'KOSP', 10, 2)], 10);

    expect(plan.missing).toBeGreaterThan(0);
    expect(couvre(plan, 100)).toBe(false);
    // Le peu qui existe reste listé : le client peut dire « il te manque X ».
    expect(plan.steps).toHaveLength(1);
  });

  test('une source dont le débit s’arrondirait à zéro est ignorée', () => {
    // Monnaie à 1 000 000 € l'unité face à un manque d'un centime de NF :
    // le débit nécessaire est très en dessous du centime.
    const plan = planConversions(0.01, [source('c-chere', 'CHER', 5, 1000000)], 10);

    // Soit on saute la source, soit on débite au moins le centime minimum —
    // dans les deux cas, jamais un débit nul qui ferait échouer l'échange.
    plan.steps.forEach((step) => expect(step.debit).toBeGreaterThanOrEqual(0.01));
  });

  test('un portefeuille vide ou une monnaie sans cours n’entrent pas dans le plan', () => {
    const plan = planConversions(10, [
      source('c-vide', 'VIDE', 0, 2),
      source('c-sanscours', 'NOPE', 100, 0)
    ], 10);

    expect(plan.steps).toHaveLength(0);
    expect(plan.missing).toBe(10);
  });

  test('deux appels identiques produisent exactement le même plan', () => {
    // Sans quoi l'aperçu affiché à l'utilisateur ne décrirait pas ce qui sera
    // réellement exécuté.
    const sources = [
      source('c-b', 'BBB', 100, 2),
      source('c-a', 'AAA', 100, 2),
      source('c-c', 'CCC', 100, 2)
    ];
    const premier = planConversions(10, sources, 10);
    const second = planConversions(10, [...sources].reverse(), 10);

    expect(second.steps.map((s) => s.symbol)).toEqual(premier.steps.map((s) => s.symbol));
  });

  test('le crédit couvre le manque quel que soit le cours — y compris les cours retors', () => {
    // Le test qui compte vraiment : des prix qui ne tombent jamais juste, donc
    // des divisions à décimales infinies. C'est là que l'arrondi au plus proche
    // laissait passer un découvert d'un centime.
    const cours = [0.07, 0.13, 0.3333, 1.7, 3.14159, 999.99];
    const manques = [0.01, 0.99, 7.77, 123.45];

    for (const prixSource of cours) {
      for (const prixCible of cours) {
        for (const manque of manques) {
          const plan = planConversions(
            manque,
            [source('c-x', 'XXX', 1e9, prixSource)],
            prixCible
          );
          const credite = plan.steps.reduce((total, step) => total + step.credit, 0);
          expect(plan.missing).toBe(0);
          expect(credite).toBeGreaterThanOrEqual(manque - 1e-9);
        }
      }
    }
  });
});

describe('ceilTWC', () => {
  test('arrondit au centime supérieur', () => {
    expect(ceilTWC(1.001)).toBe(1.01);
    expect(ceilTWC(1.0000001)).toBe(1.01);
  });

  test('laisse intacte une valeur déjà exacte au centime', () => {
    // Le piège de la représentation binaire : sans amorti, 0.07 ou 12.34
    // remontaient au centime supérieur alors qu'ils sont déjà exacts.
    expect(ceilTWC(0.07)).toBe(0.07);
    expect(ceilTWC(12.34)).toBe(12.34);
    expect(ceilTWC(1)).toBe(1);
  });

  test('encaisse les entrées absurdes sans exploser', () => {
    expect(ceilTWC('pas un nombre')).toBe(0);
    expect(ceilTWC(undefined)).toBe(0);
  });
});
