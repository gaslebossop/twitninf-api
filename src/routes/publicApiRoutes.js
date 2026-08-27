const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { Tweet, User, TweetLike, TweetRetweet, UserFollow, Notification } = require('../models');
const { requireOAuthScopes } = require('../middleware/oauthMiddleware');
const { stripInternalTweetFields } = require('../utils/stripInternalTweetFields');
const { resolveEngagementTarget } = require('../utils/engagementTarget');
const { filterVisibleTweets } = require('../utils/privateAccountVisibility');
const { assertTweetLength } = require('../utils/tweetLimits');
const paidContentService = require('../services/paidContentService');
const tweetCreationService = require('../services/tweetCreationService');
const RealtimeQueueService = require('../services/realtimeQueueService');
const logger = require('../utils/logger');

const router = express.Router();
const realtimeQueueService = new RealtimeQueueService();

const PUBLIC_PROFILE_ATTRIBUTES = [
  'id', 'username', 'full_name', 'avatar', 'banner', 'bio', 'verified',
  'premium', 'subscription_tier', 'verification_style', 'stats',
  'is_private_account', 'created_at',
];

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

/**
 * Un compte bloqué (dans un sens ou l'autre) ou privé-et-non-suivi doit être
 * invisible pour ce viewer — que ce soit pour LIRE un de ses tweets ou pour
 * INTERAGIR avec (like/retweet/réponse). `filterVisibleTweets` ne couvre que
 * le cas privé, jamais le blocage : les deux sont donc vérifiés ici.
 */
async function assertAuthorVisible(viewerId, authorId) {
  if (String(authorId) === String(viewerId)) return true;
  const blocked = await UserFollow.getBlockDirection(viewerId, authorId);
  if (blocked) return false;
  const author = await User.findByPk(authorId, { attributes: ['id', 'is_private_account'] });
  if (!author) return false;
  if (author.is_private_account) {
    return UserFollow.isFollowing(viewerId, authorId);
  }
  return true;
}

async function hydrateTweetStats(tweets, viewerId) {
  const ids = tweets.map((t) => String(t.id));
  const [likes, retweets, replies, liked, retweeted] = await Promise.all([
    TweetLike.countLikesForTweets(ids),
    TweetRetweet.countRetweetsForTweets(ids),
    Tweet.countRepliesForTweets(ids),
    TweetLike.likedTweetIdsForUser(viewerId, ids),
    TweetRetweet.retweetedTweetIdsForUser(viewerId, ids),
  ]);

  return tweets.map((tweet) => {
    const id = String(tweet.id);
    return {
      ...stripInternalTweetFields(tweet.toJSON ? tweet.toJSON() : tweet),
      stats: {
        likes: likes.get(id) || 0,
        retweets: retweets.get(id) || 0,
        replies: replies.get(id) || 0,
        views: tweet.view_count || 0,
      },
      user_interaction: {
        is_liked: liked.has(id),
        is_retweeted: retweeted.has(id),
      },
    };
  });
}

// ========================================
// read:profile
// ========================================

router.get('/me', requireOAuthScopes(['read:profile']), async (req, res) => {
  const user = await User.findByPk(req.user.id, { attributes: PUBLIC_PROFILE_ATTRIBUTES });
  if (!user) return res.status(404).json({ success: false, message: 'Profil introuvable' });
  res.json({ success: true, data: { user } });
});

router.get('/users/:username', [
  requireOAuthScopes(['read:profile']),
  param('username').isLength({ min: 1, max: 30 }),
  handleValidationErrors,
], async (req, res) => {
  const user = await User.findOne({
    where: { username: req.params.username, is_active: true, is_suspended: false },
    attributes: PUBLIC_PROFILE_ATTRIBUTES,
  });
  if (!user) return res.status(404).json({ success: false, message: 'Profil introuvable' });
  res.json({ success: true, data: { user } });
});

// ========================================
// read:tweets
// ========================================

router.get('/tweets/:id', [
  requireOAuthScopes(['read:tweets']),
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const tweet = await Tweet.findOne({
      where: { id: req.params.id, moderation_status: 'approved' },
      include: [{ model: User, as: 'author', attributes: PUBLIC_PROFILE_ATTRIBUTES.filter((a) => a !== 'stats') }],
    });
    if (!tweet) return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    if (!(await assertAuthorVisible(req.user.id, tweet.user_id))) {
      return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    }

    const [enriched] = await hydrateTweetStats([tweet], req.user.id);
    const masked = await paidContentService.maskTweet(enriched, req.user.id);
    res.json({ success: true, data: { tweet: masked } });
  } catch (error) {
    logger.error('[publicApi] GET /tweets/:id', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

router.get('/users/:username/tweets', [
  requireOAuthScopes(['read:tweets']),
  param('username').isLength({ min: 1, max: 30 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const target = await User.findOne({
      where: { username: req.params.username, is_active: true, is_suspended: false },
      attributes: ['id', 'is_private_account'],
    });
    if (!target) return res.status(404).json({ success: false, message: 'Profil introuvable' });

    if (String(target.id) !== String(req.user.id)) {
      const blocked = await UserFollow.getBlockDirection(req.user.id, target.id);
      if (blocked) {
        return res.json({ success: true, data: { tweets: [], pagination: { total: 0, limit: +limit, offset: +offset, hasMore: false } } });
      }
      if (target.is_private_account && !(await UserFollow.isFollowing(req.user.id, target.id))) {
        return res.json({ success: true, data: { tweets: [], pagination: { total: 0, limit: +limit, offset: +offset, hasMore: false } } });
      }
    }

    const rows = await Tweet.findAll({
      where: { user_id: target.id, parent_tweet_id: null, moderation_status: 'approved' },
      include: [{ model: User, as: 'author', attributes: PUBLIC_PROFILE_ATTRIBUTES.filter((a) => a !== 'stats') }],
      order: [['created_at', 'DESC']],
      limit: +limit,
      offset: +offset,
    });

    const enriched = await hydrateTweetStats(rows, req.user.id);
    const masked = await paidContentService.maskTweets(enriched, req.user.id);

    res.json({
      success: true,
      data: { tweets: masked, pagination: { limit: +limit, offset: +offset, hasMore: rows.length === +limit } },
    });
  } catch (error) {
    logger.error('[publicApi] GET /users/:username/tweets', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

router.get('/search/tweets', [
  requireOAuthScopes(['read:tweets']),
  query('q').trim().isLength({ min: 1, max: 100 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const { q, limit = 20, offset = 0 } = req.query;
    const requestedLimit = +limit;

    const blockedIds = await UserFollow.getBlockedIds(req.user.id);
    const fetched = await Tweet.searchTweets(q, {
      limit: requestedLimit + 1,
      offset: +offset,
      sortBy: 'created_at',
      sortOrder: 'DESC',
    });
    const filtered = blockedIds.length
      ? fetched.filter((t) => !blockedIds.includes(String(t.user_id)))
      : fetched;
    const visible = await filterVisibleTweets(filtered, req.user.id, { User, UserFollow, Op });
    const hasMore = visible.length > requestedLimit;
    const tweets = visible.slice(0, requestedLimit);

    const enriched = await hydrateTweetStats(tweets, req.user.id);
    const masked = await paidContentService.maskTweets(enriched, req.user.id);

    res.json({ success: true, data: { query: q, tweets: masked, pagination: { limit: requestedLimit, offset: +offset, hasMore } } });
  } catch (error) {
    logger.error('[publicApi] GET /search/tweets', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

// ========================================
// write:tweets
// ========================================

router.post('/tweets', [
  requireOAuthScopes(['write:tweets']),
  body('content').trim().custom((value, meta) => {
    if (!value) throw new Error('Le contenu ne peut pas être vide');
    return assertTweetLength(value, meta);
  }),
  body('media_urls').optional().isArray(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const tweet = await tweetCreationService.createTweet(
      req.user.id,
      { content: req.body.content, mediaUrls: req.body.media_urls || [] },
      { source: 'public_api', ip: req.ip, userAgent: `oauth:${req.oauthApp.name}` },
    );
    res.status(201).json({ success: true, data: { tweet: stripInternalTweetFields(tweet.toJSON()) } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    logger.error('[publicApi] POST /tweets', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

router.post('/tweets/:id/reply', [
  requireOAuthScopes(['write:tweets']),
  param('id').isUUID(),
  body('content').trim().custom((value, meta) => {
    if (!value) throw new Error('Le contenu ne peut pas être vide');
    return assertTweetLength(value, meta);
  }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const parent = await Tweet.findByPk(req.params.id, { attributes: ['id', 'user_id'] });
    if (!parent) return res.status(404).json({ success: false, message: 'Tweet parent non trouvé' });
    if (!(await assertAuthorVisible(req.user.id, parent.user_id))) {
      return res.status(404).json({ success: false, message: 'Tweet parent non trouvé' });
    }

    const tweet = await tweetCreationService.createTweet(
      req.user.id,
      { content: req.body.content, parentTweetId: req.params.id },
      { source: 'public_api', ip: req.ip, userAgent: `oauth:${req.oauthApp.name}` },
    );
    res.status(201).json({ success: true, data: { tweet: stripInternalTweetFields(tweet.toJSON()) } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    logger.error('[publicApi] POST /tweets/:id/reply', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

// ========================================
// write:interactions
// ========================================

router.post('/tweets/:id/like', [
  requireOAuthScopes(['write:interactions']),
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const userId = req.user.id;
    const { tweet: requested, targetTweet: tweet, targetId: id } = await resolveEngagementTarget(Tweet, req.params.id);
    if (!requested) return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    if (!(await assertAuthorVisible(userId, tweet.user_id))) {
      return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    }

    const existing = await TweetLike.findOne({ where: { tweet_id: id, user_id: userId } });
    if (existing) {
      return res.json({ success: true, data: { liked: true } });
    }

    await TweetLike.create({
      tweet_id: id,
      user_id: userId,
      metadata: { source: 'public_api', app: req.oauthApp.name },
    });
    if (tweet.user_id !== userId) {
      await Notification.createLikeNotification(userId, id, tweet.user_id);
    }
    await realtimeQueueService.updateLikesRealtime(id, userId);

    res.json({ success: true, data: { liked: true } });
  } catch (error) {
    logger.error('[publicApi] POST /tweets/:id/like', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

router.delete('/tweets/:id/like', [
  requireOAuthScopes(['write:interactions']),
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const userId = req.user.id;
    const { tweet: requested, targetTweet: tweet, targetId: id } = await resolveEngagementTarget(Tweet, req.params.id);
    if (!requested) return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    if (!(await assertAuthorVisible(userId, tweet.user_id))) {
      return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    }

    const existing = await TweetLike.findOne({ where: { tweet_id: id, user_id: userId } });
    if (existing) {
      await existing.destroy();
      await realtimeQueueService.decrementLikesRealtime(id, userId);
      await realtimeQueueService.syncTweetInteractions(id);
    }

    res.json({ success: true, data: { liked: false } });
  } catch (error) {
    logger.error('[publicApi] DELETE /tweets/:id/like', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

router.post('/tweets/:id/retweet', [
  requireOAuthScopes(['write:interactions']),
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const userId = req.user.id;
    const { tweet: requested, targetTweet: tweet, targetId: id } = await resolveEngagementTarget(Tweet, req.params.id);
    if (!requested) return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    if (!(await assertAuthorVisible(userId, tweet.user_id))) {
      return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    }

    const existing = await TweetRetweet.findOne({ where: { tweet_id: id, user_id: userId } });
    if (existing) {
      return res.json({ success: true, data: { retweeted: true } });
    }

    await TweetRetweet.create({
      tweet_id: id,
      user_id: userId,
      retweet_type: 'retweet',
      metadata: { source: 'public_api', app: req.oauthApp.name },
    });
    await realtimeQueueService.updateRetweetsRealtime(id, userId);

    res.json({ success: true, data: { retweeted: true } });
  } catch (error) {
    logger.error('[publicApi] POST /tweets/:id/retweet', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

router.delete('/tweets/:id/retweet', [
  requireOAuthScopes(['write:interactions']),
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const userId = req.user.id;
    const { tweet: requested, targetTweet: tweet, targetId: id } = await resolveEngagementTarget(Tweet, req.params.id);
    if (!requested) return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    if (!(await assertAuthorVisible(userId, tweet.user_id))) {
      return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    }

    const existing = await TweetRetweet.findOne({ where: { tweet_id: id, user_id: userId } });
    if (existing) {
      await TweetRetweet.destroy({ where: { tweet_id: id, user_id: userId } });
      await realtimeQueueService.decrementRetweetsRealtime(id, userId);
      await realtimeQueueService.syncTweetInteractions(id);
    }

    res.json({ success: true, data: { retweeted: false } });
  } catch (error) {
    logger.error('[publicApi] DELETE /tweets/:id/retweet', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

module.exports = router;
