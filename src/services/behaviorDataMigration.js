/**
 * 🔄 Service de Migration Automatique des Données Comportementales
 * 
 * Gère la création, migration et initialisation des tables de données
 * comportementales au démarrage de l'API
 */

const { sequelize, UserBehaviorData, UserPreferences, User } = require('../models');
const logger = require('../utils/logger');

class BehaviorDataMigration {
  constructor() {
    this.migrationStatus = {
      userBehaviorData: false,
      userPreferences: false,
      initialized: false
    };
  }

  /**
   * 🚀 Initialisation complète au démarrage
   */
  async initializeOnStartup() {
    try {
      logger.info('🔄 Début de l\'initialisation des données comportementales...');

      // 1. Vérifier et créer les tables si nécessaire
      await this.checkAndCreateTables();

      // 2. Migrer les données existantes si nécessaire
      await this.migrateExistingData();

      // 3. Initialiser les préférences par défaut pour les utilisateurs existants
      await this.initializeDefaultPreferences();

      // 4. Nettoyer les anciennes données
      await this.cleanupOldData();

      this.migrationStatus.initialized = true;
      logger.info('✅ Initialisation des données comportementales terminée avec succès');

      return this.migrationStatus;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation des données comportementales:', error);
      throw error;
    }
  }

  /**
   * 🏗️ Vérification et création des tables
   */
  async checkAndCreateTables() {
    try {
      logger.info('🏗️ Vérification des tables de données comportementales...');

      // Vérifier si les tables existent
      const userBehaviorTableExists = await this.checkTableExists('user_behavior_data');
      const userPreferencesTableExists = await this.checkTableExists('user_preferences');

      if (!userBehaviorTableExists) {
        logger.info('🔨 Création de la table user_behavior_data...');
        await UserBehaviorData.sync({ force: false });
        this.migrationStatus.userBehaviorData = true;
        logger.info('✅ Table user_behavior_data créée avec succès');
      } else {
        logger.info('✅ Table user_behavior_data déjà existante');
        this.migrationStatus.userBehaviorData = true;
      }

      if (!userPreferencesTableExists) {
        logger.info('🔨 Création de la table user_preferences...');
        await UserPreferences.sync({ force: false });
        this.migrationStatus.userPreferences = true;
        logger.info('✅ Table user_preferences créée avec succès');
      } else {
        logger.info('✅ Table user_preferences déjà existante');
        this.migrationStatus.userPreferences = true;
      }

      // Créer les index pour optimiser les performances
      await this.createPerformanceIndexes();

    } catch (error) {
      logger.error('❌ Erreur création des tables:', error);
      throw error;
    }
  }

  /**
   * 🔍 Vérifier si une table existe
   */
  async checkTableExists(tableName) {
    try {
      const queryInterface = sequelize.getQueryInterface();
      const tables = await queryInterface.showAllTables();
      return tables.includes(tableName);
    } catch (error) {
      logger.error(`❌ Erreur vérification table ${tableName}:`, error);
      return false;
    }
  }

  /**
   * 📊 Créer les index de performance
   */
  async createPerformanceIndexes() {
    try {
      logger.info('📊 Création des index de performance...');

      const queryInterface = sequelize.getQueryInterface();

      // Index pour user_behavior_data
      try {
        await queryInterface.addIndex('user_behavior_data', ['user_id', 'timestamp'], {
          name: 'idx_user_behavior_user_time',
          concurrently: true
        });
      } catch (error) {
        // Index peut déjà exister
        if (!error.message.includes('already exists')) {
          logger.warn('⚠️ Erreur création index user_behavior:', error.message);
        }
      }

      try {
        await queryInterface.addIndex('user_behavior_data', ['action_type', 'timestamp'], {
          name: 'idx_user_behavior_action_time',
          concurrently: true
        });
      } catch (error) {
        if (!error.message.includes('already exists')) {
          logger.warn('⚠️ Erreur création index action_type:', error.message);
        }
      }

      try {
        await queryInterface.addIndex('user_behavior_data', ['target_id', 'target_type'], {
          name: 'idx_user_behavior_target',
          concurrently: true
        });
      } catch (error) {
        if (!error.message.includes('already exists')) {
          logger.warn('⚠️ Erreur création index target:', error.message);
        }
      }

      // Index pour user_preferences
      try {
        await queryInterface.addIndex('user_preferences', ['personalization_score'], {
          name: 'idx_user_preferences_score',
          concurrently: true
        });
      } catch (error) {
        if (!error.message.includes('already exists')) {
          logger.warn('⚠️ Erreur création index score:', error.message);
        }
      }

      logger.info('✅ Index de performance créés');

    } catch (error) {
      logger.error('❌ Erreur création index:', error);
      // Ne pas arrêter le démarrage pour des erreurs d'index
    }
  }

  /**
   * 📦 Migration des données existantes
   */
  async migrateExistingData() {
    try {
      logger.info('📦 Migration des données existantes...');

      // Vérifier s'il y a des données à migrer
      const behaviorCount = await UserBehaviorData.count();
      const preferencesCount = await UserPreferences.count();

      logger.info(`📊 Données existantes: ${behaviorCount} comportements, ${preferencesCount} préférences`);

      // Si c'est une nouvelle installation, pas besoin de migration
      if (behaviorCount === 0 && preferencesCount === 0) {
        logger.info('📦 Nouvelle installation - Aucune migration nécessaire');
        return;
      }

      // Migrer les données si nécessaire
      await this.migrateBehaviorDataFormat();
      await this.migratePreferencesFormat();

      logger.info('✅ Migration des données terminée');

    } catch (error) {
      logger.error('❌ Erreur migration données:', error);
      // Ne pas arrêter le démarrage pour des erreurs de migration
    }
  }

  /**
   * ⚙️ Initialiser les préférences par défaut
   */
  async initializeDefaultPreferences() {
    try {
      logger.info('⚙️ Initialisation des préférences par défaut...');

      // Récupérer tous les utilisateurs sans préférences
      const usersWithoutPreferences = await User.findAll({
        include: [{
          model: UserPreferences,
          as: 'userPreferences',
          required: false
        }],
        where: {
          '$userPreferences.id$': null
        }
      });

      logger.info(`👥 ${usersWithoutPreferences.length} utilisateurs sans préférences trouvés`);

      // Créer les préférences par défaut
      const defaultPreferences = [];
      for (const user of usersWithoutPreferences) {
        defaultPreferences.push({
          user_id: user.id,
          content_preferences: {
            preferred_topics: [],
            blocked_topics: [],
            preferred_languages: ['fr'],
            content_length_preference: 'mixed',
            media_preference: 'mixed'
          },
          engagement_preferences: {
            show_trending: true,
            show_new_content: true,
            discovery_mode: 'balanced',
            interaction_weight: 'balanced'
          },
          temporal_preferences: {
            active_hours: [9, 18],
            timezone: 'Europe/Paris',
            content_freshness: 'mixed',
            notification_frequency: 'normal'
          },
          social_preferences: {
            follow_suggestions: true,
            show_follower_activity: true,
            privacy_level: 'normal',
            interaction_visibility: 'friends'
          },
          algorithm_preferences: {
            preferred_algorithm: 'smart',
            customization_level: 'auto',
            feedback_weight: 1.0,
            exploration_rate: 0.3
          },
          learning_data: {
            explicit_feedback: {},
            implicit_patterns: {},
            preference_confidence: 0.5,
            last_preference_update: new Date()
          },
          personalization_score: 0.5,
          privacy_settings: {
            data_collection_consent: true,
            analytics_consent: true,
            personalization_consent: true,
            third_party_sharing: false,
            data_retention_days: 365
          }
        });
      }

      if (defaultPreferences.length > 0) {
        await UserPreferences.bulkCreate(defaultPreferences, {
          ignoreDuplicates: true
        });

        logger.info(`✅ ${defaultPreferences.length} préférences par défaut créées`);
      } else {
        logger.info('✅ Tous les utilisateurs ont déjà des préférences');
      }

    } catch (error) {
      logger.error('❌ Erreur initialisation préférences:', error);
    }
  }

  /**
   * 🧹 Nettoyage des anciennes données
   */
  async cleanupOldData() {
    try {
      logger.info('🧹 Nettoyage des anciennes données...');

      // Supprimer les données comportementales de plus d'un an
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      const deletedBehaviorData = await UserBehaviorData.destroy({
        where: {
          timestamp: {
            [sequelize.Sequelize.Op.lt]: oneYearAgo
          }
        }
      });

      if (deletedBehaviorData > 0) {
        logger.info(`🗑️ ${deletedBehaviorData} anciennes données comportementales supprimées`);
      }

      // Nettoyer les données de faible qualité
      const deletedLowQuality = await UserBehaviorData.destroy({
        where: {
          interaction_quality: {
            [sequelize.Sequelize.Op.lt]: 0.1
          }
        }
      });

      if (deletedLowQuality > 0) {
        logger.info(`🗑️ ${deletedLowQuality} données de faible qualité supprimées`);
      }

      logger.info('✅ Nettoyage terminé');

    } catch (error) {
      logger.error('❌ Erreur nettoyage:', error);
    }
  }

  /**
   * 📊 Obtenir les statistiques de migration
   */
  async getMigrationStats() {
    try {
      const stats = {
        userBehaviorData: {
          total: await UserBehaviorData.count(),
          processed: await UserBehaviorData.count({ where: { processed: true } }),
          lastWeek: await UserBehaviorData.count({
            where: {
              timestamp: {
                [sequelize.Sequelize.Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
              }
            }
          })
        },
        userPreferences: {
          total: await UserPreferences.count(),
          withCustomization: await UserPreferences.count({
            where: {
              personalization_score: {
                [sequelize.Sequelize.Op.gt]: 0.5
              }
            }
          })
        },
        users: {
          total: await User.count(),
          withBehaviorData: await User.count({
            include: [{
              model: UserBehaviorData,
              as: 'behaviorData',
              required: true
            }]
          })
        }
      };

      return stats;

    } catch (error) {
      logger.error('❌ Erreur récupération stats:', error);
      return null;
    }
  }

  /**
   * 🔄 Méthodes de migration spécifiques
   */
  async migrateBehaviorDataFormat() {
    // Migration du format des données comportementales si nécessaire
    logger.info('🔄 Migration du format des données comportementales...');
    // Implémentation des migrations spécifiques si nécessaire
  }

  async migratePreferencesFormat() {
    // Migration du format des préférences si nécessaire
    logger.info('🔄 Migration du format des préférences...');
    // Implémentation des migrations spécifiques si nécessaire
  }

  /**
   * 🔧 Méthodes utilitaires
   */
  getStatus() {
    return this.migrationStatus;
  }

  isInitialized() {
    return this.migrationStatus.initialized;
  }
}

// Instance singleton
const behaviorDataMigration = new BehaviorDataMigration();

module.exports = behaviorDataMigration;
