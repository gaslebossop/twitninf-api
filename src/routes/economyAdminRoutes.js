const express = require('express');
const router = express.Router();
const EconomyAdminController = require('../controllers/economyAdminController');
const { authenticateToken, requireEconomyRole } = require('../middleware/authMiddleware');

/**
 * Routes d'administration de l'économie
 * Accessibles uniquement aux Gardiens de l'Économie, Admins et SuperAdmins
 */

router.use(authenticateToken);
router.use(requireEconomyRole);

// Statistiques globales
router.get('/stats', EconomyAdminController.getGlobalStats);

// Détection de fraude (scan rétrospectif transferts/minage/casino/achats)
router.get('/fraud-scan', EconomyAdminController.fraudScan);
// Traçage de la circulation des NF depuis un compte suspect (graphe de transferts)
router.get('/fraud-trace/:userId', EconomyAdminController.fraudTrace);
// Retrait de NF frauduleux de l'économie (vers la trésorerie, hors circulation utilisateur)
router.post('/fraud-burn', EconomyAdminController.fraudBurn);

// Gestion des transactions
router.get('/transactions', EconomyAdminController.getTransactions);
router.delete('/transactions/:id', EconomyAdminController.deleteTransaction);

// Gestion des portefeuilles et Rich List
router.get('/wallets/rich-list', EconomyAdminController.getRichList);
router.get('/wallets/search', EconomyAdminController.searchWallets);
router.put('/wallets/balance', EconomyAdminController.updateWalletBalance);

// Verrouillage de portefeuille
router.put('/wallets/lock', EconomyAdminController.toggleWalletLock);

// Transferts manuels
router.post('/transfer', EconomyAdminController.manualTransfer);

module.exports = router;
