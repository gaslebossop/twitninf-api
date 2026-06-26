/**
 * À lancer une fois sur le VPS si la colonne manque encore (avant redéploiement autoMigration) :
 *   node src/scripts/ensureShadowbanSchema.js
 */
const { sequelize, closeConnection } = require('../database');
const logger = require('../utils/logger');

async function main() {
  await sequelize.authenticate();
  await sequelize.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS algorithmic_visibility_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.0;
  `);
  try {
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  } catch (_) {}
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
  logger.info('✅ Schéma shadowban / similarity OK');
  await closeConnection();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
