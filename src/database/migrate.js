const { sequelize } = require('./index');
const User = require('../models/User');
const logger = require('../utils/logger');
const config = require('../config/config');

// Fonction pour créer les extensions PostgreSQL nécessaires
async function createExtensions() {
  try {
    // Extension pour UUID
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    
    // Extension pour les fonctions JSONB
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS "pg_trgm"');
    
    // Extension pour les index GIN
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS "btree_gin"');
    
    logger.info('Extensions PostgreSQL créées avec succès');
  } catch (error) {
    logger.error('Erreur lors de la création des extensions:', error);
    throw error;
  }
}

// Fonction pour créer les index optimisés
async function createOptimizedIndexes() {
  try {
    // Index partiels pour les utilisateurs actifs
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_users_active_verified 
      ON users (verified, premium) 
      WHERE is_active = true
    `);

    // Index pour les recherches textuelles
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username_trgm 
      ON users USING gin (username gin_trgm_ops)
    `);

    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_users_full_name_trgm 
      ON users USING gin (full_name gin_trgm_ops)
    `);

    // Index pour les statistiques
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_users_stats_followers 
      ON users USING gin ((stats->>'followers'))
    `);

    // Index pour les préférences
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_users_preferences_language 
      ON users USING gin ((preferences->>'language'))
    `);

    // Index pour les dates
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_users_created_at_btree 
      ON users (created_at DESC)
    `);

    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_users_last_activity_btree 
      ON users (last_activity DESC)
    `);

    logger.info('Index optimisés créés avec succès');
  } catch (error) {
    logger.error('Erreur lors de la création des index:', error);
    throw error;
  }
}

// Fonction pour créer les vues optimisées
async function createOptimizedViews() {
  try {
    // Vue pour les utilisateurs populaires
    await sequelize.query(`
      CREATE OR REPLACE VIEW popular_users AS
      SELECT 
        id, username, full_name, avatar, verified, premium,
        stats->>'followers' as followers_count,
        stats->>'following' as following_count,
        stats->>'tweets' as tweets_count,
        created_at, last_activity
      FROM users 
      WHERE is_active = true 
      ORDER BY (stats->>'followers')::integer DESC
    `);

    // Vue pour les utilisateurs récents
    await sequelize.query(`
      CREATE OR REPLACE VIEW recent_users AS
      SELECT 
        id, username, full_name, avatar, verified, premium,
        created_at, last_activity
      FROM users 
      WHERE is_active = true 
      AND created_at >= NOW() - INTERVAL '30 days'
      ORDER BY created_at DESC
    `);

    // Vue pour les statistiques globales
    await sequelize.query(`
      CREATE OR REPLACE VIEW global_stats AS
      SELECT 
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE verified = true) as verified_users,
        COUNT(*) FILTER (WHERE premium = true) as premium_users,
        COUNT(*) FILTER (WHERE last_activity >= NOW() - INTERVAL '24 hours') as active_today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as new_this_week,
        AVG((stats->>'followers')::integer) as avg_followers,
        AVG((stats->>'tweets')::integer) as avg_tweets
      FROM users 
      WHERE is_active = true
    `);

    logger.info('Vues optimisées créées avec succès');
  } catch (error) {
    logger.error('Erreur lors de la création des vues:', error);
    throw error;
  }
}

// Fonction pour créer les fonctions PostgreSQL
async function createDatabaseFunctions() {
  try {
    // Fonction pour mettre à jour les statistiques
    await sequelize.query(`
      CREATE OR REPLACE FUNCTION update_user_stats(
        user_id UUID,
        stat_type TEXT,
        increment INTEGER DEFAULT 1
      ) RETURNS VOID AS $$
      BEGIN
        UPDATE users 
        SET stats = jsonb_set(
          stats, 
          ARRAY[stat_type], 
          to_jsonb((COALESCE(stats->>stat_type, '0')::integer + increment)::text)
        )
        WHERE id = user_id;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Fonction pour rechercher des utilisateurs
    await sequelize.query(`
      CREATE OR REPLACE FUNCTION search_users(search_query TEXT, max_results INTEGER DEFAULT 10)
      RETURNS TABLE(
        id UUID,
        username TEXT,
        full_name TEXT,
        avatar TEXT,
        verified BOOLEAN,
        premium BOOLEAN,
        similarity REAL
      ) AS $$
      BEGIN
        RETURN QUERY
        SELECT 
          u.id,
          u.username,
          u.full_name,
          u.avatar,
          u.verified,
          u.premium,
          GREATEST(
            similarity(u.username, search_query),
            similarity(u.full_name, search_query)
          ) as similarity
        FROM users u
        WHERE u.is_active = true
        AND (
          u.username ILIKE '%' || search_query || '%'
          OR u.full_name ILIKE '%' || search_query || '%'
        )
        ORDER BY similarity DESC, u.created_at DESC
        LIMIT max_results;
      END;
      $$ LANGUAGE plpgsql;
    `);

    logger.info('Fonctions PostgreSQL créées avec succès');
  } catch (error) {
    logger.error('Erreur lors de la création des fonctions:', error);
    throw error;
  }
}

// Fonction principale de migration
async function runMigrations() {
  try {
    logger.info('Début des migrations PostgreSQL...');

    // Tester la connexion
    await sequelize.authenticate();
    logger.info('Connexion PostgreSQL établie');

    // Créer les extensions
    await createExtensions();

    // Synchroniser les modèles (créer les tables). Utiliser alter pour ajouter les nouvelles colonnes si besoin
    await sequelize.sync({ force: false, alter: true });
    logger.info('Tables synchronisées');

    // S'assurer que les nouvelles colonnes de gestion de bans existent
    await sequelize.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS ban_count INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP NULL,
      ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP NULL,
      ADD COLUMN IF NOT EXISTS suspension_reason TEXT NULL,
      ADD COLUMN IF NOT EXISTS suspension_meta JSONB DEFAULT '{}'::jsonb;
    `);
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_users_suspension ON users (is_suspended, suspended_until);
    `);

    // Profil : bio (sync alter ne l’ajoute pas toujours en prod)
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NULL;
    `);

    // Profil : bannière (URL publique ; le fichier migrations/*.js n’est pas exécuté par ce script)
    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banner TEXT NULL;
    `);

    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS algorithmic_visibility_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0;
    `);

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS feed_hashtag_rules (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tag_normalized VARCHAR(200) NOT NULL UNIQUE,
        multiplier DOUBLE PRECISION NOT NULL,
        note TEXT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_feed_hashtag_rules_tag ON feed_hashtag_rules (tag_normalized);
    `);

    // Créer les index optimisés
    await createOptimizedIndexes();

    // Créer les vues optimisées
    await createOptimizedViews();

    // Créer les fonctions
    await createDatabaseFunctions();

    logger.info('Migrations terminées avec succès');
  } catch (error) {
    logger.error('Erreur lors des migrations:', error);
    throw error;
  }
}

// Fonction pour annuler les migrations
async function rollbackMigrations() {
  try {
    logger.info('Annulation des migrations...');

    // Supprimer les vues
    await sequelize.query('DROP VIEW IF EXISTS popular_users CASCADE');
    await sequelize.query('DROP VIEW IF EXISTS recent_users CASCADE');
    await sequelize.query('DROP VIEW IF EXISTS global_stats CASCADE');

    // Supprimer les fonctions
    await sequelize.query('DROP FUNCTION IF EXISTS update_user_stats(UUID, TEXT, INTEGER) CASCADE');
    await sequelize.query('DROP FUNCTION IF EXISTS search_users(TEXT, INTEGER) CASCADE');

    // Supprimer les tables
    await sequelize.drop();

    logger.info('Migrations annulées avec succès');
  } catch (error) {
    logger.error('Erreur lors de l\'annulation des migrations:', error);
    throw error;
  }
}

// Gestion des arguments de ligne de commande
const command = process.argv[2];

if (command === 'up') {
  runMigrations()
    .then(() => {
      logger.info('Migration terminée');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Erreur de migration:', error);
      process.exit(1);
    });
} else if (command === 'down') {
  rollbackMigrations()
    .then(() => {
      logger.info('Rollback terminé');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Erreur de rollback:', error);
      process.exit(1);
    });
} else {
  // Migration par défaut
  runMigrations()
    .then(() => {
      logger.info('Migration terminée');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Erreur de migration:', error);
      process.exit(1);
    });
}

module.exports = {
  runMigrations,
  rollbackMigrations,
  createExtensions,
  createOptimizedIndexes,
  createOptimizedViews,
  createDatabaseFunctions
};
