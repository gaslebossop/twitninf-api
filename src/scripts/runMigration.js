/**
 * Script pour exécuter la migration de la colonne recommendation_group
 */

const { sequelize } = require('../models');
const logger = require('../utils/logger');

async function runMigration() {
  try {
    logger.info('🚀 Démarrage de la migration recommendation_group...');

    // Vérifier la connexion à la base de données
    await sequelize.authenticate();
    logger.info('✅ Connexion à la base de données établie');

    // Exécuter la migration
    const migration = require('../migrations/20250913-add-recommendation-group-to-tweets');
    
    logger.info('📝 Ajout de la colonne recommendation_group...');
    await migration.up(sequelize.getQueryInterface(), sequelize.Sequelize);
    
    logger.info('✅ Migration terminée avec succès !');
    logger.info('📊 Tous les tweets existants sont maintenant dans le groupe "initial"');

    // Vérifier que la colonne a été ajoutée
    const [results] = await sequelize.query(`
      SELECT column_name, data_type, is_nullable, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'tweets' AND column_name = 'recommendation_group'
    `);

    if (results.length > 0) {
      logger.info('✅ Colonne recommendation_group ajoutée avec succès');
      logger.info(`   Type: ${results[0].data_type}`);
      logger.info(`   Nullable: ${results[0].is_nullable}`);
      logger.info(`   Default: ${results[0].column_default}`);
    } else {
      logger.error('❌ La colonne recommendation_group n\'a pas été trouvée');
    }

  } catch (error) {
    logger.error('❌ Erreur lors de la migration:', error);
    throw error;
  } finally {
    await sequelize.close();
  }
}

// Exécuter la migration si le script est lancé directement
if (require.main === module) {
  runMigration()
    .then(() => {
      logger.info('✅ Migration terminée');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Erreur lors de la migration:', error);
      process.exit(1);
    });
}

module.exports = runMigration;
