const { TIER, tierRank, DEFAULT_DURATION_DAYS } = require('../constants/subscriptionTiers');
const {
  freeTierCustomization,
  hasPaidCustomization,
  CERTIFIED_NAME_EFFECT,
} = require('./profileCustomization');

/**
 * Si la date d'expiration est dépassée, repasse l'utilisateur en gratuit.
 *
 * Retirer le palier ne suffit pas : la personnalisation payante (bannière,
 * décor d'avatar, nom animé, ambiance de profil) est stockée sur le compte et
 * servie telle quelle par tous les flux. Sans neutralisation, un abonné expiré
 * garde son habillage à vie, visible par tout le monde.
 *
 * @returns {Promise<boolean>} true si une mise à jour a été enregistrée
 */
async function maybeExpireSubscription(user, dbTransaction) {
  if (!user || user.subscription_tier === TIER.FREE) return false;
  if (!user.subscription_expires_at) return false;
  if (new Date(user.subscription_expires_at) > new Date()) return false;

  user.subscription_tier = TIER.FREE;
  user.premium = false;

  // Beaucoup d'appelants ne chargent que les colonnes d'abonnement : écrire une
  // personnalisation qu'on n'a pas lue écraserait celle en base. Dans ce cas on
  // laisse faire le balayage horaire, qui travaille en SQL sur la ligne entière.
  const customizationLoaded = user.profile_customization !== undefined
    && user.verified !== undefined;
  if (customizationLoaded && hasPaidCustomization(user.profile_customization, { verified: !!user.verified })) {
    user.profile_customization = freeTierCustomization(user.profile_customization, {
      verified: !!user.verified,
    });
    // JSONB muté par assignation : sans ce `changed`, Sequelize repart parfois
    // sans rien écrire.
    user.changed('profile_customization', true);
  }

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
 * @returns {Promise<{expired: number, cleaned: number}>} comptes repassés en
 *   gratuit, et comptes déjà gratuits dont l'habillage payant traînait encore
 */
async function expireDueSubscriptions(sequelize) {
  const [, result] = await sequelize.query(
    // Le CASE est la version SQL de `freeTierCustomization` : tout l'habillage
    // payant tombe, seul l'effet de nom « Certifié » survit et seulement pour
    // un compte certifié, parce qu'il suit le badge et non l'abonnement.
    `UPDATE users
        SET subscription_tier = :freeTier,
            premium = false,
            profile_customization = CASE
              WHEN verified IS TRUE
               AND profile_customization->>'name_effect' = :certifiedEffect
              THEN jsonb_build_object('name_effect', :certifiedEffect)
              ELSE '{}'::jsonb
            END,
            updated_at = NOW()
      WHERE subscription_tier <> :freeTier
        AND subscription_expires_at IS NOT NULL
        AND subscription_expires_at <= NOW()`,
    { replacements: { freeTier: TIER.FREE, certifiedEffect: CERTIFIED_NAME_EFFECT } }
  );

  // Filet indépendant : un compte peut redevenir gratuit sans passer par la
  // condition ci-dessus (coupure administrative, rétrogradation manuelle). La
  // règle d'enregistrement interdit déjà l'habillage payant à un compte
  // gratuit ; ce balayage y ramène ceux qui l'ont gardé.
  const [, cleanup] = await sequelize.query(
    `UPDATE users
        SET profile_customization = CASE
              WHEN verified IS TRUE
               AND profile_customization->>'name_effect' = :certifiedEffect
              THEN jsonb_build_object('name_effect', :certifiedEffect)
              ELSE '{}'::jsonb
            END,
            updated_at = NOW()
      WHERE subscription_tier = :freeTier
        AND profile_customization IS NOT NULL
        AND profile_customization <> '{}'::jsonb
        AND NOT (
          verified IS TRUE
          AND profile_customization = jsonb_build_object('name_effect', :certifiedEffect)
        )`,
    { replacements: { freeTier: TIER.FREE, certifiedEffect: CERTIFIED_NAME_EFFECT } }
  );

  const count = (row) => (typeof row?.rowCount === 'number' ? row.rowCount : (row || 0));
  return { expired: count(result), cleaned: count(cleanup) };
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
