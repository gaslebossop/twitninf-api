/**
 * Routes pour la gestion des événements thématiques
 * Permet la consultation publique et la gestion admin des événements
 */

const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const twEventController = require('../controllers/twEventController');
const { authenticateToken, requireAdmin } = require('../middleware/authMiddleware');

// ─── Système unifié ────────────────────────────────────────────────────────
//
// Ces trois routes remplacent le trio /api/events (couleurs) +
// /api/functional-events (bascules) + /api/user-challenges (quêtes), que rien
// ne reliait qu'un slug recopié à la main. Les anciennes restent servies le
// temps que les appelants migrent.
//
// ⚠️ `/current` est déclarée AVANT `/:id`, sinon le paramètre l'avalerait et
// la route unifiée répondrait « événement introuvable » pour l'id « current ».

/**
 * GET /events/current
 * L'événement en cours et la progression du compte. `event: null` quand il n'y
 * a rien — ce qui est la réponse normale onze mois sur douze.
 */
router.get('/current', authenticateToken, twEventController.getCurrent);

/**
 * POST /events/:slug/quests/:questId/claim
 * Réclame une récompense. Idempotent : la seconde demande est refusée.
 */
router.post(
  '/:slug/quests/:questId/claim',
  authenticateToken,
  twEventController.claimQuest
);

/**
 * POST /events/:slug/quests/:questId/report
 * Signale un geste que seul le client peut constater (une navigation).
 * N'accorde jamais rien : incrémente un compteur que la remise revérifie.
 */
router.post(
  '/:slug/quests/:questId/report',
  authenticateToken,
  twEventController.reportQuestSignal
);

/**
 * GET  /events/:slug/guestbook   lire le livre d'or
 * POST /events/:slug/guestbook   y laisser un mot (un seul par compte)
 *
 * Ecrire valide aussi la quete correspondante : c'est le serveur qui pose le
 * signal, sur un fait constate, pas le mobile.
 */
router.get('/:slug/guestbook', authenticateToken, twEventController.getGuestbook);
router.post('/:slug/guestbook', authenticateToken, twEventController.postGuestbook);

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
