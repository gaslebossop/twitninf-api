const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const { UserWallet, Transaction, VirtualCurrency, User } = require('../models');
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const NewEconomyService = require('../services/newEconomyService');

router.use(authenticateToken);

// GET /api/wallet — Récupérer le portefeuille de l'utilisateur
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const wallets = await UserWallet.findAll({
      where: { userId },
      include: [{ model: VirtualCurrency, as: 'currency', attributes: ['id', 'name', 'symbol', 'currentPrice'] }],
    });

    if (!wallets || wallets.length === 0) {
      return res.json({
        success: true,
        data: {
          wallets: [],
          total_value_eur: 0,
        },
      });
    }

    const total_value_eur = wallets.reduce((sum, w) => {
      return sum + (parseFloat(w.balance) * parseFloat(w.currency.currentPrice));
    }, 0);

    res.json({
      success: true,
      data: {
        wallets: wallets.map(w => ({
          id: w.id,
          balance: parseFloat(w.balance),
          total_earned: parseFloat(w.totalEarned),
          total_spent: parseFloat(w.totalSpent),
          currency: {
            id: w.currency.id,
            name: w.currency.name,
            symbol: w.currency.symbol,
            price_eur: parseFloat(w.currency.currentPrice),
            value_eur: (parseFloat(w.balance) * parseFloat(w.currency.currentPrice)).toFixed(2),
          },
          loyalty_points: w.loyaltyPoints,
          is_locked: w.isLocked,
          updated_at: w.updatedAt,
        })),
        total_value_eur: total_value_eur.toFixed(2),
      },
    });
  } catch (error) {
    logger.error('❌ Erreur wallet GET:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// GET /api/wallet/transactions — Historique des transactions
router.get('/transactions', async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, offset = 0, type = null } = req.query;

    // `sequelize.Op` n'existe pas en Sequelize v6 : cette route plantait
    // systématiquement (500) à chaque appel, `Op` étant undefined.
    const where = {
      [Op.or]: [
        { toUserId: userId },
        { fromUserId: userId },
      ],
    };

    if (type) {
      where.type = type;
    }

    const transactions = await Transaction.findAndCountAll({
      where,
      include: [
        { model: VirtualCurrency, attributes: ['id', 'name', 'symbol'] },
        { model: User, as: 'fromUser', attributes: ['id', 'username', 'avatar'] },
        { model: User, as: 'toUser', attributes: ['id', 'username', 'avatar'] },
      ],
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['createdAt', 'DESC']],
    });

    res.json({
      success: true,
      data: {
        transactions: transactions.rows.map(t => ({
          id: t.id,
          hash: t.transactionHash,
          type: t.type,
          amount: parseFloat(t.amount),
          amount_eur: parseFloat(t.amountInEur),
          currency: { id: t.currency.id, name: t.currency.name, symbol: t.currency.symbol },
          from: t.fromUser ? { id: t.fromUser.id, username: t.fromUser.username, avatar: t.fromUser.avatar } : null,
          to: t.toUser ? { id: t.toUser.id, username: t.toUser.username, avatar: t.toUser.avatar } : null,
          status: t.status,
          description: t.description,
          created_at: t.createdAt,
        })),
        pagination: {
          total: transactions.count,
          limit: parseInt(limit),
          offset: parseInt(offset),
        },
      },
    });
  } catch (error) {
    logger.error('❌ Erreur transactions GET:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// POST /api/wallet/transfer — Envoyer des fonds
router.post('/transfer', async (req, res) => {
  try {
    const { toUserId, amount, currencyId, description } = req.body;
    const fromUserId = req.user.id;

    if (!toUserId || !amount || !currencyId) {
      return res.status(400).json({ success: false, message: 'Données manquantes' });
    }

    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Montant invalide' });
    }

    const result = await NewEconomyService.transferCoins(
      fromUserId,
      toUserId,
      currencyId,
      parseFloat(amount),
      description || `Transfer from ${req.user.username}`
    );

    logger.info(`💸 Transfer: ${req.user.username} → ${toUserId} | ${amount} ${currencyId}`);

    res.json({
      success: true,
      message: 'Transfert effectué',
      data: {
        transaction: {
          id: result.tx.id,
          hash: result.tx.transactionHash,
          amount: parseFloat(amount),
          status: 'COMPLETED',
        },
        fee: result.fee,
        net_amount: result.netAmount,
      },
    });
  } catch (error) {
    logger.error('❌ Erreur transfer:', error);
    const riskService = require('../services/transactionAuthorizationService');
    const isRiskError = riskService.constructor.isRiskError(error);
    res.status(isRiskError ? error.httpStatus : 500).json({
      success: false,
      message: isRiskError ? error.message : 'Erreur serveur',
      code: isRiskError ? error.code : undefined,
    });
  }
});

// GET /api/wallet/balance/:currencyId — Solde d'une devise
router.get('/balance/:currencyId', async (req, res) => {
  try {
    const userId = req.user.id;
    const { currencyId } = req.params;

    const wallet = await UserWallet.findOne({
      where: { userId, currencyId },
      include: [{ model: VirtualCurrency, attributes: ['id', 'name', 'symbol', 'currentPrice'] }],
    });

    if (!wallet) {
      return res.status(404).json({ success: false, message: 'Portefeuille non trouvé' });
    }

    res.json({
      success: true,
      data: {
        balance: parseFloat(wallet.balance),
        total_earned: parseFloat(wallet.totalEarned),
        total_spent: parseFloat(wallet.totalSpent),
        currency: {
          id: wallet.currency.id,
          name: wallet.currency.name,
          symbol: wallet.currency.symbol,
          price_eur: parseFloat(wallet.currency.currentPrice),
        },
      },
    });
  } catch (error) {
    logger.error('❌ Erreur balance GET:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

module.exports = router;
