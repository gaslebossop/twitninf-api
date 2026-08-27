'use strict';

/**
 * 🧪 Routes du programme beta.
 *
 * `/public` est SANS authentification : la vitrine du site web doit pouvoir
 * dire « ouvert, 12 places restantes » à un visiteur qui n'a pas encore de
 * compte. Elle ne renvoie que des compteurs, jamais un pseudo ni une liste.
 *
 * Tout le reste est authentifié, et les routes d'administration passent par
 * `requireAdminRole` comme celles des drapeaux de fonctionnalité.
 */

const express = require('express');
const router = express.Router();

const controller = require('../controllers/betaController');
const {
  authenticateToken,
  requireAdminRole,
} = require('../middleware/authMiddleware');

// ── Vitrine publique ──
router.get('/public', controller.publicProgram);

// ── Compte connecté ──
router.get('/me', authenticateToken, controller.me);
router.post('/apply', authenticateToken, controller.apply);
router.post('/leave', authenticateToken, controller.leave);

// ── Administration ──
router.get('/admin/members', authenticateToken, requireAdminRole, controller.listMembers);
router.get('/admin/stats', authenticateToken, requireAdminRole, controller.stats);
router.get('/admin/settings', authenticateToken, requireAdminRole, controller.getSettings);
router.put('/admin/settings', authenticateToken, requireAdminRole, controller.updateSettings);
router.post('/admin/invite', authenticateToken, requireAdminRole, controller.invite);

// Déclarées APRÈS les routes fixes : `/admin/invite` doit gagner contre
// `/admin/:userId/...` — Express sert la première déclaration qui matche.
router.post('/admin/:userId/approve', authenticateToken, requireAdminRole, controller.approve);
router.post('/admin/:userId/reject', authenticateToken, requireAdminRole, controller.reject);
router.post('/admin/:userId/revoke', authenticateToken, requireAdminRole, controller.revoke);

module.exports = router;
