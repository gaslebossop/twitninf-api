const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const {
  authenticateToken,
  requirePremium,
  denySuspended,
} = require('../middleware/authMiddleware');
const scheduler = require('../services/scheduledTweetService');
const {
  SCHEDULE_MAX_HORIZON_DAYS,
  SCHEDULE_MAX_PENDING,
} = require('../constants/premiumMarket');
const logger = require('../utils/logger');

/**
 * File de publications programmées — réservée aux abonnés (Plus et Pro).
 *
 * `requirePremium` revalide le palier ET l'expiration en base à chaque appel.
 * Le worker fait la même vérification À LA PUBLICATION, et pas seulement ici :
 * entre le moment où l'on programme et l'échéance, il peut s'écouler deux
 * mois, et l'abonnement peut avoir expiré entre les deux.
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
  if (error instanceof scheduler.ScheduleError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403 : 400;
    return res.status(status).json({ success: false, message: error.message, code: error.code });
  }
  logger.error(`[scheduler] ${fallback}:`, error);
  return res.status(500).json({ success: false, message: fallback });
}

/** GET /api/scheduled-tweets/config — bornes de la file, pour l'écran. */
router.get('/config', authenticateToken, (req, res) => {
  res.json({
    success: true,
    data: {
      max_horizon_days: SCHEDULE_MAX_HORIZON_DAYS,
      max_pending: SCHEDULE_MAX_PENDING,
      modes: ['exact', 'best_time'],
    },
  });
});

/**
 * GET /api/scheduled-tweets/best-hours
 * Créneaux retenus pour le mode « meilleur moment », pour les montrer avant
 * de programmer plutôt qu'après coup.
 */
router.get('/best-hours', authenticateToken, requirePremium, async (req, res) => {
  try {
    const hours = await scheduler.bestHoursFor(req.user.id);
    res.json({
      success: true,
      data: {
        hours,
        // Sans historique suffisant, le mode retombe sur l'heure demandée :
        // l'app doit pouvoir le dire au lieu de promettre une optimisation
        // qui n'aura pas lieu.
        reliable: hours.length > 0,
      },
    });
  } catch (error) {
    fail(res, error, 'Créneaux indisponibles.');
  }
});

/** GET /api/scheduled-tweets — la file du compte. */
router.get('/', [
  authenticateToken,
  requirePremium,
  query('status').optional().isIn(['pending', 'publishing', 'published', 'failed', 'canceled']),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await scheduler.listFor(req.user.id, { status: req.query.status });
    res.json({ success: true, data });
  } catch (error) {
    fail(res, error, 'File indisponible.');
  }
});

/** POST /api/scheduled-tweets — programme une publication. */
router.post('/', [
  authenticateToken,
  denySuspended,
  requirePremium,
  body('content').isString().trim().isLength({ min: 1, max: 1000 })
    .withMessage('Le contenu doit faire entre 1 et 1000 caractères'),
  body('scheduled_for').isISO8601().withMessage('Date de publication invalide'),
  body('mode').optional().isIn(['exact', 'best_time']).withMessage('Mode invalide'),
  body('media').optional().isArray({ max: 4 }).withMessage('4 médias au maximum'),
  body('reply_to_id').optional({ nullable: true }).isUUID().withMessage('Tweet parent invalide'),
  handleValidationErrors,
], async (req, res) => {
  try {
    const row = await scheduler.schedule({
      userId: req.user.id,
      content: req.body.content,
      media: req.body.media,
      replyToId: req.body.reply_to_id,
      mode: req.body.mode,
      scheduledFor: req.body.scheduled_for,
    });
    res.status(201).json({
      success: true,
      message: 'Publication programmée',
      data: scheduler.publicPayload(row),
    });
  } catch (error) {
    fail(res, error, 'Programmation impossible.');
  }
});

/** PATCH /api/scheduled-tweets/:id — modifie une publication encore en attente. */
router.patch('/:id', [
  authenticateToken,
  requirePremium,
  param('id').isUUID(),
  body('content').optional().isString().trim().isLength({ min: 1, max: 1000 }),
  body('scheduled_for').optional().isISO8601(),
  body('mode').optional().isIn(['exact', 'best_time']),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await scheduler.update({
      userId: req.user.id,
      id: req.params.id,
      content: req.body.content,
      scheduledFor: req.body.scheduled_for,
      mode: req.body.mode,
    });
    res.json({ success: true, message: 'Publication mise à jour', data });
  } catch (error) {
    fail(res, error, 'Modification impossible.');
  }
});

/** DELETE /api/scheduled-tweets/:id — annule. */
router.delete('/:id', [
  authenticateToken,
  requirePremium,
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await scheduler.cancel({ userId: req.user.id, id: req.params.id });
    res.json({ success: true, message: 'Publication annulée', data });
  } catch (error) {
    fail(res, error, 'Annulation impossible.');
  }
});

module.exports = router;
