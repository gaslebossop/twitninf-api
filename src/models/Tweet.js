const { DataTypes, Model, Op } = require('sequelize');
const logger = require('../utils/logger');

class Tweet extends Model {
  /**
   * AUDIT S2 (2026-08-19) : `metadata` porte `ip_address` et `device`
   * (user-agent) de l'auteur au moment de la publication — utile pour la
   * modération/anti-fraude, jamais destiné aux autres lecteurs. Sans ce
   * `toJSON`, Sequelize sérialise `metadata` tel quel : chaque appel de la
   * route la plus fréquentée de l'API (le fil) renvoyait ces deux champs à
   * tout autre utilisateur, pour tout tweet. Les autres clés (overlay_texts,
   * video_processing_percent, ab_test…) restent : elles sont lues côté
   * client. La donnée brute reste accessible côté serveur via `.metadata`
   * directement sur l'instance — seule la sérialisation JSON est filtrée.
   */
  toJSON() {
    const json = { ...super.toJSON() };
    if (json.metadata && typeof json.metadata === 'object') {
      const { ip_address, device, ...safeMetadata } = json.metadata;
      json.metadata = safeMetadata;
    }
    return json;
  }

  // Méthode pour obtenir le tweet avec les statistiques calculées
  async getTweetWithStats() {
    const tweet = this.toJSON();
    
    // Calculer les statistiques en temps réel
    const likeCount = await this.countLikes();
    const retweetCount = await this.countRetweets();
    const replyCount = await this.countReplies();
    const viewCount = await this.countViews();
    
    return {
      ...tweet,
      stats: {
        likes: likeCount,
        retweets: retweetCount,
        replies: replyCount,
        views: viewCount
      }
    };
  }

  // Méthode pour vérifier si un utilisateur a liké ce tweet
  async isLikedByUser(userId) {
    const like = await this.sequelize.models.TweetLike.findOne({
      where: {
        tweet_id: this.id,
        user_id: userId
      }
    });
    return !!like;
  }

  // Méthode pour vérifier si un utilisateur a retweeté ce tweet
  async isRetweetedByUser(userId) {
    const retweet = await this.sequelize.models.TweetRetweet.findOne({
      where: {
        tweet_id: this.id,
        user_id: userId
      }
    });
    return !!retweet;
  }

  // Méthode pour vérifier si un utilisateur a répondu à ce tweet
  async isRepliedByUser(userId) {
    const reply = await this.sequelize.models.Tweet.findOne({
      where: {
        parent_tweet_id: this.id,
        user_id: userId
      }
    });
    return !!reply;
  }

  // Méthode statique pour rechercher des tweets
  static async searchTweets(query, options = {}) {
    const { Op } = require('sequelize');
    const {
      limit = 20,
      offset = 0,
      userId = null,
      includeReplies = true,
      includeRetweets = true,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = options;

    // Construire la clause WHERE pour la recherche dans tous les champs éligibles
    const whereClause = {
      [Op.or]: [
        // Recherche dans le contenu textuel
        { content: { [Op.iLike]: `%${query}%` } }
      ],
      // Filtres de base pour les tweets éligibles
      is_private: false,
      moderation_status: 'approved',
      deleted_at: null
    };

    // Filtre par type de tweet
    if (!includeReplies) {
      whereClause.parent_tweet_id = null;
    }

    if (!includeRetweets) {
      whereClause.is_retweet = false;
    }

    // Recherche avancée : si la requête commence par #, chercher spécifiquement dans les hashtags
    if (query.startsWith('#')) {
      // Pour les hashtags, on cherche dans le contenu car les hashtags sont extraits automatiquement
      whereClause[Op.or] = [
        { content: { [Op.iLike]: `%${query}%` } }
      ];
    }
    
    // Recherche avancée : si la requête commence par @, chercher spécifiquement dans les mentions
    if (query.startsWith('@')) {
      // Pour les mentions, on cherche dans le contenu car les mentions sont extraites automatiquement
      whereClause[Op.or] = [
        { content: { [Op.iLike]: `%${query}%` } }
      ];
    }

    return this.findAll({
      where: whereClause,
      include: [
        {
          model: this.sequelize.models.User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'profile_customization']
        }
      ],
      order: [[sortBy, sortOrder]],
      limit,
      offset
    });
  }

  // Méthode statique pour obtenir les tweets d'un utilisateur
  static async getUserTweets(userId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      includeReplies = true,
      includeRetweets = true,
      includeLikes = true
    } = options;

    const whereClause = { user_id: userId };

    if (!includeReplies) {
      whereClause.parent_tweet_id = null;
    }

    if (!includeRetweets) {
      whereClause.is_retweet = false;
    }

    return this.findAll({
      where: whereClause,
      include: [
        {
          model: this.sequelize.models.User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'profile_customization']
        }
      ],
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
  }

  // Méthode statique pour obtenir le feed d'un utilisateur
  static async getUserFeed(userId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      includeReplies = false,
      includeRetweets = true
    } = options;

    // Récupérer les utilisateurs suivis (actifs seulement — une demande de
    // suivi `pending` sur un compte privé ne doit pas faire fuiter son fil)
    const following = await this.sequelize.models.UserFollow.findAll({
      where: { follower_id: userId, status: 'active' },
      attributes: ['following_id']
    });

    const followingIds = following.map(f => f.following_id);
    followingIds.push(userId); // Inclure les propres tweets de l'utilisateur

    const whereClause = {
      // `this.sequelize.Op` n'existe pas en Sequelize v6.
      user_id: { [Op.in]: followingIds },
      parent_tweet_id: null // Tweets originaux uniquement
    };

    if (!includeReplies) {
      whereClause.parent_tweet_id = null;
    }

    if (!includeRetweets) {
      whereClause.is_retweet = false;
    }

    return this.findAll({
      where: whereClause,
      include: [
        {
          model: this.sequelize.models.User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'profile_customization']
        }
      ],
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
  }

  /**
   * Nombre de réponses de PLUSIEURS tweets, en une seule requête.
   *
   * Remplace un `Tweet.count({ where: { parent_tweet_id } })` par tweet.
   * Renvoie une Map<parentId, nombre> ; un tweet sans réponse est absent du
   * résultat SQL, lire `map.get(id) || 0`.
   */
  static async countRepliesForTweets(tweetIds = []) {
    const ids = [...new Set(tweetIds.map(String))].filter(Boolean);
    if (ids.length === 0) return new Map();

    const rows = await this.findAll({
      where: { parent_tweet_id: ids, is_data_test: false },
      attributes: [
        'parent_tweet_id',
        [this.sequelize.fn('COUNT', this.sequelize.col('id')), 'count'],
      ],
      group: ['parent_tweet_id'],
      raw: true,
    });

    return new Map(rows.map((r) => [String(r.parent_tweet_id), Number(r.count) || 0]));
  }
}

// Définition du schéma du modèle Tweet
const tweetSchema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  // Contenu du tweet
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: {
      len: [0, 600]
    }
  },

  // Référence à l'utilisateur qui a créé le tweet
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },

  // Tweet parent (pour les réponses)
  parent_tweet_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'tweets',
      key: 'id'
    }
  },

  // Tweet original (pour les retweets)
  original_tweet_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'tweets',
      key: 'id'
    }
  },

  // Type de tweet
  tweet_type: {
    type: DataTypes.ENUM('tweet', 'reply', 'retweet', 'quote', 'video', 'concours'),
    defaultValue: 'tweet'
  },

  // Indicateur de retweet
  is_retweet: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  // Indicateur de tweet cité
  is_quote: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  // Contenu de la citation (pour les quote tweets)
  quote_content: {
    type: DataTypes.TEXT,
    allowNull: true,
    validate: {
      len: [0, 600]
    }
  },

  // Médias attachés (URLs des images/vidéos)
  media_urls: {
    type: DataTypes.JSONB,
    defaultValue: [],
    validate: {
      isValidMediaArray(value) {
        if (!Array.isArray(value)) {
          throw new Error('media_urls doit être un tableau');
        }
        if (value.length > 4) {
          throw new Error('Maximum 4 médias par tweet');
        }
        value.forEach(url => {
          if (typeof url !== 'string' || (!url.startsWith('http') && !url.startsWith('/storage/'))) {
            throw new Error('URLs de médias invalides');
          }
        });
      }
    }
  },

  // Hashtags extraits du contenu
  hashtags: {
    type: DataTypes.JSONB,
    defaultValue: [],
    validate: {
      isValidHashtagArray(value) {
        if (!Array.isArray(value)) {
          throw new Error('hashtags doit être un tableau');
        }
        value.forEach(tag => {
          if (typeof tag !== 'string' || !tag.startsWith('#')) {
            throw new Error('Hashtags invalides');
          }
        });
      }
    }
  },

  // Mentions d'utilisateurs
  mentions: {
    type: DataTypes.JSONB,
    defaultValue: [],
    validate: {
      isValidMentionArray(value) {
        if (!Array.isArray(value)) {
          throw new Error('mentions doit être un tableau');
        }
        value.forEach(mention => {
          if (typeof mention !== 'string' || !mention.startsWith('@')) {
            throw new Error('Mentions invalides');
          }
        });
      }
    }
  },

  // URLs dans le tweet
  urls: {
    type: DataTypes.JSONB,
    defaultValue: [],
    validate: {
      isValidUrlArray(value) {
        if (!Array.isArray(value)) {
          throw new Error('urls doit être un tableau');
        }
        value.forEach(url => {
          if (typeof url !== 'string' || !url.startsWith('http')) {
            throw new Error('URLs invalides');
          }
        });
      }
    }
  },

  // Localisation du tweet
  location: {
    type: DataTypes.JSONB,
    allowNull: true,
    validate: {
      isValidLocation(value) {
        if (value && (typeof value.lat !== 'number' || typeof value.lng !== 'number')) {
          throw new Error('Format de localisation invalide');
        }
      }
    }
  },

  // Langue du tweet
  language: {
    type: DataTypes.STRING(10),
    allowNull: true,
    defaultValue: 'fr'
  },

  // Sensibilité du contenu
  is_sensitive: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  // Tweet épinglé par l'utilisateur
  is_pinned: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  // Tweet privé (visible uniquement par l'utilisateur)
  is_private: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  // Nombre de vues (pour les statistiques)
  view_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },

  // Nombre de clics sur les liens
  click_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },

  // Vues venues du mur Explorer, dénormalisées à part de `view_count` — lues
  // uniquement par `tweetMonetizationService` pour reformuler cette part en
  // clics plutôt qu'en vues (voir exploreViewsHelpers.js).
  explore_view_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },

  // Clics d'ouverture depuis le mur Explorer — voir explore_view_count.
  explore_click_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },

  // Vues publicitaires (impressions payées au CPM par l'annonceur), gardées
  // à part de view_count pour que la monétisation ne les paie pas deux fois
  // — voir exploreViewsHelpers.js et adService.recordImpression.
  ad_view_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },

  // Indique si le tweet a déjà été monétisé
  monetized: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  /**
   * « Traduction (bêta) » — réservée aux abonnés Pro à la publication.
   * Sert de drapeau d'affichage côté client : c'est ce booléen qui décide
   * d'afficher ou non le sélecteur de langue sur le tweet. Les traductions
   * elles-mêmes vivent dans la table `tweet_translations`.
   */
  translation_enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },

  /**
   * Morceau Spotify attaché au tweet (La Forge : « mettre de la musique dans
   * les tweets »). Toujours revalidé côté écriture par
   * `spotifyService.sanitizeSpotifyTrack` avant `Tweet.create` — ne jamais
   * faire confiance à cette forme telle quelle si elle vient du client.
   */
  spotify_track: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null,
    validate: {
      isValidSpotifyTrack(value) {
        if (value === null || value === undefined) return;
        if (typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('spotify_track doit être un objet');
        }
        if (typeof value.id !== 'string' || !value.id) {
          throw new Error('spotify_track.id est requis');
        }
        if (typeof value.name !== 'string' || !value.name) {
          throw new Error('spotify_track.name est requis');
        }
        if (typeof value.externalUrl !== 'string' || !value.externalUrl.startsWith('https://open.spotify.com/')) {
          throw new Error('spotify_track.externalUrl invalide');
        }
      }
    }
  },

  /**
   * Message vocal joint au tweet (La Forge : « pouvoir ajouter un message
   * vocal dans notre tweet »). Toujours revalidé côté écriture par
   * `tweetAudioService.sanitizeAudioUrl` avant `Tweet.create` — ne jamais
   * faire confiance à cette URL telle quelle si elle vient du client.
   */
  audio_url: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },

  /** Durée en secondes, uniquement pour l'affichage (voir `MAX_DURATION_SECONDS`). */
  audio_duration: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },

  // Métadonnées du tweet
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {
      source: 'web',
      device: 'unknown',
      ip_address: null
    }
  },

  // Statut de modération
  moderation_status: {
    type: DataTypes.ENUM('pending', 'approved', 'rejected', 'flagged', 'not_eligible'),
    defaultValue: 'approved'
  },

  // Raison de modération
  moderation_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },

  // Groupe de recommandation progressive
  recommendation_group: {
    type: DataTypes.ENUM('initial', 'expansion', 'viral', 'massive', 'excluded'),
    defaultValue: 'initial',
    allowNull: false
  },

  // Tweet supprimé (soft delete)
  deleted_at: {
    type: DataTypes.DATE,
    allowNull: true
  },

  /**
   * AUDIT R2-10 (2026-08-19) : cette colonne existe déjà en production,
   * créée par `scripts/capacityDataLifecycle.js` (`ALTER TABLE ... ADD
   * COLUMN IF NOT EXISTS`), un outil de banc d'essai — pas par une
   * migration. Utilisée dans 51 clauses `where`, dont celle du fil
   * (`tweetRoutes.js`), sans jamais être déclarée ici : `sequelize.sync`
   * (`alter: false`) ne peut ni la créer sur une base neuve, ni l'indexer.
   * Toute base qui n'a jamais fait tourner ce script de charge (recette,
   * restauration, nouvel environnement) fait échouer `GET /api/tweets` avec
   * `column "is_data_test" does not exist`. Déclarée ici pour que
   * `sequelize.sync` la crée sur une base neuve ; sur une base existante
   * (dont la prod), une vraie migration reste nécessaire — voir
   * `migrations/`, `alter: false` ne touche jamais une table déjà créée.
   */
  is_data_test: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  }
};

// Options du modèle
const modelOptions = {
  modelName: 'Tweet',
  tableName: 'tweets',
  timestamps: true,
  underscored: true,
  paranoid: true, // Soft delete avec deleted_at

  // Index pour optimiser les requêtes
  indexes: [
    {
      fields: ['user_id']
    },
    {
      fields: ['parent_tweet_id']
    },
    {
      fields: ['original_tweet_id']
    },
    {
      fields: ['created_at']
    },
    {
      fields: ['tweet_type']
    },
    {
      fields: ['is_retweet']
    },
    {
      fields: ['is_quote']
    },
    {
      fields: ['is_pinned']
    },
    {
      fields: ['is_private']
    },
    {
      fields: ['moderation_status']
    },
    {
      fields: ['recommendation_group']
    },
    {
      fields: ['deleted_at']
    },
    // Index GIN pour JSONB
    {
      fields: ['hashtags'],
      using: 'gin'
    },
    {
      fields: ['mentions'],
      using: 'gin'
    },
    {
      fields: ['media_urls'],
      using: 'gin'
    },
    {
      fields: ['urls'],
      using: 'gin'
    },
    // Index composite pour les requêtes fréquentes
    {
      fields: ['user_id', 'created_at']
    },
    {
      fields: ['parent_tweet_id', 'created_at']
    },
    {
      fields: ['tweet_type', 'created_at']
    }
  ],

  // Hooks
  hooks: {
    beforeCreate: (tweet) => {
      // Extraire automatiquement les hashtags du contenu
      if (tweet.content) {
        const hashtagRegex = /#[\w\u0590-\u05ff]+/g;
        tweet.hashtags = tweet.content.match(hashtagRegex) || [];
        
        // Extraire les mentions
        const mentionRegex = /@[\w\u0590-\u05ff]+/g;
        tweet.mentions = tweet.content.match(mentionRegex) || [];
        
        // Extraire les URLs
        const urlRegex = /https?:\/\/[^\s]+/g;
        tweet.urls = tweet.content.match(urlRegex) || [];
      }
    },

    afterCreate: async (tweet) => {
      try {
        // Mettre à jour le compteur de tweets de l'utilisateur (JSONB)
        const User = tweet.sequelize.models.User;
        const user = await User.findByPk(tweet.user_id, { attributes: ['id', 'stats'] });
        if (user) {
          const currentStats = user.stats || {};
          const newTweetsCount = (currentStats.tweets || 0) + 1;
          await user.update({ stats: { ...currentStats, tweets: newTweetsCount } });
        }
        
        // 🧠 Indexer sémantiquement le nouveau tweet (si c'est un original)
        if (!tweet.parent_tweet_id) {
          try {
            const semanticSimilarityService = require('../services/semanticSimilarityService');
            semanticSimilarityService.indexTweet(tweet).catch(e => {
              logger.warn(`⚠️ [Semantic] Échec indexation asynchrone: ${e.message}`);
            });
          } catch (e) {}
        }

        // Mettre à jour la progression des défis
        const ChallengeProgressService = require('../services/challengeProgressService');
        await ChallengeProgressService.onTweetCreated(tweet.user_id);
        
        logger.info(`Nouveau tweet créé: ${tweet.id} par l'utilisateur ${tweet.user_id}`);
      } catch (error) {
        logger.error('Erreur lors de la mise à jour des statistiques:', error);
      }
    },

    afterDestroy: async (tweet) => {
      try {
        // Décrémenter le compteur de tweets de l'utilisateur (JSONB)
        const User = tweet.sequelize.models.User;
        const user = await User.findByPk(tweet.user_id, { attributes: ['id', 'stats'] });
        if (user) {
          const currentStats = user.stats || {};
          const newTweetsCount = Math.max(0, (currentStats.tweets || 0) - 1);
          await user.update({ stats: { ...currentStats, tweets: newTweetsCount } });
        }
        
        logger.info(`Tweet supprimé: ${tweet.id}`);
      } catch (error) {
        logger.error('Erreur lors de la mise à jour des statistiques:', error);
      }
    }
  }
};

// Fonction pour initialiser le modèle avec sequelize
function initTweetModel(sequelize) {
  Tweet.init(tweetSchema, {
    ...modelOptions,
    sequelize
  });
}

module.exports = Tweet;
module.exports.initTweetModel = initTweetModel;
module.exports.tweetSchema = tweetSchema;
module.exports.modelOptions = modelOptions;
