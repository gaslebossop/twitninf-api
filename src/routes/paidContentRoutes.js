const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const {
  authenticateToken,
  requirePro,
  denySuspended,
} = require('../middleware/authMiddleware');
const paidContent = require('../services/paidContentService');
const { PaidContent, ContentPurchase } = require('../models');
const {
  PAID_CONTENT_MIN_PRICE_TWC,
  PAID_CONTENT_MAX_PRICE_TWC,
  PLATFORM_CONTENT_FEE_RATE,
  PAID_CONTENT_PRICE_EDIT_WINDOW_MS,
} = require('../constants/premiumMarket');
const logger = require('../utils/logger');

/**
 * Contenu payant à l'unité.
 *
 * VENDRE est réservé au palier Pro (`requirePro`, qui revalide le palier et
 * l'expiration en base). ACHETER est ouvert à tout le monde, y compris aux
 * comptes gratuits : réserver l'achat aux abonnés priverait les créateurs de
 * la quasi-totalité de leurs acheteurs potentiels, ce qui viderait la
 * fonctionnalité de son intérêt pour ceux qui la paient.
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

/**
 * Erreurs métier attendues (prix hors bornes, contenu d'un tiers, solde
 * insuffisant) : 400 avec le message tel quel, il est écrit pour être lu par
 * l'utilisateur. Le reste part en 500 sans détail.
 */
const EXPECTED = [
  'Prix minimum', 'Prix maximum', 'Contenu introuvable', 'ne t\'appartient pas',
  'Solde insuffisant', 'possèdes déjà', 'auteur de ce contenu', 'plus payant',
  'Verrou introuvable', 'Achat introuvable', 'déjà remboursé', 'Monnaie indisponible',
];

function fail(res, error, fallback) {
  const message = error?.message || '';
  if (EXPECTED.some((needle) => message.includes(needle))) {
    return res.status(400).json({ success: false, message });
  }
  logger.error(`[paidContent] ${fallback}:`, error);
  return res.status(500).json({ success: false, message: fallback });
}

/** GET /api/paid-content/config — bornes et commission, pour l'écran de vente. */
router.get('/config', authenticateToken, (req, res) => {
  res.json({
    success: true,
    data: {
      min_price_twc: PAID_CONTENT_MIN_PRICE_TWC,
      max_price_twc: PAID_CONTENT_MAX_PRICE_TWC,
      platform_fee_rate: PLATFORM_CONTENT_FEE_RATE,
      creator_share_rate: 1 - PLATFORM_CONTENT_FEE_RATE,
      // Délai pendant lequel le prix reste ajustable après la mise en vente.
      price_edit_window_ms: PAID_CONTENT_PRICE_EDIT_WINDOW_MS,
    },
  });
});

/**
 * POST /api/paid-content
 * Verrouille un de ses contenus derrière un prix.
 */
router.post('/', [
  authenticateToken,
  denySuspended,
  requirePro,
  body('content_type').isIn(['tweet', 'story', 'live_replay']).withMessage('Type de contenu invalide'),
  body('content_id').isUUID().withMessage('Contenu invalide'),
  body('price_twc').isFloat({ min: PAID_CONTENT_MIN_PRICE_TWC, max: PAID_CONTENT_MAX_PRICE_TWC })
    .withMessage(`Le prix doit être entre ${PAID_CONTENT_MIN_PRICE_TWC} et ${PAID_CONTENT_MAX_PRICE_TWC} NF`),
  body('preview_text').optional({ nullable: true }).isString().isLength({ max: 280 })
    .withMessage('Aperçu trop long'),
  handleValidationErrors,
], async (req, res) => {
  try {
    const lock = await paidContent.lockContent({
      creatorId: req.user.id,
      contentType: req.body.content_type,
      contentId: req.body.content_id,
      priceTwc: req.body.price_twc,
      previewText: req.body.preview_text,
    });
    res.status(201).json({
      success: true,
      message: 'Contenu mis en vente',
      data: paidContent.publicLockPayload(lock, { hasAccess: true, isCreator: true }),
    });
  } catch (error) {
    fail(res, error, 'Impossible de mettre ce contenu en vente.');
  }
});

/**
 * DELETE /api/paid-content/:id
 * Retire le verrou. Les acheteurs gardent leur accès (voir le service).
 */
router.delete('/:id', [
  authenticateToken,
  param('id').isUUID().withMessage('Verrou invalide'),
  handleValidationErrors,
], async (req, res) => {
  try {
    await paidContent.unlockContent({ creatorId: req.user.id, paidContentId: req.params.id });
    res.json({ success: true, message: 'Contenu redevenu gratuit' });
  } catch (error) {
    fail(res, error, 'Impossible de retirer le verrou.');
  }
});

/**
 * POST /api/paid-content/:id/purchase
 * Achète l'accès. Idempotent par la contrainte d'unicité en base : un second
 * appel ressort en 400 « tu possèdes déjà ce contenu », jamais en double débit.
 */
router.post('/:id/purchase', [
  authenticateToken,
  denySuspended,
  param('id').isUUID().withMessage('Contenu invalide'),
  handleValidationErrors,
], async (req, res) => {
  try {
    const result = await paidContent.purchase({
      buyerId: req.user.id,
      paidContentId: req.params.id,
    });
    res.json({
      success: true,
      message: 'Contenu débloqué',
      data: {
        purchase_id: result.purchase.id,
        content_type: result.lock.content_type,
        content_id: result.lock.content_id,
        price_twc: result.price,
      },
    });
  } catch (error) {
    fail(res, error, 'Achat impossible pour le moment.');
  }
});

/**
 * GET /api/paid-content/state/:type/:id
 * État du verrou pour le lecteur courant — sert au rendu du cadenas.
 */
router.get('/state/:type/:id', [
  authenticateToken,
  param('type').isIn(['tweet', 'story', 'live_replay']),
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const map = await paidContent.accessMapFor({
      viewerId: req.user.id,
      contentType: req.params.type,
      contentIds: [req.params.id],
    });
    const entry = map.get(String(req.params.id));
    if (!entry) return res.json({ success: true, data: null });
    res.json({
      success: true,
      data: paidContent.publicLockPayload(entry.lock, {
        hasAccess: entry.hasAccess,
        isCreator: entry.isCreator,
      }),
    });
  } catch (error) {
    fail(res, error, 'État du contenu indisponible.');
  }
});

/** GET /api/paid-content/sales — tableau de bord du vendeur. */
router.get('/sales', [
  authenticateToken,
  query('limit').optional().isInt({ min: 1, max: 100 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await paidContent.creatorDashboard(req.user.id, { limit: req.query.limit });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Ventes indisponibles.');
  }
});

/** GET /api/paid-content/purchases — bibliothèque de l'acheteur. */
router.get('/purchases', [
  authenticateToken,
  query('limit').optional().isInt({ min: 1, max: 100 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await paidContent.purchaseHistory(req.user.id, { limit: req.query.limit });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'Achats indisponibles.');
  }
});

/**
 * POST /api/paid-content/purchases/:id/refund
 * Remboursement demandé par le VENDEUR (geste commercial, contenu retiré).
 *
 * Volontairement pas ouvert à l'acheteur : un remboursement à la demande sur
 * un contenu déjà lu serait gratuit pour lui et systématique. Les cas subis —
 * contenu supprimé ou modéré — relèvent du staff, qui appelle le même service.
 */
router.post('/purchases/:id/refund', [
  authenticateToken,
  param('id').isUUID(),
  body('reason').optional({ nullable: true }).isString().isLength({ max: 160 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const record = await ContentPurchase.findByPk(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Achat introuvable' });
    }
    if (String(record.creator_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Cette vente n\'est pas la tienne' });
    }
    await paidContent.refundPurchase({ purchaseId: record.id, reason: req.body?.reason });
    res.json({ success: true, message: 'Acheteur remboursé' });
  } catch (error) {
    fail(res, error, 'Remboursement impossible.');
  }
});

/**
 * GET /api/paid-content/:id/buyers
 * Liste des acheteurs d'un contenu, réservée à son auteur.
 */
router.get('/:id/buyers', [
  authenticateToken,
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const lock = await PaidContent.findByPk(req.params.id);
    if (!lock) return res.status(404).json({ success: false, message: 'Contenu introuvable' });
    if (String(lock.creator_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Ce contenu ne t\'appartient pas' });
    }
    const { User } = require('../models');
    const rows = await ContentPurchase.findAll({
      where: { paid_content_id: lock.id },
      include: [{ model: User, as: 'buyer', attributes: ['id', 'username', 'full_name', 'avatar', 'verified'] }],
      order: [['created_at', 'DESC']],
      limit: 100,
    });
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        price_twc: Number(r.price_twc),
        refunded: Boolean(r.refunded_at),
        created_at: r.created_at,
        buyer: r.buyer,
      })),
    });
  } catch (error) {
    fail(res, error, 'Acheteurs indisponibles.');
  }
});

module.exports = router;
