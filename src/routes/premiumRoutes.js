const express = require('express');
const router = express.Router();
const { User, UserWallet, Transaction, VirtualCurrency, sequelize } = require('../models');
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const crypto = require('crypto');
const transactionAuthorizationService = require('../services/transactionAuthorizationService');

router.use(authenticateToken);

const PREMIUM_PLANS = {
  monthly: { price_eur: 4.99, duration_days: 30, name: 'Premium Monthly' },
  yearly: { price_eur: 49.99, duration_days: 365, name: 'Premium Yearly' },
};

// GET /api/premium/status — Statut premium de l'utilisateur
router.get('/status', async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findByPk(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const isPremium = user.premium;
    const premiumExpiry = user.subscriptionExpiresAt;
    const daysRemaining = isPremium && premiumExpiry ? Math.ceil((new Date(premiumExpiry) - new Date()) / (1000 * 60 * 60 * 24)) : 0;

    res.json({
      success: true,
      data: {
        is_premium: isPremium,
        premium_expires_at: premiumExpiry,
        days_remaining: daysRemaining > 0 ? daysRemaining : 0,
        subscription_tier: user.subscriptionTier || 'free',
      },
    });
  } catch (error) {
    logger.error('❌ Erreur premium status:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// GET /api/premium/plans — Obtenir les plans disponibles
router.get('/plans', async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        plans: [
          {
            id: 'monthly',
            name: PREMIUM_PLANS.monthly.name,
            price_eur: PREMIUM_PLANS.monthly.price_eur,
            duration_days: PREMIUM_PLANS.monthly.duration_days,
            billing_period: '30 jours',
            features: [
              '✓ Feed personnalisé avancé',
              '✓ Badge premium visible',
              '✓ Monétisation des tweets',
              '✓ Retrait des revenus',
              '✓ Sans publicités',
            ],
          },
          {
            id: 'yearly',
            name: PREMIUM_PLANS.yearly.name,
            price_eur: PREMIUM_PLANS.yearly.price_eur,
            duration_days: PREMIUM_PLANS.yearly.duration_days,
            billing_period: '365 jours',
            features: [
              '✓ Feed personnalisé avancé',
              '✓ Badge premium visible',
              '✓ Monétisation des tweets',
              '✓ Retrait des revenus',
              '✓ Sans publicités',
              '✓ -17% vs mensuel',
            ],
          },
        ],
      },
    });
  } catch (error) {
    logger.error('❌ Erreur plans GET:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// POST /api/premium/subscribe — S'abonner au premium
router.post('/subscribe', async (req, res) => {
  let dbTransaction = null;
  try {
    const userId = req.user.id;
    const { plan_id, payment_method } = req.body;

    if (!plan_id || !PREMIUM_PLANS[plan_id]) {
      return res.status(400).json({ success: false, message: 'Plan invalide' });
    }

    const plan = PREMIUM_PLANS[plan_id];
    dbTransaction = await sequelize.transaction();
    const user = await User.findByPk(userId, {
      transaction: dbTransaction,
      // La décision antifraude est écrite depuis une transaction séparée avec
      // une FK vers users (KEY SHARE). NO KEY UPDATE protège toujours contre
      // deux souscriptions concurrentes sans provoquer de timeout circulaire.
      lock: dbTransaction.LOCK.NO_KEY_UPDATE,
    });

    if (!user) {
      await dbTransaction.rollback();
      dbTransaction = null;
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    // Vérifier si déjà premium et encore valide
    if (user.premium && user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > new Date()) {
      await dbTransaction.rollback();
      dbTransaction = null;
      return res.status(400).json({ success: false, message: 'Déjà abonné au premium' });
    }

    // Simuler le paiement Apple Pay
    logger.info(`🍎 Premium subscription: ${req.user.username} | Plan: ${plan_id}`);

    const transactionHash = crypto.randomBytes(32).toString('hex');
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + plan.duration_days);

    // Créer transaction
    const currency = await VirtualCurrency.findOne({
      where: { symbol: 'EUR' },
      transaction: dbTransaction,
    });
    if (!currency) {
      throw new Error('Portefeuille EUR indisponible');
    }
    let wallet = null;
    if (currency) {
      wallet = await UserWallet.findOne({
        where: { userId, currencyId: currency.id },
        transaction: dbTransaction,
      });
      if (!wallet) {
        wallet = await UserWallet.create({
          id: crypto.randomUUID(),
          userId,
          currencyId: currency.id,
          balance: 0,
        }, { transaction: dbTransaction });
      }
    }

    const riskAuthorization = await transactionAuthorizationService.authorize({
      userId,
      transactionKind: 'premium_subscription',
      direction: 'inbound',
      amount: plan.price_eur,
      amountEur: plan.price_eur,
      currencyId: currency.id,
      merchantId: 'twitninf_premium',
      paymentMethod: payment_method,
      itemType: 'premium',
      itemId: plan_id,
    });

    const transaction = await Transaction.create({
      transactionHash,
      toUserId: userId,
      currencyId: currency.id,
      amount: plan.price_eur,
      amountInEur: plan.price_eur,
      type: 'PURCHASE',
      status: 'COMPLETED',
      description: `Abonnement ${plan.name}`,
      metadata: {
        planId: plan_id,
        duration_days: plan.duration_days,
        purchaseType: 'PREMIUM_SUBSCRIPTION',
        paymentMethod: payment_method || null,
        ...transactionAuthorizationService.riskMetadata(riskAuthorization),
      },
      confirmedAt: new Date(),
    }, { transaction: dbTransaction });
    await transactionAuthorizationService.consume(
      riskAuthorization,
      transaction.id,
      dbTransaction
    );

    // Mettre à jour l'utilisateur
    await user.update({
      premium: true,
      subscriptionTier: 'premium',
      subscriptionExpiresAt: expiryDate,
    }, { transaction: dbTransaction });
    await dbTransaction.commit();
    dbTransaction = null;

    logger.info(`✅ Premium activated: ${req.user.username} expires ${expiryDate}`);

    res.json({
      success: true,
      message: 'Premium activé avec succès',
      data: {
        is_premium: true,
        plan: plan_id,
        price_eur: plan.price_eur,
        expires_at: expiryDate,
        transaction_id: transaction.id,
        transaction_hash: transaction.transactionHash,
      },
    });
  } catch (error) {
    if (dbTransaction && !dbTransaction.finished) {
      await dbTransaction.rollback();
    }
    logger.error('❌ Erreur subscribe:', error);
    const isRiskError = transactionAuthorizationService.constructor.isRiskError(error);
    res.status(isRiskError ? error.httpStatus : 500).json({
      success: false,
      message: isRiskError ? error.message : 'Erreur serveur',
      code: isRiskError ? error.code : undefined,
    });
  }
});

// POST /api/premium/cancel — Annuler l'abonnement
router.post('/cancel', async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findByPk(userId);

    if (!user || !user.premium) {
      return res.status(400).json({ success: false, message: 'Pas abonné au premium' });
    }

    await user.update({
      premium: false,
      subscriptionTier: 'free',
      subscriptionExpiresAt: null,
    });

    logger.info(`❌ Premium cancelled: ${req.user.username}`);

    res.json({
      success: true,
      message: 'Abonnement annulé',
    });
  } catch (error) {
    logger.error('❌ Erreur cancel:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

module.exports = router;
