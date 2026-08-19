/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SIMILARITY MODULE — Entry Point (V2)
 *
 *  Point d'entrée unique pour tout le système de recommandation multi-signal.
 *  Expose un singleton initialisé au démarrage du serveur.
 *
 *  Usage dans server.js :
 *    const similarity = require('./services/similarity');
 *    await similarity.initialize(models);
 *
 *  Usage dans les routes :
 *    const { getEngine, getAdEngine } = require('../services/similarity');
 *    const results = getEngine().getRecommendations(userId, 50);
 *    const ads = getAdEngine().selectAdsForFeed(userId, results.length);
 *
 *  Nouveau en V2 :
 *    - Le moteur charge aussi UserFollow pour le graphe social
 *    - Engagement velocity et trending cache
 *    - Cold start intelligent pour les nouveaux users
 *    - Hashtag affinity tracking
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const { SimilarityRecommendationEngine } = require('./recommendationEngine');
const { AdTargetingEngine } = require('./adTargetingEngine');
const logger = require('../../utils/logger');

let _engine = null;
let _adEngine = null;

/**
 * Initialise les deux moteurs.
 * Appelé une seule fois au démarrage du serveur.
 *
 * @param {Object} sequelizeModels - { Tweet, TweetLike, TweetRetweet, User, UserFollow, ... }
 * @returns {Promise<boolean>}
 */
async function initialize(sequelizeModels) {
  try {
    // 1. Moteur de recommandation V2
    _engine = new SimilarityRecommendationEngine();
    await _engine.initialize(sequelizeModels);

    // 2. Moteur publicitaire
    _adEngine = new AdTargetingEngine();

    console.log('🎯 [Similarity Module V2] ✅ Moteurs initialisés (multi-signal + cold start)');
    return true;
  } catch (err) {
    logger.error('❌ [Similarity Module V2] Erreur initialisation:', err.message);
    return false;
  }
}

/**
 * Retourne le moteur de recommandation (singleton).
 */
function getEngine() {
  if (!_engine) {
    // Créer un moteur vide si pas encore initialisé (mode dégradé)
    _engine = new SimilarityRecommendationEngine();
  }
  return _engine;
}

/**
 * Retourne le moteur publicitaire (singleton).
 */
function getAdEngine() {
  if (!_adEngine) {
    _adEngine = new AdTargetingEngine();
  }
  return _adEngine;
}

/**
 * Notifie le moteur d'un nouveau follow (temps réel).
 */
function onFollow(followerId, followingId) {
  if (_engine) {
    _engine.onFollow(followerId, followingId);
  }
}

/**
 * Notifie le moteur d'un unfollow (temps réel).
 */
function onUnfollow(followerId, followingId) {
  if (_engine) {
    _engine.onUnfollow(followerId, followingId);
  }
}

/**
 * Arrêt propre des moteurs.
 */
function shutdown() {
  if (_engine) _engine.shutdown();
  console.log('🛑 [Similarity Module V2] Arrêté');
}

function getAlgorithmConfig() {
  return _engine ? _engine.getAlgorithmConfig() : null;
}

function getAlgorithmAdminStats() {
  return _engine ? _engine.getAlgorithmStats() : null;
}

function applyAlgorithmConfig(patch) {
  if (!_engine) {
    return { success: false, message: 'Moteur similarity non initialisé' };
  }
  return _engine.applyAlgorithmConfig(patch);
}

async function reloadShadowbanMaps() {
  if (!_engine || typeof _engine.reloadShadowbanMaps !== 'function') {
    return false;
  }
  await _engine.reloadShadowbanMaps();
  return true;
}

module.exports = {
  initialize,
  getEngine,
  getAdEngine,
  onFollow,
  onUnfollow,
  shutdown,
  getAlgorithmConfig,
  getAlgorithmAdminStats,
  applyAlgorithmConfig,
  reloadShadowbanMaps,
};
