const express = require('express');
const router = express.Router();
const { User } = require('../models');
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const {
  maybeExpireSubscription,
  isSubscriptionActive,
  TIER,
  DEFAULT_DURATION_DAYS,
} = require('../utils/subscriptionHelpers');
const {
  maybeRenewSuperHearts,
  isSuperHeartEligible,
  SUPER_HEART_CAPS,
  SUPER_HEART_RENEW_DAYS,
} = require('../utils/superHeartHelpers');

router.use(authenticateToken);

/**
 * Ancien parcours premium (plans « mensuel » 30 j / « annuel » 365 j réglés par
 * un Apple Pay simulé). Il vivait à côté du vrai modèle d'abonnement — paliers
 * Plus/Pro, prix en euros débité en NF au cours du moment, durée de
 * DEFAULT_DURATION_DAYS jours — et accordait des mois de premium sans qu'aucun
 * fonds ne soit réellement débité.
 *
 * Seul `/status` survit, recalculé sur le vrai modèle. L'achat et l'annulation
 * répondent 410 : les anciennes versions installées reçoivent un message clair
 * au lieu d'un 404 muet. Le parcours en vigueur est
 * `GET /api/users/subscription-pricing` puis `POST /api/users/purchase-subscription`.
 */
const REPLACEMENT_HINT = {
  pricing_endpoint: '/api/users/subscription-pricing',
  purchase_endpoint: '/api/users/purchase-subscription',
};

// GET /api/premium/status — Statut premium réel de l'utilisateur
router.get('/status', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at'],
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    // Un abonnement échu doit tomber ici aussi, sinon l'écran affiche « premium »
    // à quelqu'un qui ne l'est plus.
    await maybeExpireSubscription(user);
    await user.reload({
      attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at'],
    });

    const active = isSubscriptionActive(user) && user.premium;
    const expiresAt = user.subscription_expires_at || null;
    const daysRemaining = active && expiresAt
      ? Math.max(0, Math.ceil((new Date(expiresAt) - new Date()) / 86400000))
      : 0;

    res.json({
      success: true,
      data: {
        is_premium: active,
        premium_expires_at: active ? expiresAt : null,
        days_remaining: daysRemaining,
        subscription_tier: active ? user.subscription_tier : TIER.FREE,
        duration_days: DEFAULT_DURATION_DAYS,
      },
    });
  } catch (error) {
    logger.error('❌ Erreur premium status:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// GET /api/premium/super-hearts — Solde de Super Cœurs (like arc-en-ciel, palier Pro)
router.get('/super-hearts', async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at', 'super_hearts_remaining', 'super_hearts_renew_at'],
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    await maybeExpireSubscription(user);
    await maybeRenewSuperHearts(user);

    res.json({
      success: true,
      data: {
        eligible: isSuperHeartEligible(user),
        remaining: user.super_hearts_remaining,
        cap: SUPER_HEART_CAPS[user.subscription_tier] || 0,
        renew_days: SUPER_HEART_RENEW_DAYS,
        renews_at: user.super_hearts_renew_at,
      },
    });
  } catch (error) {
    logger.error('❌ Erreur super-hearts status:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// GET /api/premium/plans — remplacé par la tarification NF
router.get('/plans', (req, res) => {
  res.status(410).json({
    success: false,
    message: 'Les plans mensuel et annuel n\'existent plus. Les paliers Plus et Pro sont vendus en NF pour une période fixe.',
    code: 'PREMIUM_LEGACY_ENDPOINT',
    data: REPLACEMENT_HINT,
  });
});

// POST /api/premium/subscribe — parcours d'achat supprimé
router.post('/subscribe', (req, res) => {
  logger.warn(`⛔ Achat premium legacy refusé pour ${req.user?.username || req.user?.id}`);
  res.status(410).json({
    success: false,
    message: 'Ce parcours d\'achat n\'est plus disponible. Mets à jour l\'application pour souscrire un abonnement Plus ou Pro.',
    code: 'PREMIUM_LEGACY_ENDPOINT',
    data: REPLACEMENT_HINT,
  });
});

// POST /api/premium/cancel — plus de reconduction à annuler
router.post('/cancel', (req, res) => {
  res.status(410).json({
    success: false,
    message: 'Il n\'y a plus rien à annuler : un abonnement est payé pour une période fixe et s\'arrête tout seul à son terme.',
    code: 'PREMIUM_LEGACY_ENDPOINT',
    data: REPLACEMENT_HINT,
  });
});

module.exports = router;
