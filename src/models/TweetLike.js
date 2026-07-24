const { DataTypes, Model } = require('sequelize');
const logger = require('../utils/logger');

class TweetLike extends Model {
  // Méthode statique pour obtenir tous les likes d'un tweet
  static async getTweetLikes(tweetId, options = {}) {
    const {
      limit = 50,
      offset = 0,
      includeUser = true
    } = options;

    const includeOptions = includeUser ? [{
      model: this.sequelize.models.User,
      as: 'user',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium']
    }] : [];

    return this.findAll({
      where: { tweet_id: tweetId },
      include: includeOptions,
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
  }

  // Méthode statique pour obtenir tous les tweets likés par un utilisateur
  static async getUserLikedTweets(userId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      includeTweet = true
    } = options;

    const includeOptions = includeTweet ? [{
      model: this.sequelize.models.Tweet,
      as: 'tweet',
      include: [{
        model: this.sequelize.models.User,
        as: 'author',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium']
      }]
    }] : [];

    return this.findAll({
      where: { user_id: userId },
      include: includeOptions,
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
  }

  // Méthode statique pour vérifier si un utilisateur a liké un tweet
  static async hasUserLikedTweet(userId, tweetId) {
    const like = await this.findOne({
      where: {
        user_id: userId,
        tweet_id: tweetId
      }
    });
    return !!like;
  }

  // Méthode statique pour compter les likes d'un tweet
  static async countTweetLikes(tweetId) {
    return this.count({
      where: { tweet_id: tweetId }
    });
  }

  // Méthode statique pour compter les tweets likés par un utilisateur
  static async countUserLikedTweets(userId) {
    return this.count({
      where: { user_id: userId }
    });
  }
}

// Définition du schéma du modèle TweetLike
const tweetLikeSchema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  // Référence à l'utilisateur qui a liké
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },

  // Référence au tweet liké
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'tweets',
      key: 'id'
    }
  },

  // Type de like (pour les futures fonctionnalités)
  like_type: {
    type: DataTypes.ENUM('like', 'love', 'haha', 'wow', 'sad', 'angry'),
    defaultValue: 'like'
  },

  // Métadonnées du like
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
  modelName: 'TweetLike',
  tableName: 'tweet_likes',
  timestamps: true,
  underscored: true,

  // Index pour optimiser les requêtes
  indexes: [
    {
      unique: true,
      fields: ['user_id', 'tweet_id'] // Un utilisateur ne peut liker un tweet qu'une fois
    },
    {
      fields: ['tweet_id']
    },
    {
      fields: ['user_id']
    },
    {
      fields: ['created_at']
    },
    {
      fields: ['like_type']
    }
  ],

  // Hooks
  hooks: {
    afterCreate: async (like) => {
      try {
        // Mettre à jour le compteur de likes de l'utilisateur
        const User = like.sequelize.models.User;
        const user = await User.findByPk(like.user_id, { attributes: ['id', 'stats'] });
        if (user) {
          const currentStats = user.stats || {};
          const newLikes = (currentStats.likes || 0) + 1;
          await user.update({ stats: { ...currentStats, likes: newLikes } });
        }
        
        // Mettre à jour la progression des défis
        const ChallengeProgressService = require('../services/challengeProgressService');
        await ChallengeProgressService.onTweetLiked(like.tweet_id, like.user_id);
        
        // 🎯 CIBLAGE ÉTENDU — Créer un batch pour l'analyse IA
        try {
          const targetingService = require('../../../../targeting/extendedTargetingService');
          const Tweet = like.sequelize.models.Tweet;
          const tweet = await Tweet.findByPk(like.tweet_id, {
            attributes: ['id', 'content', 'media_urls', 'user_id'],
            include: [{ model: like.sequelize.models.User, as: 'author', attributes: ['username'] }]
          });
          if (tweet) {
            targetingService.createBatch(
              like.user_id,
              like.tweet_id,
              'like',
              tweet.content || '',
              tweet.media_urls || [],
              tweet.author?.username || ''
            );
          }
        } catch (targetingErr) {
          logger.warn('⚠️ [Targeting] Erreur création batch (like):', targetingErr.message);
        }
        
        logger.info(`Nouveau like créé: utilisateur ${like.user_id} a liké le tweet ${like.tweet_id}`);
      } catch (error) {
        logger.error('Erreur lors de la mise à jour des statistiques:', error);
      }
    },

    afterDestroy: async (like) => {
      try {
        // Décrémenter le compteur de likes de l'utilisateur
        const User = like.sequelize.models.User;
        const user = await User.findByPk(like.user_id, { attributes: ['id', 'stats'] });
        if (user) {
          const currentStats = user.stats || {};
          const newLikes = Math.max(0, (currentStats.likes || 0) - 1);
          await user.update({ stats: { ...currentStats, likes: newLikes } });
        }
        
        // Mettre à jour la progression des défis
        const ChallengeProgressService = require('../services/challengeProgressService');
        await ChallengeProgressService.onTweetUnliked(like.tweet_id, like.user_id);
        
        logger.info(`Like supprimé: utilisateur ${like.user_id} a unliké le tweet ${like.tweet_id}`);
      } catch (error) {
        logger.error('Erreur lors de la mise à jour des statistiques:', error);
      }
    }
  }
};

// Fonction pour initialiser le modèle avec sequelize
function initTweetLikeModel(sequelize) {
  TweetLike.init(tweetLikeSchema, {
    ...modelOptions,
    sequelize
  });
}

module.exports = TweetLike;
module.exports.initTweetLikeModel = initTweetLikeModel;
module.exports.tweetLikeSchema = tweetLikeSchema;
module.exports.modelOptions = modelOptions;
