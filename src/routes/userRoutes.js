const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const router = express.Router();

// Import des modèles et services
const { User, UserFollow, Tweet, TweetLike, TweetRetweet, Notification, sequelize } = require('../models');
const { Op } = require('sequelize');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, optionalAuthenticateToken, denySuspended } = require('../middleware/authMiddleware');
const { checkUserBanStrict, checkUserBanReadOnly } = require('../middleware/banMiddleware');
const BanService = require('../services/banService');
const profileViewService = require('../services/profileViewService');
const paidContentService = require('../services/paidContentService');
const {
  TARGET_LANGUAGES,
  SOURCE_LANGUAGE,
  READABLE_LANGUAGES,
} = require('../services/tweetTranslationService');
const logger = require('../utils/logger');
const ctrTracker = require('../services/ctrTracker');

// Un profil bloqué (dans un sens ou l'autre) ne rend pas d'erreur : il rend
// un état distinct, que l'app affiche explicitement (« vous avez bloqué ce
// compte » avec un bouton débloquer, ou « ce compte vous a bloqué ») plutôt
// que le 404 générique utilisé quand le compte est vraiment introuvable.
async function blockedStateBetween(viewerId, targetId) {
  return UserFollow.getBlockDirection(viewerId, targetId);
}

// Identité minimale d'un profil bloqué : jamais la bio, la bannière ni les
// stats — un compte qui vous a bloqué n'a pas à laisser voir plus que son
// existence.
function minimalBlockedUser(user) {
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    avatar: user.avatar,
  };
}
const transactionAuthorizationService = require('../services/transactionAuthorizationService');
const subscriptionMandateService = require('../services/subscriptionMandateService');
// Même valeur que `follow_onboarding_minimum` renvoyé dans le profil : l'écran
// d'inscription et la validation serveur doivent exiger le même nombre.
const { MIN_ONBOARDING_FOLLOWS: ONBOARDING_MIN_FOLLOWS } = require('../config/onboarding');
const {
  TIER,
  TIER_PRICES_EUR,
  TIER_PRICES_NF_FIXED,
  DEFAULT_DURATION_DAYS,
  nfAmountForEur,
} = require('../constants/subscriptionTiers');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const {
  SUBSCRIPTION_TWEET_CREDITS,
  creditsAfterSubscriptionPurchase,
} = require('../constants/tweetGeneration');
const {
  maybeExpireSubscription,
  isSubscriptionActive,
  computeNewExpiry,
  normalizePurchasableTier,
  isProOrAbove,
} = require('../utils/subscriptionHelpers');

const {
  PROFILE_BANNER_STYLES,
  PROFILE_AVATAR_DECORATIONS,
  PROFILE_THEME_INTENSITIES,
  PROFILE_NAME_FONTS,
  PROFILE_NAME_EFFECTS,
  PROFILE_NAME_SIZES,
  PROFILE_EFFECTS,
  PROFILE_TITLE_MAX,
  sanitizeCustomization,
  customizationTier,
  hasPaidCustomization,
  restoreFromArchive,
} = require('../utils/profileCustomization');

const { buildStaticMediaPublicUrl } = require('../utils/publicMediaOrigin');
const { toDecodableBuffer } = require('../services/heifDecoder');
const rustClient = require('../services/rustRecommenderClient');
const { filterVisibleTweets } = require('../utils/privateAccountVisibility');

// Middleware de validation des erreurs
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Données invalides',
      errors: errors.array()
    });
  }
  next();
};

/**
 * Tarifs des abonnements convertis au cours du NF du moment.
 *
 * Source unique de vérité : c'est ce que les clients affichent ET ce qui est
 * débité. Si le cours est indisponible, aucun ancien montant fixe n'est
 * renvoyé et l'achat reste bloqué.
 */
async function resolveSubscriptionPricing(transaction) {
  const currency = await getPlatformCurrency({ transaction });
  const nfPriceEur = Number(currency?.currentPrice) || null;

  const forTier = (tier) => {
    const eur = TIER_PRICES_EUR[tier];
    const nf = nfAmountForEur(eur, nfPriceEur);
    return { eur, nf: nf ?? 0, live: nf != null };
  };

  const plus = forTier(TIER.PLUS);
  const pro = forTier(TIER.PRO);
  const upgradeEur = Math.max(0, TIER_PRICES_EUR[TIER.PRO] - TIER_PRICES_EUR[TIER.PLUS]);
  const upgradeNf = nfAmountForEur(upgradeEur, nfPriceEur);

  return {
    currency_id: currency?.id || null,
    currency_symbol: currency?.symbol || 'NF',
    nf_price_eur: nfPriceEur,
    duration_days: DEFAULT_DURATION_DAYS,
    plus,
    pro,
    // Prix fixe en NF, pas de conversion euro : voir TIER_PRICES_NF_FIXED.
    ultra: { nf: TIER_PRICES_NF_FIXED[TIER.ULTRA], live: true },
    upgrade: {
      eur: upgradeEur,
      nf: upgradeNf ?? 0,
      live: upgradeNf != null,
    },
  };
}

/**
 * Achat ou prolongation d'abonnement payant (Plus / Pro), débité en NF au
 * cours du moment pour un prix en euros constant.
 * @param {string|null} explicitTier — si défini (ex. 'plus'), ignore req.body.tier
 */
async function handleSubscriptionPurchase(req, res, explicitTier) {
  const transaction = await sequelize.transaction();

  try {
    const tier = explicitTier != null
      ? normalizePurchasableTier(explicitTier)
      : normalizePurchasableTier(req.body.tier);

    if (!tier) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Palier invalide. Utilisez « plus » ou « pro ».'
      });
    }

    const userId = req.user.id;
    const NewEconomyService = require('../services/newEconomyService');

    // L'autorisation antifraude est persistée dans une transaction séparée et
    // sa FK vers users prend un verrou KEY SHARE. Un FOR UPDATE ici la bloquait
    // jusqu'au timeout. NO KEY UPDATE sérialise toujours deux achats concurrents
    // sans bloquer cette vérification de FK.
    const subscriptionLock = transaction.LOCK.NO_KEY_UPDATE;
    const user = await User.findByPk(userId, { transaction, lock: subscriptionLock });
    if (!user) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    await maybeExpireSubscription(user, transaction);
    await user.reload({ transaction, lock: subscriptionLock });

    const active = isSubscriptionActive(user);

    if (active && user.subscription_tier === TIER.PRO && tier === TIER.PLUS) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Vous avez déjà un abonnement Pro. Le palier Plus n\'est pas disponible.'
      });
    }

    const pricing = await resolveSubscriptionPricing(transaction);
    const currencyId = pricing.currency_id;
    if (!currencyId) {
      await transaction.rollback();
      return res.status(503).json({
        success: false,
        message: 'Le portefeuille NF est momentanément indisponible.'
      });
    }
    if (!pricing[tier].live) {
      await transaction.rollback();
      return res.status(503).json({
        success: false,
        message: 'Le cours du NF est momentanément indisponible. Réessayez dans quelques instants : aucun achat ne sera facturé à un ancien prix fixe.'
      });
    }
    let price = pricing[tier].nf;
    let priceEur = pricing[tier].eur;
    let itemId = `subscription_${tier}_${DEFAULT_DURATION_DAYS}d`;
    // La durée n'est PAS négociable par le client. Elle l'était via
    // `req.body.duration` sans plafond : un appel direct achetait des années
    // d'abonnement au prix de la période standard.
    const durationDays = DEFAULT_DURATION_DAYS;
    let description = `Abonnement ${tier === TIER.PLUS ? 'Plus' : 'Pro'} (${durationDays} j.)`;

    if (active && user.subscription_tier === TIER.PLUS && tier === TIER.PRO) {
      if (!pricing.upgrade.live) {
        await transaction.rollback();
        return res.status(503).json({
          success: false,
          message: 'Le cours du NF est momentanément indisponible. La mise à niveau ne peut pas être calculée.'
        });
      }
      price = pricing.upgrade.nf;
      priceEur = pricing.upgrade.eur;
      itemId = 'subscription_upgrade_plus_to_pro';
      description = `Mise à niveau Plus → Pro (${priceEur} €)`;
      if (price <= 0) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Montant de mise à niveau invalide.'
        });
      }
    }

    await NewEconomyService.ensureWalletsForUser(userId, transaction);

    let userWallet;
    try {
      userWallet = await NewEconomyService.getUserWallet(currencyId, userId, transaction);
    } catch (walletError) {
      logger.error('❌ [SUB] Erreur récupération wallet:', walletError);
      await transaction.rollback();
      return res.status(500).json({
        success: false,
        message: 'Impossible de vérifier votre solde'
      });
    }

    if (userWallet.wallet.balance < price) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: `Solde insuffisant. Vous avez ${userWallet.wallet.balance} NF, il en faut ${price} NF (${priceEur} €).`,
        data: {
          current_balance: userWallet.wallet.balance,
          required_amount: price,
          required_amount_eur: priceEur,
          missing_amount: price - userWallet.wallet.balance
        }
      });
    }

    let spendResult;
    try {
      spendResult = await NewEconomyService.spendCoins(
        userId,
        currencyId,
        price,
        'subscription_purchase',
        itemId,
        description,
        transaction
      );
    } catch (spendError) {
      logger.caught('❌ [SUB] Erreur transaction NF:', spendError);
      await transaction.rollback();
      const isRiskError = transactionAuthorizationService.constructor.isRiskError(spendError);
      return res.status(isRiskError ? spendError.httpStatus : 500).json({
        success: false,
        message: isRiskError
          ? spendError.message
          : 'Erreur lors de la transaction. Vos NF n\'ont pas été débités.',
        code: isRiskError ? spendError.code : undefined
      });
    }

    const paymentTransactionId =
      spendResult?.transaction?.transactionHash ||
      spendResult?.transactionHash ||
      spendResult?.transaction?.id;
    if (!paymentTransactionId) {
      await transaction.rollback();
      return res.status(500).json({
        success: false,
        message: 'Le paiement NF n’a pas pu être confirmé. Aucun abonnement n’a été activé.'
      });
    }

    let nextExpiry;
    if (active && user.subscription_tier === TIER.PLUS && tier === TIER.PRO) {
      nextExpiry = user.subscription_expires_at
        ? new Date(user.subscription_expires_at)
        : computeNewExpiry(user, durationDays);
    } else {
      nextExpiry = computeNewExpiry(user, durationDays);
    }

    // L'habillage mis de côté à la dernière expiration revient, repassé au
    // filtre du palier acheté : un ancien Pro qui reprend Plus récupère ce que
    // Plus autorise, pas davantage. Une personnalisation en cours (renouvellement,
    // montée en gamme) n'est jamais écrasée.
    const restoredCustomization = hasPaidCustomization(user.profile_customization, {
      verified: !!user.verified,
    })
      ? null
      : restoreFromArchive(user.profile_customization_archive, tier, { verified: !!user.verified });

    await user.update(
      {
        subscription_tier: tier,
        subscription_expires_at: nextExpiry,
        // Chaque paiement confirmé recharge le générateur, y compris un
        // renouvellement ou un passage Plus → Pro.
        tweet_generation_credits: creditsAfterSubscriptionPurchase(user.tweet_generation_credits),
        ...(restoredCustomization
          ? { profile_customization: restoredCustomization, profile_customization_archive: null }
          : {}),
        updated_at: new Date()
      },
      { transaction }
    );

    await transaction.commit();

    res.json({
      success: true,
      message: tier === TIER.PRO ? 'Abonnement Pro activé !' : 'Abonnement Plus activé !',
      data: {
        premium: true,
        subscription_tier: tier,
        subscription_expires_at: nextExpiry,
        tweet_generation_credits: user.tweet_generation_credits,
        tweet_generation_credits_granted: SUBSCRIPTION_TWEET_CREDITS,
        duration_days: durationDays,
        payment_confirmed: true,
        transaction_id: paymentTransactionId,
        amount_spent: price,
        amount_spent_eur: priceEur,
        currency_symbol: pricing.currency_symbol,
        remaining_balance: spendResult.remainingBalance
      }
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('Erreur lors de l\'achat d\'abonnement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'achat de l\'abonnement'
    });
  }
}

/**
 * Achat de l'abonnement Ultra — prix FIXE en NF (30 NF), pas de conversion au
 * cours de l'euro comme Plus/Pro : c'est le prix demandé pour cette offre.
 * Fonction séparée de `handleSubscriptionPurchase` plutôt qu'un cas de plus
 * dedans : le calcul de prorata Plus→Pro de cette dernière ne s'applique pas
 * ici (prix fixe, pas de palier intermédiaire), et une offre qui débite de
 * l'argent réel ne gagne rien à partager son chemin avec une logique qui ne
 * la concerne pas.
 */
async function handleUltraPurchase(req, res) {
  const transaction = await sequelize.transaction();

  try {
    const userId = req.user.id;
    const NewEconomyService = require('../services/newEconomyService');

    // Même choix de verrou que `handleSubscriptionPurchase` : NO KEY UPDATE
    // plutôt que FOR UPDATE, pour ne pas bloquer sur la FK que l'autorisation
    // antifraude prend en parallèle (voir [[verrou-users-vs-antifraude]]).
    const subscriptionLock = transaction.LOCK.NO_KEY_UPDATE;
    const user = await User.findByPk(userId, { transaction, lock: subscriptionLock });
    if (!user) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    await maybeExpireSubscription(user, transaction);
    await user.reload({ transaction, lock: subscriptionLock });

    const price = TIER_PRICES_NF_FIXED[TIER.ULTRA];
    const durationDays = DEFAULT_DURATION_DAYS;
    const itemId = `subscription_${TIER.ULTRA}_${durationDays}d`;
    const description = `Abonnement Ultra (${durationDays} j.)`;

    const currency = await getPlatformCurrency({ transaction });
    const currencyId = currency?.id || null;
    if (!currencyId) {
      await transaction.rollback();
      return res.status(503).json({ success: false, message: 'Le portefeuille NF est momentanément indisponible.' });
    }

    await NewEconomyService.ensureWalletsForUser(userId, transaction);

    let userWallet;
    try {
      userWallet = await NewEconomyService.getUserWallet(currencyId, userId, transaction);
    } catch (walletError) {
      logger.error('❌ [SUB] Erreur récupération wallet (Ultra):', walletError);
      await transaction.rollback();
      return res.status(500).json({ success: false, message: 'Impossible de vérifier votre solde' });
    }

    if (userWallet.wallet.balance < price) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: `Solde insuffisant. Vous avez ${userWallet.wallet.balance} NF, il en faut ${price} NF.`,
        data: {
          current_balance: userWallet.wallet.balance,
          required_amount: price,
          missing_amount: price - userWallet.wallet.balance,
        },
      });
    }

    let spendResult;
    try {
      spendResult = await NewEconomyService.spendCoins(
        userId, currencyId, price, 'subscription_purchase', itemId, description, transaction
      );
    } catch (spendError) {
      logger.caught('❌ [SUB] Erreur transaction NF (Ultra):', spendError);
      await transaction.rollback();
      const isRiskError = transactionAuthorizationService.constructor.isRiskError(spendError);
      return res.status(isRiskError ? spendError.httpStatus : 500).json({
        success: false,
        message: isRiskError ? spendError.message : 'Erreur lors de la transaction. Vos NF n\'ont pas été débités.',
        code: isRiskError ? spendError.code : undefined,
      });
    }

    const paymentTransactionId =
      spendResult?.transaction?.transactionHash || spendResult?.transactionHash || spendResult?.transaction?.id;
    if (!paymentTransactionId) {
      await transaction.rollback();
      return res.status(500).json({ success: false, message: 'Le paiement NF n’a pas pu être confirmé. Aucun abonnement n’a été activé.' });
    }

    // Crédit publicitaire (100 €, converti en NF) : versé DEPUIS le trésor
    // (`rewardFromTreasury`), pas prélevé sur qui que ce soit — même
    // transaction que l'achat, donc annulé avec lui si la suite échoue. Il
    // atterrit sur le portefeuille NF normal : pas de grand livre séparé
    // « publicité uniquement », donc rien n'empêche techniquement de le
    // dépenser ailleurs — présenté côté client comme un crédit pub, pas
    // appliqué comme tel en base.
    const AD_CREDIT_EUR = 100;
    const adCreditNf = nfAmountForEur(AD_CREDIT_EUR, currency?.currentPrice);
    let adCreditGranted = 0;
    if (adCreditNf) {
      const rewardResult = await NewEconomyService.rewardUser(
        userId, currencyId, adCreditNf, 'Crédit publicitaire Ultra', transaction
      );
      if (rewardResult.success) adCreditGranted = adCreditNf;
      else logger.warn(`[SUB] Crédit publicitaire Ultra non versé pour ${userId}: ${rewardResult.reason}`);
    }

    const nextExpiry = computeNewExpiry(user, durationDays);

    const restoredCustomization = hasPaidCustomization(user.profile_customization, { verified: !!user.verified })
      ? null
      : restoreFromArchive(user.profile_customization_archive, TIER.ULTRA, { verified: !!user.verified });

    await user.update(
      {
        subscription_tier: TIER.ULTRA,
        subscription_expires_at: nextExpiry,
        tweet_generation_credits: creditsAfterSubscriptionPurchase(user.tweet_generation_credits),
        ...(restoredCustomization
          ? { profile_customization: restoredCustomization, profile_customization_archive: null }
          : {}),
        updated_at: new Date(),
      },
      { transaction }
    );

    await transaction.commit();

    res.json({
      success: true,
      message: 'Abonnement Ultra activé !',
      data: {
        premium: true,
        subscription_tier: TIER.ULTRA,
        subscription_expires_at: nextExpiry,
        tweet_generation_credits: user.tweet_generation_credits,
        tweet_generation_credits_granted: SUBSCRIPTION_TWEET_CREDITS,
        duration_days: durationDays,
        payment_confirmed: true,
        transaction_id: paymentTransactionId,
        amount_spent: price,
        currency_symbol: currency?.symbol || 'NF',
        remaining_balance: spendResult.remainingBalance,
        ad_credit_granted: adCreditGranted,
        ad_credit_eur_equivalent: AD_CREDIT_EUR,
      },
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('Erreur lors de l\'achat de l\'abonnement Ultra:', error);
    res.status(500).json({ success: false, message: 'Erreur lors de l\'achat de l\'abonnement' });
  }
}

// ========================================
// ROUTES PUBLIQUES (sans authentification)
// ========================================

/**
 * GET /api/users/onboarding/suggestions
 * Comptes les plus influents, pour l'écran d'abonnements de l'inscription.
 *
 * Distinct de /suggestions, qui s'appuie sur le graphe social : à l'inscription
 * il n'y a pas de graphe.
 */
router.get('/onboarding/suggestions', [
  authenticateToken,
  denySuspended,
  query('limit').optional().isInt({ min: 3, max: 30 }),
  handleValidationErrors
], async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 12;
    const suggestions = await UserFollow.getInfluentialSuggestions(req.user.id, limit);

    res.json({
      success: true,
      data: {
        suggestions,
        minimum_follows: ONBOARDING_MIN_FOLLOWS,
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des suggestions d\'inscription:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * POST /api/users/onboarding/follows
 * Enregistre les abonnements choisis à l'inscription et clôt l'étape.
 *
 * Un seul appel plutôt que N appels à /:id/follow suivis d'un marqueur : sinon
 * une coupure réseau au milieu laisse un compte à moitié abonné et l'écran
 * revient en boucle.
 */
router.post('/onboarding/follows', [
  authenticateToken,
  denySuspended,
  body('userIds')
    .isArray({ min: ONBOARDING_MIN_FOLLOWS, max: 30 })
    .withMessage(`Choisis au moins ${ONBOARDING_MIN_FOLLOWS} comptes`),
  body('userIds.*').isUUID().withMessage('Identifiant de compte invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const followerId = req.user.id;
    const requested = [...new Set(req.body.userIds.map(String))].filter((id) => id !== followerId);

    if (requested.length < ONBOARDING_MIN_FOLLOWS) {
      return res.status(400).json({
        success: false,
        message: `Choisis au moins ${ONBOARDING_MIN_FOLLOWS} comptes différents`,
      });
    }

    // Seules les cibles réellement suivables comptent : un compte supprimé,
    // suspendu ou privé glissé dans la liste ne doit pas valider l'étape.
    const targets = await User.findAll({
      where: {
        id: { [Op.in]: requested },
        is_active: true,
        is_suspended: false,
        is_private_account: false,
      },
      attributes: ['id'],
    });

    if (targets.length < ONBOARDING_MIN_FOLLOWS) {
      return res.status(400).json({
        success: false,
        message: `Choisis au moins ${ONBOARDING_MIN_FOLLOWS} comptes disponibles`,
      });
    }

    const existing = await UserFollow.findAll({
      where: { follower_id: followerId, following_id: { [Op.in]: targets.map((t) => t.id) } },
      attributes: ['following_id'],
    });
    const alreadyFollowed = new Set(existing.map((f) => f.following_id));

    const created = [];
    for (const target of targets) {
      if (alreadyFollowed.has(target.id)) continue;
      // Séquentiel et non Promise.all : les hooks du modèle incrémentent les
      // compteurs `stats` des deux comptes, et les paralléliser sur la même
      // ligne ferait perdre des incréments.
      await UserFollow.create({
        follower_id: followerId,
        following_id: target.id,
        status: 'active',
        metadata: { source: 'onboarding', device: req.headers['user-agent'] || 'unknown' },
      });
      created.push(target.id);
    }

    await User.update(
      { follow_onboarding_completed_at: new Date() },
      { where: { id: followerId } }
    );

    res.json({
      success: true,
      message: 'Abonnements enregistrés',
      data: {
        followed: created,
        total_followed: alreadyFollowed.size + created.length,
        needs_follow_onboarding: false,
      }
    });
  } catch (error) {
    logger.error('Erreur lors des abonnements d\'inscription:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * GET /api/users/suggestions
 * Obtenir des suggestions d'utilisateurs à suivre
 */
router.get('/suggestions', [
  authenticateToken,
  denySuspended,
  query('limit').optional().isInt({ min: 1, max: 20 }).withMessage('La limite doit être entre 1 et 20'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const userId = req.user.id;

    const suggestions = await UserFollow.getFollowSuggestions(userId, parseInt(limit));

    res.json({
      success: true,
      message: 'Suggestions d\'utilisateurs récupérées avec succès',
      data: { suggestions }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des suggestions:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/profile/:username
 * Obtenir le profil public d'un utilisateur par son username
 */
router.get('/profile/:username', [
  param('username').isLength({ min: 1, max: 30 }).withMessage('Username doit être entre 1 et 30 caractères'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { username } = req.params;
    
    const user = await User.findOne({
      where: { 
        username: username,
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'banner', 'bio', 'city', 'verified', 'premium', 'subscription_tier', 'verification_style', 'stats', 'profile_customization', 'created_at', 'last_activity']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Profil introuvable'
      });
    }

    res.json({
      success: true,
      message: 'Profil utilisateur récupéré avec succès',
      data: { user }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération du profil utilisateur par username:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/profile/authenticated/:username
 * Obtenir le profil d'un utilisateur par son username (authentifié),
 * en incluant des informations de relation (ex: isFollowing)
 */
router.get('/profile/authenticated/:username', [
  authenticateToken,
  checkUserBanReadOnly,
  param('username').isLength({ min: 1, max: 30 }).withMessage('Username doit être entre 1 et 30 caractères'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { username } = req.params;
    const currentUserId = req.user.id;

    const user = await User.findOne({
      where: {
        username: username,
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'banner', 'verified', 'premium', 'subscription_tier', 'verification_style', 'stats', 'profile_customization', 'is_private_account', 'created_at', 'last_activity']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Profil introuvable'
      });
    }

    // Un profil bloqué (dans un sens ou l'autre) rend un état explicite, pas
    // un 404 : l'app doit pouvoir afficher « vous avez bloqué ce compte »
    // (avec un bouton débloquer) plutôt qu'un « compte introuvable » qui
    // laisse croire à un compte supprimé.
    if (currentUserId && user.id !== currentUserId) {
      const blocked = await blockedStateBetween(currentUserId, user.id);
      if (blocked) {
        return res.json({
          success: true,
          message: 'Profil utilisateur (auth) récupéré avec succès',
          data: { user: minimalBlockedUser(user), isFollowing: false, followStatus: null, blocked }
        });
      }
    }

    // 📊 Track profile view pour l'algorithme Rust
    if (currentUserId && user.id !== currentUserId) {
      ctrTracker.trackProfileView(currentUserId, user.id).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });
    }

    // Déterminer la relation de suivi si l'utilisateur courant n'est pas le même
    let isFollowing = false;
    let followStatus = null;
    if (currentUserId && user.id !== currentUserId) {
      const existingFollow = await UserFollow.findOne({
        where: { follower_id: currentUserId, following_id: user.id },
        attributes: ['status']
      });
      followStatus = existingFollow?.status || null;
      isFollowing = followStatus === 'active';
    }

    // Visite de profil : enregistrée sans être attendue. Une visite perdue
    // n'est rien ; une page de profil ralentie par une écriture se voit.
    // Seule cette route (authentifiée, nominative) alimente la fonctionnalité —
    // la route publique par id ne sait pas QUI regarde, et deviner serait faux.
    profileViewService.record({ profileId: user.id, viewerId: currentUserId })
      .catch((e) => logger.warn(`Visite de profil non enregistrée: ${e.message}`));

    res.json({
      success: true,
      message: 'Profil utilisateur (auth) récupéré avec succès',
      data: { user, isFollowing, followStatus }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération du profil utilisateur (auth):', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/subscription-pricing
 * Prix Premium fixe en euros et équivalent NF calculé au cours du moment.
 * Cette route doit rester AVANT `/:id`, sinon Express traite
 * "subscription-pricing" comme un identifiant utilisateur.
 */
router.get('/subscription-pricing', authenticateToken, async (req, res) => {
  try {
    return res.json({ success: true, data: await resolveSubscriptionPricing() });
  } catch (error) {
    logger.error('Erreur subscription-pricing:', error);
    return res.status(503).json({ success: false, message: 'Le cours du NF est momentanément indisponible.' });
  }
});

/**
 * GET /api/users/follow-requests
 * Demandes de suivi reçues, en attente d'approbation (compte privé).
 * Cette route doit rester AVANT `/:id`, même raison que subscription-pricing.
 */
router.get('/follow-requests', authenticateToken, async (req, res) => {
  try {
    // AUDIT R3-08a (2026-08-19) : aucune pagination — un compte privé un peu
    // visible en accumule des milliers, avec le profil complet de chaque
    // demandeur. L'app ne fait pas encore de défilement sur cet écran, d'où
    // un plafond généreux plutôt qu'une page courte qui tronquerait un usage
    // réel dès aujourd'hui.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const requests = await UserFollow.findAll({
      where: { following_id: req.user.id, status: 'pending' },
      include: [{
        model: User,
        as: 'follower',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'profile_customization']
      }],
      order: [['created_at', 'DESC']],
      limit,
      offset,
    });

    res.json({ success: true, message: 'Demandes de suivi récupérées avec succès', data: { requests } });
  } catch (error) {
    logger.error('Erreur lors de la récupération des demandes de suivi:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * PUT /api/users/follow-requests/:followId/accept
 * Accepter une demande de suivi reçue.
 */
router.put('/follow-requests/:followId/accept', [
  authenticateToken,
  param('followId').isUUID().withMessage('ID de demande invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const request = await UserFollow.findOne({
      where: { id: req.params.followId, following_id: req.user.id, status: 'pending' }
    });

    if (!request) {
      return res.status(404).json({ success: false, message: 'Demande de suivi introuvable' });
    }

    await request.update({ status: 'active' });

    res.json({ success: true, message: 'Demande de suivi acceptée', data: { follow: request } });
  } catch (error) {
    logger.error('Erreur lors de l\'acceptation de la demande de suivi:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * PUT /api/users/follow-requests/:followId/reject
 * Refuser (supprimer) une demande de suivi reçue.
 */
router.put('/follow-requests/:followId/reject', [
  authenticateToken,
  param('followId').isUUID().withMessage('ID de demande invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const request = await UserFollow.findOne({
      where: { id: req.params.followId, following_id: req.user.id, status: 'pending' }
    });

    if (!request) {
      return res.status(404).json({ success: false, message: 'Demande de suivi introuvable' });
    }

    await request.destroy();

    res.json({ success: true, message: 'Demande de suivi refusée' });
  } catch (error) {
    logger.error('Erreur lors du refus de la demande de suivi:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * DELETE /api/users/followers/:followerId
 * Retirer quelqu'un de SES propres abonnés.
 *
 * L'inverse de `DELETE /:id/follow` : là, on décide de ne plus suivre ; ici, on
 * décide que quelqu'un ne nous suit plus. C'est le geste qui manquait pour
 * qu'un compte privé serve à quelque chose une fois qu'on a accepté quelqu'un
 * par erreur — sans lui, il fallait passer le compte en public, retirer, et
 * repasser en privé.
 *
 * Le lien est SUPPRIMÉ, pas repassé en `pending` : une demande en attente est
 * quelque chose que la personne a formulé, la fabriquer à sa place lui ferait
 * croire qu'elle a redemandé. Elle repart donc de zéro et devra refaire la
 * démarche — qui retombera en `pending` si le compte est toujours privé.
 */
router.delete('/followers/:followerId', [
  authenticateToken,
  denySuspended,
  param('followerId').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const ownerId = req.user.id;
    const followerId = req.params.followerId;

    if (String(ownerId) === String(followerId)) {
      return res.status(400).json({ success: false, message: 'Opération invalide' });
    }

    // On ne retire QUE des liens qui pointent vers soi : impossible de casser
    // l'abonnement de deux tiers, même en devinant leurs identifiants.
    const follow = await UserFollow.findOne({
      where: { follower_id: followerId, following_id: ownerId }
    });

    if (!follow) {
      return res.status(404).json({
        success: false,
        message: 'Cette personne ne fait pas partie de vos abonnés'
      });
    }

    // `destroy` déclenche le hook qui décrémente les compteurs des deux côtés —
    // et uniquement pour un lien `active`, donc retirer une demande encore en
    // attente ne fait pas tomber le compteur d'abonnés en négatif.
    await follow.destroy();

    // Le graphe du moteur de similarité doit oublier l'arête, sinon il
    // continue de recommander comme si la personne suivait toujours.
    try {
      const similarity = require('../services/similarity');
      similarity.onUnfollow(followerId, ownerId);

      const videoRecommendationService = require('../services/videoRecommendationService');
      videoRecommendationService.onFollow(followerId, ownerId, false);
    } catch (e) { /* non-critique */ }

    res.json({
      success: true,
      message: 'Abonné retiré',
      data: { removed_follower_id: String(followerId) }
    });

  } catch (error) {
    logger.error('Erreur lors du retrait d\'un abonné:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * GET /api/users/blocked
 * Comptes que JE bloque — pour l'écran « débloquer ». Doit rester AVANT
 * `/:id`, sinon Express traite "blocked" comme un identifiant utilisateur
 * (échoue sur la validation UUID de cette route-là, mais silencieusement).
 */
router.get('/blocked', [
  authenticateToken,
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  handleValidationErrors,
], async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const rows = await UserFollow.findAll({
      where: { follower_id: userId, status: 'blocked' },
      include: [{
        model: User,
        as: 'following',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'profile_customization']
      }],
      order: [['updated_at', 'DESC']],
      limit,
      offset,
    });
    const totalCount = await UserFollow.count({ where: { follower_id: userId, status: 'blocked' } });

    res.json({
      success: true,
      message: 'Comptes bloqués récupérés avec succès',
      data: {
        users: rows.map((row) => row.following).filter(Boolean),
        pagination: { total: totalCount, limit, offset, hasMore: offset + rows.length < totalCount },
      },
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des comptes bloqués:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/* ── Renouvellement automatique (mandat) ────────────────────────────────── */

/**
 * ⚠ Ce bloc doit rester AVANT `GET /api/users/:id`, juste en dessous.
 *
 * Express sert la première route qui correspond : placé après, le GET de ce
 * bloc était avalé par `/:id`, qui répondait « ID d'utilisateur invalide » en
 * validant « subscription-mandate » comme un UUID. La route existait, elle
 * n'était simplement jamais atteinte — et l'écran d'abonnement se serait
 * contenté de masquer l'interrupteur, sans la moindre erreur visible.
 *
 * Ces trois routes SIGNENT et RÉSILIENT un mandat ; elles ne prélèvent jamais.
 * Les prélèvements sont exécutés par le démon `twitninf-autorenew`, hors de
 * l'API. Voir `services/subscriptionMandateService.js` pour l'invariant
 * `subscription_expires_at = NULL` qui met un compte sous mandat hors
 * d'atteinte du balayage horaire des abonnements échus.
 */

function sendMandateError(res, error, fallback) {
  const status = Number(error?.httpStatus) || 500;
  if (status >= 500) {
    logger.error('❌ [Mandat] ', error);
  }
  return res.status(status).json({
    success: false,
    message: status >= 500 ? fallback : error.message,
    code: error?.code,
  });
}

/**
 * GET /api/users/subscription-mandate
 * État du renouvellement automatique du compte.
 */
router.get('/subscription-mandate', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'subscription_tier', 'subscription_expires_at', 'premium'],
    });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Compte introuvable.' });
    }
    res.json({ success: true, data: await subscriptionMandateService.describe(user) });
  } catch (error) {
    sendMandateError(res, error, 'Impossible de lire le renouvellement automatique.');
  }
});

/**
 * POST /api/users/subscription-mandate
 * Active la reconduction pour le palier actuellement actif.
 */
router.post('/subscription-mandate', [
  authenticateToken,
  denySuspended
], async (req, res) => {
  try {
    const mandate = await subscriptionMandateService.enable(req.user.id);
    res.json({
      success: true,
      message: 'Renouvellement automatique activé.',
      data: {
        enabled: true,
        state: mandate?.state || 'ACTIVE',
        tier: mandate?.tier || null,
        next_charge_at: mandate?.next_charge_at || null,
      },
    });
  } catch (error) {
    sendMandateError(res, error, 'Activation impossible pour le moment.');
  }
});

/**
 * DELETE /api/users/subscription-mandate
 * Résilie la reconduction. La période déjà payée s'écoule normalement.
 */
router.delete('/subscription-mandate', [
  authenticateToken,
  denySuspended
], async (req, res) => {
  try {
    const { expiresAt } = await subscriptionMandateService.disable(req.user.id);
    res.json({
      success: true,
      message: 'Renouvellement automatique désactivé.',
      data: { enabled: false, subscription_expires_at: expiresAt },
    });
  } catch (error) {
    sendMandateError(res, error, 'Désactivation impossible pour le moment.');
  }
});

/**
 * PATCH /api/users/subscription-mandate
 * Reprogramme la reconduction sur un palier inférieur (rétrogradation différée
 * à l'échéance). Le palier courant tient jusqu'à la fin de la période payée,
 * puis le renouvellement bascule sur le palier demandé. Rien n'est débité ici.
 *
 * Doit rester AVANT `router.get('/:id')` : sinon « subscription-mandate » serait
 * capté comme un identifiant.
 */
router.patch('/subscription-mandate', [
  authenticateToken,
  denySuspended
], async (req, res) => {
  try {
    // On accepte les trois paliers reconductibles, ultra compris : c'est le
    // service qui refuse toute cible AU-DESSUS du palier courant. Accepter
    // ultra permet à un compte Ultra d'ANNULER une rétrogradation déjà
    // programmée en repointant la reconduction sur son palier actuel.
    const raw = String(req.body?.tier || '').toLowerCase();
    const tier = ['plus', 'pro', 'ultra'].includes(raw) ? raw : null;
    if (!tier) {
      return res.status(400).json({
        success: false,
        message: 'Palier invalide.',
      });
    }
    const data = await subscriptionMandateService.scheduleTierChange(req.user.id, tier);
    res.json({
      success: true,
      message: 'Le renouvellement passera au palier choisi à la prochaine échéance.',
      data,
    });
  } catch (error) {
    sendMandateError(res, error, 'Changement de palier impossible pour le moment.');
  }
});

/**
 * GET /api/users/:id
 * Obtenir le profil public d'un utilisateur par son ID
 */
router.get('/:id', [
  // Authentification FACULTATIVE : la route reste publique, mais quand un
  // jeton accompagne la requête on sait qui regarde — et c'est par ici que
  // l'app arrive quand on touche un avatar dans le fil (elle n'a alors qu'un
  // id, pas un nom). Sans ça, « qui a consulté ton profil » ne comptait que
  // les visites faites par le chemin nominatif : la table est restée vide.
  optionalAuthenticateToken,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findOne({
      where: { 
        id: id,
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'banner', 'bio', 'city', 'verified', 'premium', 'verification_style', 'stats', 'profile_customization', 'is_private_account', 'created_at', 'last_activity']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Profil introuvable'
      });
    }

    // Blocage dans un sens ou l'autre : un profil normal ne doit pas se
    // rendre, dans aucun des deux sens — voir la même logique sur
    // `/profile/authenticated/:username`.
    if (req.user?.id && req.user.id !== user.id) {
      const blocked = await blockedStateBetween(req.user.id, user.id);
      if (blocked) {
        return res.json({
          success: true,
          message: 'Profil utilisateur récupéré avec succès',
          data: { user: minimalBlockedUser(user), blocked }
        });
      }
    }

    // Visite enregistrée sans être attendue, comme sur la route nominative.
    // `record` ignore de lui-même le visiteur anonyme et l'auto-visite.
    if (req.user?.id) {
      profileViewService.record({ profileId: user.id, viewerId: req.user.id })
        .catch((e) => logger.warn(`Visite de profil non enregistrée: ${e.message}`));
    }

    res.json({
      success: true,
      message: 'Profil utilisateur récupéré avec succès',
      data: { user }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération du profil utilisateur:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/:id/tweets
 * Obtenir les tweets d'un utilisateur
 */
/**
 * Enrichit une liste de tweets avec compteurs (likes/retweets/replies) et
 * statut d'interaction de l'utilisateur courant, en batch (une requête par
 * métrique pour toute la page) au lieu d'une requête par tweet.
 */
async function hydrateTweetStats(tweets, currentUserId) {
  const tweetIds = tweets.map((t) => t.id);
  if (tweetIds.length === 0) return [];

  const [likeCounts, retweetCounts, replyCounts, likedRows, retweetedRows] = await Promise.all([
    TweetLike.findAll({
      where: { tweet_id: tweetIds },
      attributes: ['tweet_id', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['tweet_id'],
      raw: true
    }),
    TweetRetweet.findAll({
      where: { tweet_id: tweetIds },
      attributes: ['tweet_id', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['tweet_id'],
      raw: true
    }),
    Tweet.findAll({
      where: { parent_tweet_id: tweetIds },
      attributes: ['parent_tweet_id', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['parent_tweet_id'],
      raw: true
    }),
    currentUserId
      ? TweetLike.findAll({ where: { tweet_id: tweetIds, user_id: currentUserId }, attributes: ['tweet_id'], raw: true })
      : [],
    currentUserId
      ? TweetRetweet.findAll({ where: { tweet_id: tweetIds, user_id: currentUserId }, attributes: ['tweet_id'], raw: true })
      : []
  ]);

  const likeCountMap = new Map(likeCounts.map((r) => [r.tweet_id, parseInt(r.count, 10)]));
  const retweetCountMap = new Map(retweetCounts.map((r) => [r.tweet_id, parseInt(r.count, 10)]));
  const replyCountMap = new Map(replyCounts.map((r) => [r.parent_tweet_id, parseInt(r.count, 10)]));
  const likedSet = new Set(likedRows.map((r) => r.tweet_id));
  const retweetedSet = new Set(retweetedRows.map((r) => r.tweet_id));

  return tweets.map((tweet) => ({
    ...tweet.toJSON(),
    stats: {
      likes: likeCountMap.get(tweet.id) || 0,
      retweets: retweetCountMap.get(tweet.id) || 0,
      replies: replyCountMap.get(tweet.id) || 0,
      views: tweet.view_count || 0
    },
    user_interaction: {
      is_liked: likedSet.has(tweet.id),
      is_retweeted: retweetedSet.has(tweet.id)
    }
  }));
}

router.get('/:id/tweets', [
  authenticateToken,
  checkUserBanReadOnly,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  query('type').optional().isIn(['all', 'tweets', 'replies', 'retweets', 'media', 'likes']).withMessage('Type de tweet invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0, type = 'all' } = req.query;

    // Vérifier que l'utilisateur existe
    const user = await User.findOne({
      where: { 
        id: id,
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style', 'is_private_account', 'profile_customization']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Profil introuvable'
      });
    }

    // Utilisateur authentifié via middleware
    const currentUserId = req.user.id;

    // Blocage dans un sens ou l'autre : mêmes tweets vides que sur un
    // compte privé fermé, mais avant même le contrôle de confidentialité —
    // un blocage doit fermer strictement plus qu'un compte simplement privé.
    if (String(currentUserId) !== String(id) && await blockedStateBetween(currentUserId, id)) {
      return res.json({
        success: true,
        message: 'Tweets de l\'utilisateur récupérés avec succès',
        data: {
          user,
          tweets: [],
          pagination: { total: 0, limit: parseInt(limit), offset: parseInt(offset), hasMore: false }
        }
      });
    }

    // Compte privé : personne d'autre que le propriétaire ou un abonné
    // accepté (`active`) ne voit les tweets. Le client déduit l'état
    // "verrouillé" de `user.is_private_account` + son statut de suivi.
    if (user.is_private_account && String(currentUserId) !== String(id)) {
      const isFollower = await UserFollow.isFollowing(currentUserId, id);
      if (!isFollower) {
        return res.json({
          success: true,
          message: 'Tweets de l\'utilisateur récupérés avec succès',
          data: {
            user,
            tweets: [],
            pagination: { total: 0, limit: parseInt(limit), offset: parseInt(offset), hasMore: false }
          }
        });
      }
    }

    let tweets = [];
    let totalCount = 0;

    if (type === 'retweets') {
      // Récupérer les retweets via la table TweetRetweet
      const retweets = await TweetRetweet.findAll({
        where: { user_id: id },
        include: [{
          model: Tweet,
          as: 'tweet',
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style', 'profile_customization']
          }]
        }],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      totalCount = await TweetRetweet.count({ where: { user_id: id } });

      // Mapper vers les tweets enrichis (stats/interactions en batch, pas de N+1)
      const visibleRetweets = await filterVisibleTweets(
        retweets.map((rt) => rt.tweet),
        currentUserId,
        { User, UserFollow, Op }
      );
      tweets = await hydrateTweetStats(visibleRetweets, currentUserId);
    } else if (type === 'likes') {
      // L'onglet J'aime suit l'ordre des likes, pas la date de publication.
      // Les tweets privés, modérés ou issus d'un compte privé non suivi sont
      // retirés avant hydratation afin que cet onglet ne contourne jamais les
      // règles de confidentialité du fil.
      const likedRows = await TweetLike.findAll({
        where: { user_id: id },
        include: [{
          model: Tweet,
          as: 'tweet',
          required: true,
          where: { is_private: false, moderation_status: 'approved' },
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style', 'profile_customization']
          }]
        }],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      totalCount = await TweetLike.count({
        where: { user_id: id },
        include: [{
          model: Tweet,
          as: 'tweet',
          required: true,
          where: { is_private: false, moderation_status: 'approved' }
        }]
      });

      const visibleLikes = await filterVisibleTweets(
        likedRows.map((like) => like.tweet),
        currentUserId,
        { User, UserFollow, Op }
      );
      tweets = await hydrateTweetStats(visibleLikes, currentUserId);
    } else {
      // Tweets et réponses (et éventuellement all)
      const whereClause = { user_id: id, is_private: false, moderation_status: 'approved' };
      if (type === 'replies') {
        whereClause.parent_tweet_id = { [Op.ne]: null };
        whereClause.is_retweet = false;
        whereClause.is_quote = false;
      } else if (type === 'tweets') {
        whereClause.parent_tweet_id = null;
        whereClause.is_retweet = false;
        whereClause.is_quote = false;
      } else if (type === 'media') {
        whereClause.is_retweet = false;
        whereClause[Op.and] = [
          sequelize.where(
            sequelize.fn('jsonb_array_length', sequelize.col('media_urls')),
            { [Op.gt]: 0 }
          )
        ];
      }

      const rawTweets = await Tweet.findAll({
        where: whereClause,
        include: [{
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style', 'profile_customization']
        }],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      totalCount = await Tweet.count({ where: whereClause });

      tweets = await hydrateTweetStats(rawTweets, currentUserId);
    }

    // Contenus payants : le profil est l'endroit le plus évident où aller
    // chercher un tweet vendu. Même masquage que le fil, même dernière étape.
    if (!(await paidContentService.maskTweetsOrFail(tweets, currentUserId, res))) return;

    res.json({
      success: true,
      message: 'Tweets de l\'utilisateur récupérés avec succès',
      data: {
        user,
        tweets,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + tweets.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des tweets de l\'utilisateur:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/:id/followers
 * Obtenir les followers d'un utilisateur
 */
router.get('/:id/followers', [
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  // Plafond à 2000 : l'app charge la liste complète en une fois pour bâtir
  // l'ensemble « abonnements » utilisé par le fil. À 100, la requête partait
  // en `?limit=500` et se faisait rejeter en 400 (badge « abonné » jamais posé).
  query('limit').optional().isInt({ min: 1, max: 2000 }).withMessage('La limite doit être entre 1 et 2000'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Vérifier que l'utilisateur existe
    const user = await User.findByPk(id, {
      where: { is_active: true },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style', 'profile_customization']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    const followers = await UserFollow.getFollowers(id, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      includeUser: true
    });

    // Compter le total
    const totalCount = await UserFollow.countFollowers(id);

    res.json({
      success: true,
      message: 'Followers récupérés avec succès',
      data: {
        user,
        followers: followers.map(f => f.follower),
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + followers.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des followers:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/:id/following
 * Obtenir les utilisateurs suivis par un utilisateur
 */
router.get('/:id/following', [
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  // Plafond à 2000 : voir la note sur `/:id/followers`. L'app demande `limit=500`
  // pour récupérer tous les abonnements d'un coup ; à 100 elle prenait un 400.
  query('limit').optional().isInt({ min: 1, max: 2000 }).withMessage('La limite doit être entre 1 et 2000'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Vérifier que l'utilisateur existe
    const user = await User.findByPk(id, {
      where: { is_active: true },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style', 'profile_customization']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    const following = await UserFollow.getFollowing(id, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      includeUser: true
    });

    // Compter le total
    const totalCount = await UserFollow.countFollowing(id);

    res.json({
      success: true,
      message: 'Utilisateurs suivis récupérés avec succès',
      data: {
        user,
        following: following.map(f => f.following),
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + following.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des utilisateurs suivis:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

// ========================================
// ROUTES PROTÉGÉES (avec authentification)
// ========================================

/**
 * POST /api/users/:id/follow
 * S'abonner à un utilisateur
 */
router.post('/:id/follow', [
  authenticateToken,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const followerId = req.user.id;
    const followingId = req.params.id;

    // Vérifier que l'utilisateur ne suit pas lui-même
    if (followerId === followingId) {
      return res.status(400).json({
        success: false,
        message: 'Vous ne pouvez pas vous suivre vous-même'
      });
    }

    // Vérifier que l'utilisateur à suivre existe
    const userToFollow = await User.findByPk(followingId, {
      where: { is_active: true }
    });

    if (!userToFollow) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur à suivre non trouvé'
      });
    }

    // Vérifier si l'utilisateur suit déjà
    const existingFollow = await UserFollow.findOne({
      where: {
        follower_id: followerId,
        following_id: followingId
      }
    });

    if (existingFollow) {
      return res.status(400).json({
        success: false,
        message: 'Vous suivez déjà cet utilisateur'
      });
    }

    // Compte privé : la demande reste en attente jusqu'à approbation par la
    // cible, elle ne compte pas encore comme un suivi (cf. hooks UserFollow).
    const targetStatus = userToFollow.is_private_account ? 'pending' : 'active';

    // Créer le suivi
    const follow = await UserFollow.create({
      follower_id: followerId,
      following_id: followingId,
      status: targetStatus,
      metadata: {
        source: req.userPlatform || 'unknown',
        device: req.headers['user-agent'] || 'unknown',
        ip_address: req.ip
      }
    });

    if (targetStatus === 'pending') {
      try {
        await Notification.createFollowRequestNotification(followerId, followingId);
      } catch (e) { /* non-critique */ }
    } else {
      // 🔗 Mettre à jour le graphe social du moteur de similarité en temps réel
      try {
        const similarity = require('../services/similarity');
        similarity.onFollow(followerId, followingId);

        // 🎬 [VideoReco] New video engine follow
        const videoRecommendationService = require('../services/videoRecommendationService');
        videoRecommendationService.onFollow(followerId, followingId, true);
      } catch (e) { /* non-critique */ }
    }

    res.status(201).json({
      success: true,
      message: targetStatus === 'pending' ? 'Demande de suivi envoyée' : 'Abonnement créé avec succès',
      data: { follow, status: targetStatus }
    });

  } catch (error) {
    logger.error('Erreur lors de la création de l\'abonnement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * DELETE /api/users/:id/follow
 * Se désabonner d'un utilisateur
 */
router.delete('/:id/follow', [
  authenticateToken,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const followerId = req.user.id;
    const followingId = req.params.id;

    // Vérifier que l'utilisateur ne se désabonne pas de lui-même
    if (followerId === followingId) {
      return res.status(400).json({
        success: false,
        message: 'Opération invalide'
      });
    }

    // Vérifier si l'utilisateur suit déjà
    const existingFollow = await UserFollow.findOne({
      where: {
        follower_id: followerId,
        following_id: followingId
      }
    });

    if (!existingFollow) {
      return res.status(400).json({
        success: false,
        message: 'Vous ne suivez pas cet utilisateur'
      });
    }

    // Supprimer le suivi
    await existingFollow.destroy();

    // 🔗 Mettre à jour le graphe social du moteur de similarité en temps réel
    try {
      const similarity = require('../services/similarity');
      similarity.onUnfollow(followerId, followingId);

      // 🎬 [VideoReco] New video engine unfollow
      const videoRecommendationService = require('../services/videoRecommendationService');
      videoRecommendationService.onFollow(followerId, followingId, false);
    } catch (e) { /* non-critique */ }

    res.json({
      success: true,
      message: 'Désabonnement effectué avec succès'
    });

  } catch (error) {
    logger.error('Erreur lors de la suppression de l\'abonnement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/users/me/avatar
 * Importer une image d'avatar, la stocker et mettre à jour l'URL de profil
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Seules les images sont autorisées'));
    }
    cb(null, true);
  }
});

router.post('/me/avatar', [
  authenticateToken,
  upload.single('avatar')
], async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Fichier avatar manquant (champ "avatar")' });
    }

    const userId = req.user.id;
    const avatarsDir = path.join(__dirname, '../public/avatars');
    fs.mkdirSync(avatarsDir, { recursive: true });

    const filename = `${userId}-${Date.now()}-${uuidv4().slice(0,8)}.jpg`;
    const outputPath = path.join(avatarsDir, filename);

    // Photo iPhone = HEIC/HEVC, que le libvips embarque par `sharp` ne sait pas
    // decoder — voir `heifDecoder`. Sans ca, tout envoi depuis un iPhone echoue
    // sur « bad seek ».
    const decodableAvatar = await toDecodableBuffer(req.file.buffer);

    // Traitement image: carré 256x256, couverture, JPEG qualité 85
    await sharp(decodableAvatar)
      .rotate()
      .resize(256, 256, { fit: 'cover', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(outputPath);

    const publicUrl = buildStaticMediaPublicUrl('avatars', filename);

    // Mettre à jour l'utilisateur
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }
    user.avatar = publicUrl;
    logger.info(`Avatar DB URL: ${publicUrl}`);
    await user.save();

    // Frein de vélocité (1h, ×0.5) — voir authController.updateProfile pour
    // le même frein posé quand l'avatar change via l'URL brute.
    rustClient.triggerVelocityThrottle(String(userId), 'avatar_change');

    return res.status(201).json({
      success: true,
      message: 'Avatar mis à jour avec succès',
      data: { url: publicUrl }
    });
  } catch (error) {
    logger.error('Erreur upload avatar:', error);
    return res.status(500).json({ success: false, message: 'Erreur lors de l\'upload de l\'avatar' });
  }
});

/**
 * POST /api/users/me/banner
 * Bannière profil (image large), stockée et URL enregistrée sur l'utilisateur
 */
router.post('/me/banner', [
  authenticateToken,
  upload.single('banner')
], async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Fichier bannière manquant (champ "banner")' });
    }

    const userId = req.user.id;
    const bannersDir = path.join(__dirname, '../public/banners');
    fs.mkdirSync(bannersDir, { recursive: true });

    const filename = `banner-${userId}-${Date.now()}-${uuidv4().slice(0, 8)}.jpg`;
    const outputPath = path.join(bannersDir, filename);

    // Meme raison que pour l'avatar ci-dessus.
    const decodableBanner = await toDecodableBuffer(req.file.buffer);

    await sharp(decodableBanner)
      .rotate()
      .resize(1500, 500, { fit: 'cover', withoutEnlargement: false })
      .jpeg({ quality: 82 })
      .toFile(outputPath);

    const publicUrl = buildStaticMediaPublicUrl('banners', filename);

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }
    user.banner = publicUrl;
    logger.info(`Banner DB URL: ${publicUrl}`);
    await user.save();

    return res.status(201).json({
      success: true,
      message: 'Bannière mise à jour avec succès',
      data: { url: publicUrl }
    });
  } catch (error) {
    logger.error('Erreur upload bannière:', error);
    return res.status(500).json({ success: false, message: 'Erreur lors de l\'upload de la bannière' });
  }
});

/**
 * GET /api/users/:id/follow-status
 * Vérifier le statut de suivi entre deux utilisateurs
 */
router.get('/:id/follow-status', [
  authenticateToken,
  param('id').notEmpty().withMessage('ID d\'utilisateur requis'),
  handleValidationErrors
], async (req, res) => {
  try {
    const followerId = req.user.id;
    const followingId = req.params.id;

    // Statut brut de la relation (`active`, `pending`, ou absente) : la
    // demande de suivi sur un compte privé n'est pas encore "isFollowing".
    const existingFollow = await UserFollow.findOne({
      where: { follower_id: followerId, following_id: followingId },
      attributes: ['status']
    });
    const status = existingFollow?.status || null;

    res.json({
      success: true,
      message: 'Statut de suivi récupéré avec succès',
      data: { isFollowing: status === 'active', status }
    });

  } catch (error) {
    logger.error('Erreur lors de la vérification du statut de suivi:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

// ========================================
// ROUTES D'ADMINISTRATION DES BANS
// ========================================

/**
 * POST /api/users/:id/suspend
 * Suspendre un utilisateur (admin seulement)
 */
router.post('/:id/suspend', [
  authenticateToken,
  checkUserBanStrict, // Vérifier que l'admin n'est pas banni
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, duration_days = 7 } = req.body;
    const adminId = req.user.id;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Raison de suspension requise'
      });
    }

    const result = await BanService.suspendUser(id, reason, duration_days, adminId);

    res.json({
      success: true,
      message: 'Utilisateur suspendu avec succès',
      data: result
    });

  } catch (error) {
    logger.error('Erreur lors de la suspension:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suspension'
    });
  }
});

/**
 * POST /api/users/:id/unsuspend
 * Lever la suspension d'un utilisateur (admin seulement)
 */
router.post('/:id/unsuspend', [
  authenticateToken,
  checkUserBanStrict,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const result = await BanService.unsuspendUser(id, adminId);

    res.json({
      success: true,
      message: 'Suspension levée avec succès',
      data: result
    });

  } catch (error) {
    logger.error('Erreur lors de la levée de suspension:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la levée de suspension'
    });
  }
});

/**
 * POST /api/users/:id/ban
 * Ajouter un ban à un utilisateur (admin seulement)
 */
router.post('/:id/ban', [
  authenticateToken,
  checkUserBanStrict,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user.id;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Raison du ban requise'
      });
    }

    const result = await BanService.addBan(id, reason, adminId);

    res.json({
      success: true,
      message: 'Ban ajouté avec succès',
      data: result
    });

  } catch (error) {
    logger.error('Erreur lors de l\'ajout du ban:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'ajout du ban'
    });
  }
});

/**
 * POST /api/users/:id/unban
 * Réduire le nombre de bans d'un utilisateur (admin seulement)
 */
router.post('/:id/unban', [
  authenticateToken,
  checkUserBanStrict,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const result = await BanService.reduceBan(id, adminId);

    res.json({
      success: true,
      message: 'Ban réduit avec succès',
      data: result
    });

  } catch (error) {
    logger.error('Erreur lors de la réduction du ban:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la réduction du ban'
    });
  }
});

/**
 * GET /api/users/:id/ban-history
 * Obtenir l'historique des bans d'un utilisateur
 */
router.get('/:id/ban-history', [
  authenticateToken,
  checkUserBanReadOnly,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const history = await BanService.getBanHistory(id);

    res.json({
      success: true,
      message: 'Historique des bans récupéré avec succès',
      data: history
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'historique des bans:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de l\'historique des bans'
    });
  }
});

/**
 * POST /api/users/purchase-subscription
 * Acheter ou prolonger un abonnement payant (body.tier: « plus » | « pro »).
 */
router.post('/purchase-subscription', [
  authenticateToken,
  denySuspended
], async (req, res) => handleSubscriptionPurchase(req, res, null));

/**
 * POST /api/users/purchase-premium
 * Rétrocompatibilité : achète le palier Plus (équivalent ancien « premium » d’entrée de gamme).
 */
router.post('/purchase-premium', [
  authenticateToken,
  denySuspended
], async (req, res) => handleSubscriptionPurchase(req, res, TIER.PLUS));

/**
 * POST /api/users/purchase-ultra
 * Achète ou prolonge l'abonnement Ultra — 30 NF fixe, voir `handleUltraPurchase`.
 */
router.post('/purchase-ultra', [
  authenticateToken,
  denySuspended
], handleUltraPurchase);

/* ── Personnalisation de profil premium (façon Discord) ─────────────────── */

// Règles, listes fermées et neutralisation : voir `utils/profileCustomization`.
// Elles servent aussi à l'expiration d'abonnement, qui doit retirer exactement
// ce que l'enregistrement réserve aux paliers payants.

/**
 * GET /api/users/me/profile-customization
 * Renvoie la personnalisation courante et ce que le palier autorise.
 */
router.get('/me/profile-customization', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: [
        'id', 'premium', 'subscription_tier', 'subscription_expires_at',
        'verified', 'verification_style', 'profile_customization'
      ]
    });
    if (!user) return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });

    // Un abonnement échu doit tomber ici aussi : sans ça, l'écran resterait
    // ouvert à l'édition jusqu'au prochain passage du balayage horaire.
    await maybeExpireSubscription(user);

    const tier = customizationTier(user);
    return res.json({
      success: true,
      data: {
        customization: user.profile_customization || {},
        tier,
        can_customize: tier !== TIER.FREE,
        can_use_decorations: isProOrAbove(tier),
        // Droit adossé à la certification, pas à l'abonnement.
        can_use_certified_name: !!user.verified,
        verification_style: user.verification_style || 'default',
        options: {
          banner_styles: PROFILE_BANNER_STYLES,
          theme_intensities: PROFILE_THEME_INTENSITIES,
          avatar_decorations: PROFILE_AVATAR_DECORATIONS,
          name_fonts: PROFILE_NAME_FONTS,
          name_effects: PROFILE_NAME_EFFECTS,
          name_sizes: PROFILE_NAME_SIZES,
          profile_effects: PROFILE_EFFECTS,
          profile_title_max: PROFILE_TITLE_MAX
        }
      }
    });
  } catch (error) {
    logger.error('Erreur lecture personnalisation profil:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * PUT /api/users/me/profile-customization
 * Enregistre couleurs / style de bannière / décoration / à propos.
 */
router.put('/me/profile-customization', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });

    // Idem : on ne veut pas qu'un abonnement échu depuis quelques minutes
    // enregistre encore un habillage payant.
    await maybeExpireSubscription(user);

    const tier = customizationTier(user);
    // La certification ouvre à elle seule l'effet de nom « Certifié » : un compte
    // certifié gratuit doit pouvoir l'enregistrer. `sanitizeCustomization`
    // écarte ensuite tout le reste, qui demande bien un abonnement.
    if (tier === TIER.FREE && !user.verified) {
      return res.status(403).json({
        success: false,
        message: 'La personnalisation de profil est réservée aux abonnements Plus et Pro',
        code: 'SUBSCRIPTION_REQUIRED'
      });
    }

    const customization = sanitizeCustomization(req.body?.customization ?? req.body, tier, {
      verified: !!user.verified,
      // Les habillages possédés viennent de l'ENREGISTREMENT, jamais du corps
      // de la requête : sinon n'importe qui se les accorde en postant une
      // liste. Voir `sanitizeCustomization`.
      existing: user.profile_customization,
    });
    user.profile_customization = customization;
    // `profile_customization` est un JSONB muté par assignation : sans ce
    // `changed`, Sequelize ne détecte pas toujours la modification et le save
    // repart sans rien écrire.
    user.changed('profile_customization', true);
    // Un abonné qui refait son habillage rend l'archive caduque : la garder
    // ressusciterait ses anciens réglages à la prochaine expiration.
    if (tier !== TIER.FREE && user.profile_customization_archive) {
      user.profile_customization_archive = null;
      user.changed('profile_customization_archive', true);
    }
    await user.save();

    return res.json({
      success: true,
      message: 'Personnalisation enregistrée',
      data: { customization, tier }
    });
  } catch (error) {
    logger.error('Erreur sauvegarde personnalisation profil:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * PUT /api/users/me/language
 * Langue de lecture (« Traduction bêta »).
 *
 * Accepte les 10 langues traduites plus `fr`, la langue d'origine. Choisir
 * `fr` est un choix à part entière : il est enregistré, donc la question de
 * la première connexion ne revient plus.
 */
router.put('/me/language', [authenticateToken], async (req, res) => {
  try {
    const requested = String(req.body?.language || '').trim().toLowerCase();
    if (!READABLE_LANGUAGES.includes(requested)) {
      return res.status(400).json({
        success: false,
        message: 'Langue non prise en charge',
        code: 'UNSUPPORTED_LANGUAGE'
      });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });

    user.preferred_language = requested;
    await user.save();

    return res.json({
      success: true,
      message: 'Langue de lecture enregistrée',
      data: { preferred_language: requested }
    });
  } catch (error) {
    logger.error('Erreur enregistrement de la langue de lecture:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * GET /api/users/me/language
 * Langue de lecture actuelle et catalogue des langues disponibles.
 * `preferred_language: null` = jamais choisie, l'app pose la question.
 */
router.get('/me/language', [authenticateToken], async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'preferred_language']
    });
    if (!user) return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });

    return res.json({
      success: true,
      message: 'Langue de lecture récupérée',
      data: {
        preferred_language: user.preferred_language || null,
        languages: [
          { code: SOURCE_LANGUAGE, label: 'Français', original: true },
          ...TARGET_LANGUAGES.map((language) => ({ ...language, original: false }))
        ]
      }
    });
  } catch (error) {
    logger.error('Erreur récupération de la langue de lecture:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * POST /api/users/:id/block
 * Bloquer un utilisateur
 */
router.post('/:id/block', [
  authenticateToken,
  denySuspended,
  param('id').isUUID().withMessage('ID utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id: blockedUserId } = req.params;
    const currentUserId = req.user.id;

    // Vérifier qu'on ne se bloque pas soi-même
    if (currentUserId === blockedUserId) {
      return res.status(400).json({
        success: false,
        message: 'Vous ne pouvez pas vous bloquer vous-même'
      });
    }

    // Vérifier que l'utilisateur à bloquer existe
    const userToBlock = await User.findByPk(blockedUserId);
    if (!userToBlock) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Persiste le blocage (et coupe tout follow existant dans les deux sens,
    // stats comprises) — voir UserFollow.block.
    await UserFollow.block(currentUserId, blockedUserId);

    // 📊 Track block pour l'algorithme Rust
    ctrTracker.trackBlock(currentUserId, blockedUserId).catch(err => {
      logger.warn(`CTR tracking error: ${err.message}`);
    });

    logger.info(`Utilisateur ${currentUserId} a bloqué ${blockedUserId}`);

    res.json({
      success: true,
      message: 'Utilisateur bloqué avec succès',
      data: {
        blocked_user_id: blockedUserId,
        blocked: true
      }
    });

  } catch (error) {
    logger.error('Erreur lors du blocage:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/users/:id/unblock
 * Débloquer un utilisateur
 */
router.post('/:id/unblock', [
  authenticateToken,
  denySuspended,
  param('id').isUUID().withMessage('ID utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id: unblockedUserId } = req.params;
    const currentUserId = req.user.id;

    // Vérifier que l'utilisateur à débloquer existe
    const userToUnblock = await User.findByPk(unblockedUserId);
    if (!userToUnblock) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    await UserFollow.unblock(currentUserId, unblockedUserId);

    logger.info(`Utilisateur ${currentUserId} a débloqué ${unblockedUserId}`);

    res.json({
      success: true,
      message: 'Utilisateur débloqué avec succès',
      data: {
        unblocked_user_id: unblockedUserId,
        blocked: false
      }
    });

  } catch (error) {
    logger.error('Erreur lors du déblocage:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

module.exports = router;
