/**
 * Routes NeuralRank — Proxy vers le microservice Rust de recommandation.
 *
 * Montage dans server.js : app.use('/api/neural-rank', require('./routes/neuralRankRoutes'))
 *
 * Endpoints :
 *   GET  /api/neural-rank/recommendations          → Feed personnalisé (tweets complets)
 *   POST /api/neural-rank/track                    → Tracker une interaction
 *   GET  /api/neural-rank/health                   → Santé du service Rust
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const rustClient = require('../services/rustRecommenderClient');
const { sequelize } = require('../database');
const { QueryTypes } = require('sequelize');
const redis = require('redis');

// Client Redis dédié à NeuralRank pour l'invalidation
let _redisClient;
async function getRedisClient() {
  if (_redisClient && _redisClient.isReady) return _redisClient;
  _redisClient = redis.createClient({
    socket: { host: '127.0.0.1', port: 6379 },
    password: process.env.REDIS_PASSWORD || 'linecraft_redis_2024',
  });
  _redisClient.on('error', (e) => logger.warn('[NeuralRank Redis]', e.message));
  await _redisClient.connect();
  return _redisClient;
}

// Fallback vers l'engine JS progressif si le service Rust est down
let ProgressiveEngine;
function getFallbackEngine() {
  if (!ProgressiveEngine) {
    ProgressiveEngine = new (require('../services/progressiveRecommendationEngine'))();
  }
  return ProgressiveEngine;
}

/**
 * Récupère les tweets complets depuis la DB à partir d'une liste d'IDs,
 * en préservant l'ordre Rust et en incluant author + interactions utilisateur.
 */
async function fetchTweetsByIds(tweetIds, userId) {
  if (!tweetIds || tweetIds.length === 0) return [];

  const idsStr = tweetIds.map(id => `'${id}'`).join(',');

  const rows = await sequelize.query(`
    SELECT
      t.id,
      t.content,
      t.created_at,
      t.is_retweet,
      t.is_quote,
      t.parent_tweet_id,
      t.media_urls,
      t.hashtags,
      t.mentions,
      t.tweet_type,
      t.original_tweet_id,
      -- Auteur
      u.id          AS author_id,
      u.username    AS author_username,
      u.full_name   AS author_full_name,
      u.avatar      AS author_avatar,
      u.verified    AS author_verified,
      u.verification_style AS author_verification_style,
      u.premium     AS author_premium,
      -- Stats agrégées
      COALESCE((SELECT COUNT(*) FROM tweet_likes    WHERE tweet_id = t.id), 0) AS likes_count,
      COALESCE((SELECT COUNT(*) FROM tweet_retweets WHERE tweet_id = t.id), 0) AS retweets_count,
      COALESCE((SELECT COUNT(*) FROM tweets         WHERE parent_tweet_id = t.id AND deleted_at IS NULL), 0) AS replies_count,
      COALESCE(t.view_count, 0) AS views_count,
      -- Interactions de l'utilisateur courant
      EXISTS(SELECT 1 FROM tweet_likes    WHERE tweet_id = t.id AND user_id = :userId::uuid) AS is_liked,
      EXISTS(SELECT 1 FROM tweet_retweets WHERE tweet_id = t.id AND user_id = :userId::uuid) AS is_retweeted
    FROM tweets t
    JOIN users u ON u.id = t.user_id
    WHERE t.id IN (${idsStr})
      AND t.deleted_at IS NULL
  `, {
    replacements: { userId },
    type: QueryTypes.SELECT,
  });

  // Construire un map id → row
  const byId = {};
  for (const row of rows) {
    byId[row.id] = row;
  }

  // Préserver l'ordre Rust
  const tweets = [];
  for (const id of tweetIds) {
    const row = byId[id];
    if (!row) continue;
    tweets.push({
      id: String(row.id),
      content: row.content || '',
      created_at: row.created_at,
      is_retweet: row.is_retweet || false,
      is_quote: row.is_quote || false,
      tweet_type: row.tweet_type || 'tweet',
      parent_tweet_id: row.parent_tweet_id || null,
      original_tweet_id: row.original_tweet_id || null,
      media_urls: row.media_urls || [],
      hashtags: row.hashtags || [],
      mentions: row.mentions || [],
      author: {
        id: String(row.author_id),
        username: row.author_username,
        full_name: row.author_full_name || row.author_username,
        avatar: row.author_avatar || null,
        verified: row.author_verified || false,
        verification_style: row.author_verification_style || 'default',
        premium: row.author_premium || false,
        stats: {},
      },
      stats: {
        likes: Number(row.likes_count),
        retweets: Number(row.retweets_count),
        replies: Number(row.replies_count),
        views: Number(row.views_count),
      },
      user_interaction: {
        is_liked: Boolean(row.is_liked),
        is_retweeted: Boolean(row.is_retweeted),
      },
    });
  }

  return tweets;
}

/**
 * GET /api/neural-rank/recommendations
 *
 * Query params :
 *   mode    = feed | discover | trending | for_you (défaut: for_you)
 *   limit   = nombre de tweets (défaut: 50, max: 200)
 *   offset  = pagination (défaut: 0)
 */
router.get('/recommendations', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { mode = 'for_you', limit = 50, offset = 0 } = req.query;
  const limitInt = Math.min(parseInt(limit) || 50, 200);
  const offsetInt = parseInt(offset) || 0;

  try {
    const result = await rustClient.getRecommendations(userId, {
      mode,
      limit: limitInt,
      offset: offsetInt,
    });

    logger.info(`[NeuralRank] user=${userId} mode=${mode} count=${result.count} latency=${result.latencyMs}ms cache=${result.cacheHit}`);

    // Hydrater les IDs en tweets complets
    const tweets = await fetchTweetsByIds(result.tweetIds, userId);

    return res.json({
      success: true,
      engine: 'rust-neural-rank',
      data: {
        recommendations: tweets,
        count: tweets.length,
        algorithm: result.algorithm,
        latency_ms: result.latencyMs,
        cache_hit: result.cacheHit,
        pagination: {
          limit: limitInt,
          offset: offsetInt,
          hasMore: result.count >= limitInt,
          total: result.count,
        },
      },
    });
  } catch (err) {
    logger.warn(`[NeuralRank] Rust service unavailable (${err.message}), using JS fallback`);

    // Fallback JS
    try {
      const fallback = getFallbackEngine();
      const fallbackResult = await fallback.getProgressiveRecommendations(userId, {
        limit: limitInt,
        offset: offsetInt,
      });

      return res.json({
        success: true,
        engine: 'js-progressive-fallback',
        data: {
          recommendations: fallbackResult.recommendations || [],
          count: fallbackResult.recommendations?.length || 0,
          pagination: {
            limit: limitInt,
            offset: offsetInt,
            hasMore: false,
            total: fallbackResult.recommendations?.length || 0,
          },
        },
      });
    } catch (fallbackErr) {
      logger.error(`[NeuralRank] Fallback also failed: ${fallbackErr.message}`);
      return res.status(500).json({ success: false, error: 'Service temporairement indisponible' });
    }
  }
});

/**
 * POST /api/neural-rank/track
 *
 * Body :
 *   tweetId        {number}
 *   interactionType {string}  — 'like', 'comment', 'retweet', 'share', 'view', 'skip', 'report', 'block', 'bookmark'
 *   dwellMs        {number?}  — temps en ms passé sur le contenu
 */
router.post('/track', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { tweetId, interactionType, dwellMs } = req.body;

  if (!tweetId || !interactionType) {
    return res.status(400).json({ success: false, error: 'tweetId et interactionType sont requis' });
  }

  const typeMap = {
    tweet_like: 'like', like: 'like',
    tweet_unlike: 'unlike', unlike: 'unlike',
    tweet_comment: 'comment', comment: 'comment',
    tweet_retweet: 'retweet', retweet: 'retweet',
    tweet_unretweet: 'unretweet', unretweet: 'unretweet',
    tweet_share: 'share', share: 'share',
    tweet_view: 'view', view: 'view',
    tweet_bookmark: 'bookmark', bookmark: 'bookmark',
    profile_view: 'profile_view',
    content_skip: 'skip', skip: 'skip',
    tweet_report: 'report', report: 'report',
    user_block: 'block', block: 'block',
  };

  const mappedType = typeMap[interactionType];
  if (!mappedType) {
    return res.status(400).json({ success: false, error: `Type d'interaction inconnu: ${interactionType}` });
  }

  try {
    const result = await rustClient.trackInteraction(userId, parseInt(tweetId), mappedType, dwellMs || null);
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`[NeuralRank] Track error: ${err.message}`);
    return res.json({ success: true, data: { tracked: false, reason: 'service_unavailable' } });
  }
});

/**
 * POST /api/neural-rank/on-publish
 *
 * Appelé après la publication d'un tweet.
 * Invalide les caches trending/discover NeuralRank pour que le nouveau tweet
 * apparaisse rapidement dans les fils des autres utilisateurs.
 *
 * Body : { tweetId: string }
 */
router.post('/on-publish', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { tweetId } = req.body;

  logger.info(`[NeuralRank] on-publish user=${userId} tweet=${tweetId}`);

  // Invalider le cache NeuralRank de l'auteur (ses propres recos)
  try {
    await rustClient.invalidateUser(userId);
  } catch { /* non-fatal */ }

  // Invalider les caches trending et discover pour tous les users via Redis
  try {
    const rc = await getRedisClient();
    // SCAN + DEL sur twitninf:reco:*:trending et twitninf:reco:*:discover
    for (const pattern of ['twitninf:reco:*:trending', 'twitninf:reco:*:discover', 'twitninf:reco:*:for_you']) {
      const keys = await rc.keys(pattern);
      if (keys.length > 0) {
        await rc.del(keys);
        logger.info(`[NeuralRank] Invalidated ${keys.length} cache keys for pattern ${pattern}`);
      }
    }
  } catch (redisErr) {
    logger.warn(`[NeuralRank] Redis invalidation failed: ${redisErr.message}`);
  }

  return res.json({ success: true, message: 'Caches NeuralRank invalidés' });
});

/**
 * GET /api/neural-rank/health
 */
router.get('/health', authenticateToken, async (req, res) => {
  const status = await rustClient.healthCheck();
  const code = status.healthy ? 200 : 503;
  return res.status(code).json({ success: true, data: status });
});

module.exports = router;
