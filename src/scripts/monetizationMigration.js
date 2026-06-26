const { DataTypes } = require('sequelize');
const logger = require('../utils/logger');

/**
 * Migration pour créer la table monetization_metrics
 */
async function createMonetizationTable(sequelize) {
  try {
    logger.info('🔄 Création de la table monetization_metrics...');

    await sequelize.getQueryInterface().createTable('monetization_metrics', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      tweet_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'tweets',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      views: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      eligible_clicks: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      revenue: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0.00
      },
      rpm: {
        type: DataTypes.DECIMAL(10, 4),
        defaultValue: 0.0000
      },
      is_eligible: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      last_updated: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
      },
      created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
      },
      updated_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
      }
    });

    // Créer les index pour optimiser les performances
    await sequelize.getQueryInterface().addIndex('monetization_metrics', ['tweet_id']);
    await sequelize.getQueryInterface().addIndex('monetization_metrics', ['is_eligible']);
    await sequelize.getQueryInterface().addIndex('monetization_metrics', ['last_updated']);

    logger.info('✅ Table monetization_metrics créée avec succès');
    return true;

  } catch (error) {
    logger.error('❌ Erreur lors de la création de la table monetization_metrics:', error);
    return false;
  }
}

/**
 * Migration pour ajouter des données de test
 */
async function seedMonetizationData(sequelize) {
  try {
    logger.info('🔄 Ajout de données de test pour la monétisation...');

    const { Tweet, MonetizationMetrics } = require('../models');

    // Récupérer quelques tweets existants
    const tweets = await Tweet.findAll({
      limit: 10,
      where: {
        moderation_status: 'approved',
        deleted_at: null
      }
    });

    const testData = [];
    
    for (const tweet of tweets) {
      // Générer des données de test réalistes
      const views = Math.floor(Math.random() * 50000) + 1000; // 1000-51000 vues
      const clickRate = Math.random() * 0.05; // 0-5% de taux de clic
      const clicks = Math.floor(views * clickRate);
      const cpc = 0.01 + Math.random() * 0.09; // 0.01-0.10€ par clic
      const revenue = clicks * cpc;
      const rpm = views > 0 ? (revenue / views) * 1000 : 0;

      testData.push({
        tweet_id: tweet.id,
        views: views,
        eligible_clicks: clicks,
        revenue: revenue.toFixed(2),
        rpm: rpm.toFixed(4),
        is_eligible: views >= 1000 && clicks > 0,
        last_updated: new Date()
      });
    }

    if (testData.length > 0) {
      await MonetizationMetrics.bulkCreate(testData);
      logger.info(`✅ ${testData.length} enregistrements de test ajoutés`);
    }

    return true;

  } catch (error) {
    logger.error('❌ Erreur lors de l\'ajout des données de test:', error);
    return false;
  }
}

/**
 * Migration complète pour la monétisation
 */
async function runMonetizationMigration(sequelize) {
  try {
    logger.info('🚀 Début de la migration de monétisation...');

    // Vérifier si la table existe déjà
    const tableExists = await sequelize.getQueryInterface().showAllTables()
      .then(tables => tables.includes('monetization_metrics'));

    if (tableExists) {
      logger.info('ℹ️ Table monetization_metrics existe déjà, mise à jour...');
    } else {
      const tableCreated = await createMonetizationTable(sequelize);
      if (!tableCreated) {
        throw new Error('Impossible de créer la table monetization_metrics');
      }
    }

    // Ajouter des données de test
    const dataSeeded = await seedMonetizationData(sequelize);
    if (!dataSeeded) {
      logger.warn('⚠️ Impossible d\'ajouter les données de test');
    }

    logger.info('✅ Migration de monétisation terminée avec succès');
    return true;

  } catch (error) {
    logger.error('❌ Erreur lors de la migration de monétisation:', error);
    return false;
  }
}

module.exports = {
  createMonetizationTable,
  seedMonetizationData,
  runMonetizationMigration
};
