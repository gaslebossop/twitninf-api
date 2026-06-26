const { DataTypes, Model } = require('sequelize');
const logger = require('../utils/logger');

class UserFollow extends Model {
  // Méthode statique pour vérifier si un utilisateur suit un autre
  static async isFollowing(followerId, followingId) {
    const follow = await this.findOne({
      where: {
        follower_id: followerId,
        following_id: followingId
      }
    });
    return !!follow;
  }

  // Méthode statique pour obtenir les utilisateurs suivis par un utilisateur
  static async getFollowing(userId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      includeUser = true
    } = options;

    const includeOptions = includeUser ? [{
      model: this.sequelize.models.User,
      as: 'following',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats'],
      where: { 
        is_active: true,
        is_suspended: false
      }
    }] : [];

    return this.findAll({
      where: { follower_id: userId },
      include: includeOptions,
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
  }

  // Méthode statique pour obtenir les followers d'un utilisateur
  static async getFollowers(userId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      includeUser = true
    } = options;

    const includeOptions = includeUser ? [{
      model: this.sequelize.models.User,
      as: 'follower',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats'],
      where: { 
        is_active: true,
        is_suspended: false
      }
    }] : [];

    return this.findAll({
      where: { following_id: userId },
      include: includeOptions,
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
  }

  // Méthode statique pour compter les utilisateurs suivis
  static async countFollowing(userId) {
    return this.count({
      where: { follower_id: userId }
    });
  }

  // Méthode statique pour compter les followers
  static async countFollowers(userId) {
    return this.count({
      where: { following_id: userId }
    });
  }

  // Méthode statique pour obtenir les suggestions de suivi
  static async getFollowSuggestions(userId, limit = 10) {
    // Utilisateurs que l'utilisateur ne suit pas encore
    const following = await this.findAll({
      where: { follower_id: userId },
      attributes: ['following_id']
    });

    const followingIds = following.map(f => f.following_id);
    followingIds.push(userId); // Exclure l'utilisateur lui-même

    return this.sequelize.models.User.findAll({
      where: {
        id: { [this.sequelize.Op.notIn]: followingIds },
        is_active: true,
        is_suspended: false,
        verified: true // Priorité aux comptes vérifiés
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats'],
      order: [
        ['verified', 'DESC'],
        ['stats.followers', 'DESC'],
        ['created_at', 'DESC']
      ],
      limit
    });
  }

  // Méthode statique pour obtenir les utilisateurs mutuellement suivis
  static async getMutualFollowers(userId, otherUserId) {
    const [userFollowing, otherFollowing] = await Promise.all([
      this.findAll({
        where: { follower_id: userId },
        attributes: ['following_id']
      }),
      this.findAll({
        where: { follower_id: otherUserId },
        attributes: ['following_id']
      })
    ]);

    const userFollowingIds = userFollowing.map(f => f.following_id);
    const otherFollowingIds = otherFollowing.map(f => f.following_id);

    const mutualIds = userFollowingIds.filter(id => otherFollowingIds.includes(id));

    if (mutualIds.length === 0) return [];

    return this.sequelize.models.User.findAll({
      where: {
        id: { [this.sequelize.Op.in]: mutualIds },
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium'],
      order: [['username', 'ASC']]
    });
  }
}

// Définition du schéma du modèle UserFollow
const userFollowSchema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  // Utilisateur qui suit
  follower_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },

  // Utilisateur qui est suivi
  following_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },

  // Statut de la relation
  status: {
    type: DataTypes.ENUM('active', 'blocked', 'muted'),
    defaultValue: 'active'
  },

  // Notifications activées pour ce suivi
  notifications_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },

  // Métadonnées de la relation
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {
      source: 'web',
      device: 'unknown',
      ip_address: null
    }
  }
};

// Options du modèle
const modelOptions = {
  modelName: 'UserFollow',
  tableName: 'user_follows',
  timestamps: true,
  underscored: true,

  // Index pour optimiser les requêtes
  indexes: [
    {
      unique: true,
      fields: ['follower_id', 'following_id'] // Un utilisateur ne peut suivre un autre qu'une fois
    },
    {
      fields: ['follower_id']
    },
    {
      fields: ['following_id']
    },
    {
      fields: ['status']
    },
    {
      fields: ['created_at']
    },
    // Index composite pour les requêtes fréquentes
    {
      fields: ['follower_id', 'status']
    },
    {
      fields: ['following_id', 'status']
    }
  ],

  // Hooks
  hooks: {
    afterCreate: async (follow) => {
      try {
        // Mettre à jour le compteur de following de l'utilisateur qui suit
        const follower = await follow.sequelize.models.User.findByPk(follow.follower_id);
        if (follower) {
          const currentStats = follower.stats || {};
          await follower.update({
            stats: {
              ...currentStats,
              following: (currentStats.following || 0) + 1
            }
          });
        }

        // Mettre à jour le compteur de followers de l'utilisateur suivi
        const following = await follow.sequelize.models.User.findByPk(follow.following_id);
        if (following) {
          const currentStats = following.stats || {};
          await following.update({
            stats: {
              ...currentStats,
              followers: (currentStats.followers || 0) + 1
            }
          });
        }

        // Créer une notification de suivi (si le modèle existe)
        try {
          if (follow.sequelize.models.Notification && follow.sequelize.models.Notification.createFollowNotification) {
            await follow.sequelize.models.Notification.createFollowNotification(
              follow.follower_id,
              follow.following_id
            );
          }
        } catch (notificationError) {
          logger.warn('Impossible de créer la notification de suivi:', notificationError.message);
        }

        logger.info(`Nouveau suivi créé: utilisateur ${follow.follower_id} suit maintenant ${follow.following_id}`);
      } catch (error) {
        logger.error('Erreur lors de la création du suivi:', error);
      }
    },

    afterDestroy: async (follow) => {
      try {
        // Décrémenter le compteur de following de l'utilisateur qui suivait
        const follower = await follow.sequelize.models.User.findByPk(follow.follower_id);
        if (follower) {
          const currentStats = follower.stats || {};
          await follower.update({
            stats: {
              ...currentStats,
              following: Math.max(0, (currentStats.following || 0) - 1)
            }
          });
        }

        // Décrémenter le compteur de followers de l'utilisateur qui était suivi
        const following = await follow.sequelize.models.User.findByPk(follow.following_id);
        if (following) {
          const currentStats = following.stats || {};
          await following.update({
            stats: {
              ...currentStats,
              followers: Math.max(0, (currentStats.followers || 0) - 1)
            }
          });
        }

        logger.info(`Suivi supprimé: utilisateur ${follow.follower_id} ne suit plus ${follow.following_id}`);
      } catch (error) {
        logger.error('Erreur lors de la suppression du suivi:', error);
      }
    }
  }
};

// Fonction pour initialiser le modèle avec sequelize
function initUserFollowModel(sequelize) {
  UserFollow.init(userFollowSchema, {
    ...modelOptions,
    sequelize
  });
}

module.exports = UserFollow;
module.exports.initUserFollowModel = initUserFollowModel;
module.exports.userFollowSchema = userFollowSchema;
module.exports.modelOptions = modelOptions;
