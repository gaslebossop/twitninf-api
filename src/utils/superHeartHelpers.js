const { TIER, isSubscriptionActive, isUltraActive } = require('./subscriptionHelpers');

/**
 * Solde accordé à chaque renouvellement, par palier.
 *
 * Ultra reprenait le plafond Pro : le palier le plus cher n'ajoutait donc
 * rien ici. Le Super Coeur pèse `SUPER_HEART_SPOTLIGHT_WEIGHT` fois un like
 * dans le classement Spotlight — c'est le seul levier de mise en avant qu'un
 * abonné peut pointer sur QUELQU'UN D'AUTRE, et c'est précisément ce qu'un
 * gros compte veut pouvoir faire.
 */
const SUPER_HEART_CAPS = {
  [TIER.ULTRA]: 25,
  [TIER.PRO]: 10,
  [TIER.PLUS]: 3,
};

/** Cadence de renouvellement, en jours (proposition La Forge : « tous les 5j »). */
const SUPER_HEART_RENEW_DAYS = 5;
/**
 * Ultra recharge tous les 3 jours, pas tous les 5.
 *
 * Combiné au plafond de 25, ça fait un peu plus de huit Super Coeurs par jour
 * contre deux pour un Pro : c'est là que le palier se sent à l'usage plutôt
 * que dans une ligne d'argumentaire.
 */
const SUPER_HEART_RENEW_DAYS_ULTRA = 3;

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
  const renewDays = isUltraActive(user) ? SUPER_HEART_RENEW_DAYS_ULTRA : SUPER_HEART_RENEW_DAYS;
  user.super_hearts_renew_at = new Date(now.getTime() + renewDays * 86400000);
  await user.save(saveOpts);
  return true;
}

module.exports = {
  SUPER_HEART_CAPS,
  SUPER_HEART_RENEW_DAYS,
  SUPER_HEART_RENEW_DAYS_ULTRA,
  SUPER_HEART_SPOTLIGHT_WEIGHT,
  isSuperHeartEligible,
  maybeRenewSuperHearts,
};
