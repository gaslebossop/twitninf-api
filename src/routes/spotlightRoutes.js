const express = require('express');
const router = express.Router();

const { Tweet, TweetLike, TweetRetweet, User, DailySpotlight } = require('../models');
const { Op } = require('sequelize');
const { authenticateToken } = require('../middleware/authMiddleware');
const { engagementTargetId } = require('../utils/engagementTarget');
const { zonedDayKey, instantForZonedHour } = require('../utils/timezone');
const { SPOTLIGHT_TIME_ZONE } = require('../services/spotlightService');
const logger = require('../utils/logger');

const AUTHOR_ATTRIBUTES = ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization'];

/**
 * GET /api/spotlight/today
 * Le tweet le plus liké d'hier (calculé une fois par nuit, voir
 * spotlightService). Renvoie `data: null` s'il n'y a aucun gagnant — c'est le
 * contrat normal, pas une erreur : le bandeau reste alors masqué côté client.
 *
 * `daily_spotlights.spotlight_date` porte la date du jour RÉSUMÉ (hier), pas
 * celle du jour d'affichage — même convention que `computeYesterdaySpotlight`.
 * La ligne à lire aujourd'hui est donc celle d'hier, pas celle d'aujourd'hui.
 */
router.get('/today', authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    const yesterdayStart = instantForZonedHour(now, 0, SPOTLIGHT_TIME_ZONE, -1);
    const spotlightDate = zonedDayKey(yesterdayStart, SPOTLIGHT_TIME_ZONE);
    const spotlight = await DailySpotlight.getForDate(spotlightDate);

    if (!spotlight || spotlight.status !== 'computed' || !spotlight.tweet_id) {
      return res.json({ success: true, data: null });
    }

    const tweet = await Tweet.findOne({
      where: {
        id: spotlight.tweet_id,
        is_private: false,
        moderation_status: { [Op.notIn]: ['not_eligible', 'rejected'] }
      },
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRIBUTES },
        {
          model: Tweet,
          as: 'originalTweet',
          include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRIBUTES }]
        }
      ]
    });

    // Le gagnant d'hier a pu être supprimé/modéré depuis le calcul du cron :
    // on préfère masquer le bandeau plutôt que de servir un post périmé.
    if (!tweet) {
      return res.json({ success: true, data: null });
    }

    const userId = req.user.id;
    const tweetData = tweet.toJSON();
    const statsId = engagementTargetId(tweetData);
    const isOwnStats = statsId === String(tweet.id);

    const [likeCount, retweetCount, replyCount, isLiked, isRetweeted] = await Promise.all([
      TweetLike.countTweetLikes(statsId),
      TweetRetweet.countTweetRetweets(statsId),
      Tweet.count({ where: { parent_tweet_id: statsId, is_data_test: false } }),
      TweetLike.hasUserLikedTweet(userId, statsId),
      TweetRetweet.hasUserRetweetedTweet(userId, statsId)
    ]);

    const enrichedTweet = {
      ...tweetData,
      stats: {
        likes: likeCount,
        retweets: retweetCount,
        replies: replyCount,
        views: (isOwnStats ? tweet.view_count : tweetData.originalTweet?.view_count) || 0
      },
      user_interaction: {
        is_liked: isLiked,
        is_retweeted: isRetweeted
      }
    };

    return res.json({
      success: true,
      data: {
        tweet: enrichedTweet,
        like_count: spotlight.like_count,
        spotlight_date: spotlight.spotlight_date
      }
    });
  } catch (error) {
    logger.error('[Spotlight] Erreur GET /today:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

module.exports = router;
