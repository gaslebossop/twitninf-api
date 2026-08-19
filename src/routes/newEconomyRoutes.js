const express = require('express');
const { body, param, query } = require('express-validator');
const NewEconomyController = require('../controllers/newEconomyController');
const { authenticateToken } = require('../middleware/authMiddleware');
const router = express.Router();

/**
 * Routes pour le nouveau système économique TwitCoins
 */

// Middleware d'authentification pour toutes les routes
router.use(authenticateToken);

/**
 * Verrou temporaire sur l'achat de monnaie (AUDIT 3.2, 2026-08-19).
 *
 * `paymentMethod` n'était qu'une chaîne choisie par le client, jamais
 * vérifiée contre un paiement réel — aucun SDK Stripe/PayPal n'est installé,
 * et l'app n'étant sur aucun store, il n'y a pas non plus de reçu App
 * Store/Play Store à valider. N'importe quel compte authentifié pouvait donc
 * créditer son solde gratuitement via `mintFromPurchase`.
 *
 * Bloque avant même la validation du corps de la requête, le temps qu'un
 * vrai moyen de paiement soit branché. Retirer uniquement à ce moment-là.
 */
function purchaseLockedUntilRealPayment(req, res) {
  return res.status(503).json({
    success: false,
    message: 'Achat de monnaie temporairement indisponible.',
  });
}

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
router.post('/purchase', purchaseLockedUntilRealPayment, [
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
 * @route GET /api/new-economy/mining/round
 * @desc Obtenir le round de minage ouvert (app Windows)
 * @access Private
 */
router.get('/mining/round', [
  query('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  query('engine').optional().isIn(['cpu', 'gpu']).withMessage('Moteur de minage invalide')
], NewEconomyController.getMiningRound);

/**
 * @route POST /api/new-economy/mining/submit
 * @desc Soumettre un nonce pour le round de minage en cours
 * @access Private
 */
router.post('/mining/submit', [
  body('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  body('roundId').isUUID().withMessage('ID de round invalide'),
  body('nonce').isString().isLength({ min: 1, max: 40 }).withMessage('Nonce invalide')
], NewEconomyController.submitMiningProof);

/**
 * @route POST /api/new-economy/transfer
 * @desc Transférer des TwitCoins à un autre utilisateur (frais 20% vers la trésorerie)
 * @access Private
 */
/**
 * @route GET /api/new-economy/wallets
 * @desc Portefeuilles de l'utilisateur pour toutes les monnaies actives (NF + EUR interne)
 * @access Private
 */
router.get('/wallets', NewEconomyController.getAllWallets);

/**
 * @route POST /api/new-economy/exchange
 * @desc Échanger entre le portefeuille NF et le portefeuille EUR interne (parité fixe), taux réel courant
 * @access Private
 */
router.post('/exchange', [
  body('direction').isIn(['NF_TO_EUR', 'EUR_TO_NF']).withMessage('Sens d\'échange invalide'),
  body('amount').isFloat({ min: 0.00000001 }).withMessage('Montant invalide')
], NewEconomyController.exchangeCurrency);

router.post('/transfer', [
  body('toUserId').isUUID().withMessage('ID utilisateur destinataire invalide'),
  body('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  body('amount').isFloat({ min: 0.00000001 }).withMessage('Montant invalide'),
  // amountCurrency indique l'unité dans laquelle `amount` est exprimé : NF
  // (défaut, comportement historique) ou EUR — dans ce cas le montant est
  // converti en NF au taux réel courant avant l'exécution du virement.
  body('amountCurrency').optional().isIn(['NF', 'EUR']).withMessage('Unité de montant invalide'),
  body('description').optional().isString().withMessage('Description invalide')
], NewEconomyController.transferCoins);

/**
 * @route GET /api/new-economy/stats/:currencyId
 * @desc Obtenir les statistiques économiques
 * @access Private
 */
router.get('/stats/:currencyId', [
  param('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  query('range').optional().isIn(['1h', '24h', '7d', '30d']).withMessage('Intervalle invalide')
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
