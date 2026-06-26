/**
 * 🚀 Service de Recommandation de Tweets avec Authentification
 * 
 * Intègre l'algorithme de recommandation ultra-avancé avec les routes
 * de récupération de tweets authentifiés pour une expérience personnalisée.
 * 
 * @author TwitNin Team
 * @version 1.0.0
 * @license MIT
 */

const { Op, fn, col, literal, Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const { User, Tweet, TweetLike, TweetRetweet, UserFollow, Notification } = require('../models');
const RecommendationEngine = require('./recommendationEngine');
const UltraRecommendationEngine = require('./ultraRecommendationEngine');
const UltraRecommendationEngineTikTokLevel = require('./ultraRecommendationEngineTikTokLevel');
const SmartRecommendationEngine = require('./smartRecommendationEngine');
const BehavioralAnalysisService = require('./behavioralAnalysisService');
const TrendingAnalysisService = require('./trendingAnalysisService');
const config = require('./recommendationConfig');

class TweetRecommendationService {
  constructor() {
    this.recommendationEngine = null;
    this.ultraRecommendationEngine = null;
    this.tikTokLevelEngine = null;
    this.smartRecommendationEngine = null;
    this.behavioralService = null;
    this.trendingService = null;
    this.cache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
    
    this.initialize();
  }

  /**
   * Initialisation du service
   */
  async initialize() {
    try {
      logger.info('🚀 Initialisation du service de recommandation de tweets...');
      
      // Initialiser les services de manière asynchrone
      await this.initializeServices();
      
      // Vérifier que tous les services sont disponibles
      await this.validateServices();
      
      logger.info('✅ Service de recommandation de tweets initialisé');
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation:', error);
    }
  }

  /**
   * Initialisation des services
   */
  async initializeServices() {
    try {
      // Initialiser le moteur de recommandation classique
      this.recommendationEngine = new RecommendationEngine();
      
      // Initialiser le moteur ultra-puissant
      this.ultraRecommendationEngine = new UltraRecommendationEngine();
      
      // Initialiser le moteur TikTok-Level ultra-puissant
      this.tikTokLevelEngine = new UltraRecommendationEngineTikTokLevel();
      
      // Initialiser le Smart Recommendation Engine
      this.smartRecommendationEngine = new SmartRecommendationEngine();
      
      // Initialiser le service comportemental
      this.behavioralService = new BehavioralAnalysisService();
      
      // Initialiser le service des tendances
      this.trendingService = new TrendingAnalysisService();
      
      logger.info('✅ Services initialisés (incluant Ultra Engine + TikTok-Level Engine + Smart Engine)');
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation des services:', error);
      throw error;
    }
  }

  /**
   * Validation des services requis
   */
  async validateServices() {
    try {
      // Vérifier que le moteur de recommandation est initialisé
      if (!this.recommendationEngine || typeof this.recommendationEngine.getRecommendations !== 'function') {
        throw new Error('Moteur de recommandation non initialisé');
      }
      
      // Vérifier que le service comportemental est disponible
      if (!this.behavioralService || typeof this.behavioralService.analyzeUserBehavior !== 'function') {
        throw new Error('Service comportemental non initialisé');
      }
      
      // Vérifier que le service des tendances est disponible
      if (!this.trendingService || typeof this.trendingService.analyzeTrends !== 'function') {
        throw new Error('Service des tendances non initialisé');
      }
      
      logger.info('✅ Tous les services sont disponibles');
    } catch (error) {
      logger.error('❌ Erreur de validation des services:', error);
      throw error;
    }
  }

  /**
   * Récupération de tweets avec recommandations intelligentes
   */
  async getRecommendedTweets(userId, options = {}) {
    try {
      const {
        limit = 100,
        offset = 0,
        type = 'all',
        sort = 'recommended', // Nouveau type de tri
        algorithm = 'ultra_hybrid',
        context = 'discovery',
        includeUser = true,
        includeStats = true,
        forceRefresh = false
      } = options;

      // Vérifier que les services sont initialisés
      if (!this.ultraRecommendationEngine || !this.recommendationEngine || !this.smartRecommendationEngine || !this.behavioralService || !this.trendingService) {
        logger.warn('⚠️ Services non initialisés, utilisation du fallback');
        return await this.getFallbackTweetsWithPagination(userId, limit, offset, type);
      }

      // Vérifier le cache
      const cacheKey = `tweets_${userId}_${type}_${sort}_${limit}_${offset}`;
      if (!forceRefresh && this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheExpiry) {
          logger.info(`📋 Utilisation du cache pour les tweets recommandés de ${userId}`);
          return cached.data;
        }
      }

      try {
        // Vérifier si on doit utiliser l'algorithme TikTok-Level ultra-puissant
        const useTikTokLevelAlgorithm = algorithm === 'tiktok_level' ||
                                        algorithm === 'ultra_tiktok' ||
                                        algorithm === 'tiktok_power' ||
                                        sort === 'tiktok_recommended';

        // Vérifier si on doit utiliser le Smart Algorithm
        const useSmartAlgorithm = algorithm === 'smart' || 
                                 algorithm === 'smart_discovery' || 
                                 algorithm === 'smart_custom' ||
                                 sort === 'smart_recommended';

        // Vérifier si on doit utiliser l'algorithme ultra-puissant standard
        const useUltraAlgorithm = algorithm === 'ultra_hybrid' || 
                                algorithm === 'ultra_power' || 
                                algorithm === 'ultra_advanced' ||
                                sort === 'ultra_recommended';

        // Vérifier si on doit utiliser l'algorithme progressif
        const useProgressiveAlgorithm = algorithm === 'progressive' || 
                                       algorithm === 'progressive_viral' ||
                                       sort === 'progressive_recommended';

        if (useProgressiveAlgorithm) {
          logger.info(`🚀 Utilisation du PROGRESSIVE RECOMMENDATION ENGINE pour ${userId}`);
          
          // Utiliser le Progressive Recommendation Engine
          const ProgressiveRecommendationEngine = require('./progressiveRecommendationEngine');
          const progressiveEngine = new ProgressiveRecommendationEngine();
          
          const progressiveResult = await progressiveEngine.getProgressiveRecommendations(userId, {
            limit,
            offset,
            includeUser: includeUser === 'true',
            includeStats: includeStats === 'true'
          });

          // Transformer le résultat pour correspondre au format attendu
          return {
            tweets: progressiveResult.recommendations,
            pagination: progressiveResult.pagination,
            recommendation: {
              algorithm: progressiveResult.metadata.algorithm,
              userGroup: progressiveResult.metadata.userGroup,
              totalCandidates: progressiveResult.metadata.totalCandidates,
              generatedAt: progressiveResult.metadata.generatedAt
            }
          };
        }

        if (useSmartAlgorithm) {
          logger.info(`🧠 Utilisation du SMART RECOMMENDATION ENGINE pour ${userId}`);
          
          // Utiliser le Smart Recommendation Engine
          const smartResult = await this.smartRecommendationEngine.getSmartRecommendations(userId, {
            limit,
            offset,
            context,
            refreshCache: forceRefresh
          });

          // Transformer le résultat pour correspondre au format attendu
          return {
            tweets: smartResult.recommendations,
            pagination: smartResult.pagination,
            recommendation: {
              algorithm: smartResult.metadata.algorithm,
              context: smartResult.metadata.context,
              userBehavior: smartResult.metadata.userProfile,
              trends: smartResult.metadata.qualityMetrics,
              performance: smartResult.metadata.performance
            }
          };
        }

        if (useTikTokLevelAlgorithm) {
          logger.info(`🎯 Utilisation de l'algorithme TIKTOK-LEVEL ULTRA-PUISSANT pour ${userId}`);
          
          // Utiliser le moteur TikTok-Level ultra-puissant
          const tikTokResult = await this.tikTokLevelEngine.getTikTokLevelRecommendations(userId, {
            limit,
            offset,
            context,
            includeUser,
            includeStats,
            forceRefresh
          });

          // Transformer le résultat pour correspondre au format attendu
          return {
            tweets: tikTokResult.recommendations,
            pagination: tikTokResult.pagination,
            recommendation: {
              algorithm: tikTokResult.metadata.algorithm,
              context: tikTokResult.metadata.context,
              userBehavior: tikTokResult.metadata.userProfile,
              trends: tikTokResult.metadata.qualityMetrics,
              performance: tikTokResult.metadata.performance
            }
          };
        }

        if (useUltraAlgorithm) {
          logger.info(`🚀 Utilisation de l'algorithme ULTRA-PUISSANT pour ${userId}`);
          
          // Utiliser le moteur ultra-puissant
          const ultraResult = await this.ultraRecommendationEngine.getUltraPowerRecommendations(userId, {
            limit,
            offset,
            context,
            includeUser,
            includeStats,
            forceRefresh
          });

          // Transformer le résultat pour correspondre au format attendu
          return {
            tweets: ultraResult.recommendations,
            pagination: ultraResult.pagination,
            recommendation: {
              algorithm: ultraResult.metadata.algorithm,
              context: ultraResult.metadata.context,
              userBehavior: ultraResult.metadata.userProfile,
              trends: ultraResult.metadata.qualityMetrics,
              performance: ultraResult.metadata.performance
            }
          };
        }

        // Analyser le comportement de l'utilisateur pour personnaliser les recommandations
        const userBehavior = await this.behavioralService.analyzeUserBehavior(userId, {
          includePatterns: true,
          includePredictions: false,
          includeRecommendations: false
        });

        // Analyser les tendances actuelles
        const currentTrends = await this.trendingService.analyzeTrends({
          timeWindow: 24,
          includeViral: true,
          includeTopics: true,
          includeMomentum: false
        });

        // Construire la clause WHERE avec filtres intelligents
        const whereClause = this.buildIntelligentWhereClause(type, userBehavior, currentTrends);

        // Récupérer les tweets avec l'algorithme de recommandation
        const recommendedTweets = await this.getTweetsWithRecommendation(
          userId, whereClause, limit, offset, algorithm, context, userBehavior, currentTrends
        );

        // Enrichir les tweets avec les données utilisateur et statistiques
        const enrichedTweets = await this.enrichTweetsWithUserData(
          recommendedTweets, userId, includeUser, includeStats
        );

        // Appliquer le tri intelligent
        const sortedTweets = this.applyIntelligentSorting(
          enrichedTweets, sort, userBehavior, currentTrends
        );

        // Utiliser les informations de pagination du moteur de recommandation si disponibles
        let totalCount, hasMore;
        
        if (recommendedTweets._paginationInfo) {
          // Utiliser les informations de pagination du moteur de recommandation
          totalCount = recommendedTweets._paginationInfo.total;
          hasMore = recommendedTweets._paginationInfo.hasMore;
          
          logger.info(`📊 Pagination du moteur de recommandation: total=${totalCount}, hasMore=${hasMore}`);
        } else {
          // Fallback: compter le total pour la pagination - IMPORTANT: Utiliser la clause WHERE de base
          // pour avoir le vrai total de tous les tweets éligibles
          const baseWhereClause = {
            is_private: false,
            deleted_at: null,
            moderation_status: 'approved'
          };

          // Filtrer par type
          if (type === 'replies') {
            baseWhereClause.parent_tweet_id = { [Op.ne]: null };
          } else if (type === 'retweets') {
            baseWhereClause.is_retweet = true;
          } else if (type === 'quotes') {
            baseWhereClause.is_quote = true;
          } else if (type === 'tweets') {
            baseWhereClause.parent_tweet_id = null;
            baseWhereClause.is_retweet = false;
            baseWhereClause.is_quote = false;
          } else {
            // all: originaux OU retweets OU quotes (exclut les réponses)
            baseWhereClause[Op.or] = [
              { [Op.and]: [{ parent_tweet_id: null }, { is_retweet: false }, { is_quote: false }] },
              { is_retweet: true },
              { is_quote: true }
            ];
          }

          totalCount = await Tweet.count({ where: baseWhereClause });
          hasMore = offset + sortedTweets.length < totalCount;
          
          logger.info(`📊 Pagination fallback: total=${totalCount}, hasMore=${hasMore}`);
        }

        const result = {
          tweets: sortedTweets,
          pagination: {
            total: totalCount,
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: hasMore
          },
          recommendation: {
            algorithm: algorithm,
            context: context,
            userBehavior: {
              engagementLevel: userBehavior.summary?.engagementLevel || 'medium',
              contentDiversity: userBehavior.summary?.contentDiversity || 'medium',
              socialActivity: userBehavior.summary?.socialActivity || 'medium'
            },
            trends: {
              activeTrends: currentTrends.summary?.totalTrends || 0,
              viralContent: currentTrends.summary?.viralCount || 0,
              topTopic: currentTrends.summary?.topTrendingTopic || 'Aucun'
            }
          }
        };

        // Mettre en cache
        this.cache.set(cacheKey, {
          data: result,
          timestamp: Date.now()
        });

        logger.info(`🚀 ${sortedTweets.length} tweets recommandés générés pour ${userId} avec l'algorithme ${algorithm} (total disponible: ${totalCount})`);
        return result;

      } catch (error) {
        logger.error('❌ Erreur lors de la récupération des tweets recommandés:', error);
        // Fallback vers la méthode classique
        logger.info('📋 Fallback vers la méthode classique de récupération de tweets');
        return await this.getFallbackTweetsWithPagination(userId, limit, offset, type);
      }

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des tweets recommandés:', error);
      // Fallback vers la méthode classique
      return await this.getFallbackTweetsWithPagination(userId, limit, offset, type);
    }
  }

  /**
   * Construction de la clause WHERE intelligente
   */
  buildIntelligentWhereClause(type, userBehavior, currentTrends) {
    let whereClause = {
      is_private: false,
      deleted_at: null,
      [Op.and]: [
        {
          [Op.or]: [
            { moderation_status: 'approved' },
            { moderation_status: 'pending' } // Inclure les tweets en attente
          ]
        },
        {
          moderation_status: {
            [Op.notIn]: ['not_eligible', 'rejected']
          }
        }
      ]
    };

    // Filtrage par type
    if (type === 'replies') {
      whereClause.parent_tweet_id = { [Op.ne]: null };
    } else if (type === 'retweets') {
      whereClause.is_retweet = true;
    } else if (type === 'quotes') {
      whereClause.is_quote = true;
    } else if (type === 'tweets') {
      whereClause = {
        ...whereClause,
        parent_tweet_id: null,
        is_retweet: false,
        is_quote: false
      };
    } else {
      // all: originaux OU retweets OU quotes (exclut les réponses)
      whereClause = {
        ...whereClause,
        [Op.or]: [
          { [Op.and]: [{ parent_tweet_id: null }, { is_retweet: false }, { is_quote: false }] },
          { is_retweet: true },
          { is_quote: true }
        ]
      };
    }

    // Filtres intelligents basés sur le comportement utilisateur
    if (userBehavior && userBehavior.preferences) {
      // Filtrer par hashtags préférés si disponibles
      if (userBehavior.preferences.content && userBehavior.preferences.content.preferredHashtags) {
        const preferredHashtags = userBehavior.preferences.content.preferredHashtags.slice(0, 5);
        if (preferredHashtags.length > 0) {
          whereClause[Op.or] = whereClause[Op.or] || [];
          whereClause[Op.or].push({
            hashtags: { [Op.overlap]: preferredHashtags }
          });
        }
      }

      // Filtrer par langue préférée si disponible
      if (userBehavior.preferences.platform && userBehavior.preferences.platform.language) {
        whereClause.language = userBehavior.preferences.platform.language;
      }
    }

    // Filtres basés sur les tendances actuelles
    if (currentTrends && currentTrends.topics && currentTrends.topics.hashtags) {
      const trendingHashtags = currentTrends.topics.hashtags
        .slice(0, 3)
        .map(item => item.hashtags)
        .flat();

      if (trendingHashtags.length > 0) {
        whereClause[Op.or] = whereClause[Op.or] || [];
        whereClause[Op.or].push({
          hashtags: { [Op.overlap]: trendingHashtags }
        });
      }
    }

    return whereClause;
  }

  /**
   * Récupère les tweets avec l'algorithme de recommandation
   */
  async getTweetsWithRecommendation(userId, whereClause, limit, offset, algorithm, context, userBehavior, currentTrends) {
    try {
      // Utiliser le moteur de recommandation pour obtenir les IDs recommandés
      const recommendationResult = await this.recommendationEngine.getRecommendations(userId, {
        algorithm: algorithm,
        limit: limit * 3, // Récupérer beaucoup plus pour avoir de la marge
        context: context,
        includeUser: false,
        includeStats: false
      });

      // Si pas de recommandations, utiliser une approche fallback
      if (!recommendationResult || !recommendationResult.recommendations || recommendationResult.recommendations.length === 0) {
        logger.info(`📋 Aucune recommandation disponible pour ${userId}, utilisation du fallback`);
        return await this.getFallbackTweets(whereClause, limit, offset);
      }

      // Extraire les recommandations et les informations de pagination
      const recommendations = recommendationResult.recommendations;
      const paginationInfo = recommendationResult.pagination;

      // Extraire les IDs des tweets recommandés
      const recommendedIds = recommendations.map(rec => rec.tweetId || rec.id).filter(Boolean);

      // Récupérer les tweets recommandés avec leurs données complètes
      const recommendedTweets = await Tweet.findAll({
        where: {
          ...whereClause,
          id: { [Op.in]: recommendedIds }
        },
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats'],
            where: { is_active: true }
          },
          {
            model: Tweet,
            as: 'originalTweet',
            include: [{
              model: User,
              as: 'author',
              attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium']
            }]
          }
        ],
        order: [
          [literal(`CASE WHEN id IN (${recommendedIds.map(id => `'${id}'`).join(',')}) THEN 0 ELSE 1 END`), 'ASC'],
          ['created_at', 'DESC']
        ],
        limit: limit,
        offset: offset
      });

      // Si pas assez de tweets recommandés, compléter avec des tweets populaires
      if (recommendedTweets.length < limit) {
        const remainingLimit = limit - recommendedTweets.length;
        const existingIds = recommendedTweets.map(t => t.id);
        
        logger.info(`📋 Complétion avec ${remainingLimit} tweets populaires (recommandés: ${recommendedTweets.length}/${limit})`);
        
        const additionalTweets = await Tweet.findAll({
          where: {
            ...whereClause,
            id: { [Op.notIn]: existingIds }
          },
          include: [
            {
              model: User,
              as: 'author',
              attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats'],
              where: { is_active: true }
            }
          ],
          order: [['view_count', 'DESC'], ['created_at', 'DESC']],
          limit: remainingLimit * 2 // Récupérer plus pour avoir de la marge
        });

        recommendedTweets.push(...additionalTweets);
        
        logger.info(`📋 Total après complétion: ${recommendedTweets.length} tweets`);
      }

      // Stocker les informations de pagination pour utilisation ultérieure
      recommendedTweets._paginationInfo = paginationInfo;

      return recommendedTweets;

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des tweets recommandés:', error);
      // Fallback en cas d'erreur
      return await this.getFallbackTweets(whereClause, limit, offset);
    }
  }

  /**
   * Approche fallback pour récupérer des tweets
   */
  async getFallbackTweets(whereClause, limit, offset) {
    logger.info('📋 Utilisation de l\'approche fallback pour la récupération de tweets');
    
    return await Tweet.findAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats'],
          where: { is_active: true }
        }
      ],
      order: [['view_count', 'DESC'], ['created_at', 'DESC']],
      limit: limit,
      offset: offset
    });
  }

  /**
   * Approche fallback avec pagination complète
   */
  async getFallbackTweetsWithPagination(userId, limit, offset, type) {
    logger.info('📋 Utilisation de l\'approche fallback avec pagination pour la récupération de tweets');
    
    // Construire la clause WHERE de base
    let whereClause = {
      is_private: false,
      deleted_at: null,
      [Op.and]: [
        {
          [Op.or]: [
            { moderation_status: 'approved' },
            { moderation_status: 'pending' }
          ]
        },
        {
          moderation_status: {
            [Op.notIn]: ['not_eligible', 'rejected']
          }
        }
      ]
    };

    // Filtrage par type
    if (type === 'replies') {
      whereClause.parent_tweet_id = { [Op.ne]: null };
    } else if (type === 'retweets') {
      whereClause.is_retweet = true;
    } else if (type === 'quotes') {
      whereClause.is_quote = true;
    } else if (type === 'tweets') {
      whereClause = {
        ...whereClause,
        parent_tweet_id: null,
        is_retweet: false,
        is_quote: false
      };
    } else {
      // all: originaux OU retweets OU quotes (exclut les réponses)
      whereClause = {
        ...whereClause,
        [Op.or]: [
          { [Op.and]: [{ parent_tweet_id: null }, { is_retweet: false }, { is_quote: false }] },
          { is_retweet: true },
          { is_quote: true }
        ]
      };
    }

    // Récupérer les tweets
    const tweets = await Tweet.findAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats'],
          where: { is_active: true }
        }
      ],
      order: [['view_count', 'DESC'], ['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    // Enrichir les tweets
    const enrichedTweets = await this.enrichTweetsWithUserData(
      tweets, userId, true, true
    );

    // Compter le total
    const totalCount = await Tweet.count({ where: whereClause });

    return {
      tweets: enrichedTweets,
      pagination: {
        total: totalCount,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: offset + enrichedTweets.length < totalCount
      },
      recommendation: {
        algorithm: 'fallback',
        context: 'fallback',
        userBehavior: {
          engagementLevel: 'medium',
          contentDiversity: 'medium',
          socialActivity: 'medium'
        },
        trends: {
          activeTrends: 0,
          viralContent: 0,
          topTopic: 'Aucun'
        }
      }
    };
  }

  /**
   * Enrichissement des tweets avec les données utilisateur
   */
  async enrichTweetsWithUserData(tweets, userId, includeUser, includeStats) {
    try {
      return await Promise.all(tweets.map(async (tweet) => {
        const tweetData = tweet.toJSON();
        
        // Statistiques de base
        if (includeStats) {
          const [likeCount, retweetCount, replyCount] = await Promise.all([
            TweetLike.countTweetLikes(tweet.id),
            TweetRetweet.countTweetRetweets(tweet.id),
            Tweet.count({ where: { parent_tweet_id: tweet.id } })
          ]);
          
          tweetData.stats = {
            likes: likeCount,
            retweets: retweetCount,
            replies: replyCount,
            views: tweet.view_count || 0
          };
        }
        
        // Interactions utilisateur
        if (userId) {
          const [isLiked, isRetweeted] = await Promise.all([
            TweetLike.hasUserLikedTweet(userId, tweet.id),
            TweetRetweet.hasUserRetweetedTweet(userId, tweet.id)
          ]);
          
          tweetData.user_interaction = {
            is_liked: isLiked,
            is_retweeted: isRetweeted
          };
        }
        
        // Données utilisateur enrichies
        if (includeUser && tweet.author) {
          tweetData.author = {
            ...tweetData.author,
            stats: tweet.author.stats || {},
            is_following: false // À implémenter si nécessaire
          };
        }
        
        return tweetData;
      }));
    } catch (error) {
      logger.error('❌ Erreur lors de l\'enrichissement des tweets:', error);
      return tweets.map(tweet => tweet.toJSON());
    }
  }

  /**
   * Application du tri intelligent
   */
  applyIntelligentSorting(tweets, sort, userBehavior, currentTrends) {
    try {
      switch (sort) {
        case 'recommended':
          // Tri basé sur l'algorithme de recommandation (déjà trié)
          return tweets;
          
        case 'trending':
          // Tri basé sur les tendances et le momentum
          return tweets.sort((a, b) => {
            const aScore = this.calculateTrendingScore(a, currentTrends);
            const bScore = this.calculateTrendingScore(b, currentTrends);
            return bScore - aScore;
          });
          
        case 'personalized':
          // Tri basé sur les préférences comportementales
          return tweets.sort((a, b) => {
            const aScore = this.calculatePersonalizedScore(a, userBehavior);
            const bScore = this.calculatePersonalizedScore(b, userBehavior);
            return bScore - aScore;
          });
          
        case 'latest':
          return tweets.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          
        case 'popular':
          return tweets.sort((a, b) => (b.stats?.views || 0) - (a.stats?.views || 0));
          
        default:
          return tweets;
      }
    } catch (error) {
      logger.error('❌ Erreur lors du tri intelligent:', error);
      return tweets;
    }
  }

  /**
   * Calcul du score de tendance pour un tweet
   */
  calculateTrendingScore(tweet, currentTrends) {
    let score = 0;
    
    // Score de base basé sur les vues
    score += (tweet.stats?.views || 0) * 0.1;
    
    // Bonus pour les hashtags tendance
    if (currentTrends?.topics?.hashtags && tweet.hashtags) {
      const trendingHashtags = currentTrends.topics.hashtags
        .slice(0, 5)
        .map(item => item.hashtags)
        .flat();
      
      const matchingHashtags = tweet.hashtags.filter(h => trendingHashtags.includes(h));
      score += matchingHashtags.length * 50;
    }
    
    // Bonus pour la récence
    const ageInHours = (Date.now() - new Date(tweet.created_at)) / (1000 * 60 * 60);
    const recencyBonus = Math.exp(-ageInHours / 24); // Décroissance sur 24h
    score += recencyBonus * 100;
    
    return score;
  }

  /**
   * Calcul du score personnalisé pour un tweet
   */
  calculatePersonalizedScore(tweet, userBehavior) {
    let score = 0;
    
    if (!userBehavior) return score;
    
    // Score basé sur les préférences de contenu
    if (userBehavior.preferences?.content) {
      const contentPrefs = userBehavior.preferences.content;
      
      // Préférence pour les hashtags
      if (contentPrefs.preferredHashtags && tweet.hashtags) {
        const matchingHashtags = tweet.hashtags.filter(h => 
          contentPrefs.preferredHashtags.includes(h)
        );
        score += matchingHashtags.length * 30;
      }
      
      // Préférence pour la longueur du contenu
      if (contentPrefs.preferredLength && tweet.content) {
        const contentLength = tweet.content.length;
        const lengthDiff = Math.abs(contentLength - contentPrefs.preferredLength);
        score += Math.max(0, 50 - lengthDiff);
      }
    }
    
    // Score basé sur le comportement d'engagement
    if (userBehavior.engagement) {
      const engagement = userBehavior.engagement;
      
      // Préférence pour les types de contenu
      if (engagement.typePreferences) {
        if (tweet.is_retweet && engagement.typePreferences.retweets) {
          score += 20;
        }
        if (tweet.parent_tweet_id && engagement.typePreferences.replies) {
          score += 15;
        }
      }
    }
    
    return score;
  }

  /**
   * Recherche de tweets avec recommandations
   */
  async searchTweetsWithRecommendations(userId, query, options = {}) {
    try {
      const {
        limit = 20,
        offset = 0,
        sort = 'relevance',
        type = 'all',
        hashtag,
        from_user,
        algorithm = 'content_intelligence'
      } = options;

      // Construire la clause WHERE pour la recherche
      let whereClause = {
        is_private: false,
        moderation_status: 'approved',
        deleted_at: null
      };

      // Filtre par type
      if (type === 'replies') {
        whereClause.parent_tweet_id = { [Op.ne]: null };
      } else if (type === 'retweets') {
        whereClause.is_retweet = true;
      } else if (type === 'quotes') {
        whereClause.is_quote = true;
      } else if (type === 'tweets') {
        whereClause.parent_tweet_id = null;
      }

      // Filtre par hashtag
      if (hashtag) {
        whereClause.hashtags = { [Op.overlap]: [hashtag] };
      }

      // Filtre par utilisateur
      if (from_user) {
        whereClause.user_id = from_user;
      }

      // Utiliser la méthode searchTweets du modèle Tweet
      const searchResults = await Tweet.searchTweets(query, {
        limit: parseInt(limit) * 2, // Récupérer plus pour le tri
        offset: parseInt(offset),
        includeReplies: type === 'replies',
        includeRetweets: type === 'retweets',
        sortBy: 'created_at',
        sortOrder: 'DESC'
      });

      // Analyser le comportement utilisateur pour personnaliser les résultats
      const userBehavior = await this.behavioralService.analyzeUserBehavior(userId, {
        includePatterns: false,
        includePredictions: false,
        includeRecommendations: false
      });

      // Enrichir et trier les résultats
      const enrichedTweets = await this.enrichTweetsWithUserData(
        searchResults, userId, true, true
      );

      // Appliquer le tri intelligent
      const sortedTweets = this.applySearchSorting(
        enrichedTweets, sort, query, userBehavior
      );

      // Limiter les résultats
      const limitedTweets = sortedTweets.slice(0, parseInt(limit));

      return {
        tweets: limitedTweets,
        pagination: {
          total: searchResults.length,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + limitedTweets.length < searchResults.length
        },
        search: {
          query: query,
          algorithm: algorithm,
          relevanceScore: this.calculateSearchRelevance(query, limitedTweets)
        }
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la recherche avec recommandations:', error);
      throw error;
    }
  }

  /**
   * Tri intelligent pour la recherche
   */
  applySearchSorting(tweets, sort, query, userBehavior) {
    try {
      switch (sort) {
        case 'relevance':
          // Tri par pertinence de recherche
          return tweets.sort((a, b) => {
            const aRelevance = this.calculateQueryRelevance(a, query);
            const bRelevance = this.calculateQueryRelevance(b, query);
            return bRelevance - aRelevance;
          });
          
        case 'personalized':
          // Tri personnalisé basé sur le comportement
          return tweets.sort((a, b) => {
            const aScore = this.calculatePersonalizedScore(a, userBehavior);
            const bScore = this.calculatePersonalizedScore(b, userBehavior);
            return bScore - aScore;
          });
          
        case 'latest':
          return tweets.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          
        case 'popular':
          return tweets.sort((a, b) => (b.stats?.views || 0) - (a.stats?.views || 0));
          
        default:
          return tweets;
      }
    } catch (error) {
      logger.error('❌ Erreur lors du tri de recherche:', error);
      return tweets;
    }
  }

  /**
   * Calcul de la pertinence d'une requête pour un tweet
   */
  calculateQueryRelevance(tweet, query) {
    let relevance = 0;
    const queryLower = query.toLowerCase();
    
    // Pertinence du contenu
    if (tweet.content) {
      const contentLower = tweet.content.toLowerCase();
      
      // Correspondance exacte
      if (contentLower.includes(queryLower)) {
        relevance += 100;
      }
      
      // Correspondance partielle
      const queryWords = queryLower.split(' ');
      const contentWords = contentLower.split(' ');
      
      queryWords.forEach(word => {
        if (contentWords.some(contentWord => contentWord.includes(word))) {
          relevance += 20;
        }
      });
    }
    
    // Pertinence des hashtags
    if (tweet.hashtags && Array.isArray(tweet.hashtags)) {
      tweet.hashtags.forEach(hashtag => {
        if (hashtag.toLowerCase().includes(queryLower.replace('#', ''))) {
          relevance += 50;
        }
      });
    }
    
    // Bonus pour la récence
    const ageInHours = (Date.now() - new Date(tweet.created_at)) / (1000 * 60 * 60);
    const recencyBonus = Math.exp(-ageInHours / 24);
    relevance += recencyBonus * 30;
    
    return relevance;
  }

  /**
   * Calcul du score de pertinence global de la recherche
   */
  calculateSearchRelevance(query, tweets) {
    if (tweets.length === 0) return 0;
    
    const totalRelevance = tweets.reduce((sum, tweet) => {
      return sum + this.calculateQueryRelevance(tweet, query);
    }, 0);
    
    return Math.round(totalRelevance / tweets.length);
  }

  /**
   * Nettoyage du cache
   */
  cleanupCache() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.cacheExpiry) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`🧹 Cache des tweets recommandés nettoyé: ${cleanedCount} entrées supprimées`);
    }
  }

  /**
   * Obtient les statistiques du service
   */
  getStats() {
    return {
      cacheSize: this.cache.size,
      cacheExpiry: this.cacheExpiry,
      services: {
        recommendation: this.recommendationEngine ? 'Initialisé' : 'Non initialisé',
        behavioral: this.behavioralService ? 'Initialisé' : 'Non initialisé',
        trending: this.trendingService ? 'Initialisé' : 'Non initialisé'
      }
    };
  }
}

module.exports = TweetRecommendationService;
