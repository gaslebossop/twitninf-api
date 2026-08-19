const { VirtualCurrency, UserWallet, Transaction, User, sequelize } = require('../models');
const { validationResult } = require('express-validator');
const crypto = require('crypto');
const logger = require('../utils/logger');
const NewEconomyService = require('../services/newEconomyService');
const transactionAuthorizationService = require('../services/transactionAuthorizationService');

class VirtualCurrencyController {
  // Obtenir les informations d'une cryptomonnaie par symbole
  static async getCurrencyBySymbol(req, res) {
    try {
      const { symbol } = req.params;

      const currency = await VirtualCurrency.findOne({
        where: { symbol: symbol.toUpperCase() }
      });

      if (!currency) {
        return res.status(404).json({
          success: false,
          message: 'Cryptomonnaie non trouvée'
        });
      }

      res.json({
        success: true,
        data: currency,
        message: 'Cryptomonnaie récupérée avec succès'
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de la cryptomonnaie:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne'
      });
    }
  }

  // Obtenir les informations d'une cryptomonnaie
  static async getCurrency(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Données invalides',
          errors: errors.array() 
        });
      }

      const { symbol } = req.params;

      const currency = await VirtualCurrency.findOne({
        where: { symbol: symbol.toUpperCase() }
      });

      if (!currency) {
        return res.status(404).json({
          success: false,
          message: 'Cryptomonnaie non trouvée'
        });
      }

      // Calculer les statistiques en temps réel
      const totalWallets = await UserWallet.count({
        where: { currencyId: currency.id }
      });

      const totalBalance = await UserWallet.sum('balance', {
        where: { currencyId: currency.id }
      });

      const response = {
        success: true,
        data: {
          ...currency.toJSON(),
          stats: {
            totalWallets,
            totalBalance: totalBalance || 0,
            marketCap: (totalBalance || 0) * currency.currentPrice
          }
        }
      };

      logger.info(`📊 Informations de ${currency.symbol} récupérées par ${req.user.username}`);
      res.json(response);

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération de la cryptomonnaie:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne'
      });
    }
  }

  // Obtenir le portefeuille de l'utilisateur
  static async getUserWallet(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Données invalides',
          errors: errors.array() 
        });
      }

      const { currencyId } = req.params;
      const userId = req.user.id;

      // Vérifier que la cryptomonnaie existe
      const currency = await VirtualCurrency.findByPk(currencyId);
      if (!currency) {
        return res.status(404).json({
          success: false,
          message: 'Cryptomonnaie non trouvée'
        });
      }

      // Récupérer ou créer le portefeuille
      let wallet = await UserWallet.findOne({
        where: { userId, currencyId },
        include: [{
          model: VirtualCurrency,
          as: 'currency',
          attributes: ['name', 'symbol', 'currentPrice', 'icon', 'color']
        }]
      });

      if (!wallet) {
        // Créer automatiquement un portefeuille si il n'existe pas
        wallet = await UserWallet.create({
          userId,
          currencyId,
          balance: 0,
          totalEarned: 0,
          totalSpent: 0,
          dailyMiningCount: 0,
          isLocked: false
        });

        logger.info(`💰 Portefeuille créé automatiquement pour ${req.user.username} (${currency.symbol})`);
      }

      // Calculer la valeur en euros
      const valueInEur = wallet.balance * currency.currentPrice;

      const response = {
        success: true,
        data: {
          ...wallet.toJSON(),
          currency: currency.toJSON(),
          valueInEur: valueInEur.toFixed(2)
        }
      };

      logger.info(`💰 Portefeuille de ${req.user.username} récupéré (${wallet.balance} ${currency.symbol})`);
      res.json(response);

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération du portefeuille:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne'
      });
    }
  }

  // Miner de la cryptomonnaie
  static async mineCurrency(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Données invalides',
          errors: errors.array() 
        });
      }

      const { currencyId, action, amount } = req.body;
      const userId = req.user.id;

      // Vérifier que la cryptomonnaie existe et est active
      const currency = await VirtualCurrency.findByPk(currencyId);
      if (!currency || !currency.isActive) {
        return res.status(404).json({
          success: false,
          message: 'Cryptomonnaie non trouvée ou inactive'
        });
      }

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

      // Vérifier si le portefeuille est verrouillé
      if (wallet.isLocked) {
        return res.status(403).json({
          success: false,
          message: `Portefeuille verrouillé: ${wallet.lockReason}`
        });
      }

      // Vérifier les limites de minage quotidien
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (wallet.lastMiningDate && wallet.lastMiningDate >= today) {
        if (wallet.dailyMiningCount >= currency.maxMiningPerDay) {
          return res.status(429).json({
            success: false,
            message: `Limite de minage quotidien atteinte (${currency.maxMiningPerDay} actions/jour)`
          });
        }
      } else {
        // Nouveau jour, réinitialiser le compteur
        wallet.dailyMiningCount = 0;
      }

      // Calculer la récompense
      const baseReward = amount || currency.miningReward;
      const reward = Math.min(baseReward, currency.maxMiningPerDay - wallet.dailyMiningCount);

      if (reward <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Récompense invalide'
        });
      }

      // Créer la transaction de minage
      const transactionHash = crypto.randomBytes(32).toString('hex');
      
      const transaction = await Transaction.create({
        transactionHash,
        fromUserId: null, // Minage système
        toUserId: userId,
        currencyId,
        amount: reward,
        amountInEur: reward * currency.currentPrice,
        type: 'MINING',
        status: 'COMPLETED',
        fee: 0,
        description: `Minage: ${action}`,
        metadata: {
          action,
          miningReward: reward,
          baseReward: currency.miningReward
        },
        confirmedAt: new Date()
      });

      // Mettre à jour le portefeuille
      await wallet.update({
        balance: wallet.balance + reward,
        totalEarned: wallet.totalEarned + reward,
        lastMiningDate: new Date(),
        dailyMiningCount: wallet.dailyMiningCount + 1
      });

      // Mettre à jour les statistiques de la cryptomonnaie (incrément, pas de SUM sur tous les portefeuilles)
      await currency.increment('circulatingSupply', { by: reward });
      await currency.reload();
      await currency.update({ marketCap: currency.circulatingSupply * currency.currentPrice });

      const response = {
        success: true,
        data: {
          transaction: transaction.toJSON(),
          wallet: {
            balance: wallet.balance,
            totalEarned: wallet.totalEarned,
            dailyMiningCount: wallet.dailyMiningCount,
            dailyLimit: currency.maxMiningPerDay
          },
          reward,
          action
        }
      };

      logger.info(`⛏️ ${req.user.username} a miné ${reward} ${currency.symbol} (action: ${action})`);
      res.json(response);

    } catch (error) {
      logger.error('❌ Erreur lors du minage:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne'
      });
    }
  }

  // Transférer de la cryptomonnaie
  static async transferCurrency(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Données invalides',
          errors: errors.array() 
        });
      }

      const { toUserId, currencyId, amount, description } = req.body;
      const fromUserId = req.user.id;

      // Vérifier que la cryptomonnaie et le destinataire existent
      const [currency, toUser] = await Promise.all([
        VirtualCurrency.findByPk(currencyId),
        User.findByPk(toUserId)
      ]);
      if (!currency || !currency.isActive) {
        return res.status(404).json({
          success: false,
          message: 'Cryptomonnaie non trouvée ou inactive'
        });
      }

      if (!toUser) {
        return res.status(404).json({
          success: false,
          message: 'Destinataire non trouvé'
        });
      }

      // Empêcher les transferts vers soi-même
      if (fromUserId === toUserId) {
        return res.status(400).json({
          success: false,
          message: 'Impossible de transférer vers votre propre compte'
        });
      }

      const result = await NewEconomyService.transferCoins(
        fromUserId,
        toUserId,
        currencyId,
        Number(amount),
        description || `Transfert de ${amount} ${currency.symbol}`
      );

      const response = {
        success: true,
        data: {
          transaction: result.tx.toJSON(),
          amount,
          fee: result.fee,
          netAmount: result.netAmount
        }
      };

      logger.info(`💸 ${req.user.username} a transféré ${amount} ${currency.symbol} vers ${toUser.username}`);
      res.json(response);

    } catch (error) {
      logger.error('❌ Erreur lors du transfert:', error);
      const isRiskError = transactionAuthorizationService.constructor.isRiskError(error);
      res.status(isRiskError ? error.httpStatus : 500).json({
        success: false,
        message: isRiskError ? error.message : 'Erreur serveur interne',
        code: isRiskError ? error.code : undefined
      });
    }
  }

  // Obtenir l'historique des transactions
  static async getUserTransactions(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Données invalides',
          errors: errors.array() 
        });
      }

      const { currencyId, limit = 20, offset = 0 } = req.query;
      const userId = req.user.id;

      const whereClause = {
        [require('sequelize').Op.or]: [
          { fromUserId: userId },
          { toUserId: userId }
        ]
      };

      if (currencyId) {
        whereClause.currencyId = currencyId;
      }

      const transactions = await Transaction.findAll({
        where: whereClause,
        include: [
          {
            model: VirtualCurrency,
            as: 'currency',
            attributes: ['name', 'symbol', 'icon', 'color']
          },
          {
            model: User,
            as: 'fromUser',
            attributes: ['id', 'username', 'avatar']
          },
          {
            model: User,
            as: 'toUser',
            attributes: ['id', 'username', 'avatar']
          }
        ],
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      const total = await Transaction.count({ where: whereClause });

      const response = {
        success: true,
        data: {
          transactions: transactions.map(tx => ({
            ...tx.toJSON(),
            isIncoming: tx.toUserId === userId,
            isOutgoing: tx.fromUserId === userId
          })),
          pagination: {
            total,
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: total > parseInt(offset) + transactions.length
          }
        }
      };

      logger.info(`📜 Historique des transactions récupéré pour ${req.user.username}`);
      res.json(response);

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération de l\'historique:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne'
      });
    }
  }

  // Obtenir le classement des utilisateurs
  static async getLeaderboard(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Données invalides',
          errors: errors.array() 
        });
      }

      const { currencyId } = req.params;
      const { limit = 100 } = req.query;

      // Vérifier que la cryptomonnaie existe
      const currency = await VirtualCurrency.findByPk(currencyId);
      if (!currency) {
        return res.status(404).json({
          success: false,
          message: 'Cryptomonnaie non trouvée'
        });
      }

      const wallets = await UserWallet.findAll({
        where: { currencyId },
        include: [{
          model: User,
          as: 'user',
          attributes: ['id', 'username', 'avatar', 'verified', 'premium']
        }],
        order: [['balance', 'DESC']],
        limit: parseInt(limit)
      });

      const leaderboard = wallets.map((wallet, index) => ({
        rank: index + 1,
        user: wallet.user.toJSON(),
        balance: wallet.balance,
        totalEarned: wallet.totalEarned,
        totalSpent: wallet.totalSpent,
        valueInEur: wallet.balance * currency.currentPrice
      }));

      const response = {
        success: true,
        data: {
          currency: {
            name: currency.name,
            symbol: currency.symbol,
            currentPrice: currency.currentPrice,
            icon: currency.icon,
            color: currency.color
          },
          leaderboard,
          totalParticipants: leaderboard.length
        }
      };

      logger.info(`🏆 Classement ${currency.symbol} récupéré`);
      res.json(response);

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération du classement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne'
      });
    }
  }

  // Acheter de la cryptomonnaie (simulation)
  static async purchaseCurrency(req, res) {
    let dbTransaction = null;
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Données invalides',
          errors: errors.array() 
        });
      }

      const { currencyId, amountEur } = req.body;
      const userId = req.user.id;

      // Vérifier que la cryptomonnaie existe
      const currency = await VirtualCurrency.findByPk(currencyId);
      if (!currency || !currency.isActive) {
        return res.status(404).json({
          success: false,
          message: 'Cryptomonnaie non trouvée ou inactive'
        });
      }

      // Calculer le montant de cryptomonnaie à recevoir
      const amount = amountEur / currency.currentPrice;
      dbTransaction = await sequelize.transaction();

      // Récupérer le portefeuille
      let wallet = await UserWallet.findOne({
        where: { userId, currencyId },
        transaction: dbTransaction,
        lock: dbTransaction.LOCK.UPDATE
      });

      if (!wallet) {
        await dbTransaction.rollback();
        dbTransaction = null;
        return res.status(404).json({
          success: false,
          message: 'Portefeuille non trouvé'
        });
      }

      // Créer la transaction d'achat
      const transactionHash = crypto.randomBytes(32).toString('hex');
      const riskAuthorization = await transactionAuthorizationService.authorize({
        userId,
        transactionKind: 'wallet_topup',
        direction: 'inbound',
        amount,
        amountEur: Number(amountEur),
        currencyId,
        merchantId: 'twitninf_virtual_currency',
        itemType: 'virtual_currency',
        itemId: currencyId
      });
      
      const transaction = await Transaction.create({
        transactionHash,
        fromUserId: null, // Achat système
        toUserId: userId,
        currencyId,
        amount,
        amountInEur: amountEur,
        type: 'PURCHASE',
        status: 'COMPLETED',
        fee: 0,
        description: `Achat de ${amount.toFixed(8)} ${currency.symbol} pour ${amountEur}€`,
        metadata: {
          purchaseAmount: amountEur,
          exchangeRate: currency.currentPrice,
          ...transactionAuthorizationService.riskMetadata(riskAuthorization)
        },
        confirmedAt: new Date()
      }, { transaction: dbTransaction });
      await transactionAuthorizationService.consume(
        riskAuthorization,
        transaction.id,
        dbTransaction
      );

      // Mettre à jour le portefeuille
      await wallet.update({
        balance: wallet.balance + amount,
        totalEarned: wallet.totalEarned + amount
      }, { transaction: dbTransaction });

      // Mettre à jour les statistiques de la cryptomonnaie (incrément, pas de SUM sur tous les portefeuilles)
      await currency.increment('circulatingSupply', { by: amount, transaction: dbTransaction });
      await currency.reload({ transaction: dbTransaction });
      await currency.update(
        { marketCap: currency.circulatingSupply * currency.currentPrice },
        { transaction: dbTransaction }
      );
      await dbTransaction.commit();
      dbTransaction = null;

      const response = {
        success: true,
        data: {
          transaction: transaction.toJSON(),
          wallet: {
            balance: wallet.balance,
            totalEarned: wallet.totalEarned
          },
          purchase: {
            amountEur,
            amount,
            exchangeRate: currency.currentPrice
          }
        }
      };

      logger.info(`💳 ${req.user.username} a acheté ${amount.toFixed(8)} ${currency.symbol} pour ${amountEur}€`);
      res.json(response);

    } catch (error) {
      if (dbTransaction && !dbTransaction.finished) {
        await dbTransaction.rollback();
      }
      logger.error('❌ Erreur lors de l\'achat:', error);
      const isRiskError = transactionAuthorizationService.constructor.isRiskError(error);
      res.status(isRiskError ? error.httpStatus : 500).json({
        success: false,
        message: isRiskError ? error.message : 'Erreur serveur interne',
        code: isRiskError ? error.code : undefined
      });
    }
  }
}

module.exports = VirtualCurrencyController;
