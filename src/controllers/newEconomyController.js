const NewEconomyService = require('../services/newEconomyService');
const { validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const { getOrCreateEurCurrency } = require('../economy/eurCurrency');
const { roundTWC } = require('../economy/money');

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
   * Portefeuilles de l'utilisateur pour toutes les monnaies actives (NF + EUR interne).
   */
  static async getAllWallets(req, res) {
    try {
      const userId = req.user.id;
      await NewEconomyService.ensureWalletsForUser(userId, null);
      const results = await NewEconomyService.getAllWallets(userId);

      res.json({
        success: true,
        data: results.map((result) => ({
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
            id: result.currency.id,
            symbol: result.currency.symbol,
            name: result.currency.name,
            currentPrice: result.currency.currentPrice,
            basePrice: result.currency.basePrice,
            economicTrend: result.currency.trend || 'stable'
          }
        }))
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des portefeuilles:', error);
      res.status(500).json({ success: false, message: 'Erreur serveur interne' });
    }
  }

  /**
   * Échanger entre le portefeuille NF et un portefeuille EUR interne (parité fixe 1:1),
   * au taux réel courant du NF — jamais un taux figé.
   */
  static async exchangeCurrency(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
      }

      const { direction, amount } = req.body;
      const userId = req.user.id;

      const nfCurrency = await getPlatformCurrency({ fresh: true });
      if (!nfCurrency || !(Number(nfCurrency.currentPrice) > 0)) {
        return res.status(503).json({ success: false, message: 'Taux de change indisponible' });
      }
      const eurCurrency = await getOrCreateEurCurrency();
      const nfPrice = Number(nfCurrency.currentPrice); // EUR par NF

      const fromCurrencyId = direction === 'EUR_TO_NF' ? eurCurrency.id : nfCurrency.id;
      const toCurrencyId = direction === 'EUR_TO_NF' ? nfCurrency.id : eurCurrency.id;
      // Ne PAS arrondir le taux lui-même avant de multiplier : arrondir 1/8.5
      // à 2 décimales (0.12) puis multiplier par 85 donne 10.2 au lieu de
      // 10.0 — l'arrondi ne doit porter que sur le résultat final (fait dans
      // EconomyLedger.exchangeCurrency), jamais sur le taux intermédiaire.
      const rate = direction === 'EUR_TO_NF' ? 1 / nfPrice : nfPrice;

      const result = await NewEconomyService.exchangeCurrency(userId, fromCurrencyId, toCurrencyId, amount, rate);

      res.json({
        success: true,
        data: {
          direction,
          debited: result.debited,
          credited: result.credited,
          fromBalance: result.fromBalance,
          toBalance: result.toBalance,
          rate,
          nfPriceEur: nfPrice
        },
        message: `Échangé ${result.debited} ${direction === 'EUR_TO_NF' ? '€' : 'NF'} contre ${result.credited} ${direction === 'EUR_TO_NF' ? 'NF' : '€'}`
      });
    } catch (error) {
      logger.error('Erreur lors de l\'échange NF/EUR:', error);
      const message = error instanceof Error && /Solde insuffisant|Devises identiques|Taux de change invalide/.test(error.message)
        ? error.message
        : 'Erreur serveur interne';
      res.status(error.message && /Solde insuffisant|Devises identiques|Taux de change invalide/.test(error.message) ? 400 : 500).json({
        success: false,
        message
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
            as: 'currency',
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
        currency: tx.currency
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

  /**
   * Obtenir (ou créer) le round de minage ouvert (app Windows)
   */
  static async getMiningRound(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { currencyId } = req.query;
      const engine = req.query.engine === 'gpu' ? 'gpu' : 'cpu';
      const round = await NewEconomyService.getOrCreateMiningRound(currencyId, engine);

      res.json({
        success: true,
        data: {
          roundId: round.id,
          challenge: round.challenge,
          difficulty: round.difficulty,
          target: Number(round.target),
          reward: round.reward,
          engineType: round.engineType,
          expiresAt: round.expiresAt
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération du round de minage:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur serveur interne'
      });
    }
  }

  /**
   * Soumettre une preuve de travail (nonce) pour le round de minage en cours
   */
  static async submitMiningProof(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { currencyId, roundId, nonce } = req.body;
      const userId = req.user.id;

      const result = await NewEconomyService.submitMiningProof(userId, currencyId, roundId, nonce);

      res.json({
        success: true,
        data: {
          reward: result.reward,
          difficulty: result.difficulty,
          newBalance: result.newBalance,
          dailyMiningCount: result.dailyMiningCount,
          dailyLimit: result.dailyLimit,
          currentPrice: result.currentPrice,
          priceMultiplier: result.priceMultiplier,
          nextRound: {
            roundId: result.nextRound.id,
            challenge: result.nextRound.challenge,
            difficulty: result.nextRound.difficulty,
            target: Number(result.nextRound.target),
            reward: result.nextRound.reward,
            engineType: result.nextRound.engineType,
            expiresAt: result.nextRound.expiresAt
          }
        },
        message: `+${result.reward} TWC minés (difficulté ${result.difficulty})`
      });
    } catch (error) {
      const raced = error.code === 'ROUND_TAKEN' || error.code === 'ROUND_NOT_FOUND';
      const invalid = error.code === 'INVALID_PROOF';
      const limited = error.code === 'MINING_DAILY_LIMIT';
      if (!raced && !invalid && !limited) logger.error('Erreur lors de la soumission de minage:', error);

      const status = raced ? 409 : invalid ? 400 : limited ? 429 : 500;
      res.status(status).json({
        success: false,
        message: (raced || invalid || limited) ? error.message : 'Erreur serveur interne',
        code: error.code
      });
    }
  }

  /**
   * Transférer des TwitCoins à un autre utilisateur (frais vers la trésorerie)
   */
  static async transferCoins(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { toUserId, currencyId, amount, description, amountCurrency = 'NF' } = req.body;
      const fromUserId = req.user.id;

      if (fromUserId === toUserId) {
        return res.status(400).json({
          success: false,
          message: 'Impossible de transférer vers votre propre compte'
        });
      }

      const { User } = require('../models');
      const toUser = await User.findByPk(toUserId, { attributes: ['id', 'username'] });
      if (!toUser) {
        return res.status(404).json({
          success: false,
          message: 'Destinataire non trouvé'
        });
      }

      // Un virement peut être exprimé en NF (comportement historique) ou en
      // EUR — dans ce dernier cas, on convertit au taux RÉEL courant
      // (currency.currentPrice, pas la constante REFERENCE_PRICE_EUR figée)
      // juste avant l'exécution : le montant NF réellement transféré reflète
      // toujours le taux du moment, jamais un taux mémorisé plus tôt.
      let amountNf = Number(amount);
      let exchangeRate = null;
      let finalDescription = description;
      if (amountCurrency === 'EUR') {
        const currency = await getPlatformCurrency({ fresh: true });
        if (!currency || !(Number(currency.currentPrice) > 0)) {
          return res.status(503).json({ success: false, message: 'Taux de change indisponible' });
        }
        exchangeRate = Number(currency.currentPrice);
        amountNf = roundTWC(Number(amount) / exchangeRate);
        // Il n'existe pas de portefeuille EUR séparé : le virement est
        // toujours en NF. Sans cette note, l'historique ne montre plus nulle
        // part que le montant a été saisi en EUR — seul le NF converti reste
        // visible, ce qui donne l'impression trompeuse qu'aucun EUR n'a
        // jamais été impliqué alors que c'est l'unité que la personne a tapée.
        const eurNote = `[Saisi comme ${Number(amount).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € — converti à ${exchangeRate} €/NF]`;
        finalDescription = description ? `${description} ${eurNote}` : eurNote;
      }

      // Virement direct vers/depuis le portefeuille EUR interne (widget
      // "Envoyer" en unité EUR, cas normal aujourd'hui : currencyId = celui
      // du portefeuille EUR, amountNf = le montant en EUR tel quel). Si le
      // solde EUR de l'expéditeur est insuffisant mais qu'il détient du NF,
      // convertit automatiquement le manquant en EUR au taux courant AVANT
      // le virement — sans ça, "0 € affiché mais du NF en poche" bloquait un
      // virement marqué en EUR pour rien.
      const eurCurrency = await getOrCreateEurCurrency();
      if (currencyId === eurCurrency.id) {
        const eurWallet = await NewEconomyService.getUserWallet(eurCurrency.id, fromUserId);
        const shortfall = roundTWC(amountNf - eurWallet.wallet.balance);
        if (shortfall > 0) {
          const nfCurrency = await getPlatformCurrency({ fresh: true });
          if (nfCurrency && Number(nfCurrency.currentPrice) > 0) {
            const rate = Number(nfCurrency.currentPrice); // EUR par NF
            // Arrondi AU-DESSUS au centime : arrondir au plus proche pourrait
            // convertir 0,01 € de moins que le manquant réel et laisser le
            // virement échouer pour un centime après coup.
            const nfNeeded = Math.ceil((shortfall / rate) * 100) / 100;
            try {
              await NewEconomyService.exchangeCurrency(fromUserId, nfCurrency.id, eurCurrency.id, nfNeeded, rate);
            } catch (_conversionError) {
              // Pas assez de NF non plus (ou autre échec de conversion) : on
              // laisse le virement échouer plus bas avec son "solde insuffisant"
              // habituel plutôt que de faire remonter une erreur différente ici.
            }
          }
        }
      }

      const result = await NewEconomyService.transferCoins(
        fromUserId,
        toUserId,
        currencyId,
        amountNf,
        finalDescription
      );

      res.json({
        success: true,
        data: {
          transaction: {
            id: result.tx.id,
            hash: result.tx.transactionHash,
            amount: result.netAmount,
            grossAmount: amountNf,
            description: result.tx.description
          },
          amount: amountNf,
          amountCurrency: 'NF',
          originalAmount: Number(amount),
          originalAmountCurrency: amountCurrency,
          exchangeRateEurPerNf: exchangeRate,
          fee: result.fee,
          netAmount: result.netAmount
        },
        message: `Transfert de ${result.netAmount} NF envoyé à @${toUser.username}`
      });
    } catch (error) {
      logger.error('Erreur lors du transfert de TwitCoins:', error);
      const message = error instanceof Error && /Solde insuffisant|Transfert minimal|Transfert vers soi-même/.test(error.message)
        ? error.message
        : 'Erreur serveur interne';
      res.status(error.message && /Solde insuffisant|Transfert minimal|Transfert vers soi-même/.test(error.message) ? 400 : 500).json({
        success: false,
        message
      });
    }
  }
}

module.exports = NewEconomyController;
