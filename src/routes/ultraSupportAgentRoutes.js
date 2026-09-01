const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, denySuspended, requireUltra } = require('../middleware/authMiddleware');
const ultraSupportAgentService = require('../services/ultraSupportAgentService');
const logger = require('../utils/logger');

const router = express.Router();

// Chaque message coûte un vrai appel modèle payant : un plafond en mémoire,
// même simple, borne le coût d'un compte qui bouclerait ou serait scripté —
// même patron que `userRateLimit` dans `authMiddleware.js`.
const MAX_MESSAGES_PER_DAY = 200;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const usage = new Map();

function underDailyLimit(userId) {
  const now = Date.now();
  const entry = usage.get(userId) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + WINDOW_MS;
  }
  entry.count += 1;
  usage.set(userId, entry);
  return entry.count <= MAX_MESSAGES_PER_DAY;
}

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

/**
 * POST /api/support/ai-agent/message
 * L'historique est géré côté client (pas de conversation persistée en base) :
 * simple pour une première version, à revoir si la continuité entre
 * sessions devient un vrai besoin.
 */
router.post('/message', [
  authenticateToken,
  denySuspended,
  requireUltra,
  body('message').trim().isLength({ min: 1, max: 4000 }),
  body('history').optional().isArray({ max: 40 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    if (!underDailyLimit(req.user.id)) {
      return res.status(429).json({ success: false, message: `Limite de ${MAX_MESSAGES_PER_DAY} messages/24h atteinte pour l'agent de support.` });
    }

    const { reply, ticketFiled } = await ultraSupportAgentService.handleMessage(
      req.user.id,
      req.body.history || [],
      req.body.message,
    );

    res.json({ success: true, data: { reply, ticket_filed: ticketFiled } });
  } catch (error) {
    logger.error('[ultraSupportAgent] POST /message :', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

module.exports = router;
