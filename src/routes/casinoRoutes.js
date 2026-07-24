const express = require('express');
const { body, query } = require('express-validator');
const CasinoController = require('../controllers/casinoController');
const { authenticateToken } = require('../middleware/authMiddleware');
const {
  CASINO_MIN_BET_TWC,
  CASINO_MIN_WIN_CHANCE,
  CASINO_MAX_WIN_CHANCE
} = require('../economy/constants');
const router = express.Router();

router.use(authenticateToken);

/**
 * @route GET /api/casino/config
 * @desc Paramètres du casino (avantage maison, bornes de mise/chance)
 */
router.get('/config', CasinoController.getConfig);

/**
 * @route POST /api/casino/dice
 * @desc Joue un pari "dés" : mise + chance de gain choisie -> gagné/perdu
 */
router.post('/dice', [
  body('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  body('amount').isFloat({ min: CASINO_MIN_BET_TWC }).withMessage('Mise invalide'),
  body('winChance').isFloat({ min: CASINO_MIN_WIN_CHANCE, max: CASINO_MAX_WIN_CHANCE }).withMessage('Chance de gain invalide')
], CasinoController.playDice);

router.post('/wheel', [
  body('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  body('amount').isFloat({ min: CASINO_MIN_BET_TWC }).withMessage('Mise invalide'),
  body('mode').optional().isIn(['classic', 'boost', 'jackpot']).withMessage('Mode casino invalide')
], CasinoController.playWheel);

/**
 * @route POST /api/casino/coinflip
 * @desc Pile ou face : petit profit frequent, tres peu risque (mise rendue sur "tranche")
 */
router.post('/coinflip', [
  body('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  body('amount').isFloat({ min: CASINO_MIN_BET_TWC }).withMessage('Mise invalide'),
  body('choice').optional().isIn(['pile', 'face']).withMessage('Choix invalide')
], CasinoController.playCoinflip);

/**
 * @route POST /api/casino/slots
 * @desc Machine a sous : tres difficile a gagner, jackpot enorme si alignement
 */
router.post('/slots', [
  body('currencyId').isUUID().withMessage('ID de cryptomonnaie invalide'),
  body('amount').isFloat({ min: CASINO_MIN_BET_TWC }).withMessage('Mise invalide')
], CasinoController.playSlots);

/**
 * @route GET /api/casino/history
 * @desc Historique des paris de l'utilisateur
 */
router.get('/history', [
  query('limit').optional().isInt({ min: 1, max: 100 })
], CasinoController.getHistory);

module.exports = router;
