/**
 * Routes pour gérer l'inventaire des utilisateurs
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');

/**
 * GET /api/inventory/user/:userId
 * Récupérer l'inventaire d'un utilisateur
 */
router.get('/user/:userId', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.id;

    // Vérifier que l'utilisateur peut voir cet inventaire (soi-même ou admin)
    if (userId !== currentUserId && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé'
      });
    }

    const InventoryService = require('../services/inventoryService');
    const inventory = await InventoryService.getUserInventory(userId);

    res.json({
      success: true,
      data: inventory,
      message: 'Inventaire récupéré avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'inventaire:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de l\'inventaire',
      error: error.message
    });
  }
});

/**
 * GET /api/inventory/user/:userId/has-item/:itemName
 * Vérifier si un utilisateur possède un item
 */
router.get('/user/:userId/has-item/:itemName', authenticateToken, async (req, res) => {
  try {
    const { userId, itemName } = req.params;
    const currentUserId = req.user.id;

    // Vérifier que l'utilisateur peut vérifier ses items
    if (userId !== currentUserId) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé'
      });
    }

    const InventoryService = require('../services/inventoryService');
    const hasItem = await InventoryService.userHasItem(userId, itemName);

    res.json({
      success: true,
      data: { hasItem },
      message: 'Vérification de l\'item effectuée avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la vérification de l\'item:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification de l\'item',
      error: error.message
    });
  }
});

/**
 * POST /api/inventory/user/:userId/use-item
 * Utiliser un item
 */
router.post('/user/:userId/use-item', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { itemName, quantity = 1 } = req.body;
    const currentUserId = req.user.id;

    // Vérifier que l'utilisateur peut utiliser ses items
    if (userId !== currentUserId) {
      return res.status(403).json({
        success: false,
        message: 'Vous ne pouvez utiliser que vos propres items'
      });
    }

    if (!itemName) {
      return res.status(400).json({
        success: false,
        message: 'Nom de l\'item requis'
      });
    }

    const InventoryService = require('../services/inventoryService');
    const success = await InventoryService.useItem(userId, itemName, quantity);

    if (success) {
      res.json({
        success: true,
        message: 'Item utilisé avec succès'
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Impossible d\'utiliser cet item (pas assez d\'exemplaires)'
      });
    }
  } catch (error) {
    logger.error('Erreur lors de l\'utilisation de l\'item:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'utilisation de l\'item',
      error: error.message
    });
  }
});

module.exports = router;
