/**
 * Calcule le Spotlight d'hier immédiatement, sans attendre le cron de 00:10.
 * Usage (sur le VPS) : node src/scripts/runSpotlightNow.js
 */

const { sequelize } = require('../models');
const logger = require('../utils/logger');
const { computeYesterdaySpotlight } = require('../services/spotlightService');

async function run() {
  try {
    await sequelize.authenticate();
    const row = await computeYesterdaySpotlight();
    logger.info(`✅ Spotlight: ${JSON.stringify(row?.toJSON ? row.toJSON() : row)}`);
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('❌ Erreur Spotlight:', error);
      process.exit(1);
    });
}

module.exports = run;
