const express = require('express');
const router = express.Router();
const { UserWallet, Transaction, VirtualCurrency, User, sequelize } = require('../models');
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const crypto = require('crypto');

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

    const where = {
      [sequelize.Op.or]: [
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

    // Vérifier le portefeuille source
    const fromWallet = await UserWallet.findOne({
      where: { userId: fromUserId, currencyId },
    });

    if (!fromWallet || parseFloat(fromWallet.balance) < parseFloat(amount)) {
      return res.status(400).json({ success: false, message: 'Solde insuffisant' });
    }

    // Vérifier le portefeuille destinataire
    let toWallet = await UserWallet.findOne({
      where: { userId: toUserId, currencyId },
    });

    if (!toWallet) {
      return res.status(404).json({ success: false, message: 'Portefeuille destinataire non trouvé' });
    }

    const transactionHash = crypto.randomBytes(32).toString('hex');

    // Créer la transaction
    const transaction = await Transaction.create({
      transactionHash,
      fromUserId,
      toUserId,
      currencyId,
      amount: parseFloat(amount),
      type: 'TRANSFER',
      status: 'COMPLETED',
      description: description || `Transfer from ${req.user.username}`,
      confirmedAt: new Date(),
    });

    // Mettre à jour les portefeuilles
    await fromWallet.update({
      balance: (parseFloat(fromWallet.balance) - parseFloat(amount)).toFixed(8),
      totalSpent: (parseFloat(fromWallet.totalSpent) + parseFloat(amount)).toFixed(8),
    });

    await toWallet.update({
      balance: (parseFloat(toWallet.balance) + parseFloat(amount)).toFixed(8),
      totalEarned: (parseFloat(toWallet.totalEarned) + parseFloat(amount)).toFixed(8),
    });

    logger.info(`💸 Transfer: ${req.user.username} → ${toUserId} | ${amount} ${currencyId}`);

    res.json({
      success: true,
      message: 'Transfert effectué',
      data: {
        transaction: {
          id: transaction.id,
          hash: transaction.transactionHash,
          amount: parseFloat(amount),
          status: 'COMPLETED',
        },
        from_balance: parseFloat(fromWallet.balance),
        to_balance: parseFloat(toWallet.balance),
      },
    });
  } catch (error) {
    logger.error('❌ Erreur transfer:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
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
