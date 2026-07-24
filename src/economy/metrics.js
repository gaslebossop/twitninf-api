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

    // Le multiplicateur n'est modifié que par le minage (dilution) ; refresh()
    // ne fait que recalculer le prix affiché à partir de ce multiplicateur,
    // il ne doit pas l'écraser sinon la dilution serait annulée à chaque transfert/achat.
    //
    // basePrice vient de LA monnaie elle-même (10 pour NF, 1 pour un
    // portefeuille EUR interne à parité fixe...), jamais de la constante
    // globale REFERENCE_PRICE_EUR — refresh() est appelé sur n'importe
    // quelle monnaie (P2P, casino...), et utiliser un prix de base unique
    // pour toutes écraserait la parité 1:1 d'une monnaie comme l'EUR interne
    // dès le premier transfert.
    const multiplier = toAmount(currency.currentMultiplier) || 1;
    const basePriceEur = toAmount(currency.basePrice) || REFERENCE_PRICE_EUR;
    const currentPrice = roundTWC(basePriceEur * multiplier);
    const previousPrice = toAmount(currency.currentPrice) || basePriceEur;
    const priceChange24h = previousPrice > 0 ? roundTWC(((currentPrice - previousPrice) / previousPrice) * 100) : 0;

    const priceHistory = Array.isArray(currency.priceHistory) ? [...currency.priceHistory] : [];
    priceHistory.push({
      date: new Date().toISOString(),
      price: currentPrice,
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
        currentPrice,
        // basePrice n'est plus écrasé : c'est une donnée propre à la
        // monnaie, pas une constante globale à réappliquer à chaque refresh.
        volume24h: volumeEur,
        marketCap: roundTWC(circulating * currentPrice),
        economicTrend: trend,
        priceChange24h,
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
    const basePriceEur = toAmount(currency.basePrice) || REFERENCE_PRICE_EUR;
    return {
      currency: {
        symbol: currency.symbol,
        name: currency.name,
        referencePriceEur: REFERENCE_PRICE_EUR,
        currentPrice: toAmount(currency.currentPrice) || basePriceEur,
        basePrice: basePriceEur,
        multiplier: toAmount(currency.currentMultiplier) || 1.0,
        trend: currency.economicTrend || 'stable',
        purchaseBonus: roundTWC(toAmount(currency.purchaseBonus) * 100),
        priceChange24h: toAmount(currency.priceChange24h) || 0,
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
