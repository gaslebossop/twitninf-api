const NewEconomyService = require('../services/newEconomyService');
const { validationResult } = require('express-validator');
const logger = require('../utils/logger');

/**
 * Contrôleur pour le nouveau système économique TwitCoins
 */
class NewEconomyController {

  /**
   * Obtenir les packages d'achat disponibles
   */
  static async getPurchasePackages(req, res) {
    try {
      const { currencyId } = req.params;

      const packages = await NewEconomyService.getPurchasePackages(currencyId);

      res.json({
        success: true,
        data: packages,
        message: 'Packages récupérés avec succès'
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des packages:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * Acheter des TwitCoins
   */
  static async purchaseCoins(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { currencyId, packageId, paymentMethod } = req.body;
      const userId = req.user.id;

      const result = await NewEconomyService.purchaseCoins(
        userId,
        currencyId,
        packageId,
        paymentMethod
      );

      res.json({
        success: true,
        data: {
          transaction: {
            id: result.transaction.id,
            hash: result.transaction.transactionHash,
            amount: result.transaction.amount,
            price: result.transaction.amountInEur,
            package: result.package
          },
          wallet: {
            balance: result.wallet.balance,
            totalPurchased: result.wallet.totalPurchased,
            loyaltyPoints: result.wallet.loyaltyPoints
          }
        },
        message: 'Achat effectué avec succès'
      });
    } catch (error) {
      logger.error('Erreur lors de l\'achat:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Erreur serveur interne'
      });
    }
  }

  /**
   * Dépenser des TwitCoins
   */
  static async spendCoins(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { currencyId, amount, itemType, itemId, description } = req.body;
      const userId = req.user.id;

      const result = await NewEconomyService.spendCoins(
        userId,
        currencyId,
        amount,
        itemType,
        itemId,
        description
      );

      res.json({
        success: true,
        data: {
          transaction: {
            id: result.transaction.id,
            hash: result.transaction.transactionHash,
            amount: result.transaction.amount,
            description: result.transaction.description
          },
          remainingBalance: result.remainingBalance
        },
        message: 'Dépense effectuée avec succès'
      });
    } catch (error) {
      logger.error('Erreur lors de la dépense:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Erreur serveur interne'
      });
    }
  }

  /**
   * Obtenir les statistiques économiques
   */
  static async getEconomicStats(req, res) {
    try {
      const { currencyId } = req.params;

      const stats = await NewEconomyService.getEconomicStats(currencyId);

      res.json({
        success: true,
        data: stats,
        message: 'Statistiques récupérées avec succès'
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * Obtenir le classement des acheteurs
   */
  static async getPurchaseLeaderboard(req, res) {
    try {
      const { currencyId } = req.params;
      const limit = parseInt(req.query.limit) || 50;

      const leaderboard = await NewEconomyService.getPurchaseLeaderboard(currencyId, limit);

      res.json({
        success: true,
        data: {
          leaderboard,
          total: leaderboard.length
        },
        message: 'Classement récupéré avec succès'
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération du classement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * Obtenir le portefeuille utilisateur
   */
  static async getUserWallet(req, res) {
    try {
      const { currencyId } = req.params;
      const userId = req.user.id;
      const NewEconomyService = require('../services/newEconomyService');
      const { User } = require('../models');

      const user = await User.findByPk(userId, { attributes: ['username', 'email'] });
      if (!user) {
        return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
      }

      await NewEconomyService.ensureWalletsForUser(userId, null);
      const result = await NewEconomyService.getUserWallet(currencyId, userId, null);

      res.json({
        success: true,
        data: {
          wallet: {
            id: result.wallet.id,
            balance: result.wallet.balance,
            totalEarned: result.wallet.totalEarned,
            totalPurchased: result.wallet.totalPurchased,
            totalSpent: result.wallet.totalSpent,
            loyaltyPoints: result.wallet.loyaltyPoints,
            lastPurchaseDate: result.wallet.lastPurchaseDate
          },
          currency: {
            symbol: result.currency.symbol,
            name: result.currency.name,
            currentPrice: result.currency.currentPrice,
            basePrice: result.currency.basePrice,
            economicTrend: result.currency.trend || 'stable'
          },
          user: {
            username: user.username,
            email: user.email
          }
        },
        message: 'Portefeuille récupéré avec succès'
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération du portefeuille:', error);
      res.status(500).json({
        success: false,
        message: error.message && String(error.message).includes('Cryptomonnaie')
          ? error.message
          : 'Erreur serveur interne',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * Obtenir l'historique des transactions
   */
  static async getTransactionHistory(req, res) {
    try {
      const { currencyId } = req.params;
      const userId = req.user.id;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const offset = (page - 1) * limit;

      const { Transaction, VirtualCurrency } = require('../models');
      const { Op } = require('sequelize');

      const transactions = await Transaction.findAndCountAll({
        where: {
          currencyId,
          [Op.or]: [
            { fromUserId: userId },
            { toUserId: userId }
          ]
        },
        include: [
          {
            model: VirtualCurrency,
            attributes: ['symbol', 'name']
          }
        ],
        order: [['createdAt', 'DESC']],
        limit,
        offset
      });

      const formattedTransactions = transactions.rows.map(tx => ({
        id: tx.id,
        hash: tx.transactionHash,
        type: tx.type,
        amount: parseFloat(tx.amount),
        amountInEur: parseFloat(tx.amountInEur),
        description: tx.description,
        status: tx.status,
        metadata: tx.metadata,
        createdAt: tx.createdAt,
        confirmedAt: tx.confirmedAt,
        currency: tx.VirtualCurrency
      }));

      res.json({
        success: true,
        data: {
          transactions: formattedTransactions,
          pagination: {
            page,
            limit,
            total: transactions.count,
            pages: Math.ceil(transactions.count / limit)
          }
        },
        message: 'Historique récupéré avec succès'
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'historique:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
}

module.exports = NewEconomyController;
