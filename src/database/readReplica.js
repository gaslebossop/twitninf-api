/**
 * 📖 Connexion de lecture seule vers la réplique PostgreSQL.
 *
 * ── Pourquoi une instance séparée plutôt que le `replication:` de Sequelize ──
 * Le mode `replication` intégré route automatiquement TOUT `SELECT` hors
 * transaction vers la réplique. Sur ce code, ça veut dire des centaines de
 * chemins du type « je crée, puis je relis pour renvoyer l'objet » : la
 * réplication étant asynchrone, chacun d'eux devient un bug potentiel — la
 * relecture peut arriver avant que l'écriture ne soit répliquée, et l'API
 * renvoie un objet vide sans la moindre erreur. Impossible de garantir un
 * audit exhaustif de ces chemins.
 *
 * On inverse donc le défaut : **tout continue de passer par le primaire**, et
 * on bascule explicitement sur la réplique les requêtes lourdes dont on sait
 * qu'une donnée vieille d'une seconde est sans conséquence (feed, recherche,
 * statistiques, batchs analytiques du worker). Le gain de charge vient de ces
 * requêtes-là ; le risque de lecture périmée reste nul partout ailleurs.
 *
 * ── Portée ──
 * Cette instance ne porte AUCUN modèle : elle sert aux requêtes SQL brutes.
 * C'est volontaire — ré-initialiser les ~40 modèles sur une seconde instance
 * doublerait la mémoire et inviterait à écrire par erreur via la réplique.
 *
 * ── Repli ──
 * Sans `DB_READ_HOST`, `readDb` est simplement l'instance primaire. Le code
 * appelant n'a donc pas à savoir s'il y a une réplique : en mono-serveur, tout
 * fonctionne comme avant.
 */

const { Sequelize } = require('sequelize');
const config = require('../config/config');
const logger = require('../utils/logger');
const { sequelize: primary } = require('../models');

const readHost = process.env.DB_READ_HOST;

let readSequelize = primary;
let usingReplica = false;

if (readHost) {
  try {
    readSequelize = new Sequelize({
      ...config.database,
      host: readHost,
      // Par défaut le pgbouncer local du nœud : une lecture ne traverse alors
      // même pas le réseau privé.
      port: parseInt(process.env.DB_READ_PORT, 10) || config.database.port,
      pool: {
        ...config.database.pool,
        max: parseInt(process.env.DB_READ_POOL_MAX, 10) || config.database.pool.max
      }
    });
    usingReplica = true;
    logger.info(`📖 Réplique de lecture configurée: ${readHost}`);
  } catch (error) {
    logger.error(`❌ Réplique de lecture inutilisable (${error.message}) — repli sur le primaire.`);
    readSequelize = primary;
    usingReplica = false;
  }
}

/**
 * Exécute une requête de lecture sur la réplique quand elle existe.
 *
 * En cas de panne de la réplique, on rejoue sur le primaire plutôt que de
 * renvoyer une erreur : une réplique morte doit dégrader les performances,
 * pas le service.
 *
 * @param {string} sql
 * @param {object} [options] options Sequelize (replacements, type…)
 */
async function queryRead(sql, options = {}) {
  if (!usingReplica) return primary.query(sql, options);
  try {
    return await readSequelize.query(sql, options);
  } catch (error) {
    logger.warn(`[readReplica] Lecture en échec (${error.message}) — bascule sur le primaire.`);
    return primary.query(sql, options);
  }
}

/**
 * Vérifie l'état de la réplique. Utilisé par /api/health pour distinguer
 * « pas de réplique configurée » de « réplique configurée mais injoignable ».
 */
async function checkRead() {
  if (!usingReplica) return { configured: false, reachable: null, lagSeconds: null };
  try {
    const [rows] = await readSequelize.query(
      // `pg_last_xact_replay_timestamp()` vaut NULL sur un primaire : ça permet
      // de détecter qu'on pointe par erreur sur une machine qui n'est pas une
      // réplique.
      "SELECT pg_is_in_recovery() AS in_recovery, EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) AS lag_seconds"
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    return {
      configured: true,
      reachable: true,
      inRecovery: row?.in_recovery ?? null,
      lagSeconds: row?.lag_seconds !== undefined && row.lag_seconds !== null
        ? Number(row.lag_seconds)
        : null
    };
  } catch (error) {
    return { configured: true, reachable: false, error: error.message, lagSeconds: null };
  }
}

async function closeRead() {
  if (usingReplica) await readSequelize.close();
}

module.exports = { readDb: readSequelize, usingReplica, queryRead, checkRead, closeRead };
