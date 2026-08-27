const { Tweet, User } = require('../models');
const logger = require('../utils/logger');
const { processPendingTweet } = require('./geminiService');
const tweetImageService = require('./tweetImageService');
const TweetQueueService = require('./tweetQueueService');

/**
 * Chemin de création MINIMAL pour l'API publique (tweets texte, une image au
 * plus) : même squelette que `POST /api/tweets` (statut `pending` ->
 * traitement Gemini/PolicierCongo en tâche de fond -> verdict appliqué),
 * volontairement sans les options premium de la route interne (Spotify,
 * audio, traduction, AB test, moteur vidéo) — hors périmètre de l'API
 * publique v1. Un tweet créé ici doit rester soumis à la même modération
 * qu'un tweet créé depuis l'app, voir [[filtre-qualite-tweets]].
 */

/**
 * Même logique que `applyAutomatedTweetUpdate` dans `tweetRoutes.js` : un
 * verdict communautaire déjà final ne doit jamais être écrasé par un verdict
 * automatique arrivé après coup.
 */
async function applyAutomatedTweetUpdate(tweetId, patch) {
  return Tweet.sequelize.transaction(async (tx) => {
    const current = await Tweet.findByPk(tweetId, {
      transaction: tx,
      lock: tx.LOCK.UPDATE,
      paranoid: false,
    });
    if (!current) return null;

    if (current.metadata?.community_review?.final === true) {
      return null;
    }

    const { metadata, ...fields } = patch;
    await current.update({
      ...fields,
      ...(metadata ? { metadata: { ...(current.metadata || {}), ...metadata } } : {}),
    }, { transaction: tx });
    return current;
  });
}

/**
 * @param {string} userId
 * @param {{ content: string, parentTweetId?: string, mediaUrls?: string[] }} input
 * @param {{ source: string, ip?: string, userAgent?: string }} context
 * @returns {Promise<import('../models').Tweet>} le tweet créé, avec son auteur.
 */
async function createTweet(userId, { content, parentTweetId = null, mediaUrls = [] }, context) {
  let originalTweetId = null;
  let tweetType = 'tweet';

  if (parentTweetId) {
    const parent = await Tweet.findByPk(parentTweetId);
    if (!parent) {
      const err = new Error('Tweet parent non trouvé');
      err.status = 404;
      throw err;
    }
    if (parent.is_private && parent.user_id !== userId) {
      const err = new Error('Vous ne pouvez pas répondre à ce tweet privé');
      err.status = 403;
      throw err;
    }
    originalTweetId = parent.original_tweet_id || parent.id;
    tweetType = 'reply';
  }

  const tweet = await Tweet.create({
    content,
    user_id: userId,
    parent_tweet_id: parentTweetId,
    original_tweet_id: originalTweetId,
    tweet_type: tweetType,
    media_urls: tweetImageService.sanitizeMediaUrls(mediaUrls),
    is_private: false,
    is_sensitive: false,
    language: 'fr',
    moderation_status: 'pending',
    metadata: {
      source: context.source,
      device: context.userAgent || 'unknown',
      ip_address: context.ip,
      created_at: new Date().toISOString(),
      pending_processing: true,
    },
  });

  const tweetWithAuthor = await Tweet.findByPk(tweet.id, {
    include: [{
      model: User,
      as: 'author',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization'],
    }],
  });

  try {
    const tweetQueueService = new TweetQueueService();
    await tweetQueueService.addTweetToQueue(tweet.id, userId);
  } catch (error) {
    logger.error(`[publicApi] Erreur ajout du tweet ${tweet.id} à la queue:`, error);
  }

  setImmediate(async () => {
    try {
      const author = await User.findByPk(userId, { attributes: ['username'] });
      if (!author) return;

      const processResult = await processPendingTweet(tweet.id, content, author.username, !!parentTweetId);

      if (processResult.success) {
        await applyAutomatedTweetUpdate(tweet.id, {
          moderation_status: processResult.moderation_status,
          moderation_reason: processResult.moderation_reason,
          metadata: {
            processing_result: processResult,
            processed_at: processResult.processed_at,
          },
        });
      }
    } catch (error) {
      logger.error(`[publicApi] Erreur traitement asynchrone du tweet ${tweet.id}:`, error);
      await applyAutomatedTweetUpdate(tweet.id, {
        moderation_status: 'approved',
        metadata: { processing_error: error.message, processed_at: new Date().toISOString() },
      });
    }
  });

  return tweetWithAuthor;
}

module.exports = { createTweet };
