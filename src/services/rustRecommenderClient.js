/**
 * Client HTTP pour le microservice Rust de recommandation.
 *
 * Ce client appelle le service NeuralRank Fusion (port 3002) et sert
 * de passerelle entre l'API Node.js et le moteur Rust.
 * Si le service Rust est indisponible, le fallback se fait vers le moteur JS existant.
 */
const http = require('http');
const logger = require('../utils/logger');

const RUST_BASE_URL = process.env.RUST_RECOMMENDER_URL || 'http://127.0.0.1:3002';
const TIMEOUT_MS = 4000; // 4s max — sinon fallback JS

// Clé interne service-to-service attendue par le moteur Rust sur /track,
// /invalidate et /recommendations. Elle n'était envoyée sur AUCUN appel : le
// service répondait donc 401 à tout le tracking, et le modèle CTR n'a jamais
// reçu le moindre événement (d'où un `ctr_samples` bloqué à 0, qui désactive
// en permanence le blending ML et l'auto-tuner).
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || '';
if (!INTERNAL_SECRET) {
  logger.warn('[RustRecommender] INTERNAL_SECRET absent — le moteur Rust rejettera les appels (401)');
}

// Connexion persistante vers le service Rust (co-localisé sur le VPS) : évite
// de renégocier une connexion TCP à chaque appel /recommendations, appelé à
// chaque chargement/scroll du fil d'accueil.
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/**
 * Effectue une requête HTTP vers le service Rust.
 * @param {string} path - Ex: '/recommendations'
 * @param {object} body - Corps JSON
 * @returns {Promise<object>} - Réponse parsée
 */
async function rustPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port: 3002,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Service-Key': INTERNAL_SECRET,
      },
      timeout: TIMEOUT_MS,
      agent: keepAliveAgent,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from Rust service: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Rust recommender timeout'));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function rustGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1', port: 3002, path, timeout: TIMEOUT_MS, agent: keepAliveAgent,
        headers: { 'X-Service-Key': INTERNAL_SECRET },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Invalid JSON')); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Récupère des recommandations personnalisées via le moteur Rust.
 *
 * @param {number} userId
 * @param {object} opts
 * @param {'feed'|'discover'|'trending'|'for_you'} opts.mode
 * @param {number} opts.limit
 * @param {number} opts.offset
 * @returns {Promise<{tweetIds: number[], latencyMs: number, cacheHit: boolean}>}
 */
async function getRecommendations(userId, opts = {}) {
  const { mode = 'for_you', limit = 50, offset = 0, enableExperiments = false } = opts;

  const result = await rustPost('/recommendations', {
    user_id: userId,
    mode,
    limit,
    offset,
    exclude_seen: true,
    enable_experiments: Boolean(enableExperiments),
  });

  if (!result.success) {
    throw new Error(`Rust recommender error: ${result.error}`);
  }

  return {
    tweetIds: result.tweet_ids,
    experiments: Array.isArray(result.experiments) ? result.experiments : [],
    count: result.count,
    latencyMs: result.latency_ms,
    cacheHit: result.cache_hit,
    algorithm: result.algorithm,
  };
}

/**
 * Enregistre une interaction utilisateur dans le moteur Rust.
 * Met à jour les scores Redis + invalide le cache de recommandation.
 *
 * @param {number} userId
 * @param {number} tweetId
 * @param {string} interactionType - 'like', 'comment', 'retweet', 'share', 'view', 'skip', 'report', 'block', etc.
 * @param {number|null} dwellMs - Temps passé sur le contenu en ms (optionnel)
 */
async function trackInteraction(userId, tweetId, interactionType, dwellMs = null, experiment = null) {
  const result = await rustPost('/track', {
    user_id: userId,
    tweet_id: tweetId,
    interaction_type: interactionType,
    dwell_ms: dwellMs,
    experiment_id: experiment?.experiment_id || null,
    variant_id: experiment?.variant_id || null,
  });

  if (!result.success) {
    throw new Error(`Track error: ${result.error}`);
  }

  return result;
}

/**
 * Invalide le cache NeuralRank pour un utilisateur donné.
 * Le service Rust invalide toutes les entrées twitninf:reco:{userId}:*
 * via l'endpoint /invalidate.
 */
async function invalidateUser(userId) {
  try {
    await rustPost('/invalidate', { user_id: userId });
  } catch {
    // Non-fatal
  }
}

/**
 * Vérifie la santé du service Rust.
 * @returns {Promise<{healthy: boolean, latencyMs: number}>}
 */
async function healthCheck() {
  const start = Date.now();
  try {
    const result = await rustGet('/health');
    return {
      healthy: result.status === 'healthy',
      db: result.db,
      redis: result.redis,
      latencyMs: Date.now() - start,
      version: result.version,
      uptimeSecs: result.uptime_secs,
    };
  } catch {
    return { healthy: false, latencyMs: Date.now() - start };
  }
}

module.exports = {
  getRecommendations,
  trackInteraction,
  invalidateUser,
  healthCheck,
};
