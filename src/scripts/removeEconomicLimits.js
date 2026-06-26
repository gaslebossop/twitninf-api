const { sequelize } = require('../database/index');
const logger = require('../utils/logger');

/**
 * Script pour supprimer les limites économiques
 * Met à jour la base de données pour permettre des variations illimitées
 */
async function removeEconomicLimits() {
  try {
    logger.info('🔄 Suppression des limites économiques...');

    // Commencer une transaction pour la migration
    const transaction = await sequelize.transaction();

    try {
      // 1. Modifier la précision des colonnes économiques
      logger.info('📊 Mise à jour de la précision des colonnes économiques...');

      // Modifier current_multiplier pour permettre des valeurs plus grandes
      await sequelize.getQueryInterface().changeColumn('virtual_currencies', 'current_multiplier', {
        type: sequelize.Sequelize.DECIMAL(20, 8),
        allowNull: false,
        comment: 'Multiplicateur de prix actuel basé sur l\'économie (sans limite)'
      }, { transaction });

      // Modifier purchase_bonus pour permettre des valeurs plus grandes
      await sequelize.getQueryInterface().changeColumn('virtual_currencies', 'purchase_bonus', {
        type: sequelize.Sequelize.DECIMAL(20, 8),
        allowNull: false,
        comment: 'Bonus d\'achat en pourcentage (0.10 = 10% bonus, sans limite)'
      }, { transaction });

      // 2. Mettre à jour les commentaires des colonnes
      logger.info('📝 Mise à jour des commentaires...');

      // Mettre à jour les commentaires pour refléter l'absence de limites
      await sequelize.query(`
        COMMENT ON COLUMN virtual_currencies.current_multiplier IS 'Multiplicateur de prix actuel basé sur l''économie (sans limite)';
      `, { transaction });

      await sequelize.query(`
        COMMENT ON COLUMN virtual_currencies.purchase_bonus IS 'Bonus d''achat en pourcentage (0.10 = 10% bonus, sans limite)';
      `, { transaction });

      // 3. Valider les changements
      await transaction.commit();

      logger.info('✅ Limites économiques supprimées avec succès!');
      logger.info('📊 Les colonnes économiques supportent maintenant des valeurs illimitées');
      logger.info('💰 Le multiplicateur peut maintenant dépasser 2.0 et descendre en dessous de 0.5');
      logger.info('🎁 Le bonus peut maintenant dépasser 25% et être négatif');

    } catch (error) {
      await transaction.rollback();
      throw error;
    }

  } catch (error) {
    logger.error('❌ Erreur lors de la suppression des limites:', error);
    throw error;
  }
}

// Exécuter le script si appelé directement
if (require.main === module) {
  removeEconomicLimits()
    .then(() => {
      logger.info('🎉 Migration terminée avec succès!');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('💥 Échec de la migration:', error);
      process.exit(1);
    });
}

module.exports = { removeEconomicLimits };
