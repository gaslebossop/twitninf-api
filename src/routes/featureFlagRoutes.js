'use strict';

/**
 * Routes des drapeaux de fonctionnalité.
 *
 * `/resolve` est en authentification OPTIONNELLE : une fonctionnalité peut
 * concerner l'écran de connexion ou l'accueil hors compte. Sans jeton, seuls
 * les drapeaux tirés sur `device` peuvent s'allumer — l'app envoie déjà son
 * `X-Device-ID`.
 */

const express = require('express');
const router = express.Router();

const controller = require('../controllers/featureFlagController');
const {
  authenticateToken,
  optionalAuthenticateToken,
  requireAdminRole,
} = require('../middleware/authMiddleware');

// ── Client ──
router.get('/resolve', optionalAuthenticateToken, controller.resolve);
router.get('/resolve/:key', optionalAuthenticateToken, controller.resolveOne);

// ── Administration ──
router.get('/admin', authenticateToken, requireAdminRole, controller.list);
router.post('/admin', authenticateToken, requireAdminRole, controller.create);
router.get('/admin/:key', authenticateToken, requireAdminRole, controller.getOne);
router.put('/admin/:key', authenticateToken, requireAdminRole, controller.update);
// Le palier accepte PATCH (verbe juste) et POST : `apiService.patch()` côté
// app mobile envoie en réalité un PUT, donc l'app passe par POST.
router.patch('/admin/:key/rollout', authenticateToken, requireAdminRole, controller.setRollout);
router.post('/admin/:key/rollout', authenticateToken, requireAdminRole, controller.setRollout);
// Montée automatique du palier. Même raison que ci-dessus pour le doublon
// PATCH/POST : l'app mobile ne dispose pas d'un vrai PATCH.
router.patch('/admin/:key/auto-rollout', authenticateToken, requireAdminRole, controller.setAutoRollout);
router.post('/admin/:key/auto-rollout', authenticateToken, requireAdminRole, controller.setAutoRollout);
router.post('/admin/:key/kill', authenticateToken, requireAdminRole, controller.kill);
router.post('/admin/:key/archive', authenticateToken, requireAdminRole, controller.archive);
router.post('/admin/:key/simulate', authenticateToken, requireAdminRole, controller.simulate);
router.get('/admin/:key/exposure', authenticateToken, requireAdminRole, controller.exposure);

module.exports = router;
