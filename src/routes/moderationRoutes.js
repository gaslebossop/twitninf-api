const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const moderationController = require('../controllers/moderationController');
const raidBotService = require('../services/raidBotService');
const logger = require('../utils/logger');
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
const { CATEGORY_KEYS, isValidCategory } = require('../config/reportCategories');

const router = express.Router();

/**
 * Compatibilité ascendante des signalements.
 *
 * Les clients déjà installés envoient `{ reason, severity }` en texte libre.
 * Ils continuent de fonctionner : le motif libre devient `details` et la
 * catégorie tombe sur `other`. `severity` est ignorée — elle est désormais
 * calculée côté serveur, un signaleur ne fixe plus la gravité de son propre
 * signalement.
 */
function normalizeLegacyReportBody(req, res, next) {
  const b = req.body || {};

  if (!b.category && typeof b.reason === 'string' && b.reason.trim()) {
    b.category = 'other';
    if (!b.details) b.details = b.reason.trim().slice(0, 1000);
  }
  if (b.category && !isValidCategory(b.category)) {
    // Catégorie inconnue (client plus récent que le serveur) : on conserve
    // l'information en clair plutôt que de perdre le signalement.
    b.details = `[${b.category}] ${b.details || ''}`.trim().slice(0, 1000);
    b.category = 'other';
  }
  delete b.severity; // jamais accepté du client
  delete b.priority;

  req.body = b;
  next();
}

// Middleware d'authentification pour toutes les routes
router.use(authenticateToken, logAuthenticatedRequest, updateLastActivity, checkUserBanReadOnly);

// ===== ROUTES DE SIGNALEMENTS =====

// Taxonomie des signalements — servie aux clients pour qu'ils n'embarquent
// pas chacun leur copie des libellés.
router.get('/report-categories', moderationController.getReportCategories);

// Dossier d'enquête complet sur un signalement (modérateurs uniquement) :
// contenu incriminé, annotation LLM, engagement, antécédents du compte visé,
// autres signalements sur la même cible, fiabilité du signaleur.
router.get('/reports/:reportId/context',
  requireModeratorRole,
  [param('reportId').isUUID().withMessage('ID signalement invalide')],
  moderationController.getReportContext
);

// Signalements envoyés par l'utilisateur courant.
router.get('/my-reports', moderationController.getMyReports);

// Créer un signalement (accessible à tous les utilisateurs authentifiés)
//
// `severity` n'est plus acceptée du client : le signaleur pouvait s'attribuer
// « critical » lui-même. Elle est calculée côté serveur à partir de la
// catégorie, de la fiabilité du signaleur et de la convergence.
// `reason` devient facultative (remplacée par `category` + `details`) tout en
// restant acceptée pour ne pas casser les clients non encore mis à jour.
router.post('/reports',
  normalizeLegacyReportBody, // AVANT les validateurs : sinon un ancien client
                            // est rejeté sur `category` avant d'être converti
  [
    body('target_id').isUUID().withMessage('ID cible invalide'),
    body('target_type').isIn(['tweet', 'user', 'comment']).withMessage('Type de cible invalide'),
    body('category').isIn(CATEGORY_KEYS).withMessage('Catégorie de signalement invalide'),
    body('details').optional({ nullable: true }).isString().isLength({ max: 1000 })
      .withMessage('Précision trop longue (1000 caractères maximum)'),
    body('source').optional({ nullable: true }).isIn(['mobile', 'windows', 'web', 'api'])
      .withMessage('Source invalide')
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
    query('type').optional().isIn(['tweet', 'user', 'comment', 'all']).withMessage('Type invalide')
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

router.post('/reports/:reportId/resolve',
  requireModeratorRole,
  [
    param('reportId').isUUID().withMessage('ID signalement invalide'),
    body('action').isIn(['resolve', 'dismiss', 'escalate']).withMessage('Action invalide'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Raison trop longue')
  ],
  moderationController.updateReportStatus
);

/**
 * GET /api/moderation/community-review
 * Audit des sanctions EXÉCUTÉES par la revue communautaire (BÊTA) — le compte
 * accusé et le tweet ne sont plus anonymes ici, réservé aux modérateurs.
 *
 * La revue s'exécute automatiquement (voir communityModerationService.js),
 * sans validation d'un modérateur avant d'agir — cette route sert à ce qu'un
 * modérateur puisse repasser derrière et, au besoin, annuler une sanction
 * (lever la suspension, restaurer le tweet) via les routes existantes
 * `/users/:userId/unsuspend` et la restauration manuelle d'un tweet.
 */
router.get('/community-review',
  requireModeratorRole,
  [
    query('verdict').optional().isIn(['compliant', 'violation', 'all']).withMessage('Verdict invalide'),
    query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('Limit doit être entre 1 et 200'),
  ],
  async (req, res) => {
    try {
      const { CommunityReviewItem, User, Tweet } = require('../models');
      const { Op } = require('sequelize');
      const limit = parseInt(req.query.limit, 10) || 50;
      const where = { status: 'closed' };
      if (req.query.verdict && req.query.verdict !== 'all') where.verdict = req.query.verdict;

      const items = await CommunityReviewItem.findAll({
        where,
        order: [['closed_at', 'DESC']],
        limit,
      });

      const tweetIds = items.map((i) => i.tweet_id);
      const authorIds = items.map((i) => i.author_id);
      const [tweets, authors] = await Promise.all([
        Tweet.findAll({ where: { id: { [Op.in]: tweetIds } }, attributes: ['id', 'content', 'deleted_at'], paranoid: false, raw: true }),
        User.findAll({ where: { id: { [Op.in]: authorIds } }, attributes: ['id', 'username', 'is_suspended'], raw: true }),
      ]);
      const tweetById = new Map(tweets.map((t) => [String(t.id), t]));
      const authorById = new Map(authors.map((u) => [String(u.id), u]));

      res.json({
        success: true,
        data: items.map((item) => ({
          id: item.id,
          verdict: item.verdict,
          sanction: item.sanction,
          votes: { compliant: item.votes_compliant, violation: item.votes_violation },
          closed_at: item.closed_at,
          tweet: {
            id: item.tweet_id,
            content: tweetById.get(String(item.tweet_id))?.content ?? null,
            deleted: !!tweetById.get(String(item.tweet_id))?.deleted_at,
          },
          author: {
            id: item.author_id,
            username: authorById.get(String(item.author_id))?.username ?? null,
            is_suspended: !!authorById.get(String(item.author_id))?.is_suspended,
          },
        })),
      });
    } catch (error) {
      logger.error('[moderation] GET /community-review:', error);
      res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
    }
  }
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
router.get('/tweet-annotations',
  requireAdminRole,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page doit être un entier positif'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit doit être entre 1 et 100'),
    query('status').optional().isIn(['all', 'annotated', 'pending']).withMessage('Statut d’annotation invalide'),
    query('search').optional().isString().isLength({ max: 200 }).withMessage('Recherche invalide')
  ],
  moderationController.getRecentTweetAnnotations
);

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
    body('role').isIn(['moderateur', 'moderator', 'admin', 'superadmin', 'supermoderateur', 'classeurdetweets', 'economiegardien']).withMessage('Role invalide'),
    body('permissions').optional().isObject().withMessage('Permissions invalides'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Raison trop longue')
  ],
  moderationController.promoteModerator
);

router.post('/moderators/:userId/promote-legacy',
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

// ===== ANTI-RAIDBOT =====

// Scanner les raids de bots (Admin seulement)
router.get('/raidbots/scan',
  requireAdminRole,
  [
    query('days').optional().isInt({ min: 1, max: 365 }),
    query('limit').optional().isInt({ min: 1, max: 5000 })
  ],
  async (req, res) => {
    try {
      const result = await raidBotService.scan({
        days: Number(req.query.days) || 30,
        limit: Number(req.query.limit) || 500
      });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Erreur lors du scan anti-raidbot:', error);
      res.status(500).json({ success: false, message: 'Scan indisponible' });
    }
  }
);

// Nettoyer les comptes sélectionnés (Admin seulement).
// Destructif : chaque volet est explicitement demandé par l'appelant.
router.post('/raidbots/purge',
  requireAdminRole,
  [
    body('userIds').isArray({ min: 1 }).withMessage('Sélectionnez au moins un compte'),
    body('userIds.*').isUUID().withMessage('Identifiant de compte invalide'),
    body('reason').isString().isLength({ min: 5 }).withMessage('Motif requis (min 5 caractères)'),
    body('removeLikes').optional().isBoolean(),
    body('removeFollows').optional().isBoolean(),
    body('removeRetweets').optional().isBoolean(),
    body('deleteTweets').optional().isBoolean(),
    body('banAccounts').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
    }
    try {
      const report = await raidBotService.purge(req.body.userIds, req.body, req.user.id);
      res.json({ success: true, data: report });
    } catch (error) {
      const status = error.status || 500;
      logger.error('Erreur lors du nettoyage anti-raidbot:', error);
      res.status(status).json({
        success: false,
        message: status === 500 ? 'Nettoyage impossible' : error.message
      });
    }
  }
);

// Retirer directement les likes de raid sous des tweets ciblés (Admin seulement).
// Contrairement à /purge, ne dépend pas de la liste des comptes suspects :
// un compte n'ayant raidé qu'un seul tweet n'y apparaît jamais mais son like
// doit quand même pouvoir être retiré du tweet visé.
router.post('/raidbots/purge-tweet-likes',
  requireAdminRole,
  [
    body('tweetIds').isArray({ min: 1 }).withMessage('Sélectionnez au moins un tweet'),
    body('tweetIds.*').isUUID().withMessage('Identifiant de tweet invalide')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
    }
    try {
      const report = await raidBotService.purgeRaidLikes(req.body.tweetIds, req.user.id);
      res.json({ success: true, data: report });
    } catch (error) {
      const status = error.status || 500;
      logger.error('Erreur lors du retrait des likes de raid:', error);
      res.status(status).json({
        success: false,
        message: status === 500 ? 'Retrait impossible' : error.message
      });
    }
  }
);

// Retirer directement les retweets de raid sous des tweets ciblés (Admin seulement).
// Même logique que /purge-tweet-likes, côté retweets.
router.post('/raidbots/purge-tweet-retweets',
  requireAdminRole,
  [
    body('tweetIds').isArray({ min: 1 }).withMessage('Sélectionnez au moins un tweet'),
    body('tweetIds.*').isUUID().withMessage('Identifiant de tweet invalide')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
    }
    try {
      const report = await raidBotService.purgeRaidRetweets(req.body.tweetIds, req.user.id);
      res.json({ success: true, data: report });
    } catch (error) {
      const status = error.status || 500;
      logger.error('Erreur lors du retrait des retweets de raid:', error);
      res.status(status).json({
        success: false,
        message: status === 500 ? 'Retrait impossible' : error.message
      });
    }
  }
);

// Retirer directement les abonnements de raid reçus par des comptes ciblés
// (Admin seulement). Même logique que /purge-tweet-likes, côté follow raid.
router.post('/raidbots/purge-account-follows',
  requireAdminRole,
  [
    body('userIds').isArray({ min: 1 }).withMessage('Sélectionnez au moins un compte'),
    body('userIds.*').isUUID().withMessage('Identifiant de compte invalide')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
    }
    try {
      const report = await raidBotService.purgeRaidFollows(req.body.userIds, req.user.id);
      res.json({ success: true, data: report });
    } catch (error) {
      const status = error.status || 500;
      logger.error('Erreur lors du retrait des abonnements de raid:', error);
      res.status(status).json({
        success: false,
        message: status === 500 ? 'Retrait impossible' : error.message
      });
    }
  }
);

// Lister les comptes dont les compteurs affichés (abonnés, abonnements, likes,
// retweets) divergent du graphe réel — typiquement un profil annonçant des
// milliers d'abonnés dont la liste n'en montre qu'une poignée. Lecture pure.
router.get('/raidbots/counter-desync',
  requireAdminRole,
  [
    query('limit').optional().isInt({ min: 1, max: 5000 }),
    query('minGap').optional().isInt({ min: 1 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
    }
    try {
      const result = await raidBotService.scanCounterDesync({
        limit: Number(req.query.limit) || 500,
        minGap: Number(req.query.minGap) || 1
      });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Erreur lors du scan des compteurs désynchronisés:', error);
      res.status(500).json({ success: false, message: 'Scan indisponible' });
    }
  }
);

// Réaligner les compteurs sur le graphe réel (Admin seulement).
// `userIds` vide/absent = tous les comptes désynchronisés. Ne supprime aucun
// abonnement ni like : seuls les compteurs affichés sont réécrits.
router.post('/raidbots/resync-counters',
  requireAdminRole,
  [
    body('userIds').optional().isArray(),
    body('userIds.*').optional().isUUID().withMessage('Identifiant de compte invalide'),
    body('minGap').optional().isInt({ min: 1 }),
    body('dryRun').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
    }
    try {
      const report = await raidBotService.resyncCounters(
        req.body.userIds,
        { minGap: req.body.minGap, dryRun: req.body.dryRun === true },
        req.user.id
      );
      res.json({ success: true, data: report });
    } catch (error) {
      const status = error.status || 500;
      logger.error('Erreur lors du resync des compteurs:', error);
      res.status(status).json({
        success: false,
        message: status === 500 ? 'Resync impossible' : error.message
      });
    }
  }
);

module.exports = router;
