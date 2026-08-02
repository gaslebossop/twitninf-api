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

      // Pas de colonne "lastMiningDate" (système de mining jamais mis en place
      // en base) : updatedAt approxime un portefeuille actif, tout changement
      // de solde (achat, récompense, transfert) le met à jour.
      const activeWallets = await UserWallet.count({
        where: {
          currencyId,
          updatedAt: {
            [require('sequelize').Op.gte]: yesterday
          }
        }
      });

      // Le prix N'EST PLUS recalculé ici.
      //
      // Ce service appliquait `currentPrice = 1,00 € × multiplicateur
      // d'activité`, un modèle totalement distinct de celui qui gouverne
      // réellement l'économie (`base_price × current_multiplier`, déplacé par
      // les échanges du ledger et la dilution du minage). Les deux écrivaient
      // la MÊME colonne : le cron horaire écrasait donc périodiquement le
      // cours issu des échanges réels par une valeur sans rapport — le NF, de
      // base 10 €, se faisait ramener vers ~1 € puis remontait au premier
      // échange, d'où des sauts de cours inexpliqués (0,87 € → 12,44 € →
      // 16,79 € en une journée) et une courbe incohérente.
      //
      // On garde tout ce qui est utile et non destructif : le point horaire
      // dans l'historique (c'est lui qui donne au NF une courbe continue même
      // sans échange), le volume, la variation 24 h et la capitalisation —
      // tous calculés à partir du prix RÉEL en vigueur.
      const livePrice = Number(currency.currentPrice) || 0;

      const priceHistory = currency.priceHistory || [];
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const reference = priceHistory.find((point) => new Date(point.date).getTime() >= dayAgo);
      const referencePrice = Number(reference?.price) || livePrice;
      const priceChange = referencePrice > 0
        ? ((livePrice - referencePrice) / referencePrice) * 100
        : 0;

      priceHistory.push({
        date: new Date().toISOString(),
        price: livePrice,
        volume: totalVolume24h || 0,
        transactions: recentTransactions,
        activeWallets: activeWallets
      });

      // Garder seulement les 30 derniers jours
      if (priceHistory.length > 30) {
        priceHistory.splice(0, priceHistory.length - 30);
      }

      const newPrice = livePrice;
      await currency.update({
        priceHistory: priceHistory,
        priceChange24h: priceChange,
        volume24h: totalVolume24h || 0,
        marketCap: (currency.circulatingSupply || 0) * livePrice
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

      // Limité aux monnaies système (NF, EUR) : ce sont les seules dont la
      // courbe s'appuie sur `priceHistory`, alimenté ici heure par heure.
      // Les monnaies communautaires n'en ont pas besoin — leur courbe est
      // reconstruite à partir des échanges réels, complétée par le prix
      // courant (voir economy/userCurrency.js: getCurrencyDetail).
      const currencies = await VirtualCurrency.findAll({
        where: { isActive: true, isUserCreated: false }
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
