/**
 * 🎭 Rôle du process — support du déploiement multi-instances.
 *
 * Le même code tourne sur toutes les machines ; c'est `NODE_ROLE` qui décide
 * de ce que le process a le droit de faire :
 *
 *   - `web`    : ne sert que du trafic HTTP/WebSocket. Aucun cron, aucun
 *                worker de fond, aucune migration de schéma.
 *   - `worker` : exécute les tâches de fond (crons, PolicierCongo, TwitNinfAI,
 *                radars, analyse sémantique) ET les migrations au boot.
 *                **Un seul process worker doit exister dans tout le parc** :
 *                c'est ce qui garantit que PolicierCongo ne tourne qu'en un
 *                exemplaire, par configuration et non par chance.
 *   - `all`    : les deux. Valeur par défaut, pour ne rien changer au
 *                développement local et au déploiement mono-serveur existant.
 *
 * Le repli sur `all` est délibéré : un `.env` de prod qui n'aurait pas été mis
 * à jour continue de se comporter exactement comme avant ce changement.
 */

const os = require('os');

const RAW_ROLE = String(process.env.NODE_ROLE || 'all').trim().toLowerCase();
const VALID_ROLES = ['web', 'worker', 'all'];

const role = VALID_ROLES.includes(RAW_ROLE) ? RAW_ROLE : 'all';

if (!VALID_ROLES.includes(RAW_ROLE)) {
  // Pas de logger ici : ce module est chargé très tôt, avant la config des logs.
  console.warn(
    `⚠️ [role] NODE_ROLE="${process.env.NODE_ROLE}" inconnu (attendu: ${VALID_ROLES.join('|')}). Repli sur "all".`
  );
}

const isWorker = role === 'worker' || role === 'all';
const isWeb = role === 'web' || role === 'all';

/**
 * Les migrations sont plus dangereuses que les crons : si deux instances
 * lancent `sync()` + `runAutoMigration()` en même temps au boot, elles se
 * marchent dessus sur les mêmes ALTER TABLE. On les réserve au worker, avec
 * une échappatoire explicite pour les jouer à la main sur un autre nœud.
 */
const runMigrations = isWorker || process.env.RUN_MIGRATIONS === '1';

/**
 * Identifiant lisible du process, pour savoir qui répond derrière le
 * répartiteur de charge (exposé par /api/health).
 */
const instanceId = process.env.INSTANCE_ID || `${os.hostname()}:${process.pid}`;

module.exports = { role, isWorker, isWeb, runMigrations, instanceId };
