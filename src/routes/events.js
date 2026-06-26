/**
 * Routes pour la gestion des événements thématiques
 * Permet la consultation publique et la gestion admin des événements
 */

const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const { authenticateToken, requireAdmin } = require('../middleware/authMiddleware');

// Routes publiques (accessibles à tous les utilisateurs authentifiés)

/**
 * GET /events
 * Récupérer tous les événements
 * Query params: page, limit, active_only, include_inactive
 */
router.get('/', authenticateToken, eventController.getEvents);

/**
 * GET /events/active
 * Récupérer l'événement actuellement actif
 */
router.get('/active', authenticateToken, eventController.getActiveEvent);

/**
 * GET /events/:id
 * Récupérer un événement par ID ou slug
 */
router.get('/:id', authenticateToken, eventController.getEvent);

// Routes d'administration (réservées aux admins)

/**
 * POST /events
 * Créer un nouvel événement
 * Body: { name, slug, description, theme_config, start_date, end_date, auto_activate, icon, colors, effects, priority }
 */
router.post('/', authenticateToken, requireAdmin, eventController.createEvent);

/**
 * PUT /events/:id
 * Modifier un événement existant
 * Body: { name?, slug?, description?, theme_config?, start_date?, end_date?, auto_activate?, icon?, colors?, effects?, priority? }
 */
router.put('/:id', authenticateToken, requireAdmin, eventController.updateEvent);

/**
 * POST /events/:id/activate
 * Activer un événement
 * Body: { deactivate_others? }
 */
router.post('/:id/activate', authenticateToken, requireAdmin, eventController.activateEvent);

/**
 * POST /events/:id/deactivate
 * Désactiver un événement
 */
router.post('/:id/deactivate', authenticateToken, requireAdmin, eventController.deactivateEvent);

/**
 * DELETE /events/:id
 * Supprimer un événement
 */
router.delete('/:id', authenticateToken, requireAdmin, eventController.deleteEvent);

/**
 * POST /events/initialize-defaults
 * Initialiser les événements par défaut
 */
router.post('/initialize-defaults', authenticateToken, requireAdmin, eventController.initializeDefaultEvents);

module.exports = router;
