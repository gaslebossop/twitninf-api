/**
 * Abonnements payants (2 paliers au-dessus du gratuit).
 *
 * Les tarifs sont libellés en EUROS : c'est ça, le prix de l'offre. Le
 * montant réellement débité en NF est recalculé AU COURS DU MOMENT, à chaque
 * affichage comme à chaque achat — 15 € restent 15 € quand le cours bouge,
 * seul le nombre de NF change.
 *
 * Les anciens montants (299 / 599) étaient figés en unités : ils dataient
 * d'une époque où l'unité valait ~0,01 €, et représentaient des milliers
 * d'euros au cours actuel du NF (~10 €).
 */
const TIER = {
  FREE: 'free',
  PLUS: 'plus',
  PRO: 'pro',
  ULTRA: 'ultra',
};

const DEFAULT_DURATION_DAYS = 5;

/** Prix catalogue en euros pour une souscription (voir DEFAULT_DURATION_DAYS). */
const TIER_PRICES_EUR = {
  [TIER.PLUS]: 15,
  [TIER.PRO]: 30,
};

/**
 * Ultra est tarifé en NF FIXE, pas en euros convertis au cours du moment
 * comme Plus/Pro : demandé tel quel (300 NF, confirmé « = 3000e » — palier
 * réservé aux gros créateurs), donc pas de recalcul de `nfAmountForEur` ni de
 * dépendance au cours du NF pour cette offre. Voir `handleUltraPurchase` dans
 * `userRoutes.js`.
 */
const TIER_PRICES_NF_FIXED = {
  [TIER.ULTRA]: 300,
};

/**
 * Prix historiques en unités NF. Conservés uniquement comme filet de
 * sécurité si le cours du NF est indisponible — ne rien tarifer dessus.
 * @deprecated Utiliser TIER_PRICES_EUR + nfAmountForEur.
 */
const TIER_PRICES_TWC = {
  [TIER.PLUS]: 299,
  [TIER.PRO]: 599,
};

/**
 * Convertit un prix en euros vers un montant de NF au cours donné.
 * Arrondi au dix-millième : le débit reste juste à ~0,001 € près, et le
 * montant affiché ne traîne pas quinze décimales.
 * @returns {number|null} null si le cours est inexploitable.
 */
function nfAmountForEur(amountEur, nfPriceEur) {
  const price = Number(nfPriceEur);
  const amount = Number(amountEur);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round((amount / price) * 10000) / 10000;
}

function tierRank(tier) {
  if (tier === TIER.ULTRA) return 3;
  if (tier === TIER.PRO) return 2;
  if (tier === TIER.PLUS) return 1;
  return 0;
}

/**
 * Ultra est un sur-ensemble de Pro : partout où le code réservait un avantage
 * « Pro », Ultra doit aussi passer, sans quoi le palier le plus cher offrirait
 * moins que le palier en dessous. Source unique pour ce test plutôt que
 * `tier === TIER.PRO || tier === TIER.ULTRA` recopié à chaque appelant.
 */
function isProOrAbove(tier) {
  return tierRank(tier) >= tierRank(TIER.PRO);
}

module.exports = {
  TIER,
  DEFAULT_DURATION_DAYS,
  TIER_PRICES_EUR,
  TIER_PRICES_TWC,
  TIER_PRICES_NF_FIXED,
  nfAmountForEur,
  tierRank,
  isProOrAbove,
};
