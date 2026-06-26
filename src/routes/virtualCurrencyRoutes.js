const express = require('express');
const { body, param, query } = require('express-validator');
const VirtualCurrencyController = require('../controllers/virtualCurrencyController');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// Middleware d'authentification pour toutes les routes
router.use(authMiddleware.authenticateToken);

// Obtenir les informations d'une cryptomonnaie par symbole
router.get('/currency/:symbol', [
  param('symbol').isString().notEmpty().withMessage('Symbole requis')
], VirtualCurrencyController.getCurrencyBySymbol);

// Obtenir le portefeuille de l'utilisateur
router.get('/wallet/:currencyId', [
  param('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide')
], VirtualCurrencyController.getUserWallet);

// Miner de la cryptomonnaie
router.post('/mine', [
  body('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  body('action').isString().notEmpty().withMessage('Action requise'),
  body('amount').optional().isFloat({ min: 0 }).withMessage('Montant invalide')
], VirtualCurrencyController.mineCurrency);

// Transférer de la cryptomonnaie
router.post('/transfer', [
  body('toUserId').isUUID().withMessage('ID utilisateur destinataire invalide'),
  body('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  body('amount').isFloat({ min: 0.00000001 }).withMessage('Montant invalide'),
  body('description').optional().isString().withMessage('Description invalide')
], VirtualCurrencyController.transferCurrency);

// Obtenir l'historique des transactions
router.get('/transactions', [
  query('currencyId').optional().isUUID().withMessage('ID de cryptomonnaie invalide'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limite invalide'),
  query('offset').optional().isInt({ min: 0 }).withMessage('Offset invalide')
], VirtualCurrencyController.getUserTransactions);

// Obtenir le classement des utilisateurs
router.get('/leaderboard/:currencyId', [
  param('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limite invalide')
], VirtualCurrencyController.getLeaderboard);

// Acheter de la cryptomonnaie
router.post('/purchase', [
  body('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  body('amountEur').isFloat({ min: 0.01 }).withMessage('Montant en euros invalide')
], VirtualCurrencyController.purchaseCurrency);

module.exports = router;
