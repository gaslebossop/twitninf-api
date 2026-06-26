const express = require('express');
const { body, query, param } = require('express-validator');
const moderationController = require('../controllers/moderationController');
const { 
  authenticateToken, 
  requireModeratorRole,
  requireAdminRole,
  requireSuperAdminRole,
  requireClasseurRole,
  requirePermission,
  logAuthenticatedRequest,
  updateLastActivity
} = require('../middleware/authMiddleware');
const { checkUserBanReadOnly } = require('../middleware/banMiddleware');

const router = express.Router();

// Middleware d'authentification pour toutes les routes
router.use(authenticateToken, logAuthenticatedRequest, updateLastActivity, checkUserBanReadOnly);

// ===== ROUTES DE SIGNALEMENTS =====

// Créer un signalement (accessible à tous les utilisateurs authentifiés)
router.post('/reports',
  [
    body('target_id').isUUID().withMessage('ID cible invalide'),
    body('target_type').isIn(['tweet', 'user']).withMessage('Type de cible invalide'),
    body('reason').isString().isLength({ min: 1, max: 1000 }).withMessage('Raison requise (1-1000 caractères)'),
    body('severity').optional().isIn(['low', 'medium', 'high', 'critical']).withMessage('Sévérité invalide')
  ],
  moderationController.createReport
);

// Obtenir la liste des signalements (modérateurs uniquement)
router.get('/reports',
  requireModeratorRole,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page doit être un entier positif'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit doit être entre 1 et 1000'),
    query('status').optional().isIn(['pending', 'investigating', 'resolved', 'dismissed', 'all']).withMessage('Status invalide'),
    query('severity').optional().isIn(['low', 'medium', 'high', 'critical', 'all']).withMessage('Sévérité invalide'),
    query('type').optional().isIn(['tweet', 'user', 'all']).withMessage('Type invalide')
  ],
  moderationController.getReports
);

// Mettre à jour le statut d'un signalement (modérateurs uniquement)
router.put('/reports/:reportId',
  requireModeratorRole,
  [
    param('reportId').isUUID().withMessage('ID signalement invalide'),
    body('status').isIn(['pending', 'investigating', 'resolved', 'dismissed']).withMessage('Status invalide'),
    body('moderator_notes').optional().isString().isLength({ max: 1000 }).withMessage('Notes trop longues'),
    body('resolution_action').optional().isIn(['none', 'warn', 'suspend', 'ban', 'delete']).withMessage('Action de résolution invalide'),
    body('resolution_reason').optional().isString().isLength({ max: 500 }).withMessage('Raison de résolution trop longue')
  ],
  moderationController.updateReportStatus
);

// ===== ROUTES DE GESTION DES UTILISATEURS =====

// Obtenir la liste des utilisateurs (avec filtres)
router.get('/users', 
  requireModeratorRole,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page doit être un entier positif'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit doit être entre 1 et 1000'),
    query('status').optional().isIn(['active', 'suspended', 'banned', 'all']).withMessage('Status invalide'),
    query('role').optional().isIn(['user', 'moderator', 'admin', 'superadmin', 'classeurdetweets']).withMessage('Rôle invalide'),
    query('search').optional().isString().withMessage('Recherche doit être une chaîne')
  ],
  moderationController.getUsers
);

// Obtenir les détails d'un utilisateur
router.get('/users/:userId', 
  requireModeratorRole,
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide')
  ],
  moderationController.getUserDetails
);

// Suspendre un utilisateur
router.post('/users/:userId/suspend',
  requirePermission('can_suspend_users'),
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide'),
    body('reason').isString().isLength({ min: 1, max: 500 }).withMessage('Raison requise (1-500 caractères)'),
    body('duration').optional().isInt({ min: 1, max: 8760 }).withMessage('Durée doit être entre 1 et 8760 heures (1 an)'),
    body('moderator_note').optional().isString().isLength({ max: 1000 }).withMessage('Note modérateur trop longue')
  ],
  moderationController.suspendUser
);

// Lever la suspension d'un utilisateur
router.post('/users/:userId/unsuspend',
  requirePermission('can_suspend_users'),
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Raison trop longue')
  ],
  moderationController.unsuspendUser
);

// Bannir un utilisateur
router.post('/users/:userId/ban',
  requirePermission('can_ban_users'),
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide'),
    body('reason').isString().isLength({ min: 1, max: 500 }).withMessage('Raison requise (1-500 caractères)'),
    body('permanent').optional().isBoolean().withMessage('Permanent doit être un booléen'),
    body('moderator_note').optional().isString().isLength({ max: 1000 }).withMessage('Note modérateur trop longue')
  ],
  moderationController.banUser
);

// Débannir un utilisateur
router.post('/users/:userId/unban',
  requirePermission('can_ban_users'),
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Raison trop longue')
  ],
  moderationController.unbanUser
);

// Vérifier un utilisateur
router.post('/users/:userId/verify',
  requirePermission('can_verify_users'),
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Raison trop longue')
  ],
  moderationController.verifyUser
);

// Révoquer la vérification d'un utilisateur
router.post('/users/:userId/unverify',
  requirePermission('can_verify_users'),
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Raison trop longue')
  ],
  moderationController.unverifyUser
);

// ===== ROUTES DE MODÉRATION DE CONTENU =====

// Obtenir la liste des tweets à modérer
router.get('/tweets',
  requireClasseurRole,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page doit être un entier positif'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit doit être entre 1 et 1000'),
    query('status').optional().isIn(['pending', 'approved', 'rejected', 'deleted', 'not_eligible', 'all']).withMessage('Status invalide'),
    query('search').optional().isString().withMessage('Recherche doit être une chaîne')
  ],
  moderationController.getTweetsForModeration
);

// Obtenir les détails d'un tweet
router.get('/tweets/:tweetId',
  requireClasseurRole,
  [
    param('tweetId').isUUID().withMessage('ID tweet invalide')
  ],
  moderationController.getTweetDetails
);

// Approuver un tweet
router.post('/tweets/:tweetId/approve',
  requireClasseurRole,
  [
    param('tweetId').isUUID().withMessage('ID tweet invalide'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Raison trop longue')
  ],
  moderationController.approveTweet
);

// Rejeter un tweet
router.post('/tweets/:tweetId/reject',
  requireClasseurRole,
  [
    param('tweetId').isUUID().withMessage('ID tweet invalide'),
    body('reason').isString().isLength({ min: 1, max: 500 }).withMessage('Raison requise (1-500 caractères)'),
    body('severity').optional().isIn(['low', 'medium', 'high', 'critical']).withMessage('Sévérité invalide')
  ],
  moderationController.rejectTweet
);

// Supprimer un tweet
router.delete('/tweets/:tweetId',
  requirePermission('can_delete_tweets'),
  [
    param('tweetId').isUUID().withMessage('ID tweet invalide'),
    body('reason').isString().isLength({ min: 1, max: 500 }).withMessage('Raison requise (1-500 caractères)'),
    body('notify_user').optional().isBoolean().withMessage('Notify user doit être un booléen')
  ],
  moderationController.deleteTweet
);

// Marquer un tweet comme non éligible aux recommandations
router.post('/tweets/:tweetId/not-eligible',
  requireClasseurRole,
  [
    param('tweetId').isUUID().withMessage('ID tweet invalide'),
    body('reason').isString().isLength({ min: 1, max: 500 }).withMessage('Raison requise (1-500 caractères)')
  ],
  moderationController.markTweetNotEligible
);

// ===== ROUTES DE GESTION DES SIGNALEMENTS =====

// Obtenir la liste des signalements
router.get('/reports',
  requirePermission('can_view_reports'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page doit être un entier positif'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit doit être entre 1 et 1000'),
    query('status').optional().isIn(['pending', 'investigating', 'resolved', 'dismissed']).withMessage('Status invalide'),
    query('type').optional().isIn(['tweet', 'user', 'comment']).withMessage('Type invalide'),
    query('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage('Priorité invalide')
  ],
  moderationController.getReports
);

// Obtenir les détails d'un signalement
router.get('/reports/:reportId',
  requirePermission('can_view_reports'),
  [
    param('reportId').isUUID().withMessage('ID signalement invalide')
  ],
  moderationController.getReportDetails
);

// Mettre à jour le statut d'un signalement
router.put('/reports/:reportId/status',
  requirePermission('can_view_reports'),
  [
    param('reportId').isUUID().withMessage('ID signalement invalide'),
    body('status').isIn(['pending', 'investigating', 'resolved', 'dismissed']).withMessage('Status invalide'),
    body('action_taken').optional().isString().isLength({ max: 500 }).withMessage('Action trop longue'),
    body('moderator_note').optional().isString().isLength({ max: 1000 }).withMessage('Note modérateur trop longue')
  ],
  moderationController.updateReportStatus
);

// ===== ROUTES D'ANALYTICS =====

// Obtenir les statistiques de modération (route simplifiée pour le frontend)
router.get('/stats',
  requirePermission('can_view_analytics'),
  moderationController.getModerationStats
);

// Obtenir les statistiques de modération (route complète)
router.get('/analytics/stats',
  requirePermission('can_view_analytics'),
  [
    query('period').optional().isIn(['day', 'week', 'month', 'year']).withMessage('Période invalide'),
    query('start_date').optional().isISO8601().withMessage('Date de début invalide'),
    query('end_date').optional().isISO8601().withMessage('Date de fin invalide')
  ],
  moderationController.getModerationStats
);

// Obtenir les tendances de modération
router.get('/analytics/trends',
  requirePermission('can_view_analytics'),
  [
    query('metric').isIn(['reports', 'actions', 'users_suspended', 'tweets_deleted']).withMessage('Métrique invalide'),
    query('period').optional().isIn(['day', 'week', 'month']).withMessage('Période invalide'),
    query('days').optional().isInt({ min: 1, max: 365 }).withMessage('Jours doit être entre 1 et 365')
  ],
  moderationController.getModerationTrends
);

// Obtenir les métriques des modérateurs
router.get('/analytics/moderators',
  requirePermission('can_view_analytics'),
  [
    query('period').optional().isIn(['day', 'week', 'month']).withMessage('Période invalide')
  ],
  moderationController.getModeratorMetrics
);

// ===== ROUTES D'HISTORIQUE =====

// Obtenir l'historique des actions de modération
router.get('/history',
  requireModeratorRole,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page doit être un entier positif'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit doit être entre 1 et 1000'),
    query('action_type').optional().isIn(['suspend', 'ban', 'verify', 'delete_tweet', 'approve_tweet', 'reject_tweet']).withMessage('Type d\'action invalide'),
    query('moderator_id').optional().isUUID().withMessage('ID modérateur invalide'),
    query('start_date').optional().isISO8601().withMessage('Date de début invalide'),
    query('end_date').optional().isISO8601().withMessage('Date de fin invalide')
  ],
  moderationController.getModerationHistory
);

// Obtenir l'historique d'un utilisateur spécifique
router.get('/history/user/:userId',
  requireModeratorRole,
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide'),
    query('page').optional().isInt({ min: 1 }).withMessage('Page doit être un entier positif'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit doit être entre 1 et 1000')
  ],
  moderationController.getUserModerationHistory
);

// ===== ROUTES DE GESTION DES MODÉRATEURS (ADMIN SEULEMENT) =====

// Obtenir la liste des modérateurs
router.get('/moderators',
  requireAdminRole,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page doit être un entier positif'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit doit être entre 1 et 1000'),
    query('role').optional().isIn(['moderator', 'admin', 'superadmin', 'classeurdetweets']).withMessage('Rôle invalide')
  ],
  moderationController.getModerators
);

// Promouvoir un utilisateur au rang de modérateur
router.post('/moderators/:userId/promote',
  requirePermission('can_manage_moderators'),
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide'),
    body('role').isIn(['moderator', 'admin', 'classeurdetweets']).withMessage('Rôle invalide'),
    body('permissions').optional().isObject().withMessage('Permissions invalides'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Raison trop longue')
  ],
  moderationController.promoteModerator
);

// Rétrograder un modérateur
router.post('/moderators/:userId/demote',
  requirePermission('can_manage_moderators'),
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide'),
    body('new_role').isIn(['user', 'moderator', 'classeurdetweets']).withMessage('Nouveau rôle invalide'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Raison trop longue')
  ],
  moderationController.demoteModerator
);

// Mettre à jour les permissions d'un modérateur
router.put('/moderators/:userId/permissions',
  requirePermission('can_manage_moderators'),
  [
    param('userId').isUUID().withMessage('ID utilisateur invalide'),
    body('permissions').isObject().withMessage('Permissions invalides'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Raison trop longue')
  ],
  moderationController.updateModeratorPermissions
);

// ===== ROUTES DE CONFIGURATION (SUPER ADMIN SEULEMENT) =====

// Obtenir la configuration de modération
router.get('/config',
  requireSuperAdminRole,
  moderationController.getModerationConfig
);

// Mettre à jour la configuration de modération
router.put('/config',
  requireSuperAdminRole,
  [
    body('auto_moderation').optional().isBoolean().withMessage('Auto modération doit être un booléen'),
    body('report_threshold').optional().isInt({ min: 1, max: 100 }).withMessage('Seuil de signalement invalide'),
    body('suspension_duration').optional().isInt({ min: 1, max: 8760 }).withMessage('Durée de suspension invalide (max 8760 heures)'),
    body('ban_threshold').optional().isInt({ min: 1, max: 10 }).withMessage('Seuil de bannissement invalide')
  ],
  moderationController.updateModerationConfig
);

// ===== ROUTES DE DASHBOARD =====

// Obtenir le dashboard de modération
router.get('/dashboard',
  requireModeratorRole,
  moderationController.getModerationDashboard
);

// Obtenir les alertes de modération
router.get('/alerts',
  requireModeratorRole,
  [
    query('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage('Priorité invalide'),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit doit être entre 1 et 50')
  ],
  moderationController.getModerationAlerts
);

// ===== TICKETS D'UNBAN =====

// Créer un ticket d'unban (accessible aux utilisateurs bannis)
router.post('/unban-tickets',
  [
    body('reason').isString().isLength({ min: 10 }).withMessage('Raison requise (min 10 caractères)')
  ],
  moderationController.createUnbanTicket
);

// Liste des tickets d'unban (Admin seulement)
router.get('/unban-tickets',
  requireAdminRole,
  [
    query('status').optional().isIn(['pending', 'approved', 'rejected', 'all']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  moderationController.getUnbanTickets
);

// Traiter un ticket d'unban (Admin seulement)
router.put('/unban-tickets/:ticketId',
  requireAdminRole,
  [
    param('ticketId').isUUID(),
    body('status').isIn(['approved', 'rejected']),
    body('admin_notes').optional().isString()
  ],
  moderationController.processUnbanTicket
);

module.exports = router;
