const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const { Tweet, User, TweetLike, TweetRetweet, UserBehaviorData, sequelize } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { resolveTimeZone, hourInZoneSql } = require('../utils/timezone');

const formatDateKey = (input) => {
  if (!input) return '';
  if (typeof input === 'string') return input.slice(0, 10);
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
};

const timeframeStart = (timeframe = '30d') => {
  const days = timeframe === '7d' ? 7 : timeframe === '90d' ? 90 : timeframe === '1y' ? 365 : 30;
  return new Date(Date.now() - days * 86400000);
};

const int = (value) => parseInt(value, 10) || 0;
const decimal = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

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
      WHERE user_id = :userId::uuid
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
        WHERE t.user_id = :userId::uuid
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
      WHERE (uf.following_id = :userId::uuid OR uf.follower_id = :userId::uuid)
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
    logger.error('❌ Erreur récupération stats utilisateur:', error);
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

    // Toutes les requêtes qui suivent bornaient `endDate` avec
    // `now.toISOString().split('T')[0]` — une date SANS heure, donc comparée
    // par Postgres à minuit UTC de ce jour. `timestamp <= '2026-08-18'`
    // exclut ainsi TOUTE l'activité d'aujourd'hui, du début de journée
    // jusqu'à l'instant présent : le jour le plus récent de n'importe quelle
    // fenêtre retombait systématiquement à 0, quelle que soit l'activité
    // réelle. `endDateIso` porte l'heure exacte pour que « aujourd'hui »
    // compte ce qui s'y est réellement passé.
    const endDateIso = now.toISOString();

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
      WHERE user_id = :userId::uuid
        AND created_at >= :startDate 
        AND created_at <= :endDate
        AND deleted_at IS NULL
      GROUP BY DATE(created_at)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDateIso
      },
      type: sequelize.QueryTypes.SELECT
    });

    // Groupé par le jour où la vue a EU LIEU (`user_behavior_data.timestamp`),
    // pas par le jour où le tweet a été PUBLIÉ (`tweets.created_at`).
    //
    // La requête groupait auparavant `SUM(tweets.view_count)` par date de
    // création du tweet : un tweet publié le 15 mais toujours vu aujourd'hui
    // voyait TOUTES ses vues (passées et à venir) créditées au 15, jamais aux
    // jours suivants. Résultat pour quelqu'un qui n'a rien publié depuis
    // 3 jours : la courbe des 3 derniers jours affiche 0, alors que ses
    // anciens tweets continuent d'accumuler de vraies vues chaque jour — elles
    // sont juste comptées ailleurs, sur la date de publication.
    //
    // `user_behavior_data` journalise chaque vue avec l'instant où elle s'est
    // produite (voir `behaviorRoutes.js` → `recordTweetInteraction`) : c'est
    // la seule source qui permette de répartir les vues sur le bon jour.
    const viewCounts = await sequelize.query(`
      SELECT
        DATE(ubd.timestamp) as date,
        -- Sans COALESCE, un jour sans aucune vue renvoie NULL ici :
        -- parseInt(null) donne NaN, sérialisé en null dans le JSON. Le client
        -- lisait ce null comme une COUPURE de série et scindait la courbe en
        -- morceaux (bord vertical franc au milieu du graphique). Un jour sans
        -- vue vaut 0, pas un trou.
        COALESCE(COUNT(*), 0) as views
      FROM user_behavior_data ubd
      -- AUDIT R2-01 (2026-08-19) : ancien code castait t.id::text, ce qui
      -- rendait l'index UUID de tweets.id inutilisable pour cette jointure.
      -- target_id est un STRING polymorphe (peut contenir un hashtag, une
      -- URL de lien, etc. selon target_type) : le caster en ::uuid sans
      -- garde ferait échouer la requête dès qu'une ligne non-'tweet' est
      -- évaluée. Le CASE protège le cast (Postgres garantit qu'une branche
      -- non retenue n'est jamais évaluée), et laisse t.id sans cast pour
      -- que l'index reste utilisable.
      JOIN tweets t ON t.id = CASE WHEN ubd.target_type = 'tweet' THEN ubd.target_id::uuid END
      WHERE t.user_id = :userId::uuid
        AND ubd.action_type IN ('tweet_view', 'media_view')
        AND ubd.timestamp >= :startDate 
        AND ubd.timestamp <= :endDate
        AND t.deleted_at IS NULL
      GROUP BY DATE(ubd.timestamp)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDateIso
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
      WHERE t.user_id = :userId::uuid
        AND tl.created_at >= :startDate 
        AND tl.created_at <= :endDate
        AND t.deleted_at IS NULL
      GROUP BY DATE(tl.created_at)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDateIso
      },
      type: sequelize.QueryTypes.SELECT
    });

    const retweetsCounts = await sequelize.query(`
      SELECT 
        DATE(tr.created_at) as date,
        COUNT(*) as retweets
      FROM tweet_retweets tr
      JOIN tweets t ON tr.tweet_id = t.id
      WHERE t.user_id = :userId::uuid
        AND tr.created_at >= :startDate 
        AND tr.created_at <= :endDate
        AND t.deleted_at IS NULL
      GROUP BY DATE(tr.created_at)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDateIso
      },
      type: sequelize.QueryTypes.SELECT
    });

    const commentsCounts = await sequelize.query(`
      SELECT 
        DATE(reply.created_at) as date,
        COUNT(*) as comments
      FROM tweets reply
      JOIN tweets t ON reply.parent_tweet_id = t.id
      WHERE t.user_id = :userId::uuid
        AND reply.created_at >= :startDate 
        AND reply.created_at <= :endDate
        AND t.deleted_at IS NULL
      GROUP BY DATE(reply.created_at)
    `, {
      replacements: { 
        userId, 
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDateIso
      },
      type: sequelize.QueryTypes.SELECT
    });

    const sharesCounts = await sequelize.query(`
      SELECT
        DATE(ubd.created_at) as date,
        COUNT(*) as shares
      FROM user_behavior_data ubd
      -- AUDIT R2-01 (2026-08-19) : voir la note plus haut sur le même motif
      -- (target_id polymorphe, cast protégé par CASE).
      JOIN tweets t ON t.id = CASE WHEN ubd.target_type = 'tweet' THEN ubd.target_id::uuid END
      WHERE t.user_id = :userId::uuid
        AND ubd.target_type = 'tweet'
        AND ubd.action_type = 'tweet_share'
        AND ubd.created_at >= :startDate
        AND ubd.created_at <= :endDate
        AND t.deleted_at IS NULL
      GROUP BY DATE(ubd.created_at)
    `, {
      replacements: {
        userId,
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDateIso
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
        endDate: endDateIso
      },
      type: sequelize.QueryTypes.SELECT
    });

    const followersGainedCounts = await sequelize.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as followers_gained
      FROM user_follows
      WHERE following_id = :userId::uuid
        AND status = 'active'
        AND created_at >= :startDate
        AND created_at <= :endDate
      GROUP BY DATE(created_at)
    `, {
      replacements: {
        userId,
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDateIso
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
      const sharesData = sharesCounts.find(s => formatDateKey(s.date) === dateStr);
      const behaviorData = behaviorCounts.find(b => formatDateKey(b.date) === dateStr);
      const followersData = followersGainedCounts.find(f => formatDateKey(f.date) === dateStr);
      
      return {
        date: dateStr,
        tweets: tweetData ? parseInt(tweetData.tweets) : 0,
        views: viewData ? parseInt(viewData.views) : 0,
        likes: likesData ? parseInt(likesData.likes) : 0,
        retweets: retweetsData ? parseInt(retweetsData.retweets) : 0,
        comments: commentsData ? parseInt(commentsData.comments) : 0,
        shares: sharesData ? parseInt(sharesData.shares) : 0,
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
    logger.error('❌ Erreur récupération stats quotidiennes:', error);
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

    // AUDIT R2-07 (2026-08-19) : trois jointures « un vers plusieurs » sur la
    // même table de gauche se multipliaient entre elles avant l'agrégation
    // (un tweet à 100 likes/20 retweets/50 réponses produisait 100 000
    // lignes intermédiaires, à trier pour dédupliquer via COUNT(DISTINCT)) —
    // probablement la requête la plus chère de toute l'API. La sous-requête
    // `sh` agrégeait en plus TOUTE `user_behavior_data`, sans filtre sur
    // l'utilisateur. Chaque compteur est maintenant agrégé séparément, et
    // restreint aux seuls tweets de l'utilisateur (`user_tweets`), avant la
    // jointure — un JOIN, pas un produit.
    const topTweets = await sequelize.query(`
      WITH user_tweets AS (
        SELECT id, content, view_count, created_at
        FROM tweets
        WHERE user_id = :userId::uuid
          AND created_at >= :startDate
          AND parent_tweet_id IS NULL
          AND deleted_at IS NULL
      ),
      likes_agg AS (
        SELECT tweet_id, COUNT(*) AS likes
        FROM tweet_likes
        WHERE tweet_id IN (SELECT id FROM user_tweets)
        GROUP BY tweet_id
      ),
      retweets_agg AS (
        SELECT tweet_id, COUNT(*) AS retweets
        FROM tweet_retweets
        WHERE tweet_id IN (SELECT id FROM user_tweets)
        GROUP BY tweet_id
      ),
      replies_agg AS (
        SELECT parent_tweet_id, COUNT(*) AS comments
        FROM tweets
        WHERE parent_tweet_id IN (SELECT id FROM user_tweets)
        GROUP BY parent_tweet_id
      ),
      shares_agg AS (
        SELECT target_id::text AS tweet_id, COUNT(*) AS shares
        FROM user_behavior_data
        WHERE target_type = 'tweet' AND action_type = 'tweet_share'
          AND target_id::text IN (SELECT id::text FROM user_tweets)
        GROUP BY target_id::text
      )
      SELECT
        ut.id,
        ut.content,
        ut.view_count as views,
        ut.created_at,
        COALESCE(la.likes, 0) as likes,
        COALESCE(ra.retweets, 0) as retweets,
        COALESCE(rpa.comments, 0) as comments,
        COALESCE(sa.shares, 0) as shares,
        (COALESCE(la.likes, 0) + COALESCE(ra.retweets, 0) + COALESCE(rpa.comments, 0) + COALESCE(sa.shares, 0)) as total_engagement,
        CASE
          WHEN ut.view_count > 0
          THEN ((COALESCE(la.likes, 0) + COALESCE(ra.retweets, 0) + COALESCE(rpa.comments, 0) + COALESCE(sa.shares, 0)) * 100.0 / ut.view_count)
          ELSE 0
        END as engagement_rate,
        (
          COALESCE(ut.view_count, 0) +
          COALESCE(la.likes, 0) +
          COALESCE(ra.retweets, 0) +
          COALESCE(rpa.comments, 0) +
          COALESCE(sa.shares, 0)
        ) as performance_score
      FROM user_tweets ut
      LEFT JOIN likes_agg la ON la.tweet_id = ut.id
      LEFT JOIN retweets_agg ra ON ra.tweet_id = ut.id
      LEFT JOIN replies_agg rpa ON rpa.parent_tweet_id = ut.id
      LEFT JOIN shares_agg sa ON sa.tweet_id = ut.id::text
      ORDER BY performance_score DESC, views DESC, likes DESC, retweets DESC, comments DESC, ut.created_at DESC
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
      shares: parseInt(tweet.shares) || 0,
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
    logger.error('❌ Erreur récupération top tweets:', error);
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
      WHERE user_id = :userId::uuid
        AND created_at >= :startDate
        AND deleted_at IS NULL
      GROUP BY 1
    `, {
      replacements: { userId, startDate, timeZone },
      type: sequelize.QueryTypes.SELECT
    });

    // Activite recue par le createur. L'ancienne requete comptait ses propres
    // actions tout en les presentant dans l'onglet Audience.
    const engagementActivity = await sequelize.query(`
      WITH audience_events AS (
        SELECT tl.created_at AS occurred_at
        FROM tweet_likes tl JOIN tweets t ON t.id = tl.tweet_id
        WHERE t.user_id = :userId::uuid AND t.deleted_at IS NULL
        UNION ALL
        SELECT tr.created_at AS occurred_at
        FROM tweet_retweets tr JOIN tweets t ON t.id = tr.tweet_id
        WHERE t.user_id = :userId::uuid AND t.deleted_at IS NULL
        UNION ALL
        SELECT reply.created_at AS occurred_at
        FROM tweets reply JOIN tweets t ON t.id = reply.parent_tweet_id
        WHERE t.user_id = :userId::uuid AND t.deleted_at IS NULL AND reply.deleted_at IS NULL
        UNION ALL
        SELECT ubd.created_at AS occurred_at
        -- AUDIT R2-01 (2026-08-19) : même motif, voir la note plus haut.
        FROM user_behavior_data ubd JOIN tweets t ON t.id = CASE WHEN ubd.target_type = 'tweet' THEN ubd.target_id::uuid END
        WHERE t.user_id = :userId::uuid AND t.deleted_at IS NULL
          AND ubd.target_type = 'tweet' AND ubd.action_type = 'tweet_share'
      )
      SELECT
        ${hourInZoneSql('occurred_at')} as hour,
        COUNT(*) as engagement_count
      FROM audience_events
      WHERE occurred_at >= :startDate
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
        activity_score: engagementCount
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
    logger.error('❌ Erreur récupération activité utilisateur:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des données d\'activité',
      error: error.message
    });
  }
});

/**
 * GET /api/user-stats/:userId/deep-insights
 *
 * Signaux reels deja presents dans la base : usage, sessions, audience
 * engagee, demographics declarees et localisation consentie. Les donnees
 * d'audience sensibles sont uniquement restituees par groupes comptant au
 * moins cinq personnes, jamais sous forme de coordonnees individuelles.
 */
router.get('/:userId/deep-insights', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { timeframe = '30d' } = req.query;
    const isOwner = req.user.id === userId;
    if (req.user.id !== userId && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Acces non autorise' });
    }

    const startDate = timeframeStart(timeframe);
    const audienceEventsCte = `
      WITH audience_events AS (
        SELECT tl.user_id AS actor_id, 'like'::text AS event_type
        FROM tweet_likes tl JOIN tweets t ON t.id = tl.tweet_id
        WHERE t.user_id = :userId::uuid AND tl.created_at >= :startDate AND t.deleted_at IS NULL
        UNION ALL
        SELECT tr.user_id AS actor_id, 'retweet'::text AS event_type
        FROM tweet_retweets tr JOIN tweets t ON t.id = tr.tweet_id
        WHERE t.user_id = :userId::uuid AND tr.created_at >= :startDate AND t.deleted_at IS NULL
        UNION ALL
        SELECT reply.user_id AS actor_id, 'reply'::text AS event_type
        FROM tweets reply JOIN tweets t ON t.id = reply.parent_tweet_id
        WHERE t.user_id = :userId::uuid AND reply.created_at >= :startDate
          AND t.deleted_at IS NULL AND reply.deleted_at IS NULL
        UNION ALL
        SELECT ubd.user_id AS actor_id, 'share'::text AS event_type
        -- AUDIT R2-01 (2026-08-19) : cast protégé par CASE, voir la note du
        -- même motif plus haut dans ce fichier (target_id polymorphe).
        FROM user_behavior_data ubd JOIN tweets t ON t.id = CASE WHEN ubd.target_type = 'tweet' THEN ubd.target_id::uuid END
        WHERE t.user_id = :userId::uuid AND ubd.created_at >= :startDate
          AND ubd.target_type = 'tweet' AND ubd.action_type = 'tweet_share' AND t.deleted_at IS NULL
      ), audience_users AS (
        SELECT actor_id, COUNT(*) AS event_count
        FROM audience_events
        WHERE actor_id::text <> :userId
        GROUP BY actor_id
      )
    `;

    const [
      behaviorRows,
      sessionRows,
      audienceRows,
      ageRows,
      ageCoverageRows,
      countryRows,
      cityRows,
      locationRows,
      contentRows,
      profile,
    ] = await Promise.all([
      sequelize.query(`
        SELECT
          COUNT(DISTINCT DATE(created_at)) AS active_days,
          COUNT(*) FILTER (WHERE action_type = 'screen_view') AS screen_views,
          COUNT(*) FILTER (WHERE action_type = 'tweet_view') AS tweets_read,
          COUNT(*) FILTER (WHERE action_type = 'profile_view') AS profiles_opened,
          COUNT(*) FILTER (WHERE action_type IN ('search_query', 'search_completed')) AS searches,
          COUNT(*) FILTER (WHERE action_type = 'tweet_bookmark') AS bookmarks,
          COUNT(*) FILTER (WHERE action_type = 'tweet_share') AS shares_sent,
          COUNT(*) FILTER (WHERE action_type = 'media_view') AS media_views,
          COUNT(*) FILTER (WHERE action_type = 'content_pause') AS content_pauses,
          COUNT(*) FILTER (WHERE action_type = 'content_replay') AS content_replays,
          COUNT(*) FILTER (WHERE action_type = 'content_fullscreen') AS fullscreen_opens,
          COUNT(*) FILTER (WHERE action_type = 'refresh') AS refreshes,
          COALESCE(SUM(duration_ms) FILTER (WHERE action_type = 'time_spent'), 0) AS total_time_ms,
          COALESCE(AVG(duration_ms) FILTER (WHERE action_type = 'time_spent'), 0) AS avg_time_spent_ms
        FROM user_behavior_data
        WHERE user_id = :userId::uuid AND created_at >= :startDate
      `, { replacements: { userId, startDate }, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(`
        SELECT
          COUNT(DISTINCT family_id) AS login_sessions,
          COUNT(DISTINCT COALESCE(device_id, family_id::text)) AS devices,
          MAX(COALESCE(last_used_at, created_at)) AS last_session_at
        FROM sessions
        WHERE user_id = :userId::uuid AND created_at >= :startDate
      `, { replacements: { userId, startDate }, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(`${audienceEventsCte}
        SELECT
          COALESCE(SUM(event_count), 0) AS total_interactions,
          COUNT(*) AS unique_users,
          COUNT(*) FILTER (WHERE event_count >= 2) AS returning_users,
          COALESCE(AVG(event_count), 0) AS interactions_per_user
        FROM audience_users
      `, { replacements: { userId, startDate }, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(`${audienceEventsCte}
        SELECT
          CASE
            WHEN u.declared_age BETWEEN 13 AND 17 THEN '13-17'
            WHEN u.declared_age BETWEEN 18 AND 24 THEN '18-24'
            WHEN u.declared_age BETWEEN 25 AND 34 THEN '25-34'
            WHEN u.declared_age BETWEEN 35 AND 44 THEN '35-44'
            WHEN u.declared_age BETWEEN 45 AND 54 THEN '45-54'
            ELSE '55+'
          END AS label,
          COUNT(*) AS audience_count
        FROM audience_users au JOIN users u ON u.id = au.actor_id
        WHERE u.demographics_validated_at IS NOT NULL AND u.declared_age IS NOT NULL
        GROUP BY 1
        HAVING COUNT(*) >= 5
        ORDER BY MIN(u.declared_age)
      `, { replacements: { userId, startDate }, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(`${audienceEventsCte}
        SELECT COUNT(*) AS declared_users
        FROM audience_users au JOIN users u ON u.id = au.actor_id
        WHERE u.demographics_validated_at IS NOT NULL AND u.declared_age IS NOT NULL
      `, { replacements: { userId, startDate }, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(`${audienceEventsCte}, latest_locations AS (
        SELECT DISTINCT ON (user_id) user_id, country_code, country, region
        FROM user_location_events
        WHERE permission_status = 'granted' AND country_code IS NOT NULL
        ORDER BY user_id, captured_at DESC
      )
        SELECT
          COALESCE(NULLIF(ll.country, ''), ll.country_code) AS label,
          ll.country_code,
          COUNT(*) AS audience_count
        FROM audience_users au JOIN latest_locations ll ON ll.user_id = au.actor_id
        GROUP BY ll.country_code, ll.country
        HAVING COUNT(*) >= 5
        ORDER BY audience_count DESC, label
        LIMIT 12
      `, { replacements: { userId, startDate }, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(`${audienceEventsCte}, latest_locations AS (
        SELECT DISTINCT ON (user_id) user_id, country_code, city
        FROM user_location_events
        WHERE permission_status = 'granted' AND city IS NOT NULL AND city <> ''
        ORDER BY user_id, captured_at DESC
      )
        SELECT
          ll.city || COALESCE(', ' || ll.country_code, '') AS label,
          ll.country_code,
          COUNT(*) AS audience_count
        FROM audience_users au JOIN latest_locations ll ON ll.user_id = au.actor_id
        GROUP BY ll.city, ll.country_code
        HAVING COUNT(*) >= 5
        ORDER BY audience_count DESC, label
        LIMIT 12
      `, { replacements: { userId, startDate }, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(`
        SELECT
          COUNT(*) FILTER (WHERE permission_status = 'granted') AS captured_sessions,
          COUNT(DISTINCT country_code) FILTER (WHERE permission_status = 'granted' AND country_code IS NOT NULL) AS countries,
          COUNT(DISTINCT region) FILTER (WHERE permission_status = 'granted' AND region IS NOT NULL) AS regions,
          MAX(captured_at) FILTER (WHERE permission_status = 'granted') AS last_captured_at
        FROM user_location_events
        WHERE user_id = :userId::uuid AND captured_at >= :startDate
      `, { replacements: { userId, startDate }, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(`
        SELECT
          (SELECT COUNT(*) FROM stories s
            WHERE s.user_id = :userId::uuid AND s.created_at >= :startDate AND s.deleted_at IS NULL) AS stories_created,
          (SELECT COALESCE(SUM(s.views_count), 0) FROM stories s
            WHERE s.user_id = :userId::uuid AND s.created_at >= :startDate AND s.deleted_at IS NULL) AS story_views,
          (SELECT COALESCE(SUM(s.likes_count), 0) FROM stories s
            WHERE s.user_id = :userId::uuid AND s.created_at >= :startDate AND s.deleted_at IS NULL) AS story_likes,
          (SELECT COALESCE(SUM(pv.view_count), 0) FROM profile_views pv
            WHERE pv.profile_id = :userId::uuid AND pv.viewed_on >= CAST(:startDate AS date)) AS canonical_profile_views,
          (SELECT COUNT(*) FROM scheduled_tweets st
            WHERE st.user_id = :userId::uuid AND st.created_at >= :startDate) AS scheduled_posts,
          (SELECT COUNT(*) FROM scheduled_tweets st
            WHERE st.user_id = :userId::uuid AND st.created_at >= :startDate AND st.status = 'published') AS published_scheduled_posts,
          (SELECT COUNT(*) FROM paid_contents pc
            WHERE pc.creator_id = :userId::uuid AND pc.created_at >= :startDate) AS paid_offers,
          (SELECT COUNT(*) FROM content_purchases cp
            WHERE cp.creator_id = :userId::uuid AND cp.created_at >= :startDate AND cp.refunded_at IS NULL) AS paid_sales,
          (SELECT COALESCE(SUM(cp.creator_net_twc), 0) FROM content_purchases cp
            WHERE cp.creator_id = :userId::uuid AND cp.created_at >= :startDate AND cp.refunded_at IS NULL) AS paid_revenue_twc,
          (SELECT COALESCE(AVG(labels.quality_score), 0)
            -- AUDIT R2-01 (2026-08-19) : tweet_llm_labels.tweet_id est déjà
            -- UUID (voir moderationController.js, l.tweet_id = t.id sans
            -- cast, qui fonctionne) — les deux ::text ne faisaient que
            -- rendre l'index de tweets.id inutilisable pour rien.
            FROM tweet_llm_labels labels JOIN tweets t ON t.id = labels.tweet_id
            WHERE t.user_id = :userId::uuid AND t.created_at >= :startDate AND t.deleted_at IS NULL) AS average_quality_score,
          (SELECT COALESCE(AVG(labels.toxicity_score), 0)
            -- AUDIT R2-01 (2026-08-19) : tweet_llm_labels.tweet_id est déjà
            -- UUID (voir moderationController.js, l.tweet_id = t.id sans
            -- cast, qui fonctionne) — les deux ::text ne faisaient que
            -- rendre l'index de tweets.id inutilisable pour rien.
            FROM tweet_llm_labels labels JOIN tweets t ON t.id = labels.tweet_id
            WHERE t.user_id = :userId::uuid AND t.created_at >= :startDate AND t.deleted_at IS NULL) AS average_toxicity_score,
          (SELECT COALESCE(SUM(tq.total_views), 0) FROM tweet_queue tq
            WHERE tq.user_id = :userId::uuid AND tq.queued_at >= :startDate) AS algorithmic_views,
          (SELECT COALESCE(SUM(tq.evaluation_count), 0) FROM tweet_queue tq
            WHERE tq.user_id = :userId::uuid AND tq.queued_at >= :startDate) AS algorithm_evaluations
      `, { replacements: { userId, startDate }, type: sequelize.QueryTypes.SELECT }),
      User.findByPk(userId, {
        attributes: ['declared_age', 'birth_day', 'birth_month', 'demographics_validated_at', 'location_consent_status'],
      }),
    ]);

    const behavior = behaviorRows[0] || {};
    const sessions = sessionRows[0] || {};
    const audience = audienceRows[0] || {};
    const location = locationRows[0] || {};
    const content = contentRows[0] || {};
    const uniqueAudience = int(audience.unique_users);
    const declaredAudience = int(ageCoverageRows[0]?.declared_users);
    const visibleAgeTotal = ageRows.reduce((sum, row) => sum + int(row.audience_count), 0);
    const visibleCountryTotal = countryRows.reduce((sum, row) => sum + int(row.audience_count), 0);
    const visibleCityTotal = cityRows.reduce((sum, row) => sum + int(row.audience_count), 0);

    res.json({
      success: true,
      data: {
        userId,
        timeframe,
        behavior: {
          activeDays: int(behavior.active_days),
          loginSessions: int(sessions.login_sessions),
          devices: int(sessions.devices),
          lastSessionAt: sessions.last_session_at || null,
          totalMinutes: Math.round(int(behavior.total_time_ms) / 60000),
          averageActiveSeconds: Math.round(decimal(behavior.avg_time_spent_ms) / 1000),
          screenViews: int(behavior.screen_views),
          tweetsRead: int(behavior.tweets_read),
          profilesOpened: int(behavior.profiles_opened),
          searches: int(behavior.searches),
          bookmarks: int(behavior.bookmarks),
          sharesSent: int(behavior.shares_sent),
          mediaViews: int(behavior.media_views),
          contentPauses: int(behavior.content_pauses),
          contentReplays: int(behavior.content_replays),
          fullscreenOpens: int(behavior.fullscreen_opens),
          refreshes: int(behavior.refreshes),
        },
        audience: {
          uniqueEngagedUsers: uniqueAudience,
          returningUsers: int(audience.returning_users),
          totalInteractions: int(audience.total_interactions),
          interactionsPerUser: decimal(audience.interactions_per_user),
          demographicsCoverage: uniqueAudience >= 5 ? declaredAudience : 0,
          ageBands: ageRows.map((row) => ({
            label: row.label,
            count: int(row.audience_count),
            percentage: visibleAgeTotal > 0 ? Math.round(int(row.audience_count) * 1000 / visibleAgeTotal) / 10 : 0,
          })),
          countries: countryRows.map((row) => ({
            label: row.label,
            code: row.country_code,
            count: int(row.audience_count),
            percentage: visibleCountryTotal > 0 ? Math.round(int(row.audience_count) * 1000 / visibleCountryTotal) / 10 : 0,
          })),
          cities: cityRows.map((row) => ({
            label: row.label,
            code: row.country_code,
            count: int(row.audience_count),
            percentage: visibleCityTotal > 0 ? Math.round(int(row.audience_count) * 1000 / visibleCityTotal) / 10 : 0,
          })),
          privacyThreshold: 5,
        },
        location: {
          consentStatus: profile?.location_consent_status || 'undetermined',
          capturedSessions: int(location.captured_sessions),
          countries: int(location.countries),
          regions: int(location.regions),
          lastCapturedAt: location.last_captured_at || null,
        },
        content: {
          storiesCreated: int(content.stories_created),
          storyViews: int(content.story_views),
          storyLikes: int(content.story_likes),
          profileViews: int(content.canonical_profile_views),
          scheduledPosts: int(content.scheduled_posts),
          publishedScheduledPosts: int(content.published_scheduled_posts),
          paidOffers: int(content.paid_offers),
          paidSales: int(content.paid_sales),
          paidRevenueTwc: decimal(content.paid_revenue_twc),
          averageQualityScore: decimal(content.average_quality_score),
          averageToxicityScore: decimal(content.average_toxicity_score),
          algorithmicViews: int(content.algorithmic_views),
          algorithmEvaluations: int(content.algorithm_evaluations),
        },
        privateProfile: {
          declaredAge: isOwner ? profile?.declared_age ?? null : null,
          birthDay: isOwner ? profile?.birth_day ?? null : null,
          birthMonth: isOwner ? profile?.birth_month ?? null : null,
          validated: isOwner && Boolean(profile?.demographics_validated_at),
        },
        generated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Erreur recuperation insights approfondis:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la recuperation des insights approfondis',
      error: error.message,
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
      WHERE t.user_id = :userId::uuid
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
    logger.error('❌ Erreur calcul meilleur créneau:', error);
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
          COALESCE((
            SELECT COUNT(*)
            FROM user_behavior_data ubd
            WHERE ubd.target_id::text = t.id::text
              AND ubd.target_type = 'tweet'
              AND ubd.action_type = 'tweet_share'
          ), 0) as shares_count
        FROM tweets t
        LEFT JOIN tweet_likes tl ON t.id = tl.tweet_id
        LEFT JOIN tweet_retweets tr ON t.id = tr.tweet_id
        LEFT JOIN tweets reply ON t.id = reply.parent_tweet_id
        WHERE t.user_id = :userId::uuid
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
    logger.error('❌ Erreur récupération répartition engagement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de la répartition de l\'engagement',
      error: error.message
    });
  }
});

module.exports = router;
