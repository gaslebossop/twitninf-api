/**
 * 📊 Routes de Collecte de Données Comportementales
 * 
 * API endpoints pour collecter et analyser le comportement utilisateur
 */

const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const BehaviorDataCollector = require('../services/behaviorDataCollector');
const { UserBehaviorData, UserPreferences } = require('../models');
const { ultraSafeClean } = require('../utils/circularRefCleaner');
const botDetectionService = require('../services/BotDetectionService');
const { denySuspended } = require('../middleware/authMiddleware');

// Initialiser le collecteur de données
const behaviorCollector = new BehaviorDataCollector();

/**
 * 📝 POST /api/behavior/action
 * Enregistrer une action utilisateur
 */
router.post('/action', 
  authMiddleware.authenticateToken,
  denySuspended,
  [
    body('action_type').isIn([
      'tweet_view', 'tweet_like', 'tweet_unlike', 'tweet_retweet', 'tweet_unretweet',
      'tweet_reply', 'tweet_share', 'tweet_bookmark', 'tweet_report',
      'profile_view', 'hashtag_click', 'link_click', 'media_view',
      'search_query', 'scroll_speed', 'time_spent',
      'scroll_25', 'scroll_50', 'scroll_75', 'tab_change',
      'content_skip', 'content_pause', 'content_replay', 'content_fullscreen',
      'user_follow', 'user_unfollow', 'user_block', 'user_mute',
      'algorithm_change', 'theme_change', 'notification_setting',
      'session_start', 'session_end', 'app_background', 'app_foreground'
    ]).withMessage('Type d\'action invalide'),
    body('target_id').optional().isString(),
    body('target_type').optional().isIn(['tweet', 'user', 'hashtag', 'link', 'search', 'app', 'setting']),
    body('context_data').optional().isObject(),
    body('device_info').optional().isObject()
  ],
  async (req, res) => {
    try {
      // Validation des erreurs
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { action_type, target_id, target_type, context_data, device_info } = req.body;
      const userId = req.user.id;

      // Enregistrer l'action
      const behaviorData = await behaviorCollector.recordUserAction(
        userId,
        action_type,
        target_id,
        target_type,
        context_data || {},
        device_info || {},
        req.ip
      );

      // 🚨 DÉTECTION DE BOT INSTANTANÉE
      botDetectionService.analyzeAndSanction(userId, {
        ip: req.ip,
        deviceId: req.headers['x-device-id']
      }).catch(err => {
        logger.error(`⚠️ [BotDetection] Erreur analyse asynchrone: ${err.message}`);
      });

      logger.info(`📊 Action enregistrée: ${action_type} par utilisateur ${userId}`);

      res.json({
        success: true,
        message: 'Action enregistrée avec succès',
        data: {
          id: behaviorData.id,
          action_type: behaviorData.action_type,
          timestamp: behaviorData.timestamp
        }
      });

    } catch (error) {
      logger.error('❌ Erreur enregistrement action:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'enregistrement de l\'action',
        error: error.message
      });
    }
  }
);

/**
 * 🐦 POST /api/behavior/tweet-interaction
 * Enregistrer une interaction avec un tweet
 */
router.post('/tweet-interaction',
  authMiddleware.authenticateToken,
  denySuspended,
  [
    body('tweet_id').isString().notEmpty().withMessage('ID de tweet requis'),
    body('interaction_type').isIn([
      'tweet_view', 'tweet_like', 'tweet_unlike', 'tweet_retweet',
      'tweet_unretweet', 'tweet_reply', 'tweet_share', 'tweet_bookmark',
      'media_view'
    ]).withMessage('Type d\'interaction invalide'),
    body('context_data').optional().isObject()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweet_id, interaction_type, context_data } = req.body;
      const userId = req.user.id;

      await behaviorCollector.recordTweetInteraction(
        userId,
        tweet_id,
        interaction_type,
        context_data || {},
        req.ip
      );

      // 🚨 DÉTECTION DE BOT INSTANTANÉE
      botDetectionService.analyzeAndSanction(userId, {
        ip: req.ip,
        deviceId: req.headers['x-device-id']
      }).catch(err => {
        logger.error(`⚠️ [BotDetection] Erreur analyse asynchrone: ${err.message}`);
      });

      // 👁️ Incrémenter le compteur de vues à chaque visionnage vidéo
      if (interaction_type === 'media_view' || interaction_type === 'tweet_view') {
        try {
          const { Tweet } = require('../models');
          await Tweet.sequelize.query(
            'UPDATE tweets SET view_count = COALESCE(view_count, 0) + 1 WHERE id = :id',
            { replacements: { id: tweet_id } }
          );
        } catch (viewErr) {
          logger.warn(`⚠️ Impossible d'incrémenter view_count pour ${tweet_id}:`, viewErr.message);
        }
      }

      res.json({
        success: true,
        message: 'Interaction tweet enregistrée avec succès'
      });

    } catch (error) {
      logger.error('❌ Erreur interaction tweet:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'enregistrement de l\'interaction',
        error: error.message
      });
    }
  }
);

/**
 * 🔍 POST /api/behavior/search
 * Enregistrer une recherche utilisateur
 */
router.post('/search',
  authMiddleware.authenticateToken,
  denySuspended,
  [
    body('query').isString().isLength({ min: 1, max: 200 }).withMessage('Requête de recherche invalide'),
    body('results_count').isInt({ min: 0 }).withMessage('Nombre de résultats invalide'),
    body('context_data').optional().isObject()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { query, results_count, context_data } = req.body;
      const userId = req.user.id;

      await behaviorCollector.recordSearchQuery(
        userId,
        query,
        results_count,
        context_data || {},
        req.ip
      );

      res.json({
        success: true,
        message: 'Recherche enregistrée avec succès'
      });

    } catch (error) {
      logger.error('❌ Erreur enregistrement recherche:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'enregistrement de la recherche',
        error: error.message
      });
    }
  }
);

/**
 * ⏱️ POST /api/behavior/engagement
 * Enregistrer l'engagement sur du contenu
 */
router.post('/engagement',
  authMiddleware.authenticateToken,
  denySuspended,
  [
    body('content_id').isString().withMessage('ID de contenu requis'),
    body('content_type').isIn(['tweet', 'profile', 'hashtag', 'search', 'screen']).withMessage('Type de contenu invalide'),
    body('time_spent').isInt({ min: 0 }).withMessage('Temps passé invalide'),
    body('engagement_data').optional().isObject()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { content_id, content_type, time_spent, engagement_data } = req.body;
      const userId = req.user.id;

      await behaviorCollector.recordContentEngagement(
        userId,
        content_id,
        content_type,
        time_spent,
        engagement_data || {},
        req.ip
      );

      res.json({
        success: true,
        message: 'Engagement enregistré avec succès'
      });

    } catch (error) {
      logger.error('❌ Erreur enregistrement engagement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'enregistrement de l\'engagement',
        error: error.message
      });
    }
  }
);

/**
 * 📱 POST /api/behavior/session
 * Enregistrer une session utilisateur
 */
router.post('/session',
  authMiddleware.authenticateToken,
  [
    body('session_data').isObject().withMessage('Données de session requises'),
    body('session_data.app_version').optional().isString(),
    body('session_data.device_type').optional().isString(),
    body('session_data.network_type').optional().isString()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { session_data } = req.body;
      const userId = req.user.id;

      await behaviorCollector.recordUserSession(userId, session_data, req.ip);

      res.json({
        success: true,
        message: 'Session enregistrée avec succès'
      });

    } catch (error) {
      logger.error('❌ Erreur enregistrement session:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'enregistrement de la session',
        error: error.message
      });
    }
  }
);

/**
 * 📊 GET /api/behavior/stats
 * Récupérer les statistiques comportementales de l'utilisateur
 */
router.get('/stats',
  authMiddleware.authenticateToken,
  [
    query('days').optional().isInt({ min: 1, max: 365 }).withMessage('Nombre de jours invalide')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Paramètres invalides',
          errors: errors.array()
        });
      }

      const userId = req.user.id;
      const days = parseInt(req.query.days) || 30;

      const stats = await behaviorCollector.getUserBehaviorStats(userId, days);

      if (!stats) {
        return res.status(404).json({
          success: false,
          message: 'Aucune donnée comportementale trouvée'
        });
      }

      const cleanStats = ultraSafeClean(stats);

      res.json({
        success: true,
        message: 'Statistiques comportementales récupérées',
        data: cleanStats
      });

    } catch (error) {
      logger.error('❌ Erreur récupération stats:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des statistiques',
        error: error.message
      });
    }
  }
);

/**
 * ⚙️ GET /api/behavior/preferences
 * Récupérer les préférences utilisateur
 */
router.get('/preferences',
  authMiddleware.authenticateToken,
  async (req, res) => {
    try {
      const userId = req.user.id;

      let preferences = await UserPreferences.findOne({
        where: { user_id: userId }
      });

      // Créer des préférences par défaut si elles n'existent pas
      if (!preferences) {
        preferences = await UserPreferences.create({ user_id: userId });
      }

      const cleanPreferences = ultraSafeClean(preferences);

      res.json({
        success: true,
        message: 'Préférences récupérées avec succès',
        data: cleanPreferences
      });

    } catch (error) {
      logger.error('❌ Erreur récupération préférences:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des préférences',
        error: error.message
      });
    }
  }
);

/**
 * ⚙️ PUT /api/behavior/preferences
 * Mettre à jour les préférences utilisateur
 */
router.put('/preferences',
  authMiddleware.authenticateToken,
  [
    body('content_preferences').optional().isObject(),
    body('engagement_preferences').optional().isObject(),
    body('temporal_preferences').optional().isObject(),
    body('social_preferences').optional().isObject(),
    body('algorithm_preferences').optional().isObject(),
    body('privacy_settings').optional().isObject()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const userId = req.user.id;
      const updateData = req.body;

      // Enregistrer le changement de préférences comme action
      await behaviorCollector.recordUserAction(
        userId,
        'preference_update',
        null,
        'setting',
        { updated_fields: Object.keys(updateData) }
      );

      // Mettre à jour les préférences
      const [preferences, created] = await UserPreferences.findOrCreate({
        where: { user_id: userId },
        defaults: { user_id: userId, ...updateData }
      });

      if (!created) {
        await preferences.update(updateData);
      }

      const cleanPreferences = ultraSafeClean(preferences);

      res.json({
        success: true,
        message: 'Préférences mises à jour avec succès',
        data: cleanPreferences
      });

    } catch (error) {
      logger.error('❌ Erreur mise à jour préférences:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la mise à jour des préférences',
        error: error.message
      });
    }
  }
);

/**
 * 📈 POST /api/behavior/batch
 * Enregistrer plusieurs actions en batch
 */
router.post('/batch',
  authMiddleware.authenticateToken,
  denySuspended,
  [
    body('actions').isArray({ min: 1, max: 50 }).withMessage('Tableau d\'actions requis (max 50)'),
    body('actions.*.action_type').isString().withMessage('Type d\'action requis'),
    body('actions.*.timestamp').optional().isISO8601().withMessage('Timestamp invalide')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { actions } = req.body;
      const userId = req.user.id;

      const results = [];

      for (const action of actions) {
        try {
          const behaviorData = await behaviorCollector.recordUserAction(
            userId,
            action.action_type,
            action.target_id,
            action.target_type,
            action.context_data || {},
            action.device_info || {},
            req.ip
          );
          results.push({ success: true, id: behaviorData.id });
        } catch (error) {
          results.push({ success: false, error: error.message });
        }
      }

      // 🚨 DÉTECTION DE BOT INSTANTANÉE (après le batch)
      botDetectionService.analyzeAndSanction(userId, {
        ip: req.ip,
        deviceId: req.headers['x-device-id']
      }).catch(err => {
        logger.error(`⚠️ [BotDetection] Erreur analyse asynchrone: ${err.message}`);
      });

      const successCount = results.filter(r => r.success).length;

      res.json({
        success: true,
        message: `${successCount}/${actions.length} actions enregistrées avec succès`,
        data: {
          total: actions.length,
          success: successCount,
          failed: actions.length - successCount,
          results: results
        }
      });

    } catch (error) {
      logger.error('❌ Erreur enregistrement batch:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'enregistrement en batch',
        error: error.message
      });
    }
  }
);

/**
 * 🔍 GET /api/behavior/analytics
 * Analytics avancées pour les admins
 */
router.get('/analytics',
  authMiddleware.requireAdminRole,
  [
    query('start_date').optional().isISO8601().withMessage('Date de début invalide'),
    query('end_date').optional().isISO8601().withMessage('Date de fin invalide'),
    query('user_id').optional().isInt().withMessage('ID utilisateur invalide')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Paramètres invalides',
          errors: errors.array()
        });
      }

      // Analytics globales ou par utilisateur
      const analytics = {
        total_actions: 0,
        active_users: 0,
        top_actions: [],
        engagement_trends: [],
        user_patterns: {}
      };

      // Implémentation des analytics...
      // (Code simplifié pour l'exemple)

      res.json({
        success: true,
        message: 'Analytics récupérées avec succès',
        data: analytics
      });

    } catch (error) {
      logger.error('❌ Erreur récupération analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des analytics',
        error: error.message
      });
    }
  }
);

module.exports = router;
