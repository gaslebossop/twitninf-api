/**
 * ═══════════════════════════════════════════════════════════════════════
 *  RETARGETING HOOK — Pont entre l'API Twitninf et le module de ciblage
 *
 *  Appelle createBatch() sur chaque interaction utilisateur :
 *    - post   → nouveau tweet
 *    - like   → like d'un tweet
 *    - retweet / quote
 *    - comment → réponse à un tweet
 *
 *  better-sqlite3 est SYNCHRONE → appel direct, pas de setImmediate.
 *  Non-bloquant côté HTTP car sqlite3 est O(1) pour un INSERT.
 * ═══════════════════════════════════════════════════════════════════════
 */

const path = require('path');
const logger = require('../utils/logger');

// ─── Résolution du chemin ──────────────────────────────────────────────────────
// Depuis api/src/services/  →  ../../../  =  racine du projet (IAFILTRE ou /home/debian)
// Puis on pointe directement sur extendedTargetingService (bypass index.js)
const TARGETING_ROOT = path.resolve(__dirname, '../../../targeting');
const SERVICE_PATH = path.join(TARGETING_ROOT, 'extendedTargetingService');
const DB_PATH = path.join(TARGETING_ROOT, 'db');

let _createBatch = null;   // fonction createBatch chargée paresseusement
let _loadError = null;   // erreur de chargement (loggée une seule fois)

/**
 * Charge createBatch() depuis extendedTargetingService.
 * Initialise la DB si elle ne l'est pas encore.
 * Retourne la fonction ou null si le module est indisponible.
 */
function getCreateBatch() {
  if (_createBatch) return _createBatch;
  if (_loadError) return null; // déjà échoué → ne pas re-tenter

  try {
    // S'assurer que la DB est ouverte (idempotent : retourne la connexion existante si déjà ouverte)
    const { getDB } = require(DB_PATH);
    getDB(); // ouvre la connexion SQLite si pas encore fait

    // Charger le service
    const service = require(SERVICE_PATH);
    if (typeof service.createBatch !== 'function') {
      throw new Error('createBatch n\'est pas une fonction dans extendedTargetingService');
    }

    _createBatch = service.createBatch;
    logger.info(`🎯 [RetargetingHook] createBatch chargé depuis ${SERVICE_PATH}`);
    return _createBatch;

  } catch (err) {
    _loadError = err.message;
    // Le module de ciblage est un STUB volontairement absent en production
    // (voir api/CLAUDE.md : « targeting (stub) »). Son absence n'est donc pas
    // une erreur mais un état de déploiement attendu : on la journalise une
    // seule fois, au niveau `warn`, pour ne pas polluer l'agrégation d'erreurs
    // (elle y ressortait ~10×, une par redémarrage). Le retargeting devient
    // simplement un no-op.
    logger.warn(`🎯 [RetargetingHook] Ciblage indisponible (module stub absent), retargeting désactivé: ${err.message}`);
    return null;
  }
}

/**
 * Crée un batch de retargeting (appel synchrone, non-bloquant car O(1) INSERT).
 *
 * @param {string} userId           - ID de l'utilisateur qui interagit
 * @param {string} tweetId          - ID du tweet concerné
 * @param {string} interactionType  - 'like' | 'retweet' | 'quote' | 'comment' | 'post'
 * @param {string} tweetContent     - Contenu textuel du tweet
 * @param {string[]} mediaUrls      - URLs des médias attachés
 * @param {string} authorUsername   - @username de l'auteur du tweet
 */
function trackInteraction(userId, tweetId, interactionType, tweetContent = '', mediaUrls = [], authorUsername = '') {
  try {
    const createBatch = getCreateBatch();
    if (!createBatch) return; // module indisponible → skip silencieux (déjà loggé)

    const batchId = createBatch(
      String(userId),
      String(tweetId),
      interactionType,
      tweetContent || '',
      Array.isArray(mediaUrls) ? mediaUrls : [],
      authorUsername || ''
    );

    if (batchId) {
      logger.info(`📦 [Retargeting] ✅ Batch créé → user=${String(userId).substring(0, 8)}… type=${interactionType} tweet=${String(tweetId).substring(0, 8)}… batchId=${String(batchId).substring(0, 8)}…`);
    } else {
      logger.warn(`⚠️ [Retargeting] createBatch a retourné null pour user=${userId} type=${interactionType}`);
    }
  } catch (err) {
    // Non-critique : une erreur de ciblage ne doit jamais faire planter l'API
    logger.error(`❌ [RetargetingHook] Erreur lors de createBatch (${interactionType}): ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers sémantiques exposés dans tweetRoutes.js
// ─────────────────────────────────────────────────────────────────────────────

/** Utilisateur like un tweet */
function trackLike({ userId, tweetId, tweetContent, authorUsername, mediaUrls }) {
  trackInteraction(userId, tweetId, 'like', tweetContent, mediaUrls, authorUsername);
}

/** Utilisateur retweet sans commentaire */
function trackRetweet({ userId, tweetId, tweetContent, authorUsername, mediaUrls }) {
  trackInteraction(userId, tweetId, 'retweet', tweetContent, mediaUrls, authorUsername);
}

/** Utilisateur cite un tweet (retweet + commentaire) */
function trackQuote({ userId, tweetId, tweetContent, authorUsername, mediaUrls }) {
  trackInteraction(userId, tweetId, 'quote', tweetContent, mediaUrls, authorUsername);
}

/** Utilisateur répond à un tweet (comment/reply) */
function trackComment({ userId, tweetId, tweetContent, authorUsername, mediaUrls }) {
  trackInteraction(userId, tweetId, 'comment', tweetContent, mediaUrls, authorUsername);
}

/** Utilisateur publie un nouveau tweet */
function trackPost({ userId, tweetId, tweetContent, mediaUrls }) {
  trackInteraction(userId, tweetId, 'post', tweetContent, mediaUrls, '');
}

module.exports = {
  trackInteraction,
  trackLike,
  trackRetweet,
  trackQuote,
  trackComment,
  trackPost
};
