/**
 * Mandats de renouvellement automatique des abonnements.
 *
 * Ce service SIGNE et RÉSILIE les mandats. Il ne prélève jamais : les
 * prélèvements sont exécutés par le démon `twitninf-autorenew`, qui lit la
 * table `subscription_mandates` et écrit directement dans le grand livre.
 *
 * ── L'anti-fraude est consultée UNE FOIS, ici ──
 * `transactionAuthorizationService.authorize` est appelé à la signature, pour
 * le montant d'une période. Les prélèvements suivants ne le rappellent pas :
 * un mandat est une autorisation donnée d'avance, pas une suite d'achats
 * indépendants. L'autorisation obtenue n'est jamais « consommée » — aucun
 * débit ne l'accompagne — elle expire d'elle-même au bout de 15 secondes et
 * ne sert que de preuve horodatée du contrôle. Le seul garde-fou conservé à
 * chaque échéance est `user_wallets.is_locked`, que le démon relit.
 *
 * ── L'invariant de la date d'expiration ──
 * Tant qu'un mandat vit, `users.subscription_expires_at` vaut NULL. NULL
 * signifie déjà « pas d'expiration » partout (`isSubscriptionActive`,
 * `maybeExpireSubscription`, et `expireDueSubscriptions` filtre explicitement
 * `AND subscription_expires_at IS NOT NULL`) : le compte devient donc
 * structurellement hors d'atteinte du balayage horaire, sans qu'aucune de ces
 * fonctions n'ait été modifiée. La vraie date de facturation vit dans
 * `subscription_mandates.next_charge_at`.
 *
 * À la résiliation, on repose `subscription_expires_at = next_charge_at` : la
 * période déjà payée s'écoule, puis le balayage existant reprend la main.
 */

const { v4: uuidv4 } = require('uuid');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../database/index');
const { User } = require('../models');
const logger = require('../utils/logger');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const { TREASURY_USER_ID } = require('../economy/constants');
const { roundTWC, toAmount } = require('../economy/money');
const {
  TIER,
  TIER_PRICES_EUR,
  TIER_PRICES_NF_FIXED,
  DEFAULT_DURATION_DAYS,
  nfAmountForEur,
  tierRank,
} = require('../constants/subscriptionTiers');
const { isSubscriptionActive } = require('../utils/subscriptionHelpers');
const transactionAuthorizationService = require('./transactionAuthorizationService');

/** États d'un mandat encore engageant : tout sauf une résiliation. */
const LIVE_STATES = ['ACTIVE', 'DUNNING', 'GRACE', 'DEFAULTED'];

/** Paliers qui acceptent la reconduction. */
const RENEWABLE_TIERS = [TIER.PLUS, TIER.PRO, TIER.ULTRA];

class MandateError extends Error {
  constructor(message, code, httpStatus = 400) {
    super(message);
    this.name = 'MandateError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * La table est posée à la main (`twitninf-autorenew/sql/001_...sql`) : ni
 * `migrate.js` ni `sync()` ne la créent au démarrage. Sans ce contrôle, chaque
 * ouverture de l'écran d'abonnement partirait en 500 sur une base où la
 * migration n'a pas encore été jouée. Le résultat est mis en cache une fois
 * qu'il est positif — une table ne disparaît pas.
 */
let tableReady = false;
async function hasMandateTable() {
  if (tableReady) return true;
  const rows = await sequelize.query(
    "SELECT to_regclass('public.subscription_mandates') AS present",
    { type: QueryTypes.SELECT }
  );
  tableReady = !!rows[0]?.present;
  return tableReady;
}

/** Le mandat encore engageant d'un compte, ou null. */
async function find(userId, dbTransaction = null) {
  if (!(await hasMandateTable())) return null;
  const rows = await sequelize.query(
    // `IN (:states)` et non `= ANY(:states)` : Sequelize developpe un tableau
    // de `replacements` en liste separee par des virgules ('A','B','C'), ce
    // que `IN` attend et que `ANY` refuse — « syntax error at or near "," ».
    // La route partait alors en 500, que l'app avalait en masquant simplement
    // l'interrupteur : une panne totale, parfaitement silencieuse.
    `SELECT * FROM subscription_mandates
      WHERE user_id = :userId AND state IN (:states)
      LIMIT 1`,
    {
      type: QueryTypes.SELECT,
      replacements: { userId, states: LIVE_STATES },
      transaction: dbTransaction,
    }
  );
  return rows[0] || null;
}

/**
 * Prix d'une période, en NF, au cours du moment.
 *
 * Reprend exactement la tarification de l'achat manuel : Plus et Pro sont
 * libellés en euros et reconvertis au cours, Ultra est en NF fixe. Le démon
 * refait ce calcul de son côté à chaque échéance — cette valeur n'est
 * qu'indicative, pour l'afficher.
 */
async function periodPriceNf(tier, currency) {
  if (tier === TIER.ULTRA) {
    return roundTWC(TIER_PRICES_NF_FIXED[TIER.ULTRA]);
  }
  const eur = TIER_PRICES_EUR[tier];
  if (!eur) return null;
  const amount = nfAmountForEur(eur, toAmount(currency?.currentPrice));
  return amount === null ? null : roundTWC(amount);
}

/**
 * L'état du mandat tel que l'application l'affiche.
 *
 * `available: false` quand la migration n'a pas encore été jouée : l'écran
 * masque alors l'interrupteur au lieu de proposer une bascule qui échouerait.
 */
async function describe(user) {
  if (!(await hasMandateTable())) {
    return { available: false, enabled: false };
  }

  const mandate = await find(user.id);
  const currency = await getPlatformCurrency();
  const tier = mandate?.tier || user.subscription_tier;

  return {
    available: true,
    enabled: !!mandate && mandate.state !== 'DEFAULTED',
    state: mandate?.state || null,
    tier: mandate?.tier || null,
    nextChargeAt: mandate?.next_charge_at || null,
    failureCount: mandate?.failure_count || 0,
    graceUntil: mandate?.grace_until || null,
    priceNf: RENEWABLE_TIERS.includes(tier) ? await periodPriceNf(tier, currency) : null,
  };
}

/**
 * Signe un mandat pour le palier actuellement actif.
 *
 * Le contrôle anti-fraude est fait AVANT d'ouvrir la transaction : le moteur
 * de risque écrit sur `user_wallets` par une connexion distincte, donc
 * l'appeler en tenant déjà des verrous provoquerait un blocage circulaire —
 * c'est la même règle que celle documentée dans `EconomyLedger`.
 */
async function enable(userId) {
  if (!(await hasMandateTable())) {
    throw new MandateError(
      'Le renouvellement automatique n’est pas encore disponible.',
      'MANDATE_UNAVAILABLE',
      503
    );
  }

  const user = await User.findByPk(userId, {
    attributes: ['id', 'subscription_tier', 'subscription_expires_at', 'premium'],
  });
  if (!user) {
    throw new MandateError('Compte introuvable.', 'USER_NOT_FOUND', 404);
  }

  const tier = user.subscription_tier;
  if (!RENEWABLE_TIERS.includes(tier) || !isSubscriptionActive(user)) {
    throw new MandateError(
      'Il faut un abonnement actif pour activer le renouvellement automatique.',
      'NO_ACTIVE_SUBSCRIPTION',
      409
    );
  }

  // Un compte historique sans date de fin possède déjà son palier sans
  // échéance : lui poser un mandat le ferait payer pour du temps qu'il a
  // définitivement acquis.
  if (!user.subscription_expires_at) {
    throw new MandateError(
      'Cet abonnement n’a pas de date de fin : il n’y a rien à reconduire.',
      'SUBSCRIPTION_WITHOUT_EXPIRY',
      409
    );
  }

  const existing = await find(userId);
  if (existing) {
    throw new MandateError(
      existing.state === 'DEFAULTED'
        ? 'Un impayé est en cours sur ce compte. Contacte le support.'
        : 'Le renouvellement automatique est déjà actif.',
      existing.state === 'DEFAULTED' ? 'MANDATE_DEFAULTED' : 'MANDATE_ALREADY_ACTIVE',
      409
    );
  }

  const currency = await getPlatformCurrency();
  if (!currency) {
    throw new MandateError('Monnaie indisponible.', 'CURRENCY_UNAVAILABLE', 503);
  }

  const price = await periodPriceNf(tier, currency);
  if (!price || price <= 0) {
    throw new MandateError('Tarif indisponible.', 'PRICE_UNAVAILABLE', 503);
  }

  // Contrôle anti-fraude unique. Il porte sur le montant d'UNE période : c'est
  // ce que le mandat engage à chaque échéance. Les empreintes d'appareil et
  // d'IP sont reprises du contexte de requête (AsyncLocalStorage), comme pour
  // un achat manuel — rien à passer explicitement.
  const authorization = await transactionAuthorizationService.authorize({
    userId,
    transactionKind: 'purchase',
    direction: 'outbound',
    amount: price,
    amountEur: roundTWC(price * toAmount(currency.currentPrice)),
    currencyId: currency.id,
    counterpartyUserId: TREASURY_USER_ID,
    merchantId: 'subscription_mandate',
    itemType: 'subscription_mandate',
    itemId: tier,
  });

  const mandateId = uuidv4();
  const dbTransaction = await sequelize.transaction();
  try {
    await sequelize.query(
      `INSERT INTO subscription_mandates
         (id, user_id, tier, state, currency_id, authorized_at, authorization_id,
          next_charge_at, failure_count, created_at, updated_at)
       VALUES (:id, :userId, :tier, 'ACTIVE', :currencyId, NOW(), :authorizationId,
               :nextChargeAt, 0, NOW(), NOW())`,
      {
        replacements: {
          id: mandateId,
          userId,
          tier,
          currencyId: currency.id,
          authorizationId: authorization?.id || null,
          // La première échéance tombe à la fin de la période DÉJÀ payée :
          // partir de maintenant referait payer du temps acquis.
          nextChargeAt: user.subscription_expires_at,
        },
        transaction: dbTransaction,
        type: QueryTypes.INSERT,
      }
    );

    await sequelize.query(
      `UPDATE users SET subscription_expires_at = NULL, updated_at = NOW()
        WHERE id = :userId`,
      { replacements: { userId }, transaction: dbTransaction, type: QueryTypes.UPDATE }
    );

    await dbTransaction.commit();
  } catch (error) {
    await dbTransaction.rollback();
    throw error;
  }

  logger.info(`🔁 [Mandat] ${userId} : reconduction ${tier} activée (${price} NF / ${DEFAULT_DURATION_DAYS}j)`);
  return find(userId);
}

/**
 * Résilie le mandat et redonne à l'abonnement sa date de fin.
 *
 * `next_charge_at` est la fin de la période payée. Sur un mandat en impayé
 * elle est dans le passé — c'est voulu : le temps a été consommé sans être
 * réglé, le balayage horaire rétrogradera le compte au prochain passage.
 */
async function disable(userId) {
  if (!(await hasMandateTable())) {
    throw new MandateError(
      'Le renouvellement automatique n’est pas encore disponible.',
      'MANDATE_UNAVAILABLE',
      503
    );
  }

  const dbTransaction = await sequelize.transaction();
  try {
    const mandate = await find(userId, dbTransaction);
    if (!mandate) {
      await dbTransaction.rollback();
      throw new MandateError(
        'Aucun renouvellement automatique à désactiver.',
        'NO_MANDATE',
        404
      );
    }

    await sequelize.query(
      `UPDATE users
          SET subscription_expires_at = :expiry, updated_at = NOW()
        WHERE id = :userId
          AND subscription_expires_at IS NULL`,
      {
        replacements: { userId, expiry: mandate.next_charge_at },
        transaction: dbTransaction,
        type: QueryTypes.UPDATE,
      }
    );

    await sequelize.query(
      `UPDATE subscription_mandates
          SET state = 'CANCELLED', cancelled_at = NOW(),
              next_retry_at = NULL, updated_at = NOW()
        WHERE id = :id`,
      { replacements: { id: mandate.id }, transaction: dbTransaction, type: QueryTypes.UPDATE }
    );

    await dbTransaction.commit();
    logger.info(`🔁 [Mandat] ${userId} : reconduction résiliée, fin au ${mandate.next_charge_at}`);
    return { expiresAt: mandate.next_charge_at };
  } catch (error) {
    if (!dbTransaction.finished) await dbTransaction.rollback();
    throw error;
  }
}

/**
 * Reprogramme le mandat sur un palier INFÉRIEUR ou égal — une rétrogradation
 * différée à l'échéance.
 *
 * ── Pourquoi c'est aussi simple ──
 * Le démon relit `subscription_mandates.tier` à CHAQUE prélèvement : il en
 * déduit le prix, puis écrit ce palier dans `users.subscription_tier` au
 * paiement confirmé. Abaisser `tier` ici suffit donc — la bascule se fera
 * toute seule à la prochaine échéance, et le compte garde son palier courant
 * jusque-là (sous mandat, `subscription_expires_at` vaut NULL, rien ne le
 * rétrograde avant).
 *
 * ── Pourquoi seulement vers le bas ──
 * Une MONTÉE en gamme engage un montant plus élevé : elle doit repasser par
 * l'autorisation anti-fraude, c'est-à-dire par un achat (`enable` rouvre un
 * mandat neuf après contrôle). On refuse donc ici tout palier au-dessus de
 * celui qui court réellement. Aucun contrôle anti-fraude n'est nécessaire pour
 * descendre : on n'engage jamais plus que ce qui l'était déjà.
 */
async function scheduleTierChange(userId, targetTier) {
  if (!(await hasMandateTable())) {
    throw new MandateError(
      'Le renouvellement automatique n’est pas encore disponible.',
      'MANDATE_UNAVAILABLE',
      503
    );
  }
  if (!RENEWABLE_TIERS.includes(targetTier)) {
    throw new MandateError('Palier de reconduction invalide.', 'INVALID_TIER', 400);
  }

  const user = await User.findByPk(userId, {
    attributes: ['id', 'subscription_tier', 'subscription_expires_at', 'premium'],
  });
  if (!user) {
    throw new MandateError('Compte introuvable.', 'USER_NOT_FOUND', 404);
  }

  // Le palier de référence est celui qui COURT réellement sur le compte, pas
  // `mandate.tier` (qui a pu être déjà abaissé) : on ne descend jamais en
  // dessous, mais on autorise à remonter jusqu'à lui — c'est ainsi qu'on
  // annule une rétrogradation déjà programmée.
  if (tierRank(targetTier) > tierRank(user.subscription_tier)) {
    throw new MandateError(
      'Une montée en gamme se fait par un achat, pas par le renouvellement automatique.',
      'UPGRADE_NOT_ALLOWED',
      409
    );
  }

  const dbTransaction = await sequelize.transaction();
  try {
    const mandate = await find(userId, dbTransaction);
    if (!mandate) {
      await dbTransaction.rollback();
      throw new MandateError(
        'Aucun renouvellement automatique à modifier.',
        'NO_MANDATE',
        404
      );
    }
    if (mandate.state === 'DEFAULTED') {
      await dbTransaction.rollback();
      throw new MandateError(
        'Un impayé est en cours sur ce compte. Contacte le support.',
        'MANDATE_DEFAULTED',
        409
      );
    }

    if (mandate.tier !== targetTier) {
      await sequelize.query(
        `UPDATE subscription_mandates
            SET tier = :tier, updated_at = NOW()
          WHERE id = :id`,
        {
          replacements: { id: mandate.id, tier: targetTier },
          transaction: dbTransaction,
          type: QueryTypes.UPDATE,
        }
      );
    }

    await dbTransaction.commit();
  } catch (error) {
    if (!dbTransaction.finished) await dbTransaction.rollback();
    throw error;
  }

  logger.info(`🔁 [Mandat] ${userId} : reconduction reprogrammée sur ${targetTier}`);
  const user2 = await User.findByPk(userId, {
    attributes: ['id', 'subscription_tier', 'subscription_expires_at', 'premium'],
  });
  return describe(user2);
}

module.exports = {
  MandateError,
  LIVE_STATES,
  RENEWABLE_TIERS,
  find,
  describe,
  enable,
  disable,
  scheduleTierChange,
  periodPriceNf,
};
