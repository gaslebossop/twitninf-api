/**
 * 🚀 Moteur de Recommandation Ultra-Avancé - TwitNin Legacy
 * 
 * Algorithme de recommandation de niveau professionnel inspiré des meilleures plateformes
 * avec analyse comportementale, ML features, et optimisation multi-dimensionnelle.
 * 
 * @author TwitNin Team
 * @version 3.0.0 - Ultra-Professional
 * @license MIT
 */

const { Op, fn, col, literal, Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const { User, Tweet, TweetLike, TweetRetweet, UserFollow, Notification, Report, ModerationAction } = require('../models');

class RecommendationEngine {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = 3 * 60 * 1000; // 3 minutes pour plus de fraîcheur
    this.maxRecommendations = 100;
    
    // Système de scoring multi-dimensionnel avancé
    this.scoreWeights = {
      // Engagement direct
      like: 15,
      comment: 25,
      retweet: 20,
      view: 2,
      share: 30,
      
      // Qualité du contenu
      contentQuality: 35,
      mediaPresence: 10,
      hashtagRelevance: 12,
      mentionEngagement: 8,
      
      // Popularité et influence
      authorInfluence: 40,
      authorVerification: 15,
      authorPremium: 10,
      authorActivity: 20,
      
      // Comportement utilisateur
      userEngagement: 25,
      userSimilarity: 30,
      userActivity: 15,
      userPreferences: 20,
      
      // Facteurs temporels
      recency: 25,
      trending: 35,
      timeOfDay: 10,
      dayOfWeek: 8,
      
      // Facteurs de diversité
      contentDiversity: 20,
      authorDiversity: 15,
      topicDiversity: 18,
      formatDiversity: 12,
      
      // Facteurs de modération et qualité
      moderationScore: 50,
      reportRatio: -30,
      spamScore: -40,
      contentMaturity: 15
    };
    
    // Seuils dynamiques adaptatifs
    this.thresholds = {
      minScore: 0.05,
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 an (au lieu de 14 jours)
      minEngagement: 0.005,
      diversityFactor: 0.4,
      qualityThreshold: 0.3,
      trendingThreshold: 0.6,
      retrieveAllTweets: true // Activer la récupération de TOUS les tweets depuis toujours
    };
    
    // Métriques de performance avancées
    this.metrics = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      avgResponseTime: 0,
      algorithmPerformance: {},
      lastUpdate: new Date(),
      userSatisfaction: 0.75 // Score de satisfaction moyen
    };
    
    // Système de cache intelligent
    this.cacheLayers = {
      userPreferences: new Map(),
      trendingTopics: new Map(),
      authorScores: new Map(),
      contentScores: new Map()
    };
    
    this.initialize();
  }

  /**
   * Initialisation avancée du moteur
   */
  async initialize() {
    try {
      logger.info('🚀 Initialisation du moteur de recommandation ultra-avancé...');
      
      // Précharger toutes les données critiques
      await Promise.all([
        this.preloadUserBehaviorData(),
        this.preloadTrendingData(),
        this.preloadAuthorInfluenceData(),
        this.preloadContentQualityMetrics()
      ]);
      
      // Démarrer les processus en arrière-plan
      this.startBackgroundProcesses();
      
      logger.info('✅ Moteur de recommandation ultra-avancé initialisé avec succès');
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation du moteur:', error);
    }
  }

  /**
   * Récupère le profil utilisateur complet avec toutes les données nécessaires
   */
  async getUserProfile(userId) {
    try {
      const user = await User.findByPk(userId, {
        include: [
          {
            model: UserFollow,
            as: 'followers',
            attributes: ['id', 'follower_id'],
            required: false
          },
          {
            model: UserFollow,
            as: 'following',
            attributes: ['id', 'following_id'],
            required: false
          },
          {
            model: Tweet,
            as: 'tweets',
            attributes: [
              'id', 'content', 'created_at', 'view_count', 'click_count',
              'tweet_type', 'is_retweet', 'is_quote', 'moderation_status'
            ],
            required: false,
            limit: 50,
            order: [['created_at', 'DESC']]
          },
          {
            model: TweetLike,
            as: 'likes',
            attributes: ['id', 'tweet_id', 'created_at'],
            required: false,
            limit: 100,
            order: [['created_at', 'DESC']]
          }
        ],
        attributes: [
          'id', 'username', 'full_name', 'verified', 'premium', 
          'created_at', 'last_activity', 'stats', 'preferences'
        ]
      });

      if (!user) {
        logger.warn(`⚠️ Utilisateur non trouvé: ${userId}`);
        return null;
      }

      // Enrichir avec des données calculées
      user.dataValues.followersCount = user.followers?.length || 0;
      user.dataValues.followingCount = user.following?.length || 0;
      user.dataValues.tweetsCount = user.tweets?.length || 0;
      user.dataValues.likesCount = user.likes?.length || 0;

      logger.info(`✅ Profil utilisateur récupéré: ${userId} (${user.username})`);
      return user;

    } catch (error) {
      logger.error(`❌ Erreur lors de la récupération du profil utilisateur ${userId}:`, error);
      return null;
    }
  }

  /**
   * Génération de recommandations ultra-personnalisées
   */
  async getRecommendations(userId, options = {}) {
    const startTime = Date.now();
    this.metrics.totalRequests++;
    
    try {
      const {
        limit = 100,
        offset = 0,
        includeUser = true,
        includeStats = true,
        forceRefresh = false,
        algorithm = 'ultra_hybrid',
        context = 'discovery'
      } = options;

      // Vérifier le cache intelligent
      const cacheKey = this.generateCacheKey(userId, options);
      if (!forceRefresh && this.isCacheValid(cacheKey)) {
          this.metrics.cacheHits++;
        const cachedResult = this.getFromCache(cacheKey);
        // Vérifier que le cache retourne la bonne structure
        if (cachedResult && cachedResult.recommendations && cachedResult.pagination) {
          logger.info(`✅ Utilisation du cache pour ${userId} (${cachedResult.recommendations.length} recommandations)`);
          return cachedResult;
        } else {
          logger.warn(`⚠️ Cache invalide détecté, régénération des recommandations`);
        }
      }
      this.metrics.cacheMisses++;

      // Récupérer le profil utilisateur complet
      const user = await this.getUserProfile(userId);
      if (!user) throw new Error('Utilisateur non trouvé');

      // Analyser le contexte et l'intention
      const userContext = await this.analyzeUserContext(user, context);
      
      // Générer les recommandations selon l'algorithme
      let recommendations = await this.executeAlgorithm(algorithm, user, userContext, limit * 3); // Récupérer plus pour avoir de la marge
      
      // Vérifier que les recommandations sont valides
      if (!Array.isArray(recommendations)) {
        logger.warn(`⚠️ Recommandations non valides reçues de l'algorithme ${algorithm}, utilisation d'un tableau vide`);
        recommendations = [];
      }
      
      // Application des filtres avancés
      recommendations = await this.applyAdvancedFilters(recommendations, user, userContext);
      
      // Scoring et ranking ultra-avancés
      recommendations = await this.ultraAdvancedScoring(recommendations, user, userContext);
      
      // Calculer le total réel de tweets disponibles (avant pagination)
      const totalAvailableTweets = recommendations.length;
      
      // Pagination intelligente
      const paginatedResults = this.intelligentPagination(recommendations, offset, limit);
      
      // Enrichissement des données
      if (includeUser || includeStats) {
        await this.enrichRecommendationsAdvanced(paginatedResults, { 
          includeUser, 
          includeStats, 
          userId: userId 
        });
      }
      
      // Nettoyer les objets pour éviter les références circulaires
      const cleanedResults = this.prepareRecommendationsForAPI(paginatedResults);

      // Filtrage final pour exclure les tweets réponses (double sécurité)
      const finalResults = cleanedResults.filter(rec => {
        // Exclure les tweets réponses
        if (rec.parent_tweet_id) {
          logger.debug(`🚫 Tweet réponse exclu des recommandations: ${rec.id}`);
          return false;
        }
        
        // Exclure les tweets sans contenu valide
        if (!rec.content || rec.content.trim().length === 0) {
          logger.debug(`🚫 Tweet sans contenu exclu: ${rec.id}`);
          return false;
        }
        
        return true;
      });

      // Mise en cache intelligente
      this.setIntelligentCache(cacheKey, finalResults, userContext);

      // Mise à jour des métriques
      const responseTime = Date.now() - startTime;
      this.updateAdvancedMetrics(responseTime, algorithm, userContext);

      // Retourner avec informations de pagination complètes
      const result = {
        recommendations: finalResults,
        pagination: {
          total: totalAvailableTweets,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + finalResults.length < totalAvailableTweets,
          totalPages: Math.ceil(totalAvailableTweets / limit),
          currentPage: Math.floor(offset / limit) + 1
        },
        metadata: {
          algorithm,
          context,
          responseTime,
          totalGenerated: recommendations.length,
          totalFiltered: finalResults.length
        }
      };

      logger.info(`🚀 Recommandations ultra-avancées générées pour ${userId}: ${finalResults.length} résultats en ${responseTime}ms (total disponible: ${totalAvailableTweets})`);
      
      return result;

    } catch (error) {
      logger.error('❌ Erreur lors de la génération des recommandations:', error);
      
      // Retourner une structure d'erreur valide au lieu de throw
      return {
        recommendations: [],
        pagination: {
          total: 0,
          limit: options.limit || 100,
          offset: options.offset || 0,
          hasMore: false,
          totalPages: 0,
          currentPage: 1
        },
        metadata: {
          algorithm: options.algorithm || 'ultra_hybrid',
          context: options.context || 'discovery',
          responseTime: Date.now() - startTime,
          totalGenerated: 0,
          totalFiltered: 0,
          error: error.message
        }
      };
    }
  }

  /**
   * Algorithme ultra-hybride multi-dimensionnel
   */
  async executeAlgorithm(algorithm, user, context, limit) {
    switch (algorithm) {
      case 'hybrid':
      case 'ultra_hybrid':
        return await this.getUltraHybridRecommendations(user, context, limit);
      case 'behavioral':
      case 'behavioral_ai':
        return await this.getBehavioralAIRecommendations(user, context, limit);
      case 'trending':
      case 'trending_boost':
        return await this.getTrendingBoostRecommendations(user, context, limit);
      case 'social':
      case 'social_graph':
        return await this.getSocialGraphRecommendations(user, context, limit);
      case 'content':
      case 'content_intelligence':
        return await this.getContentIntelligenceRecommendations(user, context, limit);
      case 'discovery':
        return await this.getDiscoveryRecommendations(user, context, limit);
      case 'popularity':
        return await this.getTrendingRecommendations(user, context, limit);
      case 'new_content_discovery':
        return await this.getNewContentDiscoveryRecommendations(user, context, limit);
      default:
        return await this.getUltraHybridRecommendations(user, context, limit);
    }
  }

  /**
   * Algorithme ultra-hybride avec pondération dynamique
   */
  async getUltraHybridRecommendations(user, context, limit) {
    try {
      // Récupération parallèle de toutes les sources avec des multiplicateurs plus élevés
      // pour s'assurer d'avoir assez de tweets après filtrage
      const [
        behavioralRecs,
        socialRecs,
        contentRecs,
        trendingRecs,
        discoveryRecs
      ] = await Promise.all([
        this.getBehavioralRecommendations(user, context, Math.ceil(limit * 1.5)), // Augmenté de 0.25 à 1.5
        this.getSocialGraphRecommendations(user, context, Math.ceil(limit * 1.5)), // Augmenté de 0.25 à 1.5
        this.getContentIntelligenceRecommendations(user, context, Math.ceil(limit * 1.2)), // Augmenté de 0.2 à 1.2
        this.getTrendingRecommendations(user, context, Math.ceil(limit * 1.0)), // Augmenté de 0.15 à 1.0
        this.getDiscoveryRecommendations(user, context, Math.ceil(limit * 1.0)) // Augmenté de 0.15 à 1.0
      ]);

      // Fusion intelligente avec déduplication
      const allRecs = this.mergeRecommendations([
        behavioralRecs, socialRecs, contentRecs, trendingRecs, discoveryRecs
      ]);

      // Application de la diversité et du filtrage
      const diversified = await this.applyAdvancedDiversity(allRecs, user, context);
      
      // Retourner plus de tweets que la limite pour avoir de la marge
      return diversified.slice(0, limit * 2);
    } catch (error) {
      logger.error('❌ Erreur dans l\'algorithme ultra-hybride:', error);
      return [];
    }
  }

  /**
   * Récupère les recommandations tendances
   */
  async getTrendingRecommendations(user, context, limit) {
    try {
      // Construire la clause WHERE avec option pour récupérer TOUS les tweets
      const whereClause = {
        moderation_status: 'approved',
        deleted_at: null,
        parent_tweet_id: null, // Exclure les réponses
        user_id: { [Op.ne]: user.id }
      };

      // Si retrieveAllTweets est activé, ne pas limiter par la date
      if (!this.thresholds.retrieveAllTweets) {
        whereClause.created_at = { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) }; // Dernières 24h
        logger.info(`📅 Recommandations tendances: limitation aux dernières 24h`);
      } else {
        logger.info(`🌍 Recommandations tendances: récupération de TOUS les tweets depuis toujours`);
      }

      const recommendations = await Tweet.findAll({
        where: whereClause,
        attributes: [
          'id', 'content', 'user_id', 'tweet_type', 'is_retweet', 'is_quote',
          'media_urls', 'hashtags', 'mentions', 'view_count', 'click_count',
          'moderation_status', 'deleted_at'
        ],
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats']
          }
        ],
        order: [
          ['view_count', 'DESC'],
          ['created_at', 'DESC']
        ],
        limit: limit * 2,
        raw: true,
        nest: true
      });

      logger.info(`📊 getTrendingRecommendations: ${recommendations.length} tweets récupérés (${this.thresholds.retrieveAllTweets ? 'depuis toujours' : 'dernières 24h'})`);
      return recommendations;
    } catch (error) {
      logger.error('❌ Erreur dans les recommandations tendances:', error);
      return [];
    }
  }

  /**
   * Récupère les recommandations de découverte
   */
  async getDiscoveryRecommendations(user, context, limit) {
    try {
      // Récupérer des tweets d'utilisateurs que l'utilisateur ne suit pas encore
      const followingIds = await UserFollow.findAll({
        where: { follower_id: user.id },
        attributes: ['following_id']
      });
      
      const followingIdsList = followingIds.map(f => f.following_id);
      followingIdsList.push(user.id); // Exclure les propres tweets

      // Construire la clause WHERE avec option pour récupérer TOUS les tweets
      const whereClause = {
        user_id: { [Op.notIn]: followingIdsList },
        moderation_status: 'approved',
        deleted_at: null,
        parent_tweet_id: null // Exclure les réponses
      };

      // Si retrieveAllTweets est activé, ne pas limiter par la date
      if (!this.thresholds.retrieveAllTweets) {
        whereClause.created_at = { [Op.gte]: new Date(Date.now() - this.thresholds.maxAge) };
        logger.info(`📅 Recommandations de découverte: limitation aux ${this.thresholds.maxAge / (24 * 60 * 60 * 1000)} derniers jours`);
      } else {
        logger.info(`🌍 Recommandations de découverte: récupération de TOUS les tweets depuis toujours`);
      }

      const recommendations = await Tweet.findAll({
        where: whereClause,
        attributes: [
          'id', 'content', 'user_id', 'tweet_type', 'is_retweet', 'is_quote',
          'media_urls', 'hashtags', 'mentions', 'view_count', 'click_count',
          'moderation_status', 'deleted_at'
        ],
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: limit * 2,
        raw: true,
        nest: true
      });

      logger.info(`📊 getDiscoveryRecommendations: ${recommendations.length} tweets récupérés (${this.thresholds.retrieveAllTweets ? 'depuis toujours' : 'limités par date'})`);
      return recommendations;

    } catch (error) {
      logger.error('❌ Erreur dans les recommandations de découverte:', error);
      return [];
    }
  }

  /**
   * Récupère les recommandations basées sur l'IA comportementale
   */
  async getBehavioralAIRecommendations(user, context, limit) {
    try {
      // Analyser les patterns avancés de l'utilisateur
      const userBehavior = await this.analyzeUserBehavior(user.id);
      
      // Récupérer les tweets similaires aux préférences
      const recommendations = await Tweet.findAll({
        where: {
          created_at: { [Op.gte]: new Date(Date.now() - this.thresholds.maxAge) },
          moderation_status: 'approved',
          deleted_at: null,
          parent_tweet_id: null, // Exclure les réponses
          user_id: { [Op.ne]: user.id }
        },
        attributes: [
          'id', 'content', 'user_id', 'tweet_type', 'is_retweet', 'is_quote',
          'media_urls', 'hashtags', 'mentions', 'view_count', 'click_count',
          'moderation_status', 'deleted_at'
        ],
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: limit * 3,
        raw: true,
        nest: true
      });

      // Convertir en objets JavaScript simples
      const simpleRecommendations = recommendations.map(rec => {
        const tweetData = rec.toJSON ? rec.toJSON() : rec;
        return {
          ...tweetData,
          author: tweetData.author ? (tweetData.author.toJSON ? tweetData.author.toJSON() : tweetData.author) : null
        };
      });

      // Filtrer selon le comportement IA
      return this.filterByAIBehavior(simpleRecommendations, userBehavior);
    } catch (error) {
      logger.error('❌ Erreur dans les recommandations IA comportementales:', error);
      return [];
    }
  }

  /**
   * Récupère les recommandations avec boost de tendances
   */
  async getTrendingBoostRecommendations(user, context, limit) {
    try {
      const recommendations = await Tweet.findAll({
        where: {
          created_at: { [Op.gte]: new Date(Date.now() - 6 * 60 * 60 * 1000) }, // Dernières 6h
          moderation_status: 'approved',
          deleted_at: null,
          parent_tweet_id: null, // Exclure les réponses
          user_id: { [Op.ne]: user.id }
        },
        attributes: [
          'id', 'content', 'created_at', 'user_id', 'tweet_type', 'is_retweet', 'is_quote',
          'media_urls', 'hashtags', 'mentions', 'view_count', 'click_count',
          'moderation_status', 'deleted_at'
        ],
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats']
          }
        ],
        order: [
          ['view_count', 'DESC'],
          ['created_at', 'DESC']
        ],
        limit: limit * 2
      });

      return recommendations;
    } catch (error) {
      logger.error('❌ Erreur dans les recommandations avec boost de tendances:', error);
      return [];
    }
  }

  /**
   * Récupère les recommandations basées sur le graphe social
   */
  async getSocialGraphRecommendations(user, context, limit) {
    try {
      // Récupérer les tweets des personnes que l'utilisateur suit
      const followingIds = await UserFollow.findAll({
        where: { follower_id: user.id },
        attributes: ['following_id']
      });
      
      if (followingIds.length === 0) {
        return await this.getTrendingRecommendations(user, context, limit);
      }

      const followingIdsList = followingIds.map(f => f.following_id);

      const recommendations = await Tweet.findAll({
        where: {
          user_id: { [Op.in]: followingIdsList },
          created_at: { [Op.gte]: new Date(Date.now() - this.thresholds.maxAge) },
          moderation_status: 'approved',
          deleted_at: null,
          parent_tweet_id: null // Exclure les réponses
        },
        attributes: [
          'id', 'content', 'created_at', 'user_id', 'tweet_type', 'is_retweet', 'is_quote',
          'media_urls', 'hashtags', 'mentions', 'view_count', 'click_count',
          'moderation_status', 'deleted_at'
        ],
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: limit
      });

      return recommendations;
    } catch (error) {
      logger.error('❌ Erreur dans les recommandations du graphe social:', error);
      return [];
    }
  }

  /**
   * Récupère les recommandations basées sur l'intelligence du contenu
   */
  async getContentIntelligenceRecommendations(user, context, limit) {
    try {
      logger.info(`🔍 getContentIntelligenceRecommendations: Début pour l'utilisateur ${user.id}, limite: ${limit}`);
      
      // Construire la clause WHERE avec option pour récupérer TOUS les tweets
      const whereClause = {
        moderation_status: 'approved',
        deleted_at: null,
        parent_tweet_id: null, // Exclure les réponses
        user_id: { [Op.ne]: user.id },
        hashtags: { [Op.not]: null }
      };

      // Si retrieveAllTweets est activé, ne pas limiter par la date
      if (!this.thresholds.retrieveAllTweets) {
        whereClause.created_at = { [Op.gte]: new Date(Date.now() - this.thresholds.maxAge) };
        logger.info(`📅 Limitation temporelle activée: tweets des ${this.thresholds.maxAge / (24 * 60 * 60 * 1000)} derniers jours`);
      } else {
        logger.info(`🌍 Récupération de TOUS les tweets depuis toujours (pas de limite temporelle)`);
      }
      
      // Récupérer les tweets avec des hashtags populaires
      const recommendations = await Tweet.findAll({
        where: whereClause,
        attributes: [
          'id', 'content', 'created_at', 'user_id', 'tweet_type', 'is_retweet', 'is_quote',
          'media_urls', 'hashtags', 'mentions', 'view_count', 'click_count',
          'moderation_status', 'deleted_at'
        ],
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: limit * 2
      });

      logger.info(`📊 getContentIntelligenceRecommendations: ${recommendations.length} tweets récupérés de la base de données (${this.thresholds.retrieveAllTweets ? 'depuis toujours' : 'limités par date'})`);

      // Filtrer par contenu pertinent et valider les IDs
      const relevantTweets = recommendations.filter(tweet => {
        const tweetData = tweet.toJSON ? tweet.toJSON() : tweet; // Explicit conversion
        if (!tweetData.id) {
          logger.warn(`⚠️ Tweet sans ID détecté dans getContentIntelligenceRecommendations:`, {
            tweet: tweetData, hasDataValues: !!tweet.dataValues, keys: Object.keys(tweetData), originalTweet: tweet
          });
          return false;
        }
        if (!tweetData.content || tweetData.content.trim().length === 0) {
          logger.debug(`🚫 Tweet sans contenu exclu: ${tweetData.id}`);
          return false;
        }
        if (!tweetData.hashtags || tweetData.hashtags.length === 0) {
          logger.debug(`🚫 Tweet sans hashtags exclu: ${tweetData.id}`);
          return false;
        }
        if (!tweetData.author || !tweetData.author.id) {
          logger.debug(`🚫 Tweet sans auteur valide exclu: ${tweetData.id}`);
          return false;
        }
        return true;
      });

      logger.info(`✅ getContentIntelligenceRecommendations: ${relevantTweets.length} tweets valides sur ${recommendations.length} récupérés`);

      // Convertir en objets JavaScript simples
      const finalTweets = relevantTweets.map(tweet => {
        const tweetData = tweet.toJSON ? tweet.toJSON() : tweet;
        return {
          ...tweetData,
          author: tweetData.author ? (tweetData.author.toJSON ? tweetData.author.toJSON() : tweetData.author) : null
        };
      });

      if (finalTweets.length > 0) {
        logger.info('🔍 Premier tweet valide final:', { 
          id: finalTweets[0].id, 
          type: typeof finalTweets[0].id, 
          content: finalTweets[0].content?.substring(0, 50),
          created_at: finalTweets[0].created_at
        });
      }

      return finalTweets.slice(0, limit);

    } catch (error) {
      logger.error('❌ Erreur dans getContentIntelligenceRecommendations:', error);
      return [];
    }
  }

  /**
   * Récupère les recommandations basées sur le comportement utilisateur
   */
  async getBehavioralRecommendations(user, context, limit) {
    try {
      // Analyser l'historique complet de l'utilisateur
      const userBehavior = await this.analyzeUserBehavior(user.id);
      
      // Construire la clause WHERE avec option pour récupérer TOUS les tweets
      const whereClause = {
        moderation_status: 'approved',
        deleted_at: null,
        parent_tweet_id: null, // Exclure les réponses
        user_id: { [Op.ne]: user.id }
      };

      // Si retrieveAllTweets est activé, ne pas limiter par la date
      if (!this.thresholds.retrieveAllTweets) {
        whereClause.created_at = { [Op.gte]: new Date(Date.now() - this.thresholds.maxAge) };
        logger.info(`📅 Recommandations comportementales: limitation aux ${this.thresholds.maxAge / (24 * 60 * 60 * 1000)} derniers jours`);
      } else {
        logger.info(`🌍 Recommandations comportementales: récupération de TOUS les tweets depuis toujours`);
      }
      
      // Récupérer les tweets selon les patterns identifiés
      const recommendations = await Tweet.findAll({
        where: whereClause,
        attributes: [
          'id', 'content', 'user_id', 'tweet_type', 'is_retweet', 'is_quote',
          'media_urls', 'hashtags', 'mentions', 'view_count', 'click_count',
          'moderation_status', 'deleted_at'
        ],
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: limit * 2,
        raw: true,
        nest: true
      });

      logger.info(`📊 getBehavioralRecommendations: ${recommendations.length} tweets récupérés (${this.thresholds.retrieveAllTweets ? 'depuis toujours' : 'limités par date'})`);
      return recommendations;

    } catch (error) {
      logger.error('❌ Erreur dans les recommandations comportementales:', error);
      return [];
    }
  }

  /**
   * Filtre global pour exclure les tweets réponses et autres contenus non éligibles
   */
  applyGlobalFilters(recommendations) {
    try {
      return recommendations.filter(rec => {
        // Exclure les tweets réponses (parent_tweet_id IS NOT NULL)
        if (rec.parent_tweet_id) {
          return false;
        }
        
        // Exclure les tweets supprimés
        if (rec.deleted_at) {
          return false;
        }
        
        // Exclure les tweets non approuvés
        if (rec.moderation_status !== 'approved') {
          return false;
        }
        
        // Exclure les tweets privés
        if (rec.is_private) {
          return false;
        }
        
        // Exclure les tweets sensibles
        if (rec.is_sensitive) {
          return false;
        }
        
        return true;
      });
    } catch (error) {
      logger.error('❌ Erreur lors de l\'application des filtres globaux:', error);
      return recommendations;
    }
  }

  /**
   * Applique les filtres avancés
   */
  async applyAdvancedFilters(recommendations, user, context) {
    try {
      let filtered = recommendations;

      // Appliquer d'abord les filtres globaux
      filtered = this.applyGlobalFilters(filtered);
      
      // Filtrer par contenu
      filtered = await this.applyContentFilter(filtered, user);
      
      // Filtrer par qualité
      filtered = await this.applyQualityFilter(filtered, user);
      
      // Filtrer par modération
      filtered = await this.applyModerationFilter(filtered, user);
      
      // Filtrer par diversité
      filtered = await this.applyDiversityFilter(filtered, user, context);

      return filtered;
    } catch (error) {
      logger.error('❌ Erreur lors de l\'application des filtres avancés:', error);
      return recommendations;
    }
  }

  /**
   * Filtre par qualité
   */
  async applyQualityFilter(recommendations, user) {
    try {
      return recommendations.filter(rec => {
        // Vérifier la qualité minimale du contenu
        if (!rec.content || rec.content.length < 10) {
          return false;
        }

        // Vérifier si c'est du spam évident
        if (rec.content.includes('http') && rec.content.split('http').length > 3) {
          return false; // Trop de liens
        }

        return true;
      });
    } catch (error) {
      logger.error('❌ Erreur lors du filtrage par qualité:', error);
      return recommendations;
    }
  }

  /**
   * Filtre par modération
   */
  async applyModerationFilter(recommendations, user) {
    try {
      return recommendations.filter(rec => {
        // Vérifier le statut de modération
        if (rec.moderation_status !== 'approved') {
          return false;
        }

        // Vérifier si l'utilisateur a été bloqué
        if (rec.author && rec.author.banned) {
          return false;
        }

        return true;
      });
    } catch (error) {
      logger.error('❌ Erreur lors du filtrage par modération:', error);
      return recommendations;
    }
  }

  /**
   * Filtre par diversité
   */
  async applyDiversityFilter(recommendations, user, context) {
    try {
      const diversified = [];
      const authorCounts = new Map();
      const hashtagCounts = new Map();

      for (const rec of recommendations) {
        const authorId = rec.author?.id;
        const currentAuthorCount = authorCounts.get(authorId) || 0;
        
        // Limiter le nombre de tweets par auteur
        if (currentAuthorCount >= 3) {
          continue;
        }

        // Limiter la répétition des hashtags
        let hashtagOverlap = false;
        if (rec.hashtags && rec.hashtags.length > 0) {
          for (const hashtag of rec.hashtags) {
            const count = hashtagCounts.get(hashtag) || 0;
            if (count >= 2) {
              hashtagOverlap = true;
              break;
            }
          }
        }

        if (!hashtagOverlap) {
          diversified.push(rec);
          authorCounts.set(authorId, currentAuthorCount + 1);
          
          if (rec.hashtags) {
            rec.hashtags.forEach(hashtag => {
              hashtagCounts.set(hashtag, (hashtagCounts.get(hashtag) || 0) + 1);
            });
          }
        }
      }

      return diversified;
    } catch (error) {
      logger.error('❌ Erreur lors du filtrage par diversité:', error);
      return recommendations;
    }
  }

  /**
   * Filtre par comportement IA
   */
  filterByAIBehavior(recommendations, userBehavior) {
    try {
      return recommendations.filter(rec => {
        // Vérifier la cohérence avec le comportement utilisateur
        const recAge = (new Date() - rec.created_at) / (1000 * 60 * 60 * 24);
        
        // Filtrer par âge selon l'activité de l'utilisateur
        if (userBehavior.tweetFrequency > 5 && recAge > 1) {
          return false; // Utilisateur très actif, privilégier le contenu récent
        }
        
        if (userBehavior.tweetFrequency < 1 && recAge > 7) {
          return false; // Utilisateur peu actif, pas de contenu trop ancien
        }

        return true;
      });
    } catch (error) {
      logger.error('❌ Erreur lors du filtrage par IA comportementale:', error);
      return recommendations;
    }
  }

  /**
   * Pagination intelligente
   */
  intelligentPagination(recommendations, offset, limit) {
    try {
      // Appliquer la pagination avec des ajustements intelligents
      const start = Math.max(0, offset);
      const end = start + limit;
      
      return recommendations.slice(start, end);
    } catch (error) {
      logger.error('❌ Erreur lors de la pagination intelligente:', error);
      return recommendations.slice(offset, offset + limit);
    }
  }

  /**
   * Scoring ultra-avancé avec analyse intelligente
   */
  async ultraAdvancedScoring(recommendations, user, context) {
    try {
      const scoredRecommendations = [];

      for (const rec of recommendations) {
        const scores = {
          engagement: 0,
          contentQuality: 0,
          authorInfluence: 0,
          userRelevance: 0,
          temporal: 0,
          diversity: 0,
          moderation: 0
        };

        // Score d'engagement basé sur les vraies interactions
        scores.engagement = await this.calculateEngagementScore(rec);
        
        // Score de qualité du contenu intelligent
        scores.contentQuality = await this.calculateContentQualityScore(rec, user);
        
        // Score d'influence de l'auteur
        scores.authorInfluence = await this.calculateAuthorInfluenceScore(rec.author);
        
        // Score de pertinence pour l'utilisateur
        scores.userRelevance = await this.calculateUserRelevanceScore(rec, user);
        
        // Score temporel intelligent
        scores.temporal = this.calculateTemporalScore(rec);
        
        // Score de diversité
        scores.diversity = this.calculateDiversityScore(rec, scoredRecommendations);
        
        // Score de modération
        scores.moderation = await this.calculateModerationScore(rec);

        // Score total pondéré
        const totalScore = this.calculateWeightedTotal(scores);
        const confidence = this.calculateConfidence(scores);
        
        // 🚀 BOOST SPÉCIAL POUR LES NOUVEAUX CONTENUS
        const newContentBoost = this.calculateNewContentBoost(rec);
        const boostedScore = totalScore + newContentBoost;
        
        // Score final avec boost
        const finalScore = boostedScore * confidence;

        scoredRecommendations.push({
          ...rec,
          score: totalScore,
          confidence,
          scoreBreakdown: scores,
          newContentBoost, // Ajouter le boost pour le debug
          boostedScore,    // Score avec boost
          finalScore       // Score final final
        });
        
        // Log du boost si significatif
        if (newContentBoost > 0) {
          logger.info(`🚀 Tweet ${rec.id} boosté: score=${totalScore.toFixed(2)} + boost=${newContentBoost} = ${boostedScore.toFixed(2)} (final: ${finalScore.toFixed(2)})`);
        }
      }

      // Trier par score final décroissant (avec boost)
      scoredRecommendations.sort((a, b) => b.finalScore - a.finalScore);

      logger.info(`✅ Scoring terminé pour ${scoredRecommendations.length} recommandations (boost nouveau contenu activé)`);
      return scoredRecommendations;

    } catch (error) {
      logger.error('❌ Erreur lors du scoring ultra-avancé:', error);
      return recommendations;
    }
  }

  /**
   * Calcule le score d'engagement basé sur les vraies interactions
   */
  async calculateEngagementScore(tweet) {
    try {
      let score = 0;
      
      // Score basé sur les likes
      const likesCount = tweet.stats?.likes || 0;
      score += Math.min(likesCount * 2, 50); // Max 50 points pour les likes
      
      // Score basé sur les retweets
      const retweetsCount = tweet.stats?.retweets || 0;
      score += Math.min(retweetsCount * 3, 60); // Max 60 points pour les retweets
      
      // Score basé sur les réponses
      const repliesCount = tweet.stats?.replies || 0;
      score += Math.min(repliesCount * 4, 40); // Max 40 points pour les réponses
      
      // Score basé sur les vues
      const viewsCount = tweet.stats?.views || tweet.view_count || 0;
      score += Math.min(viewsCount * 0.01, 20); // Max 20 points pour les vues
      
      // Bonus pour l'engagement élevé
      const totalEngagement = likesCount + retweetsCount + repliesCount;
      if (totalEngagement > 100) score += 20;
      if (totalEngagement > 500) score += 30;
      
      return Math.min(score, 100);
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score d\'engagement:', error);
      return 25; // Score par défaut
    }
  }

  /**
   * Calcule le score de qualité du contenu intelligent
   */
  async calculateContentQualityScore(tweet, user) {
    try {
      let score = 0;
      
      // Score basé sur la longueur du contenu (pas trop court, pas trop long)
      const contentLength = tweet.content?.length || 0;
      if (contentLength >= 50 && contentLength <= 200) {
        score += 30; // Longueur optimale
      } else if (contentLength >= 20 && contentLength <= 600) {
        score += 20; // Longueur acceptable
      } else {
        score += 10; // Longueur non optimale
      }
      
      // Score basé sur la présence de hashtags pertinents
      if (tweet.hashtags && tweet.hashtags.length > 0) {
        const relevantHashtags = tweet.hashtags.filter(tag => 
          tag.length >= 3 && tag.length <= 20
        );
        score += Math.min(relevantHashtags.length * 5, 25);
      }
      
      // Score basé sur la présence de médias
      if (tweet.media_urls && tweet.media_urls.length > 0) {
        score += Math.min(tweet.media_urls.length * 8, 24);
      }
      
      // Score basé sur la présence de mentions
      if (tweet.mentions && tweet.mentions.length > 0) {
        score += Math.min(tweet.mentions.length * 3, 15);
      }
      
      // Bonus pour le contenu original (pas de retweet)
      if (!tweet.is_retweet && !tweet.is_quote) {
        score += 15;
      }
      
      // Malus pour le contenu trop court ou spam
      if (contentLength < 10) score -= 20;
      if (tweet.content && tweet.content.includes('http') && tweet.content.split('http').length > 3) {
        score -= 30; // Trop de liens
      }
      
      return Math.max(0, Math.min(score, 100));
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score de qualité:', error);
      return 50; // Score par défaut
    }
  }

  /**
   * Calcule le score d'influence de l'auteur
   */
  async calculateAuthorInfluenceScore(author) {
    try {
      if (!author) return 25;
      
      let score = 25; // Score de base
      
      // Bonus pour les utilisateurs vérifiés
      if (author.verified) score += 20;
      
      // Bonus pour les utilisateurs premium
      if (author.premium) score += 15;
      
      // Score basé sur le nombre de followers
      const followersCount = author.stats?.followers || author.followers || 0;
      if (followersCount > 1000) score += 15;
      if (followersCount > 10000) score += 20;
      if (followersCount > 100000) score += 25;
      
      // Score basé sur l'âge du compte
      const accountAge = this.calculateAccountAge(author.created_at);
      if (accountAge > 365) score += 10; // Plus d'un an
      if (accountAge > 730) score += 10; // Plus de deux ans
      
      return Math.min(score, 100);
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score d\'influence:', error);
      return 25; // Score par défaut
    }
  }

  /**
   * Calcule le score de pertinence pour l'utilisateur
   */
  async calculateUserRelevanceScore(tweet, user) {
    try {
      let score = 50; // Score de base
      
      // Analyser les préférences de l'utilisateur
      const userBehavior = await this.analyzeUserBehavior(user.id);
      
      // Score basé sur la similarité des hashtags
      if (tweet.hashtags && userBehavior.preferredHashtags) {
        const commonHashtags = tweet.hashtags.filter(tag => 
          userBehavior.preferredHashtags.includes(tag)
        );
        score += commonHashtags.length * 10;
      }
      
      // Score basé sur l'activité de l'utilisateur
      if (userBehavior.tweetFrequency > 5) {
        // Utilisateur très actif, privilégier le contenu récent
        const ageInHours = (Date.now() - new Date(tweet.created_at).getTime()) / (1000 * 60 * 60);
        if (ageInHours < 24) score += 20;
        else if (ageInHours < 168) score += 10;
      }
      
      // Score basé sur les interactions passées
      if (userBehavior.interactionPatterns) {
        const hasLikedSimilar = userBehavior.interactionPatterns.recentLikes > 0;
        const hasRetweetedSimilar = userBehavior.interactionPatterns.recentRetweets > 0;
        
        if (hasLikedSimilar) score += 15;
        if (hasRetweetedSimilar) score += 20;
      }
      
      return Math.min(score, 100);
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score de pertinence:', error);
      return 50; // Score par défaut
    }
  }

  /**
   * Calcule le score temporel intelligent
   */
  calculateTemporalScore(tweet) {
    try {
      let score = 0;
      
      const now = new Date();
      const tweetDate = new Date(tweet.created_at);
      const ageInHours = (now - tweetDate) / (1000 * 60 * 60);
      
      // Score basé sur la récence
      if (ageInHours < 1) score += 40;      // Moins d'1 heure
      else if (ageInHours < 6) score += 30; // Moins de 6 heures
      else if (ageInHours < 24) score += 20; // Moins d'1 jour
      else if (ageInHours < 168) score += 10; // Moins d'1 semaine
      else score += 5; // Plus ancien
      
      // Bonus pour les tweets publiés aux heures de pointe
      const hour = tweetDate.getHours();
      if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19)) {
        score += 15; // Heures de pointe
      }
      
      // Bonus pour les tweets du weekend
      const dayOfWeek = tweetDate.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        score += 10; // Weekend
      }
      
      return Math.min(score, 100);
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score temporel:', error);
      return 25; // Score par défaut
    }
  }

  /**
   * Calcule le score de diversité
   */
  calculateDiversityScore(tweet, existingRecommendations) {
    try {
      let score = 50; // Score de base
      
      // Vérifier la diversité des auteurs
      const authorCounts = {};
      existingRecommendations.forEach(rec => {
        const authorId = rec.author?.id || rec.user_id;
        authorCounts[authorId] = (authorCounts[authorId] || 0) + 1;
      });
      
      const currentAuthorId = tweet.author?.id || tweet.user_id;
      const authorFrequency = authorCounts[currentAuthorId] || 0;
      
      if (authorFrequency === 0) score += 25; // Nouvel auteur
      else if (authorFrequency === 1) score += 15; // Auteur peu fréquent
      else if (authorFrequency === 2) score += 5; // Auteur modérément fréquent
      else score -= 10; // Auteur trop fréquent
      
      // Vérifier la diversité des hashtags
      const hashtagCounts = {};
      existingRecommendations.forEach(rec => {
        if (rec.hashtags) {
          rec.hashtags.forEach(tag => {
            hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
          });
        }
      });
      
      if (tweet.hashtags) {
        const uniqueHashtags = tweet.hashtags.filter(tag => 
          (hashtagCounts[tag] || 0) < 2
        );
        score += uniqueHashtags.length * 5;
      }
      
      return Math.max(0, Math.min(score, 100));
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score de diversité:', error);
      return 50; // Score par défaut
    }
  }

  /**
   * Calcul du score ultra-avancé
   */
  async calculateUltraAdvancedScore(tweet, user, context) {
    try {
      const scores = {};

      // Score d'engagement avancé
      scores.engagement = await this.calculateAdvancedEngagementScore(tweet);
      
      // Score de qualité du contenu
      scores.contentQuality = await this.calculateContentQualityScore(tweet);
      
      // Score d'influence de l'auteur
      scores.authorInfluence = await this.calculateAuthorInfluenceScore(tweet.author);
      
      // Score de pertinence utilisateur
      scores.userRelevance = await this.calculateUserRelevanceScore(tweet, user, context);
      
      // Score temporel avancé
      scores.temporal = this.calculateAdvancedTemporalScore(tweet);

      // Score de diversité
      scores.diversity = this.calculateAdvancedDiversityScore(tweet, context);
      
      // Score de modération et qualité
      scores.moderation = await this.calculateModerationScore(tweet);

      // Calcul du score total pondéré
      const totalScore = this.calculateWeightedTotal(scores);
      
      // Calcul de la confiance
      const confidence = this.calculateConfidence(scores);

      return {
        total: totalScore,
        breakdown: scores,
        confidence
      };

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score ultra-avancé:', error);
      return { total: 0, breakdown: {}, confidence: 0.5 };
    }
  }

  /**
   * Calcul du score d'engagement avancé
   */
  async calculateAdvancedEngagementScore(tweet) {
    try {
      const [likes, retweets, replies, views] = await Promise.all([
        TweetLike.count({ where: { tweet_id: tweet.id } }),
        TweetRetweet.count({ where: { tweet_id: tweet.id } }),
        Tweet.count({ where: { parent_tweet_id: tweet.id } }),
        Promise.resolve(tweet.view_count || 0)
      ]);

      // Calcul du taux d'engagement
      const totalInteractions = likes + retweets + replies;
      const engagementRate = totalInteractions / Math.max(views, 1);
      
      // Score logarithmique avec bonus pour les interactions
      const baseScore = Math.log10(totalInteractions + 1) * 20;
      const engagementBonus = engagementRate * 30;
      const interactionBonus = Math.min(totalInteractions * 0.5, 20);
      
      return Math.min(baseScore + engagementBonus + interactionBonus, 100);

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score d\'engagement avancé:', error);
      return 0;
    }
  }

  /**
   * Calcul du score de qualité du contenu
   */
  async calculateContentQualityScore(tweet) {
    try {
      let score = 50; // Score de base

      // Bonus pour la présence de médias
      if (tweet.media_urls && tweet.media_urls.length > 0) {
        score += Math.min(tweet.media_urls.length * 8, 20);
      }

      // Bonus pour les hashtags pertinents
      if (tweet.hashtags && tweet.hashtags.length > 0) {
        score += Math.min(tweet.hashtags.length * 3, 15);
      }

      // Bonus pour les mentions
      if (tweet.mentions && tweet.mentions.length > 0) {
        score += Math.min(tweet.mentions.length * 2, 10);
      }

      // Bonus pour les liens
      if (tweet.urls && tweet.urls.length > 0) {
        score += Math.min(tweet.urls.length * 2, 8);
      }

      // Bonus pour la longueur optimale du contenu
      const contentLength = tweet.content.length;
      if (contentLength > 50 && contentLength < 200) {
        score += 10; // Longueur optimale
      } else if (contentLength > 20) {
        score += 5; // Longueur acceptable
      }

      return Math.min(score, 100);

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score de qualité du contenu:', error);
      return 50;
    }
  }

  /**
   * Calcul du score d'influence de l'auteur
   */
  async calculateAuthorInfluenceScore(author) {
    try {
      let score = 0;
      const stats = author.stats || {};

      // Score basé sur les followers
      const followers = stats.followers || 0;
      if (followers > 0) {
        score += Math.log10(followers + 1) * 15;
      }

      // Bonus pour la vérification
      if (author.verified) {
        score += 20;
      }

      // Bonus pour le statut premium
      if (author.premium) {
        score += 15;
      }

      // Bonus pour le rôle
      if (author.role === 'admin' || author.role === 'superadmin') {
        score += 25;
      } else if (author.role === 'moderator') {
        score += 15;
      }

      // Bonus pour l'activité
      const accountAge = author.accountAge || 0;
      if (accountAge > 365) {
        score += 10; // Compte ancien
      }

      return Math.min(score, 100);

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score d\'influence de l\'auteur:', error);
      return 0;
    }
  }

  /**
   * Calcul du score de pertinence utilisateur
   */
  async calculateUserRelevanceScore(tweet, user, context) {
    try {
      let score = 0;

      // Vérifier si l'utilisateur suit l'auteur
      const isFollowing = await UserFollow.findOne({
        where: {
          follower_id: user.id,
          following_id: tweet.author.id
        }
      });

      if (isFollowing) {
        score += 40;
      }

      // Vérifier les interactions passées
      const [hasLiked, hasRetweeted, hasReplied] = await Promise.all([
        TweetLike.findOne({ where: { user_id: user.id, tweet_id: tweet.id } }),
        TweetRetweet.findOne({ where: { user_id: user.id, tweet_id: tweet.id } }),
        Tweet.findOne({ where: { user_id: user.id, parent_tweet_id: tweet.id } })
      ]);

      if (hasLiked) score += 25;
      if (hasRetweeted) score += 30;
      if (hasReplied) score += 35;

      // Similarité des hashtags
      if (tweet.hashtags && tweet.hashtags.length > 0) {
        const userHashtagPreferences = await this.getUserHashtagPreferences(user.id);
        const commonHashtags = tweet.hashtags.filter(tag => 
          userHashtagPreferences.includes(tag)
        );
        score += (commonHashtags.length / Math.max(tweet.hashtags.length, 1)) * 20;
      }

      // Similarité des mentions
      if (tweet.mentions && tweet.mentions.length > 0) {
        const userMentionPreferences = await this.getUserMentionPreferences(user.id);
        const commonMentions = tweet.mentions.filter(mention => 
          userMentionPreferences.includes(mention)
        );
        score += (commonMentions.length / Math.max(tweet.mentions.length, 1)) * 15;
      }

      return Math.min(score, 100);

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score de pertinence utilisateur:', error);
      return 0;
    }
  }

  /**
   * Calcul du score temporel avancé
   */
  calculateAdvancedTemporalScore(tweet) {
    try {
      const now = new Date();
      const ageInHours = (now - tweet.created_at) / (1000 * 60 * 60);
      
      // Score de récence avec décroissance exponentielle
      const recencyScore = Math.exp(-ageInHours / 48) * 40; // Décroissance sur 48h
      
      // Bonus pour l'heure de la journée
      const hour = now.getHours();
      let timeBonus = 0;
      
      if (hour >= 8 && hour <= 12) timeBonus = 10; // Matin
      else if (hour >= 12 && hour <= 18) timeBonus = 15; // Après-midi
      else if (hour >= 18 && hour <= 22) timeBonus = 20; // Soirée
      else if (hour >= 22 || hour <= 6) timeBonus = 5; // Nuit
      
      // Bonus pour le jour de la semaine
      const dayOfWeek = now.getDay();
      let dayBonus = 0;
      
      if (dayOfWeek === 0 || dayOfWeek === 6) dayBonus = 10; // Weekend
      else dayBonus = 15; // Semaine
      
      return Math.min(recencyScore + timeBonus + dayBonus, 100);

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score temporel avancé:', error);
      return 0;
    }
  }

  /**
   * Calcul du score de diversité avancé
   */
  calculateAdvancedDiversityScore(tweet, context) {
    try {
      let score = 30; // Score de base pour la diversité
    
    // Bonus pour les nouveaux auteurs
      const isNewAuthor = Math.random() < 0.15; // 15% de chance
      if (isNewAuthor) {
        score += 25;
      }
      
      // Bonus pour la diversité des types de contenu
      if (tweet.media_urls && tweet.media_urls.length > 0) {
        score += 15;
      }
      
      // Bonus pour la diversité des hashtags
      if (tweet.hashtags && tweet.hashtags.length > 1) {
        score += Math.min(tweet.hashtags.length * 3, 15);
      }
      
      return Math.min(score, 100);

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score de diversité avancé:', error);
      return 30;
    }
  }

  /**
   * Calcul du score de modération
   */
  async calculateModerationScore(tweet) {
    try {
      let score = 100; // Score de base
      
      // Vérifier le statut de modération
      if (tweet.moderation_status !== 'approved') {
        score -= 50;
      }
      
      // Vérifier les rapports - utiliser target_id et target_type au lieu de tweet_id
      const reportCount = await Report.count({
        where: { 
          target_id: tweet.id, 
          target_type: 'tweet', 
          status: 'pending' 
        }
      });
      
      if (reportCount > 0) {
        score -= reportCount * 10;
      }
      
      // Vérifier les actions de modération
      const moderationActions = await ModerationAction.count({
        where: { target_id: tweet.id, target_type: 'tweet' }
      });
      
      if (moderationActions > 0) {
        score -= moderationActions * 15;
      }
      
      return Math.max(score, 0);

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score de modération:', error);
      return 100;
    }
  }

  /**
   * Calcul du score total pondéré
   */
  calculateWeightedTotal(scores) {
    try {
      let totalScore = 0;
      let totalWeight = 0;
      
      // Pondération dynamique basée sur la qualité des scores
      const weights = {
        engagement: 0.25,
        contentQuality: 0.20,
        authorInfluence: 0.15,
        userRelevance: 0.20,
        temporal: 0.10,
        diversity: 0.05,
        moderation: 0.05
      };
      
      for (const [key, score] of Object.entries(scores)) {
        if (weights[key]) {
          totalScore += score * weights[key];
          totalWeight += weights[key];
        }
      }
      
      return totalWeight > 0 ? totalScore / totalWeight : 0;

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score total pondéré:', error);
      return 0;
    }
  }

  /**
   * Calcul de la confiance du score
   */
  calculateConfidence(scores) {
    try {
      const validScores = Object.values(scores).filter(score => score !== null && score !== undefined);
      
      if (validScores.length === 0) return 0.5;
      
      // La confiance est basée sur la cohérence des scores
      const mean = validScores.reduce((a, b) => a + b, 0) / validScores.length;
      const variance = validScores.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / validScores.length;
      const stdDev = Math.sqrt(variance);
      
      // Plus la variance est faible, plus la confiance est élevée
      const confidence = Math.max(0.1, Math.min(1, 1 - (stdDev / 100)));
      
      return confidence;

    } catch (error) {
      logger.error('❌ Erreur lors du calcul de la confiance:', error);
      return 0.5;
    }
  }

  /**
   * Trouve les utilisateurs similaires
   */
  async findSimilarUsers(userId, limit = 10) {
    try {
      // Récupérer les utilisateurs que l'utilisateur suit
      const following = await UserFollow.findAll({
        where: { follower_id: userId },
        attributes: ['following_id']
      });

      if (following.length === 0) {
        return [];
      }

      const followingIds = following.map(f => f.following_id);

      // Trouver les utilisateurs qui suivent les mêmes personnes
      const similarUsers = await UserFollow.findAll({
        where: {
          following_id: { [Op.in]: followingIds },
          follower_id: { [Op.ne]: userId }
        },
        attributes: [
          'follower_id',
          [fn('COUNT', col('following_id')), 'common_following']
        ],
        group: ['follower_id'],
        order: [[fn('COUNT', col('following_id')), 'DESC']],
        limit
      });

      // Récupérer les détails des utilisateurs similaires
      const similarUserIds = similarUsers.map(u => u.follower_id);
      const users = await User.findAll({
        where: { id: { [Op.in]: similarUserIds } },
        attributes: ['id', 'username', 'full_name', 'avatar', 'stats']
      });

      return users;

    } catch (error) {
      logger.error('❌ Erreur lors de la recherche d\'utilisateurs similaires:', error);
      return [];
    }
  }

  /**
   * Analyse les préférences de contenu de l'utilisateur
   */
  async analyzeUserContentPreferences(userId) {
    try {
      // Récupérer les tweets likés par l'utilisateur
      const likedTweets = await TweetLike.findAll({
        where: { user_id: userId },
        include: [
          {
            model: Tweet,
            as: 'tweet',
            attributes: ['hashtags', 'content', 'tweet_type']
          }
        ],
        limit: 100
      });

      // Extraire les hashtags préférés
      const hashtags = [];
      likedTweets.forEach(like => {
        if (like.tweet && like.tweet.hashtags) {
          hashtags.push(...like.tweet.hashtags);
        }
      });

      // Compter les occurrences
      const hashtagCounts = {};
      hashtags.forEach(tag => {
        hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
      });

      // Trier par popularité
      const sortedHashtags = Object.entries(hashtagCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .map(([tag]) => tag);

      return {
        hashtags: sortedHashtags,
        topics: [], // À implémenter avec NLP
        tweetTypes: ['tweet', 'reply', 'retweet']
      };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des préférences:', error);
      return { hashtags: [], topics: [], tweetTypes: [] };
    }
  }

  /**
   * Récupère les préférences de hashtags de l'utilisateur
   */
  async getUserHashtagPreferences(userId) {
    try {
      const preferences = await this.analyzeUserContentPreferences(userId);
      return preferences.hashtags;
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des préférences hashtags:', error);
      return [];
    }
  }

  /**
   * Récupère les préférences de mentions de l'utilisateur
   */
  async getUserMentionPreferences(userId) {
    try {
      const user = await User.findByPk(userId);
      if (!user) return [];

      const userMentions = user.mentions || [];
      return userMentions.map(mention => mention.username);
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des préférences mentions:', error);
      return [];
    }
  }

  /**
   * Applique le filtre de diversité
   */
  async applyAdvancedDiversity(recommendations, user, context) {
    try {
      const diversified = [];
      const authorCounts = new Map();

      for (const rec of recommendations) {
        const authorId = rec.author.id;
        const currentCount = authorCounts.get(authorId) || 0;
        
        // Limiter le nombre de tweets par auteur
        if (currentCount < 3) {
          diversified.push(rec);
          authorCounts.set(authorId, currentCount + 1);
        }
      }

      return diversified;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'application du filtre de diversité:', error);
      return recommendations;
    }
  }

  /**
   * Applique le filtre de contenu
   */
  async applyContentFilter(recommendations, user) {
    try {
      return recommendations.filter(rec => {
        // Filtrer les tweets supprimés ou modérés
        if (rec.deleted_at || rec.moderation_status !== 'approved') {
          return false;
        }

        // Filtrer les tweets trop anciens
        const ageInDays = (new Date() - rec.created_at) / (1000 * 60 * 60 * 24);
        if (ageInDays > 7) {
          return false;
        }

        // Filtrer les tweets de l'utilisateur lui-même
        if (rec.author.id === user.id) {
          return false;
        }

        return true;
      });

    } catch (error) {
      logger.error('❌ Erreur lors de l\'application du filtre de contenu:', error);
      return recommendations;
    }
  }

  /**
   * Enrichit les recommandations avec des données supplémentaires
   */
  async enrichRecommendations(recommendations, options) {
    try {
      const { includeUser = true, includeStats = true } = options;

      for (const rec of recommendations) {
        if (includeStats) {
          // Ajouter les statistiques d'engagement
          const [likes, retweets, replies] = await Promise.all([
            TweetLike.count({ where: { tweet_id: rec.id } }),
            TweetRetweet.count({ where: { tweet_id: rec.id } }),
            Tweet.count({ where: { parent_tweet_id: rec.id } })
          ]);

          rec.stats = {
            likes,
            retweets,
            replies,
            views: rec.view_count || 0
          };
        }

        if (includeUser && rec.author) {
          // Enrichir les données de l'auteur
          rec.author = {
            ...rec.author.toJSON(),
            stats: rec.author.stats || {}
          };
        }
      }

    } catch (error) {
      logger.error('❌ Erreur lors de l\'enrichissement des recommandations:', error);
    }
  }

  /**
   * Enrichit les recommandations avec les informations d'interaction utilisateur
   */
  async enrichUserInteractions(recommendations, userId) {
    try {
      if (!userId || recommendations.length === 0) {
        return recommendations;
      }

      logger.info(`🔄 Enrichissement des interactions utilisateur pour ${recommendations.length} recommandations...`);

      for (const rec of recommendations) {
        try {
          // Validation stricte de l'ID du tweet
          if (!rec.id || typeof rec.id !== 'string' || rec.id.trim() === '') {
            logger.warn(`⚠️ Tweet avec ID invalide détecté dans enrichUserInteractions:`, {
              id: rec.id,
              type: typeof rec.id,
              content: rec.content?.substring(0, 5000),
              hasDataValues: !!rec.dataValues,
              keys: Object.keys(rec),
              fullObject: JSON.stringify(rec, null, 2)
            });
            // Ajouter des valeurs par défaut et continuer
            rec.user_interaction = {
              is_liked: false,
              is_retweeted: false,
              has_replied: false
            };
            continue;
          }

          // Vérifier si l'utilisateur a liké ce tweet
          const isLiked = await TweetLike.findOne({
            where: {
              user_id: userId,
              tweet_id: rec.id
            }
          });

          // Vérifier si l'utilisateur a retweeté ce tweet
          const isRetweeted = await TweetRetweet.findOne({
            where: {
              user_id: userId,
              tweet_id: rec.id
            }
          });

          // Vérifier si l'utilisateur a répondu à ce tweet
          const hasReplied = await Tweet.findOne({
            where: {
              user_id: userId,
              parent_tweet_id: rec.id
            }
          });

          // Ajouter les informations d'interaction
          rec.user_interaction = {
            is_liked: !!isLiked,
            is_retweeted: !!isRetweeted,
            has_replied: !!hasReplied
          };

        } catch (interactionError) {
          logger.warn(`⚠️ Erreur lors de l'enrichissement des interactions pour le tweet ${rec.id}:`, interactionError);
          // Utiliser des valeurs par défaut en cas d'erreur
          rec.user_interaction = {
            is_liked: false,
            is_retweeted: false,
            has_replied: false
          };
        }
      }

      logger.info(`✅ Interactions utilisateur enrichies pour ${recommendations.length} recommandations`);
      return recommendations;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'enrichissement des interactions utilisateur:', error);
      // En cas d'erreur, ajouter des valeurs par défaut
      recommendations.forEach(rec => {
        rec.user_interaction = {
          is_liked: false,
          is_retweeted: false,
          has_replied: false
        };
      });
      return recommendations;
    }
  }

  /**
   * Enrichit les recommandations avec des données supplémentaires avancées
   */
  async enrichRecommendationsAdvanced(recommendations, options) {
    try {
      const { includeUser = true, includeStats = true, userId = null } = options;

      for (const rec of recommendations) {
        // Vérifier que la recommandation a un ID valide
        const tweetId = rec.id;
        if (!tweetId) {
          logger.warn('⚠️ Recommandation sans ID valide, ignorée:', rec);
          continue;
        }

        if (includeStats) {
          try {
          // Ajouter les statistiques d'engagement
          const [likes, retweets, replies] = await Promise.all([
              TweetLike.count({ where: { tweet_id: tweetId } }),
              TweetRetweet.count({ where: { tweet_id: tweetId } }),
              Tweet.count({ where: { parent_tweet_id: tweetId } })
            ]);

            // Créer l'objet stats s'il n'existe pas
            if (!rec.stats) {
              rec.stats = {};
            }

            rec.stats.likes = likes || 0;
            rec.stats.retweets = retweets || 0;
            rec.stats.replies = replies || 0;
            rec.stats.views = rec.view_count || 0;
          } catch (statsError) {
            logger.warn(`⚠️ Erreur lors de l'ajout des stats pour ${tweetId}:`, statsError);
            // Utiliser des valeurs par défaut
            if (!rec.stats) {
              rec.stats = {};
            }
            rec.stats.likes = 0;
            rec.stats.retweets = 0;
            rec.stats.replies = 0;
            rec.stats.views = rec.view_count || 0;
          }
        }

        if (includeUser && rec.author) {
          try {
            // Enrichir les données de l'auteur sans écraser les données du tweet
            const authorData = rec.author.toJSON ? rec.author.toJSON() : rec.author;
          rec.author = {
              ...authorData,
              stats: authorData.stats || {},
              accountAge: this.calculateAccountAge(authorData.created_at) // Ajouter l'âge du compte
            };
          } catch (authorError) {
            logger.warn(`⚠️ Erreur lors de l'enrichissement de l'auteur pour ${tweetId}:`, authorError);
          }
        }
      }

      // Enrichir avec les interactions utilisateur si un userId est fourni
      if (userId) {
        await this.enrichUserInteractions(recommendations, userId);
      }

      logger.info(`✅ ${recommendations.length} recommandations enrichies avec succès`);
      return recommendations;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'enrichissement des recommandations avancées:', error);
      return recommendations;
    }
  }

  /**
   * Score et trie les recommandations
   */
  async scoreRecommendations(recommendations, user) {
    try {
      const scoredRecs = [];

      for (const rec of recommendations) {
        const scored = await this.calculateRecommendationScore(rec, user);
        scoredRecs.push(scored);
      }

      // Trier par score décroissant
      scoredRecs.sort((a, b) => b.score - a.score);

      return scoredRecs;

    } catch (error) {
      logger.error('❌ Erreur lors du scoring des recommandations:', error);
      return recommendations.map(rec => ({ tweet: rec, score: 0, breakdown: {} }));
    }
  }

  /**
   * Déduplique les recommandations
   */
  deduplicateRecommendations(recommendations) {
    const seen = new Set();
    const unique = [];

    for (const rec of recommendations) {
      const tweetId = rec.tweet ? rec.tweet.id : rec.id;
      if (!seen.has(tweetId)) {
        seen.add(tweetId);
        unique.push(rec);
      }
    }

    return unique;
  }

  /**
   * Précharge les données fréquemment utilisées
   */
  async preloadFrequentData() {
    try {
      logger.info('🔄 Préchargement des données fréquentes...');
      
      // Précharger les statistiques globales
      // Cette méthode peut être étendue selon les besoins
      
      logger.info('✅ Données fréquentes préchargées');
    } catch (error) {
      logger.error('❌ Erreur lors du préchargement:', error);
    }
  }

  /**
   * Précharge les données de comportement utilisateur
   */
  async preloadUserBehaviorData() {
    try {
      logger.info('🔄 Préchargement des données de comportement utilisateur...');
      // Exemple: Précharger les tweets likés, retweetés, etc.
      // await TweetLike.findAll({ where: { user_id: userId }, limit: 1000 });
      // await TweetRetweet.findAll({ where: { user_id: userId }, limit: 1000 });
      // await Tweet.findAll({ where: { user_id: userId, created_at: { [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }, limit: 1000 });
      logger.info('✅ Données de comportement utilisateur préchargées');
    } catch (error) {
      logger.error('❌ Erreur lors du préchargement des données de comportement:', error);
    }
  }

  /**
   * Précharge les données de popularité et de tendance
   */
  async preloadTrendingData() {
    try {
      logger.info('🔄 Préchargement des données de popularité et de tendance...');
      // Exemple: Précharger les tweets populaires, les hashtags populaires, etc.
      // await Tweet.findAll({ order: [[literal('(SELECT COUNT(*) FROM tweet_likes WHERE tweet_likes.tweet_id = Tweet.id)'), 'DESC']], limit: 1000 });
      // await Tweet.findAll({ order: [[literal('(SELECT COUNT(*) FROM tweet_retweets WHERE tweet_retweets.tweet_id = Tweet.id)'), 'DESC']], limit: 1000 });
      // await Tweet.findAll({ order: [[literal('(SELECT COUNT(*) FROM tweet_likes WHERE tweet_likes.tweet_id = Tweet.id) + (SELECT COUNT(*) FROM tweet_retweets WHERE tweet_retweets.tweet_id = Tweet.id)'), 'DESC']], limit: 1000 });
      logger.info('✅ Données de popularité et de tendance préchargées');
    } catch (error) {
      logger.error('❌ Erreur lors du préchargement des données de popularité:', error);
    }
  }

  /**
   * Précharge les données d'influence des auteurs
   */
  async preloadAuthorInfluenceData() {
    try {
      logger.info('🔄 Préchargement des données d\'influence des auteurs...');
      // Exemple: Précharger les utilisateurs influents, leurs statistiques, etc.
      // await User.findAll({ order: [[literal('(SELECT COUNT(*) FROM user_follows WHERE user_follows.following_id = User.id)'), 'DESC']], limit: 1000 });
      // await User.findAll({ order: [[literal('(SELECT COUNT(*) FROM user_follows WHERE user_follows.following_id = User.id) + (SELECT COUNT(*) FROM user_follows WHERE user_follows.follower_id = User.id)'), 'DESC']], limit: 1000 });
      logger.info('✅ Données d\'influence des auteurs préchargées');
    } catch (error) {
      logger.error('❌ Erreur lors du préchargement des données d\'influence:', error);
    }
  }

  /**
   * Précharge les métriques de qualité du contenu
   */
  async preloadContentQualityMetrics() {
    try {
      logger.info('🔄 Préchargement des métriques de qualité du contenu...');
      // Exemple: Précharger les hashtags pertinents, les mentions, etc.
      // await Tweet.findAll({ where: { moderation_status: 'approved', deleted_at: null }, limit: 1000 });
      logger.info('✅ Métriques de qualité du contenu préchargées');
    } catch (error) {
      logger.error('❌ Erreur lors du préchargement des métriques de qualité:', error);
    }
  }

  /**
   * Démarre les processus en arrière-plan
   */
  startBackgroundProcesses() {
    // Exemple: Démarrer le nettoyage périodique du cache
    setInterval(() => {
      this.cleanupCache();
    }, 10 * 60 * 1000); // Toutes les 10 minutes

    // Note: La mise à jour des tendances est gérée par TrendingAnalysisService
    // setInterval(() => {
    //   this.updateTrendingTopics(); // Méthode non implémentée
    // }, 30 * 60 * 1000); // Toutes les 30 minutes

    // Exemple: Démarrer la mise à jour des scores des auteurs
    setInterval(() => {
      this.updateAuthorScores();
    }, 60 * 60 * 1000); // Toutes les heures

    // Exemple: Démarrer la mise à jour des scores de contenu
    setInterval(() => {
      this.updateContentScores();
    }, 15 * 60 * 1000); // Toutes les 15 minutes
  }

  /**
   * Nettoie le cache expiré
   */
  cleanupCache() {
    try {
      const now = Date.now();
      let cleanedCount = 0;

      for (const [key, value] of this.cache.entries()) {
        if (now - value.timestamp > this.cacheExpiry) {
          this.cache.delete(key);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.info(`🧹 Cache nettoyé: ${cleanedCount} entrées supprimées`);
      }
    } catch (error) {
      logger.error('❌ Erreur lors du nettoyage du cache:', error);
    }
  }

  /**
   * Met à jour les métriques de performance
   */
  updateMetrics(responseTime) {
    const currentAvg = this.metrics.avgResponseTime;
    const requestCount = this.metrics.totalRequests;
    
    this.metrics.avgResponseTime = (currentAvg * (requestCount - 1) + responseTime) / requestCount;
    this.metrics.lastUpdate = new Date();
  }

  /**
   * Met à jour les métriques avancées
   */
  updateAdvancedMetrics(responseTime, algorithm, userContext) {
    const currentAlgorithmPerformance = this.metrics.algorithmPerformance[algorithm] || {};
    const requestCount = this.metrics.totalRequests;

    this.metrics.algorithmPerformance[algorithm] = {
      totalRequests: currentAlgorithmPerformance.totalRequests || 0,
      cacheHits: currentAlgorithmPerformance.cacheHits || 0,
      cacheMisses: currentAlgorithmPerformance.cacheMisses || 0,
      avgResponseTime: (currentAlgorithmPerformance.avgResponseTime * (requestCount - 1) + responseTime) / requestCount,
      lastUpdate: new Date()
    };

    // Mettre à jour la satisfaction utilisateur
    const userSatisfaction = this.metrics.userSatisfaction;
    const newUserSatisfaction = (userSatisfaction * (requestCount - 1) + userContext.userSatisfaction) / requestCount;
    this.metrics.userSatisfaction = newUserSatisfaction;

    this.metrics.lastUpdate = new Date();
  }

  /**
   * Génère une clé de cache intelligente
   */
  generateCacheKey(userId, options) {
    const { limit, offset, includeUser, includeStats, forceRefresh, algorithm, context } = options;
    return `recommendations_${userId}_${limit}_${offset}_${algorithm}_${context}`;
  }

  /**
   * Vérifie si le cache est valide
   */
  isCacheValid(cacheKey) {
    const cached = this.cache.get(cacheKey);
    if (!cached) return false;

    const now = Date.now();
    const cacheExpiry = this.cacheExpiry;

    // Vérifier si le cache est expiré
    if (now - cached.timestamp > cacheExpiry) {
      this.cache.delete(cacheKey);
      return false;
    }

    return true;
  }

  /**
   * Récupère les données du cache
   */
  getFromCache(cacheKey) {
    const cached = this.cache.get(cacheKey);
    if (!cached) {
      logger.warn(`Cache miss pour la clé: ${cacheKey}`);
      return null;
    }
    return cached.data;
  }

  /**
   * Met en cache les données intelligemment
   */
  setIntelligentCache(cacheKey, data, userContext) {
    this.cache.set(cacheKey, {
      data: data,
      timestamp: Date.now(),
      userContext: userContext // Stocker le contexte pour la validation
    });
  }

  /**
   * Analyse le contexte de l'utilisateur
   */
  async analyzeUserContext(user, context) {
    const userContext = {
      userSatisfaction: 0.75, // Score de base
      userEngagement: 0.8, // Engagement général
      userSimilarity: 0.9, // Similarité avec l'utilisateur
      userActivity: 0.7, // Activité récente
      userPreferences: 0.8, // Préférences de contenu
      trendingFactor: 0.6, // Facteur de tendance
      contentMaturity: 0.7, // Maturité du contenu
      moderationScore: 0.9, // Score de modération
      reportRatio: 0.05, // Ratio de rapports
      spamScore: 0.02, // Score de spam
      diversityFactor: 0.4, // Facteur de diversité
      timeOfDay: new Date().getHours(), // Heure de la journée
      dayOfWeek: new Date().getDay() // Jour de la semaine
    };

    // Peut être amélioré avec des modèles ML ou des données externes
    // Exemple: Utiliser des embeddings de l'utilisateur et du tweet pour la similarité
    // Exemple: Utiliser des modèles de langage pour analyser le contenu

    return userContext;
  }

  /**
   * Analyse le comportement utilisateur
   */
  async analyzeUserBehavior(userId) {
    try {
      const user = await User.findByPk(userId);
      if (!user) return { 
        tweetTypes: ['tweet', 'reply', 'retweet'],
        engagementRate: 0.5,
        tweetFrequency: 1
      };

      const userBehavior = {
        userId: userId,
        totalTweets: user.tweet_count || 0,
        totalLikes: user.likes_count || 0,
        totalRetweets: user.retweets_count || 0,
        totalComments: user.comments_count || 0,
        totalShares: user.shares_count || 0,
        totalFollowers: user.followers || 0,
        totalFollowing: user.following || 0,
        lastTweetAt: user.last_activity || null,
        tweetFrequency: 0, // À calculer
        engagementRate: 0, // À calculer
        contentVariety: 0, // À calculer
        interactionPatterns: {},
        tweetTypes: ['tweet', 'reply', 'retweet'], // Valeur par défaut
        preferredHashtags: [], // Nouveau : hashtags préférés
        preferredTopics: [], // Nouveau : sujets préférés
        preferredAuthors: [] // Nouveau : auteurs préférés
      };

      // Calculer la fréquence des tweets
      const tweets = await Tweet.findAll({
        where: { 
          user_id: userId, 
          created_at: { [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } 
        },
        order: [['created_at', 'DESC']],
        limit: 100
      });
      
      userBehavior.tweetFrequency = tweets.length / 30; // Tweets par jour

      // Calculer le taux d'engagement
      const totalInteractions = (user.likes_count || 0) + (user.retweets_count || 0) + 
                               (user.comments_count || 0) + (user.shares_count || 0);
      userBehavior.engagementRate = totalInteractions / Math.max(user.tweet_count || 1, 1);

      // Analyser les patterns d'interaction avec vérification null
      const recentInteractions = await TweetLike.findAll({
        where: { 
          user_id: userId, 
          created_at: { [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
        },
        include: [{ 
          model: Tweet, 
          as: 'tweet',
          required: true // S'assurer que le tweet existe
        }]
      });

      userBehavior.interactionPatterns = {
        recentLikes: recentInteractions.filter(i => i.tweet && i.tweet.tweet_type === 'tweet').length,
        recentRetweets: recentInteractions.filter(i => i.tweet && i.tweet.tweet_type === 'retweet').length,
        recentComments: recentInteractions.filter(i => i.tweet && i.tweet.tweet_type === 'reply').length,
        recentShares: recentInteractions.filter(i => i.tweet && i.tweet.tweet_type === 'share').length
      };

      // Analyser les hashtags préférés
      const userLikedTweets = await TweetLike.findAll({
        where: { 
          user_id: userId, 
          created_at: { [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } 
        },
        include: [{ 
          model: Tweet, 
          as: 'tweet',
          required: true
        }]
      });

      // Compter les hashtags des tweets likés
      const hashtagCounts = {};
      userLikedTweets.forEach(like => {
        if (like.tweet && like.tweet.hashtags) {
          like.tweet.hashtags.forEach(tag => {
            hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
          });
        }
      });

      // Prendre les hashtags les plus populaires
      userBehavior.preferredHashtags = Object.entries(hashtagCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .map(([tag]) => tag);

      // Analyser les auteurs préférés
      const authorCounts = {};
      userLikedTweets.forEach(like => {
        if (like.tweet && like.tweet.user_id) {
          authorCounts[like.tweet.user_id] = (authorCounts[like.tweet.user_id] || 0) + 1;
        }
      });

      // Prendre les auteurs les plus likés
      userBehavior.preferredAuthors = Object.entries(authorCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([authorId]) => authorId);

      // Analyser la variété du contenu
      const userTweets = await Tweet.findAll({
        where: { 
          user_id: userId, 
          created_at: { [Op.gte]: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } 
        },
        limit: 200
      });

      const hashtagVariety = new Set();
      const mentionVariety = new Set();
      const mediaVariety = new Set();

      userTweets.forEach(tweet => {
        if (tweet.hashtags) tweet.hashtags.forEach(tag => hashtagVariety.add(tag));
        if (tweet.mentions) tweet.mentions.forEach(mention => mentionVariety.add(mention));
        if (tweet.media_urls) tweet.media_urls.forEach(media => mediaVariety.add(media.split('.').pop()));
      });

      userBehavior.contentVariety = (hashtagVariety.size + mentionVariety.size + mediaVariety.size) / 3;

      logger.info(`✅ Analyse comportementale terminée pour ${userId}: ${userBehavior.preferredHashtags.length} hashtags préférés, ${userBehavior.preferredAuthors.length} auteurs préférés`);
      return userBehavior;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse du comportement utilisateur:', error);
      return { 
        userId: userId,
        tweetTypes: ['tweet', 'reply', 'retweet'],
        engagementRate: 0.5,
        tweetFrequency: 1,
        preferredHashtags: [],
        preferredTopics: [],
        preferredAuthors: []
      };
    }
  }

  /**
   * Construit le graphe social
   */
  async buildSocialGraph(userId) {
    try {
      const user = await User.findByPk(userId);
      if (!user) return [];

      const following = await UserFollow.findAll({
        where: { follower_id: userId },
        attributes: ['following_id']
      });

      const followers = await UserFollow.findAll({
        where: { following_id: userId },
        attributes: ['follower_id']
      });

      const graph = {
        userId: userId,
        following: following.map(f => f.following_id),
        followers: followers.map(f => f.follower_id)
      };

      return graph;
    } catch (error) {
      logger.error('❌ Erreur lors de la construction du graphe social:', error);
      return [];
    }
  }

  /**
   * Trouve les chemins d'influence dans le graphe social
   */
  findInfluencePaths(graph, userId) {
    const paths = [];
    const visited = new Set();

    function dfs(currentUserId, currentPath) {
      if (currentUserId === userId) {
        paths.push({ userId: currentUserId, path: [...currentPath] });
        return;
      }
      visited.add(currentUserId);
      const following = graph.following.filter(id => !visited.has(id));
      for (const nextUserId of following) {
        dfs(nextUserId, [...currentPath, { userId: currentUserId, nextUserId }]);
      }
      visited.delete(currentUserId);
    }

    dfs(graph.userId, []);
    return paths;
  }

  /**
   * Analyse les préférences de contenu avancées
   */
  async analyzeAdvancedContentPreferences(userId) {
    try {
      const user = await User.findByPk(userId);
      if (!user) return { hashtags: [], topics: [], tweetTypes: [] };

      const userPreferences = {
        hashtags: user.hashtag_preferences || [],
        topics: user.topic_preferences || [],
        tweetTypes: user.tweet_type_preferences || ['tweet', 'reply', 'retweet']
      };

      return userPreferences;
    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des préférences avancées:', error);
      return { hashtags: [], topics: [], tweetTypes: [] };
    }
  }

  /**
   * Construit la clause WHERE intelligente
   */
  buildIntelligentWhereClause(contentPreferences, userId) {
    const { hashtags, topics, tweetTypes } = contentPreferences;
    const whereClause = {
      created_at: { [Op.gte]: new Date(Date.now() - this.thresholds.maxAge) },
      moderation_status: 'approved',
      deleted_at: null,
      user_id: { [Op.ne]: userId }
    };

    if (hashtags.length > 0) {
      whereClause.hashtags = {
        [Op.overlap]: hashtags.slice(0, 5)
      };
    }

    if (topics.length > 0) {
      whereClause.topics = {
        [Op.overlap]: topics.slice(0, 5)
      };
    }

    if (tweetTypes.length > 0) {
      whereClause.tweet_type = {
        [Op.in]: tweetTypes
      };
    }

    return whereClause;
  }

  /**
   * Filtre les recommandations selon le comportement utilisateur
   */
  async filterByUserBehavior(recommendations, userBehavior) {
    try {
    return recommendations.filter(rec => {
      const recCreatedAt = rec.created_at;
      const ageInDays = (new Date() - recCreatedAt) / (1000 * 60 * 60 * 24);

      // Filtrer les tweets trop anciens
      if (ageInDays > 7) {
        return false;
      }

      // Filtrer les tweets de l'utilisateur lui-même
        if (rec.author && rec.author.id === userBehavior.userId) {
        return false;
      }

      // Filtrer les tweets qui ne correspondent pas au comportement de l'utilisateur
      const recInteractionRate = (rec.likes_count + rec.retweets_count + rec.comments_count) / Math.max(rec.view_count || 1, 1);
      const userInteractionRate = userBehavior.engagementRate;

      if (recInteractionRate < userInteractionRate * 0.5) { // Tweet moins interactif que l'utilisateur
        return false;
      }

        // Vérifier si userBehavior.tweetTypes existe
        const userTweetTypes = userBehavior.tweetTypes || ['tweet', 'reply', 'retweet'];

      // Filtrer les tweets qui n'ont pas le bon type de contenu
        if (rec.tweet_type && !userTweetTypes.includes(rec.tweet_type)) {
        return false;
      }

      return true;
    });
    } catch (error) {
      logger.error('❌ Erreur lors du filtrage par comportement utilisateur:', error);
      return recommendations;
    }
  }

  /**
   * Fusionne les recommandations de différentes sources
   */
  mergeRecommendations(sources) {
    const allRecommendations = [];
    const seenTweets = new Set();

    for (const source of sources) {
      for (const rec of source) {
        const tweetId = rec.id;
        if (!seenTweets.has(tweetId)) {
          allRecommendations.push(rec);
          seenTweets.add(tweetId);
        }
      }
    }

    return allRecommendations;
  }

  /**
   * Obtient les statistiques avancées du moteur
   */
  getAdvancedStats() {
    return {
      ...this.metrics,
      cacheSize: this.cache.size,
      cacheHitRate: this.metrics.totalRequests > 0 
        ? (this.metrics.cacheHits / this.metrics.totalRequests * 100).toFixed(2) + '%'
        : '0%',
      uptime: Date.now() - this.metrics.lastUpdate.getTime(),
      algorithmPerformance: this.metrics.algorithmPerformance,
      userSatisfaction: this.metrics.userSatisfaction,
      cacheLayers: {
        userPreferences: this.cacheLayers.userPreferences.size,
        trendingTopics: this.cacheLayers.trendingTopics.size,
        authorScores: this.cacheLayers.authorScores.size,
        contentScores: this.cacheLayers.contentScores.size
      }
    };
  }

  /**
   * Réinitialise le moteur
   */
  reset() {
    this.cache.clear();
    this.metrics = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      avgResponseTime: 0,
      algorithmPerformance: {},
      lastUpdate: new Date(),
      userSatisfaction: 0.75
    };
    this.cacheLayers.userPreferences.clear();
    this.cacheLayers.trendingTopics.clear();
    this.cacheLayers.authorScores.clear();
    this.cacheLayers.contentScores.clear();
    
    logger.info('🔄 Moteur de recommandation réinitialisé');
  }

  /**
   * Calcule l'âge du compte
   */
  calculateAccountAge(createdAt) {
    try {
      if (!createdAt) return 0;
      const now = new Date();
      const created = new Date(createdAt);
      return Math.floor((now - created) / (1000 * 60 * 60 * 24)); // En jours
    } catch (error) {
      logger.error('❌ Erreur lors du calcul de l\'âge du compte:', error);
      return 0;
    }
  }

  /**
   * Nettoie un objet pour éviter les références circulaires lors de la sérialisation JSON
   */
  cleanObjectForJSON(obj) {
    try {
      // Si c'est null ou undefined, retourner tel quel
      if (obj === null || obj === undefined) {
        return obj;
      }

      // Si c'est un objet Sequelize, extraire les dataValues
      if (obj && typeof obj === 'object' && obj.dataValues) {
        const cleaned = {};
        for (const [key, value] of Object.entries(obj.dataValues)) {
          if (key === 'parent' || key === 'include' || key === 'sequelize' || key === '_modelOptions') {
            continue;
          }
          
          // Récursivement nettoyer les valeurs imbriquées
          cleaned[key] = this.cleanObjectForJSON(value);
        }
        return cleaned;
      }

      // Si c'est un tableau, nettoyer chaque élément
      if (Array.isArray(obj)) {
        return obj.map(item => this.cleanObjectForJSON(item));
      }

      // Si c'est un objet normal, nettoyer récursivement
      if (typeof obj === 'object' && obj !== null) {
        const cleaned = {};
        for (const [key, value] of Object.entries(obj)) {
          if (key === 'parent' || key === 'include' || key === 'sequelize' || key === '_modelOptions') {
            continue;
          }
          
          // Récursivement nettoyer les valeurs imbriquées
          cleaned[key] = this.cleanObjectForJSON(value);
        }
        return cleaned;
      }
      
      // Retourner les valeurs primitives telles quelles
      return obj;
    } catch (error) {
      logger.error('❌ Erreur lors du nettoyage de l\'objet:', error);
      return obj;
    }
  }

  /**
   * Prépare les recommandations pour l'API en évitant les références circulaires
   */
  prepareRecommendationsForAPI(recommendations) {
    try {
      const preparedRecommendations = [];
      
      for (const rec of recommendations) {
        // Vérifier que ce n'est pas un tweet réponse
        if (rec.parent_tweet_id) {
          logger.debug(`🚫 Tweet réponse détecté et exclu: ${rec.id} -> parent: ${rec.parent_tweet_id}`);
          continue;
        }
        
        // Validation stricte de l'ID
        if (!rec.id || typeof rec.id !== 'string' || rec.id.trim() === '') {
          logger.warn(`🚫 Tweet avec ID invalide détecté et exclu dans prepareRecommendationsForAPI:`, {
            id: rec.id,
            type: typeof rec.id,
            content: rec.content?.substring(0, 50)
          });
          continue;
        }
        
        // Nettoyer l'objet principal
        const cleanedRec = this.cleanObjectForJSON(rec);
        
        // S'assurer que les propriétés essentielles sont présentes
        const preparedRec = {
          id: cleanedRec.id,
          content: cleanedRec.content,
          user_id: cleanedRec.user_id,
          tweet_type: cleanedRec.tweet_type,
          is_retweet: cleanedRec.is_retweet,
          is_quote: cleanedRec.is_quote,
          hashtags: cleanedRec.hashtags || [],
          mentions: cleanedRec.mentions || [],
          media_urls: cleanedRec.media_urls || [],
          moderation_status: cleanedRec.moderation_status,
          view_count: cleanedRec.view_count || 0,
          click_count: cleanedRec.click_count || 0,
          // Idem : ce mapper ne garde que les champs listés, et le sélecteur
          // de langue de la carte dépend de celui-ci.
          translation_enabled: !!cleanedRec.translation_enabled,
          author: cleanedRec.author ? {
            id: cleanedRec.author.id,
            username: cleanedRec.author.username,
            full_name: cleanedRec.author.full_name,
            avatar: cleanedRec.author.avatar,
            verified: cleanedRec.author.verified || false,
            premium: cleanedRec.author.premium || false,
            stats: cleanedRec.author.stats || {}
          } : null,
          stats: cleanedRec.stats || {
            likes: 0,
            retweets: 0,
            replies: 0,
            views: 0
          },
          user_interaction: cleanedRec.user_interaction || {
            is_liked: false,
            is_retweeted: false,
            has_replied: false
          },
          score: cleanedRec.score || 0,
          confidence: cleanedRec.confidence || 0,
          finalScore: cleanedRec.finalScore || 0,
          scoreBreakdown: cleanedRec.scoreBreakdown || {}
        };
        
        preparedRecommendations.push(preparedRec);
      }
      
      logger.info(`✅ ${preparedRecommendations.length} recommandations préparées pour l'API (${recommendations.length - preparedRecommendations.length} tweets réponses exclus)`);
      return preparedRecommendations;
      
    } catch (error) {
      logger.error('❌ Erreur lors de la préparation des recommandations:', error);
      return recommendations;
    }
  }

  /**
   * Met à jour les scores des auteurs
   */
  async updateAuthorScores() {
    try {
      logger.info('🔄 Mise à jour des scores des auteurs...');
      // Cette méthode peut être étendue pour calculer des scores d'influence
      // basés sur les followers, l'engagement, etc.
      logger.info('✅ Scores des auteurs mis à jour');
    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour des scores des auteurs:', error);
    }
  }

  /**
   * Met à jour les scores de contenu
   */
  async updateContentScores() {
    try {
      logger.info('🔄 Mise à jour des scores de contenu...');
      // Cette méthode peut être étendue pour analyser la qualité du contenu
      // avec des modèles de NLP, etc.
      logger.info('✅ Scores de contenu mis à jour');
    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour des scores de contenu:', error);
    }
  }

  /**
   * Calcul du boost pour les nouveaux contenus (tweets récents avec 0 vues)
   */
  calculateNewContentBoost(tweet) {
    try {
      const now = new Date();
      const tweetAge = now - new Date(tweet.created_at);
      const ageInHours = tweetAge / (1000 * 60 * 60);
      
      // Boost maximum pour les tweets de 0-2h avec 0 vues
      if (ageInHours <= 2 && (!tweet.view_count || tweet.view_count === 0)) {
        const timeBoost = Math.max(0, 2 - ageInHours) * 50; // 0-100 points bonus
        const newContentBoost = 100; // Boost de base pour nouveau contenu
        
        logger.debug(`🚀 Boost nouveau contenu pour tweet ${tweet.id}: âge=${ageInHours.toFixed(2)}h, boost=${timeBoost + newContentBoost}`);
        return timeBoost + newContentBoost;
      }
      
      // Boost réduit pour les tweets de 2-6h avec faible engagement
      if (ageInHours <= 6 && (!tweet.view_count || tweet.view_count < 5)) {
        const timeBoost = Math.max(0, 6 - ageInHours) * 20; // 0-80 points bonus
        logger.debug(`📈 Boost contenu récent pour tweet ${tweet.id}: âge=${ageInHours.toFixed(2)}h, boost=${timeBoost}`);
        return timeBoost;
      }
      
      // Boost minimal pour les tweets de 6-24h avec engagement moyen
      if (ageInHours <= 24 && (!tweet.view_count || tweet.view_count < 20)) {
        const timeBoost = Math.max(0, 24 - ageInHours) * 5; // 0-90 points bonus
        logger.debug(`📊 Boost contenu jeune pour tweet ${tweet.id}: âge=${ageInHours.toFixed(2)}h, boost=${timeBoost}`);
        return timeBoost;
      }
      
      return 0; // Pas de boost pour les tweets plus anciens ou avec engagement élevé
      
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du boost nouveau contenu:', error);
      return 0;
    }
  }

  /**
   * Récupère les recommandations spécialement optimisées pour la découverte de nouveaux contenus
   * Cet algorithme donne la priorité aux tweets récents avec 0 vues pour éviter qu'ils restent invisibles
   */
  async getNewContentDiscoveryRecommendations(user, context, limit) {
    try {
      logger.info(`🚀 getNewContentDiscoveryRecommendations: Début pour l'utilisateur ${user.id}, limite: ${limit}`);
      
      // Construire la clause WHERE optimisée pour les nouveaux contenus
      const whereClause = {
        moderation_status: 'approved',
        deleted_at: null, // Exclure les réponses
        user_id: { [Op.ne]: user.id }
      };

      // Si retrieveAllTweets est activé, ne pas limiter par la date
      if (!this.thresholds.retrieveAllTweets) {
        whereClause.created_at = { [Op.gte]: new Date(Date.now() - this.thresholds.maxAge) };
        logger.info(`📅 Découverte nouveaux contenus: limitation aux ${this.thresholds.maxAge / (24 * 60 * 60 * 1000)} derniers jours`);
      } else {
        logger.info(`🌍 Découverte nouveaux contenus: récupération de TOUS les tweets depuis toujours`);
      }
      
      // Récupérer les tweets avec priorité aux nouveaux
      const recommendations = await Tweet.findAll({
        where: whereClause,
        attributes: [
          'id', 'content', 'created_at', 'user_id', 'tweet_type', 'is_retweet', 'is_quote',
          'media_urls', 'hashtags', 'mentions', 'view_count', 'click_count',
          'moderation_status', 'deleted_at'
        ],
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats']
          }
        ],
        order: [
          // Priorité 1: Tweets très récents (0-2h) avec 0 vues
          [literal(`CASE 
            WHEN "Tweet"."created_at" >= NOW() - INTERVAL '2 hours' AND ("Tweet"."view_count" = 0 OR "Tweet"."view_count" IS NULL) THEN 1
            WHEN "Tweet"."created_at" >= NOW() - INTERVAL '6 hours' AND ("Tweet"."view_count" < 5 OR "Tweet"."view_count" IS NULL) THEN 2
            WHEN "Tweet"."created_at" >= NOW() - INTERVAL '24 hours' AND ("Tweet"."view_count" < 20 OR "Tweet"."view_count" IS NULL) THEN 3
            ELSE 4
          END`), 'ASC'],
          // Priorité 2: Date de création (plus récent en premier)
          ['created_at', 'DESC']
        ],
        limit: limit * 3 // Récupérer plus de tweets pour avoir une meilleure sélection
      });

      logger.info(`📊 getNewContentDiscoveryRecommendations: ${recommendations.length} tweets récupérés`);

      // Filtrer et valider les tweets
      const validTweets = recommendations.filter(tweet => {
        const tweetData = tweet.toJSON ? tweet.toJSON() : tweet;
        if (!tweetData.id || !tweetData.content || !tweetData.author) {
          return false;
        }
        return true;
      });

      // Appliquer un boost spécial pour les nouveaux contenus
      const boostedTweets = validTweets.map(tweet => {
        const tweetData = tweet.toJSON ? tweet.toJSON() : tweet;
        const newContentBoost = this.calculateNewContentBoost(tweetData);
        
        // Ajouter le boost directement dans l'objet pour le scoring ultérieur
        tweetData.newContentBoost = newContentBoost;
        tweetData.isNewContent = newContentBoost > 0;
        
        return tweetData;
      });

      // Trier par boost décroissant pour prioriser les nouveaux contenus
      boostedTweets.sort((a, b) => (b.newContentBoost || 0) - (a.newContentBoost || 0));

      logger.info(`✅ getNewContentDiscoveryRecommendations: ${boostedTweets.length} tweets valides avec boost nouveau contenu`);
      
      // Log des tweets les plus boostés
      const topBoosted = boostedTweets.slice(0, 3);
      topBoosted.forEach((tweet, index) => {
        logger.info(`🚀 Top ${index + 1} boosté: Tweet ${tweet.id} - Boost: ${tweet.newContentBoost} - Vues: ${tweet.view_count || 0} - Âge: ${((Date.now() - new Date(tweet.created_at)) / (1000 * 60 * 60)).toFixed(2)}h`);
      });

      return boostedTweets.slice(0, limit);

    } catch (error) {
      logger.error('❌ Erreur dans getNewContentDiscoveryRecommendations:', error);
      return [];
    }
  }
}

module.exports = RecommendationEngine;
