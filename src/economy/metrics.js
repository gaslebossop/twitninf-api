const { Op } = require('sequelize');
const { VirtualCurrency, UserWallet, Transaction } = require('../models');
const { REFERENCE_PRICE_EUR, TREASURY_USER_ID } = require('./constants');
const { roundTWC, toAmount } = require('./money');
const logger = require('../utils/logger');

/**
 * Statistiques et synchronisation de l'offre en circulation (somme des soldes).
 */
class EconomyMetrics {
  static async sumBalances(currencyId, dbTransaction = null) {
    const total = await UserWallet.sum('balance', {
      where: { currencyId },
      transaction: dbTransaction
    });
    return roundTWC(total || 0);
  }

  static async getTreasuryBalance(currencyId, dbTransaction = null) {
    const w = await UserWallet.findOne({
      where: { userId: TREASURY_USER_ID, currencyId },
      transaction: dbTransaction
    });
    return w ? toAmount(w.balance) : 0;
  }

  static async purchaseVolume24h(currencyId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await Transaction.findAll({
      where: {
        currencyId,
        type: 'PURCHASE',
        status: 'COMPLETED',
        createdAt: { [Op.gte]: since }
      },
      attributes: ['amountInEur', 'amount']
    });
    const volumeEur = rows.reduce((s, t) => s + toAmount(t.amountInEur), 0);
    const volumeTwc = rows.reduce((s, t) => s + toAmount(t.amount), 0);
    return { volumeEur: roundTWC(volumeEur), volumeTwc: roundTWC(volumeTwc), count: rows.length };
  }

  /**
   * Recalcule circulatingSupply = Σ soldes ; met à jour volume24h et prix de référence fixe.
   */
  static async refresh(currencyId, dbTransaction = null) {
    const currency = await VirtualCurrency.findByPk(currencyId, { transaction: dbTransaction });
    if (!currency) {
      throw new Error('Monnaie introuvable');
    }

    const circulating = await this.sumBalances(currencyId, dbTransaction);
    const treasury = await this.getTreasuryBalance(currencyId, dbTransaction);
    const { volumeEur, volumeTwc, count } = await this.purchaseVolume24h(currencyId);

    const userHeld = roundTWC(circulating - treasury);

    let trend = 'stable';
    if (count >= 10 && volumeEur > 500) {
      trend = 'rising';
    } else if (count === 0 && volumeEur === 0) {
      trend = 'stable';
    } else if (volumeEur < 50 && count < 3) {
      trend = 'falling';
    }

    const priceHistory = Array.isArray(currency.priceHistory) ? [...currency.priceHistory] : [];
    priceHistory.push({
      date: new Date().toISOString(),
      price: REFERENCE_PRICE_EUR,
      circulatingSupply: circulating,
      treasuryReserve: treasury,
      volumeEur24h: volumeEur
    });
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const filteredHistory = priceHistory
      .filter((e) => new Date(e.date) > cutoff)
      .slice(-90);

    await currency.update(
      {
        circulatingSupply: circulating,
        currentPrice: REFERENCE_PRICE_EUR,
        basePrice: REFERENCE_PRICE_EUR,
        currentMultiplier: 1.0,
        volume24h: volumeEur,
        marketCap: roundTWC(circulating * REFERENCE_PRICE_EUR),
        economicTrend: trend,
        priceChange24h: 0,
        priceHistory: filteredHistory
      },
      { transaction: dbTransaction }
    );

    logger.debug(
      `[economy] Metrics ${currency.symbol}: supply=${circulating}, treasury=${treasury}, users=${userHeld}, vol24h=${volumeEur}€`
    );

    return {
      circulatingSupply: circulating,
      treasuryReserve: treasury,
      userHeldSupply: userHeld,
      volume24hEur: volumeEur,
      volume24hTwc: volumeTwc,
      purchaseCount24h: count,
      trend
    };
  }

  static buildPublicStats(currency, metricsExtras = {}) {
    return {
      currency: {
        symbol: currency.symbol,
        name: currency.name,
        referencePriceEur: REFERENCE_PRICE_EUR,
        currentPrice: REFERENCE_PRICE_EUR,
        basePrice: REFERENCE_PRICE_EUR,
        multiplier: 1.0,
        trend: currency.economicTrend || 'stable',
        purchaseBonus: roundTWC(toAmount(currency.purchaseBonus) * 100),
        priceChange24h: 0,
        volume24h: toAmount(currency.volume24h),
        marketCap: toAmount(currency.marketCap),
        circulatingSupply: toAmount(currency.circulatingSupply),
        treasuryReserve: metricsExtras.treasuryReserve ?? null,
        userHeldSupply: metricsExtras.userHeldSupply ?? null
      },
      priceHistory: (currency.priceHistory || []).slice(-30)
    };
  }
}

module.exports = EconomyMetrics;
