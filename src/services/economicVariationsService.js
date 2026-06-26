const { VirtualCurrency } = require('../models');
const logger = require('../utils/logger');
const cron = require('node-cron');
const EconomyMetrics = require('../economy/metrics');

/**
 * Promotions admin et rafraîchissement des métriques — pas de « marché » simulé.
 */
class EconomicVariationsService {
  static async analyzeAndAdjustEconomy(currencyId) {
    const metrics = await EconomyMetrics.refresh(currencyId);
    const currency = await VirtualCurrency.findByPk(currencyId);
    return {
      newPrice: parseFloat(currency.currentPrice),
      newMultiplier: 1.0,
      newBonus: parseFloat(currency.purchaseBonus),
      newTrend: metrics.trend,
      ...metrics
    };
  }

  /**
   * Promotion temporaire : bonus % supplémentaire sur les packs (prix EUR inchangés).
   */
  static async triggerSpecialEvent(currencyId, eventType, durationHours = 24) {
    const currency = await VirtualCurrency.findByPk(currencyId);
    if (!currency) {
      throw new Error('Monnaie introuvable');
    }

    const events = {
      BLACK_FRIDAY: { bonus: 0.3, description: 'Black Friday — +30% de pièces bonus' },
      CHRISTMAS_SPECIAL: { bonus: 0.25, description: 'Noël — +25% de pièces bonus' },
      NEW_USER_PROMO: { bonus: 0.5, description: 'Nouveaux utilisateurs — +50% de pièces bonus' },
      CREATOR_WEEK: { bonus: 0.15, description: 'Semaine créateurs — +15% de pièces bonus' }
    };

    const event = events[eventType];
    if (!event) {
      throw new Error("Type d'événement non reconnu");
    }

    await currency.update({
      purchaseBonus: event.bonus,
      economicTrend: 'stable',
      currentMultiplier: 1.0,
      currentPrice: parseFloat(currency.basePrice) || 0.01
    });

    logger.info(`Promotion active: ${event.description} (${durationHours}h)`);

    if (durationHours > 0) {
      setTimeout(async () => {
        try {
          const c = await VirtualCurrency.findByPk(currencyId);
          if (c) {
            await c.update({ purchaseBonus: 0 });
            await EconomyMetrics.refresh(currencyId);
          }
          logger.info(`Promotion terminée: ${eventType}`);
        } catch (err) {
          logger.error('Erreur fin promotion:', err);
        }
      }, durationHours * 60 * 60 * 1000);
    }

    return {
      eventType,
      description: event.description,
      bonusPercent: event.bonus * 100,
      durationHours
    };
  }

  static initializeAutomaticTasks() {
    logger.info('Tâches économiques: sync métriques horaire');

    cron.schedule('0 * * * *', async () => {
      try {
        const currencies = await VirtualCurrency.findAll({ where: { isActive: true } });
        for (const currency of currencies) {
          await EconomyMetrics.refresh(currency.id);
        }
      } catch (error) {
        logger.error('Erreur sync métriques économiques:', error);
      }
    });
  }

  static async getEconomicPredictions() {
    return {
      prediction: 'stable',
      confidence: 100,
      reason: 'Prix de référence fixe — pas de spéculation sur TwitCoins'
    };
  }

  /** @deprecated compat */
  static async calculateEconomicMetrics(data) {
    return this.analyzeAndAdjustEconomy(data.currency.id);
  }

  static async applyEconomicAdjustments(currency) {
    return this.analyzeAndAdjustEconomy(currency.id);
  }
}

module.exports = EconomicVariationsService;
