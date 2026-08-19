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

    // AUDIT R2-11 (2026-08-19) : `getPopularUsers` trie sur
    // `(stats->>'followers')::int DESC` (User.js:88-98) — un GIN sur
    // l'expression texte brute ne peut PAS servir un tri (GIN n'ordonne pas)
    // ni même cette expression précise (le cast ::int n'y figure pas).
    // Remplacé par un btree sur l'expression réellement triée.
    await sequelize.query(`DROP INDEX IF EXISTS idx_users_stats_followers`);
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_users_stats_followers_btree
      ON users (((stats->>'followers')::int) DESC)
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

    // AUDIT R2-04 (2026-08-19) : le fil (`GET /api/tweets`, la route la plus
    // appelée de l'API) filtre sur deleted_at/is_private/is_data_test/
    // moderation_status puis trie par created_at — aucun index déclaré ne
    // correspond, le planificateur n'a que le parcours séquentiel ou un
    // bitmap peu sélectif. Index partiel calqué exactement sur ce prédicat :
    // il ne contient que les lignes réellement servies par le fil.
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS tweets_feed_idx
      ON tweets (created_at DESC)
      WHERE deleted_at IS NULL
        AND is_private = false
        AND is_data_test = false
        AND moderation_status = 'approved'
    `);

    // AUDIT R2-05 (2026-08-19) : `sort=popular` trie sur `view_count DESC`
    // sans aucun index sur cette colonne — tri complet, souvent sur disque
    // au-delà de work_mem. Partiel sur le même prédicat que le fil pour
    // servir le filtre ET le tri en une passe.
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS tweets_popular_idx
      ON tweets (view_count DESC, created_at DESC)
      WHERE deleted_at IS NULL
        AND is_private = false
        AND is_data_test = false
        AND moderation_status = 'approved'
    `);

    // AUDIT R2-06 (2026-08-19) : la recherche de tweets utilise
    // `content ILIKE '%terme%'` — aucun index btree ne peut servir un motif
    // commençant par '%'. `idx_users_username_trgm`/`idx_users_full_name_trgm`
    // existaient déjà ci-dessus pour les utilisateurs ; il manquait
    // l'équivalent pour les tweets, la table la plus volumineuse du modèle.
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_tweets_content_trgm
      ON tweets USING gin (content gin_trgm_ops)
    `);

    // AUDIT R2-12 (2026-08-19) : l'onglet « Médias » du profil filtre sur
    // `jsonb_array_length(media_urls) > 0` — un GIN sur `media_urls` (voir le
    // nettoyage ci-dessous) n'indexe pas la cardinalité, seulement le
    // contenu. Le filtre `user_id` reste indexé et s'applique en premier,
    // donc l'effet ne se voit que sur un compte à très gros volume — d'où
    // l'ajout, pas un remplacement de l'index composite existant.
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS tweets_user_media_idx
      ON tweets (user_id, created_at DESC)
      WHERE deleted_at IS NULL AND jsonb_array_length(media_urls) > 0
    `);

    // AUDIT R2-08 (2026-08-19) : index maintenus en permanence sur les
    // tables les plus écrites du dépôt, pour un bénéfice nul ou hors
    // production.
    //
    // (a) `data_test_batch_id` : NULL sur 100 % des lignes réelles, créé par
    // un script de banc d'essai (`scripts/capacityDataLifecycle.js:145-150`)
    // sur les six tables les plus écrites — noms d'index repris tels quels
    // de ce script (pas une convention Sequelize à deviner ici). Rendus
    // partiels plutôt que supprimés : le script de charge en a toujours
    // besoin, `WHERE ... IS NOT NULL` les réduit à quelques pages tant
    // qu'aucune charge n'est en cours.
    const dataTestBatchIndexes = {
      idx_users_data_test_batch: 'users',
      idx_tweets_data_test_batch: 'tweets',
      idx_likes_data_test_batch: 'tweet_likes',
      idx_retweets_data_test_batch: 'tweet_retweets',
      idx_follows_data_test_batch: 'user_follows',
      idx_behavior_data_test_batch: 'user_behavior_data',
    };
    for (const [oldName, table] of Object.entries(dataTestBatchIndexes)) {
      await sequelize.query(`DROP INDEX IF EXISTS ${oldName}`);
      await sequelize.query(`
        CREATE INDEX IF NOT EXISTS ${oldName}_partial
        ON ${table} (data_test_batch_id)
        WHERE data_test_batch_id IS NOT NULL
      `);
    }

    // (b) Cinq mono-colonnes booléennes sur `tweets` (is_retweet, is_quote,
    // is_pinned, is_private, deleted_at) : une colonne à deux valeurs n'est
    // pas sélective, le planificateur préfère presque toujours le parcours
    // séquentiel. L'information vit désormais dans la clause WHERE de
    // `tweets_feed_idx`/`tweets_popular_idx` ci-dessus.
    //
    // ⚠ Mêmes noms déduits (non vérifiés par `\di`) que pour (c) plus bas.
    for (const idx of ['tweets_is_retweet', 'tweets_is_quote', 'tweets_is_pinned', 'tweets_is_private', 'tweets_deleted_at']) {
      await sequelize.query(`DROP INDEX IF EXISTS ${idx}`);
    }

    // (c) Cinq GIN morts sur du JSONB jamais interrogé par contenance (`@>`,
    // `?`, `?|`, `?&`) — recherche exhaustive dans src/routes/ et
    // src/services/, aucun usage trouvé. Un GIN sur JSONB est parmi les plus
    // coûteux à l'écriture ; `hashtags` seul mérite un GIN (voir R2-09, qui
    // demande de vérifier le type réel de la colonne avant d'agir).
    //
    // ⚠ Noms déduits de la convention Sequelize par défaut (`fields:`
    // déclarés sans `name:` explicite dans Tweet.js/User.js) — jamais
    // confirmés par un `\di` réel (accès base bloqué depuis ici, voir la
    // note de contexte n°1 d'AUDIT-R2.md). `DROP INDEX IF EXISTS` est un
    // no-op silencieux si le nom réel diffère : vérifier après coup avec
    // `\di tweets_mentions tweets_media_urls tweets_urls users_stats
    // users_preferences` que ces cinq lignes ont bien disparu.
    for (const idx of ['tweets_mentions', 'tweets_media_urls', 'tweets_urls', 'users_stats', 'users_preferences']) {
      await sequelize.query(`DROP INDEX IF EXISTS ${idx}`);
    }

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

    // Donnees privees du profil et localisation consentie. Les fichiers de
    // migrations ne sont pas executes par ce script en production, donc le
    // DDL critique reste idempotent ici aussi.
    await sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS declared_age SMALLINT NULL,
        ADD COLUMN IF NOT EXISTS birth_day SMALLINT NULL,
        ADD COLUMN IF NOT EXISTS birth_month SMALLINT NULL,
        ADD COLUMN IF NOT EXISTS demographics_validated_at TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS location_consent_status VARCHAR(24) NOT NULL DEFAULT 'undetermined',
        ADD COLUMN IF NOT EXISTS location_consent_updated_at TIMESTAMPTZ NULL;

      CREATE TABLE IF NOT EXISTS user_location_events (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        capture_key VARCHAR(180) NOT NULL UNIQUE,
        permission_status VARCHAR(24) NOT NULL,
        latitude NUMERIC(9,6) NULL,
        longitude NUMERIC(9,6) NULL,
        accuracy_m NUMERIC(10,2) NULL,
        country_code VARCHAR(2) NULL,
        country VARCHAR(100) NULL,
        region VARCHAR(120) NULL,
        city VARCHAR(120) NULL,
        timezone VARCHAR(64) NULL,
        platform VARCHAR(32) NULL,
        client_captured_at TIMESTAMPTZ NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_user_location_events_user_captured
        ON user_location_events (user_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_location_events_country_region
        ON user_location_events (country_code, region);
    `);

    // Consentement RGPD : etat courant sur users pour pouvoir decider en une
    // requete s'il faut reposer la question, et journal append-only qui
    // constitue la PREUVE du consentement (art. 7.1 : c'est au responsable de
    // traitement de demontrer l'accord). On n'ecrase jamais une ligne du
    // journal : un retrait s'ajoute, il n'effface pas l'accord precedent.
    await sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS consent_version VARCHAR(20) NULL,
        ADD COLUMN IF NOT EXISTS consent_accepted_at TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS consent_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

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
        -- Empreinte HMAC, jamais l'adresse en clair : la preuve d'origine est
        -- conservee sans stocker une donnee de plus que necessaire.
        ip_fingerprint VARCHAR(64) NULL,
        user_agent VARCHAR(255) NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_user_consent_records_user_recorded
        ON user_consent_records (user_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_consent_records_purpose
        ON user_consent_records (purpose, granted);
    `);

    await sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS follow_onboarding_completed_at TIMESTAMPTZ NULL;
    `);

    // Drapeaux de fonctionnalite : deploiement progressif et ciblage par
    // attributs. `key` porte l'unicite parce que c'est elle qui est ecrite
    // dans le code applicatif ; l'index partiel sur les drapeaux vivants sert
    // la seule requete chaude, le rechargement du cache d'evaluation.
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        key VARCHAR(120) NOT NULL UNIQUE,
        name VARCHAR(160) NOT NULL,
        description TEXT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        rollout_percentage INTEGER NOT NULL DEFAULT 0,
        rules JSONB NOT NULL DEFAULT '[]'::jsonb,
        variants JSONB NOT NULL DEFAULT '[]'::jsonb,
        allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
        blocklist JSONB NOT NULL DEFAULT '[]'::jsonb,
        bucket_by VARCHAR(16) NOT NULL DEFAULT 'user',
        salt VARCHAR(32) NOT NULL DEFAULT 'v1',
        payload JSONB NULL,
        start_at TIMESTAMPTZ NULL,
        end_at TIMESTAMPTZ NULL,
        archived_at TIMESTAMPTZ NULL,
        created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        updated_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE feature_flags
        DROP CONSTRAINT IF EXISTS feature_flags_rollout_percentage_check;
      ALTER TABLE feature_flags
        ADD CONSTRAINT feature_flags_rollout_percentage_check
        CHECK (rollout_percentage BETWEEN 0 AND 100);

      CREATE INDEX IF NOT EXISTS idx_feature_flags_live
        ON feature_flags (enabled) WHERE archived_at IS NULL;

      -- Montee automatique du palier. Index partiel : le planificateur passe
      -- toutes les minutes et ne doit lire que les drapeaux reellement armes.
      -- Il compare ensuite l'echeance en memoire, d'ou un index sur la seule
      -- condition de selection et non sur la date.
      ALTER TABLE feature_flags
        ADD COLUMN IF NOT EXISTS auto_rollout JSONB NULL;

      DROP INDEX IF EXISTS idx_feature_flags_auto_rollout;
      CREATE INDEX IF NOT EXISTS idx_feature_flags_auto_rollout
        ON feature_flags (updated_at)
        WHERE auto_rollout IS NOT NULL AND archived_at IS NULL;
    `);

    // Carte NF : position PARTAGEE, et rien d'autre.
    //
    // Volontairement separee de `user_location_events`, qui enregistre des
    // captures techniques a d'autres fins. Publier ces captures sur une carte
    // montrerait la position de gens qui n'ont jamais accepte de la publier.
    // Ici, une ligne n'existe que si son proprietaire l'a demandee, elle ne
    // contient que ce qu'il accepte de montrer, et elle expire toute seule.
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS nf_map_presence (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        sharing_mode VARCHAR(16) NOT NULL DEFAULT 'ghost',
        audience VARCHAR(16) NOT NULL DEFAULT 'connections',
        latitude NUMERIC(9,6) NULL,
        longitude NUMERIC(9,6) NULL,
        place_label VARCHAR(120) NULL,
        shared_at TIMESTAMPTZ NULL,
        expires_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE nf_map_presence
        DROP CONSTRAINT IF EXISTS nf_map_presence_sharing_mode_check;
      ALTER TABLE nf_map_presence
        ADD CONSTRAINT nf_map_presence_sharing_mode_check
        CHECK (sharing_mode IN ('ghost', 'city', 'precise'));

      ALTER TABLE nf_map_presence
        DROP CONSTRAINT IF EXISTS nf_map_presence_audience_check;
      ALTER TABLE nf_map_presence
        ADD CONSTRAINT nf_map_presence_audience_check
        CHECK (audience IN ('mutuals', 'followers'));

      -- La seule requete chaude : « qui est visible dans ce rectangle ». Index
      -- partiel, parce que les lignes en mode fantome n'ont pas de position et
      -- ne doivent jamais etre parcourues.
      CREATE INDEX IF NOT EXISTS idx_nf_map_presence_visible
        ON nf_map_presence (latitude, longitude)
        WHERE sharing_mode <> 'ghost' AND latitude IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_nf_map_presence_expiry
        ON nf_map_presence (expires_at)
        WHERE expires_at IS NOT NULL;
    `);

    await sequelize.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS algorithmic_visibility_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0;
    `);

    // Ledger : amount_in_eur/fee étaient en NUMERIC(10,4), soit un plafond de
    // 999 999,9999. Un virement d'un gros montant dépassait ce plafond et
    // faisait échouer l'INSERT (« numeric field overflow »), ce qui avortait
    // la transaction Postgres et annulait le virement entier. Aligné sur
    // `amount`, dont ces deux colonnes sont dérivées.
    await sequelize.query(`
      ALTER TABLE transactions
        ALTER COLUMN amount_in_eur TYPE NUMERIC(20,8),
        ALTER COLUMN fee TYPE NUMERIC(20,8);
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
    // Expériences A/B de publications. Le tweet reste la version A canonique :
    // les anciens clients restent compatibles, tandis que NeuralRank attribue
    // une variante aux lecteurs qui passent par le fil expérimental.
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS tweet_ab_experiments (
        id UUID PRIMARY KEY,
        tweet_id UUID NOT NULL UNIQUE REFERENCES tweets(id) ON DELETE CASCADE,
        author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
        strategy VARCHAR(20) NOT NULL DEFAULT 'adaptive',
        platform_scope VARCHAR(20) NOT NULL DEFAULT 'windows',
        exploration_percent SMALLINT NOT NULL DEFAULT 20
          CHECK (exploration_percent BETWEEN 0 AND 100),
        min_impressions_per_variant INTEGER NOT NULL DEFAULT 6
          CHECK (min_impressions_per_variant >= 4),
        winner_variant_id UUID NULL,
        cancellation_reason TEXT NULL,
        activated_at TIMESTAMPTZ NULL,
        completed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await sequelize.query(`
      ALTER TABLE tweet_ab_experiments
        DROP CONSTRAINT IF EXISTS tweet_ab_experiments_min_impressions_per_variant_check;
      ALTER TABLE tweet_ab_experiments
        ALTER COLUMN min_impressions_per_variant SET DEFAULT 6;
      ALTER TABLE tweet_ab_experiments
        ADD CONSTRAINT tweet_ab_experiments_min_impressions_per_variant_check
        CHECK (min_impressions_per_variant >= 4);
    `);
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS tweet_ab_variants (
        id UUID PRIMARY KEY,
        experiment_id UUID NOT NULL REFERENCES tweet_ab_experiments(id) ON DELETE CASCADE,
        position SMALLINT NOT NULL,
        label VARCHAR(4) NOT NULL,
        content TEXT NOT NULL,
        is_control BOOLEAN NOT NULL DEFAULT FALSE,
        moderation_status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
        moderation_reason TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (experiment_id, position),
        UNIQUE (experiment_id, label)
      );
    `);
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS tweet_ab_variant_metrics (
        variant_id UUID PRIMARY KEY REFERENCES tweet_ab_variants(id) ON DELETE CASCADE,
        impressions BIGINT NOT NULL DEFAULT 0,
        interactions BIGINT NOT NULL DEFAULT 0,
        reward DOUBLE PRECISION NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS tweet_ab_assignments (
        experiment_id UUID NOT NULL REFERENCES tweet_ab_experiments(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        variant_id UUID NOT NULL REFERENCES tweet_ab_variants(id) ON DELETE CASCADE,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (experiment_id, user_id)
      );
    `);
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_tweet_ab_experiments_status
        ON tweet_ab_experiments (status, tweet_id);
      CREATE INDEX IF NOT EXISTS idx_tweet_ab_variants_experiment
        ON tweet_ab_variants (experiment_id, moderation_status);
      CREATE INDEX IF NOT EXISTS idx_tweet_ab_assignments_user
        ON tweet_ab_assignments (user_id, experiment_id);
    `);

    // Liaison de compte avec g-auth (connexion et association « associer mon
    // compte à G »). g_auth_bonus_claimed_at est distinct de g_auth_linked_at :
    // si un délienage/reliaison est introduit plus tard, il ne doit pas
    // permettre de reclaimer le bonus.
    await sequelize.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS g_auth_sub TEXT NULL,
        ADD COLUMN IF NOT EXISTS g_auth_linked_at TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS g_auth_bonus_claimed_at TIMESTAMPTZ NULL;
    `);
    await sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_g_auth_sub
        ON users (g_auth_sub) WHERE g_auth_sub IS NOT NULL;
    `);

    // Publicité : promouvoir un COMPTE, pas seulement un tweet.
    //
    // `advertisements.tweet_id` était NOT NULL : une publicité de compte
    // n'avait aucune colonne où se poser, et la restriction « il faut un
    // tweet » venait du schéma, pas d'un choix de produit. `target_type` dit
    // laquelle des deux cibles fait foi ; la contrainte garantit qu'il y en a
    // toujours exactement une de renseignée.
    await sequelize.query(`
      ALTER TABLE advertisements
        ADD COLUMN IF NOT EXISTS target_type VARCHAR(16) NOT NULL DEFAULT 'tweet',
        ADD COLUMN IF NOT EXISTS target_user_id UUID NULL REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE advertisements ALTER COLUMN tweet_id DROP NOT NULL;
    `);
    await sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'advertisements_target_ck'
        ) THEN
          ALTER TABLE advertisements ADD CONSTRAINT advertisements_target_ck CHECK (
            (target_type = 'tweet'   AND tweet_id       IS NOT NULL) OR
            (target_type = 'profile' AND target_user_id IS NOT NULL)
          );
        END IF;
      END $$;
    `);
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_advertisements_target_user
        ON advertisements (target_user_id) WHERE target_user_id IS NOT NULL;
    `);

    // Suivi vues/clics du mur Explorer, séparé de `view_count` (qui reste la
    // source de vérité pour les stats créateur et le classement algo). Lu
    // uniquement par `tweetMonetizationService.js` pour reformuler la part
    // Explorer en clics plutôt qu'en vues.
    await sequelize.query(`
      ALTER TABLE tweets
        ADD COLUMN IF NOT EXISTS explore_view_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS explore_click_count INTEGER NOT NULL DEFAULT 0;
    `);

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
