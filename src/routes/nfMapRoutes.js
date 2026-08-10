'use strict';

/**
 * Routes de la Carte NF.
 *
 * Tout est derrière `requireFlag('fil.cartenf')` — y compris la lecture de ses
 * propres réglages. Tant que le palier n'est pas ouvert pour un compte, la
 * fonctionnalité n'existe pas pour lui, et l'API répond 404 plutôt que de
 * laisser deviner qu'une carte se prépare.
 */

const express = require('express');
const router = express.Router();

const { sequelize } = require('../models');
const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const { requireFlag } = require('../middleware/featureFlagMiddleware');
const nfMap = require('../services/nfMapService');
const logger = require('../utils/logger');

const guard = [authenticateToken, requireFlag('fil.cartenf')];

/** GET /api/nf-map/me — mes réglages de partage. */
router.get('/me', guard, async (req, res) => {
  try {
    const settings = await nfMap.getSettings(sequelize, req.user.id);
    return res.json({
      success: true,
      data: {
        ...settings,
        // Servi par l'API pour que l'écran n'ait pas à redire les règles :
        // une explication dupliquée dans l'app devient fausse en silence.
        policy: {
          modes: nfMap.SHARING_MODES,
          audiences: nfMap.AUDIENCES,
          ttl_hours: nfMap.PRESENCE_TTL_HOURS,
          city_precision_km: Math.round(nfMap.CITY_GRID_DEGREES * 111),
        },
      },
    });
  } catch (error) {
    logger.error(`[nfMap] getSettings: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Réglages indisponibles' });
  }
});

/** PUT /api/nf-map/me — changer de mode ou de public. */
router.put('/me', [...guard, denySuspended], async (req, res) => {
  try {
    const settings = await nfMap.updateSettings(sequelize, req.user.id, req.body || {});
    logger.info(`[nfMap] ${req.user.username || req.user.id} → mode ${settings.sharing_mode}`);
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/nf-map/position — l'app pousse la position courante.
 *
 * Le mode est relu en base : le client ne décide pas de sa propre précision.
 */
router.post('/position', [...guard, denySuspended], async (req, res) => {
  try {
    const result = await nfMap.updatePosition(sequelize, req.user.id, req.body || {});
    if (!result.stored && result.reason === 'invalid_position') {
      return res.status(400).json({ success: false, message: 'Position invalide' });
    }
    return res.json({ success: true, data: result });
  } catch (error) {
    logger.error(`[nfMap] updatePosition: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Position non enregistrée' });
  }
});

/** DELETE /api/nf-map/position — disparaître tout de suite. */
router.delete('/position', guard, async (req, res) => {
  try {
    await nfMap.clearPresence(sequelize, req.user.id);
    return res.json({ success: true });
  } catch (error) {
    logger.error(`[nfMap] clearPresence: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Effacement impossible' });
  }
});

/** GET /api/nf-map/nearby?north=&south=&east=&west= */
router.get('/nearby', guard, async (req, res) => {
  try {
    const people = await nfMap.nearby(sequelize, req.user.id, req.query);
    return res.json({ success: true, data: { people } });
  } catch (error) {
    // Un rectangle refusé est une erreur d'appel, pas une panne.
    return res.status(400).json({ success: false, message: error.message });
  }
});

module.exports = router;
