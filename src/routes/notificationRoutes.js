const express = require('express');
const { param, query, body, validationResult } = require('express-validator');
const router = express.Router();

// Import des modèles et services
const { Notification, User, Tweet } = require('../models');
const { Op } = require('sequelize');
// Utiliser fetch natif de Node.js 18+ (pas besoin d'import)
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');

// Middleware de validation des erreurs
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Données invalides',
      errors: errors.array()
    });
  }
  next();
};

// ========================================
// ROUTES PROTÉGÉES (avec authentification)
// ========================================

/**
 * GET /api/notifications
 * Récupérer les notifications de l'utilisateur connecté
 */
router.get('/', [
  authenticateToken,
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  query('unread_only').optional().isBoolean().withMessage('Le filtre unread_only doit être un booléen'),
  query('type').optional().isIn(['all', 'like', 'retweet', 'reply', 'mention', 'follow', 'unfollow', 'quote', 'system', 'verification', 'premium']).withMessage('Type de notification invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const {
      limit = 20,
      offset = 0,
      unread_only = false,
      type = 'all'
    } = req.query;

    const userId = req.user.id;

    // Construire les options de récupération
    const options = {
      limit: parseInt(limit),
      offset: parseInt(offset),
      unreadOnly: unread_only,
      includeSender: true,
      includeTweet: true
    };

    // Filtrer par type si spécifié
    if (type !== 'all') {
      options.type = type;
    }

    const [notifications, unreadCount, totalCount] = await Promise.all([
      Notification.getUserNotifications(userId, options),
      Notification.countUnreadNotifications(userId),
      Notification.count({
        where: {
          recipient_id: userId,
          ...(type !== 'all' && { type }),
          ...(unread_only && { is_read: false })
        }
      })
    ]);

    res.json({
      success: true,
      message: 'Notifications récupérées avec succès',
      data: {
        notifications,
        unread_count: unreadCount,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + notifications.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/notifications/unread-count
 * Récupérer le nombre de notifications non lues
 */
router.get('/unread-count', [
  authenticateToken,
  handleValidationErrors
], async (req, res) => {
  try {
    const userId = req.user.id;

    const unreadCount = await Notification.countUnreadNotifications(userId);

    res.json({
      success: true,
      message: 'Nombre de notifications non lues récupéré avec succès',
      data: {
        unread_count: unreadCount
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération du nombre de notifications non lues:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/notifications/:id
 * Récupérer une notification spécifique
 */
router.get('/:id', [
  authenticateToken,
  param('id').isUUID().withMessage('ID de notification invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const notification = await Notification.findOne({
      where: {
        id,
        recipient_id: userId
      },
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'profile_customization']
        },
        {
          model: Tweet,
          as: 'tweet',
          attributes: ['id', 'content', 'created_at'],
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'profile_customization']
          }]
        }
      ]
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification non trouvée'
      });
    }

    // Marquer comme lue si ce n'est pas déjà fait
    if (!notification.is_read) {
      await notification.markAsRead();
    }

    res.json({
      success: true,
      message: 'Notification récupérée avec succès',
      data: notification
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération de la notification:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * PUT /api/notifications/:id/read
 * Marquer une notification comme lue
 */
router.put('/:id/read', [
  authenticateToken,
  param('id').isUUID().withMessage('ID de notification invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const notification = await Notification.findOne({
      where: {
        id,
        recipient_id: userId
      }
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification non trouvée'
      });
    }

    await notification.markAsRead();

    res.json({
      success: true,
      message: 'Notification marquée comme lue avec succès',
      data: {
        id: notification.id,
        is_read: notification.is_read,
        read_at: notification.read_at
      }
    });

  } catch (error) {
    logger.error('Erreur lors du marquage de la notification comme lue:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * PUT /api/notifications/read-all
 * Marquer toutes les notifications comme lues
 */
router.put('/read-all', [
  authenticateToken,
  handleValidationErrors
], async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await Notification.markAllAsRead(userId);

    res.json({
      success: true,
      message: 'Toutes les notifications ont été marquées comme lues',
      data: {
        updated_count: result[0]
      }
    });

  } catch (error) {
    logger.error('Erreur lors du marquage de toutes les notifications comme lues:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * DELETE /api/notifications/:id
 * Supprimer une notification
 */
router.delete('/:id', [
  authenticateToken,
  param('id').isUUID().withMessage('ID de notification invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const notification = await Notification.findOne({
      where: {
        id,
        recipient_id: userId
      }
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification non trouvée'
      });
    }

    await notification.destroy();

    logger.info(`Notification supprimée: ${id} par l'utilisateur ${userId}`);

    res.json({
      success: true,
      message: 'Notification supprimée avec succès'
    });

  } catch (error) {
    logger.error('Erreur lors de la suppression de la notification:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * DELETE /api/notifications/clear-all
 * Supprimer toutes les notifications de l'utilisateur
 */
router.delete('/clear-all', [
  authenticateToken,
  query('type').optional().isIn(['all', 'read', 'unread']).withMessage('Type de suppression invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { type = 'all' } = req.query;
    const userId = req.user.id;

    let whereClause = { recipient_id: userId };

    if (type === 'read') {
      whereClause.is_read = true;
    } else if (type === 'unread') {
      whereClause.is_read = false;
    }

    const result = await Notification.destroy({
      where: whereClause
    });

    logger.info(`${result} notifications supprimées par l'utilisateur ${userId} (type: ${type})`);

    res.json({
      success: true,
      message: 'Notifications supprimées avec succès',
      data: {
        deleted_count: result
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la suppression de toutes les notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/notifications/test
 * Créer une notification de test (pour les développeurs)
 */
router.post('/test', [
  authenticateToken,
  body('type').isIn(['like', 'retweet', 'reply', 'mention', 'follow', 'system']).withMessage('Type de notification invalide'),
  body('title').trim().isLength({ min: 1, max: 100 }).withMessage('Le titre doit contenir entre 1 et 100 caractères'),
  body('message').trim().isLength({ min: 1, max: 500 }).withMessage('Le message doit contenir entre 1 et 500 caractères'),
  body('priority').optional().isIn(['low', 'normal', 'high', 'urgent']).withMessage('Priorité invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const {
      type,
      title,
      message,
      priority = 'normal'
    } = req.body;

    const userId = req.user.id;

    // Vérifier que l'utilisateur est un administrateur ou développeur
    const user = await User.findByPk(userId);
    if (!user || !user.premium) {
      return res.status(403).json({
        success: false,
        message: 'Accès non autorisé. Fonctionnalité réservée aux développeurs.'
      });
    }

    const notification = await Notification.create({
      recipient_id: userId,
      sender_id: userId, // L'utilisateur s'envoie une notification à lui-même
      type,
      title,
      message,
      priority,
      metadata: {
        source: 'test',
        device: req.headers['user-agent'] || 'unknown',
        ip_address: req.ip
      }
    });

    logger.info(`Notification de test créée: ${notification.id} par l'utilisateur ${userId}`);

    // Envoi d'un push si un token Expo est enregistré
    if (user.id_notif) {
      try {
        const pushRes = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            to: user.id_notif,
            sound: 'default',
            title,
            body: message,
            data: { type, notification_id: notification.id }
          })
        });
        const pushJson = await pushRes.json();
        logger.info('Envoi push test', pushJson);
      } catch (e) {
        logger.error('Erreur envoi push Expo:', e);
      }
    }

    res.status(201).json({ success: true, message: 'Notification de test créée avec succès', data: notification });

  } catch (error) {
    logger.error('Erreur lors de la création de la notification de test:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/notifications/settings
 * Récupérer les paramètres de notifications de l'utilisateur
 */
router.get('/settings', [
  authenticateToken,
  handleValidationErrors
], async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findByPk(userId, {
      attributes: ['preferences']
    });

    const notificationSettings = user.preferences?.notifications || {
      push: true,
      email: true,
      sms: false
    };

    res.json({
      success: true,
      message: 'Paramètres de notifications récupérés avec succès',
      data: {
        notifications: notificationSettings
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des paramètres de notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * PUT /api/notifications/settings
 * Mettre à jour les paramètres de notifications de l'utilisateur
 */
router.put('/settings', [
  authenticateToken,
  body('notifications.push').optional().isBoolean().withMessage('Le paramètre push doit être un booléen'),
  body('notifications.email').optional().isBoolean().withMessage('Le paramètre email doit être un booléen'),
  body('notifications.sms').optional().isBoolean().withMessage('Le paramètre sms doit être un booléen'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { notifications } = req.body;
    const userId = req.user.id;

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Mettre à jour les préférences
    const currentPreferences = user.preferences || {};
    const updatedPreferences = {
      ...currentPreferences,
      notifications: {
        ...currentPreferences.notifications,
        ...notifications
      }
    };

    await user.update({
      preferences: updatedPreferences
    });

    logger.info(`Paramètres de notifications mis à jour pour l'utilisateur ${userId}`);

    res.json({
      success: true,
      message: 'Paramètres de notifications mis à jour avec succès',
      data: {
        notifications: updatedPreferences.notifications
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la mise à jour des paramètres de notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

module.exports = router;
/**
 * POST /api/notifications/register-device
 * Enregistrer le token Expo de l'appareil
 */
router.post('/register-device', [
  authenticateToken,
  body('expoPushToken').isString().withMessage('Token invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const userId = req.user.id;
    let { expoPushToken } = req.body;
    if (typeof expoPushToken === 'string') expoPushToken = expoPushToken.trim();
    if (!expoPushToken) return res.status(400).json({ success: false, message: 'Token manquant' });
    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    // Libérer le token d'autres comptes (contrainte unique potentielle)
    await User.update({ id_notif: null }, {
      where: {
        id: { [Op.ne]: userId },
        id_notif: expoPushToken
      }
    });
    await user.update({ id_notif: expoPushToken });
    res.json({ success: true, message: 'Device enregistré', data: { id_notif: user.id_notif } });
  } catch (error) {
    logger.error('Erreur enregistrement device:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});
