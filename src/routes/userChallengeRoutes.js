/**
 * Routes pour la gestion des défis d'utilisateur
 * Permet de suivre la progression des défis d'événements fonctionnels
 */

const express = require('express');
const router = express.Router();
const { authenticateToken, requireAdmin } = require('../middleware/authMiddleware');
const { UserChallenge } = require('../models');
const logger = require('../utils/logger');

/**
 * GET /api/user-challenges
 * Récupérer tous les défis d'un utilisateur pour un événement
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { event_slug } = req.query;
    const userId = req.user.id;

    const challenges = await UserChallenge.getUserChallenges(userId, event_slug);

    res.json({
      success: true,
      data: challenges,
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des défis:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des défis',
      error: error.message,
    });
  }
});

/**
 * GET /api/user-challenges/:challengeId
 * Récupérer un défi spécifique d'un utilisateur
 */
router.get('/:challengeId', authenticateToken, async (req, res) => {
  try {
    const { challengeId } = req.params;
    const { event_slug } = req.query;
    const userId = req.user.id;

    if (!event_slug) {
      return res.status(400).json({
        success: false,
        message: 'event_slug est requis',
      });
    }

    const challenge = await UserChallenge.getUserChallenge(userId, challengeId, event_slug);

    if (!challenge) {
      return res.status(404).json({
        success: false,
        message: 'Défi non trouvé',
      });
    }

    res.json({
      success: true,
      data: challenge,
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération du défi:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du défi',
      error: error.message,
    });
  }
});

/**
 * POST /api/user-challenges
 * Créer ou mettre à jour un défi d'utilisateur
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { challenge_id, event_slug, max_progress, metadata = {} } = req.body;
    const userId = req.user.id;

    if (!challenge_id || !event_slug || !max_progress) {
      return res.status(400).json({
        success: false,
        message: 'challenge_id, event_slug et max_progress sont requis',
      });
    }

    const challenge = await UserChallenge.createOrUpdateChallenge(
      userId,
      challenge_id,
      event_slug,
      max_progress,
      metadata
    );

    res.json({
      success: true,
      data: challenge,
    });
  } catch (error) {
    logger.error('Erreur lors de la création/mise à jour du défi:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création/mise à jour du défi',
      error: error.message,
    });
  }
});

/**
 * PUT /api/user-challenges/:challengeId/progress
 * Mettre à jour la progression d'un défi
 */
router.put('/:challengeId/progress', authenticateToken, async (req, res) => {
  try {
    const { challengeId } = req.params;
    const { event_slug, progress } = req.body;
    const userId = req.user.id;

    if (!event_slug || progress === undefined) {
      return res.status(400).json({
        success: false,
        message: 'event_slug et progress sont requis',
      });
    }

    const challenge = await UserChallenge.updateChallengeProgress(
      userId,
      challengeId,
      event_slug,
      progress
    );

    res.json({
      success: true,
      data: challenge,
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour de la progression:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour de la progression',
      error: error.message,
    });
  }
});

/**
 * POST /api/user-challenges/:challengeId/claim
 * Réclamer la récompense d'un défi
 */
router.post('/:challengeId/claim', authenticateToken, async (req, res) => {
  try {
    const { challengeId } = req.params;
    const { event_slug } = req.body;
    const userId = req.user.id;

    if (!event_slug) {
      return res.status(400).json({
        success: false,
        message: 'event_slug est requis',
      });
    }

    const challenge = await UserChallenge.claimChallengeReward(
      userId,
      challengeId,
      event_slug
    );

    res.json({
      success: true,
      data: challenge,
      message: 'Récompense réclamée avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors de la réclamation de la récompense:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur lors de la réclamation de la récompense',
      error: error.message,
    });
  }
});

/**
 * GET /api/user-challenges/stats/:eventSlug
 * Récupérer les statistiques des défis pour un événement
 */
router.get('/stats/:eventSlug', authenticateToken, async (req, res) => {
  try {
    const { eventSlug } = req.params;
    const userId = req.user.id;

    const challenges = await UserChallenge.getUserChallenges(userId, eventSlug);
    
    const stats = {
      total: challenges.length,
      completed: challenges.filter(c => c.completed).length,
      claimed: challenges.filter(c => c.claimed).length,
      in_progress: challenges.filter(c => !c.completed && !c.claimed).length,
      total_rewards: challenges.filter(c => c.claimed).length * 5, // 5 TWC par défi
    };

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques',
      error: error.message,
    });
  }
});

/**
 * POST /api/user-challenges/update-progress/:eventSlug
 * Mettre à jour la progression de tous les défis d'un utilisateur
 */
router.post('/update-progress/:eventSlug', authenticateToken, async (req, res) => {
  try {
    const { eventSlug } = req.params;
    const userId = req.user.id;

    const ChallengeProgressService = require('../services/challengeProgressService');
    const result = await ChallengeProgressService.updateAllChallengesProgress(userId, eventSlug);

    res.json({
      success: true,
      data: result,
      message: 'Progression des défis mise à jour avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour de la progression des défis:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour de la progression des défis',
      error: error.message,
    });
  }
});

/**
 * POST /api/user-challenges/update-likes-progress/:eventSlug
 * Mettre à jour spécifiquement la progression du défi des likes
 */
router.post('/update-likes-progress/:eventSlug', authenticateToken, async (req, res) => {
  try {
    const { eventSlug } = req.params;
    const userId = req.user.id;

    const ChallengeProgressService = require('../services/challengeProgressService');
    const challenge = await ChallengeProgressService.updateLikesProgress(userId, eventSlug);

    res.json({
      success: true,
      data: challenge,
      message: 'Progression des likes mise à jour avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour de la progression des likes:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour de la progression des likes',
      error: error.message,
    });
  }
});

/**
 * POST /api/user-challenges/update-tweets-progress/:eventSlug
 * Mettre à jour spécifiquement la progression du défi des tweets
 */
router.post('/update-tweets-progress/:eventSlug', authenticateToken, async (req, res) => {
  try {
    const { eventSlug } = req.params;
    const userId = req.user.id;

    const ChallengeProgressService = require('../services/challengeProgressService');
    const challenge = await ChallengeProgressService.updateTweetsProgress(userId, eventSlug);

    res.json({
      success: true,
      data: challenge,
      message: 'Progression des tweets mise à jour avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour de la progression des tweets:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour de la progression des tweets',
      error: error.message,
    });
  }
});

/**
 * POST /api/user-challenges/complete-birthday-wish/:eventSlug
 * Marquer le défi "souhaiter bon anniversaire" comme complété
 */
router.post('/complete-birthday-wish/:eventSlug', authenticateToken, async (req, res) => {
  try {
    const { eventSlug } = req.params;
    const userId = req.user.id;

    const ChallengeProgressService = require('../services/challengeProgressService');
    const challenge = await ChallengeProgressService.completeBirthdayWishChallenge(userId, eventSlug);

    res.json({
      success: true,
      data: challenge,
      message: 'Défi "souhaiter bon anniversaire" marqué comme complété',
    });
  } catch (error) {
    logger.error('Erreur lors de la complétion du défi "souhaiter bon anniversaire":', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la complétion du défi "souhaiter bon anniversaire"',
      error: error.message,
    });
  }
});

/**
 * POST /api/user-challenges/initialize/:eventSlug
 * Initialiser les défis par défaut pour un événement
 */
router.post('/initialize/:eventSlug', authenticateToken, async (req, res) => {
  try {
    const { eventSlug } = req.params;
    const userId = req.user.id;

    // Défis par défaut pour l'événement Kospor Birthday
    const defaultChallenges = [
      {
        challenge_id: 'post_tweets',
        max_progress: 5,
        metadata: {
          title: 'Poster 5 tweets',
          description: 'Partagez 5 tweets pour célébrer l\'anniversaire de Kospor',
          reward: '5 TWC',
          icon: 'chatbubbles-outline',
        },
      },
      {
        challenge_id: 'get_likes',
        max_progress: 5,
        metadata: {
          title: 'Obtenir 5 likes',
          description: 'Recevez 5 likes sur vos tweets',
          reward: '5 TWC',
          icon: 'heart-outline',
        },
      },
      {
        challenge_id: 'wish_birthday',
        max_progress: 1,
        metadata: {
          title: 'Souhaiter bon anniversaire',
          description: 'Souhaitez un bon anniversaire à Kospor sur son profil',
          reward: '5 TWC',
          icon: 'gift-outline',
        },
      },
    ];

    const createdChallenges = [];
    for (const challengeData of defaultChallenges) {
      const challenge = await UserChallenge.createOrUpdateChallenge(
        userId,
        challengeData.challenge_id,
        eventSlug,
        challengeData.max_progress,
        challengeData.metadata
      );
      createdChallenges.push(challenge);
    }

    res.json({
      success: true,
      data: createdChallenges,
      message: 'Défis initialisés avec succès',
    });
  } catch (error) {
    logger.error('Erreur lors de l\'initialisation des défis:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'initialisation des défis',
      error: error.message,
    });
  }
});

/**
 * POST /api/user-challenges/claim-special-reward/:eventSlug
 * Réclamer la récompense spéciale (Badge Verifie Rose) pour un événement
 */
router.post('/claim-special-reward/:eventSlug', authenticateToken, async (req, res) => {
  try {
    const { eventSlug } = req.params;
    const userId = req.user.id;

    if (eventSlug !== 'kosporbirthday') {
      return res.status(400).json({
        success: false,
        message: 'Récompense spéciale non disponible pour cet événement',
      });
    }

    const result = await UserChallenge.claimSpecialReward(userId, eventSlug);

    res.json({
      success: true,
      data: result,
      message: result.message,
    });
  } catch (error) {
    logger.error('Erreur lors de la réclamation de la récompense spéciale:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Erreur lors de la réclamation de la récompense spéciale',
      error: error.message,
    });
  }
});

/**
 * GET /api/user-challenges/special-reward-stock/:eventSlug
 * Vérifier le stock disponible pour la récompense spéciale
 */
router.get('/special-reward-stock/:eventSlug', authenticateToken, async (req, res) => {
  try {
    const { eventSlug } = req.params;

    if (eventSlug !== 'kosporbirthday') {
      return res.status(400).json({
        success: false,
        message: 'Récompense spéciale non disponible pour cet événement',
      });
    }

    const VerificationStyleService = require('../services/verificationStyleService');
    const stockInfo = await VerificationStyleService.checkRoseItemStock();

    res.json({
      success: true,
      data: stockInfo,
    });
  } catch (error) {
    logger.error('Erreur lors de la vérification du stock:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification du stock',
      error: error.message,
    });
  }
});

module.exports = router;
