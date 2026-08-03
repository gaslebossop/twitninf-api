const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const {
  authenticateToken,
  requirePremium,
  denySuspended,
} = require('../middleware/authMiddleware');
const market = require('../services/usernameMarketService');
const {
  USERNAME_MIN_PRICE_TWC,
  USERNAME_MAX_PRICE_TWC,
  USERNAME_RESERVATION_PRICE_TWC,
  USERNAME_RESERVATION_DAYS,
  USERNAME_RESERVATION_MAX_PER_USER,
  PLATFORM_USERNAME_FEE_RATE,
} = require('../constants/premiumMarket');
const logger = require('../utils/logger');

/**
 * Marché des pseudos.
 *
 * Qui peut faire quoi :
 * - **consulter** : tout compte connecté (une place de marché vide de badauds
 *   ne vend rien) ;
 * - **vendre et réserver** : abonnés seulement — ce sont les avantages payants ;
 * - **acheter** : tout compte connecté. Réserver l'achat aux abonnés
 *   priverait les vendeurs de l'essentiel de leurs acheteurs.
 */

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0]?.msg || 'Requête invalide',
    });
  }
  next();
}

function fail(res, error, fallback) {
  if (error instanceof market.UsernameMarketError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403 : 400;
    return res.status(status).json({ success: false, message: error.message, code: error.code });
  }
  // Une violation d'unicité sur `username` signifie qu'une course a été perdue
  // : le pseudo vient d'être pris. C'est un cas métier, pas une panne.
  if (String(error?.name || '').includes('UniqueConstraint')) {
    return res.status(409).json({
      success: false,
      message: 'Ce pseudo vient d\'être pris.',
      code: 'race_lost',
    });
  }
  logger.error(`[usernameMarket] ${fallback}:`, error);
  return res.status(500).json({ success: false, message: fallback });
}

/** GET /api/username-market/config */
router.get('/config', authenticateToken, (req, res) => {
  res.json({
    success: true,
    data: {
      min_price_twc: USERNAME_MIN_PRICE_TWC,
      max_price_twc: USERNAME_MAX_PRICE_TWC,
      reservation_price_twc: USERNAME_RESERVATION_PRICE_TWC,
      reservation_days: USERNAME_RESERVATION_DAYS,
      reservation_max_per_user: USERNAME_RESERVATION_MAX_PER_USER,
      platform_fee_rate: PLATFORM_USERNAME_FEE_RATE,
      seller_share_rate: 1 - PLATFORM_USERNAME_FEE_RATE,
    },
  });
});

/** GET /api/username-market/availability/:username */
router.get('/availability/:username', [
  authenticateToken,
  param('username').isLength({ min: 3, max: 30 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await market.availability(req.params.username, { forUserId: req.user.id });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Vérification impossible.');
  }
});

/** GET /api/username-market/listings — la vitrine. */
router.get('/listings', [
  authenticateToken,
  query('search').optional().isString().isLength({ max: 30 }),
  query('min_price').optional().isFloat({ min: 0 }),
  query('max_price').optional().isFloat({ min: 0 }),
  query('sort').optional().isIn(['recent', 'price_asc', 'price_desc', 'short']),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await market.browse({
      search: req.query.search,
      minPrice: req.query.min_price,
      maxPrice: req.query.max_price,
      sort: req.query.sort,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Annonces indisponibles.');
  }
});

/** GET /api/username-market/me — mes annonces, réservations, achats et ventes. */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const data = await market.myMarket(req.user.id);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Marché personnel indisponible.');
  }
});

/** GET /api/username-market/history/:username — historique public des ventes. */
router.get('/history/:username', [
  authenticateToken,
  param('username').isLength({ min: 3, max: 30 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await market.historyOf(req.params.username);
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Historique indisponible.');
  }
});

/**
 * POST /api/username-market/listings
 * Met son pseudo en vente. Le pseudo de remplacement est obligatoire ici,
 * et pas à l'achat : voir l'en-tête du service.
 */
router.post('/listings', [
  authenticateToken,
  denySuspended,
  requirePremium,
  body('price_twc').isFloat({ min: USERNAME_MIN_PRICE_TWC, max: USERNAME_MAX_PRICE_TWC })
    .withMessage(`Le prix doit être entre ${USERNAME_MIN_PRICE_TWC} et ${USERNAME_MAX_PRICE_TWC} NF`),
  body('replacement_username').isLength({ min: 3, max: 30 })
    .withMessage('Choisis le pseudo que tu porteras après la vente'),
  handleValidationErrors,
], async (req, res) => {
  try {
    const listing = await market.createListing({
      sellerId: req.user.id,
      priceTwc: req.body.price_twc,
      replacementUsername: req.body.replacement_username,
    });
    res.status(201).json({
      success: true,
      message: 'Pseudo mis en vente',
      data: {
        id: listing.id,
        username: listing.username,
        replacement_username: listing.replacement_username,
        price_twc: Number(listing.price_twc),
      },
    });
  } catch (error) {
    fail(res, error, 'Mise en vente impossible.');
  }
});

/** DELETE /api/username-market/listings/:id — retire l'annonce. */
router.delete('/listings/:id', [
  authenticateToken,
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    await market.cancelListing({ sellerId: req.user.id, listingId: req.params.id });
    res.json({ success: true, message: 'Annonce retirée' });
  } catch (error) {
    fail(res, error, 'Retrait impossible.');
  }
});

/** POST /api/username-market/listings/:id/buy — l'échange. */
router.post('/listings/:id/buy', [
  authenticateToken,
  denySuspended,
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const result = await market.buyListing({ buyerId: req.user.id, listingId: req.params.id });
    res.json({
      success: true,
      message: `Tu es maintenant @${result.soldUsername}`,
      data: {
        sale_id: result.sale.id,
        username: result.soldUsername,
        previous_username: result.buyerPrevious,
        price_twc: result.price,
      },
    });
  } catch (error) {
    fail(res, error, 'Achat impossible.');
  }
});

/** POST /api/username-market/reservations — retient un pseudo libre. */
router.post('/reservations', [
  authenticateToken,
  denySuspended,
  requirePremium,
  body('username').isLength({ min: 3, max: 30 }).withMessage('Pseudo invalide'),
  handleValidationErrors,
], async (req, res) => {
  try {
    const reservation = await market.reserve({
      userId: req.user.id,
      username: req.body.username,
    });
    res.status(201).json({
      success: true,
      message: 'Pseudo réservé',
      data: { id: reservation.id, username: reservation.username, expires_at: reservation.expires_at },
    });
  } catch (error) {
    fail(res, error, 'Réservation impossible.');
  }
});

/**
 * POST /api/username-market/claim
 * Prend un pseudo réservé (ou libre) comme identité.
 *
 * Réservé aux abonnés : c'est le changement de pseudo lui-même qui est
 * l'avantage payant, la réservation n'en étant que la mise de côté.
 */
router.post('/claim', [
  authenticateToken,
  denySuspended,
  requirePremium,
  body('username').isLength({ min: 3, max: 30 }).withMessage('Pseudo invalide'),
  handleValidationErrors,
], async (req, res) => {
  try {
    const result = await market.claim({ userId: req.user.id, username: req.body.username });
    res.json({
      success: true,
      message: `Tu es maintenant @${result.username}`,
      data: result,
    });
  } catch (error) {
    fail(res, error, 'Changement de pseudo impossible.');
  }
});

module.exports = router;
