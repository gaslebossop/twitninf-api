/**
 * Routes pour gérer les styles de badges vérifiés
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');

/**
 * GET /api/verified-badges/user/:userId/style
 * Récupérer le style de badge actuel d'un utilisateur
 */
router.get('/user/:userId/style', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.id;

    // Vérifier que l'utilisateur peut voir ce style (soi-même ou admin)
    if (userId !== currentUserId && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé'
      });
    }

    const VerifiedBadgeService = require('../services/verifiedBadgeService');
    const badgeStyle = await VerifiedBadgeService.getUserBadgeStyle(userId);

    res.json({
      success: true,
      data: badgeStyle,
      message: 'Style de badge récupéré avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération du style de badge:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du style de badge',
      error: error.message
    });
  }
});

/**
 * POST /api/verified-badges/user/:userId/change-style
 * Changer le style de badge d'un utilisateur
 */
router.post('/user/:userId/change-style', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { styleId } = req.body;
    const currentUserId = req.user.id;

    // Vérifier que l'utilisateur peut changer son style
    if (userId !== currentUserId) {
      return res.status(403).json({
        success: false,
        message: 'Vous ne pouvez changer que votre propre style de badge'
      });
    }

    if (!styleId) {
      return res.status(400).json({
        success: false,
        message: 'ID du style requis'
      });
    }

    const VerifiedBadgeService = require('../services/verifiedBadgeService');
    const success = await VerifiedBadgeService.changeUserBadgeStyle(userId, styleId);

    if (success) {
      res.json({
        success: true,
        message: 'Style de badge changé avec succès'
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Impossible de changer le style de badge'
      });
    }
  } catch (error) {
    logger.error('Erreur lors du changement de style de badge:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du changement de style de badge',
      error: error.message
    });
  }
});

/**
 * GET /api/verified-badges/styles
 * Récupérer tous les styles de badges disponibles
 */
router.get('/styles', authenticateToken, async (req, res) => {
  try {
    const VerifiedBadgeService = require('../services/verifiedBadgeService');
    const styles = await VerifiedBadgeService.getAvailableBadgeStyles();

    res.json({
      success: true,
      data: styles,
      message: 'Styles de badges récupérés avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des styles de badges:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des styles de badges',
      error: error.message
    });
  }
});

/**
 * GET /api/verified-badges/user/:userId/can-use/:styleId
 * Vérifier si un utilisateur peut utiliser un style de badge
 */
router.get('/user/:userId/can-use/:styleId', authenticateToken, async (req, res) => {
  try {
    const { userId, styleId } = req.params;
    const currentUserId = req.user.id;

    // Vérifier que l'utilisateur peut vérifier ses permissions
    if (userId !== currentUserId) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé'
      });
    }

    const VerifiedBadgeService = require('../services/verifiedBadgeService');
    const canUse = await VerifiedBadgeService.canUseBadgeStyle(userId, styleId);

    res.json({
      success: true,
      data: { canUse },
      message: 'Permission vérifiée avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la vérification de permission:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification de permission',
      error: error.message
    });
  }
});

module.exports = router;
