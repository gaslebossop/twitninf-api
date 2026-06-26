/**
 * Routes pour la gestion des événements fonctionnels
 * API endpoints pour les événements fonctionnels
 */

const express = require('express');
const router = express.Router();
const functionalEventController = require('../controllers/functionalEventController');
const { authenticateToken, requireAdmin } = require('../middleware/authMiddleware');

// Routes publiques
router.get('/events', functionalEventController.getEvents);
router.get('/events/active', functionalEventController.getActiveEvents);
router.get('/events/active/:pageName', functionalEventController.getActiveEventsForPage);
router.get('/events/features/:pageName', functionalEventController.getActiveFeaturesForPage);
router.get('/events/check/:pageName/:featureName', functionalEventController.isFeatureActive);
router.get('/events/value/:pageName/:featureName', functionalEventController.getFeatureValue);

// Routes protégées (admin uniquement)
router.get('/events/:id', authenticateToken, requireAdmin, functionalEventController.getEventById);
router.post('/events', authenticateToken, requireAdmin, functionalEventController.createEvent);
router.put('/events/:id', authenticateToken, requireAdmin, functionalEventController.updateEvent);
router.post('/events/:id/activate', authenticateToken, requireAdmin, functionalEventController.activateEvent);
router.post('/events/:id/deactivate', authenticateToken, requireAdmin, functionalEventController.deactivateEvent);
router.delete('/events/:id', authenticateToken, requireAdmin, functionalEventController.deleteEvent);
router.post('/events/initialize-defaults', authenticateToken, requireAdmin, functionalEventController.initializeDefaultEvents);

module.exports = router;
