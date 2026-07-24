/**
 * 🧠 Smart Recommendation Engine - Algorithme Personnalisé TwitNin
 * 
 * Algorithme de recommandation sur mesure développé spécialement pour TwitNin
 * avec un système de score multi-dimensionnel ultra-précis qui analyse TOUTES
 * les données disponibles pour créer des recommandations parfaitement adaptées.
 * 
 * @author TwitNin Team
 * @version 1.0.0 - SMART CUSTOM ENGINE
 * @license MIT
 */

const { Op, fn, col, literal, Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const { User, Tweet, TweetLike, TweetRetweet, UserFollow, Notification, Report, ModerationAction, UserBehaviorData, UserPreferences } = require('../models');
const behaviorDataLoader = require('./behaviorDataLoader');
const botDetectionService = require('./BotDetectionService');

class SmartRecommendationEngine {
  constructor() {
    // Cache intelligent multi-niveaux
    this.cache = new Map();
    this.userCache = new Map();
    this.scoreCache = new Map();
    this.analysisCache = new Map();
    this.trendingHashtagsCache = new Map();
    this.shadowbanCache = new Map();
    
    // Configuration cache adaptatif
    this.cacheConfig = {
      userProfileTTL: 5 * 60 * 1000,     // 5 minutes
      recommendationTTL: 2 * 60 * 1000,   // 2 minutes  
      analysisTTL: 10 * 60 * 1000,        // 10 minutes
      scoreTTL: 3 * 60 * 1000,            // 3 minutes
      trendingHashtagsTTL: 30 * 60 * 1000, // 30 minutes
      shadowbanTTL: 60 * 60 * 1000,      // 1 heure
      maxCacheSize: 500
    };
    
    // Système de scoring multi-dimensionnel personnalisé
    this.scoringSystem = {
      // 🎯 ENGAGEMENT UTILISATEUR (35% du score total)
      userEngagement: {
        weight: 0.35,
        factors: {
          recentLikes: { weight: 25, timeWindow: 24 * 60 * 60 * 1000 }, // 24h
          recentRetweets: { weight: 30, timeWindow: 24 * 60 * 60 * 1000 },
          recentReplies: { weight: 20, timeWindow: 24 * 60 * 60 * 1000 },
          userFollowsAuthor: { weight: 40 },
          authorFollowsUser: { weight: 25 },
          mutualConnections: { weight: 35 },
          engagementHistory: { weight: 15, timeWindow: 7 * 24 * 60 * 60 * 1000 }, // 7 jours
          engagementVelocity: { weight: 20 } // Vitesse d'engagement récente
        }
      },

      // 📊 QUALITÉ ET POPULARITÉ DU CONTENU (25% du score total)
      contentQuality: {
        weight: 0.25,
        factors: {
          likeCount: { weight: 30, logarithmic: true },
          retweetCount: { weight: 35, logarithmic: true },
          replyCount: { weight: 25, logarithmic: true },
          viewCount: { weight: 20, logarithmic: true },
          clickCount: { weight: 15, logarithmic: true },
          engagementRate: { weight: 40 }, // (likes + retweets + replies) / views
          viralVelocity: { weight: 30 }, // Vitesse de propagation
          qualityRatio: { weight: 25 }, // Rapport engagements positifs vs négatifs
          contentLength: { weight: 10, optimal: 100 }, // Longueur optimale ~100 caractères
          hasMedia: { weight: 15 },
          hashtagRelevance: { weight: 20 }
        }
      },

      // 👤 INFLUENCE ET CRÉDIBILITÉ DE L'AUTEUR (20% du score total)  
      authorInfluence: {
        weight: 0.20,
        factors: {
          followerCount: { weight: 30, logarithmic: true },
          followingRatio: { weight: 20 }, // followers / following
          verified: { weight: 25, bonus: 50 },
          premium: { weight: 15, bonus: 30 },
          accountAge: { weight: 10, optimal: 365 * 24 * 60 * 60 * 1000 }, // 1 an optimal
          postFrequency: { weight: 15, optimal: 3 }, // 3 posts par jour optimal
          authorEngagementRate: { weight: 35 },
          authorConsistency: { weight: 20 }, // Régularité des posts
          moderationStatus: { weight: 40 }, // Statut de modération clean
          influenceScore: { weight: 30 } // Score d'influence calculé
        }
      },

      // 🕒 FACTEURS TEMPORELS (10% du score total)
      temporalFactors: {
        weight: 0.10,
        factors: {
          recency: { weight: 50, halfLife: 6 * 60 * 60 * 1000 }, // 6h de demi-vie
          timeOfDay: { weight: 25 }, // Correspondance avec habitudes utilisateur
          dayOfWeek: { weight: 15 },
          trending: { weight: 40 }, // Tendance actuelle
          momentumScore: { weight: 30 }, // Momentum de popularité
          seasonality: { weight: 10 }
        }
      },

      // 🧠 INTELLIGENCE COMPORTEMENTALE (10% du score total)
      behavioralIntelligence: {
        weight: 0.10,
        factors: {
          userTopics: { weight: 40 }, // Correspondance avec sujets préférés
          userLanguage: { weight: 20 },
          userActivity: { weight: 25 }, // Niveau d'activité utilisateur
          similarUsers: { weight: 35 }, // Utilisateurs avec comportement similaire
          contentAffinity: { weight: 30 }, // Affinité pour le type de contenu
          emotionalTone: { weight: 15 }, // Correspondance ton émotionnel
          interactionPattern: { weight: 25 } // Pattern d'interaction habituel
        }
      }
    };

    // Configuration de l'analyse des données
    this.dataAnalysis = {
      userBehaviorDepth: 100, // Analyser les 100 dernières interactions
      temporalAnalysisWindow: 30 * 24 * 60 * 60 * 1000, // 30 jours
      trendingWindow: 24 * 60 * 60 * 1000, // 24h pour les tendances
      similarityThreshold: 0.3, // Seuil de similarité entre utilisateurs
      minDataPoints: 5, // Minimum de points de données pour l'analyse
      maxRecommendations: 200 // Maximum de tweets à analyser
    };

    // 🚀 Configuration du système de boost pour nouveau contenu
    this.newContentBoost = {
      maxAge: 2 * 60 * 60 * 1000, // 2 heures pour être considéré comme "nouveau"
      minViews: 3, // Seuil minimum de vues (en dessous = boost)
      boostMultiplier: 2.5, // Multiplicateur de score pour nouveau contenu
      maxBoostPerUser: 2, // Maximum de tweets boostés par utilisateur
      qualityRequired: 0.4 // Score de qualité minimum pour bénéficier du boost
    };

    // 📈 Configuration de l'analyse des hashtags tendance
    this.trendingHashtagBoost = {
      analysisWindow: 24 * 60 * 60 * 1000, // Analyse sur 24h
      minUsageCount: 10, // Usage minimum pour être considéré tendance
      boostMultiplier: 1.8, // Multiplicateur pour hashtags tendance
      maxHashtagsAnalyzed: 50, // Maximum de hashtags à analyser
      refreshInterval: 30 * 60 * 1000 // Actualisation toutes les 30min
    };

    // 🚫 Configuration du système de shadowban
    this.shadowbanSystem = {
      spamDetection: {
        maxTweetsPerHour: 4, // Maximum de tweets par heure
        maxTweetsPerDay: 20, // Maximum de tweets par jour
        cooldownPeriod: 24 * 60 * 60 * 1000 // Période de cooldown
      },
      contentQuality: {
        analysisWindow: 3 * 24 * 60 * 60 * 1000, // 3 jours
        minQualityThreshold: 0.2, // Seuil minimum de qualité
        maxLowQualityRatio: 0.7, // Ratio maximum de contenu de faible qualité
        shadowbanDuration: 48 * 60 * 60 * 1000 // Durée du shadowban
      }
    };

    // Métriques de performance
    this.metrics = {
      totalRequests: 0,
      cacheHits: 0,
      averageProcessingTime: 0,
      accuracyScore: 0,
      userSatisfaction: 0
    };

    // 📊 Données comportementales chargées
    this.behaviorData = {
      globalStats: null,
      userProfiles: new Map(),
      trendingBehaviors: [],
      isInitialized: false
    };

    // Initialisation
    this.initializeEngine();
  }

  /**
   * Initialisation du moteur
   */
  async initializeEngine() {
    try {
      logger.info('🧠 Initialisation du Smart Recommendation Engine...');
      
      // 📊 Charger les données comportementales
      await this.loadBehaviorData();
      
      // Démarrer les processus de maintenance
      this.startMaintenanceProcesses();
      
      logger.info('✅ Smart Recommendation Engine initialisé');
    } catch (error) {
      logger.error('❌ Erreur initialisation Smart Engine:', error);
    }
  }

  /**
   * 📊 Chargement des données comportementales
   */
  async loadBehaviorData() {
    try {
      logger.info('📊 Chargement des données comportementales dans Smart Engine...');

      // Charger les statistiques globales
      this.behaviorData.globalStats = behaviorDataLoader.getGlobalStats();
      
      // Charger les tendances comportementales
      this.behaviorData.trendingBehaviors = behaviorDataLoader.getTrendingBehaviors();
      
      this.behaviorData.isInitialized = true;
      
      logger.info('✅ Données comportementales chargées dans Smart Engine');
      
      // Programmer le rafraîchissement périodique
      setInterval(() => {
        this.refreshBehaviorData();
      }, 30 * 60 * 1000); // Toutes les 30 minutes

    } catch (error) {
      logger.error('❌ Erreur chargement données comportementales:', error);
    }
  }

  /**
   * 🔄 Rafraîchissement des données comportementales
   */
  async refreshBehaviorData() {
    try {
      this.behaviorData.globalStats = behaviorDataLoader.getGlobalStats();
      this.behaviorData.trendingBehaviors = behaviorDataLoader.getTrendingBehaviors();
      
      // Nettoyer le cache des profils utilisateurs pour forcer le rechargement
      this.behaviorData.userProfiles.clear();
      
      logger.info('🔄 Données comportementales rafraîchies');
    } catch (error) {
      logger.error('❌ Erreur rafraîchissement données comportementales:', error);
    }
  }

  /**
   * 🎯 MÉTHODE PRINCIPALE - Obtenir des recommandations intelligentes
   */
  async getSmartRecommendations(userId, options = {}) {
    const startTime = Date.now();

    // 🚨 DÉTECTION DE BOT INSTANTANÉE (Asynchrone)
    botDetectionService.analyzeAndSanction(userId).catch(err => {
      // On reste silencieux ici pour ne pas impacter l'expérience utilisateur
    });
    
    try {
      const {
        limit = 50,
        offset = 0,
        context = 'smart_discovery',
        refreshCache = false
      } = options;

      this.metrics.totalRequests++;

      // 1. Vérifier le cache
      const cacheKey = `smart_${userId}_${limit}_${offset}_${context}`;
      if (!refreshCache) {
        const cached = this.getFromCache(cacheKey, 'recommendation');
        if (cached) {
          this.metrics.cacheHits++;
          return cached;
        }
      }

      logger.info(`🧠 Génération smart pour utilisateur ${userId} (${limit} tweets)`);

      // 2. Créer le profil utilisateur intelligent
      const userProfile = await this.createSmartUserProfile(userId);
      
      // 3. Collecter et analyser toutes les données disponibles
      const dataMatrix = await this.collectAndAnalyzeAllData(userId, userProfile, limit * 4);
      
      // 4. Appliquer le système de scoring multi-dimensionnel
      const scoredTweets = await this.applySmartScoring(dataMatrix.tweets, userProfile);
      
      // 5. Optimiser la diversité intelligente
      const diversifiedTweets = await this.optimizeDiversity(scoredTweets, userProfile);
      
      // 6. Finaliser et personnaliser
      const finalRecommendations = await this.finalizeRecommendations(
        diversifiedTweets, userProfile, limit, offset
      );
      
      // 7. Enrichir avec les métadonnées
      const enrichedRecommendations = await this.enrichWithMetadata(
        finalRecommendations, userId
      );

      // Calculer la pagination
      const pagination = {
        total: dataMatrix.totalAvailable,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: offset + enrichedRecommendations.length < dataMatrix.totalAvailable,
        nextOffset: offset + limit,
        currentPage: Math.floor(offset / limit) + 1
      };

      const result = {
        recommendations: enrichedRecommendations,
        pagination,
        metadata: {
          algorithm: 'smart_custom_v1',
          context,
          processingTime: Date.now() - startTime,
          userProfile: {
            type: userProfile.type,
            confidence: userProfile.confidence,
            interests: userProfile.topInterests,
            activityLevel: userProfile.activityLevel
          },
          qualityMetrics: {
            averageScore: this.calculateAverageScore(enrichedRecommendations),
            diversityScore: this.calculateDiversityScore(enrichedRecommendations),
            relevanceScore: this.calculateRelevanceScore(enrichedRecommendations, userProfile),
            freshnessScore: this.calculateFreshnessScore(enrichedRecommendations)
          },
          performance: {
            dataPoints: dataMatrix.totalDataPoints,
            cacheHitRate: this.metrics.cacheHits / this.metrics.totalRequests,
            processingEfficiency: this.calculateEfficiency(startTime)
          }
        }
      };

      // Mettre en cache
      this.setInCache(cacheKey, result, 'recommendation');

      // Mettre à jour les métriques
      this.updateMetrics(result, Date.now() - startTime);

      logger.info(`✅ Smart recommendations: ${enrichedRecommendations.length} tweets en ${Date.now() - startTime}ms`);
      return result;

    } catch (error) {
      logger.error('❌ Erreur Smart Recommendation Engine:', error);
      return await this.getFallbackRecommendations(userId, options);
    }
  }

  /**
   * 👤 Création du profil utilisateur intelligent
   */
  async createSmartUserProfile(userId) {
    try {
      const cacheKey = `profile_${userId}`;
      const cached = this.getFromCache(cacheKey, 'user');
      if (cached) return cached;

      // 📊 Charger le profil comportemental s'il existe
      let behaviorProfile = null;
      if (this.behaviorData.isInitialized) {
        behaviorProfile = this.behaviorData.userProfiles.get(userId);
        if (!behaviorProfile) {
          behaviorProfile = await behaviorDataLoader.loadUserBehaviorProfile(userId);
          this.behaviorData.userProfiles.set(userId, behaviorProfile);
        }
      }

      // Récupération parallèle de toutes les données utilisateur
      const [
        user,
        userPreferences,
        recentLikes,
        recentRetweets,
        recentTweets,
        following,
        followers,
        recentActivity
      ] = await Promise.all([
        User.findByPk(userId),
        UserPreferences.findOne({ where: { user_id: userId } }),
        this.getRecentUserLikes(userId),
        this.getRecentUserRetweets(userId),
        this.getRecentUserTweets(userId),
        this.getUserFollowing(userId),
        this.getUserFollowers(userId),
        this.getRecentUserActivity(userId)
      ]);

      if (!user) throw new Error(`Utilisateur ${userId} non trouvé`);

      // 📊 Intégrer les données comportementales avancées
      const contentPreferences = behaviorProfile 
        ? this.mergeBehaviorContentPreferences(
            this.analyzeContentPreferences(recentLikes, recentRetweets),
            behaviorProfile.content_preferences
          )
        : this.analyzeContentPreferences(recentLikes, recentRetweets);
      
      // Analyser les patterns temporels (enrichi avec les données comportementales)
      const temporalPatterns = behaviorProfile
        ? this.mergeBehaviorTemporalPatterns(
            this.analyzeTemporalPatterns(recentActivity),
            behaviorProfile.temporal_patterns
          )
        : this.analyzeTemporalPatterns(recentActivity);
      
      // Analyser le réseau social
      const socialAnalysis = this.analyzeSocialNetwork(following, followers);
      
      // Calculer le niveau d'activité (enrichi avec les données comportementales)
      const activityLevel = behaviorProfile
        ? Math.max(
            this.calculateActivityLevel(recentActivity),
            behaviorProfile.activity_patterns?.activity_frequency === 'high' ? 0.8 : 
            behaviorProfile.activity_patterns?.activity_frequency === 'medium' ? 0.6 : 0.4
          )
        : this.calculateActivityLevel(recentActivity);
      
      // Déterminer le type d'utilisateur (enrichi avec les données comportementales)
      const userType = this.determineUserType(user, recentActivity, socialAnalysis, behaviorProfile);

      const profile = {
        userId,
        user,
        type: userType,
        confidence: this.calculateProfileConfidence(recentActivity, socialAnalysis, behaviorProfile),
        activityLevel,
        
        // 📊 Données comportementales avancées
        behaviorProfile,
        userPreferences,
        personalizationScore: userPreferences?.personalization_score || 0.5,
        behaviorConfidence: behaviorProfile?.behavior_confidence || 0.5,
        
        // Analyses comportementales enrichies
        contentPreferences,
        temporalPatterns,
        socialAnalysis,
        
        // Données d'interaction
        recentLikes: recentLikes.slice(0, 50),
        recentRetweets: recentRetweets.slice(0, 50),
        recentTweets: recentTweets.slice(0, 20),
        
        // Intérêts et préférences
        topInterests: this.extractTopInterests(contentPreferences),
        preferredAuthors: this.extractPreferredAuthors(recentLikes, recentRetweets),
        engagementPatterns: this.analyzeEngagementPatterns(recentLikes, recentRetweets),
        
        // Métriques
        engagementRate: this.calculateUserEngagementRate(recentActivity),
        influenceScore: this.calculateUserInfluence(socialAnalysis),
        
        timestamp: Date.now()
      };

      this.setInCache(cacheKey, profile, 'user');
      return profile;

    } catch (error) {
      logger.error('❌ Erreur création profil smart:', error);
      return this.createBasicProfile(userId);
    }
  }

  /**
   * 🔗 Fusionner les préférences de contenu avec les données comportementales
   */
  mergeBehaviorContentPreferences(traditionalPrefs, behaviorPrefs) {
    if (!behaviorPrefs) return traditionalPrefs;

    return {
      ...traditionalPrefs,
      // Ajouter les hashtags préférés des données comportementales
      hashtags: [
        ...(traditionalPrefs.hashtags || []),
        ...(behaviorPrefs.hashtags || []).map(h => h.hashtag)
      ].slice(0, 20),
      
      // Fusionner les auteurs préférés
      preferredAuthors: [
        ...(traditionalPrefs.preferredAuthors || []),
        ...(behaviorPrefs.authors || []).map(a => a.author_id)
      ].slice(0, 15),
      
      // Améliorer la confiance si on a des données comportementales
      confidence: Math.min(1, traditionalPrefs.confidence + 0.2)
    };
  }

  /**
   * ⏰ Fusionner les patterns temporels avec les données comportementales
   */
  mergeBehaviorTemporalPatterns(traditionalPatterns, behaviorPatterns) {
    if (!behaviorPatterns) return traditionalPatterns;

    return {
      ...traditionalPatterns,
      // Utiliser les heures d'activité des données comportementales si disponibles
      peakHours: behaviorPatterns.peak_hours?.length > 0 
        ? behaviorPatterns.peak_hours.map(p => p.hour)
        : traditionalPatterns.peakHours,
        
      // Fusionner l'activité hebdomadaire
      weeklyActivity: behaviorPatterns.weekly_activity || traditionalPatterns.weeklyActivity,
      
      // Améliorer la confiance temporelle
      confidence: Math.min(1, traditionalPatterns.confidence + 0.15)
    };
  }

  /**
   * 👤 Déterminer le type d'utilisateur avec données comportementales
   */
  determineUserType(user, recentActivity, socialAnalysis, behaviorProfile) {
    // Type de base basé sur l'analyse traditionnelle
    let baseType = this.determineBaseUserType(user, recentActivity, socialAnalysis);
    
    // Affiner avec les données comportementales
    if (behaviorProfile) {
      const engagementScore = behaviorProfile.engagement_patterns?.engagement_quality || 0;
      const socialActivity = behaviorProfile.engagement_patterns?.social_activity || 0;
      const contentConsumption = behaviorProfile.engagement_patterns?.content_consumption || 0;
      
      // Utilisateur très engagé
      if (engagementScore > 0.8 && socialActivity > 0.6) {
        return 'power_user';
      }
      
      // Utilisateur social
      if (socialActivity > 0.7) {
        return 'social_butterfly';
      }
      
      // Utilisateur consommateur
      if (contentConsumption > 0.8 && socialActivity < 0.3) {
        return 'lurker';
      }
      
      // Utilisateur découvreur
      if (behaviorProfile.activity_patterns?.activity_frequency === 'high' && 
          behaviorProfile.engagement_patterns?.preferred_interactions?.some(i => 
            i.type === 'search_query' || i.type === 'hashtag_click'
          )) {
        return 'explorer';
      }
    }
    
    return baseType;
  }

  /**
   * 📊 Calculer la confiance du profil avec données comportementales
   */
  calculateProfileConfidence(recentActivity, socialAnalysis, behaviorProfile) {
    let baseConfidence = this.calculateBaseProfileConfidence(recentActivity, socialAnalysis);
    
    if (behaviorProfile) {
      // Bonus pour la quantité de données comportementales
      const dataBonus = Math.min(0.3, behaviorProfile.total_actions / 500);
      
      // Bonus pour la confiance comportementale
      const behaviorBonus = (behaviorProfile.behavior_confidence || 0) * 0.2;
      
      // Bonus pour la récence des données
      const recentActivity = behaviorProfile.last_activity;
      const recencyBonus = recentActivity && 
        (Date.now() - new Date(recentActivity).getTime()) < 7 * 24 * 60 * 60 * 1000 
        ? 0.1 : 0;
      
      baseConfidence = Math.min(1, baseConfidence + dataBonus + behaviorBonus + recencyBonus);
    }
    
    return baseConfidence;
  }

  /**
   * 🎯 Améliorer le scoring avec les données comportementales
   */
  enhanceScoreWithBehaviorData(baseScore, tweet, userProfile) {
    if (!userProfile.behaviorProfile) return baseScore;
    
    let enhancedScore = baseScore;
    const behaviorProfile = userProfile.behaviorProfile;
    
    // Bonus pour les hashtags préférés de l'utilisateur
    if (behaviorProfile.content_preferences?.hashtags) {
      const tweetHashtags = this.extractHashtags(tweet.content || '');
      const hashtagMatch = tweetHashtags.some(tweetHashtag => 
        behaviorProfile.content_preferences.hashtags.some(preferred => 
          preferred.hashtag === tweetHashtag
        )
      );
      if (hashtagMatch) {
        enhancedScore += 10; // Bonus pour hashtag préféré
      }
    }
    
    // Bonus pour les auteurs avec lesquels l'utilisateur interagit
    if (behaviorProfile.content_preferences?.authors) {
      const authorInteraction = behaviorProfile.content_preferences.authors.find(
        author => author.author_id === tweet.user_id
      );
      if (authorInteraction) {
        enhancedScore += Math.min(15, authorInteraction.count); // Bonus proportionnel aux interactions
      }
    }
    
    // Pénalité pour le contenu que l'utilisateur évite généralement
    if (behaviorProfile.engagement_patterns?.preferred_interactions) {
      const userAvoidsTopic = this.checkIfUserAvoidsTopic(tweet, behaviorProfile);
      if (userAvoidsTopic) {
        enhancedScore -= 5;
      }
    }
    
    // Bonus temporel basé sur les habitudes utilisateur
    if (behaviorProfile.activity_patterns?.most_active_hours) {
      const currentHour = new Date().getHours();
      const isActiveHour = behaviorProfile.activity_patterns.most_active_hours.includes(currentHour);
      if (isActiveHour) {
        enhancedScore += 3; // Petit bonus pour le timing optimal
      }
    }
    
    return enhancedScore;
  }

  /**
   * 📊 Collecte et analyse de toutes les données disponibles
   */
  async collectAndAnalyzeAllData(userId, userProfile, limit) {
    try {
      logger.info(`📊 Collecte des données pour ${userProfile.topInterests.join(', ')}`);

      // Collecte parallèle de différentes sources
      const [
        trendingTweets,
        socialNetworkTweets,
        topicBasedTweets,
        popularTweets,
        recentTweets,
        similarUsersTweets,
        discoveryTweets
      ] = await Promise.all([
        this.collectTrendingTweets(limit),
        this.collectSocialNetworkTweets(userId, userProfile, limit),
        this.collectTopicBasedTweets(userProfile, limit),
        this.collectPopularTweets(limit),
        this.collectRecentQualityTweets(limit),
        this.collectSimilarUsersTweets(userId, userProfile, limit),
        this.collectDiscoveryTweets(userId, userProfile, limit)
      ]);

      // Fusion intelligente avec pondération
      const allTweets = [
        ...this.tagTweets(trendingTweets, 'trending', 0.25),
        ...this.tagTweets(socialNetworkTweets, 'social', 0.30),
        ...this.tagTweets(topicBasedTweets, 'topic', 0.35),
        ...this.tagTweets(popularTweets, 'popular', 0.20),
        ...this.tagTweets(recentTweets, 'recent', 0.15),
        ...this.tagTweets(similarUsersTweets, 'similar', 0.25),
        ...this.tagTweets(discoveryTweets, 'discovery', 0.15)
      ];

      // Déduplication intelligente
      const uniqueTweets = this.smartDeduplication(allTweets);

      // Filtrage par qualité et modération
      const qualityTweets = this.filterByQuality(uniqueTweets, userProfile);

      return {
        tweets: qualityTweets,
        totalDataPoints: allTweets.length,
        totalAvailable: await this.estimateTotalAvailable(userId),
        sources: {
          trending: trendingTweets.length,
          social: socialNetworkTweets.length,
          topic: topicBasedTweets.length,
          popular: popularTweets.length,
          recent: recentTweets.length,
          similar: similarUsersTweets.length,
          discovery: discoveryTweets.length
        }
      };

    } catch (error) {
      logger.error('❌ Erreur collecte données:', error);
      return { tweets: [], totalDataPoints: 0, totalAvailable: 0 };
    }
  }

  /**
   * 🎯 Application du système de scoring multi-dimensionnel
   */
  async applySmartScoring(tweets, userProfile) {
    try {
      logger.info(`🎯 Scoring de ${tweets.length} tweets`);

      // 🚀 1. Analyser les tweets éligibles au boost nouveau contenu
      const newContentBoosts = await this.analyzeNewContentBoost(tweets);
      const newContentBoostMap = new Map(newContentBoosts.map(b => [b.tweetId, b]));

      // 📈 2. Analyser les hashtags tendance
      const trendingHashtags = await this.analyzeTrendingHashtags();

      // 🚫 3. Vérifier les shadowbans (pour filtrer les tweets d'utilisateurs shadowbannés)
      const shadowbanChecks = new Map();

      const scoredTweets = await Promise.all(tweets.map(async (tweet) => {
        // Vérifier le shadowban de l'auteur (avec cache)
        let shadowbanStatus = shadowbanChecks.get(tweet.author_id);
        if (!shadowbanStatus) {
          shadowbanStatus = await this.checkShadowbanStatus(tweet.author_id);
          shadowbanChecks.set(tweet.author_id, shadowbanStatus);
        }

        // Si l'utilisateur est shadowbanned, réduire drastiquement la visibilité
        if (shadowbanStatus.isShadowbanned) {
          logger.warn(`🚫 Tweet ${tweet.id} de l'utilisateur shadowbanned ${tweet.author_id}`);
          return {
            ...tweet,
            smartScore: {
              total: 0.01, // Score minimal pour shadowban
              userEngagement: 0,
              contentQuality: 0,
              authorInfluence: 0,
              temporal: 0,
              behavioral: 0,
              sourceBonus: 0,
              shadowbanned: true,
              shadowbanReason: shadowbanStatus.reason
            }
          };
        }

        // Calcul des scores par dimension
        const userEngagementScore = await this.calculateUserEngagementScore(tweet, userProfile);
        const contentQualityScore = await this.calculateContentQualityScore(tweet, userProfile);
        const authorInfluenceScore = await this.calculateAuthorInfluenceScore(tweet, userProfile);
        const temporalScore = await this.calculateTemporalScore(tweet, userProfile);
        const behavioralScore = await this.calculateBehavioralScore(tweet, userProfile);

        // Score final pondéré
        let finalScore = 
          (userEngagementScore * this.scoringSystem.userEngagement.weight) +
          (contentQualityScore * this.scoringSystem.contentQuality.weight) +
          (authorInfluenceScore * this.scoringSystem.authorInfluence.weight) +
          (temporalScore * this.scoringSystem.temporalFactors.weight) +
          (behavioralScore * this.scoringSystem.behavioralIntelligence.weight);

        // Bonus pour le contexte source
        const sourceBonus = this.calculateSourceBonus(tweet);
        finalScore += sourceBonus;

        // 📊 AMÉLIORATION AVEC DONNÉES COMPORTEMENTALES
        const behaviorEnhancedScore = this.enhanceScoreWithBehaviorData(finalScore, tweet, userProfile);
        finalScore = behaviorEnhancedScore;

        // 🚀 BOOST NOUVEAU CONTENU
        let newContentBoost = 1;
        const newContentBoostInfo = newContentBoostMap.get(tweet.id);
        if (newContentBoostInfo) {
          newContentBoost = this.newContentBoost.boostMultiplier;
          finalScore *= newContentBoost;
          logger.info(`🚀 Boost nouveau contenu appliqué au tweet ${tweet.id} (x${newContentBoost})`);
        }

        // 📈 BOOST HASHTAGS TENDANCE
        const hashtagBoost = await this.calculateHashtagBoost(tweet, trendingHashtags);
        if (hashtagBoost > 1) {
          finalScore *= hashtagBoost;
          logger.info(`📈 Boost hashtag tendance appliqué au tweet ${tweet.id} (x${hashtagBoost})`);
        }

        return {
          ...tweet,
          smartScore: {
            total: Math.round(finalScore * 100) / 100,
            userEngagement: Math.round(userEngagementScore * 100) / 100,
            contentQuality: Math.round(contentQualityScore * 100) / 100,
            authorInfluence: Math.round(authorInfluenceScore * 100) / 100,
            temporal: Math.round(temporalScore * 100) / 100,
            behavioral: Math.round(behavioralScore * 100) / 100,
            sourceBonus: Math.round(sourceBonus * 100) / 100,
            newContentBoost: newContentBoost,
            hashtagBoost: Math.round(hashtagBoost * 100) / 100,
            shadowbanned: false
          }
        };
      }));

      // Tri par score décroissant
      const sortedTweets = scoredTweets.sort((a, b) => b.smartScore.total - a.smartScore.total);

      logger.info(`✅ Scoring terminé: ${newContentBoosts.length} boosts nouveau contenu, ${trendingHashtags.length} hashtags tendance`);
      return sortedTweets;

    } catch (error) {
      logger.error('❌ Erreur scoring smart:', error);
      return tweets;
    }
  }

  /**
   * 📈 Calcul du score d'engagement utilisateur
   */
  async calculateUserEngagementScore(tweet, userProfile) {
    try {
      let score = 0;
      const factors = this.scoringSystem.userEngagement.factors;

      // L'utilisateur suit-il l'auteur ?
      if (await this.userFollowsAuthor(userProfile.userId, tweet.user_id)) {
        score += factors.userFollowsAuthor.weight;
      }

      // L'auteur suit-il l'utilisateur ?
      if (await this.authorFollowsUser(tweet.user_id, userProfile.userId)) {
        score += factors.authorFollowsUser.weight;
      }

      // Connexions mutuelles
      const mutualConnections = await this.getMutualConnections(userProfile.userId, tweet.user_id);
      score += Math.min(factors.mutualConnections.weight, mutualConnections * 5);

      // Historique d'engagement avec l'auteur
      const engagementHistory = await this.getEngagementHistory(userProfile.userId, tweet.user_id);
      score += Math.min(factors.engagementHistory.weight, engagementHistory * 2);

      // Bonus si l'utilisateur a déjà aimé des tweets similaires
      const similarityBonus = this.calculateSimilarityBonus(tweet, userProfile);
      score += similarityBonus;

      return Math.min(100, score);
    } catch (error) {
      logger.error('❌ Erreur score engagement:', error);
      return 0;
    }
  }

  /**
   * ⭐ Calcul du score de qualité du contenu
   */
  async calculateContentQualityScore(tweet, userProfile) {
    try {
      let score = 0;
      const factors = this.scoringSystem.contentQuality.factors;

      // Métriques d'engagement (avec échelle logarithmique)
      const likes = await this.getTweetLikeCount(tweet.id);
      const retweets = await this.getTweetRetweetCount(tweet.id);
      const replies = await this.getTweetReplyCount(tweet.id);
      const views = tweet.view_count || 1;

      if (factors.likeCount.logarithmic) {
        score += Math.log10(likes + 1) * factors.likeCount.weight;
      } else {
        score += Math.min(factors.likeCount.weight, likes / 10);
      }

      if (factors.retweetCount.logarithmic) {
        score += Math.log10(retweets + 1) * factors.retweetCount.weight;
      } else {
        score += Math.min(factors.retweetCount.weight, retweets / 5);
      }

      if (factors.replyCount.logarithmic) {
        score += Math.log10(replies + 1) * factors.replyCount.weight;
      } else {
        score += Math.min(factors.replyCount.weight, replies / 3);
      }

      // Taux d'engagement
      const totalEngagement = likes + retweets + replies;
      const engagementRate = views > 0 ? (totalEngagement / views) * 100 : 0;
      score += Math.min(factors.engagementRate.weight, engagementRate * 5);

      // Qualité du contenu
      const contentLength = (tweet.content || '').length;
      const lengthScore = this.calculateLengthScore(contentLength, factors.contentLength.optimal);
      score += lengthScore * factors.contentLength.weight / 100;

      // Présence de médias
      if (tweet.media_urls && tweet.media_urls.length > 0) {
        score += factors.hasMedia.weight;
      }

      // Pertinence des hashtags
      const hashtagRelevance = this.calculateHashtagRelevance(tweet, userProfile);
      score += hashtagRelevance * factors.hashtagRelevance.weight / 100;

      return Math.min(100, score);
    } catch (error) {
      logger.error('❌ Erreur score qualité:', error);
      return 0;
    }
  }

  /**
   * 👑 Calcul du score d'influence de l'auteur
   */
  async calculateAuthorInfluenceScore(tweet, userProfile) {
    try {
      let score = 0;
      const factors = this.scoringSystem.authorInfluence.factors;
      const author = tweet.author || await User.findByPk(tweet.user_id);

      if (!author) return 0;

      // Nombre de followers (échelle logarithmique)
      const followers = author.stats?.followers || 0;
      if (factors.followerCount.logarithmic) {
        score += Math.log10(followers + 1) * factors.followerCount.weight;
      } else {
        score += Math.min(factors.followerCount.weight, followers / 1000);
      }

      // Ratio followers/following
      const following = author.stats?.following || 1;
      const ratio = followers / following;
      score += Math.min(factors.followingRatio.weight, ratio);

      // Vérification
      if (author.verified) {
        score += factors.verified.bonus;
      }

      // Premium
      if (author.premium) {
        score += factors.premium.bonus;
      }

      // Âge du compte
      const accountAge = Date.now() - new Date(author.created_at).getTime();
      const ageScore = this.calculateAgeScore(accountAge, factors.accountAge.optimal);
      score += ageScore * factors.accountAge.weight / 100;

      // Statut de modération
      if (author.moderation_status === 'approved' || !author.moderation_status) {
        score += factors.moderationStatus.weight;
      }

      return Math.min(100, score);
    } catch (error) {
      logger.error('❌ Erreur score influence:', error);
      return 0;
    }
  }

  /**
   * ⏰ Calcul du score temporel
   */
  async calculateTemporalScore(tweet, userProfile) {
    try {
      let score = 0;
      const factors = this.scoringSystem.temporalFactors.factors;
      const now = Date.now();
      const tweetTime = new Date(tweet.created_at).getTime();

      // Score de récence avec demi-vie
      const age = now - tweetTime;
      const halfLife = factors.recency.halfLife;
      const recencyScore = Math.exp(-age / halfLife) * 100;
      score += recencyScore * factors.recency.weight / 100;

      // Correspondance temporelle avec les habitudes utilisateur
      const timeOfDayScore = this.calculateTimeOfDayScore(tweet, userProfile);
      score += timeOfDayScore * factors.timeOfDay.weight / 100;

      // Détection de tendance
      const trendingScore = await this.calculateTrendingScore(tweet);
      score += trendingScore * factors.trending.weight / 100;

      // Momentum de popularité
      const momentumScore = await this.calculateMomentumScore(tweet);
      score += momentumScore * factors.momentumScore.weight / 100;

      return Math.min(100, score);
    } catch (error) {
      logger.error('❌ Erreur score temporel:', error);
      return 0;
    }
  }

  /**
   * 🧠 Calcul du score d'intelligence comportementale
   */
  async calculateBehavioralScore(tweet, userProfile) {
    try {
      let score = 0;
      const factors = this.scoringSystem.behavioralIntelligence.factors;

      // Correspondance avec les sujets préférés
      const topicMatch = this.calculateTopicMatch(tweet, userProfile.topInterests);
      score += topicMatch * factors.userTopics.weight / 100;

      // Correspondance linguistique
      const languageMatch = this.calculateLanguageMatch(tweet, userProfile);
      score += languageMatch * factors.userLanguage.weight / 100;

      // Affinité pour le type de contenu
      const contentAffinity = this.calculateContentAffinity(tweet, userProfile);
      score += contentAffinity * factors.contentAffinity.weight / 100;

      // Similarité avec les utilisateurs similaires
      const similarUserScore = await this.calculateSimilarUserScore(tweet, userProfile);
      score += similarUserScore * factors.similarUsers.weight / 100;

      // Pattern d'interaction habituel
      const interactionPattern = this.calculateInteractionPattern(tweet, userProfile);
      score += interactionPattern * factors.interactionPattern.weight / 100;

      return Math.min(100, score);
    } catch (error) {
      logger.error('❌ Erreur score comportemental:', error);
      return 0;
    }
  }

  /**
   * 🎨 Optimisation de la diversité intelligente
   */
  async optimizeDiversity(tweets, userProfile) {
    try {
      const diversifiedTweets = [];
      const usedAuthors = new Set();
      const usedTopics = new Set();
      const maxAuthorRepeat = 2; // Maximum 2 tweets par auteur
      const maxTopicRepeat = 3;  // Maximum 3 tweets par sujet

      // Premième passe : sélection diversifiée
      for (const tweet of tweets) {
        const authorId = tweet.user_id;
        const topics = this.extractTopics(tweet);
        
        // Vérifier la diversité d'auteur
        const authorCount = [...usedAuthors].filter(id => id === authorId).length;
        if (authorCount >= maxAuthorRepeat) continue;

        // Vérifier la diversité de sujets
        const topicOverlap = topics.filter(topic => usedTopics.has(topic)).length;
        if (topicOverlap >= maxTopicRepeat) continue;

        // Ajouter le tweet
        diversifiedTweets.push(tweet);
        usedAuthors.add(authorId);
        topics.forEach(topic => usedTopics.add(topic));

        // Arrêter si on a assez de tweets
        if (diversifiedTweets.length >= tweets.length * 0.8) break;
      }

      // Deuxième passe : compléter avec les meilleurs tweets restants
      const remainingTweets = tweets.filter(t => 
        !diversifiedTweets.find(dt => dt.id === t.id)
      );

      for (const tweet of remainingTweets) {
        if (diversifiedTweets.length >= tweets.length) break;
        diversifiedTweets.push(tweet);
      }

      return diversifiedTweets;
    } catch (error) {
      logger.error('❌ Erreur diversification:', error);
      return tweets;
    }
  }

  /**
   * 🎯 Finalisation des recommandations
   */
  async finalizeRecommendations(tweets, userProfile, limit, offset) {
    try {
      // Application de filtres finaux
      let filteredTweets = tweets.filter(tweet => {
        // Filtrer les tweets de l'utilisateur lui-même
        if (tweet.user_id === userProfile.userId) return false;
        
        // Filtrer les tweets déjà vus récemment
        if (this.isRecentlySeen(tweet, userProfile)) return false;
        
        // Filtrer les contenus inappropriés
        if (tweet.is_sensitive && !userProfile.user.allow_sensitive) return false;
        
        return true;
      });

      // Tri final par score
      filteredTweets.sort((a, b) => b.smartScore.total - a.smartScore.total);

      // Pagination
      return filteredTweets.slice(offset, offset + limit);
    } catch (error) {
      logger.error('❌ Erreur finalisation:', error);
      return tweets.slice(offset, offset + limit);
    }
  }

  /**
   * 💎 Enrichissement avec métadonnées
   */
  async enrichWithMetadata(tweets, userId) {
    try {
      return await Promise.all(tweets.map(async (tweet) => {
        const enriched = { ...tweet };

        // Statistiques d'engagement
        if (tweet.id) {
          const [likeCount, retweetCount, replyCount] = await Promise.all([
            this.getTweetLikeCount(tweet.id),
            this.getTweetRetweetCount(tweet.id),
            this.getTweetReplyCount(tweet.id)
          ]);

          enriched.stats = {
            likes: likeCount,
            retweets: retweetCount,
            replies: replyCount,
            views: tweet.view_count || 0
          };

          // Interactions utilisateur
          const [isLiked, isRetweeted] = await Promise.all([
            this.hasUserLiked(userId, tweet.id),
            this.hasUserRetweeted(userId, tweet.id)
          ]);

          enriched.userInteraction = {
            isLiked,
            isRetweeted
          };
        }

        return enriched;
      }));
    } catch (error) {
      logger.error('❌ Erreur enrichissement:', error);
      return tweets;
    }
  }

  // ========================================
  // MÉTHODES UTILITAIRES ET D'ANALYSE
  // ========================================

  /**
   * Méthodes de collecte de données spécialisées
   */
  async collectTrendingTweets(limit) {
    try {
      return await Tweet.findAll({
        where: {
          created_at: {
            [Op.gte]: new Date(Date.now() - this.dataAnalysis.trendingWindow)
          },
          moderation_status: { [Op.or]: ['approved', null] },
          is_private: false
        },
        include: [{ model: User, as: 'author' }],
        order: [
          [literal('(SELECT COUNT(*) FROM tweet_likes WHERE tweet_likes.tweet_id = "Tweet"."id") + (SELECT COUNT(*) FROM tweet_retweets WHERE tweet_retweets.tweet_id = "Tweet"."id")'), 'DESC']
        ],
        limit: Math.ceil(limit * 0.3)
      });
    } catch (error) {
      logger.error('❌ Erreur collecte trending:', error);
      return [];
    }
  }

  async collectSocialNetworkTweets(userId, userProfile, limit) {
    try {
      const followingIds = await UserFollow.findAll({
        where: { follower_id: userId },
        attributes: ['following_id']
      });

      if (followingIds.length === 0) return [];

      return await Tweet.findAll({
        where: {
          user_id: { [Op.in]: followingIds.map(f => f.following_id) },
          created_at: {
            [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          },
          moderation_status: { [Op.or]: ['approved', null] },
          is_private: false
        },
        include: [{ model: User, as: 'author' }],
        order: [['created_at', 'DESC']],
        limit: Math.ceil(limit * 0.4)
      });
    } catch (error) {
      logger.error('❌ Erreur collecte social:', error);
      return [];
    }
  }

  async collectTopicBasedTweets(userProfile, limit) {
    try {
      if (!userProfile.topInterests || userProfile.topInterests.length === 0) {
        return [];
      }

      return await Tweet.findAll({
        where: {
          [Op.or]: userProfile.topInterests.map(interest => ({
            content: { [Op.iLike]: `%${interest}%` }
          })),
          created_at: {
            [Op.gte]: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
          },
          moderation_status: { [Op.or]: ['approved', null] },
          is_private: false
        },
        include: [{ model: User, as: 'author' }],
        order: [['created_at', 'DESC']],
        limit: Math.ceil(limit * 0.5)
      });
    } catch (error) {
      logger.error('❌ Erreur collecte topics:', error);
      return [];
    }
  }

  async collectPopularTweets(limit) {
    try {
      return await Tweet.findAll({
        where: {
          created_at: {
            [Op.gte]: new Date(Date.now() - 48 * 60 * 60 * 1000) // 48h
          },
          moderation_status: { [Op.or]: ['approved', null] },
          is_private: false
        },
        include: [{ model: User, as: 'author' }],
        order: [['view_count', 'DESC']],
        limit: Math.ceil(limit * 0.3)
      });
    } catch (error) {
      logger.error('❌ Erreur collecte populaire:', error);
      return [];
    }
  }

  async collectRecentQualityTweets(limit) {
    try {
      return await Tweet.findAll({
        where: {
          created_at: {
            [Op.gte]: new Date(Date.now() - 12 * 60 * 60 * 1000) // 12h
          },
          moderation_status: 'approved',
          is_private: false
        },
        include: [{ model: User, as: 'author' }],
        order: [['created_at', 'DESC']],
        limit: Math.ceil(limit * 0.2)
      });
    } catch (error) {
      logger.error('❌ Erreur collecte récents:', error);
      return [];
    }
  }

  async collectSimilarUsersTweets(userId, userProfile, limit) {
    try {
      // Pour l'instant, retourner un tableau vide
      // Cette méthode peut être développée pour analyser les utilisateurs similaires
      return [];
    } catch (error) {
      logger.error('❌ Erreur collecte similaires:', error);
      return [];
    }
  }

  async collectDiscoveryTweets(userId, userProfile, limit) {
    try {
      return await Tweet.findAll({
        where: {
          user_id: { [Op.ne]: userId },
          created_at: {
            [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000)
          },
          moderation_status: { [Op.or]: ['approved', null] },
          is_private: false
        },
        include: [{ model: User, as: 'author' }],
        order: [fn('RANDOM')], // Ordre aléatoire pour la découverte
        limit: Math.ceil(limit * 0.2)
      });
    } catch (error) {
      logger.error('❌ Erreur collecte découverte:', error);
      return [];
    }
  }

  /**
   * Méthodes d'analyse comportementale
   */
  async getRecentUserLikes(userId) {
    try {
      return await TweetLike.findAll({
        where: {
          user_id: userId,
          created_at: {
            [Op.gte]: new Date(Date.now() - this.dataAnalysis.temporalAnalysisWindow)
          }
        },
        include: [{ model: Tweet, as: 'tweet' }],
        order: [['created_at', 'DESC']],
        limit: this.dataAnalysis.userBehaviorDepth
      });
    } catch (error) {
      logger.error('❌ Erreur récupération likes récents:', error);
      return [];
    }
  }

  async getRecentUserRetweets(userId) {
    try {
      return await TweetRetweet.findAll({
        where: {
          user_id: userId,
          created_at: {
            [Op.gte]: new Date(Date.now() - this.dataAnalysis.temporalAnalysisWindow)
          }
        },
        include: [{ model: Tweet, as: 'tweet' }],
        order: [['created_at', 'DESC']],
        limit: this.dataAnalysis.userBehaviorDepth
      });
    } catch (error) {
      logger.error('❌ Erreur récupération retweets récents:', error);
      return [];
    }
  }

  async getRecentUserTweets(userId) {
    try {
      return await Tweet.findAll({
        where: {
          user_id: userId,
          created_at: {
            [Op.gte]: new Date(Date.now() - this.dataAnalysis.temporalAnalysisWindow)
          }
        },
        order: [['created_at', 'DESC']],
        limit: 50
      });
    } catch (error) {
      logger.error('❌ Erreur récupération tweets récents:', error);
      return [];
    }
  }

  async getUserFollowing(userId) {
    try {
      return await UserFollow.findAll({
        where: { follower_id: userId },
        include: [{ model: User, as: 'following' }]
      });
    } catch (error) {
      logger.error('❌ Erreur récupération following:', error);
      return [];
    }
  }

  async getUserFollowers(userId) {
    try {
      return await UserFollow.findAll({
        where: { following_id: userId },
        include: [{ model: User, as: 'follower' }]
      });
    } catch (error) {
      logger.error('❌ Erreur récupération followers:', error);
      return [];
    }
  }

  async getRecentUserActivity(userId) {
    try {
      const [likes, retweets, tweets] = await Promise.all([
        this.getRecentUserLikes(userId),
        this.getRecentUserRetweets(userId),
        this.getRecentUserTweets(userId)
      ]);

      return {
        likes,
        retweets,
        tweets,
        totalActivity: likes.length + retweets.length + tweets.length
      };
    } catch (error) {
      logger.error('❌ Erreur récupération activité récente:', error);
      return { likes: [], retweets: [], tweets: [], totalActivity: 0 };
    }
  }

  /**
   * Méthodes d'analyse des préférences
   */
  analyzeContentPreferences(likes, retweets) {
    try {
      const preferences = {
        topics: {},
        authors: {},
        contentTypes: {},
        languages: {},
        timePatterns: {}
      };

      // Analyser les likes
      likes.forEach(like => {
        if (like.tweet) {
          this.analyzeContentElement(like.tweet, preferences);
        }
      });

      // Analyser les retweets
      retweets.forEach(retweet => {
        if (retweet.tweet) {
          this.analyzeContentElement(retweet.tweet, preferences, 1.5); // Poids plus élevé pour les retweets
        }
      });

      return preferences;
    } catch (error) {
      logger.error('❌ Erreur analyse préférences contenu:', error);
      return { topics: {}, authors: {}, contentTypes: {}, languages: {}, timePatterns: {} };
    }
  }

  analyzeContentElement(tweet, preferences, weight = 1) {
    try {
      // Analyser les sujets
      const content = (tweet.content || '').toLowerCase();
      const words = content.split(/\s+/).filter(word => word.length > 3);
      words.forEach(word => {
        preferences.topics[word] = (preferences.topics[word] || 0) + weight;
      });

      // Analyser les auteurs
      if (tweet.author) {
        const authorId = tweet.author.id;
        preferences.authors[authorId] = (preferences.authors[authorId] || 0) + weight;
      }

      // Analyser les types de contenu
      let contentType = 'text';
      if (tweet.media_urls && tweet.media_urls.length > 0) contentType = 'media';
      if (tweet.is_retweet) contentType = 'retweet';
      if (tweet.parent_tweet_id) contentType = 'reply';

      preferences.contentTypes[contentType] = (preferences.contentTypes[contentType] || 0) + weight;

      // Analyser la langue
      const language = tweet.language || 'unknown';
      preferences.languages[language] = (preferences.languages[language] || 0) + weight;

      // Analyser les patterns temporels
      const hour = new Date(tweet.created_at).getHours();
      preferences.timePatterns[hour] = (preferences.timePatterns[hour] || 0) + weight;
    } catch (error) {
      logger.error('❌ Erreur analyse élément contenu:', error);
    }
  }

  analyzeTemporalPatterns(activity) {
    try {
      const patterns = {
        hourlyActivity: new Array(24).fill(0),
        dailyActivity: new Array(7).fill(0),
        peakHours: [],
        mostActiveDay: 0
      };

      const allActivities = [
        ...activity.likes,
        ...activity.retweets,
        ...activity.tweets
      ];

      allActivities.forEach(item => {
        const date = new Date(item.created_at);
        const hour = date.getHours();
        const day = date.getDay();

        patterns.hourlyActivity[hour]++;
        patterns.dailyActivity[day]++;
      });

      // Trouver les heures de pic
      patterns.peakHours = patterns.hourlyActivity
        .map((activity, hour) => ({ hour, activity }))
        .filter(item => item.activity > 0)
        .sort((a, b) => b.activity - a.activity)
        .slice(0, 3);

      // Jour le plus actif
      patterns.mostActiveDay = patterns.dailyActivity
        .indexOf(Math.max(...patterns.dailyActivity));

      return patterns;
    } catch (error) {
      logger.error('❌ Erreur analyse patterns temporels:', error);
      return { hourlyActivity: [], dailyActivity: [], peakHours: [], mostActiveDay: 0 };
    }
  }

  analyzeSocialNetwork(following, followers) {
    try {
      return {
        followingCount: following.length,
        followersCount: followers.length,
        ratio: following.length > 0 ? followers.length / following.length : 0,
        networkSize: following.length + followers.length,
        influence: Math.log10(followers.length + 1) * 10
      };
    } catch (error) {
      logger.error('❌ Erreur analyse réseau social:', error);
      return { followingCount: 0, followersCount: 0, ratio: 0, networkSize: 0, influence: 0 };
    }
  }

  calculateActivityLevel(activity) {
    try {
      const total = activity.totalActivity;
      if (total > 50) return 'high';
      if (total > 15) return 'medium';
      if (total > 5) return 'low';
      return 'very_low';
    } catch (error) {
      logger.error('❌ Erreur calcul niveau activité:', error);
      return 'unknown';
    }
  }

  determineUserType(user, activity, socialAnalysis) {
    try {
      const totalActivity = activity.totalActivity;
      const influence = socialAnalysis.influence;

      if (user.verified) return 'verified';
      if (user.premium) return 'premium';
      if (influence > 50 && totalActivity > 30) return 'influencer';
      if (totalActivity > 50) return 'power_user';
      if (totalActivity > 15) return 'active_user';
      if (totalActivity > 5) return 'casual_user';
      return 'new_user';
    } catch (error) {
      logger.error('❌ Erreur détermination type utilisateur:', error);
      return 'unknown';
    }
  }

  calculateProfileConfidence(activity, socialAnalysis) {
    try {
      let confidence = 0.3; // Base

      // Bonus pour l'activité
      confidence += Math.min(0.4, activity.totalActivity / 100);

      // Bonus pour le réseau social
      confidence += Math.min(0.2, socialAnalysis.networkSize / 500);

      // Bonus pour l'influence
      confidence += Math.min(0.1, socialAnalysis.influence / 100);

      return Math.min(1.0, confidence);
    } catch (error) {
      logger.error('❌ Erreur calcul confiance profil:', error);
      return 0.5;
    }
  }

  extractTopInterests(contentPreferences) {
    try {
      return Object.entries(contentPreferences.topics)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([topic]) => topic);
    } catch (error) {
      logger.error('❌ Erreur extraction intérêts:', error);
      return ['general'];
    }
  }

  extractPreferredAuthors(likes, retweets) {
    try {
      const authorCounts = {};

      [...likes, ...retweets].forEach(interaction => {
        if (interaction.tweet && interaction.tweet.author) {
          const authorId = interaction.tweet.author.id;
          authorCounts[authorId] = (authorCounts[authorId] || 0) + 1;
        }
      });

      return Object.entries(authorCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([authorId]) => parseInt(authorId));
    } catch (error) {
      logger.error('❌ Erreur extraction auteurs préférés:', error);
      return [];
    }
  }

  analyzeEngagementPatterns(likes, retweets) {
    try {
      const patterns = {
        preferredContentLength: 0,
        preferredTimeSlots: [],
        engagementTypes: {},
        averageEngagementDelay: 0
      };

      // Analyser la longueur de contenu préférée
      const lengths = [...likes, ...retweets]
        .map(interaction => interaction.tweet?.content?.length || 0)
        .filter(length => length > 0);

      if (lengths.length > 0) {
        patterns.preferredContentLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      }

      // Analyser les créneaux horaires préférés
      const hourCounts = {};
      [...likes, ...retweets].forEach(interaction => {
        const hour = new Date(interaction.created_at).getHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      });

      patterns.preferredTimeSlots = Object.entries(hourCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([hour]) => parseInt(hour));

      return patterns;
    } catch (error) {
      logger.error('❌ Erreur analyse patterns engagement:', error);
      return { preferredContentLength: 100, preferredTimeSlots: [12, 18, 21], engagementTypes: {}, averageEngagementDelay: 0 };
    }
  }

  calculateUserEngagementRate(activity) {
    try {
      const total = activity.totalActivity;
      const timeWindowDays = this.dataAnalysis.temporalAnalysisWindow / (24 * 60 * 60 * 1000);
      return total / timeWindowDays; // Engagements par jour
    } catch (error) {
      logger.error('❌ Erreur calcul taux engagement utilisateur:', error);
      return 0;
    }
  }

  calculateUserInfluence(socialAnalysis) {
    try {
      return socialAnalysis.influence;
    } catch (error) {
      logger.error('❌ Erreur calcul influence utilisateur:', error);
      return 0;
    }
  }

  /**
   * Méthodes utilitaires de scoring
   */
  tagTweets(tweets, source, weight) {
    return tweets.map(tweet => ({ ...tweet, source, sourceWeight: weight }));
  }

  smartDeduplication(tweets) {
    const seen = new Set();
    return tweets.filter(tweet => {
      const key = tweet.id || `${tweet.content}_${tweet.user_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  filterByQuality(tweets, userProfile) {
    return tweets.filter(tweet => {
      // Filtrer les tweets supprimés ou privés
      if (tweet.deleted_at || tweet.is_private) return false;
      
      // Filtrer selon le statut de modération
      if (tweet.moderation_status === 'rejected') return false;
      
      // Filtrer le contenu sensible si l'utilisateur ne l'autorise pas
      if (tweet.is_sensitive && !userProfile.user.allow_sensitive) return false;
      
      return true;
    });
  }

  calculateSourceBonus(tweet) {
    const sourceWeights = {
      'topic': 0.15,
      'social': 0.12,
      'trending': 0.10,
      'similar': 0.08,
      'popular': 0.05,
      'discovery': 0.03,
      'recent': 0.02
    };

    return sourceWeights[tweet.source] || 0;
  }

  /**
   * Méthodes de vérification et calculs de scores spécialisés
   */
  async userFollowsAuthor(userId, authorId) {
    try {
      const follow = await UserFollow.findOne({
        where: { follower_id: userId, following_id: authorId }
      });
      return !!follow;
    } catch (error) {
      return false;
    }
  }

  async authorFollowsUser(authorId, userId) {
    try {
      const follow = await UserFollow.findOne({
        where: { follower_id: authorId, following_id: userId }
      });
      return !!follow;
    } catch (error) {
      return false;
    }
  }

  async getMutualConnections(userId, authorId) {
    try {
      const userFollowing = await UserFollow.findAll({
        where: { follower_id: userId },
        attributes: ['following_id']
      });
      
      const authorFollowing = await UserFollow.findAll({
        where: { follower_id: authorId },
        attributes: ['following_id']
      });

      const userFollowingIds = new Set(userFollowing.map(f => f.following_id));
      const authorFollowingIds = new Set(authorFollowing.map(f => f.following_id));

      let mutualCount = 0;
      for (const id of userFollowingIds) {
        if (authorFollowingIds.has(id)) mutualCount++;
      }

      return mutualCount;
    } catch (error) {
      return 0;
    }
  }

  async getEngagementHistory(userId, authorId) {
    try {
      const [likes, retweets] = await Promise.all([
        TweetLike.count({
          include: [{
            model: Tweet,
            as: 'tweet',
            where: { user_id: authorId }
          }],
          where: { user_id: userId }
        }),
        TweetRetweet.count({
          include: [{
            model: Tweet,
            as: 'tweet',
            where: { user_id: authorId }
          }],
          where: { user_id: userId }
        })
      ]);

      return likes + retweets;
    } catch (error) {
      return 0;
    }
  }

  calculateSimilarityBonus(tweet, userProfile) {
    try {
      let bonus = 0;

      // Bonus pour les sujets d'intérêt
      const tweetContent = (tweet.content || '').toLowerCase();
      userProfile.topInterests.forEach(interest => {
        if (tweetContent.includes(interest.toLowerCase())) {
          bonus += 5;
        }
      });

      // Bonus pour les auteurs préférés
      if (userProfile.preferredAuthors.includes(tweet.user_id)) {
        bonus += 10;
      }

      return Math.min(20, bonus);
    } catch (error) {
      return 0;
    }
  }

  async getTweetLikeCount(tweetId) {
    try {
      return await TweetLike.count({ where: { tweet_id: tweetId } });
    } catch (error) {
      return 0;
    }
  }

  async getTweetRetweetCount(tweetId) {
    try {
      return await TweetRetweet.count({ where: { tweet_id: tweetId } });
    } catch (error) {
      return 0;
    }
  }

  async getTweetReplyCount(tweetId) {
    try {
      return await Tweet.count({ where: { parent_tweet_id: tweetId } });
    } catch (error) {
      return 0;
    }
  }

  calculateLengthScore(length, optimal) {
    const diff = Math.abs(length - optimal);
    return Math.max(0, 100 - (diff / optimal) * 100);
  }

  calculateHashtagRelevance(tweet, userProfile) {
    try {
      if (!tweet.hashtags || !userProfile.topInterests) return 0;

      const relevantHashtags = tweet.hashtags.filter(hashtag =>
        userProfile.topInterests.some(interest =>
          hashtag.toLowerCase().includes(interest.toLowerCase())
        )
      );

      return Math.min(100, (relevantHashtags.length / tweet.hashtags.length) * 100);
    } catch (error) {
      return 0;
    }
  }

  calculateAgeScore(age, optimal) {
    const diff = Math.abs(age - optimal);
    return Math.max(0, 100 - (diff / optimal) * 100);
  }

  calculateTimeOfDayScore(tweet, userProfile) {
    try {
      const tweetHour = new Date(tweet.created_at).getHours();
      const preferredHours = userProfile.temporalPatterns?.peakHours?.map(p => p.hour) || [12, 18, 21];
      
      if (preferredHours.includes(tweetHour)) return 100;
      
      // Score dégradé basé sur la proximité
      const minDistance = Math.min(...preferredHours.map(hour => 
        Math.min(Math.abs(hour - tweetHour), 24 - Math.abs(hour - tweetHour))
      ));
      
      return Math.max(0, 100 - (minDistance * 10));
    } catch (error) {
      return 50;
    }
  }

  async calculateTrendingScore(tweet) {
    try {
      // Calculer le score de tendance basé sur la vitesse d'engagement récente
      const now = Date.now();
      const tweetTime = new Date(tweet.created_at).getTime();
      const ageHours = (now - tweetTime) / (60 * 60 * 1000);

      if (ageHours > 48) return 0; // Trop vieux pour être tendance

      const [likes, retweets] = await Promise.all([
        this.getTweetLikeCount(tweet.id),
        this.getTweetRetweetCount(tweet.id)
      ]);

      const totalEngagement = likes + retweets;
      const engagementPerHour = totalEngagement / Math.max(1, ageHours);

      return Math.min(100, engagementPerHour * 5);
    } catch (error) {
      return 0;
    }
  }

  async calculateMomentumScore(tweet) {
    try {
      // Pour simplifier, retourner un score basé sur l'âge et l'engagement
      const now = Date.now();
      const tweetTime = new Date(tweet.created_at).getTime();
      const ageMinutes = (now - tweetTime) / (60 * 1000);

      if (ageMinutes > 720) return 0; // Plus de 12h = pas de momentum

      const views = tweet.view_count || 1;
      const momentumScore = Math.max(0, 100 - (ageMinutes / 10));

      return Math.min(100, momentumScore * (Math.log10(views) / 3));
    } catch (error) {
      return 0;
    }
  }

  calculateTopicMatch(tweet, topInterests) {
    try {
      if (!topInterests || topInterests.length === 0) return 0;

      const content = (tweet.content || '').toLowerCase();
      let matchScore = 0;

      topInterests.forEach((interest, index) => {
        if (content.includes(interest.toLowerCase())) {
          // Score plus élevé pour les premiers intérêts (plus importants)
          matchScore += Math.max(20 - index * 2, 5);
        }
      });

      return Math.min(100, matchScore);
    } catch (error) {
      return 0;
    }
  }

  calculateLanguageMatch(tweet, userProfile) {
    try {
      const tweetLanguage = tweet.language || 'unknown';
      const userLanguage = userProfile.user?.language || 'fr';

      return tweetLanguage === userLanguage ? 100 : 0;
    } catch (error) {
      return 50;
    }
  }

  calculateContentAffinity(tweet, userProfile) {
    try {
      const tweetType = this.getTweetType(tweet);
      const preferences = userProfile.contentPreferences?.contentTypes || {};
      
      const preference = preferences[tweetType] || 0;
      const maxPreference = Math.max(...Object.values(preferences), 1);
      
      return (preference / maxPreference) * 100;
    } catch (error) {
      return 50;
    }
  }

  getTweetType(tweet) {
    if (tweet.media_urls && tweet.media_urls.length > 0) return 'media';
    if (tweet.is_retweet) return 'retweet';
    if (tweet.parent_tweet_id) return 'reply';
    return 'text';
  }

  async calculateSimilarUserScore(tweet, userProfile) {
    try {
      // Pour l'instant, retourner un score de base
      // Cette méthode peut être développée pour analyser les utilisateurs similaires
      return 50;
    } catch (error) {
      return 0;
    }
  }

  calculateInteractionPattern(tweet, userProfile) {
    try {
      const tweetHour = new Date(tweet.created_at).getHours();
      const preferredHours = userProfile.engagementPatterns?.preferredTimeSlots || [12, 18, 21];
      
      if (preferredHours.includes(tweetHour)) return 100;
      
      return 30; // Score de base
    } catch (error) {
      return 50;
    }
  }

  extractTopics(tweet) {
    try {
      const content = (tweet.content || '').toLowerCase();
      const hashtags = tweet.hashtags || [];
      const words = content.split(/\s+/).filter(word => word.length > 3);
      
      return [...new Set([...hashtags, ...words.slice(0, 5)])];
    } catch (error) {
      return [];
    }
  }

  isRecentlySeen(tweet, userProfile) {
    try {
      // Pour l'instant, considérer qu'aucun tweet n'a été vu récemment
      // Cette logique peut être développée pour tracker les tweets vus
      return false;
    } catch (error) {
      return false;
    }
  }

  async hasUserLiked(userId, tweetId) {
    try {
      const like = await TweetLike.findOne({
        where: { user_id: userId, tweet_id: tweetId }
      });
      return !!like;
    } catch (error) {
      return false;
    }
  }

  async hasUserRetweeted(userId, tweetId) {
    try {
      const retweet = await TweetRetweet.findOne({
        where: { user_id: userId, tweet_id: tweetId }
      });
      return !!retweet;
    } catch (error) {
      return false;
    }
  }

  async estimateTotalAvailable(userId) {
    try {
      return await Tweet.count({
        where: {
          user_id: { [Op.ne]: userId },
          moderation_status: { [Op.or]: ['approved', null] },
          is_private: false,
          deleted_at: null
        }
      });
    } catch (error) {
      return 1000;
    }
  }

  /**
   * Méthodes de métriques de qualité
   */
  calculateAverageScore(tweets) {
    if (tweets.length === 0) return 0;
    const totalScore = tweets.reduce((sum, tweet) => sum + (tweet.smartScore?.total || 0), 0);
    return Math.round((totalScore / tweets.length) * 100) / 100;
  }

  calculateDiversityScore(tweets) {
    try {
      const authors = new Set(tweets.map(t => t.user_id));
      const topics = new Set(tweets.flatMap(t => this.extractTopics(t)));
      
      const authorDiversity = authors.size / Math.max(tweets.length, 1);
      const topicDiversity = topics.size / Math.max(tweets.length, 1);
      
      return Math.round(((authorDiversity + topicDiversity) / 2) * 100);
    } catch (error) {
      return 70;
    }
  }

  calculateRelevanceScore(tweets, userProfile) {
    try {
      if (tweets.length === 0) return 0;
      
      const relevanceScores = tweets.map(tweet => {
        const topicMatch = this.calculateTopicMatch(tweet, userProfile.topInterests);
        const authorMatch = userProfile.preferredAuthors.includes(tweet.user_id) ? 50 : 0;
        return (topicMatch + authorMatch) / 2;
      });
      
      const averageRelevance = relevanceScores.reduce((a, b) => a + b, 0) / relevanceScores.length;
      return Math.round(averageRelevance);
    } catch (error) {
      return 50;
    }
  }

  calculateFreshnessScore(tweets) {
    try {
      if (tweets.length === 0) return 0;
      
      const now = Date.now();
      const freshnessScores = tweets.map(tweet => {
        const age = now - new Date(tweet.created_at).getTime();
        const ageHours = age / (60 * 60 * 1000);
        return Math.max(0, 100 - (ageHours * 2)); // 2 points perdus par heure
      });
      
      const averageFreshness = freshnessScores.reduce((a, b) => a + b, 0) / freshnessScores.length;
      return Math.round(averageFreshness);
    } catch (error) {
      return 50;
    }
  }

  calculateEfficiency(startTime) {
    const processingTime = Date.now() - startTime;
    return Math.max(0.1, Math.min(1, 1000 / processingTime));
  }

  /**
   * Méthodes de cache et performance
   */
  getFromCache(key, type) {
    try {
      const cache = this.getCacheByType(type);
      const entry = cache.get(key);
      
      if (!entry) return null;
      
      const ttl = this.cacheConfig[`${type}TTL`] || this.cacheConfig.recommendationTTL;
      if (Date.now() - entry.timestamp > ttl) {
        cache.delete(key);
        return null;
      }
      
      return entry.data;
    } catch (error) {
      return null;
    }
  }

  setInCache(key, data, type) {
    try {
      const cache = this.getCacheByType(type);
      
      // Maintenir la taille du cache
      if (cache.size >= this.cacheConfig.maxCacheSize) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
      }
      
      cache.set(key, {
        data,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('❌ Erreur mise en cache:', error);
    }
  }

  getCacheByType(type) {
    switch (type) {
      case 'user': return this.userCache;
      case 'score': return this.scoreCache;
      case 'analysis': return this.analysisCache;
      default: return this.cache;
    }
  }

  /**
   * Profil de base en cas d'erreur
   */
  createBasicProfile(userId) {
    return {
      userId,
      user: { id: userId, allow_sensitive: false },
      type: 'basic',
      confidence: 0.3,
      activityLevel: 'low',
      contentPreferences: { topics: {}, authors: {}, contentTypes: {}, languages: {}, timePatterns: {} },
      temporalPatterns: { hourlyActivity: [], dailyActivity: [], peakHours: [], mostActiveDay: 0 },
      socialAnalysis: { followingCount: 0, followersCount: 0, ratio: 0, networkSize: 0, influence: 0 },
      recentLikes: [],
      recentRetweets: [],
      recentTweets: [],
      topInterests: ['general'],
      preferredAuthors: [],
      engagementPatterns: { preferredContentLength: 100, preferredTimeSlots: [12, 18, 21], engagementTypes: {}, averageEngagementDelay: 0 },
      engagementRate: 0,
      influenceScore: 0,
      timestamp: Date.now()
    };
  }

  /**
   * Recommandations de fallback
   */
  async getFallbackRecommendations(userId, options) {
    try {
      const { limit = 50, offset = 0 } = options;
      
      const tweets = await Tweet.findAll({
        where: {
          user_id: { [Op.ne]: userId },
          moderation_status: { [Op.or]: ['approved', null] },
          is_private: false,
          created_at: {
            [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          }
        },
        include: [{ model: User, as: 'author' }],
        order: [['view_count', 'DESC'], ['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      return {
        recommendations: tweets,
        pagination: {
          total: tweets.length,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: tweets.length === parseInt(limit)
        },
        metadata: {
          algorithm: 'smart_fallback',
          context: 'fallback'
        }
      };
    } catch (error) {
      logger.error('❌ Erreur fallback smart:', error);
      return { recommendations: [], pagination: { total: 0, hasMore: false } };
    }
  }

  /**
   * Mise à jour des métriques
   */
  updateMetrics(result, processingTime) {
    this.metrics.averageProcessingTime = 
      (this.metrics.averageProcessingTime + processingTime) / 2;
  }

  /**
   * Processus de maintenance
   */
  startMaintenanceProcesses() {
    // Nettoyage du cache toutes les 10 minutes
    setInterval(() => {
      this.cleanupCache();
    }, 10 * 60 * 1000);

    // Mise à jour des métriques toutes les 5 minutes
    setInterval(() => {
      this.updateGlobalMetrics();
    }, 5 * 60 * 1000);
  }

  // 🚀 SYSTÈME DE BOOST POUR NOUVEAU CONTENU
  async analyzeNewContentBoost(tweets) {
    try {
      const now = Date.now();
      const boostEligibleTweets = [];

      for (const tweet of tweets) {
        const tweetAge = now - new Date(tweet.created_at).getTime();
        const views = tweet.view_count || 0;

        // Vérifier si le tweet est éligible au boost nouveau contenu
        if (tweetAge <= this.newContentBoost.maxAge && 
            views <= this.newContentBoost.minViews) {
          
          // Vérifier la qualité minimum requise
          const qualityScore = await this.calculateContentQuality(tweet);
          if (qualityScore >= this.newContentBoost.qualityRequired) {
            boostEligibleTweets.push({
              tweetId: tweet.id,
              authorId: tweet.user_id,
              age: tweetAge,
              views: views,
              qualityScore: qualityScore
            });
          }
        }
      }

      // Limiter le nombre de boost par utilisateur
      const userBoostCount = new Map();
      const finalBoostTweets = boostEligibleTweets.filter(tweet => {
        const count = userBoostCount.get(tweet.authorId) || 0;
        if (count < this.newContentBoost.maxBoostPerUser) {
          userBoostCount.set(tweet.authorId, count + 1);
          return true;
        }
        return false;
      });

      logger.info(`🚀 Nouveau contenu éligible au boost: ${finalBoostTweets.length} tweets`);
      return finalBoostTweets;

    } catch (error) {
      logger.error('❌ Erreur analyse nouveau contenu:', error);
      return [];
    }
  }

  // 📈 SYSTÈME D'ANALYSE DES HASHTAGS TENDANCE
  async analyzeTrendingHashtags() {
    try {
      const cacheKey = 'trending_hashtags_24h';
      const cached = this.trendingHashtagsCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.cacheConfig.trendingHashtagsTTL) {
        return cached.data;
      }

      const twentyFourHoursAgo = new Date(Date.now() - this.trendingHashtagBoost.analysisWindow);

      // Extraire tous les hashtags des tweets récents
      const recentTweets = await Tweet.findAll({
        where: {
          created_at: {
            [Op.gte]: twentyFourHoursAgo
          }
        },
        attributes: ['content', 'created_at'],
        limit: 10000 // Limite pour la performance
      });

      // Analyser les hashtags
      const hashtagCount = new Map();
      const hashtagRegex = /#([a-zA-Z0-9_À-ÿ]+)/g;

      recentTweets.forEach(tweet => {
        const matches = tweet.content.match(hashtagRegex);
        if (matches) {
          matches.forEach(hashtag => {
            const cleanHashtag = hashtag.toLowerCase();
            hashtagCount.set(cleanHashtag, (hashtagCount.get(cleanHashtag) || 0) + 1);
          });
        }
      });

      // Filtrer et trier les hashtags tendance
      const trendingHashtags = Array.from(hashtagCount.entries())
        .filter(([hashtag, count]) => count >= this.trendingHashtagBoost.minUsageCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, this.trendingHashtagBoost.maxHashtagsAnalyzed)
        .map(([hashtag, count]) => ({
          hashtag,
          count,
          trending_score: Math.min(count / this.trendingHashtagBoost.minUsageCount, 10)
        }));

      // Mettre en cache
      this.trendingHashtagsCache.set(cacheKey, {
        data: trendingHashtags,
        timestamp: Date.now()
      });

      logger.info(`📈 Hashtags tendance analysés: ${trendingHashtags.length} trouvés`);
      return trendingHashtags;

    } catch (error) {
      logger.error('❌ Erreur analyse hashtags tendance:', error);
      return [];
    }
  }

  async calculateHashtagBoost(tweet, trendingHashtags) {
    try {
      if (!trendingHashtags.length) return 1;

      const hashtagRegex = /#([a-zA-Z0-9_À-ÿ]+)/g;
      const tweetHashtags = tweet.content.match(hashtagRegex) || [];
      
      let totalBoost = 1;
      let matchedTrending = 0;

      tweetHashtags.forEach(hashtag => {
        const cleanHashtag = hashtag.toLowerCase();
        const trending = trendingHashtags.find(th => th.hashtag === cleanHashtag);
        if (trending) {
          totalBoost += (trending.trending_score / 10) * (this.trendingHashtagBoost.boostMultiplier - 1);
          matchedTrending++;
        }
      });

      return Math.min(totalBoost, this.trendingHashtagBoost.boostMultiplier);

    } catch (error) {
      logger.error('❌ Erreur calcul boost hashtag:', error);
      return 1;
    }
  }

  // 🚫 SYSTÈME DE SHADOWBAN
  async checkShadowbanStatus(userId) {
    try {
      const cacheKey = `shadowban_${userId}`;
      const cached = this.shadowbanCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.cacheConfig.shadowbanTTL) {
        return cached.data;
      }

      const now = Date.now();
      const analysis = {
        isShadowbanned: false,
        reason: null,
        bannedUntil: null,
        violations: []
      };

      // 1. Vérifier le spam (trop de tweets trop vite)
      const spamCheck = await this.checkSpamViolation(userId);
      if (spamCheck.violation) {
        analysis.isShadowbanned = true;
        analysis.reason = 'spam_detection';
        analysis.bannedUntil = now + this.shadowbanSystem.spamDetection.cooldownPeriod;
        analysis.violations.push(spamCheck);
      }

      // 2. Vérifier la qualité du contenu sur 3 jours
      const qualityCheck = await this.checkContentQualityViolation(userId);
      if (qualityCheck.violation) {
        analysis.isShadowbanned = true;
        analysis.reason = 'low_quality_content';
        analysis.bannedUntil = now + this.shadowbanSystem.contentQuality.shadowbanDuration;
        analysis.violations.push(qualityCheck);
      }

      // Mettre en cache
      this.shadowbanCache.set(cacheKey, {
        data: analysis,
        timestamp: now
      });

      if (analysis.isShadowbanned) {
        logger.warn(`🚫 Utilisateur ${userId} shadowbanned: ${analysis.reason}`);
      }

      return analysis;

    } catch (error) {
      logger.error('❌ Erreur vérification shadowban:', error);
      return { isShadowbanned: false, reason: null };
    }
  }

  async checkSpamViolation(userId) {
    try {
      const now = Date.now();
      const oneHourAgo = new Date(now - 60 * 60 * 1000);
      const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

      // Compter les tweets de la dernière heure
      const tweetsLastHour = await Tweet.count({
        where: {
          user_id: userId,
          created_at: { [Op.gte]: oneHourAgo }
        }
      });

      // Compter les tweets du dernier jour
      const tweetsLastDay = await Tweet.count({
        where: {
          user_id: userId,
          created_at: { [Op.gte]: oneDayAgo }
        }
      });

      const hourlyViolation = tweetsLastHour > this.shadowbanSystem.spamDetection.maxTweetsPerHour;
      const dailyViolation = tweetsLastDay > this.shadowbanSystem.spamDetection.maxTweetsPerDay;

      return {
        violation: hourlyViolation || dailyViolation,
        tweetsLastHour,
        tweetsLastDay,
        maxHourly: this.shadowbanSystem.spamDetection.maxTweetsPerHour,
        maxDaily: this.shadowbanSystem.spamDetection.maxTweetsPerDay
      };

    } catch (error) {
      logger.error('❌ Erreur vérification spam:', error);
      return { violation: false };
    }
  }

  async checkContentQualityViolation(userId) {
    try {
      const threeDaysAgo = new Date(Date.now() - this.shadowbanSystem.contentQuality.analysisWindow);

      // Récupérer les tweets des 3 derniers jours
      const recentTweets = await Tweet.findAll({
        where: {
          user_id: userId,
          created_at: { [Op.gte]: threeDaysAgo }
        },
        attributes: ['id', 'content', 'view_count', 'created_at']
      });

      if (recentTweets.length < 5) return { violation: false }; // Pas assez de données

      // Calculer le score de qualité pour chaque tweet
      let lowQualityCount = 0;
      for (const tweet of recentTweets) {
        const qualityScore = await this.calculateContentQuality(tweet);
        if (qualityScore < this.shadowbanSystem.contentQuality.minQualityThreshold) {
          lowQualityCount++;
        }
      }

      const lowQualityRatio = lowQualityCount / recentTweets.length;
      const violation = lowQualityRatio > this.shadowbanSystem.contentQuality.maxLowQualityRatio;

      return {
        violation,
        totalTweets: recentTweets.length,
        lowQualityCount,
        lowQualityRatio,
        threshold: this.shadowbanSystem.contentQuality.maxLowQualityRatio
      };

    } catch (error) {
      logger.error('❌ Erreur vérification qualité:', error);
      return { violation: false };
    }
  }

  async calculateContentQuality(tweet) {
    try {
      const now = Date.now();
      const tweetAge = now - new Date(tweet.created_at).getTime();
      const ageInHours = tweetAge / (60 * 60 * 1000);

      // Scores basés sur l'engagement (view_count est le seul champ DB direct)
      const views = tweet.view_count || 1; 

      // On pourrait fetcher les likes/retweets ici mais pour un check rapide on va se baser sur views
      const engagementRate = Math.min(views / 100, 1);
      
      // Score de longueur (favorise un contenu substantiel)
      const contentLength = tweet.content ? tweet.content.length : 0;
      const lengthScore = Math.min(contentLength / 100, 1); // Score max à 100 caractères

      // Score temporel (plus de temps = plus de données fiables)
      const timeScore = Math.min(ageInHours / 24, 1); // Score max après 24h

      // Score final pondéré
      const qualityScore = (
        engagementRate * 0.6 +
        lengthScore * 0.2 +
        timeScore * 0.2
      );

      return Math.min(qualityScore, 1);

    } catch (error) {
      logger.error('❌ Erreur calcul qualité contenu:', error);
      return 0.5; // Score neutre en cas d'erreur
    }
  }

  cleanupCache() {
    const now = Date.now();
    let cleaned = 0;

    [this.cache, this.userCache, this.scoreCache, this.analysisCache, this.trendingHashtagsCache, this.shadowbanCache].forEach(cache => {
      for (const [key, entry] of cache.entries()) {
        if (now - entry.timestamp > 30 * 60 * 1000) { // 30 minutes max
          cache.delete(key);
          cleaned++;
        }
      }
    });

    if (cleaned > 0) {
      logger.info(`🧹 Smart cache nettoyé: ${cleaned} entrées supprimées`);
    }
  }

  updateGlobalMetrics() {
    // Mettre à jour les métriques globales de performance
    this.metrics.cacheHitRate = this.metrics.cacheHits / Math.max(this.metrics.totalRequests, 1);
  }

  /**
   * Obtenir les statistiques du moteur
   */
  getEngineStats() {
    return {
      ...this.metrics,
      cacheStats: {
        mainCache: this.cache.size,
        userCache: this.userCache.size,
        scoreCache: this.scoreCache.size,
        analysisCache: this.analysisCache.size
      },
      configuration: {
        scoringSystem: Object.keys(this.scoringSystem),
        dataAnalysis: this.dataAnalysis,
        cacheConfig: this.cacheConfig
      }
    };
  }
}

module.exports = new SmartRecommendationEngine();
