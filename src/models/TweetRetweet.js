const { DataTypes, Model } = require('sequelize');
const logger = require('../utils/logger');

class TweetRetweet extends Model {
  // Méthode statique pour obtenir tous les retweets d'un tweet
  static async getTweetRetweets(tweetId, options = {}) {
    const {
      limit = 50,
      offset = 0,
      includeUser = true
    } = options;

    const includeOptions = includeUser ? [{
      model: this.sequelize.models.User,
      as: 'user',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'profile_customization']
    }] : [];

    return this.findAll({
      where: { tweet_id: tweetId },
      include: includeOptions,
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
  }

  // Méthode statique pour obtenir tous les retweets d'un utilisateur
  static async getUserRetweets(userId, options = {}) {
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
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'profile_customization']
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

  // Méthode statique pour vérifier si un utilisateur a retweeté un tweet
  static async hasUserRetweetedTweet(userId, tweetId) {
    const retweet = await this.findOne({
      where: {
        user_id: userId,
        tweet_id: tweetId
      }
    });
    return !!retweet;
  }

  // Méthode statique pour compter les retweets d'un tweet
  static async countTweetRetweets(tweetId) {
    return this.count({
      where: { tweet_id: tweetId }
    });
  }

  /**
   * Compte les retweets de PLUSIEURS tweets en une seule requête.
   * Pendant de `TweetLike.countLikesForTweets` — même contrat : un tweet sans
   * retweet est absent du résultat, lire `map.get(id) || 0`.
   */
  static async countRetweetsForTweets(tweetIds = []) {
    const ids = [...new Set(tweetIds.map(String))].filter(Boolean);
    if (ids.length === 0) return new Map();

    const rows = await this.findAll({
      where: { tweet_id: ids },
      attributes: [
        'tweet_id',
        [this.sequelize.fn('COUNT', this.sequelize.col('id')), 'count'],
      ],
      group: ['tweet_id'],
      raw: true,
    });

    return new Map(rows.map((r) => [String(r.tweet_id), Number(r.count) || 0]));
  }

  /** Parmi `tweetIds`, ceux que `userId` a retweetés. Une seule requête. */
  static async retweetedTweetIdsForUser(userId, tweetIds = []) {
    const ids = [...new Set(tweetIds.map(String))].filter(Boolean);
    if (!userId || ids.length === 0) return new Set();

    const rows = await this.findAll({
      where: { user_id: userId, tweet_id: ids },
      attributes: ['tweet_id'],
      raw: true,
    });

    return new Set(rows.map((r) => String(r.tweet_id)));
  }

  // Méthode statique pour compter les retweets d'un utilisateur
  static async countUserRetweets(userId) {
    return this.count({
      where: { user_id: userId }
    });
  }
}

// Définition du schéma du modèle TweetRetweet
const tweetRetweetSchema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  // Référence à l'utilisateur qui a retweeté
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },

  // Référence au tweet retweeté
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'tweets',
      key: 'id'
    }
  },

  // Type de retweet
  retweet_type: {
    type: DataTypes.ENUM('retweet', 'quote'),
    defaultValue: 'retweet'
  },

  // Commentaire ajouté au retweet (pour les quote retweets)
  comment: {
    type: DataTypes.TEXT,
    allowNull: true,
    validate: {
      len: [0, 600]
    }
  },

  // Métadonnées du retweet
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
  modelName: 'TweetRetweet',
  tableName: 'tweet_retweets',
  timestamps: true,
  underscored: true,

  // Index pour optimiser les requêtes
  indexes: [
    {
      unique: true,
      fields: ['user_id', 'tweet_id'] // Un utilisateur ne peut retweeter un tweet qu'une fois
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
      fields: ['retweet_type']
    }
  ],

  // Hooks
  hooks: {
    afterCreate: async (retweet) => {
      try {
        // Mettre à jour le compteur de retweets de l'utilisateur (JSONB)
        const User = retweet.sequelize.models.User;
        const user = await User.findByPk(retweet.user_id, { attributes: ['id', 'stats'] });
        if (user) {
          const currentStats = user.stats || {};
          const newRetweets = (currentStats.retweets || 0) + 1;
          await user.update({ stats: { ...currentStats, retweets: newRetweets } });
        }
        
        logger.info(`Nouveau retweet créé: utilisateur ${retweet.user_id} a retweeté le tweet ${retweet.tweet_id}`);
        
        // 🎯 CIBLAGE ÉTENDU — Créer un batch pour l'analyse IA
        try {
          const targetingService = require('../../../../targeting/extendedTargetingService');
          const Tweet = retweet.sequelize.models.Tweet;
          const tweet = await Tweet.findByPk(retweet.tweet_id, {
            attributes: ['id', 'content', 'media_urls', 'user_id'],
            include: [{ model: retweet.sequelize.models.User, as: 'author', attributes: ['username'] }]
          });
          if (tweet) {
            targetingService.createBatch(
              retweet.user_id,
              retweet.tweet_id,
              'retweet',
              tweet.content || '',
              tweet.media_urls || [],
              tweet.author?.username || ''
            );
          }
        } catch (targetingErr) {
          logger.warn('⚠️ [Targeting] Erreur création batch (retweet):', targetingErr.message);
        }
      } catch (error) {
        logger.error('Erreur lors de la mise à jour des statistiques:', error);
      }
    },

    afterDestroy: async (retweet) => {
      try {
        // Décrémenter le compteur de retweets de l'utilisateur (JSONB)
        const User = retweet.sequelize.models.User;
        const user = await User.findByPk(retweet.user_id, { attributes: ['id', 'stats'] });
        if (user) {
          const currentStats = user.stats || {};
          const newRetweets = Math.max(0, (currentStats.retweets || 0) - 1);
          await user.update({ stats: { ...currentStats, retweets: newRetweets } });
        }
        
        logger.info(`Retweet supprimé: utilisateur ${retweet.user_id} a unretweeté le tweet ${retweet.tweet_id}`);
      } catch (error) {
        logger.error('Erreur lors de la mise à jour des statistiques:', error);
      }
    }
  }
};

// Fonction pour initialiser le modèle avec sequelize
function initTweetRetweetModel(sequelize) {
  TweetRetweet.init(tweetRetweetSchema, {
    ...modelOptions,
    sequelize
  });
}

module.exports = TweetRetweet;
module.exports.initTweetRetweetModel = initTweetRetweetModel;
module.exports.tweetRetweetSchema = tweetRetweetSchema;
module.exports.modelOptions = modelOptions;
