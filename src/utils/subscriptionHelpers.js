const { TIER, tierRank } = require('../constants/subscriptionTiers');

/**
 * Si la date d'expiration est dépassée, repasse l'utilisateur en gratuit.
 * @returns {Promise<boolean>} true si une mise à jour a été enregistrée
 */
async function maybeExpireSubscription(user, dbTransaction) {
  if (!user || user.subscription_tier === TIER.FREE) return false;
  if (!user.subscription_expires_at) return false;
  if (new Date(user.subscription_expires_at) > new Date()) return false;

  user.subscription_tier = TIER.FREE;
  user.premium = false;
  await user.save(dbTransaction ? { transaction: dbTransaction } : {});
  return true;
}

function isSubscriptionActive(user) {
  if (!user || user.subscription_tier === TIER.FREE) return false;
  if (!user.subscription_expires_at) return true;
  return new Date(user.subscription_expires_at) > new Date();
}

/**
 * Calcule la nouvelle date de fin : prolonge depuis la fin actuelle si encore active, sinon depuis maintenant.
 */
function computeNewExpiry(user, durationDays) {
  const now = new Date();
  const days = Math.max(1, parseInt(durationDays, 10) || 30);
  let base = now;
  if (user.subscription_expires_at) {
    const cur = new Date(user.subscription_expires_at);
    if (cur > base) base = cur;
  }
  return new Date(base.getTime() + days * 86400000);
}

function normalizePurchasableTier(raw) {
  const t = String(raw || '').toLowerCase();
  if (t === TIER.PLUS || t === TIER.PRO) return t;
  return null;
}

module.exports = {
  maybeExpireSubscription,
  isSubscriptionActive,
  computeNewExpiry,
  normalizePurchasableTier,
  tierRank,
  TIER,
};
