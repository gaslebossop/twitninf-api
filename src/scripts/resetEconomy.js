/**
 * Script pour réinitialiser complètement l'économie TwitCoins
 * Remet l'économie à zéro et réinitialise tous les paramètres
 */

const { sequelize } = require('../database/index');
const { UserWallet, VirtualCurrency } = require('../models');
const logger = require('../utils/logger');

async function resetEconomy() {
  try {
    logger.info('🔄 Début de la réinitialisation complète de l\'économie...');

    const transaction = await sequelize.transaction();

    try {
      // 1. Récupérer la cryptomonnaie TwitCoins
      const currency = await VirtualCurrency.findOne({
        where: { symbol: 'TWC' }
      });

      if (!currency) {
        throw new Error('Cryptomonnaie TwitCoins non trouvée');
      }

      logger.info(`💰 Cryptomonnaie trouvée: ${currency.name} (${currency.symbol})`);

      // 2. Réinitialiser complètement l'économie
      await VirtualCurrency.update({
        // Prix et multiplicateurs
        currentPrice: 0.01,
        basePrice: 0.01,
        currentMultiplier: 1.0,
        purchaseBonus: 0,
        economicTrend: 'stable',
        
        // Supply et circulation
        totalSupply: 1000000000, // 1 milliard TWC
        circulatingSupply: 0,
        
        // Volume et marché
        volume24h: 0,
        priceChange24h: 0,
        marketCap: 0,
        
        // Historique des prix
        priceHistory: JSON.stringify([]),
        
        // Packages d'achat (réinitialisés)
        purchasePackages: JSON.stringify([
          {
            id: 'small',
            name: 'Petit Pack',
            price: 5,
            coins: 500,
            bonus: 0
          },
          {
            id: 'medium',
            name: 'Pack Moyen',
            price: 10,
            coins: 1200,
            bonus: 20
          },
          {
            id: 'large',
            name: 'Gros Pack',
            price: 25,
            coins: 3500,
            bonus: 40
          },
          {
            id: 'mega',
            name: 'Mega Pack',
            price: 50,
            coins: 8000,
            bonus: 60
          },
          {
            id: 'ultimate',
            name: 'Pack Ultime',
            price: 100,
            coins: 20000,
            bonus: 100
          },
          {
            id: 'vip_100',
            name: 'VIP 100€',
            price: 100,
            coins: 25000,
            bonus: 150
          },
          {
            id: 'vip_500',
            name: 'VIP 500€',
            price: 500,
            coins: 150000,
            bonus: 200
          },
          {
            id: 'vip_1000',
            name: 'VIP 1000€',
            price: 1000,
            coins: 350000,
            bonus: 250
          },
          {
            id: 'vip_10000',
            name: 'VIP 10000€',
            price: 10000,
            coins: 5000000,
            bonus: 400
          }
        ]),
        
        updatedAt: new Date()
      }, {
        where: { id: currency.id },
        transaction
      });

      logger.info('📊 Économie réinitialisée avec les paramètres de base');

      // 3. Réinitialiser tous les portefeuilles
      const resetResult = await UserWallet.update({
        balance: 0,
        totalPurchased: 0,
        totalEarned: 0,
        totalSpent: 0,
        loyaltyPoints: 0,
        lastPurchaseDate: null,
        lastEarnedDate: null,
        lastSpentDate: null,
        updatedAt: new Date()
      }, {
        where: { currencyId: currency.id },
        transaction
      });

      logger.info(`✅ ${resetResult[0]} portefeuilles réinitialisés`);

      // 4. Supprimer toutes les transactions existantes
      try {
        await sequelize.query(`
          DELETE FROM virtual_currency_transactions 
          WHERE currency_id = $1
        `, {
          bind: [currency.id],
          transaction
        });
      } catch (deleteError) {
        logger.warn('⚠️ Erreur lors de la suppression des transactions (peut-être que la table n\'existe pas):', deleteError.message);
      }

      logger.info('🗑️ Toutes les transactions supprimées');

      // 5. Vérifier la réinitialisation
      const updatedCurrency = await VirtualCurrency.findByPk(currency.id);
      const wallets = await UserWallet.findAll({
        where: { currencyId: currency.id },
        attributes: ['userId', 'balance', 'totalPurchased', 'totalEarned', 'totalSpent']
      });

      const totalBalance = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.balance), 0);
      const totalPurchased = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.totalPurchased), 0);
      const totalEarned = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.totalEarned), 0);
      const totalSpent = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.totalSpent), 0);

      logger.info('📊 Vérification de la réinitialisation:');
      logger.info(`   💰 Prix actuel: ${updatedCurrency.currentPrice}€`);
      logger.info(`   📈 Multiplicateur: ${updatedCurrency.currentMultiplier}x`);
      logger.info(`   🎁 Bonus: ${updatedCurrency.purchaseBonus * 100}%`);
      logger.info(`   📊 Tendance: ${updatedCurrency.economicTrend}`);
      logger.info(`   💎 Supply total: ${updatedCurrency.totalSupply} TWC`);
      logger.info(`   💰 Supply en circulation: ${updatedCurrency.circulatingSupply} TWC`);
      logger.info(`   💰 Total des soldes: ${totalBalance} TWC`);
      logger.info(`   🛒 Total acheté: ${totalPurchased} TWC`);
      logger.info(`   💎 Total gagné: ${totalEarned} TWC`);
      logger.info(`   💸 Total dépensé: ${totalSpent} TWC`);

      await transaction.commit();
      logger.info('🎉 Réinitialisation complète de l\'économie terminée avec succès');

    } catch (innerError) {
      await transaction.rollback();
      logger.error('❌ Erreur lors de la réinitialisation de l\'économie:', innerError);
      throw innerError;
    }

  } catch (error) {
    logger.error('❌ Erreur fatale lors de la réinitialisation de l\'économie:', error);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

// Exécuter le script
resetEconomy();
