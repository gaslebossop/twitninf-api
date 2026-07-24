'use strict';

/**
 * Migration de la mémoire PolicierCongo V3 vers la couche sémantique.
 *
 * Idempotent : peut être relancé sans risque. Trois étapes —
 *   1. création/complétion du schéma (colonnes vecteur, statut, entité, épisodes) ;
 *   2. vectorisation des souvenirs existants, qui n'en avaient pas ;
 *   3. purge des souvenirs expirés et des épisodes anciens sans valeur.
 *
 *   node src/scripts/migratePolicierCongoV3Memory.js
 *   node src/scripts/migratePolicierCongoV3Memory.js --no-backfill
 */

const models = require('../models');
const logger = require('../utils/logger');
const { loadV3Config } = require('../services/policiercongo/policiercongov3/config');
const { PostgresMemoryStore } = require('../services/policiercongo/policiercongov3/memoryStore');

async function main() {
  const skipBackfill = process.argv.includes('--no-backfill');
  const config = loadV3Config();
  const store = new PostgresMemoryStore({ sequelize: models.sequelize, config, logger });

  logger.info('[pc3.migrate] Vérification du schéma…');
  await store.ensureSchema();
  logger.info('[pc3.migrate] Schéma à jour.');

  if (skipBackfill) {
    logger.info('[pc3.migrate] Vectorisation ignorée (--no-backfill).');
  } else {
    logger.info('[pc3.migrate] Vectorisation des souvenirs sans embedding…');
    const backfill = await store.backfillEmbeddings({ batchSize: 50 });
    logger.info(`[pc3.migrate] Vectorisation: ${JSON.stringify(backfill)}`);
  }

  const consolidation = await store.consolidate({ maxAgeDays: 120 });
  logger.info(`[pc3.migrate] Consolidation: ${JSON.stringify(consolidation)}`);
  logger.info('[pc3.migrate] Terminé.');
}

main()
  .then(() => models.sequelize.close())
  .then(() => process.exit(0))
  .catch(error => {
    logger.error(`[pc3.migrate] Échec: ${error.message}`);
    process.exit(1);
  });
