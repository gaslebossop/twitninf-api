const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { Tweet, User, TweetLike, TweetRetweet, UserBehaviorData, sequelize } = require('../models');
const { Op } = require('sequelize');
const { resolveTimeZone, hourInZoneSql } = require('../utils/timezone');

const formatDateKey = (input) => {
  if (!input) return '';
  if (typeof input === 'string') return input.slice(0, 10);
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
};

/**
 * GET /api/user-stats/test
 * Route de test pour vérifier que les routes fonctionnent
 */
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Routes user-stats fonctionnent correctement',
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /api/user-stats/:userId/overview
 * Récupère les statistiques générales d'un utilisateur
 */
router.get('/:userId/overview', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { timeframe = '30d' } = req.query;
    
    // Vérifier que l'utilisateur demande ses propres stats ou est admin
    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé aux statistiques de cet utilisateur'
      });
    }

    // Calculer la date de début selon le timeframe
    const now = new Date();
    let startDate = new Date();
    
    switch (timeframe) {
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(now.getDate() - 90);
        break;
      case '1y':
        startDate.setFullYear(now.getFullYear() - 1);
        break;
      default:
        startDate.setDate(now.getDate() - 30);
    }

    // Récupérer l'utilisateur
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Statistiques des tweets avec vraies données
    const [tweetsStats] = await sequelize.query(`
      SELECT 
        COUNT(*) as total_tweets,
        COALESCE(SUM(view_count), 0) as total_views,
        COALESCE(AVG(view_count), 0) as avg_views_per_tweet
      FROM tweets 
      WHERE user_id::text = :userId
        AND created_at >= :startDate 
        AND deleted_at IS NULL
    `, {
      replacements: { userId, startDate },
      type: sequelize.QueryTypes.SELECT
    });

    // Statistiques d'engagement avec vraies données
    const [engagementStats] = await sequelize.query(`
      SELECT 
        COALESCE(SUM(likes_count), 0) as total_likes,
        COALESCE(SUM(retweets_count), 0) as total_retweets,
        COALESCE(SUM(comments_count), 0) as total_comments,
        COALESCE(SUM(shares_count), 0) as total_shares
      FROM (
        SELECT 
          t.id,
          (SELECT COUNT(*) FROM tweet_likes WHERE tweet_id = t.id) as likes_count,
          (SELECT COUNT(*) FROM tweet_retweets WHERE tweet_id = t.id) as retweets_count,
          (SELECT COUNT(*) FROM tweets WHERE parent_tweet_id = t.id) as comments_count,
          (SELECT COUNT(*) FROM user_behavior_data WHERE target_id::text = t.id::text AND target_type = 'tweet' AND action_type = 'tweet_share') as shares_count
        FROM tweets t
        WHERE t.user_id::text = :userId
          AND t.created_at >= :startDate 
          AND t.deleted_at IS NULL
      ) as tweet_engagement
    `, {
      replacements: { userId, startDate },
      type: sequelize.QueryTypes.SELECT
    });

    // Statistiques des abonnés (vraies données)
    const [followerStats] = await sequelize.query(`
      SELECT 
        COUNT(CASE WHEN uf.following_id = :userId AND uf.status = 'active' THEN 1 END) as follower_count,
        COUNT(CASE WHEN uf.follower_id = :userId AND uf.status = 'active' THEN 1 END) as following_count
      FROM user_follows uf
      WHERE (uf.following_id::text = :userId OR uf.follower_id::text = :userId)
    `, {
      replacements: { userId },
      type: sequelize.QueryTypes.SELECT
    });

    const followerCount = parseInt(followerStats.follower_count) || 0;
    const followingCount = parseInt(followerStats.following_count) || 0;

    // Vues de profil depuis UserBehaviorData
    const profileViews = await UserBehaviorData.count({
      where: {
        target_id: userId,
        target_type: 'user',
        action_type: 'profile_view',
        created_at: {
          [Op.gte]: startDate
        }
      }
    });

    // Calculer le taux d'engagement
    const totalTweets = parseInt(tweetsStats.total_tweets) || 0;
    const totalLikes = parseInt(engagementStats.total_likes) || 0;
    const totalRetweets = parseInt(engagementStats.total_retweets) || 0;
    const totalComments = parseInt(engagementStats.total_comments) || 0;
    const totalViews = parseInt(tweetsStats.total_views) || 0;
    
    const totalEngagement = totalLikes + totalRetweets + totalComments;
    const engagementRate = totalViews > 0 ? ((totalEngagement / totalViews) * 100) : 0;

    const analytics = {
      totalTweets,
      totalViews,
      totalLikes,
      totalRetweets,
      totalComments,
      totalShares: parseInt(engagementStats.total_shares) || 0,
      followerCount,
      followingCount,
      profileViews,
      engagementRate: parseFloat(engagementRate.toFixed(2)),
      averageViewsPerTweet: parseFloat(tweetsStats.avg_views_per_tweet) || 0,
      reachGrowth: 0, // À calculer avec des données historiques
      engagementGrowth: 0, // À calculer avec des données historiques
    };

    res.json({
      success: true,
      data: {
        userId,
        timeframe,
        analytics,
        generated_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur récupération stats utilisateur:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques',
      error: error.message
    });
  }
});

/**
 * GET /api/user-stats/:userId/daily
 * Récupère les statistiques quotidiennes d'un utilisateur
 */
router.get('/:userId/daily', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { timeframe = '30d' } = req.query;
    
    // Vérifier l'autorisation
    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé'
      });
    }

    // Calculer les dates
    const now = new Date();
    let days = 30;
    
    switch (timeframe) {
      case '7d': days = 7; break;
      case '30d': days = 30; break;
      case '90d': days = 90; break;
      case '1y': days = 365; break;
    }

    const startDate = new Date();
    startDate.setDate(now.getDate() - days);

    // Générer les dates manuellement
    const dates = [];
    const currentDate = new Date(startDate);
    while (currentDate <= now) {
      dates.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Requêtes séparées pour chaque type de données
    const tweetCounts = await sequelize.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as tweets
      FROM tweets 
      WHERE user_id::text = :userId
        AND created_at >= :startDate 
        AND created_at <= :endDate
        AND deleted_at IS NULL
      GROUP BY DATE(created_at)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0]
      },
      type: sequelize.QueryTypes.SELECT
    });

    const viewCounts = await sequelize.query(`
      SELECT 
        DATE(created_at) as date,
        SUM(view_count) as views
      FROM tweets 
      WHERE user_id::text = :userId
        AND created_at >= :startDate 
        AND created_at <= :endDate
        AND deleted_at IS NULL
      GROUP BY DATE(created_at)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0]
      },
      type: sequelize.QueryTypes.SELECT
    });

    // Récupérer les interactions par date (sans restriction sur la date de création du tweet)
    const likesCounts = await sequelize.query(`
      SELECT 
        DATE(tl.created_at) as date,
        COUNT(*) as likes
      FROM tweet_likes tl
      JOIN tweets t ON tl.tweet_id = t.id
      WHERE t.user_id::text = :userId
        AND tl.created_at >= :startDate 
        AND tl.created_at <= :endDate
        AND t.deleted_at IS NULL
      GROUP BY DATE(tl.created_at)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0]
      },
      type: sequelize.QueryTypes.SELECT
    });

    const retweetsCounts = await sequelize.query(`
      SELECT 
        DATE(tr.created_at) as date,
        COUNT(*) as retweets
      FROM tweet_retweets tr
      JOIN tweets t ON tr.tweet_id = t.id
      WHERE t.user_id::text = :userId
        AND tr.created_at >= :startDate 
        AND tr.created_at <= :endDate
        AND t.deleted_at IS NULL
      GROUP BY DATE(tr.created_at)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0]
      },
      type: sequelize.QueryTypes.SELECT
    });

    const commentsCounts = await sequelize.query(`
      SELECT 
        DATE(reply.created_at) as date,
        COUNT(*) as comments
      FROM tweets reply
      JOIN tweets t ON reply.parent_tweet_id = t.id
      WHERE t.user_id::text = :userId
        AND reply.created_at >= :startDate 
        AND reply.created_at <= :endDate
        AND t.deleted_at IS NULL
      GROUP BY DATE(reply.created_at)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0]
      },
      type: sequelize.QueryTypes.SELECT
    });

    const behaviorCounts = await sequelize.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as profile_views
      FROM user_behavior_data 
      WHERE target_id::text = :userId
        AND target_type = 'user'
        AND action_type = 'profile_view'
        AND created_at >= :startDate 
        AND created_at <= :endDate
      GROUP BY DATE(created_at)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0]
      },
      type: sequelize.QueryTypes.SELECT
    });

    const followersGainedCounts = await sequelize.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as followers_gained
      FROM user_follows
      WHERE following_id::text = :userId
        AND status = 'active'
        AND created_at >= :startDate
        AND created_at <= :endDate
      GROUP BY DATE(created_at)
    `, {
      replacements: {
        userId,
        startDate: startDate.toISOString().split('T')[0],
        endDate: now.toISOString().split('T')[0]
      },
      type: sequelize.QueryTypes.SELECT
    });

    // Combiner les données
    const dailyStats = dates.map(date => {
      const dateStr = date.toISOString().split('T')[0];
      
      const tweetData = tweetCounts.find(t => formatDateKey(t.date) === dateStr);
      const viewData = viewCounts.find(v => formatDateKey(v.date) === dateStr);
      const likesData = likesCounts.find(l => formatDateKey(l.date) === dateStr);
      const retweetsData = retweetsCounts.find(r => formatDateKey(r.date) === dateStr);
      const commentsData = commentsCounts.find(c => formatDateKey(c.date) === dateStr);
      const behaviorData = behaviorCounts.find(b => formatDateKey(b.date) === dateStr);
      const followersData = followersGainedCounts.find(f => formatDateKey(f.date) === dateStr);
      
      return {
        date: dateStr,
        tweets: tweetData ? parseInt(tweetData.tweets) : 0,
        views: viewData ? parseInt(viewData.views) : 0,
        likes: likesData ? parseInt(likesData.likes) : 0,
        retweets: retweetsData ? parseInt(retweetsData.retweets) : 0,
        comments: commentsData ? parseInt(commentsData.comments) : 0,
        shares: 0, // À implémenter si nécessaire
        profile_views: behaviorData ? parseInt(behaviorData.profile_views) : 0,
        followers_gained: followersData ? parseInt(followersData.followers_gained) : 0
      };
    });

    res.json({
      success: true,
      data: {
        userId,
        timeframe,
        dailyStats,
        generated_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur récupération stats quotidiennes:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques quotidiennes',
      error: error.message
    });
  }
});

/**
 * GET /api/user-stats/:userId/top-tweets
 * Récupère les tweets les plus performants d'un utilisateur
 */
router.get('/:userId/top-tweets', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20, timeframe = '30d' } = req.query;
    
    // Vérifier l'autorisation
    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé'
      });
    }

    // Calculer la date de début
    const now = new Date();
    let startDate = new Date();
    
    switch (timeframe) {
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(now.getDate() - 90);
        break;
      case '1y':
        startDate.setFullYear(now.getFullYear() - 1);
        break;
    }

    // Requête pour obtenir les tweets les plus performants
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    const topTweets = await sequelize.query(`
      SELECT 
        t.id,
        t.content,
        t.view_count as views,
        t.created_at,
        COUNT(DISTINCT tl.id) as likes,
        COUNT(DISTINCT tr.id) as retweets,
        COUNT(DISTINCT reply.id) as comments,
        (COUNT(DISTINCT tl.id) + COUNT(DISTINCT tr.id) + COUNT(DISTINCT reply.id)) as total_engagement,
        CASE 
          WHEN t.view_count > 0 
          THEN ((COUNT(DISTINCT tl.id) + COUNT(DISTINCT tr.id) + COUNT(DISTINCT reply.id)) * 100.0 / t.view_count)
          ELSE 0 
        END as engagement_rate,
        (
          COALESCE(t.view_count, 0) +
          COUNT(DISTINCT tl.id) +
          COUNT(DISTINCT tr.id) +
          COUNT(DISTINCT reply.id)
        ) as performance_score
      FROM tweets t
      LEFT JOIN tweet_likes tl ON t.id = tl.tweet_id
      LEFT JOIN tweet_retweets tr ON t.id = tr.tweet_id
      LEFT JOIN tweets reply ON t.id = reply.parent_tweet_id
      WHERE t.user_id::text = :userId
        AND t.created_at >= :startDate 
        AND t.parent_tweet_id IS NULL
        AND t.deleted_at IS NULL
      GROUP BY t.id, t.content, t.view_count, t.created_at
      ORDER BY performance_score DESC, views DESC, likes DESC, retweets DESC, comments DESC, t.created_at DESC
      LIMIT :limit
    `, {
      replacements: { userId, startDate, limit: parsedLimit },
      type: sequelize.QueryTypes.SELECT
    });

    // Formater les résultats
    const formattedTweets = topTweets.map(tweet => ({
      id: tweet.id,
      content: tweet.content,
      views: parseInt(tweet.views) || 0,
      likes: parseInt(tweet.likes) || 0,
      retweets: parseInt(tweet.retweets) || 0,
      comments: parseInt(tweet.comments) || 0,
      shares: Math.floor(parseInt(tweet.total_engagement) * 0.1), // Estimation
      engagement_rate: parseFloat(tweet.engagement_rate) || 0,
      created_at: tweet.created_at,
      performance_score: parseFloat(tweet.performance_score) || 0
    }));

    res.json({
      success: true,
      data: {
        userId,
        timeframe,
        topTweets: formattedTweets,
        generated_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur récupération top tweets:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des tweets performants',
      error: error.message
    });
  }
});

/**
 * GET /api/user-stats/:userId/activity
 * Récupère les données d'activité par heure d'un utilisateur
 */
router.get('/:userId/activity', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { timeframe = '30d' } = req.query;
    
    // Vérifier l'autorisation
    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé'
      });
    }

    // Calculer la date de début
    const now = new Date();
    let startDate = new Date();
    
    switch (timeframe) {
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(now.getDate() - 90);
        break;
      case '1y':
        startDate.setFullYear(now.getFullYear() - 1);
        break;
    }

    // Créer un tableau des heures 0-23
    const hours = Array.from({ length: 24 }, (_, i) => i);
    
    // Heures de l'horloge du lecteur : la base est en UTC, une courbe
    // d'activité décalée de deux heures désigne les mauvais moments.
    const timeZone = resolveTimeZone(req);

    // Requête pour obtenir l'activité par heure (sans generate_series)
    const tweetActivity = await sequelize.query(`
      SELECT
        ${hourInZoneSql('created_at')} as hour,
        COUNT(*) as tweet_count
      FROM tweets
      WHERE user_id::text = :userId
        AND created_at >= :startDate
        AND deleted_at IS NULL
      GROUP BY 1
    `, {
      replacements: { userId, startDate, timeZone },
      type: sequelize.QueryTypes.SELECT
    });

    const engagementActivity = await sequelize.query(`
      SELECT
        ${hourInZoneSql('ubd.created_at')} as hour,
        COUNT(*) as engagement_count
      FROM user_behavior_data ubd
      WHERE ubd.user_id::text = :userId
        AND ubd.created_at >= :startDate
        AND ubd.action_type IN ('tweet_like', 'tweet_retweet', 'tweet_reply')
      GROUP BY 1
    `, {
      replacements: { userId, startDate, timeZone },
      type: sequelize.QueryTypes.SELECT
    });

    // Combiner les données
    const activityData = hours.map(hour => {
      const tweetData = tweetActivity.find(t => parseInt(t.hour) === hour);
      const engagementData = engagementActivity.find(e => parseInt(e.hour) === hour);
      
      const tweetCount = tweetData ? parseInt(tweetData.tweet_count) : 0;
      const engagementCount = engagementData ? parseInt(engagementData.engagement_count) : 0;
      
      return {
        hour,
        tweet_count: tweetCount,
        engagement_count: engagementCount,
        activity_score: tweetCount + engagementCount
      };
    });

    // Identifier les heures les plus actives
    const sortedActivity = [...activityData].sort((a, b) => b.activity_score - a.activity_score);
    const mostActiveHours = sortedActivity.slice(0, 5).map(item => parseInt(item.hour));

    res.json({
      success: true,
      data: {
        userId,
        timeframe,
        activityData: activityData.map(item => ({
          hour: parseInt(item.hour),
          tweet_count: parseInt(item.tweet_count),
          engagement_count: parseInt(item.engagement_count),
          activity_score: parseInt(item.activity_score)
        })),
        mostActiveHours,
        generated_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur récupération activité utilisateur:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des données d\'activité',
      error: error.message
    });
  }
});

/**
 * GET /api/user-stats/:userId/best-time
 * Meilleurs créneaux de publication — avantage abonné (Plus / Pro).
 *
 * À ne pas confondre avec `/activity`, qui mesure quand l'utilisateur EST
 * actif (ses propres tweets, ses propres likes). Ici on mesure l'inverse :
 * quand SON AUDIENCE réagit à ce qu'il publie. Publier à l'heure où l'on est
 * soi-même sur l'app n'a aucune raison d'être l'heure où les autres y sont.
 *
 * La note d'un créneau est l'engagement MOYEN PAR TWEET publié dans ce
 * créneau, pas l'engagement total : sans cette normalisation, l'heure
 * recommandée serait simplement celle où l'utilisateur poste le plus souvent,
 * ce qui ne lui apprend rien.
 */
router.get('/:userId/best-time', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { timeframe = '90d' } = req.query;

    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès non autorisé' });
    }

    const days = timeframe === '30d' ? 30 : timeframe === '1y' ? 365 : 90;
    const startDate = new Date(Date.now() - days * 86400000);

    /**
     * Les trois jointures peuvent multiplier les lignes entre elles (un tweet
     * à 10 likes et 3 retweets en produit 30) : chaque compteur est donc un
     * COUNT(DISTINCT) sur la clé de sa propre table, jamais un COUNT(*).
     * Seuls les tweets ORIGINAUX comptent — recommander une heure sur la base
     * de réponses noierait le signal.
     */
    // L'heure est celle de l'HORLOGE DU CRÉATEUR : la base est en UTC, et
    // « publie à 19 h » n'a aucun sens si ce 19 h n'est pas le sien.
    const timeZone = resolveTimeZone(req);

    const rows = await sequelize.query(`
      SELECT
        ${hourInZoneSql('t.created_at')} AS hour,
        COUNT(DISTINCT t.id) AS tweets,
        COUNT(DISTINCT l.id) AS likes,
        COUNT(DISTINCT rt.id) AS retweets,
        COUNT(DISTINCT rp.id) AS replies
      FROM tweets t
      LEFT JOIN tweet_likes l ON l.tweet_id = t.id
      LEFT JOIN tweet_retweets rt ON rt.tweet_id = t.id
      LEFT JOIN tweets rp ON rp.parent_tweet_id = t.id AND rp.deleted_at IS NULL
      WHERE t.user_id::text = :userId
        AND t.created_at >= :startDate
        AND t.deleted_at IS NULL
        AND t.parent_tweet_id IS NULL
      GROUP BY 1
      ORDER BY 1
    `, {
      replacements: { userId, startDate, timeZone },
      type: sequelize.QueryTypes.SELECT
    });

    /** En dessous, un seul tweet chanceux suffirait à élire une heure. */
    const MIN_TWEETS_PER_SLOT = 3;

    const hourly = Array.from({ length: 24 }, (_, hour) => {
      const row = rows.find((r) => parseInt(r.hour, 10) === hour);
      const tweets = row ? parseInt(row.tweets, 10) : 0;
      const engagement = row
        ? parseInt(row.likes, 10) + parseInt(row.retweets, 10) + parseInt(row.replies, 10)
        : 0;
      return {
        hour,
        tweets,
        engagement,
        avg_engagement: tweets > 0 ? Math.round((engagement / tweets) * 100) / 100 : 0,
        // Un créneau sous-échantillonné est renvoyé quand même (l'app affiche
        // l'histogramme complet) mais reste inéligible à la recommandation.
        reliable: tweets >= MIN_TWEETS_PER_SLOT
      };
    });

    const eligible = hourly.filter((h) => h.reliable && h.avg_engagement > 0);
    const bestHours = [...eligible]
      .sort((a, b) => b.avg_engagement - a.avg_engagement)
      .slice(0, 3)
      .map((h) => h.hour);

    const totalTweets = hourly.reduce((sum, h) => sum + h.tweets, 0);

    res.json({
      success: true,
      data: {
        userId,
        timeframe,
        hourly,
        bestHours,
        /**
         * Sans assez d'historique, aucune heure n'est défendable. L'app doit
         * alors se taire plutôt que d'inventer une recommandation — un mauvais
         * conseil sur un avantage payant coûte plus cher que pas de conseil.
         */
        hasEnoughData: eligible.length > 0,
        sampleTweets: totalTweets,
        generated_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Erreur calcul meilleur créneau:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du calcul des meilleurs créneaux',
      error: error.message
    });
  }
});

/**
 * GET /api/user-stats/:userId/engagement-breakdown
 * Récupère la répartition de l'engagement d'un utilisateur
 */
router.get('/:userId/engagement-breakdown', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { timeframe = '30d' } = req.query;
    
    // Vérifier l'autorisation
    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé'
      });
    }

    // Calculer la date de début
    const now = new Date();
    let startDate = new Date();
    
    switch (timeframe) {
      case '7d':
        startDate.setDate(now.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(now.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(now.getDate() - 90);
        break;
      case '1y':
        startDate.setFullYear(now.getFullYear() - 1);
        break;
    }

    // Requête pour obtenir la répartition de l'engagement
    const [engagementBreakdown] = await sequelize.query(`
      SELECT 
        COALESCE(SUM(likes_count), 0) as likes,
        COALESCE(SUM(retweets_count), 0) as retweets,
        COALESCE(SUM(comments_count), 0) as comments,
        COALESCE(SUM(shares_count), 0) as shares,
        (COALESCE(SUM(likes_count), 0) + COALESCE(SUM(retweets_count), 0) + 
         COALESCE(SUM(comments_count), 0) + COALESCE(SUM(shares_count), 0)) as total
      FROM (
        SELECT 
          t.id,
          COUNT(DISTINCT tl.id) as likes_count,
          COUNT(DISTINCT tr.id) as retweets_count,
          COUNT(DISTINCT reply.id) as comments_count,
          FLOOR(COUNT(DISTINCT tl.id) * 0.1) as shares_count
        FROM tweets t
        LEFT JOIN tweet_likes tl ON t.id = tl.tweet_id
        LEFT JOIN tweet_retweets tr ON t.id = tr.tweet_id
        LEFT JOIN tweets reply ON t.id = reply.parent_tweet_id
        WHERE t.user_id::text = :userId
          AND t.created_at >= :startDate 
          AND t.deleted_at IS NULL
        GROUP BY t.id
      ) as tweet_engagement
    `, {
      replacements: { userId, startDate },
      type: sequelize.QueryTypes.SELECT
    });

    const breakdown = {
      likes: parseInt(engagementBreakdown.likes) || 0,
      retweets: parseInt(engagementBreakdown.retweets) || 0,
      comments: parseInt(engagementBreakdown.comments) || 0,
      shares: parseInt(engagementBreakdown.shares) || 0,
      total: parseInt(engagementBreakdown.total) || 0
    };

    res.json({
      success: true,
      data: {
        userId,
        timeframe,
        engagementBreakdown: breakdown,
        generated_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Erreur récupération répartition engagement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la répartition de l\'engagement',
      error: error.message
    });
  }
});

module.exports = router;
