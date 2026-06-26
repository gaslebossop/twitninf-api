const { sequelize } = require('../database/index');
const logger = require('../utils/logger');

/**
 * Script de migration vers le nouveau système économique
 * Ajoute les nouvelles colonnes nécessaires et retire les anciennes
 */
async function migrateToNewEconomy() {
  try {
    logger.info('🔄 Début de la migration vers le nouveau système économique...');

    // Commencer une transaction pour la migration
    const transaction = await sequelize.transaction();

    try {
      // 1. Modifier la table virtual_currencies
      logger.info('📊 Modification de la table virtual_currencies...');

      // Ajouter les nouvelles colonnes économiques
      await sequelize.getQueryInterface().addColumn('virtual_currencies', 'base_price', {
        type: sequelize.Sequelize.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 0.01,
        comment: 'Prix de base en euros (ex: 0.01€ = 1 centime)'
      }, { transaction });

      await sequelize.getQueryInterface().addColumn('virtual_currencies', 'current_multiplier', {
        type: sequelize.Sequelize.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 1.0,
        comment: 'Multiplicateur de prix actuel basé sur l\'économie'
      }, { transaction });

      await sequelize.getQueryInterface().addColumn('virtual_currencies', 'purchase_bonus', {
        type: sequelize.Sequelize.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 0,
        comment: 'Bonus d\'achat en pourcentage (0.10 = 10% bonus)'
      }, { transaction });

      await sequelize.getQueryInterface().addColumn('virtual_currencies', 'economic_trend', {
        type: sequelize.Sequelize.ENUM('stable', 'rising', 'falling'),
        allowNull: false,
        defaultValue: 'stable',
        comment: 'Tendance économique actuelle'
      }, { transaction });

      await sequelize.getQueryInterface().addColumn('virtual_currencies', 'purchase_packages', {
        type: sequelize.Sequelize.JSONB,
        allowNull: false,
        defaultValue: '[]',
        comment: 'Packages d\'achat disponibles avec bonus'
      }, { transaction });

      // Supprimer les anciennes colonnes de minage
      try {
        await sequelize.getQueryInterface().removeColumn('virtual_currencies', 'inflation_rate', { transaction });
        logger.info('✅ Colonne inflation_rate supprimée');
      } catch (error) {
        logger.warn('⚠️ Colonne inflation_rate non trouvée, ignorée');
      }

      try {
        await sequelize.getQueryInterface().removeColumn('virtual_currencies', 'mining_reward', { transaction });
        logger.info('✅ Colonne mining_reward supprimée');
      } catch (error) {
        logger.warn('⚠️ Colonne mining_reward non trouvée, ignorée');
      }

      try {
        await sequelize.getQueryInterface().removeColumn('virtual_currencies', 'max_mining_per_day', { transaction });
        logger.info('✅ Colonne max_mining_per_day supprimée');
      } catch (error) {
        logger.warn('⚠️ Colonne max_mining_per_day non trouvée, ignorée');
      }

      // 2. Modifier la table user_wallets
      logger.info('👛 Modification de la table user_wallets...');

      // Ajouter les nouvelles colonnes de portefeuille
      await sequelize.getQueryInterface().addColumn('user_wallets', 'total_purchased', {
        type: sequelize.Sequelize.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 0,
        comment: 'Total acheté avec de l\'argent réel'
      }, { transaction });

      await sequelize.getQueryInterface().addColumn('user_wallets', 'loyalty_points', {
        type: sequelize.Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Points de fidélité pour les bonus d\'achat'
      }, { transaction });

      await sequelize.getQueryInterface().addColumn('user_wallets', 'last_purchase_date', {
        type: sequelize.Sequelize.DATE,
        allowNull: true,
        comment: 'Dernière date d\'achat'
      }, { transaction });

      // Supprimer les anciennes colonnes de minage
      try {
        await sequelize.getQueryInterface().removeColumn('user_wallets', 'last_mining_date', { transaction });
        logger.info('✅ Colonne last_mining_date supprimée');
      } catch (error) {
        logger.warn('⚠️ Colonne last_mining_date non trouvée, ignorée');
      }

      try {
        await sequelize.getQueryInterface().removeColumn('user_wallets', 'daily_mining_count', { transaction });
        logger.info('✅ Colonne daily_mining_count supprimée');
      } catch (error) {
        logger.warn('⚠️ Colonne daily_mining_count non trouvée, ignorée');
      }

      // 3. Mettre à jour les données existantes
      logger.info('🔄 Mise à jour des données existantes...');

      // Mettre à jour toutes les cryptomonnaies existantes
      await sequelize.query(`
        UPDATE virtual_currencies 
        SET 
          base_price = 0.01,
          current_multiplier = 1.0,
          purchase_bonus = 0.0,
          economic_trend = 'stable',
          purchase_packages = '[
            {"id": "small", "name": "Pack Starter", "coins": 100, "price": 0.99, "popular": false},
            {"id": "medium", "name": "Pack Popular", "coins": 500, "price": 4.99, "popular": true},
            {"id": "large", "name": "Pack Premium", "coins": 1200, "price": 9.99, "popular": false},
            {"id": "mega", "name": "Pack Elite", "coins": 2500, "price": 19.99, "popular": false},
            {"id": "ultimate", "name": "Pack Ultimate", "coins": 6000, "price": 49.99, "popular": false}
          ]'::jsonb,
          current_price = 0.01,
          description = COALESCE(description, 'TwitCoins - La cryptomonnaie officielle de TwitNin. Achetez avec de l''argent réel pour débloquer des fonctionnalités premium.')
        WHERE is_active = true
      `, { transaction });

      // Initialiser les nouvelles colonnes des portefeuilles
      await sequelize.query(`
        UPDATE user_wallets 
        SET 
          total_purchased = 0,
          loyalty_points = 0,
          last_purchase_date = NULL
        WHERE total_purchased IS NULL
      `, { transaction });

      // 4. Créer des index pour optimiser les performances
      logger.info('📊 Création des index d\'optimisation...');

      try {
        await sequelize.getQueryInterface().addIndex('virtual_currencies', ['economic_trend'], {
          name: 'idx_virtual_currencies_economic_trend',
          transaction
        });
      } catch (error) {
        logger.warn('⚠️ Index economic_trend déjà existant');
      }

      try {
        await sequelize.getQueryInterface().addIndex('user_wallets', ['total_purchased'], {
          name: 'idx_user_wallets_total_purchased',
          transaction
        });
      } catch (error) {
        logger.warn('⚠️ Index total_purchased déjà existant');
      }

      try {
        await sequelize.getQueryInterface().addIndex('user_wallets', ['loyalty_points'], {
          name: 'idx_user_wallets_loyalty_points',
          transaction
        });
      } catch (error) {
        logger.warn('⚠️ Index loyalty_points déjà existant');
      }

      // Valider la transaction
      await transaction.commit();

      logger.info('✅ Migration vers le nouveau système économique terminée avec succès !');

      // Afficher un résumé
      const currencyCount = await sequelize.query(
        'SELECT COUNT(*) as count FROM virtual_currencies WHERE is_active = true',
        { type: sequelize.QueryTypes.SELECT }
      );

      const walletCount = await sequelize.query(
        'SELECT COUNT(*) as count FROM user_wallets',
        { type: sequelize.QueryTypes.SELECT }
      );

      logger.info('📊 Résumé de la migration:');
      logger.info(`   • Cryptomonnaies actives: ${currencyCount[0].count}`);
      logger.info(`   • Portefeuilles mis à jour: ${walletCount[0].count}`);
      logger.info('   • Nouvelles colonnes ajoutées: 8');
      logger.info('   • Anciennes colonnes supprimées: 5');
      logger.info('   • Index créés: 3');

      logger.info('🎉 Le nouveau système économique est maintenant prêt !');
      logger.info('💡 Prochaines étapes:');
      logger.info('   1. Exécuter: node src/scripts/initNewEconomy.js');
      logger.info('   2. Tester: node ../test-new-economy.js');
      logger.info('   3. Démarrer l\'API: npm run dev');

    } catch (error) {
      // Annuler la transaction en cas d'erreur
      await transaction.rollback();
      throw error;
    }

  } catch (error) {
    logger.error('❌ Erreur lors de la migration:', error);
    throw error;
  }
}

// Exécuter la migration si appelée directement
if (require.main === module) {
  migrateToNewEconomy()
    .then(() => {
      logger.info('✅ Migration terminée avec succès');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Erreur fatale:', error);
      process.exit(1);
    });
}

module.exports = { migrateToNewEconomy };
