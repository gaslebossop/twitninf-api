/**
 * Profil demographique prive et captures de localisation consenties.
 * Idempotente pour pouvoir etre jouee apres sequelize.sync ou seule.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
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
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS user_location_events;
      ALTER TABLE users
        DROP COLUMN IF EXISTS location_consent_updated_at,
        DROP COLUMN IF EXISTS location_consent_status,
        DROP COLUMN IF EXISTS demographics_validated_at,
        DROP COLUMN IF EXISTS birth_month,
        DROP COLUMN IF EXISTS birth_day,
        DROP COLUMN IF EXISTS declared_age;
    `);
  },
};
