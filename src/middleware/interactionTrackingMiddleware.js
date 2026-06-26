/**
 * 📊 Middleware de Tracking des Interactions - TwitNin Legacy
 * 
 * Middleware pour tracker automatiquement les interactions utilisateur
 * et mettre à jour la viralité des tweets en temps réel.
 * 
 * @author TwitNin Team
 * @version 1.0.0 - Interaction Tracking Middleware
 * @license MIT
 */

const logger = require('../utils/logger');

// Services (initialisation paresseuse)
let ViralityTracker;
let InteractionScoringService;

async function initializeServices() {
  if (!ViralityTracker) {
    ViralityTracker = require('../services/viralityTracker');
  }
  if (!InteractionScoringService) {
    InteractionScoringService = require('../services/interactionScoringService');
  }
}

// Instances des services
let viralityTracker;
let scoringService;

async function getServices() {
  if (!viralityTracker || !scoringService) {
    await initializeServices();
    viralityTracker = new ViralityTracker();
    scoringService = new InteractionScoringService();
  }
  return { viralityTracker, scoringService };
}

/**
 * Middleware pour tracker les interactions sur les tweets
 */
const trackTweetInteractions = async (req, res, next) => {
  try {
    // Vérifier si l'utilisateur est authentifié
    if (!req.user || !req.user.id) {
      return next();
    }

    const userId = req.user.id;
    const method = req.method;
    const path = req.path;
    const tweetId = req.params.id || req.params.tweetId;

    // Déterminer le type d'interaction basé sur la route et la méthode
    let interactionType = null;
    let metadata = {};

    // Extraire les métadonnées de la requête
    metadata = {
      method,
      path,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
      timestamp: new Date().toISOString(),
      platform: req.userPlatform || 'unknown'
    };

    // Ajouter les données du corps de la requête si disponibles
    if (req.body && Object.keys(req.body).length > 0) {
      metadata.requestBody = req.body;
    }

    // Ajouter les paramètres de requête
    if (req.query && Object.keys(req.query).length > 0) {
      metadata.queryParams = req.query;
    }

    // Mapping des routes vers les types d'interaction
    if (path.includes('/tweets') && tweetId) {
      if (method === 'GET') {
        interactionType = 'tweet_view';
      } else if (method === 'POST' && path.includes('/like')) {
        interactionType = 'tweet_like';
      } else if (method === 'DELETE' && path.includes('/like')) {
        interactionType = 'tweet_unlike';
      } else if (method === 'POST' && path.includes('/retweet')) {
        interactionType = 'tweet_retweet';
      } else if (method === 'DELETE' && path.includes('/retweet')) {
        interactionType = 'tweet_unretweet';
      } else if (method === 'POST' && path.includes('/bookmark')) {
        interactionType = 'tweet_bookmark';
      } else if (method === 'POST' && path.includes('/share')) {
        interactionType = 'tweet_share';
      } else if (method === 'POST' && path.includes('/report')) {
        interactionType = 'tweet_report';
      }
    } else if (path.includes('/users') && req.params.userId) {
      if (method === 'GET') {
        interactionType = 'profile_view';
        metadata.targetUserId = req.params.userId;
      } else if (method === 'POST' && path.includes('/follow')) {
        interactionType = 'user_follow';
        metadata.targetUserId = req.params.userId;
      } else if (method === 'DELETE' && path.includes('/follow')) {
        interactionType = 'user_unfollow';
        metadata.targetUserId = req.params.userId;
      } else if (method === 'POST' && path.includes('/block')) {
        interactionType = 'user_block';
        metadata.targetUserId = req.params.userId;
      } else if (method === 'POST' && path.includes('/mute')) {
        interactionType = 'user_mute';
        metadata.targetUserId = req.params.userId;
      }
    } else if (path.includes('/search')) {
      if (method === 'GET') {
        interactionType = 'search_query';
        metadata.searchQuery = req.query.q;
        metadata.searchType = req.query.type || 'all';
      }
    }

    // Si on a identifié une interaction, la tracker
    if (interactionType && tweetId) {
      try {
        const { viralityTracker, scoringService } = await getServices();
        
        // Calculer le score de l'interaction
        const scoreResult = await scoringService.calculateInteractionScore(
          tweetId,
          userId,
          interactionType,
          metadata
        );

        // Enregistrer l'interaction et mettre à jour la viralité
        await viralityTracker.trackInteraction(
          tweetId,
          userId,
          interactionType,
          metadata
        );

        logger.info(`📊 Interaction trackée: ${interactionType} sur tweet ${tweetId} par ${userId} (score: ${scoreResult.finalScore})`);
        
        // Ajouter les informations de tracking à la réponse
        res.locals.interactionTracked = {
          type: interactionType,
          tweetId,
          score: scoreResult.finalScore,
          timestamp: new Date().toISOString()
        };

      } catch (trackingError) {
        // Ne pas faire échouer la requête principale si le tracking échoue
        logger.error('❌ Erreur lors du tracking de l\'interaction:', trackingError);
      }
    }

    next();

  } catch (error) {
    logger.error('❌ Erreur dans le middleware de tracking:', error);
    next(); // Continuer même en cas d'erreur
  }
};

/**
 * Middleware pour tracker les interactions de navigation
 */
const trackNavigationInteractions = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return next();
    }

    const userId = req.user.id;
    const path = req.path;
    const method = req.method;

    // Tracker les interactions de navigation importantes
    let interactionType = null;
    let metadata = {
      method,
      path,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
      timestamp: new Date().toISOString(),
      platform: req.userPlatform || 'unknown'
    };

    // Mapping des routes de navigation
    if (path === '/api/tweets' && method === 'GET') {
      interactionType = 'screen_view';
      metadata.screenName = 'tweets_feed';
    } else if (path.includes('/api/users/') && method === 'GET') {
      interactionType = 'profile_view';
      metadata.targetUserId = req.params.id || req.params.userId;
    } else if (path === '/api/notifications' && method === 'GET') {
      interactionType = 'screen_view';
      metadata.screenName = 'notifications';
    } else if (path === '/api/search' && method === 'GET') {
      interactionType = 'screen_view';
      metadata.screenName = 'search';
    }

    // Tracker l'interaction de navigation
    if (interactionType) {
      try {
        const { viralityTracker } = await getServices();
        
        // Pour les interactions de navigation, on utilise un ID générique
        const navigationId = `nav_${Date.now()}_${userId}`;
        
        await viralityTracker.trackInteraction(
          navigationId,
          userId,
          interactionType,
          metadata
        );

        logger.info(`📱 Navigation trackée: ${interactionType} par ${userId}`);
        
      } catch (trackingError) {
        logger.error('❌ Erreur lors du tracking de la navigation:', trackingError);
      }
    }

    next();

  } catch (error) {
    logger.error('❌ Erreur dans le middleware de tracking de navigation:', error);
    next();
  }
};

/**
 * Middleware pour tracker les interactions temporelles
 */
const trackTemporalInteractions = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return next();
    }

    const userId = req.user.id;
    const startTime = Date.now();

    // Intercepter la réponse pour calculer la durée
    const originalSend = res.send;
    res.send = function(data) {
      const duration = Date.now() - startTime;
      
      // Tracker la durée de la requête
      if (duration > 1000) { // Seulement si la requête prend plus d'1 seconde
        try {
          const metadata = {
            duration,
            path: req.path,
            method: req.method,
            statusCode: res.statusCode,
            timestamp: new Date().toISOString()
          };

          // Tracker de manière asynchrone pour ne pas ralentir la réponse
          setImmediate(async () => {
            try {
              const { viralityTracker } = await getServices();
              
              await viralityTracker.trackInteraction(
                `temp_${Date.now()}_${userId}`,
                userId,
                'request_duration',
                metadata
              );
            } catch (error) {
              logger.error('❌ Erreur lors du tracking temporel:', error);
            }
          });
        } catch (error) {
          logger.error('❌ Erreur dans le tracking temporel:', error);
        }
      }

      return originalSend.call(this, data);
    };

    next();

  } catch (error) {
    logger.error('❌ Erreur dans le middleware de tracking temporel:', error);
    next();
  }
};

/**
 * Middleware pour ajouter les informations de tracking à la réponse
 */
const addTrackingInfo = (req, res, next) => {
  // Ajouter les informations de tracking à la réponse si disponibles
  if (res.locals.interactionTracked) {
    res.set('X-Interaction-Tracked', JSON.stringify(res.locals.interactionTracked));
  }
  
  next();
};

module.exports = {
  trackTweetInteractions,
  trackNavigationInteractions,
  trackTemporalInteractions,
  addTrackingInfo
};
