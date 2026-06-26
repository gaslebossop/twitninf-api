/**
 * 🎯 Routes API Avancées pour le Système Publicitaire
 * 
 * Routes pour le tracking avancé, le scoring, le ciblage prédictif,
 * le A/B testing et les analytics en temps réel
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

// Services
const advancedAdTrackingService = require('../services/advancedAdTrackingService');
const adScoringService = require('../services/adScoringService');
const predictiveTargetingService = require('../services/predictiveTargetingService');
const adABTestingService = require('../services/adABTestingService');
const realTimeAdAnalyticsService = require('../services/realTimeAdAnalyticsService');

/**
 * 📊 Routes de Tracking Avancé
 */

// POST /api/advanced-ads/track-interaction
router.post('/track-interaction', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      advertisement_id,
      interaction_type,
      context = {}
    } = req.body;

    if (!advertisement_id || !interaction_type) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres manquants',
        details: 'advertisement_id et interaction_type sont requis'
      });
    }

    const result = await advancedAdTrackingService.trackAdInteraction(
      advertisement_id,
      userId,
      interaction_type,
      context
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('❌ Erreur lors du tracking avancé:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du tracking',
      details: error.message
    });
  }
});

// GET /api/advanced-ads/performance-metrics/:advertisementId
router.get('/performance-metrics/:advertisementId', authenticateToken, async (req, res) => {
  try {
    const { advertisementId } = req.params;
    const { timeWindow = 24 } = req.query;

    const metrics = advancedAdTrackingService.getAdvertisementPerformanceMetrics(advertisementId);

    res.json({
      success: true,
      data: {
        advertisement_id: advertisementId,
        time_window_hours: parseInt(timeWindow),
        metrics: metrics,
        last_updated: new Date()
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des métriques:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des métriques',
      details: error.message
    });
  }
});

// POST /api/advanced-ads/export-data
router.post('/export-data', authenticateToken, async (req, res) => {
  try {
    const {
      advertisement_id,
      date_range = {}
    } = req.body;

    if (!advertisement_id) {
      return res.status(400).json({
        success: false,
        error: 'advertisement_id requis'
      });
    }

    const exportData = await advancedAdTrackingService.exportPerformanceData(
      advertisement_id,
      date_range
    );

    res.json({
      success: true,
      data: exportData
    });

  } catch (error) {
    logger.error('❌ Erreur lors de l\'export des données:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'export',
      details: error.message
    });
  }
});

/**
 * 🎯 Routes de Scoring Publicitaire
 */

// GET /api/advanced-ads/score/:advertisementId
router.get('/score/:advertisementId', authenticateToken, async (req, res) => {
  try {
    const { advertisementId } = req.params;
    const { timeWindow = 24, forceRefresh = false } = req.query;

    const score = await adScoringService.getAdScore(
      advertisementId,
      forceRefresh === 'true'
    );

    res.json({
      success: true,
      data: score
    });

  } catch (error) {
    logger.error('❌ Erreur lors du calcul du score:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du calcul du score',
      details: error.message
    });
  }
});

// GET /api/advanced-ads/scores/all
router.get('/scores/all', authenticateToken, async (req, res) => {
  try {
    const scores = await adScoringService.getAllActiveAdScores();

    res.json({
      success: true,
      data: {
        scores: scores,
        total_count: scores.length,
        last_updated: new Date()
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des scores:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des scores',
      details: error.message
    });
  }
});

/**
 * 🧠 Routes de Ciblage Prédictif
 */

// POST /api/advanced-ads/predict-performance
router.post('/predict-performance', authenticateToken, async (req, res) => {
  try {
    const {
      advertisement_id,
      user_id
    } = req.body;

    if (!advertisement_id || !user_id) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres manquants',
        details: 'advertisement_id et user_id sont requis'
      });
    }

    const prediction = await predictiveTargetingService.predictAdPerformance(
      advertisement_id,
      user_id
    );

    res.json({
      success: true,
      data: prediction
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la prédiction:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la prédiction',
      details: error.message
    });
  }
});

// GET /api/advanced-ads/top-predictions/:advertisementId
router.get('/top-predictions/:advertisementId', authenticateToken, async (req, res) => {
  try {
    const { advertisementId } = req.params;
    const { limit = 100 } = req.query;

    const predictions = await predictiveTargetingService.getTopPredictions(
      advertisementId,
      parseInt(limit)
    );

    res.json({
      success: true,
      data: {
        advertisement_id: advertisementId,
        predictions: predictions,
        total_count: predictions.length,
        last_updated: new Date()
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des prédictions:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des prédictions',
      details: error.message
    });
  }
});

/**
 * 🧪 Routes de A/B Testing
 */

// POST /api/advanced-ads/ab-test/create
router.post('/ab-test/create', authenticateToken, async (req, res) => {
  try {
    const testConfig = req.body;

    const test = await adABTestingService.createABTest(testConfig);

    res.json({
      success: true,
      data: test
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la création du test A/B:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la création du test A/B',
      details: error.message
    });
  }
});

// POST /api/advanced-ads/ab-test/:testId/assign-user
router.post('/ab-test/:testId/assign-user', authenticateToken, async (req, res) => {
  try {
    const { testId } = req.params;
    const userId = req.user.id;

    const assignment = await adABTestingService.assignUserToVariant(testId, userId);

    res.json({
      success: true,
      data: assignment
    });

  } catch (error) {
    logger.error('❌ Erreur lors de l\'assignation:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'assignation',
      details: error.message
    });
  }
});

// POST /api/advanced-ads/ab-test/:testId/record-interaction
router.post('/ab-test/:testId/record-interaction', authenticateToken, async (req, res) => {
  try {
    const { testId } = req.params;
    const userId = req.user.id;
    const {
      interaction_type,
      context = {}
    } = req.body;

    if (!interaction_type) {
      return res.status(400).json({
        success: false,
        error: 'interaction_type requis'
      });
    }

    const result = await adABTestingService.recordTestInteraction(
      testId,
      userId,
      interaction_type,
      context
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('❌ Erreur lors de l\'enregistrement de l\'interaction:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'enregistrement',
      details: error.message
    });
  }
});

// GET /api/advanced-ads/ab-test/:testId/analyze
router.get('/ab-test/:testId/analyze', authenticateToken, async (req, res) => {
  try {
    const { testId } = req.params;

    const analysis = await adABTestingService.analyzeTestResults(testId);

    res.json({
      success: true,
      data: analysis
    });

  } catch (error) {
    logger.error('❌ Erreur lors de l\'analyse du test:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'analyse',
      details: error.message
    });
  }
});

// POST /api/advanced-ads/ab-test/:testId/finalize
router.post('/ab-test/:testId/finalize', authenticateToken, async (req, res) => {
  try {
    const { testId } = req.params;
    const { action = 'implement_winner' } = req.body;

    const result = await adABTestingService.finalizeTest(testId, action);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la finalisation du test:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la finalisation',
      details: error.message
    });
  }
});

// GET /api/advanced-ads/ab-tests/active
router.get('/ab-tests/active', authenticateToken, async (req, res) => {
  try {
    const activeTests = adABTestingService.getActiveTests();

    res.json({
      success: true,
      data: {
        active_tests: activeTests,
        total_count: activeTests.length
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des tests actifs:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des tests',
      details: error.message
    });
  }
});

// GET /api/advanced-ads/ab-tests/history
router.get('/ab-tests/history', authenticateToken, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const history = adABTestingService.getTestHistory(parseInt(limit));

    res.json({
      success: true,
      data: {
        test_history: history,
        total_count: history.length
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération de l\'historique:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération de l\'historique',
      details: error.message
    });
  }
});

/**
 * 📊 Routes d'Analytics en Temps Réel
 */

// GET /api/advanced-ads/analytics/:advertisementId
router.get('/analytics/:advertisementId', authenticateToken, async (req, res) => {
  try {
    const { advertisementId } = req.params;
    const { timeWindow = 24 } = req.query;

    const analytics = await realTimeAdAnalyticsService.getRealTimeAnalytics(
      advertisementId,
      parseInt(timeWindow)
    );

    res.json({
      success: true,
      data: analytics
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des analytics:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des analytics',
      details: error.message
    });
  }
});

// GET /api/advanced-ads/analytics/campaign/:campaignId
router.get('/analytics/campaign/:campaignId', authenticateToken, async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { timeWindow = 24 } = req.query;

    const analytics = await realTimeAdAnalyticsService.getCampaignAnalytics(
      campaignId,
      parseInt(timeWindow)
    );

    res.json({
      success: true,
      data: analytics
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des analytics de campagne:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des analytics de campagne',
      details: error.message
    });
  }
});

// GET /api/advanced-ads/analytics/global/summary
router.get('/analytics/global/summary', authenticateToken, async (req, res) => {
  try {
    const { timeWindow = 24 } = req.query;

    const summary = await realTimeAdAnalyticsService.getGlobalPerformanceSummary(
      parseInt(timeWindow)
    );

    res.json({
      success: true,
      data: summary
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la récupération du résumé global:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération du résumé global',
      details: error.message
    });
  }
});

// POST /api/advanced-ads/analytics/alert-thresholds/:advertisementId
router.post('/analytics/alert-thresholds/:advertisementId', authenticateToken, async (req, res) => {
  try {
    const { advertisementId } = req.params;
    const thresholds = req.body;

    realTimeAdAnalyticsService.setAlertThresholds(advertisementId, thresholds);

    res.json({
      success: true,
      message: 'Seuils d\'alerte configurés avec succès',
      data: {
        advertisement_id: advertisementId,
        thresholds: thresholds
      }
    });

  } catch (error) {
    logger.error('❌ Erreur lors de la configuration des seuils:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la configuration des seuils',
      details: error.message
    });
  }
});

/**
 * 🔧 Routes de Maintenance et Utilitaires
 */

// POST /api/advanced-ads/cleanup-cache
router.post('/cleanup-cache', authenticateToken, async (req, res) => {
  try {
    // Nettoyer les caches de tous les services
    advancedAdTrackingService.cleanupExpiredSessions();
    adScoringService.cleanupExpiredScores();
    predictiveTargetingService.cleanupExpiredPredictions();
    adABTestingService.cleanupExpiredTests();
    realTimeAdAnalyticsService.cleanupExpiredAnalytics();

    res.json({
      success: true,
      message: 'Cache nettoyé avec succès',
      timestamp: new Date()
    });

  } catch (error) {
    logger.error('❌ Erreur lors du nettoyage du cache:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du nettoyage du cache',
      details: error.message
    });
  }
});

// GET /api/advanced-ads/health-check
router.get('/health-check', async (req, res) => {
  try {
    const healthStatus = {
      advanced_tracking: advancedAdTrackingService.initialized,
      scoring_service: adScoringService.initialized,
      predictive_targeting: predictiveTargetingService.initialized,
      ab_testing: adABTestingService.initialized,
      real_time_analytics: realTimeAdAnalyticsService.initialized,
      timestamp: new Date()
    };

    const allHealthy = Object.values(healthStatus).every(status => 
      status === true || status instanceof Date
    );

    res.status(allHealthy ? 200 : 503).json({
      success: allHealthy,
      data: healthStatus
    });

  } catch (error) {
    logger.error('❌ Erreur lors du health check:', error);
    res.status(503).json({
      success: false,
      error: 'Services non disponibles',
      details: error.message
    });
  }
});

module.exports = router;
