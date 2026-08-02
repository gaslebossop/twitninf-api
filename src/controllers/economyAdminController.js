const { Transaction, UserWallet, User, VirtualCurrency } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../database/index');
const logger = require('../utils/logger');
const EconomyMetrics = require('../economy/metrics');
const EconomyLedger = require('../economy/ledger');
const { TREASURY_USER_ID, REFERENCE_PRICE_EUR } = require('../economy/constants');
const { toAmount } = require('../economy/money');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const FraudScanService = require('../services/fraudScanService');
const transactionAuthorizationService = require('../services/transactionAuthorizationService');

class EconomyAdminController {
  async fraudCases(req, res) {
    try {
      const cases = await transactionAuthorizationService.listRiskCases({
        state: req.query.state || null,
        limit: req.query.limit,
      });
      res.json({ success: true, cases });
    } catch (error) {
      const isRiskError = transactionAuthorizationService.constructor.isRiskError(error);
      logger.error('Erreur fraudCases Admin:', error);
      res.status(isRiskError ? error.httpStatus : 500).json({
        success: false,
        message: error.message,
        code: isRiskError ? error.code : undefined,
      });
    }
  }

  async fraudScan(req, res) {
    try {
      const lookbackDays = Math.max(1, Math.min(90, parseInt(req.query.lookbackDays, 10) || 14));
      const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
      const result = await FraudScanService.scan({ lookbackDays, limit });
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Erreur fraudScan Admin:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async fraudTrace(req, res) {
    try {
      const { userId } = req.params;
      const lookbackDays = Math.max(1, Math.min(90, parseInt(req.query.lookbackDays, 10) || 30));
      const maxHops = Math.max(1, Math.min(6, parseInt(req.query.maxHops, 10) || 4));
      const result = await FraudScanService.traceFlow({ userId, lookbackDays, maxHops });
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Erreur fraudTrace Admin:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * Retrait anti-fraude — `items` porte le MONTANT et la MONNAIE exacts à
   * retirer par compte, fournis par le scan (`FlaggedUser.fraudByCurrency`,
   * éventuellement ajusté par l'admin dans l'UI) : on ne vide plus tout le
   * portefeuille d'un coup, et on ne se limite plus à une seule monnaie
   * (`getPlatformCurrency()`) — un compte peut être retiré simultanément sur
   * le NF et sur une ou plusieurs monnaies communautaires.
   */
  async fraudBurn(req, res) {
    const { items, reason } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'items requis (userId, currencyId, amount par compte)' });
    }
    for (const item of items) {
      if (!item?.userId || !item?.currencyId || !(Number(item.amount) > 0)) {
        return res.status(400).json({ success: false, message: 'Chaque item requiert userId, currencyId et un amount > 0' });
      }
    }

    const dbTransaction = await sequelize.transaction();

    try {
      const results = [];
      const touchedCurrencyIds = new Set();
      for (const item of items) {
        const { tx, amount } = await EconomyLedger.burnFraudulent(item.userId, item.currencyId, Number(item.amount), reason, dbTransaction);
        results.push({ userId: item.userId, currencyId: item.currencyId, requested: Number(item.amount), burned: amount, transactionId: tx?.id || null });
        touchedCurrencyIds.add(item.currencyId);
      }

      await Promise.all([...touchedCurrencyIds].map((id) => EconomyMetrics.refresh(id, dbTransaction)));
      await dbTransaction.commit();

      const totalsByCurrency = {};
      for (const r of results) {
        totalsByCurrency[r.currencyId] = (totalsByCurrency[r.currencyId] || 0) + r.burned;
      }
      logger.warn(`ADMIN: retrait anti-fraude sur ${results.length} entrée(s) (${touchedCurrencyIds.size} monnaie(s)) — ${reason || 'sans motif précisé'} — ${JSON.stringify(totalsByCurrency)}`);

      res.json({ success: true, results, totalsByCurrency });
    } catch (error) {
      await dbTransaction.rollback();
      logger.error('Erreur fraudBurn Admin:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getGlobalStats(req, res) {
    try {
      const currency = await getPlatformCurrency();
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

      const currency = await getPlatformCurrency();
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
      const currency = await getPlatformCurrency();
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

      const currency = await getPlatformCurrency();
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
      const currency = await getPlatformCurrency({ transaction: dbTransaction });
      if (!currency) throw new Error('Monnaie TWC non trouvée');

      const { wallet, diff } = await EconomyLedger.adminAdjustBalance(
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
      const currency = await getPlatformCurrency({ transaction: dbTransaction });
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
      const currency = await getPlatformCurrency();
      if (!currency) throw new Error('Monnaie TWC non trouvée');

      const wallet = await UserWallet.findOne({ where: { userId, currencyId: currency.id } });
      if (!wallet) {
        return res.status(404).json({ success: false, message: 'Portefeuille TWC non trouvé' });
      }

      const result = await transactionAuthorizationService.setManualWalletState({
        userId,
        frozen: !!isLocked,
        reason: reason || 'Verrouillé par le Gardien',
        reviewerUserId: req.user?.id || null
      });

      res.json({
        success: true,
        isLocked: result.frozen,
        affectedWallets: result.affectedWallets,
        message: result.frozen ? 'Portefeuille gelé' : 'Portefeuille dégelé'
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
