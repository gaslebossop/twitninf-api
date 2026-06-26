const express = require('express');
const { body, validationResult } = require('express-validator');
const { VirtualCurrency, UserWallet, Transaction } = require('../models');
const crypto = require('crypto');
const logger = require('../utils/logger');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// Appliquer le middleware d'authentification à toutes les routes
router.use(authMiddleware.authenticateToken);

// Route pour simuler un paiement Apple Pay
router.post('/apple-pay', [
  body('amount').isFloat({ min: 0.01, max: 1000 }).withMessage('Montant invalide (0.01€ - 1000€)'),
  body('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  body('paymentMethod').isString().notEmpty().withMessage('Méthode de paiement requise'),
  body('deviceToken').optional().isString().withMessage('Token de dispositif invalide')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Données invalides',
        errors: errors.array() 
      });
    }

    const { amount, currencyId, paymentMethod, deviceToken } = req.body;
    const userId = req.user.id;

    // Vérifier que la cryptomonnaie existe
    const currency = await VirtualCurrency.findByPk(currencyId);
    if (!currency || !currency.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Cryptomonnaie non trouvée ou inactive'
      });
    }

    // Simuler le traitement du paiement Apple Pay
    logger.info(`🍎 Simulation paiement Apple Pay: ${amount}€ pour ${req.user.username}`);

    // Simuler un délai de traitement
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Calculer le montant de cryptomonnaie à recevoir
    const ninfiAmount = parseFloat(amount) / parseFloat(currency.currentPrice);

    // Récupérer le portefeuille
    let wallet = await UserWallet.findOne({
      where: { userId, currencyId }
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: 'Portefeuille non trouvé'
      });
    }

    // Générer un ID de transaction Apple Pay factice
    const applePayTransactionId = `AP_${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
    const transactionHash = crypto.randomBytes(32).toString('hex');

    // Créer la transaction d'achat
    const transaction = await Transaction.create({
      transactionHash,
      fromUserId: null, // Achat système
      toUserId: userId,
      currencyId,
      amount: ninfiAmount,
      amountInEur: amount,
      type: 'PURCHASE',
      status: 'COMPLETED',
      fee: 0,
      description: `Achat Apple Pay: ${ninfiAmount.toFixed(8)} ${currency.symbol} pour ${amount}€`,
      metadata: {
        paymentMethod: 'APPLE_PAY',
        applePayTransactionId,
        deviceToken,
        purchaseAmount: amount,
        exchangeRate: currency.currentPrice,
        processingTime: '2.1s'
      },
      confirmedAt: new Date()
    });

    // Mettre à jour le portefeuille
    const newBalance = parseFloat(wallet.balance) + ninfiAmount;
    const newTotalEarned = parseFloat(wallet.totalEarned) + ninfiAmount;
    
    await wallet.update({
      balance: newBalance.toFixed(8),
      totalEarned: newTotalEarned.toFixed(8)
    });

    // Mettre à jour les statistiques de la cryptomonnaie
    const totalBalance = await UserWallet.sum('balance', {
      where: { currencyId }
    });

    await currency.update({
      circulatingSupply: totalBalance || 0,
      marketCap: (totalBalance || 0) * currency.currentPrice
    });

    const response = {
      success: true,
      message: 'Paiement Apple Pay traité avec succès',
      data: {
        transaction: {
          id: transaction.id,
          hash: transaction.transactionHash,
          applePayTransactionId,
          amount: ninfiAmount,
          amountEur: amount,
          status: 'COMPLETED',
          timestamp: transaction.confirmedAt
        },
                 wallet: {
           balance: newBalance.toFixed(8),
           totalEarned: newTotalEarned.toFixed(8)
         },
        purchase: {
          amountEur: amount,
          amount: ninfiAmount,
          exchangeRate: currency.currentPrice,
          currency: currency.symbol
        },
        applePay: {
          transactionId: applePayTransactionId,
          status: 'APPROVED',
          processingTime: '2.1s',
          deviceToken: deviceToken || null
        }
      }
    };

    logger.info(`✅ Paiement Apple Pay réussi: ${amount}€ → ${ninfiAmount.toFixed(8)} ${currency.symbol}`);
    res.json(response);

  } catch (error) {
    logger.error('❌ Erreur lors du paiement Apple Pay:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du traitement du paiement'
    });
  }
});

// Route pour obtenir les options de paiement disponibles
router.get('/payment-methods', async (req, res) => {
  try {
    const paymentMethods = [
      {
        id: 'apple_pay',
        name: 'Apple Pay',
        type: 'DIGITAL_WALLET',
        icon: '🍎',
        description: 'Paiement sécurisé avec Apple Pay',
        supported: true,
        processingTime: '2-3 secondes',
        fees: '0%',
        limits: {
          min: 0.01,
          max: 1000,
          currency: 'EUR'
        }
      },
      {
        id: 'google_pay',
        name: 'Google Pay',
        type: 'DIGITAL_WALLET',
        icon: '🤖',
        description: 'Paiement sécurisé avec Google Pay',
        supported: false,
        processingTime: '2-3 secondes',
        fees: '0%',
        limits: {
          min: 0.01,
          max: 1000,
          currency: 'EUR'
        }
      },
      {
        id: 'card',
        name: 'Carte bancaire',
        type: 'CREDIT_CARD',
        icon: '💳',
        description: 'Visa, Mastercard, American Express',
        supported: false,
        processingTime: '5-10 secondes',
        fees: '2.9%',
        limits: {
          min: 0.01,
          max: 5000,
          currency: 'EUR'
        }
      }
    ];

    res.json({
      success: true,
      data: {
        paymentMethods,
        defaultMethod: 'apple_pay',
        supportedCurrencies: ['EUR', 'USD'],
        processingFees: {
          apple_pay: 0,
          google_pay: 0,
          card: 0.029
        }
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des méthodes de paiement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur interne'
    });
  }
});

// Route pour vérifier la disponibilité d'Apple Pay
router.post('/apple-pay/check', async (req, res) => {
  try {
    const { domain, validationURL } = req.body;

    // Simuler la vérification Apple Pay
    const isAvailable = true; // Toujours disponible en mode factice
    const canMakePayments = true;
    const supportedNetworks = ['visa', 'masterCard', 'amex'];
    const supportedCountries = ['FR', 'US', 'CA', 'GB', 'DE'];

    res.json({
      success: true,
      data: {
        isAvailable,
        canMakePayments,
        supportedNetworks,
        supportedCountries,
        merchantCapabilities: ['supports3DS', 'supportsCredit', 'supportsDebit'],
        domain: domain || 'twitnin.com',
        validationURL: validationURL || 'https://twitnin.com/apple-pay-validation'
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la vérification Apple Pay:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification'
    });
  }
});

module.exports = router;
