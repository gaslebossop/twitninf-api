'use strict';

/**
 * L'arithmétique qui décide des montants — et rien d'autre.
 *
 * Isolée dans son propre module, sans base ni modèle, pour la même raison que
 * `planConversions` dans `multiCurrencyPayment` : c'est le seul endroit du pot
 * créateur où une erreur se traduit directement en argent mal réparti, donc
 * c'est le seul endroit qui doit être testable sans rien monter.
 */

/**
 * Rang percentile de chaque valeur, dans `[0, 1]`.
 *
 * Les ex æquo partagent leur rang moyen. Sans ça, l'ordre d'arrivée dans le
 * tableau départagerait deux créateurs strictement identiques — et deux
 * clôtures rejouées sur les mêmes données ne donneraient pas le même partage.
 *
 * Un vivier d'une seule personne renvoie `1` : seule au monde, elle est
 * première, et lui donner `0` la punirait de l'absence de concurrence.
 */
function percentileRanks(values) {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(n);

  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && indexed[j + 1].v === indexed[k].v) j += 1;
    const average = ((k + j) / 2) / (n - 1);
    for (let m = k; m <= j; m += 1) ranks[indexed[m].i] = average;
    k = j + 1;
  }
  return ranks;
}

/**
 * Qualité d'un créateur à partir de ses rangs, dans `[floor, 1]`.
 *
 * La pénalité est SOUSTRAITE : un compte très signalé peut annuler l'avantage
 * qu'il tire de son attention. Le plancher empêche malgré tout d'arriver à
 * zéro — à ce niveau-là, la sanction n'est plus la paie mais le registre
 * d'avertissements, qui a ses propres seuils.
 */
function qualityScore(percentiles, weights, floor) {
  const raw =
    weights.attention * percentiles.attention +
    weights.retention * percentiles.retention +
    weights.dau * percentiles.dau -
    weights.penalty * percentiles.penalty;

  return Math.min(1, Math.max(floor, raw));
}

/**
 * Poids d'un créateur dans le partage.
 *
 * `vues qualifiées` est le SEUL facteur de volume : la qualité, la décote
 * d'attention estimée et les récompenses sont toutes des multiplicateurs sans
 * dimension. Ajouter un second facteur de volume (le nombre de tweets, par
 * exemple) rendrait la publication en rafale payante.
 */
function creatorWeight({ qualifiedViews, quality, attentionFactor = 1, bonusMultiplier = 1 }) {
  return Math.max(0, qualifiedViews) * quality * attentionFactor * bonusMultiplier;
}

/**
 * Part d'un créateur dans le pot.
 *
 * `totalWeight` ne compte que les poids ÉLIGIBLES : quelqu'un qui n'a pas
 * encore droit à la monétisation ne doit pas diluer la part de ceux qui sont
 * payés. Sa propre ligne passe malgré tout par cette fonction, ce qui revient
 * à lui montrer ce qu'il toucherait s'il rejoignait le partage.
 *
 * Un poids total nul ne distribue rien plutôt que de diviser par zéro : c'est
 * la semaine sans aucun créateur éligible, et le pot reste en trésorerie.
 */
function shareOfPool(pool, weight, totalWeight) {
  if (!(totalWeight > 0)) return 0;
  return (pool * Math.max(0, weight)) / totalWeight;
}

/** RPM constaté : ce qu'une part représente pour mille vues qualifiées. */
function rpmFor(amount, qualifiedViews) {
  if (!(qualifiedViews > 0)) return 0;
  return (amount / qualifiedViews) * 1000;
}

module.exports = { percentileRanks, qualityScore, creatorWeight, shareOfPool, rpmFor };
