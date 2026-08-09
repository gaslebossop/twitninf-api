const { TIER, tierRank, DEFAULT_DURATION_DAYS } = require('../constants/subscriptionTiers');

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
 *
 * Le repli est `DEFAULT_DURATION_DAYS`, jamais une durée plus généreuse : une
 * valeur absente ou illisible ne doit pas offrir un mois d'abonnement.
 */
function computeNewExpiry(user, durationDays) {
  const now = new Date();
  const days = Math.max(1, parseInt(durationDays, 10) || DEFAULT_DURATION_DAYS);
  let base = now;
  // On ne prolonge que depuis un abonnement RÉELLEMENT actif. Une date de fin
  // future sur un compte repassé en gratuit (coupure administrative) n'est plus
  // du temps acquis : la reprendre comme base rendrait la coupure sans effet au
  // premier rachat.
  if (isSubscriptionActive(user) && user.subscription_expires_at) {
    const cur = new Date(user.subscription_expires_at);
    if (cur > base) base = cur;
  }
  return new Date(base.getTime() + days * 86400000);
}

/**
 * Repasse en gratuit TOUS les abonnements dont la date de fin est passée.
 *
 * `maybeExpireSubscription` est paresseux : il ne s'exécute que si le compte
 * concerné touche une route qui le vérifie. Sans ce balayage, un abonné expiré
 * garde `premium = true` en base — donc son badge, son fil et ses avantages
 * d'affichage — indéfiniment tant qu'il ne revient pas. Le balayage est fait en
 * une seule requête pour ne pas charger des milliers d'instances.
 *
 * @param {object} sequelize instance Sequelize
 * @returns {Promise<number>} nombre de comptes repassés en gratuit
 */
async function expireDueSubscriptions(sequelize) {
  const [, result] = await sequelize.query(
    `UPDATE users
        SET subscription_tier = :freeTier,
            premium = false,
            updated_at = NOW()
      WHERE subscription_tier <> :freeTier
        AND subscription_expires_at IS NOT NULL
        AND subscription_expires_at <= NOW()`,
    { replacements: { freeTier: TIER.FREE } }
  );
  return typeof result?.rowCount === 'number' ? result.rowCount : (result || 0);
}

function normalizePurchasableTier(raw) {
  const t = String(raw || '').toLowerCase();
  if (t === TIER.PLUS || t === TIER.PRO) return t;
  return null;
}

module.exports = {
  maybeExpireSubscription,
  expireDueSubscriptions,
  isSubscriptionActive,
  computeNewExpiry,
  normalizePurchasableTier,
  tierRank,
  TIER,
  DEFAULT_DURATION_DAYS,
};
