const express = require('express');
const { query, validationResult } = require('express-validator');
const router = express.Router();

// Import des modèles et services
const { User, Tweet, TweetLike, TweetRetweet, sequelize } = require('../models');
const { Op } = require('sequelize');
const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const { streamSearchSummary } = require('../services/searchSummaryService');

router.post('/ai-summary/stream', async (req, res) => {
  const { q, type = 'all', users = [], tweets = [], hashtags = [] } = req.body || {};
  const queryText = typeof q === 'string' ? q.trim() : '';

  if (!queryText) {
    return res.status(400).json({
      success: false,
      message: 'Le champ q est requis'
    });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const sendEvent = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const result = await streamSearchSummary({
      query: queryText,
      type,
      users,
      tweets,
      hashtags,
      onChunk: (text) => sendEvent('chunk', { text })
    });

    sendEvent('done', { text: result.text || '' });
  } catch (error) {
    logger.error('❌ Erreur route /api/search/ai-summary/stream:', error);
    sendEvent('error', { message: 'Erreur lors de la génération du résumé IA' });
  } finally {
    res.end();
  }
});

// Middleware de validation des erreurs
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Données invalides',
      errors: errors.array()
    });
  }
  next();
};

// ========================================
// ROUTES PUBLIQUES (sans authentification)
// ========================================

/**
 * GET /api/search/test
 * Route de test pour vérifier le système de recherche
 */
router.get('/test', async (req, res) => {
  try {
    logger.info('🧪 Test du système de recherche');
    
    // Test de recherche d'utilisateurs
    const testUsers = await User.searchUsers('test', 5);
    logger.info(`✅ Recherche utilisateurs: ${testUsers.length} résultats`);
    
    // Test de recherche de tweets
    const testTweets = await Tweet.searchTweets('test', { limit: 5 });
    logger.info(`✅ Recherche tweets: ${testTweets.length} résultats`);
    
    // Test de recherche de hashtags
    const testHashtagTweets = await Tweet.findAll({
      where: {
        hashtags: { [Op.overlap]: ['test'] },
        is_private: false,
        moderation_status: 'approved'
      },
      limit: 5
    });
    logger.info(`✅ Recherche hashtags: ${testHashtagTweets.length} tweets avec hashtag 'test'`);
    
    res.json({
      success: true,
      message: 'Test du système de recherche réussi',
      data: {
        users_count: testUsers.length,
        tweets_count: testTweets.length,
        hashtags_count: testHashtagTweets.length,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    logger.error('❌ Erreur lors du test du système de recherche:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du test',
      error: error.message
    });
  }
});

/**
 * GET /api/search
 * Recherche globale (utilisateurs et tweets)
 */
router.get('/', [
  query('q').trim().isLength({ min: 1, max: 100 }).withMessage('Le terme de recherche doit contenir entre 1 et 100 caractères'),
  query('type').optional().isIn(['all', 'users', 'tweets', 'hashtags']).withMessage('Type de recherche invalide'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  query('sort').optional().isIn(['relevance', 'latest', 'popular']).withMessage('Tri invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    logger.info('🔍 Recherche globale - Query params:', req.query);
    
    const {
      q: query,
      type = 'all',
      limit = 20,
      offset = 0,
      sort = 'relevance'
    } = req.query;
    
    logger.info('🔍 Recherche globale - Paramètres extraits:', { query, type, limit, offset, sort });

    const results = {
      users: [],
      tweets: [],
      hashtags: [],
      total: 0
    };

    // Recherche d'utilisateurs
    if (type === 'all' || type === 'users') {
      const users = await User.searchUsers(query, Math.ceil(limit / 2));
      results.users = users;
    }

    // Recherche de tweets
    if (type === 'all' || type === 'tweets') {
      const tweets = await Tweet.searchTweets(query, {
        limit: Math.ceil(limit / 2),
        includeReplies: false,
        includeRetweets: true,
        sortBy: sort === 'popular' ? 'view_count' : 'created_at',
        sortOrder: sort === 'latest' ? 'DESC' : 'DESC'
      });

      // Enrichir les tweets avec les statistiques et interactions utilisateur
      const enrichedTweets = await Promise.all(tweets.map(async (tweet) => {
        // Compter les likes, retweets et réponses
        const likeCount = await TweetLike.count({ where: { tweet_id: tweet.id } });
        const retweetCount = await TweetRetweet.count({ where: { tweet_id: tweet.id } });
        const replyCount = await Tweet.count({ 
          where: { parent_tweet_id: tweet.id }
        });

        // Vérifier si l'utilisateur connecté a liké/retweeté ce tweet (si authentifié)
        let isLiked = false;
        let isRetweeted = false;
        
        // Vérifier si l'utilisateur est authentifié via le header Authorization
        const authHeader = req.headers.authorization;
        logger.info(`🔍 Recherche de tweets - Auth header: ${authHeader ? 'Présent' : 'Absent'}`);
        
        if (authHeader && authHeader.startsWith('Bearer ')) {
          try {
            const token = authHeader.substring(7);
            logger.info(`🔑 Token extrait, longueur: ${token.length}`);
            
            const jwt = require('jsonwebtoken');
            const config = require('../config/config');
            
            logger.info(`🔧 Tentative de décodage du JWT avec secret: ${config.jwt.secret ? 'Présent' : 'Absent'}`);
            
            const decoded = jwt.verify(token, config.jwt.secret);
            logger.info(`✅ JWT décodé avec succès:`, { userId: decoded.id, username: decoded.username });
            
            if (decoded && decoded.id) {
              logger.info(`👤 Utilisateur authentifié: ${decoded.id}`);
              isLiked = await TweetLike.hasUserLikedTweet(decoded.id, tweet.id);
              isRetweeted = await TweetRetweet.hasUserRetweetedTweet(decoded.id, tweet.id);
              logger.info(`📊 Tweet ${tweet.id} - Interactions: Like=${isLiked}, Retweet=${isRetweeted}`);
            } else {
              logger.warn(`⚠️ JWT décodé mais pas d'userId:`, decoded);
            }
          } catch (error) {
            // Token invalide, continuer sans authentification
            logger.error(`❌ Erreur lors du décodage du JWT:`, error.message);
            logger.debug('Token invalide lors de la recherche de tweets, recherche publique');
          }
        } else {
          logger.info('🔍 Recherche publique - Pas d\'authentification');
        }

        const enrichedTweet = {
          ...tweet.toJSON(),
          stats: {
            likes: likeCount,
            retweets: retweetCount,
            replies: replyCount,
            views: tweet.view_count || 0
          },
          user_interaction: {
            is_liked: isLiked,
            is_retweeted: isRetweeted
          }
        };

        logger.info(`📝 Tweet ${tweet.id} enrichi:`, {
          stats: enrichedTweet.stats,
          user_interaction: enrichedTweet.user_interaction
        });

        return enrichedTweet;
      }));

      results.tweets = enrichedTweets;
    }

    // Recherche de hashtags
    if (type === 'all' || type === 'hashtags') {
      try {
        // Utiliser la méthode searchTweets améliorée pour les hashtags
        const hashtagTweets = await Tweet.searchTweets(`#${query}`, {
          limit: 100, // Limite plus élevée pour un meilleur comptage
          includeReplies: true,
          includeRetweets: true
        });

        // Extraire et compter les hashtags
        const hashtagCounts = {};
        hashtagTweets.forEach(tweet => {
          if (tweet.hashtags && Array.isArray(tweet.hashtags)) {
            tweet.hashtags.forEach(tag => {
              if (tag && tag.toLowerCase().includes(query.toLowerCase())) {
                hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
              }
            });
          }
        });

        results.hashtags = Object.entries(hashtagCounts)
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
          
        logger.info(`🔍 Hashtags trouvés pour "${query}": ${results.hashtags.length}`);
      } catch (hashtagError) {
        logger.error(`❌ Erreur lors de la recherche de hashtags pour "${query}":`, hashtagError);
        results.hashtags = [];
      }
    }

    // Calculer le total
    results.total = results.users.length + results.tweets.length + results.hashtags.length;

    res.json({
      success: true,
      message: 'Recherche effectuée avec succès',
      data: {
        query,
        type,
        results,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + results.total < results.total
        }
      }
    });

  } catch (error) {
    console.error('💥 Erreur lors de la recherche globale:', error);
    logger.error('Erreur lors de la recherche globale:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur',
      error: error.message
    });
  }
});

/**
 * GET /api/search/users
 * Recherche d'utilisateurs
 */
router.get('/users', [
  query('q').trim().isLength({ min: 1, max: 100 }).withMessage('Le terme de recherche doit contenir entre 1 et 100 caractères'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  query('sort').optional().isIn(['relevance', 'followers', 'latest', 'verified']).withMessage('Tri invalide'),
  query('verified').optional().isBoolean().withMessage('Le filtre vérifié doit être un booléen'),
  handleValidationErrors
], async (req, res) => {
  try {
    const {
      q: query,
      limit = 20,
      offset = 0,
      sort = 'relevance',
      verified
    } = req.query;

    let whereClause = {
      is_active: true
    };

    // Filtre par statut vérifié
    if (verified !== undefined) {
      whereClause.verified = verified;
    }

    // Recherche par nom d'utilisateur ou nom complet
    const users = await User.findAll({
      where: {
        ...whereClause,
        [Op.or]: [
          { username: { [Op.iLike]: `%${query}%` } },
          { full_name: { [Op.iLike]: `%${query}%` } }
        ]
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'stats'],
      order: getUsersOrderClause(sort),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    // Compter le total
    const totalCount = await User.count({
      where: {
        ...whereClause,
        [Op.or]: [
          { username: { [Op.iLike]: `%${query}%` } },
          { full_name: { [Op.iLike]: `%${query}%` } }
        ]
      }
    });

    res.json({
      success: true,
      message: 'Recherche d\'utilisateurs effectuée avec succès',
      data: {
        query,
        users,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + users.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la recherche d\'utilisateurs:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/search/tweets
 * Recherche de tweets
 */
router.get('/tweets', [
  query('q').trim().isLength({ min: 1, max: 100 }).withMessage('Le terme de recherche doit contenir entre 1 et 100 caractères'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  query('sort').optional().isIn(['relevance', 'latest', 'popular', 'trending']).withMessage('Tri invalide'),
  query('type').optional().isIn(['all', 'tweets', 'replies', 'retweets', 'quotes']).withMessage('Type de tweet invalide'),
  query('hashtag').optional().isString().withMessage('Le hashtag doit être une chaîne'),
  query('from_user').optional().isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const {
      q: rawQuery,
      limit = 20,
      offset = 0,
      sort = 'relevance',
      type = 'all',
      hashtag: rawHashtag,
      from_user
    } = req.query;

    // Normaliser les hashtags dans la requête: réduire '##tag' -> '#tag'
    const query = typeof rawQuery === 'string' ? rawQuery.replace(/^#+/, '#') : rawQuery;
    const hashtag = typeof rawHashtag === 'string' ? rawHashtag.replace(/^#+/, '#') : rawHashtag;

    let whereClause = {
      is_private: false,
      moderation_status: 'approved'
    };

    // Filtre par type
    if (type === 'replies') {
      whereClause.parent_tweet_id = { [Op.ne]: null };
    } else if (type === 'retweets') {
      whereClause.is_retweet = true;
    } else if (type === 'quotes') {
      whereClause.is_quote = true;
    } else if (type === 'tweets') {
      whereClause.parent_tweet_id = null;
    }

    // Filtre par hashtag
    if (hashtag) {
      whereClause.hashtags = { [Op.overlap]: [hashtag] };
    }

    // Filtre par utilisateur
    if (from_user) {
      whereClause.user_id = from_user;
    }

    // Utiliser la méthode searchTweets du modèle Tweet
    const tweets = await Tweet.searchTweets(query, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      includeReplies: type === 'replies',
      includeRetweets: type === 'retweets',
      sortBy: sort === 'popular' ? 'view_count' : 'created_at',
      sortOrder: sort === 'latest' ? 'DESC' : 'DESC'
    });

    // Enrichir les tweets avec les statistiques et interactions utilisateur
    const enrichedTweets = await Promise.all(tweets.map(async (tweet) => {
      // Compter les likes, retweets et réponses
      const likeCount = await TweetLike.count({ where: { tweet_id: tweet.id } });
      const retweetCount = await TweetRetweet.count({ where: { tweet_id: tweet.id } });
      const replyCount = await Tweet.count({ 
        where: { parent_tweet_id: tweet.id }
      });

      // Vérifier si l'utilisateur connecté a liké/retweeté ce tweet (si authentifié)
      let isLiked = false;
      let isRetweeted = false;
      
      // Vérifier si l'utilisateur est authentifié via le header Authorization
      const authHeader = req.headers.authorization;
      logger.info(`🔍 Recherche de tweets - Auth header: ${authHeader ? 'Présent' : 'Absent'}`);
      
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.substring(7);
          const jwt = require('jsonwebtoken');
          const config = require('../config/config');
          const decoded = jwt.verify(token, config.jwt.secret);
          
          if (decoded && decoded.id) {
            logger.info(`👤 Utilisateur authentifié: ${decoded.id}`);
            isLiked = await TweetLike.hasUserLikedTweet(decoded.id, tweet.id);
            isRetweeted = await TweetRetweet.hasUserRetweetedTweet(decoded.id, tweet.id);
            logger.info(`📊 Tweet ${tweet.id} - Interactions: Like=${isLiked}, Retweet=${isRetweeted}`);
          }
        } catch (error) {
          // Token invalide, continuer sans authentification
          logger.debug('Token invalide lors de la recherche de tweets, recherche publique');
        }
      } else {
        logger.info('🔍 Recherche publique - Pas d\'authentification');
      }

      const enrichedTweet = {
        ...tweet.toJSON(),
        stats: {
          likes: likeCount,
          retweets: retweetCount,
          replies: replyCount,
          views: tweet.view_count || 0
        },
        user_interaction: {
          is_liked: isLiked,
          is_retweeted: isRetweeted
        }
      };

      logger.info(`📝 Tweet ${tweet.id} enrichi:`, {
        stats: enrichedTweet.stats,
        user_interaction: enrichedTweet.user_interaction
      });

      return enrichedTweet;
    }));

    // Compter le total
    const totalCount = await Tweet.count({ where: whereClause });

    res.json({
      success: true,
      message: 'Recherche de tweets effectuée avec succès',
      data: {
        query,
        tweets: enrichedTweets,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + enrichedTweets.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la recherche de tweets:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/search/tweets/authenticated
 * Recherche de tweets avec authentification (pour récupérer les interactions utilisateur)
 */
router.get('/tweets/authenticated', [
  authenticateToken,
  denySuspended,
  query('q').trim().isLength({ min: 1, max: 100 }).withMessage('Le terme de recherche doit contenir entre 1 et 100 caractères'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  query('sort').optional().isIn(['relevance', 'latest', 'popular', 'trending']).withMessage('Tri invalide'),
  query('type').optional().isIn(['all', 'tweets', 'replies', 'retweets', 'quotes']).withMessage('Type de tweet invalide'),
  query('hashtag').optional().isString().withMessage('Le hashtag doit être une chaîne'),
  query('from_user').optional().isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const {
      q: rawQuery,
      limit = 20,
      offset = 0,
      sort = 'relevance',
      type = 'all',
      hashtag: rawHashtag,
      from_user
    } = req.query;

    // Normaliser les hashtags dans la requête: réduire '##tag' -> '#tag'
    const query = typeof rawQuery === 'string' ? rawQuery.replace(/^#+/, '#') : rawQuery;
    const hashtag = typeof rawHashtag === 'string' ? rawHashtag.replace(/^#+/, '#') : rawHashtag;

    const userId = req.user.id; // Récupéré par le middleware d'authentification
    logger.info(`🔍 Recherche authentifiée pour l'utilisateur: ${userId}`);

    let whereClause = {
      is_private: false,
      moderation_status: 'approved'
    };

    // Filtre par type
    if (type === 'replies') {
      whereClause.parent_tweet_id = { [Op.ne]: null };
    } else if (type === 'retweets') {
      whereClause.is_retweet = true;
    } else if (type === 'quotes') {
      whereClause.is_quote = true;
    } else if (type === 'tweets') {
      whereClause.parent_tweet_id = null;
    }

    // Filtre par hashtag
    if (hashtag) {
      whereClause.hashtags = { [Op.overlap]: [hashtag] };
    }

    // Filtre par utilisateur
    if (from_user) {
      whereClause.user_id = from_user;
    }

    // Utiliser la méthode searchTweets du modèle Tweet
    const tweets = await Tweet.searchTweets(query, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      includeReplies: type === 'replies',
      includeRetweets: type === 'retweets',
      sortBy: sort === 'popular' ? 'view_count' : 'created_at',
      sortOrder: sort === 'latest' ? 'DESC' : 'DESC'
    });

    // Enrichir les tweets avec les statistiques et interactions utilisateur
    const enrichedTweets = await Promise.all(tweets.map(async (tweet) => {
      // Compter les likes, retweets et réponses
      const likeCount = await TweetLike.count({ where: { tweet_id: tweet.id } });
      const retweetCount = await TweetRetweet.count({ where: { tweet_id: tweet.id } });
      const replyCount = await Tweet.count({ 
        where: { parent_tweet_id: tweet.id }
      });

      // Récupérer les interactions de l'utilisateur authentifié
      const isLiked = await TweetLike.hasUserLikedTweet(userId, tweet.id);
      const isRetweeted = await TweetRetweet.hasUserRetweetedTweet(userId, tweet.id);
      
      logger.info(`📊 Tweet ${tweet.id} - Interactions pour ${userId}: Like=${isLiked}, Retweet=${isRetweeted}`);

      return {
        ...tweet.toJSON(),
        stats: {
          likes: likeCount,
          retweets: retweetCount,
          replies: replyCount,
          views: tweet.view_count || 0
        },
        user_interaction: {
          is_liked: isLiked,
          is_retweeted: isRetweeted
        }
      };
    }));

    // Compter le total
    const totalCount = await Tweet.count({ where: whereClause });

    res.json({
      success: true,
      message: 'Recherche de tweets authentifiée effectuée avec succès',
      data: {
        query,
        tweets: enrichedTweets,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + enrichedTweets.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la recherche de tweets authentifiée:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/search/hashtags
 * Recherche de hashtags
 */
router.get('/hashtags', [
  query('q').trim().isLength({ min: 1, max: 100 }).withMessage('Le terme de recherche doit contenir entre 1 et 100 caractères'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  query('sort').optional().isIn(['popularity', 'recent', 'alphabetical']).withMessage('Tri invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const {
      q: query,
      limit = 20,
      offset = 0,
      sort = 'popularity'
    } = req.query;

    // Recherche de tweets contenant le hashtag
    const tweetsWithHashtag = await Tweet.findAll({
      where: {
        hashtags: { [Op.overlap]: [query] },
        is_private: false,
        moderation_status: 'approved',
        parent_tweet_id: null // Exclure les réponses
      },
      attributes: ['hashtags', 'created_at'],
      order: [['created_at', 'DESC']],
      limit: 1000 // Limite élevée pour un bon comptage
    });

    if (!tweetsWithHashtag || tweetsWithHashtag.length === 0) {
      logger.info(`🔍 Aucun tweet trouvé avec le hashtag "${query}"`);
      return res.json({
        success: true,
        message: 'Aucun hashtag trouvé',
        data: {
          query,
          hashtags: [],
          pagination: {
            total: 0,
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: false
          }
        }
      });
    }

    // Analyser et compter les hashtags
    const hashtagStats = {};
    tweetsWithHashtag.forEach(tweet => {
      if (tweet.hashtags && Array.isArray(tweet.hashtags)) {
        tweet.hashtags.forEach(tag => {
          if (tag && typeof tag === 'string' && tag.toLowerCase().includes(query.toLowerCase())) {
            if (!hashtagStats[tag]) {
              hashtagStats[tag] = {
                tag,
                count: 0,
                recent_usage: null
              };
            }
            hashtagStats[tag].count++;
            
            // Garder la date d'utilisation la plus récente
            if (!hashtagStats[tag].recent_usage || tweet.created_at > hashtagStats[tag].recent_usage) {
              hashtagStats[tag].recent_usage = tweet.created_at;
            }
          }
        });
      }
    });

    // Convertir en tableau et trier
    let hashtags = Object.values(hashtagStats);
    
    switch (sort) {
      case 'popularity':
        hashtags.sort((a, b) => b.count - a.count);
        break;
      case 'recent':
        hashtags.sort((a, b) => new Date(b.recent_usage) - new Date(a.recent_usage));
        break;
      case 'alphabetical':
        hashtags.sort((a, b) => a.tag.localeCompare(b.tag));
        break;
    }

    // Pagination
    const totalCount = hashtags.length;
    hashtags = hashtags.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    res.json({
      success: true,
      message: 'Recherche de hashtags effectuée avec succès',
      data: {
        query,
        hashtags,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + hashtags.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la recherche de hashtags:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/search/trending
 * Obtenir les hashtags et sujets tendance
 */
router.get('/trending', [
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('La limite doit être entre 1 et 50'),
  query('period').optional().isIn(['1h', '24h', '7d', '30d']).withMessage('Période invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const {
      limit = 20,
      period = '24h'
    } = req.query;

    // Calculer la date de début selon la période
    const now = new Date();
    let startDate;
    
    switch (period) {
      case '1h':
        startDate = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case '24h':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
    }

    // Récupérer les tweets de la période
    const recentTweets = await Tweet.findAll({
      where: {
        created_at: { [Op.gte]: startDate },
        is_private: false,
        moderation_status: 'approved',
        parent_tweet_id: null // Exclure les réponses
      },
      attributes: ['hashtags', 'created_at', 'view_count'],
      order: [['created_at', 'DESC']],
      limit: 10000 // Limite élevée pour une bonne analyse
    });

    // Analyser les hashtags tendance
    const hashtagTrends = {};
    recentTweets.forEach(tweet => {
      tweet.hashtags.forEach(tag => {
        if (!hashtagTrends[tag]) {
          hashtagTrends[tag] = {
            tag,
            count: 0,
            total_views: 0,
            recent_usage: null
          };
        }
        hashtagTrends[tag].count++;
        hashtagTrends[tag].total_views += tweet.view_count || 0;
        
        if (!hashtagTrends[tag].recent_usage || tweet.created_at > hashtagTrends[tag].recent_usage) {
          hashtagTrends[tag].recent_usage = tweet.created_at;
        }
      });
    });

    // Calculer le score de tendance (combinaison de fréquence et d'engagement)
    const trendingHashtags = Object.values(hashtagTrends)
      .map(hashtag => ({
        ...hashtag,
        trend_score: hashtag.count * Math.log(hashtag.total_views + 1) * 
                    (1 + (now - new Date(hashtag.recent_usage)) / (24 * 60 * 60 * 1000))
      }))
      .sort((a, b) => b.trend_score - a.trend_score)
      .slice(0, parseInt(limit));

    res.json({
      success: true,
      message: 'Hashtags tendance récupérés avec succès',
      data: {
        period,
        hashtags: trendingHashtags,
        generated_at: now.toISOString()
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des hashtags tendance:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

// ========================================
// ROUTES PROTÉGÉES (avec authentification)
// ========================================

/**
 * GET /api/search/suggestions
 * Obtenir des suggestions de recherche personnalisées
 */
router.get('/suggestions', [
  authenticateToken,
  denySuspended,
  query('limit').optional().isInt({ min: 1, max: 20 }).withMessage('La limite doit être entre 1 et 20'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const userId = req.user.id;

    // Suggestions basées sur les utilisateurs suivis
    const following = await User.findAll({
      include: [{
        model: User,
        as: 'following',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style']
      }],
      where: { 'following.follower_id': userId },
      limit: 5
    });

    // Suggestions basées sur les hashtags populaires
    const popularHashtags = await Tweet.findAll({
      attributes: ['hashtags'],
      where: {
        is_private: false,
        moderation_status: 'approved',
        created_at: { [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      },
      order: [['view_count', 'DESC']],
      limit: 100
    });

    const hashtagCounts = {};
    popularHashtags.forEach(tweet => {
      tweet.hashtags.forEach(tag => {
        hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
      });
    });

    const trendingHashtags = Object.entries(hashtagCounts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    res.json({
      success: true,
      message: 'Suggestions de recherche récupérées avec succès',
      data: {
        following_suggestions: following.map(f => f.following),
        hashtag_suggestions: trendingHashtags
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des suggestions:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

// ========================================
// FONCTIONS UTILITAIRES
// ========================================

/**
 * Génère la clause d'ordre pour les utilisateurs
 */
function getUsersOrderClause(sort) {
  switch (sort) {
    case 'followers':
      return [['stats.followers', 'DESC'], ['username', 'ASC']];
    case 'latest':
      return [['created_at', 'DESC']];
    case 'verified':
      return [['verified', 'DESC'], ['username', 'ASC']];
    case 'relevance':
    default:
      return [['username', 'ASC']];
  }
}

/**
 * Génère la clause d'ordre pour les tweets
 */
function getTweetsOrderClause(sort) {
  switch (sort) {
    case 'latest':
      return [['created_at', 'DESC']];
    case 'popular':
      return [['view_count', 'DESC'], ['created_at', 'DESC']];
    case 'trending':
      // Score de tendance basé sur l'engagement récent
      return [['created_at', 'DESC']];
    case 'relevance':
    default:
      return [['created_at', 'DESC']];
  }
}

module.exports = router;
