/**
 * Routes pour gérer les styles de vérification
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');

/**
 * GET /api/verification-style/user/:userId
 * Récupérer le style de vérification d'un utilisateur
 */
router.get('/user/:userId', authenticateToken, async (req, res) => {
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

    const VerificationStyleService = require('../services/verificationStyleService');
    const style = await VerificationStyleService.getUserVerificationStyle(userId);

    res.json({
      success: true,
      data: { style },
      message: 'Style de vérification récupéré avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération du style de vérification:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du style de vérification',
      error: error.message
    });
  }
});

/**
 * POST /api/verification-style/user/:userId/change
 * Changer le style de vérification d'un utilisateur
 */
router.post('/user/:userId/change', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { style } = req.body;
    const currentUserId = req.user.id;

    // Vérifier que l'utilisateur peut changer son style
    if (userId !== currentUserId) {
      return res.status(403).json({
        success: false,
        message: 'Vous ne pouvez changer que votre propre style de vérification'
      });
    }

    if (!style || !['default', 'rose', 'gray', 'gold'].includes(style)) {
      return res.status(400).json({
        success: false,
        message: 'Style invalide. Utilisez "default", "rose", "gray" ou "gold"'
      });
    }

    const VerificationStyleService = require('../services/verificationStyleService');
    const success = await VerificationStyleService.changeUserVerificationStyle(userId, style);

    if (success) {
      res.json({
        success: true,
        message: 'Style de vérification changé avec succès'
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Impossible de changer le style de vérification'
      });
    }
  } catch (error) {
    logger.error('Erreur lors du changement de style de vérification:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du changement de style de vérification',
      error: error.message
    });
  }
});

/**
 * GET /api/verification-style/user/:userId/can-use/:style
 * Vérifier si un utilisateur peut utiliser un style
 */
router.get('/user/:userId/can-use/:style', authenticateToken, async (req, res) => {
  try {
    const { userId, style } = req.params;
    const currentUserId = req.user.id;

    // Vérifier que l'utilisateur peut vérifier ses permissions
    if (userId !== currentUserId) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé'
      });
    }

    const VerificationStyleService = require('../services/verificationStyleService');
    let canUse = false;

    if (style === 'default') {
      canUse = true;
    } else if (style === 'rose') {
      canUse = await VerificationStyleService.canUseRoseStyle(userId);
    } else if (style === 'gray') {
      canUse = await VerificationStyleService.canUseGrayStyle(userId);
    } else if (style === 'gold') {
      canUse = await VerificationStyleService.canUseGoldStyle(userId);
    }

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
