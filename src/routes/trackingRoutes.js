const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');

/**
 * POST /track
 * Envoie les interactions utilisateur au recommandeur Rust pour CTR tracking
 */
router.post('/', [authenticateToken], async (req, res) => {
  try {
    const { tweet_id, action, dwell_ms, experiment_id, variant_id } = req.body;
    const userId = req.user.id;

    if (!tweet_id || !action) {
      return res.status(400).json({
        success: false,
        message: 'tweet_id et action sont requis'
      });
    }

    // Valider l'action
    const validActions = ['like', 'unlike', 'retweet', 'unretweet', 'comment', 'view', 'bookmark', 'share', 'skip', 'report', 'block', 'profile_view'];
    if (!validActions.includes(action)) {
      return res.status(400).json({
        success: false,
        message: `Action invalide. Doit être l'une de: ${validActions.join(', ')}`
      });
    }

    // Envoyer le tracking au recommandeur Rust
    const rustRecommenderUrl = process.env.RUST_RECOMMENDER_URL || 'http://localhost:3002';
    const internalSecret = process.env.INTERNAL_SECRET || 'changeme-internal-secret';

    try {
      const response = await fetch(`${rustRecommenderUrl}/track`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': internalSecret,
        },
        body: JSON.stringify({
          user_id: userId,
          tweet_id: tweet_id,
          interaction_type: action,
          dwell_ms: dwell_ms || null,
          experiment_id: experiment_id || null,
          variant_id: variant_id || null,
        }),
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        logger.warn(`⚠️ Rust recommender tracking failed: ${response.status}`);
        // Non-blocking: continue même si le Rust recommender échoue
      }

      logger.debug(`📊 Tracking: ${action} sur tweet ${tweet_id} par user ${userId}`);
    } catch (rustError) {
      logger.warn(`⚠️ Erreur connection au Rust recommender: ${rustError.message}`);
      // Non-blocking: on continue même si Rust n'est pas disponible
    }

    res.json({
      success: true,
      message: 'Interaction trackée',
      data: {
        tweet_id,
        action,
        user_id: userId,
      }
    });
  } catch (error) {
    logger.error('Erreur lors du tracking:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du tracking'
    });
  }
});

module.exports = router;
