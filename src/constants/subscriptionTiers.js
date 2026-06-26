/**
 * Abonnements payants (2 paliers au-dessus du gratuit).
 * Les montants sont en TWC (TwitCoins) pour une période par défaut de 30 jours.
 */
const TIER = {
  FREE: 'free',
  PLUS: 'plus',
  PRO: 'pro',
};

const DEFAULT_DURATION_DAYS = 30;

/** Prix catalogue pour une nouvelle souscription (30 j.) */
const TIER_PRICES_TWC = {
  [TIER.PLUS]: 299,
  [TIER.PRO]: 599,
};

function tierRank(tier) {
  if (tier === TIER.PRO) return 2;
  if (tier === TIER.PLUS) return 1;
  return 0;
}

module.exports = {
  TIER,
  DEFAULT_DURATION_DAYS,
  TIER_PRICES_TWC,
  tierRank,
};
