/**
 * Client HTTP pour le microservice Scala de recommandation "Swipe or Follow".
 *
 * Même squelette que rustRecommenderClient.js : agent keep-alive, base URL et
 * secret lus à chaque appel (pas à l'évaluation du module — dotenv n'a pas
 * forcément tourné), header X-Service-Key. Réutilise le même INTERNAL_SECRET
 * que le recommandeur Rust : pas de nouveau secret à générer.
 */
const http = require('http');
const logger = require('../utils/logger');

const swipeBaseUrl = () => process.env.SWIPE_RECOMMENDER_URL || 'http://127.0.0.1:3003';

function swipeTarget() {
  try {
    const u = new URL(swipeBaseUrl());
    return { hostname: u.hostname, port: Number(u.port) || 3003 };
  } catch {
    return { hostname: '127.0.0.1', port: 3003 };
  }
}

const internalSecret = () => process.env.INTERNAL_SECRET || '';
const TIMEOUT_MS = 4000;

const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

async function swipePost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const { hostname, port } = swipeTarget();
    const options = {
      hostname,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Service-Key': internalSecret(),
      },
      timeout: TIMEOUT_MS,
      agent: keepAliveAgent,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch {
          reject(new Error(`Invalid JSON from swipe-recommender: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('swipe-recommender timeout'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Récupère une file de candidats classés pour l'écran "Swipe or Follow".
 * @param {string} userId
 * @param {{limit?: number, forceRefresh?: boolean}} opts
 */
async function getSwipeCandidates(userId, opts = {}) {
  const { limit = 20, forceRefresh = false } = opts;
  const { statusCode, body } = await swipePost('/swipe/candidates', {
    user_id: userId,
    limit,
    force_refresh: forceRefresh,
  });
  if (statusCode !== 200 || !body.success) {
    throw new Error(`swipe-recommender error (status ${statusCode})`);
  }
  return { candidates: body.data, cached: !!body.cached };
}

/**
 * Enregistre un "pass" : retire le profil de la file en cache et pose un
 * cooldown côté service Scala (il ne sera pas reproposé pendant 21 jours).
 * Le follow réel ne passe pas par ce client — il reste géré par
 * POST /api/users/:id/follow, seule source de vérité pour UserFollow.
 * @param {string} userId
 * @param {string} targetUserId
 */
async function recordSwipePass(userId, targetUserId) {
  const { statusCode, body } = await swipePost('/swipe/action', {
    user_id: userId,
    target_user_id: targetUserId,
    action: 'pass',
  });
  if (statusCode !== 200 || !body.success) {
    throw new Error(`swipe-recommender pass error (status ${statusCode})`);
  }
}

setTimeout(() => {
  if (!internalSecret()) {
    logger.warn('[SwipeRecommender] INTERNAL_SECRET absent — le moteur Swipe rejettera les appels (401)');
  }
}, 5000).unref?.();

module.exports = { getSwipeCandidates, recordSwipePass };
