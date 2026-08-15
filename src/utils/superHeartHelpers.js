const { TIER, isSubscriptionActive } = require('./subscriptionHelpers');

/** Solde accordé à chaque renouvellement, par palier. */
const SUPER_HEART_CAPS = {
  [TIER.PRO]: 10,
  [TIER.PLUS]: 3,
};

/** Cadence de renouvellement, en jours (proposition La Forge : « tous les 5j »). */
const SUPER_HEART_RENEW_DAYS = 5;

/** Poids d'un Super Cœur face à un like classique dans le classement Spotlight. */
const SUPER_HEART_SPOTLIGHT_WEIGHT = 3;

function isSuperHeartEligible(user) {
  return !!user && !!SUPER_HEART_CAPS[user?.subscription_tier] && isSubscriptionActive(user);
}

/**
 * Renouvelle paresseusement le solde de Super Cœurs, au même patron que
 * `maybeExpireSubscription` : recalculé à la lecture (statut premium, pose
 * d'un Super Cœur), pas par un cron dédié.
 *
 * Un compte qui n'est plus Pro retombe à 0 sans date de renouvellement, pour
 * ne pas repartir avec un solde plein au réabonnement avant le prochain
 * cycle réel.
 *
 * @returns {Promise<boolean>} true si une mise à jour a été enregistrée
 */
async function maybeRenewSuperHearts(user, dbTransaction) {
  if (!user) return false;
  const saveOpts = dbTransaction ? { transaction: dbTransaction } : {};

  if (!isSuperHeartEligible(user)) {
    if (user.super_hearts_remaining === 0 && !user.super_hearts_renew_at) return false;
    user.super_hearts_remaining = 0;
    user.super_hearts_renew_at = null;
    await user.save(saveOpts);
    return true;
  }

  const now = new Date();
  if (user.super_hearts_renew_at && new Date(user.super_hearts_renew_at) > now) {
    return false;
  }

  user.super_hearts_remaining = SUPER_HEART_CAPS[user.subscription_tier];
  user.super_hearts_renew_at = new Date(now.getTime() + SUPER_HEART_RENEW_DAYS * 86400000);
  await user.save(saveOpts);
  return true;
}

module.exports = {
  SUPER_HEART_CAPS,
  SUPER_HEART_RENEW_DAYS,
  SUPER_HEART_SPOTLIGHT_WEIGHT,
  isSuperHeartEligible,
  maybeRenewSuperHearts,
};
