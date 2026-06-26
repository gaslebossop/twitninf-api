const express = require('express');
const router = express.Router();
const MonetizationController = require('../controllers/monetizationController');
const authMiddleware = require('../middleware/authMiddleware');

// Appliquer l'authentification à toutes les routes
router.use(authMiddleware.authenticateToken);

// Routes pour la monétisation

/**
 * @route GET /api/monetization/eligible-tweets
 * @desc Obtenir les tweets éligibles à la monétisation
 * @access Private
 */
router.get('/eligible-tweets', MonetizationController.getEligibleTweets);

/**
 * @route GET /api/monetization/revenue
 * @desc Obtenir les revenus totaux d'un utilisateur
 * @access Private
 */
router.get('/revenue', MonetizationController.getUserRevenue);

/**
 * @route GET /api/monetization/stats
 * @desc Obtenir les statistiques de monétisation globales
 * @access Private
 */
router.get('/stats', MonetizationController.getMonetizationStats);

/**
 * @route PUT /api/monetization/tweets/:tweetId/metrics
 * @desc Mettre à jour les métriques de monétisation d'un tweet
 * @access Private
 */
router.put('/tweets/:tweetId/metrics', MonetizationController.updateTweetMetrics);

/**
 * @route POST /api/monetization/tweets/:tweetId/simulate
 * @desc Simuler l'engagement pour les tests
 * @access Private
 */
router.post('/tweets/:tweetId/simulate', MonetizationController.simulateEngagement);

module.exports = router;
