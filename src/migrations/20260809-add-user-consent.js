/**
 * Consentement RGPD : etat courant sur users + journal append-only qui sert de
 * preuve de l'accord (art. 7.1). Idempotente : le meme DDL est aussi joue par
 * src/database/migrate.js, seul chemin execute en production.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
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
        ip_fingerprint VARCHAR(64) NULL,
        user_agent VARCHAR(255) NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_user_consent_records_user_recorded
        ON user_consent_records (user_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_consent_records_purpose
        ON user_consent_records (purpose, granted);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS user_consent_records;
      ALTER TABLE users
        DROP COLUMN IF EXISTS consent_preferences,
        DROP COLUMN IF EXISTS consent_accepted_at,
        DROP COLUMN IF EXISTS consent_version;
    `);
  },
};
