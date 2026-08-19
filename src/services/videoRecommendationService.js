const { RecommendationEngine } = require('./videoRecommendationEngine');
const logger = require('../utils/logger');
const { Op } = require('sequelize');

/**
 * Service wrapper for the TikTok-like Recommendation Engine.
 * Manages data synchronization between PostgreSQL and the memory-resident engine.
 */
class VideoRecommendationService {
  constructor() {
    this.engine = new RecommendationEngine();
    this._initialized = false;
  }

  /**
   * Initialize the engine with data from the database.
   * @param {Object} models - Sequelize models
   */
  async initialize(models) {
    try {
      const { User, Tweet, UserFollow, TweetLike, TweetRetweet } = models;
      this.Tweet = Tweet; // Store for real-time persistence

      logger.info('🚀 [VideoReco] Starting database sync...');

      // 1. Fetch all users and follows
      const [users, follows] = await Promise.all([
        User.findAll({ attributes: ['id'], raw: true }),
        UserFollow.findAll({ attributes: ['follower_id', 'following_id'], raw: true })
      ]);

      const followMap = {};
      follows.forEach(f => {
        if (!followMap[f.follower_id]) followMap[f.follower_id] = [];
        followMap[f.follower_id].push(f.following_id);
      });

      users.forEach(u => {
        this.engine.addUser(u.id, followMap[u.id] || []);
      });

      // 2. Fetch all video tweets
      const videos = await Tweet.findAll({
        where: { 
          tweet_type: 'video', 
          deleted_at: null,
          moderation_status: 'approved'
        },
        attributes: ['id', 'user_id', 'content', 'hashtags', 'created_at'],
        raw: true
      });

      videos.forEach(v => {
        this.engine.addVideo(v.id, {
          authorId: v.user_id,
          title: v.content,
          tags: Array.isArray(v.hashtags) ? v.hashtags.join(' ') : (v.hashtags || ""),
          createdAt: new Date(v.created_at).getTime()
        });
      });

      // 3. Fetch all interactions for these videos
      const videoIds = videos.map(v => v.id);

      const [likes, retweets, replies] = await Promise.all([
        TweetLike.findAll({
          where: { tweet_id: { [Op.in]: videoIds } },
          attributes: ['user_id', 'tweet_id', 'created_at'],
          raw: true
        }),
        TweetRetweet.findAll({
          where: { tweet_id: { [Op.in]: videoIds } },
          attributes: ['user_id', 'tweet_id', 'created_at'],
          raw: true
        }),
        Tweet.findAll({
          where: { 
            parent_tweet_id: { [Op.in]: videoIds },
            deleted_at: null
          },
          attributes: ['user_id', 'parent_tweet_id', 'created_at'],
          raw: true
        })
      ]);

      likes.forEach(l => {
        this.engine.addInteraction(l.user_id, l.tweet_id, 'like', new Date(l.created_at).getTime());
      });

      retweets.forEach(r => {
        this.engine.addInteraction(r.user_id, r.tweet_id, 'repost', new Date(r.created_at).getTime());
      });

      replies.forEach(rp => {
        this.engine.addInteraction(rp.user_id, rp.parent_tweet_id, 'comment', new Date(rp.created_at).getTime());
      });

      // 4. Build final index
      this.engine.build();
      this._initialized = true;
      logger.info(`✅ [VideoReco] Engine ready (${users.length} users, ${videos.length} videos loaded)`);
    } catch (error) {
      logger.error('❌ [VideoReco] Initialization failed:', error);
    }
  }

  /**
   * Get video recommendations for a user.
   */
  recommend(userId, options = {}) {
    if (!this._initialized) return [];
    try {
      const { 
        limit = 20, 
        offset = 0, 
        forceRefresh = false 
      } = options;
      
      return this.engine.recommend(userId, { limit, offset, forceRefresh });
    } catch (error) {
      logger.error(`❌ [VideoReco] Recommendation error for ${userId}:`, error.message);
      return [];
    }
  }

  /**
   * Real-time update: User interaction.
   */
  onInteraction(userId, videoId, type, meta = {}) {
    if (!this._initialized) return;
    try {
      // Map interaction types if necessary
      let mappedType = type;
      if (type === 'reply' || type === 'tweet_reply' || type === 'comment') mappedType = 'comment';
      if (type === 'retweet' || type === 'tweet_retweet' || type === 'repost') mappedType = 'repost';
      if (type === 'tweet_view' || type === 'media_view') mappedType = 'view';
      if (type === 'tweet_like' || type === 'like') mappedType = 'like';

      this.engine.addInteraction(userId, videoId, mappedType, Date.now(), meta);
    } catch (e) {
      logger.error('❌ [VideoReco] Interaction error:', e.message);
    }
  }

  /**
   * Real-time update: Withdrawal of interaction (unlike / unretweet).
   */
  offInteraction(userId, videoId, type) {
    if (!this._initialized) return;
    try {
      let mappedType = type;
      if (type === 'reply' || type === 'tweet_reply' || type === 'comment') mappedType = 'comment';
      if (type === 'retweet' || type === 'tweet_retweet' || type === 'repost') mappedType = 'repost';
      if (type === 'tweet_like' || type === 'like') mappedType = 'like';

      this.engine.removeInteraction(userId, videoId, mappedType);
    } catch (e) {
      logger.error('❌ [VideoReco] offInteraction error:', e.message);
    }
  }

  /**
   * Real-time update: Watch duration.
   */
  async onWatchTime(userId, videoId, durationMs) {
    if (!this._initialized || !videoId) return;
    
    // Validation du temps de visionnage
    const ms = parseFloat(durationMs);
    if (isNaN(ms) || ms <= 0) return;

    try {
      // 1. Update In-Memory Engine
      this.engine.addInteraction(userId, videoId, 'watch_time', Date.now(), { durationMs: ms });

      // 2. Persist to Database (Asynchronous for performance)
      if (this.Tweet && this.Tweet.sequelize) {
        const timeInSeconds = ms / 1000;
        
        // Use raw query for atomic increment in JSONB metadata
        // On s'assure que les types sont corrects pour Postgres
        await this.Tweet.sequelize.query(`
          UPDATE tweets 
          SET metadata = COALESCE(metadata, '{}'::jsonb) || 
            jsonb_build_object('total_watch_time', 
              (COALESCE(metadata->>'total_watch_time', '0'))::float + :seconds::float
            )
          WHERE id = :id
        `, {
          replacements: { id: videoId, seconds: timeInSeconds },
          type: this.Tweet.sequelize.QueryTypes ? this.Tweet.sequelize.QueryTypes.UPDATE : 'UPDATE'
        });
      }
    } catch (e) {
      logger.error(`❌ [VideoReco] Failed to persist watch time for ${videoId}:`, e);
      // Fallback simple si la requête complexe échoue (problème de version PG ou JSONB)
      try {
        if (this.Tweet) {
          const tweet = await this.Tweet.findByPk(videoId);
          if (tweet) {
            const currentMetadata = tweet.metadata || {};
            const currentTotal = parseFloat(currentMetadata.total_watch_time) || 0;
            await tweet.update({
              metadata: {
                ...currentMetadata,
                total_watch_time: currentTotal + (ms / 1000)
              }
            });
          }
        }
      } catch (fallbackError) {
        logger.error(`❌ [VideoReco] Fallback persistence failed for ${videoId}:`, fallbackError.message);
      }
    }
  }

  /**
   * Real-time update: User follows.
   */
  onFollow(followerId, followingId, isFollow = true) {
    if (!this._initialized) return;
    try {
      this.engine.setFollow(followerId, followingId, isFollow);
    } catch (e) {
      logger.error(`❌ [VideoReco] Failed to set follow ${followerId}->${followingId}:`, e.message);
    }
  }

  /**
   * Real-time update: New video added.
   */
  onNewVideo(videoId, meta) {
    if (!this._initialized) {
      logger.warn(`⚠️ [VideoReco] onNewVideo called but engine NOT initialized yet (${videoId})`);
      return;
    }
    try {
      this.engine.addVideo(videoId, {
        authorId: meta.user_id,
        title: meta.content,
        tags: Array.isArray(meta.hashtags) ? meta.hashtags.join(' ') : (meta.hashtags || ""),
        createdAt: Date.now()
      });
      logger.info(`🎬 [VideoReco] New video added to engine: ${videoId}`);
    } catch (e) {
      logger.error(`❌ [VideoReco] Failed to add new video ${videoId}:`, e.message);
    }
  }

  /**
   * Real-time update: New user added.
   */
  onNewUser(userId) {
    if (!this._initialized) return;
    try {
      this.engine.addUser(userId);
    } catch (e) {
      logger.error(`❌ [VideoReco] Failed to add new user ${userId}:`, e.message);
    }
  }
}

// Singleton instance
module.exports = new VideoRecommendationService();
