'use strict';

/** Crédits offerts à chaque achat ou renouvellement Plus / Pro confirmé. */
const SUBSCRIPTION_TWEET_CREDITS = 5;
/** Une génération réussie réserve exactement un crédit. */
const TWEET_GENERATION_COST = 1;

function normalizeTweetCredits(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function creditsAfterSubscriptionPurchase(currentCredits) {
  return normalizeTweetCredits(currentCredits) + SUBSCRIPTION_TWEET_CREDITS;
}

module.exports = {
  SUBSCRIPTION_TWEET_CREDITS,
  TWEET_GENERATION_COST,
  normalizeTweetCredits,
  creditsAfterSubscriptionPurchase,
};
