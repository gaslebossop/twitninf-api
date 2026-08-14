const { sequelize } = require('../database');
const User = require('../models/User');
const logger = require('../utils/logger');

async function runAutoMigration() {
  try {
    logger.info('🔄 Démarrage de la migration automatique...');
    
    // Vérifier la connexion à la base de données
    await sequelize.authenticate();
    logger.info('✅ Connexion à la base de données établie');

    // Colonnes / tables similarity & shadowban (doit exister avant tout User.find* Sequelize)
    try {
      await sequelize.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS algorithmic_visibility_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0;
      `);
      logger.info('✅ Colonne algorithmic_visibility_multiplier vérifiée');
    } catch (e) {
      logger.warn('⚠️ algorithmic_visibility_multiplier:', e.message);
    }

    try {
      await sequelize.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    } catch (e) {
      logger.warn('⚠️ uuid-ossp (ignoré si pas les droits):', e.message);
    }

    // Concours : nouvelle valeur du type de tweet. `sequelize.sync()` crée
    // bien les tables `contests` / `contest_entries` à partir des modèles,
    // mais il n'ajoute JAMAIS une valeur à un ENUM déjà créé en base : sans
    // ce bloc, toute publication de concours échoue en production sur
    // « invalid input value for enum enum_tweets_tweet_type: "concours" ».
    try {
      await sequelize.query(`
        ALTER TYPE "enum_tweets_tweet_type" ADD VALUE IF NOT EXISTS 'concours';
      `);
      logger.info('✅ Type de tweet "concours" vérifié');
    } catch (e) {
      logger.warn('⚠️ enum tweet_type concours:', e.message);
    }

    // Séquestre des concours. Même raison que ci-dessus : `sync()` crée la
    // table `contests` mais n'y AJOUTE jamais une colonne une fois qu'elle
    // existe — et elle existe déjà en production, avec des lignes dedans.
    // Sans ce bloc, toute création de concours échoue sur une colonne
    // manquante.
    try {
      await sequelize.query(`
        DO $$ BEGIN
          CREATE TYPE "enum_contests_escrow_status" AS ENUM ('none','held','paid','refunded');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
      `);
      await sequelize.query(`
        ALTER TABLE contests
          ADD COLUMN IF NOT EXISTS currency_id UUID NULL REFERENCES virtual_currencies(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS escrow_total DECIMAL(20,8) NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS escrow_status "enum_contests_escrow_status" NOT NULL DEFAULT 'none';
      `);
      await sequelize.query('ALTER TABLE contests ALTER COLUMN prize_amount TYPE DECIMAL(20,8);');
      await sequelize.query(
        'CREATE INDEX IF NOT EXISTS idx_contests_currency ON contests (currency_id);'
      );
      logger.info('✅ Colonnes de séquestre des concours vérifiées');
    } catch (e) {
      logger.warn('⚠️ séquestre concours:', e.message);
    }

    // Consentement RGPD. Le DDL doit vivre ICI et pas seulement dans
    // database/migrate.js : ce dernier est un script en ligne de commande, il
    // n'est pas joué au démarrage. `sequelize.sync()` crée bien la table
    // user_consent_records à partir du modèle, mais il n'ajoute AUCUNE colonne
    // à une table existante — sans ce bloc, users reste sans les colonnes de
    // consentement et /api/auth/consent échoue en production.
    try {
      await sequelize.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS consent_version VARCHAR(20) NULL,
          ADD COLUMN IF NOT EXISTS consent_accepted_at TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS consent_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
      `);
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS user_consent_records (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          consent_version VARCHAR(20) NOT NULL,
          purpose VARCHAR(40) NOT NULL,
          granted BOOLEAN NOT NULL,
          required BOOLEAN NOT NULL,
          source VARCHAR(24) NOT NULL,
          platform VARCHAR(32) NULL,
          app_version VARCHAR(32) NULL,
          ip_fingerprint VARCHAR(64) NULL,
          user_agent VARCHAR(255) NULL,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await sequelize.query(`
        CREATE INDEX IF NOT EXISTS idx_user_consent_records_user_recorded
          ON user_consent_records (user_id, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_user_consent_records_purpose
          ON user_consent_records (purpose, granted);
      `);
      logger.info('✅ Schéma de consentement RGPD vérifié');
    } catch (e) {
      logger.warn('⚠️ consentement RGPD:', e.message);
    }

    // Étape d'abonnements de l'inscription. Une colonne dédiée plutôt qu'un
    // simple `following_count >= 3` : quelqu'un qui se désabonne ensuite ne
    // doit pas se voir reposer l'écran d'inscription des mois plus tard.
    try {
      await sequelize.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS follow_onboarding_completed_at TIMESTAMPTZ NULL;
      `);
      logger.info('✅ Colonne follow_onboarding_completed_at vérifiée');
    } catch (e) {
      logger.warn('⚠️ follow_onboarding_completed_at:', e.message);
    }

    try {
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
      logger.info('✅ Table feed_hashtag_rules vérifiée');
    } catch (e) {
      logger.warn('⚠️ feed_hashtag_rules:', e.message);
    }

    // Index Spotlight : `sync()` crée bien la nouvelle table daily_spotlights,
    // mais n'ajoute aucun index à une table EXISTANTE comme tweet_likes.
    try {
      await sequelize.query(`
        CREATE INDEX IF NOT EXISTS tweet_likes_created_at_tweet_id
          ON tweet_likes (created_at, tweet_id);
      `);
      logger.info('✅ Index tweet_likes_created_at_tweet_id vérifié');
    } catch (e) {
      logger.warn('⚠️ index tweet_likes (Spotlight):', e.message);
    }

    // Réactions aux messages : le sélecteur libre accepte les emojis composés,
    // qui dépassent les 8 caractères d'origine (« 👨‍👩‍👧‍👦 » en fait 11).
    // `sync()` ne modifie jamais une colonne existante — d'où ce DDL.
    try {
      await sequelize.query(`
        ALTER TABLE message_reactions ALTER COLUMN emoji TYPE VARCHAR(32);
      `);
      logger.info('✅ Colonne message_reactions.emoji vérifiée (VARCHAR 32)');
    } catch (e) {
      logger.warn('⚠️ message_reactions.emoji:', e.message);
    }

    // Vérifier si les colonnes de modération existent
    const tableInfo = await sequelize.getQueryInterface().describeTable('users');
    const needsMigration = !tableInfo.role || !tableInfo.moderation_permissions || !tableInfo.moderation_history;

    if (needsMigration) {
      logger.info('📝 Colonnes de modération manquantes, ajout en cours...');
      
      // Ajouter les colonnes manquantes
      const alterQueries = [];
      
      if (!tableInfo.role) {
        alterQueries.push(`
          ALTER TABLE users 
          ADD COLUMN role VARCHAR(20) DEFAULT 'user' NOT NULL,
          ADD CONSTRAINT check_role CHECK (role IN ('user', 'moderator', 'admin', 'superadmin', 'classeurdetweets'))
        `);
      }
      
      if (!tableInfo.moderation_permissions) {
        alterQueries.push(`
          ALTER TABLE users 
          ADD COLUMN moderation_permissions JSONB DEFAULT '{"can_ban_users": false, "can_suspend_users": false, "can_delete_tweets": false, "can_verify_users": false, "can_view_reports": false, "can_view_analytics": false, "can_manage_moderators": false}'::jsonb
        `);
      }
      
      if (!tableInfo.moderation_history) {
        alterQueries.push(`
          ALTER TABLE users 
          ADD COLUMN moderation_history JSONB DEFAULT '[]'::jsonb
        `);
      }

      // Exécuter les requêtes d'alteration
      for (const query of alterQueries) {
        try {
          await sequelize.query(query);
          logger.info('✅ Colonne ajoutée avec succès');
        } catch (error) {
          logger.warn('⚠️ Erreur lors de l\'ajout de colonne (peut-être déjà existante):', error.message);
        }
      }
      
      logger.info('✅ Migration des colonnes terminée');
    } else {
      logger.info('✅ Toutes les colonnes de modération existent déjà');
    }

    // Définir l'utilisateur "g" comme admin
    try {
      const userG = await User.findOne({
        where: { username: 'g' }
      });

      if (userG) {
        // Mettre à jour l'utilisateur "g" pour le rendre admin
        await userG.update({
          role: 'superadmin',
          moderation_permissions: {
            can_ban_users: true,
            can_suspend_users: true,
            can_delete_tweets: true,
            can_verify_users: true,
            can_view_reports: true,
            can_view_analytics: true,
            can_manage_moderators: true
          }
        });

        logger.info('👑 Utilisateur "g" promu au rang de superadmin');
        console.log('🎉 Utilisateur "g" est maintenant superadmin avec toutes les permissions!');
      } else {
        logger.warn('⚠️ Utilisateur "g" non trouvé - impossible de le promouvoir admin');
      }
    } catch (error) {
      logger.error('❌ Erreur lors de la promotion de l\'utilisateur "g":', error.message);
    }

    logger.info('✅ Migration automatique terminée avec succès');

  } catch (error) {
    logger.error('❌ Erreur lors de la migration automatique:', error);
    console.error('❌ Erreur de migration:', error.message);
  }
}

module.exports = runAutoMigration;
