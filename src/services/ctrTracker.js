/**
 * Service pour envoyer les événements d'interaction au recommandeur Rust
 * Cela remplit les CTR samples pour l'auto-tuner de l'algorithme
 *
 * Types d'interactions supportées (de models.rs):
 * - Like (1.0), Unlike (-1.0)
 * - Comment (3.5)
 * - Retweet (5.0), Unretweet (-2.0)
 * - Share (4.0)
 * - Bookmark (2.5)
 * - View (0.2)
 * - ProfileView (1.5)
 * - Skip (-0.5)
 * - Report (-12.0)
 * - Block (-20.0)
 */

const logger = require('../utils/logger');

const RUST_RECOMMENDER_URL = process.env.RUST_RECOMMENDER_URL || 'http://localhost:3002';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'changeme-internal-secret';

/**
 * Envoie une interaction au recommandeur Rust
 * @param {string} userId - UUID de l'utilisateur
 * @param {string} tweetId - UUID du tweet
 * @param {string} interactionType - Type d'interaction (from InteractionType enum)
 * @param {number} dwellMs - Temps passé sur le tweet en ms (optionnel)
 */
async function trackInteraction(userId, tweetId, interactionType, dwellMs = null) {
  if (!userId || !tweetId || !interactionType) {
    logger.warn('⚠️ [ctrTracker] userId, tweetId ou interactionType manquant');
    return;
  }

  try {
    const payload = {
      user_id: userId,
      tweet_id: tweetId,
      interaction_type: interactionType,
    };

    // Ajouter dwell_ms si fourni et valide
    if (dwellMs && typeof dwellMs === 'number' && dwellMs > 0) {
      payload.dwell_ms = Math.min(dwellMs, 60000); // Max 1 min
    }

    const response = await fetch(`${RUST_RECOMMENDER_URL}/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': INTERNAL_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.warn(`⚠️ [ctrTracker] Erreur ${response.status}: ${error}`);
      return;
    }

    logger.debug(`📊 [ctrTracker] Interaction "${interactionType}" enregistrée pour user ${userId} sur tweet ${tweetId}`);
  } catch (error) {
    logger.warn(`⚠️ [ctrTracker] Impossible de contacter le recommandeur: ${error.message}`);
    // Non-blocking: on continue même si le tracking échoue
  }
}

// ═══════════════════════════════════════════════════════════════════
// 📊 Interactions positives (augmentent le score)
// ═══════════════════════════════════════════════════════════════════

/**
 * Envoie un événement quand un user voit un tweet (0.2 points)
 */
async function trackView(userId, tweetId, dwellMs = null) {
  return trackInteraction(userId, tweetId, 'view', dwellMs);
}

/**
 * Envoie un événement quand un user like un tweet (1.0 point)
 */
async function trackLike(userId, tweetId) {
  return trackInteraction(userId, tweetId, 'like');
}

/**
 * Envoie un événement quand un user retweet un tweet (5.0 points)
 */
async function trackRetweet(userId, tweetId) {
  return trackInteraction(userId, tweetId, 'retweet');
}

/**
 * Envoie un événement quand un user commente/répond à un tweet (3.5 points)
 */
async function trackComment(userId, tweetId, dwellMs = null) {
  return trackInteraction(userId, tweetId, 'comment', dwellMs);
}

/**
 * Envoie un événement quand un user partage un tweet (4.0 points)
 */
async function trackShare(userId, tweetId) {
  return trackInteraction(userId, tweetId, 'share');
}

/**
 * Envoie un événement quand un user ajoute un tweet à ses favoris (2.5 points)
 */
async function trackBookmark(userId, tweetId) {
  return trackInteraction(userId, tweetId, 'bookmark');
}

/**
 * Envoie un événement quand un user visite le profil d'un auteur (1.5 points)
 */
async function trackProfileView(userId, profileUserId) {
  return trackInteraction(userId, profileUserId, 'profile_view');
}

// ═══════════════════════════════════════════════════════════════════
// 📉 Interactions négatives (diminuent le score)
// ═══════════════════════════════════════════════════════════════════

/**
 * Envoie un événement quand un user unlike un tweet (-1.0 point)
 */
async function trackUnlike(userId, tweetId) {
  return trackInteraction(userId, tweetId, 'unlike');
}

/**
 * Envoie un événement quand un user un-retweet un tweet (-2.0 points)
 */
async function trackUnretweet(userId, tweetId) {
  return trackInteraction(userId, tweetId, 'unretweet');
}

/**
 * Envoie un événement quand un user skip/ignore un tweet (-0.5 point)
 */
async function trackSkip(userId, tweetId) {
  return trackInteraction(userId, tweetId, 'skip');
}

/**
 * Envoie un événement quand un user signale un tweet (-12.0 points)
 */
async function trackReport(userId, tweetId, reason = null) {
  return trackInteraction(userId, tweetId, 'report');
}

/**
 * Envoie un événement quand un user bloque un auteur (-20.0 points)
 */
async function trackBlock(userId, blockedUserId) {
  return trackInteraction(userId, blockedUserId, 'block');
}

module.exports = {
  // Core
  trackInteraction,

  // Positives
  trackView,
  trackLike,
  trackRetweet,
  trackComment,
  trackShare,
  trackBookmark,
  trackProfileView,

  // Negatives
  trackUnlike,
  trackUnretweet,
  trackSkip,
  trackReport,
  trackBlock,

  // Legacy aliases
  trackTweetView: trackView,
  trackTweetLike: trackLike,
  trackTweetRetweet: trackRetweet,
  trackTweetReply: trackComment,
};
