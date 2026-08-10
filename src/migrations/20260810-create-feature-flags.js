/**
 * Drapeaux de fonctionnalite : deploiement progressif et ciblage par
 * attributs. Idempotente : le meme DDL est aussi joue par
 * src/database/migrate.js, seul chemin execute en production.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
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

      -- Montee automatique du palier : plan d'elargissement de la portee.
      -- L'index partiel sert le planificateur, qui ne lit que les drapeaux
      -- reellement armes.
      ALTER TABLE feature_flags
        ADD COLUMN IF NOT EXISTS auto_rollout JSONB NULL;

      DROP INDEX IF EXISTS idx_feature_flags_auto_rollout;
      CREATE INDEX IF NOT EXISTS idx_feature_flags_auto_rollout
        ON feature_flags (updated_at)
        WHERE auto_rollout IS NOT NULL AND archived_at IS NULL;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS feature_flags;
    `);
  },
};
