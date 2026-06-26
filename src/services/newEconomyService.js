const { VirtualCurrency, UserWallet, Transaction, User } = require('../models');
const { sequelize } = require('../database/index');
const logger = require('../utils/logger');
const {
  PURCHASE_PACKAGES,
  REFERENCE_PRICE_EUR,
  TREASURY_USER_ID
} = require('../economy/constants');
const { roundTWC, toAmount, computePackageCoins } = require('../economy/money');
const EconomyLedger = require('../economy/ledger');
const EconomyMetrics = require('../economy/metrics');

/**
 * API économique TwitCoins — monnaie fermée plateforme.
 * Achat = mint | Dépense → trésorerie | Récompense ← trésorerie
 */
class NewEconomyService {
  static async _findOrCreateWallet(userId, currencyId, transaction = null) {
    return EconomyLedger.findOrCreateWallet(userId, currencyId, transaction);
  }

  static async ensureWalletsForUser(userId, externalTransaction = null) {
    if (!userId) return { ensured: 0 };
    const currencies = await VirtualCurrency.findAll({
      where: { isActive: true },
      attributes: ['id'],
      transaction: externalTransaction
    });
    for (const c of currencies) {
      await EconomyLedger.findOrCreateWallet(userId, c.id, externalTransaction);
    }
    if (currencies.length > 0) {
      await EconomyLedger.findOrCreateWallet(
        TREASURY_USER_ID,
        currencies[0].id,
        externalTransaction
      );
    }
    return { ensured: currencies.length };
  }

  static _resolvePackage(pkgDef, promoBonusFraction = 0) {
    const bonusCoins =
      computePackageCoins(pkgDef.baseCoins, pkgDef.bonusPercent, promoBonusFraction) -
      pkgDef.baseCoins;
    const totalCoins = pkgDef.baseCoins + bonusCoins;
    return {
      id: pkgDef.id,
      name: pkgDef.name,
      coins: pkgDef.baseCoins,
      price: pkgDef.priceEur,
      popular: pkgDef.popular,
      originalPrice: pkgDef.priceEur,
      currentPrice: pkgDef.priceEur.toFixed(2),
      priceEur: pkgDef.priceEur,
      bonusCoins,
      totalCoins,
      savings: pkgDef.bonusPercent,
      pricePerCoin: (pkgDef.priceEur / totalCoins).toFixed(4)
    };
  }

  static async getPurchasePackages(currencyId) {
    const currency = await EconomyLedger.getActiveCurrency(currencyId);
    const promo = Math.max(0, toAmount(currency.purchaseBonus));

    const packages = PURCHASE_PACKAGES.map((p) => this._resolvePackage(p, promo));

    return {
      packages,
      economicStatus: {
        trend: currency.economicTrend || 'stable',
        multiplier: 1.0,
        bonus: roundTWC(promo * 100),
        referencePriceEur: REFERENCE_PRICE_EUR,
        activePromotion: promo > 0
      }
    };
  }

  static async purchaseCoins(userId, currencyId, packageId, paymentMethod) {
    const dbTransaction = await sequelize.transaction();
    try {
      const currency = await EconomyLedger.getActiveCurrency(currencyId, dbTransaction);
      const promo = Math.max(0, toAmount(currency.purchaseBonus));
      const pkgDef = PURCHASE_PACKAGES.find((p) => p.id === packageId);
      if (!pkgDef) {
        throw new Error('Package non trouvé');
      }
      const selectedPackage = this._resolvePackage(pkgDef, promo);

      const { tx, wallet } = await EconomyLedger.mintFromPurchase(
        userId,
        currencyId,
        selectedPackage,
        paymentMethod,
        dbTransaction
      );

      await EconomyMetrics.refresh(currencyId, dbTransaction);
      await dbTransaction.commit();

      logger.info(
        `Achat: ${selectedPackage.totalCoins} TWC (${selectedPackage.currentPrice}€) user=${userId}`
      );

      return {
        transaction: tx,
        wallet,
        package: selectedPackage
      };
    } catch (error) {
      await dbTransaction.rollback();
      logger.error('Erreur achat TWC:', error);
      throw error;
    }
  }

  static async getUserWallet(currencyId, userId, dbTransaction = null) {
    const currency = await EconomyLedger.getActiveCurrency(currencyId, dbTransaction);
    const wallet = await EconomyLedger.findOrCreateWallet(userId, currencyId, dbTransaction);
    const treasury = await EconomyMetrics.getTreasuryBalance(currencyId, dbTransaction);

    return {
      wallet: {
        id: wallet.id,
        balance: toAmount(wallet.balance),
        totalEarned: toAmount(wallet.totalEarned),
        totalSpent: toAmount(wallet.totalSpent),
        totalPurchased: toAmount(wallet.totalPurchased),
        loyaltyPoints: wallet.loyaltyPoints || 0,
        lastPurchaseDate: wallet.lastPurchaseDate
      },
      currency: {
        id: currency.id,
        name: currency.name,
        symbol: currency.symbol,
        currentPrice: REFERENCE_PRICE_EUR,
        basePrice: REFERENCE_PRICE_EUR,
        multiplier: 1.0,
        trend: currency.economicTrend || 'stable',
        volume24h: toAmount(currency.volume24h),
        marketCap: toAmount(currency.marketCap),
        priceChange24h: 0,
        treasuryReserve: treasury
      }
    };
  }

  static async spendCoins(
    userId,
    currencyId,
    amount,
    itemType,
    itemId,
    description,
    externalTransaction = null
  ) {
    const dbTransaction = externalTransaction || (await sequelize.transaction());
    const shouldCommit = !externalTransaction;

    try {
      await EconomyLedger.getActiveCurrency(currencyId, dbTransaction);
      const result = await EconomyLedger.spendToTreasury(
        userId,
        currencyId,
        amount,
        {
          description,
          itemType,
          itemId,
          spendingCategory: this.getSpendingCategory(itemType),
          metadata: {}
        },
        dbTransaction
      );

      if (shouldCommit) {
        await EconomyMetrics.refresh(currencyId, dbTransaction);
        await dbTransaction.commit();
      }

      logger.info(`Dépense: ${amount} TWC user=${userId} — ${description}`);
      return {
        transaction: result.tx,
        transactionHash: result.tx.transactionHash,
        wallet: result.wallet,
        remainingBalance: result.remainingBalance
      };
    } catch (error) {
      if (shouldCommit) await dbTransaction.rollback();
      logger.error('Erreur dépense TWC:', error);
      throw error;
    }
  }

  static async rewardUser(
    userId,
    currencyId,
    amount,
    description = 'Récompense créateur',
    externalTransaction = null
  ) {
    const dbTransaction = externalTransaction || (await sequelize.transaction());
    const shouldCommit = !externalTransaction;

    try {
      const result = await EconomyLedger.rewardFromTreasury(
        userId,
        currencyId,
        amount,
        description,
        dbTransaction
      );

      if (shouldCommit) {
        await EconomyMetrics.refresh(currencyId, dbTransaction);
        await dbTransaction.commit();
      }

      logger.info(`Récompense: ${amount} TWC → user=${userId}`);
      return { success: true, reward: amount, transaction: result.tx };
    } catch (error) {
      if (shouldCommit) await dbTransaction.rollback();
      logger.error('Erreur récompense TWC:', error);
      throw error;
    }
  }

  static async transferCoins(fromUserId, toUserId, currencyId, amount, description) {
    const dbTransaction = await sequelize.transaction();
    try {
      const result = await EconomyLedger.transferP2P(
        fromUserId,
        toUserId,
        currencyId,
        amount,
        description,
        dbTransaction
      );
      await EconomyMetrics.refresh(currencyId, dbTransaction);
      await dbTransaction.commit();
      return result;
    } catch (error) {
      await dbTransaction.rollback();
      throw error;
    }
  }

  static async getEconomicStats(currencyId) {
    const currency = await VirtualCurrency.findByPk(currencyId);
    if (!currency) {
      throw new Error('Monnaie introuvable');
    }
    const metrics = await EconomyMetrics.refresh(currencyId);
    await currency.reload();
    return EconomyMetrics.buildPublicStats(currency, metrics);
  }

  static getSpendingCategory(itemType) {
    const categories = {
      boost_visibility: 'Promotion',
      super_like: 'Interaction',
      badge: 'Cosmétique',
      premium_feature: 'Fonctionnalité',
      subscription_purchase: 'Abonnement',
      gift: 'Social',
      ad_campaign: 'Publicité'
    };
    return categories[itemType] || 'Autre';
  }

  static async getPurchaseLeaderboard(currencyId, limit = 50) {
    const leaderboard = await UserWallet.findAll({
      where: {
        currencyId,
        userId: { [require('sequelize').Op.ne]: TREASURY_USER_ID }
      },
      include: [
        {
          model: User,
          attributes: ['username', 'profilePicture', 'isVerified']
        }
      ],
      order: [['totalPurchased', 'DESC']],
      limit
    });

    return leaderboard.map((wallet, index) => ({
      rank: index + 1,
      user: {
        id: wallet.userId,
        username: wallet.User?.username,
        profilePicture: wallet.User?.profilePicture,
        isVerified: wallet.User?.isVerified
      },
      totalPurchased: toAmount(wallet.totalPurchased),
      currentBalance: toAmount(wallet.balance),
      loyaltyPoints: wallet.loyaltyPoints,
      joinDate: wallet.createdAt
    }));
  }

  /** Compat : ancien hook post-achat — délégué aux métriques */
  static async updateEconomicMetrics(currencyId) {
    return EconomyMetrics.refresh(currencyId);
  }
}

module.exports = NewEconomyService;
