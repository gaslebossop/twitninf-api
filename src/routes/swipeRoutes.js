const express = require('express');
const { query, body, validationResult } = require('express-validator');
const router = express.Router();

const { authenticateToken } = require('../middleware/authMiddleware');
const { getSwipeCandidates, recordSwipePass } = require('../services/swipeRecommenderClient');
const logger = require('../utils/logger');

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: errors.array()[0].msg, errors: errors.array() });
  }
  next();
};

/**
 * GET /api/swipe/candidates
 * File de candidats pour l'écran "Swipe or Follow", classée par
 * swipe-recommender. Le service Scala étant appelable et indisponible sont
 * possibles : on répond success:false plutôt qu'une 500 dure, l'écran
 * affiche alors un état vide/retry au lieu de planter.
 */
router.get('/candidates', [
  authenticateToken,
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('limit invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const forceRefresh = req.query.force_refresh === 'true' || req.query.force_refresh === '1';
    const { candidates, cached } = await getSwipeCandidates(req.user.id, { limit, forceRefresh });
    return res.json({ success: true, data: candidates, cached });
  } catch (error) {
    logger.warn(`[Swipe] candidates indisponibles pour ${req.user.id}: ${error.message}`);
    return res.json({ success: false, data: [], message: 'Découverte indisponible pour le moment' });
  }
});

/**
 * POST /api/swipe/pass
 * Enregistre un "pass" (l'utilisateur ne veut pas suivre ce profil). Le
 * follow réel ne passe volontairement pas par cette route : le client
 * appelle directement POST /api/users/:id/follow, qui porte déjà la logique
 * compte privé / hooks de stats / notifications.
 */
router.post('/pass', [
  authenticateToken,
  body('target_user_id').isUUID().withMessage('target_user_id invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    await recordSwipePass(req.user.id, req.body.target_user_id);
    return res.json({ success: true });
  } catch (error) {
    logger.warn(`[Swipe] pass non enregistré pour ${req.user.id}: ${error.message}`);
    // Non bloquant côté client : le profil pourrait réapparaître plus tôt
    // que prévu, ce n'est pas une erreur qui doit interrompre le swipe.
    return res.json({ success: false, message: 'Pass non enregistré' });
  }
});

module.exports = router;
