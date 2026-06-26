const { VirtualCurrency, Transaction, UserWallet } = require('../models');
const logger = require('../utils/logger');

class PriceEvolutionService {
  /**
   * Calcule et met à jour le prix de la cryptomonnaie basé sur l'activité réelle
   */
  static async updatePriceBasedOnActivity(currencyId) {
    try {
      const currency = await VirtualCurrency.findByPk(currencyId);
      if (!currency) {
        throw new Error('Cryptomonnaie non trouvée');
      }

      // Calculer l'activité des dernières 24h
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const recentTransactions = await Transaction.count({
        where: {
          currencyId,
          createdAt: {
            [require('sequelize').Op.gte]: yesterday
          },
          status: 'COMPLETED'
        }
      });

      const totalVolume24h = await Transaction.sum('amountInEur', {
        where: {
          currencyId,
          createdAt: {
            [require('sequelize').Op.gte]: yesterday
          },
          status: 'COMPLETED'
        }
      });

      const totalWallets = await UserWallet.count({
        where: { currencyId }
      });

      const activeWallets = await UserWallet.count({
        where: {
          currencyId,
          lastMiningDate: {
            [require('sequelize').Op.gte]: yesterday
          }
        }
      });

      // Calculer le nouveau prix basé sur l'activité
      const basePrice = 1.00; // Prix de base
      const activityMultiplier = this.calculateActivityMultiplier(
        recentTransactions,
        totalVolume24h || 0,
        totalWallets,
        activeWallets
      );

      const newPrice = Math.max(0.01, basePrice * activityMultiplier);
      const priceChange = ((newPrice - currency.currentPrice) / currency.currentPrice) * 100;

      // Mettre à jour l'historique des prix
      const priceHistory = currency.priceHistory || [];
      priceHistory.push({
        date: new Date().toISOString(),
        price: newPrice,
        volume: totalVolume24h || 0,
        transactions: recentTransactions,
        activeWallets: activeWallets
      });

      // Garder seulement les 30 derniers jours
      if (priceHistory.length > 30) {
        priceHistory.splice(0, priceHistory.length - 30);
      }

      // Mettre à jour la cryptomonnaie
      await currency.update({
        currentPrice: newPrice,
        priceHistory: priceHistory,
        priceChange24h: priceChange,
        volume24h: totalVolume24h || 0,
        marketCap: (currency.circulatingSupply || 0) * newPrice
      });

      logger.info(`📈 Prix ${currency.symbol} mis à jour: ${newPrice.toFixed(4)}€ (${priceChange.toFixed(2)}%)`);
      logger.info(`📊 Activité: ${recentTransactions} transactions, ${activeWallets}/${totalWallets} portefeuilles actifs`);

      return {
        newPrice,
        priceChange,
        activity: {
          transactions: recentTransactions,
          volume: totalVolume24h || 0,
          activeWallets,
          totalWallets
        }
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour du prix:', error);
      throw error;
    }
  }

  /**
   * Calcule le multiplicateur de prix basé sur l'activité
   */
  static calculateActivityMultiplier(transactions, volume, totalWallets, activeWallets) {
    // Facteurs d'activité (sans limites)
    const transactionFactor = transactions / 100; // Pas de limite max
    const volumeFactor = volume / 1000; // Pas de limite max
    const engagementFactor = totalWallets > 0 ? (activeWallets / totalWallets) : 0; // Ratio d'engagement

    // Calcul du multiplicateur
    let multiplier = 1.0;
    
    // Bonus pour l'activité (sans limites)
    multiplier += (transactionFactor - 1) * 0.1; // Pas de limite max pour les transactions
    multiplier += (volumeFactor - 1) * 0.05; // Pas de limite max pour le volume
    multiplier += engagementFactor * 0.2; // Pas de limite max pour l'engagement

    // Pas de limites sur les variations

    return multiplier;
  }

  /**
   * Met à jour le prix toutes les heures (à appeler via cron)
   */
  static async scheduledPriceUpdate() {
    try {
      logger.info('🕐 Mise à jour programmée du prix des cryptomonnaies...');

      const currencies = await VirtualCurrency.findAll({
        where: { isActive: true }
      });

      for (const currency of currencies) {
        await this.updatePriceBasedOnActivity(currency.id);
      }

      logger.info('✅ Mise à jour des prix terminée');

    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour programmée des prix:', error);
    }
  }

  /**
   * Force la mise à jour du prix d'une cryptomonnaie spécifique
   */
  static async forcePriceUpdate(currencyId) {
    try {
      logger.info(`🔄 Mise à jour forcée du prix pour la cryptomonnaie ${currencyId}...`);
      return await this.updatePriceBasedOnActivity(currencyId);
    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour forcée du prix:', error);
      throw error;
    }
  }
}

module.exports = PriceEvolutionService;
