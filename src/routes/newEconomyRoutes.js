const express = require('express');
const { body, param } = require('express-validator');
const NewEconomyController = require('../controllers/newEconomyController');
const { authenticateToken } = require('../middleware/authMiddleware');
const router = express.Router();

/**
 * Routes pour le nouveau système économique TwitCoins
 */

// Middleware d'authentification pour toutes les routes
router.use(authenticateToken);

/**
 * @route GET /api/new-economy/packages/:currencyId
 * @desc Obtenir les packages d'achat disponibles
 * @access Private
 */
router.get('/packages/:currencyId', [
  param('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide')
], NewEconomyController.getPurchasePackages);

/**
 * @route POST /api/new-economy/purchase
 * @desc Acheter des TwitCoins
 * @access Private
 */
router.post('/purchase', [
  body('currencyId')
    .isUUID()
    .withMessage('ID de cryptomonnaie invalide'),
  body('packageId')
    .isIn(['small', 'medium', 'large', 'mega', 'ultimate', 'vip_100', 'vip_500', 'vip_1000', 'vip_10000'])
    .withMessage('Package invalide'),
  body('paymentMethod')
    .isIn(['stripe', 'paypal', 'apple_pay', 'google_pay'])
    .withMessage('Méthode de paiement invalide')
], NewEconomyController.purchaseCoins);

/**
 * @route POST /api/new-economy/spend
 * @desc Dépenser des TwitCoins
 * @access Private
 */
router.post('/spend', [
  body('currencyId')
    .isUUID()
    .withMessage('ID de cryptomonnaie invalide'),
  body('amount')
    .isFloat({ min: 0.00000001 })
    .withMessage('Montant invalide'),
  body('itemType')
    .isIn(['boost_visibility', 'super_like', 'badge', 'premium_feature', 'gift'])
    .withMessage('Type d\'objet invalide'),
  body('itemId')
    .optional()
    .isString()
    .withMessage('ID d\'objet invalide'),
  body('description')
    .isLength({ min: 1, max: 500 })
    .withMessage('Description requise (max 500 caractères)')
], NewEconomyController.spendCoins);

/**
 * @route GET /api/new-economy/stats/:currencyId
 * @desc Obtenir les statistiques économiques
 * @access Private
 */
router.get('/stats/:currencyId', [
  param('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide')
], NewEconomyController.getEconomicStats);

/**
 * @route GET /api/new-economy/leaderboard/:currencyId
 * @desc Obtenir le classement des acheteurs
 * @access Private
 */
router.get('/leaderboard/:currencyId', [
  param('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide')
], NewEconomyController.getPurchaseLeaderboard);

/**
 * @route GET /api/new-economy/wallet/:currencyId
 * @desc Obtenir le portefeuille utilisateur
 * @access Private
 */
router.get('/wallet/:currencyId', [
  param('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide')
], NewEconomyController.getUserWallet);

/**
 * @route GET /api/new-economy/transactions/:currencyId
 * @desc Obtenir l'historique des transactions
 * @access Private
 */
router.get('/transactions/:currencyId', [
  param('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide')
], NewEconomyController.getTransactionHistory);

module.exports = router;
