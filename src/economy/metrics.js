const { Op } = require('sequelize');
const { VirtualCurrency, UserWallet, Transaction } = require('../models');
const { REFERENCE_PRICE_EUR, TREASURY_USER_ID } = require('./constants');
const { roundTWC, roundPrice, toAmount } = require('./money');
const logger = require('../utils/logger');

const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;
// En-dessous de ce délai, un point sans changement de prix n'est pas
// réenregistré — sinon `refresh()` (appelé à CHAQUE consultation des stats,
// pas seulement à chaque échange réel) noyait l'historique de points quasi
// identiques, qui évinçaient les vieux points utiles hors du tableau.
const MIN_UNCHANGED_INTERVAL_MS = 5 * 60_000;

/**
 * Réduit un historique de prix en gardant une résolution fine sur le passé
 * récent et de plus en plus grossière en remontant dans le temps (tous les
 * points sur les dernières 24h, 1 point/heure jusqu'à 7 jours, 1 point/jour
 * jusqu'à 30 jours) — au lieu d'un `slice(-N)` aveugle qui, combiné à des
 * appels très fréquents, ne conservait jamais plus d'une heure ou deux
 * d'historique réel quel que soit le nombre de jours théoriquement couverts.
 * Recalculé à chaque appel : un point glisse naturellement d'une résolution
 * à l'autre à mesure qu'il vieillit.
 */
function decimatePriceHistory(history) {
  const now = Date.now();
  const cutoff = now - THIRTY_DAYS_MS;
  const sorted = history
    .filter((e) => {
      const t = new Date(e.date).getTime();
      return Number.isFinite(t) && t > cutoff;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const kept = [];
  const bucketIndex = new Map();
  for (const entry of sorted) {
    const t = new Date(entry.date).getTime();
    const age = now - t;
    const bucketMs = age <= ONE_DAY_MS ? null : age <= SEVEN_DAYS_MS ? ONE_HOUR_MS : ONE_DAY_MS;

    if (bucketMs == null) {
      kept.push(entry);
      continue;
    }
    const key = Math.floor(t / bucketMs);
    const existing = bucketIndex.get(key);
    if (existing == null) {
      bucketIndex.set(key, kept.length);
      kept.push(entry);
    } else {
      // Garde le DERNIER point du bucket (le plus représentatif de son état final).
      kept[existing] = entry;
    }
  }
  return kept;
}

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
    const currentPrice = roundPrice(basePriceEur * multiplier);
    const previousPrice = toAmount(currency.currentPrice) || basePriceEur;
    const priceChange24h = previousPrice > 0 ? roundTWC(((currentPrice - previousPrice) / previousPrice) * 100) : 0;

    const priceHistory = Array.isArray(currency.priceHistory) ? [...currency.priceHistory] : [];
    const last = priceHistory[priceHistory.length - 1];
    const now = new Date();
    const unchanged = last && Number(last.price) === currentPrice;
    const tooSoon = last && now.getTime() - new Date(last.date).getTime() < MIN_UNCHANGED_INTERVAL_MS;
    // Un point sans changement de prix est ignoré s'il est trop rapproché du
    // précédent — mais un VRAI changement de prix est toujours enregistré,
    // même quelques secondes après le point précédent.
    if (!(unchanged && tooSoon)) {
      priceHistory.push({
        date: now.toISOString(),
        price: currentPrice,
        circulatingSupply: circulating,
        treasuryReserve: treasury,
        volumeEur24h: volumeEur
      });
    }
    const filteredHistory = decimatePriceHistory(priceHistory);

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

  /**
   * `range` sélectionne la fenêtre de `priceHistory` à renvoyer — auparavant
   * toujours les 30 DERNIÈRES ENTRÉES du tableau, quel que soit leur âge réel.
   * Comme une entrée est ajoutée à chaque `refresh()` (chaque échange/achat,
   * mais aussi chaque simple consultation des stats via le polling 30s de la
   * page Trading), ces 30 entrées ne couvraient en pratique qu'une quinzaine
   * à une trentaine de minutes — jamais plus, même si l'historique réel (90
   * entrées sur 30 jours, voir `refresh()`) en contenait beaucoup plus. On
   * filtre maintenant par ÂGE RÉEL des entrées plutôt que par leur position.
   */
  static buildPublicStats(currency, metricsExtras = {}, { rangeHours = null } = {}) {
    const basePriceEur = toAmount(currency.basePrice) || REFERENCE_PRICE_EUR;
    const allHistory = Array.isArray(currency.priceHistory) ? currency.priceHistory : [];
    const priceHistory = rangeHours
      ? allHistory.filter((e) => new Date(e.date).getTime() > Date.now() - rangeHours * 3600_000)
      : allHistory.slice(-30);
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
      priceHistory
    };
  }
}

module.exports = EconomyMetrics;
