/**
 * Client HTTP pour le microservice Rust de recommandation.
 *
 * Ce client appelle le service NeuralRank Fusion (port 3002) et sert
 * de passerelle entre l'API Node.js et le moteur Rust.
 * Si le service Rust est indisponible, le fallback se fait vers le moteur JS existant.
 */
const http = require('http');
const logger = require('../utils/logger');

// Lu à chaque appel, pas une fois pour toutes au chargement du module.
//
// Figer cette valeur à l'évaluation du fichier a coûté cher : ce module est
// chargé indirectement avant que dotenv n'ait tourné, donc `process.env` était
// vide et le repli 127.0.0.1 devenait définitif. Sur un serveur qui n'héberge
// pas le moteur Rust, 100 % des requêtes basculaient sur le classement JS sans
// qu'aucune erreur ne remonte — seule la qualité des recommandations baissait.
const rustBaseUrl = () => process.env.RUST_RECOMMENDER_URL || 'http://127.0.0.1:3002';

/**
 * Hôte et port du moteur Rust, résolus à chaque appel.
 *
 * `rustPost` et `rustGet` codaient `127.0.0.1:3002` en dur dans leurs options :
 * `RUST_RECOMMENDER_URL` était lue mais ne servait à rien. Tant que le moteur
 * tournait sur la même machine, la valeur en dur se trouvait être la bonne et
 * personne ne pouvait s'en apercevoir. Depuis un second serveur, chaque appel
 * échouait en ECONNREFUSED et retombait sur le classement JS.
 */
function rustTarget() {
  try {
    const u = new URL(rustBaseUrl());
    return { hostname: u.hostname, port: Number(u.port) || 3002 };
  } catch {
    return { hostname: '127.0.0.1', port: 3002 };
  }
}

/** Clé service-à-service, lue au moment de l'appel (voir le commentaire ci-dessus). */
const internalSecret = () => process.env.INTERNAL_SECRET || '';
/**
 * Clé distincte de `INTERNAL_SECRET` : les routes `/admin/*` du moteur Rust
 * vérifient `X-Admin-Key` contre son propre `ADMIN_SECRET`, pas le secret
 * service-à-service utilisé par `/track`/`/recommendations`/`/account-status`.
 * Doit être la MÊME valeur que `ADMIN_SECRET` sur le service Rust, sinon
 * chaque appel d'admin (avertissement, retrait, décision manuelle) échoue en 401.
 */
const adminSecret = () => process.env.RUST_ADMIN_SECRET || '';
const TIMEOUT_MS = 4000; // 4s max — sinon fallback JS

// Clé interne service-to-service attendue par le moteur Rust sur /track,
// /invalidate et /recommendations. Elle n'était envoyée sur AUCUN appel : le
// service répondait donc 401 à tout le tracking, et le modèle CTR n'a jamais
// reçu le moindre événement (d'où un `ctr_samples` bloqué à 0, qui désactive
// en permanence le blending ML et l'auto-tuner).
// L'avertissement est différé : au chargement de ce module, dotenv n'a pas
// forcément tourné, et une alerte « secret absent » émise trop tôt était
// systématiquement fausse — donc ignorée, donc inutile.
setTimeout(() => {
  if (!internalSecret()) {
    logger.warn('[RustRecommender] INTERNAL_SECRET absent — le moteur Rust rejettera les appels (401)');
  }
}, 5000).unref?.();

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
    const { hostname, port } = rustTarget();
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

/**
 * Requête admin vers le moteur Rust — même transport que `rustPost`, mais
 * authentifiée par `X-Admin-Key` plutôt que `X-Service-Key`.
 */
async function rustAdminPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const { hostname, port } = rustTarget();
    const options = {
      hostname,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Admin-Key': adminSecret(),
      },
      timeout: TIMEOUT_MS,
      agent: keepAliveAgent,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          reject(new Error(`Invalid JSON from Rust service: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Rust recommender timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function rustGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        ...rustTarget(), path, timeout: TIMEOUT_MS, agent: keepAliveAgent,
        headers: { 'X-Service-Key': internalSecret() },
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
  const {
    mode = 'for_you', limit = 50, offset = 0,
    enableExperiments = false, forceRefresh = false, excludeSeen = false,
  } = opts;

  const result = await rustPost('/recommendations', {
    user_id: userId,
    mode,
    limit,
    offset,
    // ⚠ Ce champ était envoyé en dur à `true`, mais le moteur Rust ne le lisait
    // nulle part : il n'a jamais rien fait. Maintenant qu'il est implémenté
    // (`recommend()` écarte les tweets du set `twitninf:seen:<user>`), le
    // laisser à `true` pour tout le monde changerait d'un coup le comportement
    // de « Pour toi » et du fil, qui n'ont rien demandé. Il devient donc
    // explicite et par défaut FAUX — même règle que `force_refresh` : seule la
    // page Explorer le demande.
    exclude_seen: Boolean(excludeSeen),
    enable_experiments: Boolean(enableExperiments),
    // Le moteur Rust supporte déjà ce champ (voir `recommender.rs`) : quand
    // vrai, il saute la lecture du cache `twitninf:reco:{userId}:{mode}` et
    // recalcule, tout en réécrivant le cache avec le nouveau classement.
    force_refresh: Boolean(forceRefresh),
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
 * @param {object|null} experiment - Affectation A/B ({ experiment_id, variant_id })
 * @param {object|null} dwellContext - Nature du contenu regardé :
 *   `{ media: 'text'|'image'|'video', contentChars: number, videoDurationMs: number|null }`.
 *   Sans lui, le moteur interprète `dwellMs` à l'aveugle et confond le temps
 *   passé avec la LONGUEUR du contenu (voir `algorithm/dwell.rs`).
 */
async function trackInteraction(
  userId, tweetId, interactionType, dwellMs = null, experiment = null, dwellContext = null,
  authorId = null,
) {
  const result = await rustPost('/track', {
    user_id: userId,
    tweet_id: tweetId,
    interaction_type: interactionType,
    dwell_ms: dwellMs,
    // Sans lui, un « ça ne m'intéresse pas » ne porte que sur le tweet refusé
    // et reste imperceptible dans le fil (voir `track_handler` côté Rust).
    author_id: authorId,
    dwell_media: dwellContext?.media || null,
    content_chars: Number.isFinite(dwellContext?.contentChars) ? dwellContext.contentChars : null,
    video_duration_ms: Number.isFinite(dwellContext?.videoDurationMs) ? dwellContext.videoDurationMs : null,
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
 * État de distribution d'un compte : avertissements actifs, surfaces fermées,
 * date de retour à la normale.
 *
 * L'appelant est responsable de ne demander que le compte authentifié — le
 * moteur Rust ne voit qu'une clé de service, pas un utilisateur.
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
async function getAccountStatus(userId) {
  const result = await rustGet(`/account-status?user_id=${encodeURIComponent(userId)}`);
  if (!result.success) {
    throw new Error(`Account status error: ${result.error || 'unknown'}`);
  }
  return result.data;
}

/**
 * Émet un avertissement daté sur un compte, rattaché à un domaine de règle.
 *
 * C'est le chemin normal pour sanctionner un compte — à préférer à
 * `setShadowban` : l'avertissement expire seul au bout de 90 jours et le
 * niveau de restriction se déduit du nombre d'avertissements actifs dans CE
 * domaine, avec des seuils propres à chaque domaine (voir `StrikePolicy` côté
 * Rust). `tweetId`, quand fourni, permet à un recours accepté de retirer
 * précisément cet avertissement plus tard.
 *
 * @param {string} userId
 * @param {'spam'|'engagement_bait'|'unoriginal'|'misinformation'|'harassment'|'adult_content'|'hateful_conduct'|'violent_threat'} policy
 * @param {string|null} tweetId
 * @param {string|null} reason
 * @returns {Promise<object>} L'état de compte à jour (niveau, avertissements actifs, date de retour)
 */
async function issueStrike(userId, policy, tweetId = null, reason = null) {
  const { status, body } = await rustAdminPost('/admin/strike', {
    user_id: userId,
    policy,
    tweet_id: tweetId,
    reason,
  });
  if (status !== 200 || !body.success) {
    throw new Error(`Issue strike error (${status}): ${body.error || 'unknown'}`);
  }
  return body.data;
}

/**
 * Recours accepté : retire les avertissements liés à un tweet précis, ou tout
 * le registre du compte si `tweetId` est omis.
 *
 * @param {string} userId
 * @param {string|null} tweetId
 * @returns {Promise<object>} L'état de compte à jour
 */
async function revokeStrike(userId, tweetId = null) {
  const { status, body } = await rustAdminPost('/admin/strike/revoke', {
    user_id: userId,
    tweet_id: tweetId,
  });
  if (status !== 200 || !body.success) {
    throw new Error(`Revoke strike error (${status}): ${body.error || 'unknown'}`);
  }
  return body.data;
}

/**
 * Pose une décision manuelle de restriction, en dehors du registre
 * d'avertissements — prime sur le calcul automatique, dans les deux sens
 * (peut durcir comme blanchir un compte que l'heuristique a mal jugé).
 *
 * Réservé aux cas où `issueStrike` ne convient pas (blanchiment d'un compte,
 * restriction hors des 8 domaines existants) : une décision sans
 * `expiresInDays` reste posée jusqu'à ce que quelqu'un pense à la lever.
 *
 * @param {string} userId
 * @param {'clean'|'monitoring'|'suppressed'|'ghosted'} level
 * @param {string|null} reason
 * @param {number|null} expiresInDays
 */
async function setShadowban(userId, level, reason = null, expiresInDays = null) {
  // `ShadowbanLevel` n'a PAS de `rename_all` côté Rust (voir shadowban/models.rs,
  // commentaire explicite à ce sujet) : la désérialisation de `SetShadowbanRequest`
  // attend "Clean"/"Monitoring"/"Suppressed"/"Ghosted", capitale initiale —
  // contrairement à `StrikePolicy` (issueStrike), qui lui est en snake_case.
  // Envoyer la valeur minuscule utilisée partout ailleurs dans cette API fait
  // échouer la désérialisation.
  const rustLevel = String(level).charAt(0).toUpperCase() + String(level).slice(1).toLowerCase();
  const { status, body } = await rustAdminPost('/admin/shadowban', {
    user_id: userId,
    level: rustLevel,
    reason,
    expires_in_days: expiresInDays,
  });
  if (status !== 200 || !body.success) {
    throw new Error(`Set shadowban error (${status}): ${body.error || 'unknown'}`);
  }
  return body;
}

/**
 * Pose un frein temporaire (1h, ×0.5) — jamais un avertissement de
 * modération. Réservé aux quatre déclencheurs identifiés : suppression d'un
 * tweet, changement d'avatar, changement de bio. La rafale de publication ne
 * passe pas par ici, voir `recordPostForVelocity`.
 *
 * Fire-and-forget par construction : un frein raté ne doit jamais faire
 * échouer l'action de l'utilisateur (supprimer son tweet, changer sa bio...).
 * L'appelant n'a pas à attendre la promesse.
 *
 * @param {string} userId
 * @param {string} reason - 'tweet_delete' | 'avatar_change' | 'bio_change'
 */
async function triggerVelocityThrottle(userId, reason) {
  try {
    await rustPost('/velocity-throttle', { user_id: userId, reason });
  } catch (e) {
    logger.warn(`[RustRecommender] velocity-throttle (${reason}) non posé pour ${userId}: ${e.message}`);
  }
}

/**
 * Compte une publication dans la fenêtre de rafale (10 tweets / 10 min) et
 * pose le frein si le seuil est franchi — la décision se prend côté Rust,
 * voir `crate::velocity::record_post_and_maybe_throttle`. Fire-and-forget,
 * même raison qu'au-dessus.
 *
 * @param {string} userId
 */
async function recordPostForVelocity(userId) {
  try {
    await rustPost('/velocity/post-burst', { user_id: userId, reason: 'tweet_create' });
  } catch (e) {
    logger.warn(`[RustRecommender] velocity/post-burst non enregistré pour ${userId}: ${e.message}`);
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
  getAccountStatus,
  issueStrike,
  revokeStrike,
  setShadowban,
  triggerVelocityThrottle,
  recordPostForVelocity,
  healthCheck,
};
