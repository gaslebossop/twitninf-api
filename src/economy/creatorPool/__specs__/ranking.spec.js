'use strict';

/**
 * Le cœur risqué du pot créateur, c'est le CLASSEMENT : une part se déduit
 * d'un rang, et un rang mal calculé déplace de l'argent d'un créateur vers un
 * autre sans que personne ne s'en aperçoive — il n'y a pas d'erreur visible,
 * juste un partage faux.
 *
 * `ranking.js` est pur exprès : tout se vérifie ici, sans base ni période.
 * Les assertions sont écrites en INVARIANTS (« la somme des parts vaut le
 * pot », « un poids nul ne touche rien ») plutôt qu'en valeurs attendues,
 * pour rester valables si les pondérations changent.
 */

const {
  percentileRanks,
  qualityScore,
  creatorWeight,
  shareOfPool,
  rpmFor,
} = require('../ranking');

const WEIGHTS = { attention: 0.45, retention: 0.25, dau: 0.20, penalty: 0.10 };
const FLOOR = 0.05;

describe('percentileRanks', () => {
  test('un vivier vide ne produit aucun rang', () => {
    expect(percentileRanks([])).toEqual([]);
  });

  test('seule au monde, une personne est première', () => {
    // Lui donner 0 la punirait de l'absence de concurrence.
    expect(percentileRanks([42])).toEqual([1]);
  });

  test('les rangs occupent bien tout l\'intervalle [0, 1]', () => {
    const ranks = percentileRanks([5, 1, 3, 9]);
    expect(Math.min(...ranks)).toBe(0);
    expect(Math.max(...ranks)).toBe(1);
    ranks.forEach((r) => {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    });
  });

  test('le rang suit l\'ordre des valeurs, pas l\'ordre du tableau', () => {
    const values = [5, 1, 3, 9];
    const ranks = percentileRanks(values);
    for (let i = 0; i < values.length; i += 1) {
      for (let j = 0; j < values.length; j += 1) {
        if (values[i] < values[j]) expect(ranks[i]).toBeLessThan(ranks[j]);
      }
    }
  });

  test('les ex æquo partagent le même rang', () => {
    // Sinon l'ordre d'arrivée dans le tableau départagerait deux créateurs
    // identiques, et deux clôtures rejouées ne donneraient pas le même partage.
    const ranks = percentileRanks([2, 2, 2, 8]);
    expect(ranks[0]).toBe(ranks[1]);
    expect(ranks[1]).toBe(ranks[2]);
    expect(ranks[3]).toBeGreaterThan(ranks[0]);
  });

  test('un vivier entièrement à égalité ne fabrique aucun écart', () => {
    const ranks = percentileRanks([7, 7, 7]);
    expect(new Set(ranks).size).toBe(1);
  });

  test('le résultat ne dépend pas de l\'ordre d\'entrée', () => {
    const a = percentileRanks([1, 2, 3, 4]);
    const b = percentileRanks([4, 3, 2, 1]).reverse();
    expect(a).toEqual(b);
  });
});

describe('qualityScore', () => {
  test('le meilleur partout sans pénalité atteint le maximum', () => {
    const q = qualityScore(
      { attention: 1, retention: 1, dau: 1, penalty: 0 }, WEIGHTS, FLOOR);
    expect(q).toBeCloseTo(0.9, 6); // 0,45 + 0,25 + 0,20
    expect(q).toBeLessThanOrEqual(1);
  });

  test('le dernier partout ne tombe jamais à zéro', () => {
    // Le plancher évite que la dernière place vaille une sanction : à ce
    // niveau, c'est le registre d'avertissements qui prend le relais.
    const q = qualityScore(
      { attention: 0, retention: 0, dau: 0, penalty: 1 }, WEIGHTS, FLOOR);
    expect(q).toBe(FLOOR);
  });

  test('la pénalité est bien soustraite', () => {
    const base = { attention: 0.8, retention: 0.8, dau: 0.8, penalty: 0 };
    const puni = { ...base, penalty: 1 };
    expect(qualityScore(puni, WEIGHTS, FLOOR)).toBeLessThan(qualityScore(base, WEIGHTS, FLOOR));
  });

  test('la qualité reste bornée quelles que soient les pondérations', () => {
    const enorme = { attention: 3, retention: 3, dau: 3, penalty: 0 };
    expect(qualityScore(enorme, WEIGHTS, FLOOR)).toBe(1);
  });

  test('l\'attention pèse plus que la DAU à écart égal', () => {
    const attentif = { attention: 1, retention: 0, dau: 0, penalty: 0 };
    const ramasseur = { attention: 0, retention: 0, dau: 1, penalty: 0 };
    expect(qualityScore(attentif, WEIGHTS, FLOOR))
      .toBeGreaterThan(qualityScore(ramasseur, WEIGHTS, FLOOR));
  });
});

describe('creatorWeight', () => {
  test('sans audience, pas de poids — quelle que soit la qualité', () => {
    expect(creatorWeight({ qualifiedViews: 0, quality: 1, bonusMultiplier: 1.5 })).toBe(0);
  });

  test('le volume est le seul facteur dimensionnel', () => {
    const simple = creatorWeight({ qualifiedViews: 1000, quality: 0.5 });
    const double = creatorWeight({ qualifiedViews: 2000, quality: 0.5 });
    expect(double).toBeCloseTo(simple * 2, 6);
  });

  test('une récompense multiplie le poids sans toucher au volume', () => {
    const sans = creatorWeight({ qualifiedViews: 1000, quality: 0.5, bonusMultiplier: 1 });
    const avec = creatorWeight({ qualifiedViews: 1000, quality: 0.5, bonusMultiplier: 1.1 });
    expect(avec).toBeCloseTo(sans * 1.1, 6);
  });

  test('la décote d\'attention estimée pénalise bien le poids', () => {
    const mesure = creatorWeight({ qualifiedViews: 1000, quality: 0.5, attentionFactor: 1 });
    const estime = creatorWeight({ qualifiedViews: 1000, quality: 0.5, attentionFactor: 0.5 });
    expect(estime).toBeLessThan(mesure);
  });

  test('des vues négatives ne peuvent pas fabriquer de poids', () => {
    expect(creatorWeight({ qualifiedViews: -500, quality: 1 })).toBe(0);
  });
});

describe('shareOfPool', () => {
  test('la somme des parts vaut exactement le pot', () => {
    const pool = 1000;
    const weights = [12, 7.5, 0.25, 40];
    const total = weights.reduce((a, b) => a + b, 0);
    const sum = weights.reduce((acc, w) => acc + shareOfPool(pool, w, total), 0);
    expect(sum).toBeCloseTo(pool, 6);
  });

  test('un vivier sans aucun poids ne distribue rien', () => {
    // La semaine sans créateur éligible : le pot reste en trésorerie plutôt
    // que de provoquer une division par zéro.
    expect(shareOfPool(1000, 0, 0)).toBe(0);
  });

  test('un poids nul dans un vivier actif ne touche rien', () => {
    expect(shareOfPool(1000, 0, 50)).toBe(0);
  });

  test('doubler son poids double sa part, à vivier constant', () => {
    expect(shareOfPool(1000, 20, 100)).toBeCloseTo(shareOfPool(1000, 10, 100) * 2, 6);
  });

  test('un pot vide ne verse rien à personne', () => {
    expect(shareOfPool(0, 25, 100)).toBe(0);
  });

  test('la part ne dépasse jamais le pot', () => {
    expect(shareOfPool(1000, 80, 80)).toBeCloseTo(1000, 6);
  });
});

describe('rpmFor', () => {
  test('le RPM est bien une somme pour mille vues', () => {
    expect(rpmFor(5, 1000)).toBeCloseTo(5, 6);
    expect(rpmFor(5, 2000)).toBeCloseTo(2.5, 6);
  });

  test('sans vue, le RPM vaut zéro et ne diverge pas', () => {
    expect(rpmFor(10, 0)).toBe(0);
    expect(Number.isFinite(rpmFor(10, 0))).toBe(true);
  });
});

describe('bout en bout : le partage reste cohérent', () => {
  test('à qualité égale, le partage suit exactement les vues', () => {
    const pool = 500;
    const creators = [
      { qualifiedViews: 1000, p: { attention: 0.5, retention: 0.5, dau: 0.5, penalty: 0 } },
      { qualifiedViews: 3000, p: { attention: 0.5, retention: 0.5, dau: 0.5, penalty: 0 } },
    ];
    const weights = creators.map((c) =>
      creatorWeight({ qualifiedViews: c.qualifiedViews, quality: qualityScore(c.p, WEIGHTS, FLOOR) }));
    const total = weights.reduce((a, b) => a + b, 0);
    const parts = weights.map((w) => shareOfPool(pool, w, total));

    expect(parts[1]).toBeCloseTo(parts[0] * 3, 6);
    expect(parts[0] + parts[1]).toBeCloseTo(pool, 6);
    // Même qualité et même pot : le RPM est identique, quelle que soit la taille.
    expect(rpmFor(parts[0], 1000)).toBeCloseTo(rpmFor(parts[1], 3000), 6);
  });

  test('un petit compte de meilleure qualité peut battre un gros compte médiocre', () => {
    // C'est la promesse du modèle : le rang percentile permet à un compte à
    // faible audience mais forte attention de dépasser un gros compte tiède.
    const pool = 1000;
    const petit = creatorWeight({
      qualifiedViews: 1000,
      quality: qualityScore({ attention: 1, retention: 1, dau: 1, penalty: 0 }, WEIGHTS, FLOOR),
    });
    const gros = creatorWeight({
      qualifiedViews: 8000,
      quality: qualityScore({ attention: 0, retention: 0, dau: 0, penalty: 1 }, WEIGHTS, FLOOR),
    });
    const total = petit + gros;
    expect(shareOfPool(pool, petit, total)).toBeGreaterThan(shareOfPool(pool, gros, total));
  });

  test('le pot ne peut jamais être dépassé, même avec toutes les récompenses', () => {
    // L'invariant qui garantit que la plateforme reste positive : une
    // récompense déplace une part, elle n'en crée pas.
    const pool = 250;
    const weights = [
      creatorWeight({ qualifiedViews: 5000, quality: 0.9, bonusMultiplier: 1.5 }),
      creatorWeight({ qualifiedViews: 5000, quality: 0.9, bonusMultiplier: 1.5 }),
      creatorWeight({ qualifiedViews: 100, quality: 0.05, bonusMultiplier: 1 }),
    ];
    const total = weights.reduce((a, b) => a + b, 0);
    const sum = weights.reduce((acc, w) => acc + shareOfPool(pool, w, total), 0);
    expect(sum).toBeLessThanOrEqual(pool + 1e-9);
  });
});
