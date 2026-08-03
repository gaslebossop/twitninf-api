/**
 * 🚀 Routes de Recommandation Progressive - TwitNin Legacy
 * 
 * Routes API pour le système de recommandation progressive basé sur la viralité
 * avec expansion des groupes selon les interactions utilisateur.
 * 
 * @author TwitNin Team
 * @version 1.0.0 - Progressive Recommendation API
 * @license MIT
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const { Tweet, User, UserFollow } = require('../models');
const { Op } = require('sequelize');
const { filterVisibleTweets } = require('../utils/privateAccountVisibility');
const paidContentService = require('../services/paidContentService');

// Services
let ProgressiveRecommendationEngine;
let ViralityTracker;
let InteractionScoringService;

// Instance globale du moteur de recommandation
let recommendationEngine;

// Initialisation paresseuse des services
async function initializeServices() {
  if (!ProgressiveRecommendationEngine) {
    ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
  }
  if (!ViralityTracker) {
    ViralityTracker = require('../services/viralityTracker');
  }
  if (!InteractionScoringService) {
    InteractionScoringService = require('../services/interactionScoringService');
  }
}

// Initialisation des instances
let progressiveEngine;

// Créer l'instance globale du moteur de recommandation
if (!recommendationEngine) {
  recommendationEngine = new (require('../services/progressiveRecommendationEngine'))();
}
let viralityTracker;
let scoringService;

async function initializeInstances() {
  if (!progressiveEngine) {
    await initializeServices();
    progressiveEngine = new ProgressiveRecommendationEngine();
    viralityTracker = new ViralityTracker();
    scoringService = new InteractionScoringService();
  }
}

/**
 * GET /api/progressive-recommendations
 * Obtient les recommandations progressives pour l'utilisateur connecté
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    await initializeInstances();
    
    const userId = req.user.id;
    const {
      limit = 50,
      offset = 0,
      includeUser = true,
      includeStats = true,
      group = 'auto' // auto, initial, expansion, viral
    } = req.query;

    logger.info(`🚀 Demande de recommandations progressives pour ${userId} (groupe: ${group})`);

    const context = {
      limit: parseInt(limit),
      offset: parseInt(offset),
      includeUser: includeUser === 'true',
      includeStats: includeStats === 'true',
      group: group === 'auto' ? null : group
    };

    const result = await progressiveEngine.getProgressiveRecommendations(userId, context);

    if (!result || !result.recommendations) {
      return res.status(500).json({
        success: false,
        error: 'Erreur lors de la génération des recommandations',
        details: 'Aucune donnée retournée par le moteur de recommandation'
      });
    }

    // Comptes privés : le moteur classe par viralité et ignore tout de la
    // confidentialité. On tranche donc en sortie, une fois pour toutes.
    const recommendations = await filterVisibleTweets(
      result.recommendations,
      userId,
      { User, UserFollow, Op },
    );

    // Contenus payants : le moteur classe par viralité, il ignore les verrous
    // comme il ignore la confidentialité. Même endroit, même raison.
    if (!(await paidContentService.maskTweetsOrFail(recommendations, userId, res))) return;

    res.json({
      success: true,
      data: {
        recommendations,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: recommendations.length,
          // `hasMore` se calcule sur ce que le MOTEUR a produit, pas sur ce qui
          // survit au filtre : une page entièrement composée de comptes privés
          // renverrait sinon « fin du fil » alors qu'il reste tout à lire.
          hasMore: result.recommendations.length >= parseInt(limit)
        },
        metadata: result.metadata
      }
    });

  } catch (error) {
    logger.error('❌ Erreur dans GET /api/progressive-recommendations:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur',
      details: error.message
    });
  }
});

/**
 * POST /api/progressive-recommendations/track-interaction
 * Enregistre une interaction et met à jour la viralité
 */
router.post('/track-interaction', authenticateToken, async (req, res) => {
  try {
    await initializeInstances();
    
    const userId = req.user.id;
    const {
      tweetId,
      interactionType,
      metadata = {}
    } = req.body;

    // Validation des paramètres requis
    if (!tweetId || !interactionType) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres manquants',
        details: 'tweetId et interactionType sont requis'
      });
    }

    // Valider le type d'interaction
    const validInteractionTypes = [
      'tweet_like', 'tweet_unlike', 'tweet_comment', 'tweet_retweet', 'tweet_unretweet',
      'tweet_share', 'tweet_view', 'tweet_bookmark', 'profile_view', 'link_click',
      'media_view', 'hashtag_click', 'mention_click', 'content_skip', 'scroll_pause',
      'fullscreen', 'content_replay', 'tweet_report', 'user_block', 'user_mute'
    ];

    if (!validInteractionTypes.includes(interactionType)) {
      return res.status(400).json({
        success: false,
        error: 'Type d\'interaction invalide',
        validTypes: validInteractionTypes
      });
    }

    logger.info(`📊 Tracking interaction: ${interactionType} sur tweet ${tweetId} par ${userId}`);

    // Utiliser le tracking de l'algorithme progressif
    await progressiveEngine.trackUserBehavior(userId, tweetId, interactionType, {
      ...metadata,
      route: 'progressive_recommendations',
      timestamp: new Date().toISOString()
    });

    // Calculer le score de l'interaction
    const scoreResult = await scoringService.calculateInteractionScore(
      tweetId, 
      userId, 
      interactionType, 
      metadata
    );

    // Enregistrer l'interaction et mettre à jour la viralité
    const trackingResult = await viralityTracker.trackInteraction(
      tweetId,
      userId,
      interactionType,
      metadata
    );

    res.json({
      success: true,
      data: {
        interaction: {
          tweetId,
          userId,
          type: interactionType,
          score: scoreResult.finalScore,
          metadata: scoreResult
        },
        virality: trackingResult,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('❌ Erreur dans POST /api/progressive-recommendations/track-interaction:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du tracking de l\'interaction',
      details: error.message
    });
  }
});

/**
 * GET /api/progressive-recommendations/viral-tweets
 * Obtient les tweets viraux en temps réel
 */
router.get('/viral-tweets', authenticateToken, async (req, res) => {
  try {
    await initializeInstances();
    
    const { limit = 20 } = req.query;

    logger.info(`🔥 Récupération des tweets viraux (limite: ${limit})`);

    const viralTweets = await viralityTracker.getViralTweets(parseInt(limit));

    if (!(await paidContentService.maskTweetsOrFail(viralTweets, req.user.id, res))) return;

    res.json({
      success: true,
      data: {
        viralTweets,
        count: viralTweets.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('❌ Erreur dans GET /api/progressive-recommendations/viral-tweets:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des tweets viraux',
      details: error.message
    });
  }
});

/**
 * GET /api/progressive-recommendations/tweet-virality/:tweetId
 * Obtient les statistiques de viralité d'un tweet
 */
router.get('/tweet-virality/:tweetId', authenticateToken, async (req, res) => {
  try {
    await initializeInstances();
    
    const { tweetId } = req.params;

    if (!tweetId) {
      return res.status(400).json({
        success: false,
        error: 'ID de tweet requis'
      });
    }

    logger.info(`📊 Récupération des statistiques de viralité pour le tweet ${tweetId}`);

    // Récupérer les données du tweet directement
    const tweet = await Tweet.findByPk(tweetId, {
      attributes: ['id', 'view_count', 'created_at', 'stats'],
      where: {
        deleted_at: null
      }
    });

    if (!tweet) {
      return res.status(404).json({
        success: false,
        error: 'Tweet non trouvé'
      });
    }

    // Calculer les statistiques de viralité basées sur les données disponibles
    const views = parseInt(tweet.view_count) || 0;
    const stats = tweet.stats || {};
    const likes = parseInt(stats.likes) || 0;
    const retweets = parseInt(stats.retweets) || 0;
    const replies = parseInt(stats.replies) || 0;
    
    const totalInteractions = likes + retweets + replies;
    const engagementRate = views > 0 ? (totalInteractions / views) * 100 : 0;
    
    // Déterminer le niveau de recommandation basé sur les vues
    let recommendationLevel = 0;
    if (views >= 1000) {
      recommendationLevel = 4; // Massive
    } else if (views >= 100) {
      recommendationLevel = 3; // Viral
    } else if (views >= 20) {
      recommendationLevel = 2; // Expansion
    } else if (views >= 4) {
      recommendationLevel = 1; // Initial
    }

    const viralityStats = {
      tweetId: tweet.id,
      views,
      interactions: {
        likes,
        retweets,
        replies,
        total: totalInteractions
      },
      engagementRate: parseFloat(engagementRate.toFixed(2)),
      recommendationLevel,
      createdAt: tweet.created_at
    };

    res.json({
      success: true,
      data: {
        tweetId,
        virality: viralityStats,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('❌ Erreur dans GET /api/progressive-recommendations/tweet-virality:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des statistiques de viralité',
      details: error.message
    });
  }
});

/**
 * GET /api/progressive-recommendations/user-interactions
 * Obtient les statistiques d'interaction de l'utilisateur
 */
router.get('/user-interactions', authenticateToken, async (req, res) => {
  try {
    await initializeInstances();
    
    const userId = req.user.id;
    const { timeWindow = 24 } = req.query; // en heures

    logger.info(`👤 Récupération des statistiques d'interaction pour ${userId} (${timeWindow}h)`);

    const interactionStats = await scoringService.getUserInteractionStats(
      userId, 
      parseInt(timeWindow)
    );

    res.json({
      success: true,
      data: {
        userId,
        timeWindow: parseInt(timeWindow),
        stats: interactionStats,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('❌ Erreur dans GET /api/progressive-recommendations/user-interactions:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des statistiques d\'interaction',
      details: error.message
    });
  }
});

/**
 * GET /api/progressive-recommendations/algorithm-info
 * Obtient les informations sur l'algorithme de recommandation progressive
 */
router.get('/algorithm-info', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        algorithm: 'Progressive Viral Recommendation',
        version: '1.0.0',
        description: 'Algorithme de recommandation basé sur la viralité progressive avec expansion des groupes',
        features: [
          'Recommandation progressive par groupes (initial, expansion, viral)',
          'Scoring intelligent des interactions utilisateur',
          'Tracking de viralité en temps réel',
          'Expansion automatique selon les performances',
          'Arrêt automatique des tweets peu performants'
        ],
        groups: {
          initial: {
            size: 4,
            description: 'Petit groupe de test pour nouveaux tweets (10% des utilisateurs)',
            criteria: 'followers_count < 5 OR account_age < 7'
          },
          expansion: {
            size: 10,
            description: 'Groupe d\'expansion pour tweets performants (25% des utilisateurs)',
            criteria: 'followers_count BETWEEN 5 AND 15'
          },
          viral: {
            size: 26,
            description: 'Groupe viral pour tweets très performants (65% des utilisateurs)',
            criteria: 'followers_count > 15'
          },
          massive: {
            size: 40,
            description: 'Groupe massif pour tweets exceptionnels (tous les utilisateurs)',
            criteria: 'all_users',
            isUnlimited: true
          }
        },
        interactionScores: {
          positive: {
            'tweet_like': 1.0,
            'tweet_comment': 3.0,
            'tweet_retweet': 5.0,
            'tweet_share': 4.0,
            'profile_view': 2.0
          },
          negative: {
            'tweet_unlike': -1.0,
            'tweet_report': -10.0,
            'user_block': -15.0,
            'content_skip': -0.5
          }
        },
        thresholds: {
          'initial_to_expansion': 2,
          'expansion_to_viral': 8,
          'viral_to_massive': 15,
          'stop_threshold': -2
        },
        progression: {
          'Utilisateurs avec beaucoup d\'abonnés': 'Commencent directement dans un groupe plus élevé',
          'Progression continue': 'Les tweets peuvent passer d\'un groupe à l\'autre selon les interactions',
          'Groupe massif': 'Après le groupe viral, les tweets exceptionnels atteignent tous les utilisateurs',
          'Recommandation continue': 'Les tweets massifs continuent d\'être recommandés tant qu\'ils performent'
        }
      }
    });

  } catch (error) {
    logger.error('❌ Erreur dans GET /api/progressive-recommendations/algorithm-info:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des informations de l\'algorithme',
      details: error.message
    });
  }
});

/**
 * POST /api/progressive-recommendations/cleanup-cache
 * Nettoie les caches du système de recommandation
 */
router.post('/cleanup-cache', authenticateToken, async (req, res) => {
  try {
    await initializeInstances();
    
    // Nettoyer les caches
    progressiveEngine.cleanupCache();
    viralityTracker.cleanupCache();

    logger.info('🧹 Caches des recommandations progressives nettoyés');

    res.json({
      success: true,
      message: 'Caches nettoyés avec succès',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('❌ Erreur dans POST /api/progressive-recommendations/cleanup-cache:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du nettoyage des caches',
      details: error.message
    });
  }
});

/**
 * POST /api/progressive-recommendations/add-tweet
 * Ajoute un nouveau tweet approuvé au cache
 */
router.post('/add-tweet', authenticateToken, async (req, res) => {
  try {
    await initializeServices();
    
    const { tweetId } = req.body;
    
    if (!tweetId) {
      return res.status(400).json({
        success: false,
        error: 'ID du tweet requis'
      });
    }

    // Ajouter le tweet au cache
    await recommendationEngine.addNewTweet(tweetId);
    
    res.json({
      success: true,
      message: `Tweet ${tweetId} ajouté au cache`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erreur dans POST /api/progressive-recommendations/add-tweet:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'ajout du tweet au cache',
      details: error.message
    });
  }
});

/**
 * PUT /api/progressive-recommendations/update-tweet
 * Met à jour un tweet existant dans le cache
 */
router.put('/update-tweet', authenticateToken, async (req, res) => {
  try {
    await initializeServices();
    
    const { tweetId } = req.body;
    
    if (!tweetId) {
      return res.status(400).json({
        success: false,
        error: 'ID du tweet requis'
      });
    }

    // Mettre à jour le tweet dans le cache
    await recommendationEngine.updateTweet(tweetId);
    
    res.json({
      success: true,
      message: `Tweet ${tweetId} mis à jour dans le cache`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erreur dans PUT /api/progressive-recommendations/update-tweet:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la mise à jour du tweet',
      details: error.message
    });
  }
});

/**
 * POST /api/progressive-recommendations/reload-cache
 * Recharge le cache depuis la base de données
 */
router.post('/reload-cache', authenticateToken, async (req, res) => {
  try {
    await initializeServices();
    
    // Recharger le cache
    await recommendationEngine.loadCachedData();
    
    res.json({
      success: true,
      message: 'Cache rechargé depuis la base de données',
      cacheSize: recommendationEngine.cache.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Erreur dans POST /api/progressive-recommendations/reload-cache:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du rechargement du cache',
      details: error.message
    });
  }
});

/**
 * GET /api/progressive-recommendations/cache-status
 * Vérifie l'état du cache
 */
router.get('/cache-status', authenticateToken, async (req, res) => {
  try {
    await initializeServices();
    
    res.json({
      success: true,
      data: {
        cacheSize: recommendationEngine.cache.size,
        isLoaded: recommendationEngine.isLoaded,
        isLoading: recommendationEngine.isLoading,
        cacheExpiry: recommendationEngine.cacheExpiry,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('❌ Erreur dans GET /api/progressive-recommendations/cache-status:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la vérification du cache',
      details: error.message
    });
  }
});

/**
 * POST /api/progressive-recommendations/tag-all-tweets
 * Tagge tous les tweets existants avec leur groupe de recommandation
 */
router.post('/tag-all-tweets', authenticateToken, async (req, res) => {
  try {
    await initializeServices();
    
    logger.info('🏷️ Début du taguage de tous les tweets...');
    
    // Récupérer tous les tweets non tagués
    const tweets = await Tweet.findAll({
      where: {
        deleted_at: null,
        moderation_status: 'approved',
        parent_tweet_id: null,
        recommendation_group: null // Tweets non tagués
      },
      limit: 1000 // Limiter pour éviter la surcharge
    });
    
    let taggedCount = 0;
    let excludedCount = 0;
    
    for (const tweet of tweets) {
      const tweetGroup = await recommendationEngine.determineTweetRecommendationGroup(tweet.id);
      
      // Tagger le tweet
      await recommendationEngine.updateTweetRecommendationGroup(tweet.id, tweetGroup.group);
      
      if (tweetGroup.group !== 'excluded') {
        taggedCount++;
      } else {
        excludedCount++;
      }
    }
    
    res.json({
      success: true,
      message: `Taguage terminé: ${taggedCount} tweets tagués, ${excludedCount} exclus`,
      data: {
        taggedCount,
        excludedCount,
        totalProcessed: tweets.length,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('❌ Erreur dans POST /api/progressive-recommendations/tag-all-tweets:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du taguage des tweets',
      details: error.message
    });
  }
});

module.exports = router;
