/**
 * Script pour réinitialiser tous les portefeuilles utilisateurs
 * Remet tous les soldes à zéro et réinitialise les statistiques
 */

const { sequelize } = require('../database/index');
const { UserWallet, VirtualCurrency } = require('../models');
const logger = require('../utils/logger');

async function resetAllWallets() {
  try {
    logger.info('🔄 Début de la réinitialisation de tous les portefeuilles...');

    const transaction = await sequelize.transaction();

    try {
      // 1. Récupérer l'ID de la cryptomonnaie TwitCoins
      const currency = await VirtualCurrency.findOne({
        where: { symbol: 'TWC' }
      });

      if (!currency) {
        throw new Error('Cryptomonnaie TwitCoins non trouvée');
      }

      logger.info(`💰 Cryptomonnaie trouvée: ${currency.name} (${currency.symbol})`);

      // 2. Réinitialiser tous les portefeuilles
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

      // 3. Réinitialiser les statistiques de la cryptomonnaie
      await VirtualCurrency.update({
        circulatingSupply: 0,
        volume24h: 0,
        priceChange24h: 0,
        currentMultiplier: 1.0,
        purchaseBonus: 0,
        economicTrend: 'stable',
        updatedAt: new Date()
      }, {
        where: { id: currency.id },
        transaction
      });

      logger.info('📊 Statistiques de la cryptomonnaie réinitialisées');

      // 4. Vérifier la réinitialisation
      const wallets = await UserWallet.findAll({
        where: { currencyId: currency.id },
        attributes: ['userId', 'balance', 'totalPurchased', 'totalEarned', 'totalSpent']
      });

      const totalBalance = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.balance), 0);
      const totalPurchased = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.totalPurchased), 0);
      const totalEarned = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.totalEarned), 0);
      const totalSpent = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.totalSpent), 0);

      logger.info('📊 Vérification de la réinitialisation:');
      logger.info(`   💰 Total des soldes: ${totalBalance} TWC`);
      logger.info(`   🛒 Total acheté: ${totalPurchased} TWC`);
      logger.info(`   💎 Total gagné: ${totalEarned} TWC`);
      logger.info(`   💸 Total dépensé: ${totalSpent} TWC`);

      await transaction.commit();
      logger.info('🎉 Réinitialisation de tous les portefeuilles terminée avec succès');

    } catch (innerError) {
      await transaction.rollback();
      logger.error('❌ Erreur lors de la réinitialisation des portefeuilles:', innerError);
      throw innerError;
    }

  } catch (error) {
    logger.error('❌ Erreur fatale lors de la réinitialisation des portefeuilles:', error);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

// Exécuter le script
resetAllWallets();
