const { DataTypes, Model } = require('sequelize');
const axios = require('axios');
const logger = require('../utils/logger');

class Notification extends Model {
  // Méthode pour marquer la notification comme lue
  async markAsRead() {
    this.is_read = true;
    this.read_at = new Date();
    return this.save();
  }

  // Méthode statique pour obtenir les notifications d'un utilisateur
  static async getUserNotifications(userId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      unreadOnly = false,
      includeSender = true,
      includeTweet = true
    } = options;

    const whereClause = { recipient_id: userId };
    
    if (unreadOnly) {
      whereClause.is_read = false;
    }

    const includeOptions = [];
    
    if (includeSender) {
      includeOptions.push({
        model: this.sequelize.models.User,
        as: 'sender',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style', 'profile_customization']
      });
    }

    if (includeTweet) {
      includeOptions.push({
        model: this.sequelize.models.Tweet,
        as: 'tweet',
        attributes: ['id', 'content', 'created_at'],
        include: [{
          model: this.sequelize.models.User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'profile_customization']
        }]
      });
    }

    return this.findAll({
      where: whereClause,
      include: includeOptions,
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
  }

  // Méthode statique pour compter les notifications non lues d'un utilisateur
  static async countUnreadNotifications(userId) {
    return this.count({
      where: {
        recipient_id: userId,
        is_read: false
      }
    });
  }

  // Méthode statique pour marquer toutes les notifications comme lues
  static async markAllAsRead(userId) {
    return this.update(
      {
        is_read: true,
        read_at: new Date()
      },
      {
        where: {
          recipient_id: userId,
          is_read: false
        }
      }
    );
  }

  // Méthode statique pour créer une notification
  static async createNotification(data) {
    try {
      const { _skip_push, ...record } = data || {};
      const notification = await this.create(record);
      logger.info(`Nouvelle notification créée: ${notification.id} pour l'utilisateur ${data.recipient_id}`);

      // Tentative d'envoi push automatique si un token Expo est enregistré
      try {
        if (_skip_push) return notification;
        const User = this.sequelize.models.User;
        const recipient = await User.findByPk(data.recipient_id, { attributes: ['id_notif'] });
        const to = recipient?.id_notif;
        if (to) {
          const payload = {
            to,
            sound: 'default',
            title: record.title || 'Notification',
            body: record.message || '',
            data: {
              type: record.type,
              notification_id: notification.id,
              tweet_id: record.tweet_id || null,
              sender_id: record.sender_id || null,
              entity_type: record.content?.entity_type || null,
              // Sous-type des notifications `system` (idée du radar, réponse du
              // support…). Sans lui, le client ne peut pas router un push : le
              // type `system` seul ne dit pas où aller.
              kind: record.metadata?.kind || null,
              story_id: record.content?.story_id || null,
              conversation_id: record.content?.conversation_id || null,
              message_id: record.content?.message_id || null,
            }
          };
          await axios.post('https://exp.host/--/api/v2/push/send', payload, {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (pushError) {
        logger.warn('Envoi push automatique échoué (non bloquant):', pushError?.message || pushError);
      }

      return notification;
    } catch (error) {
      logger.error('Erreur lors de la création de la notification:', error);
      throw error;
    }
  }

  // Méthode statique pour créer une notification de like
  static async createLikeNotification(likerId, tweetId, tweetAuthorId) {
    if (likerId === tweetAuthorId) return null; // Pas de notification pour soi-même
    const User = this.sequelize.models.User;
    const sender = await User.findByPk(likerId, { attributes: ['username'] });
    const senderName = sender?.username ? `@${sender.username}` : 'Quelqu\'un';
    return this.createNotification({
      recipient_id: tweetAuthorId,
      sender_id: likerId,
      tweet_id: tweetId,
      type: 'like',
      // Title = "@username a aimé votre tweet"
      title: `${senderName} a aimé votre tweet`,
      // Body = "Nouveau like"
      message: 'Nouveau like'
    });
  }

  // Méthode statique pour créer une notification de retweet
  static async createRetweetNotification(retweeterId, tweetId, tweetAuthorId) {
    if (retweeterId === tweetAuthorId) return null; // Pas de notification pour soi-même
    const User = this.sequelize.models.User;
    const sender = await User.findByPk(retweeterId, { attributes: ['username'] });
    const senderName = sender?.username ? `@${sender.username}` : 'Quelqu\'un';
    return this.createNotification({
      recipient_id: tweetAuthorId,
      sender_id: retweeterId,
      tweet_id: tweetId,
      type: 'retweet',
      title: `${senderName} a retweeté votre tweet`,
      message: 'Nouveau retweet'
    });
  }

  // Méthode statique pour créer une notification de mention
  static async createMentionNotification(mentionerId, tweetId, mentionedUserId) {
    if (mentionerId === mentionedUserId) return null; // Pas de notification pour soi-même
    const User = this.sequelize.models.User;
    const sender = await User.findByPk(mentionerId, { attributes: ['username'] });
    const senderName = sender?.username ? `@${sender.username}` : 'Quelqu\'un';
    return this.createNotification({
      recipient_id: mentionedUserId,
      sender_id: mentionerId,
      tweet_id: tweetId,
      type: 'mention',
      title: `${senderName} vous a mentionné`,
      message: 'Nouvelle mention'
    });
  }

  // Méthode statique pour créer une notification de suivi
  static async createFollowNotification(followerId, followedUserId) {
    if (followerId === followedUserId) return null; // Pas de notification pour soi-même
    const User = this.sequelize.models.User;
    const sender = await User.findByPk(followerId, { attributes: ['username'] });
    const senderName = sender?.username ? `@${sender.username}` : 'Quelqu\'un';
    return this.createNotification({
      recipient_id: followedUserId,
      sender_id: followerId,
      type: 'follow',
      title: `${senderName} vous suit maintenant`,
      message: 'Nouveau suivi'
    });
  }

  // Compte privé : demande de suivi en attente d'approbation. Réutilise le
  // type `follow` (pas de nouvelle valeur d'ENUM à migrer) et se distingue
  // via `metadata.kind` pour le tri/affichage côté client.
  static async createFollowRequestNotification(requesterId, targetUserId) {
    if (requesterId === targetUserId) return null;
    const User = this.sequelize.models.User;
    const sender = await User.findByPk(requesterId, { attributes: ['username'] });
    const senderName = sender?.username ? `@${sender.username}` : 'Quelqu\'un';
    return this.createNotification({
      recipient_id: targetUserId,
      sender_id: requesterId,
      type: 'follow',
      title: `${senderName} a demandé à vous suivre`,
      message: 'Demande de suivi',
      metadata: { kind: 'follow_request' }
    });
  }

  // Compte privé : notifie le demandeur que sa demande a été acceptée.
  static async createFollowAcceptNotification(accepterId, requesterId) {
    if (accepterId === requesterId) return null;
    const User = this.sequelize.models.User;
    const sender = await User.findByPk(accepterId, { attributes: ['username'] });
    const senderName = sender?.username ? `@${sender.username}` : 'Quelqu\'un';
    return this.createNotification({
      recipient_id: requesterId,
      sender_id: accepterId,
      type: 'follow',
      title: `${senderName} a accepté votre demande de suivi`,
      message: 'Demande acceptée',
      metadata: { kind: 'follow_accept' }
    });
  }

  // Méthode statique pour créer une notification de réponse
  static async createReplyNotification(replierId, replyTweetId, originalTweetId, originalTweetAuthorId) {
    if (replierId === originalTweetAuthorId) return null; // Pas de notification pour soi-même
    const User = this.sequelize.models.User;
    const sender = await User.findByPk(replierId, { attributes: ['username'] });
    const senderName = sender?.username ? `@${sender.username}` : 'Quelqu\'un';
    return this.createNotification({
      recipient_id: originalTweetAuthorId,
      sender_id: replierId,
      tweet_id: replyTweetId,
      original_tweet_id: originalTweetId,
      type: 'reply',
      title: `${senderName} a répondu à votre tweet`,
      message: 'Nouvelle réponse'
    });
  }
}

// Définition du schéma du modèle Notification
const notificationSchema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  // Utilisateur qui reçoit la notification
  recipient_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },

  // Utilisateur qui déclenche la notification (peut être null pour les notifications système)
  sender_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },

  // Tweet associé à la notification (peut être null pour les notifications de suivi)
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'tweets',
      key: 'id'
    }
  },

  // Tweet original (pour les réponses)
  original_tweet_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'tweets',
      key: 'id'
    }
  },

  // Type de notification
  type: {
    type: DataTypes.ENUM(
      'like',
      'retweet',
      'reply',
      'mention',
      'follow',
      'unfollow',
      'quote',
      'system',
      'verification',
      'premium'
    ),
    allowNull: false
  },

  // Titre de la notification
  title: {
    type: DataTypes.STRING(100),
    allowNull: false
  },

  // Message de la notification
  message: {
    type: DataTypes.TEXT,
    allowNull: false
  },

  // Contenu additionnel (pour les notifications complexes)
  content: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: {}
  },

  // Statut de lecture
  is_read: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  // Date de lecture
  read_at: {
    type: DataTypes.DATE,
    allowNull: true
  },

  // Priorité de la notification
  priority: {
    type: DataTypes.ENUM('low', 'normal', 'high', 'urgent'),
    defaultValue: 'normal'
  },

  // Métadonnées de la notification
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {
      source: 'web',
      device: 'unknown',
      ip_address: null,
      user_agent: null
    }
  }
};

// Options du modèle
const modelOptions = {
  modelName: 'Notification',
  tableName: 'notifications',
  timestamps: true,
  underscored: true,

  // Index pour optimiser les requêtes
  indexes: [
    {
      fields: ['recipient_id']
    },
    {
      fields: ['sender_id']
    },
    {
      fields: ['tweet_id']
    },
    {
      fields: ['type']
    },
    {
      fields: ['is_read']
    },
    {
      fields: ['created_at']
    },
    {
      fields: ['priority']
    },
    // Index composite pour les requêtes fréquentes
    {
      fields: ['recipient_id', 'is_read']
    },
    {
      fields: ['recipient_id', 'created_at']
    },
    {
      fields: ['recipient_id', 'type']
    }
  ],

  // Hooks
  hooks: {
    afterCreate: (notification) => {
      logger.info(`Notification créée: ${notification.type} pour l'utilisateur ${notification.recipient_id}`);
    },

    afterUpdate: (notification) => {
      if (notification.changed('is_read')) {
        logger.info(`Notification ${notification.id} marquée comme ${notification.is_read ? 'lue' : 'non lue'}`);
      }
    }
  }
};

// Fonction pour initialiser le modèle avec sequelize
function initNotificationModel(sequelize) {
  Notification.init(notificationSchema, {
    ...modelOptions,
    sequelize
  });
}

module.exports = Notification;
module.exports.initNotificationModel = initNotificationModel;
module.exports.notificationSchema = notificationSchema;
module.exports.modelOptions = modelOptions;
