/** Utilitaires montants TWC (2 décimales) */

function roundTWC(amount) {
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Arrondi dédié aux PRIX unitaires d'une monnaie (currentPrice/basePrice),
 * PAS aux montants (soldes, frais, capitalisation) qui restent sur roundTWC.
 *
 * `roundTWC` (2 décimales) était utilisé partout, y compris pour les prix —
 * or les colonnes DB `current_price`/`base_price` sont en DECIMAL(10,4), donc
 * 4 décimales de résolution réelle. Sur un NF à 10 €, arrondir le prix à 2
 * décimales passe presque inaperçu (0,01 sur 10 = 0,1 %). Mais sur une
 * monnaie communautaire à 0,08 € (cas courant), CHAQUE échange ne déplace le
 * multiplicateur que d'une fraction infime — bien en-dessous de 0,005 — donc
 * `roundTWC` ramenait systématiquement le prix affiché exactement à sa valeur
 * de départ : l'impact prix existait bien en interne (currentMultiplier
 * change réellement) mais restait invisible tant qu'assez d'échanges
 * cumulés ne faisaient pas franchir un centime entier. Ce n'est PAS le même
 * mécanisme qui était cassé entre NF et monnaies communautaires, juste une
 * perte de précision qui touchait plus durement les prix bas. `roundPrice`
 * s'aligne sur la précision réelle de la colonne (4 décimales) pour que
 * l'impact d'achat/vente soit visible pour N'IMPORTE QUELLE monnaie,
 * indépendamment de son prix de base.
 */
function roundPrice(amount) {
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function toAmount(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function assertPositive(amount, label = 'Montant') {
  const n = roundTWC(amount);
  if (n <= 0) {
    throw new Error(`${label} invalide : doit être strictement positif`);
  }
  return n;
}

function computePackageCoins(baseCoins, packageBonusPercent, promoBonusFraction = 0) {
  const base = Math.floor(baseCoins);
  const tierBonus = Math.floor(base * (packageBonusPercent / 100));
  const promoBonus = Math.floor(base * Math.max(0, promoBonusFraction));
  return base + tierBonus + promoBonus;
}

module.exports = {
  roundTWC,
  roundPrice,
  toAmount,
  assertPositive,
  computePackageCoins
};
