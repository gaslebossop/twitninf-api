/** Utilitaires montants TWC (2 décimales) */

function roundTWC(amount) {
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
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
  toAmount,
  assertPositive,
  computePackageCoins
};
