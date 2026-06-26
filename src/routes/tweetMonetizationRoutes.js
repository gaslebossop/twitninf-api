/**
 * Routes pour la monétisation des tweets
 */

const express = require('express');
const router = express.Router();
const TweetMonetizationController = require('../controllers/tweetMonetizationController');
const { authenticateToken } = require('../middleware/authMiddleware');

// Routes publiques
router.get('/rpm-rates', TweetMonetizationController.getRPMRates);
router.get('/eligibility/:tweetId', TweetMonetizationController.checkEligibility);
router.get('/reward/:tweetId', TweetMonetizationController.calculateReward);
router.get('/stats', TweetMonetizationController.getStats);

// Routes protégées
router.get('/preview', authenticateToken, TweetMonetizationController.previewEarnings);
router.get('/preview-earnings', authenticateToken, TweetMonetizationController.previewEarnings);
router.post('/distribute/:tweetId', authenticateToken, TweetMonetizationController.distributeReward);
router.post('/process-all', authenticateToken, TweetMonetizationController.processEligibleTweets);
router.get('/user/:userId/eligible', authenticateToken, TweetMonetizationController.getUserEligibleTweets);

module.exports = router;
