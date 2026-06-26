/**
 * 🧹 Script de nettoyage de l'économie
 * Supprime toutes les transactions de type PURCHASE (achats illégaux)
 * et ajuste les soldes des portefeuilles ainsi que l'offre en circulation.
 */

const { sequelize, Transaction, UserWallet, VirtualCurrency } = require('./src/models');
const logger = require('./src/utils/logger');

async function cleanupEconomy() {
  logger.info('🚀 Début du nettoyage de l\'économie...');
  
  const t = await sequelize.transaction();
  
  try {
    // 1. Récupérer toutes les transactions d'achat complétées
    const purchases = await Transaction.findAll({
      where: {
        type: 'PURCHASE',
        status: 'COMPLETED'
      },
      transaction: t
    });

    logger.info(`🔍 ${purchases.length} transactions d'achat trouvées.`);

    if (purchases.length === 0) {
      logger.info('✅ Aucune transaction d\'achat à supprimer.');
      await t.rollback();
      return;
    }

    // 2. Traiter chaque transaction pour annuler son impact
    for (const tx of purchases) {
      const amount = parseFloat(tx.amount);
      const userId = tx.toUserId;
      const currencyId = tx.currencyId;

      // Ajuster le portefeuille utilisateur
      const wallet = await UserWallet.findOne({
        where: { userId, currencyId },
        transaction: t
      });

      if (wallet) {
        const loyaltyPointsToSubtract = Math.floor(amount / 100);
        
        // On soustrait les montants ajoutés lors de l'achat "gratuit"
        await wallet.update({
          balance: parseFloat(wallet.balance) - amount,
          totalEarned: parseFloat(wallet.totalEarned) - amount,
          totalPurchased: parseFloat(wallet.totalPurchased) - amount,
          loyaltyPoints: Math.max(0, wallet.loyaltyPoints - loyaltyPointsToSubtract)
        }, { transaction: t });
        
        logger.info(`📉 Portefeuille ajusté pour l'utilisateur ${userId} : -${amount} TWC`);
      }

      // Ajuster l'offre en circulation de la monnaie
      const currency = await VirtualCurrency.findByPk(currencyId, { transaction: t });
      if (currency) {
        await currency.update({
          circulatingSupply: parseFloat(currency.circulatingSupply) - amount
        }, { transaction: t });
        
        logger.info(`📉 Offre en circulation ajustée pour ${currency.symbol} : -${amount}`);
      }
    }

    // 3. Supprimer physiquement les transactions d'achat
    const deletedCount = await Transaction.destroy({
      where: {
        type: 'PURCHASE'
      },
      transaction: t
    });

    logger.info(`🗑️ ${deletedCount} transactions supprimées de la base de données.`);

    // 4. Valider la transaction
    await t.commit();
    logger.info('✨ Nettoyage de l\'économie terminé avec succès !');
    
  } catch (error) {
    if (t) await t.rollback();
    logger.error('❌ Erreur lors du nettoyage de l\'économie :', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

// Exécuter le script
cleanupEconomy();
