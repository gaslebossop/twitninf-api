const { Transaction, UserWallet, User, VirtualCurrency } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../database/index');
const logger = require('../utils/logger');
const EconomyMetrics = require('../economy/metrics');
const EconomyLedger = require('../economy/ledger');
const { TREASURY_USER_ID, REFERENCE_PRICE_EUR } = require('../economy/constants');
const { toAmount } = require('../economy/money');

class EconomyAdminController {
  async getGlobalStats(req, res) {
    try {
      const currency = await VirtualCurrency.findOne({ where: { symbol: 'TWC' } });
      if (!currency) {
        return res.status(404).json({ success: false, message: 'Monnaie TWC non trouvée' });
      }

      const metrics = await EconomyMetrics.refresh(currency.id);
      const treasuryWallet = await UserWallet.findOne({
        where: { userId: TREASURY_USER_ID, currencyId: currency.id }
      });

      res.json({
        success: true,
        stats: {
          circulatingSupply: metrics.circulatingSupply,
          userHeldSupply: metrics.userHeldSupply,
          systemReserve: metrics.treasuryReserve,
          treasuryWalletBalance: parseFloat(treasuryWallet?.balance || 0),
          currencyPrice: REFERENCE_PRICE_EUR,
          multiplier: 1.0,
          volume24hEur: metrics.volume24hEur,
          purchaseCount24h: metrics.purchaseCount24h
        }
      });
    } catch (error) {
      logger.error('Erreur getGlobalStats Admin:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getTransactions(req, res) {
    try {
      const { page = 1, limit = 50, type, status } = req.query;
      const offset = (page - 1) * limit;

      const where = {};
      if (type && type !== 'ALL') where.type = type;
      if (status) where.status = status;

      const transactions = await Transaction.findAndCountAll({
        where,
        limit: parseInt(limit, 10),
        offset,
        order: [['createdAt', 'DESC']],
        include: [
          { model: User, as: 'fromUser', attributes: ['id', 'username', 'avatar'] },
          { model: User, as: 'toUser', attributes: ['id', 'username', 'avatar'] }
        ]
      });

      const currency = await VirtualCurrency.findOne({ where: { symbol: 'TWC' } });
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const volume24h = await Transaction.sum('amount', {
        where: {
          currencyId: currency?.id,
          createdAt: { [Op.gte]: last24h },
          status: 'COMPLETED'
        }
      });

      const count24h = await Transaction.count({
        where: {
          currencyId: currency?.id,
          createdAt: { [Op.gte]: last24h }
        }
      });

      res.json({
        success: true,
        data: transactions.rows,
        stats24h: {
          volume: parseFloat(volume24h || 0),
          count: count24h
        },
        pagination: {
          total: transactions.count,
          page: parseInt(page, 10),
          pages: Math.ceil(transactions.count / limit)
        }
      });
    } catch (error) {
      logger.error('Erreur getTransactions Admin:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getRichList(req, res) {
    try {
      const { limit = 20 } = req.query;
      const currency = await VirtualCurrency.findOne({ where: { symbol: 'TWC' } });
      if (!currency) {
        return res.status(404).json({ success: false, message: 'Monnaie TWC non trouvée' });
      }

      const wallets = await UserWallet.findAll({
        where: {
          currencyId: currency.id,
          userId: { [Op.ne]: TREASURY_USER_ID },
          balance: { [Op.gt]: 0 }
        },
        limit: parseInt(limit, 10),
        order: [['balance', 'DESC']],
        include: [{ model: User, as: 'user', attributes: ['id', 'username', 'avatar', 'verified'] }]
      });

      res.json({
        success: true,
        data: wallets.map((w) => ({
          userId: w.userId,
          username: w.user?.username,
          avatar: w.user?.avatar,
          balance: parseFloat(w.balance),
          isVerified: w.user?.verified
        }))
      });
    } catch (error) {
      logger.error('Erreur getRichList Admin:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async searchWallets(req, res) {
    try {
      const { query } = req.query;
      if (!query) return res.status(400).json({ success: false, message: 'Requête vide' });

      const currency = await VirtualCurrency.findOne({ where: { symbol: 'TWC' } });
      if (!currency) {
        return res.status(404).json({ success: false, message: 'Monnaie TWC non trouvée' });
      }

      const users = await User.findAll({
        where: {
          [Op.or]: [
            { username: { [Op.iLike]: `%${query}%` } },
            { full_name: { [Op.iLike]: `%${query}%` } }
          ]
        },
        limit: 10,
        attributes: ['id', 'username', 'avatar', 'full_name'],
        include: [
          {
            model: UserWallet,
            as: 'wallets',
            where: { currencyId: currency.id },
            required: false
          }
        ]
      });

      const results = users.map((u) => {
        const twcWallet = u.wallets?.length > 0 ? u.wallets[0] : null;
        return {
          id: u.id,
          username: u.username,
          avatar: u.avatar,
          full_name: u.full_name,
          balance: twcWallet ? parseFloat(twcWallet.balance) : 0,
          walletId: twcWallet?.id,
          isLocked: twcWallet?.isLocked || false
        };
      });

      res.json({ success: true, data: results });
    } catch (error) {
      logger.error('Erreur searchWallets Admin:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async updateWalletBalance(req, res) {
    const { userId, amount, reason } = req.body;
    const dbTransaction = await sequelize.transaction();

    try {
      const currency = await VirtualCurrency.findOne({ where: { symbol: 'TWC' }, transaction: dbTransaction });
      if (!currency) throw new Error('Monnaie TWC non trouvée');

      const { wallet, diff } = await EconomyLedger.adminSetBalance(
        userId,
        currency.id,
        amount,
        reason,
        dbTransaction
      );

      await EconomyMetrics.refresh(currency.id, dbTransaction);
      logger.warn(`ADMIN: solde ${userId} ajusté (Δ ${diff}) — ${reason}`);

      await dbTransaction.commit();
      res.json({ success: true, newBalance: parseFloat(wallet.balance) });
    } catch (error) {
      await dbTransaction.rollback();
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async manualTransfer(req, res) {
    const { fromUserId, toUserId, amount, description } = req.body;
    const transferAmount = parseFloat(amount || 0);

    if (transferAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Le montant doit être supérieur à 0' });
    }

    const dbTransaction = await sequelize.transaction();

    try {
      const currency = await VirtualCurrency.findOne({ where: { symbol: 'TWC' }, transaction: dbTransaction });
      if (!currency) throw new Error('Monnaie TWC non trouvée');

      let tx;
      if (!fromUserId) {
        const result = await EconomyLedger.adminCredit(
          toUserId,
          currency.id,
          transferAmount,
          description || 'Transfert admin (mint)',
          dbTransaction
        );
        tx = result.tx;
      } else if (!toUserId || toUserId === TREASURY_USER_ID) {
        const fromWallet = await EconomyLedger.lockWallet(fromUserId, currency.id, dbTransaction);
        if (toAmount(fromWallet.balance) < transferAmount) {
          throw new Error('Solde expéditeur insuffisant');
        }
        const result = await EconomyLedger.spendToTreasury(
          fromUserId,
          currency.id,
          transferAmount,
          { description: `[ADMIN] ${description}`, itemType: 'admin', itemId: null, spendingCategory: 'Admin' },
          dbTransaction
        );
        tx = result.tx;
      } else {
        const result = await EconomyLedger.transferP2P(
          fromUserId,
          toUserId,
          currency.id,
          transferAmount,
          `[ADMIN] ${description || 'Transfert'}`,
          dbTransaction
        );
        tx = result.tx;
      }

      await EconomyMetrics.refresh(currency.id, dbTransaction);
      await dbTransaction.commit();
      res.json({ success: true, transaction: tx });
    } catch (error) {
      await dbTransaction.rollback();
      logger.error('Erreur manualTransfer:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async toggleWalletLock(req, res) {
    const { userId, isLocked, reason } = req.body;

    try {
      const currency = await VirtualCurrency.findOne({ where: { symbol: 'TWC' } });
      if (!currency) throw new Error('Monnaie TWC non trouvée');

      const wallet = await UserWallet.findOne({ where: { userId, currencyId: currency.id } });
      if (!wallet) {
        return res.status(404).json({ success: false, message: 'Portefeuille TWC non trouvé' });
      }

      await wallet.update({
        isLocked: !!isLocked,
        lockReason: isLocked ? reason || 'Verrouillé par le Gardien' : null
      });

      res.json({
        success: true,
        isLocked: wallet.isLocked,
        message: wallet.isLocked ? 'Portefeuille gelé' : 'Portefeuille dégelé'
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async deleteTransaction(req, res) {
    const { id } = req.params;
    const { refund = false } = req.body;
    const dbTransaction = await sequelize.transaction();

    try {
      const tx = await Transaction.findByPk(id, { transaction: dbTransaction });
      if (!tx) throw new Error('Transaction non trouvée');

      if (refund && tx.status === 'COMPLETED') {
        const currency = await VirtualCurrency.findByPk(tx.currencyId, { transaction: dbTransaction });
        if (tx.fromUserId && tx.toUserId) {
          await EconomyLedger.transferP2P(
            tx.toUserId,
            tx.fromUserId,
            tx.currencyId,
            tx.amount,
            `[Remboursement admin] ${tx.description}`,
            dbTransaction
          );
        } else if (!tx.fromUserId && tx.toUserId) {
          await EconomyLedger.spendToTreasury(
            tx.toUserId,
            tx.currencyId,
            tx.amount,
            { description: 'Annulation mint admin', itemType: 'admin', itemId: id },
            dbTransaction
          );
        }
        if (currency) await EconomyMetrics.refresh(currency.id, dbTransaction);
      }

      await tx.destroy({ transaction: dbTransaction });
      await dbTransaction.commit();
      res.json({ success: true, message: 'Transaction supprimée' });
    } catch (error) {
      await dbTransaction.rollback();
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new EconomyAdminController();
