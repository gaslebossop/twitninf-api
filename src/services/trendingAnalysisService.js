/**
 * 📈 Service d'Analyse des Tendances Avancée
 * 
 * Analyse en temps réel des tendances, contenus viraux et momentum
 * pour optimiser les recommandations et la découverte.
 * 
 * @author TwitNin Team
 * @version 1.0.0
 * @license MIT
 */

const { Op, fn, col, literal, Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const { User, Tweet, TweetLike, TweetRetweet, UserFollow, Hashtag } = require('../models');

class TrendingAnalysisService {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = 2 * 60 * 1000; // 2 minutes pour la fraîcheur
    this.trendingCache = new Map();
    
    // Configuration des tendances
    this.trendingConfig = {
      viralThreshold: 0.8,
      trendingThreshold: 0.6,
      momentumThreshold: 0.7,
      decayFactor: 0.95,
      timeWindows: [1, 6, 24, 72], // heures
      minEngagement: 10
    };
    
    // Métriques de tendances
    this.trendingMetrics = {
      totalTrends: 0,
      viralContent: 0,
      trendingTopics: 0,
      lastUpdate: null,
      updateFrequency: 0
    };
    
    // Cache des tendances en cours
    this.activeTrends = new Map();
    this.trendingTopics = new Map();
    this.viralContent = new Map();
    
    this.initialize();
  }

  /**
   * Initialisation du service
   */
  async initialize() {
    try {
      logger.info('📈 Initialisation du service d\'analyse des tendances...');
      
      // Charger les tendances existantes
      await this.loadExistingTrends();
      
      // Démarrer l'analyse en temps réel
      this.startRealTimeAnalysis();
      
      logger.info('✅ Service d\'analyse des tendances initialisé');
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation:', error);
    }
  }

  /**
   * Analyse complète des tendances
   */
  async analyzeTrends(options = {}) {
    try {
      const {
        includeViral = true,
        includeTopics = true,
        includeMomentum = true,
        timeWindow = 24, // heures
        limit = 50,
        forceRefresh = false
      } = options;

      // Vérifier le cache
      const cacheKey = `trends_${timeWindow}_${limit}`;
      if (!forceRefresh && this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheExpiry) {
          return cached.data;
        }
      }

      // Analyses parallèles
      const [viralAnalysis, topicAnalysis, momentumAnalysis] = await Promise.all([
        includeViral ? this.analyzeViralContent(timeWindow, limit) : Promise.resolve([]),
        includeTopics ? this.analyzeTrendingTopics(timeWindow, limit) : Promise.resolve([]),
        includeMomentum ? this.analyzeContentMomentum(timeWindow, limit) : Promise.resolve([])
      ]);

      // Compiler l'analyse complète
      const completeAnalysis = {
        timestamp: new Date(),
        timeWindow,
        viral: viralAnalysis,
        topics: topicAnalysis,
        momentum: momentumAnalysis,
        summary: this.generateTrendingSummary({
          viral: viralAnalysis,
          topics: topicAnalysis,
          momentum: momentumAnalysis
        }),
        metadata: {
          totalTrends: this.trendingMetrics.totalTrends,
          viralCount: viralAnalysis.length,
          topicCount: topicAnalysis.length,
          momentumCount: momentumAnalysis.length
        }
      };

      // Mettre en cache
      this.cache.set(cacheKey, {
        data: completeAnalysis,
        timestamp: Date.now()
      });

      return completeAnalysis;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des tendances:', error);
      throw error;
    }
  }

  /**
   * Analyse des contenus viraux
   */
  async analyzeViralContent(timeWindow = 24, limit = 50) {
    try {
      const cutoffTime = new Date(Date.now() - timeWindow * 60 * 60 * 1000);
      
      // Récupérer les tweets avec engagement élevé
      const viralTweets = await Tweet.findAll({
        where: {
          created_at: { [Op.gte]: cutoffTime },
          moderation_status: 'approved',
          deleted_at: null
        },
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats']
          }
        ],
        order: [
          ['created_at', 'DESC']
        ],
        limit: limit * 2
      });

      // Calculer les scores viraux
      const viralScores = await Promise.all(
        viralTweets.map(async (tweet) => {
          const viralScore = await this.calculateViralScore(tweet, timeWindow);
          return { tweet, viralScore };
        })
      );

      // Filtrer par seuil viral et trier
      const viralContent = viralScores
        .filter(item => item.viralScore >= this.trendingConfig.viralThreshold)
        .sort((a, b) => b.viralScore - a.viralScore)
        .slice(0, limit);

      return viralContent;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des contenus viraux:', error);
      return [];
    }
  }

  /**
   * Analyse des sujets tendance
   */
  async analyzeTrendingTopics(timeWindow = 24, limit = 50) {
    try {
      const cutoffTime = new Date(Date.now() - timeWindow * 60 * 60 * 1000);
      
      // Analyser les hashtags tendance
      const trendingHashtags = await this.analyzeTrendingHashtags(cutoffTime, limit);
      
      // Analyser les mentions tendance
      const trendingMentions = await this.analyzeTrendingMentions(cutoffTime, limit);
      
      // Analyser les mots-clés tendance
      const trendingKeywords = await this.analyzeTrendingKeywords(cutoffTime, limit);
      
      // Analyser les sujets par catégorie
      const trendingCategories = await this.analyzeTrendingCategories(cutoffTime, limit);

      return {
        hashtags: trendingHashtags,
        mentions: trendingMentions,
        keywords: trendingKeywords,
        categories: trendingCategories,
        summary: this.generateTopicSummary({
          hashtags: trendingHashtags,
          mentions: trendingMentions,
          keywords: trendingKeywords,
          categories: trendingCategories
        })
      };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des sujets tendance:', error);
      return {};
    }
  }

  /**
   * Analyse du momentum des contenus
   */
  async analyzeContentMomentum(timeWindow = 24, limit = 50) {
    try {
      const cutoffTime = new Date(Date.now() - timeWindow * 60 * 60 * 1000);
      
      // Analyser la vélocité d'engagement
      const engagementVelocity = await this.analyzeEngagementVelocity(cutoffTime, limit);
      
      // Analyser la croissance virale
      const viralGrowth = await this.analyzeViralGrowth(cutoffTime, limit);
      
      // Analyser les pics d'activité
      const activityPeaks = await this.analyzeActivityPeaks(cutoffTime, limit);
      
      // Analyser les cycles de tendance
      const trendCycles = await this.analyzeTrendCycles(cutoffTime, limit);

      return {
        velocity: engagementVelocity,
        growth: viralGrowth,
        peaks: activityPeaks,
        cycles: trendCycles,
        summary: this.generateMomentumSummary({
          velocity: engagementVelocity,
          growth: viralGrowth,
          peaks: activityPeaks,
          cycles: trendCycles
        })
      };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse du momentum:', error);
      return {};
    }
  }

  /**
   * Calcul du score viral d'un tweet
   */
  async calculateViralScore(tweet, timeWindow) {
    try {
      // Récupérer les statistiques d'engagement
      const [likes, retweets, replies, views] = await Promise.all([
        TweetLike.count({ where: { tweet_id: tweet.id } }),
        TweetRetweet.count({ where: { tweet_id: tweet.id } }),
        Tweet.count({ where: { parent_tweet_id: tweet.id } }),
        Promise.resolve(tweet.view_count || 0)
      ]);

      // Calculer le taux d'engagement
      const totalInteractions = likes + retweets + replies;
      const engagementRate = totalInteractions / Math.max(views, 1);
      
      // Calculer la vélocité d'engagement
      const engagementVelocity = await this.calculateEngagementVelocity(tweet.id, timeWindow);
      
      // Calculer le score viral composite
      const viralScore = (
        engagementRate * 0.4 +
        engagementVelocity * 0.3 +
        Math.log10(totalInteractions + 1) * 0.2 +
        this.calculateRecencyBonus(tweet.created_at, timeWindow) * 0.1
      );

      return Math.min(viralScore, 1);

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score viral:', error);
      return 0;
    }
  }

  /**
   * Calcul de la vélocité d'engagement
   */
  async calculateEngagementVelocity(tweetId, timeWindow) {
    try {
      const timeIntervals = [1, 6, 12, timeWindow]; // heures
      const velocityData = [];

      for (const interval of timeIntervals) {
        const cutoffTime = new Date(Date.now() - interval * 60 * 60 * 1000);
        
        const [likes, retweets, replies] = await Promise.all([
          TweetLike.count({
            where: {
              tweet_id: tweetId,
              created_at: { [Op.gte]: cutoffTime }
            }
          }),
          TweetRetweet.count({
            where: {
              tweet_id: tweetId,
              created_at: { [Op.gte]: cutoffTime }
            }
          }),
          Tweet.count({
            where: {
              parent_tweet_id: tweetId,
              created_at: { [Op.gte]: cutoffTime }
            }
          })
        ]);

        velocityData.push({
          interval,
          total: likes + retweets + replies
        });
      }

      // Calculer la vélocité (taux de changement)
      let velocity = 0;
      for (let i = 1; i < velocityData.length; i++) {
        const current = velocityData[i].total;
        const previous = velocityData[i - 1].total;
        const timeDiff = velocityData[i].interval - velocityData[i - 1].interval;
        
        if (timeDiff > 0) {
          velocity += (current - previous) / timeDiff;
        }
      }

      return Math.max(0, velocity / (velocityData.length - 1));

    } catch (error) {
      logger.error('❌ Erreur lors du calcul de la vélocité d\'engagement:', error);
      return 0;
    }
  }

  /**
   * Calcul du bonus de récence
   */
  calculateRecencyBonus(createdAt, timeWindow) {
    const now = new Date();
    const ageInHours = (now - createdAt) / (1000 * 60 * 60);
    
    // Bonus décroissant avec l'âge
    const recencyBonus = Math.exp(-ageInHours / timeWindow);
    return Math.max(0, Math.min(1, recencyBonus));
  }

  /**
   * Analyse des hashtags tendance
   */
  async analyzeTrendingHashtags(cutoffTime, limit) {
    try {
      // Récupérer TOUS les tweets avec hashtags (sans limite)
      const tweetsWithHashtags = await Tweet.findAll({
        where: {
          created_at: { [Op.gte]: cutoffTime },
          moderation_status: 'approved',
          deleted_at: null,
          hashtags: { [Op.ne]: null }
        },
        attributes: ['id', 'hashtags'],
        include: [
          {
            model: TweetLike,
            as: 'likes',
            attributes: [],
            required: false
          },
          {
            model: TweetRetweet,
            as: 'retweets',
            attributes: [],
            required: false
          }
        ]
        // Suppression de la limite pour récupérer tous les tweets
      });

      logger.info(`📊 Récupération de ${tweetsWithHashtags.length} tweets avec hashtags pour l'analyse...`);

      // Traiter les hashtags manuellement
      const hashtagStats = {};
      
      for (const tweet of tweetsWithHashtags) {
        const hashtags = tweet.hashtags || [];
        const likeCount = tweet.likes ? tweet.likes.length : 0;
        const retweetCount = tweet.retweets ? tweet.retweets.length : 0;
        
        for (const hashtag of hashtags) {
          if (!hashtagStats[hashtag]) {
            hashtagStats[hashtag] = {
              hashtag,
              tweetCount: 0,
              totalLikes: 0,
              totalRetweets: 0
            };
          }
          
          hashtagStats[hashtag].tweetCount++;
          hashtagStats[hashtag].totalLikes += likeCount;
          hashtagStats[hashtag].totalRetweets += retweetCount;
        }
      }

      // Convertir en tableau et calculer les scores
      const processedHashtags = Object.values(hashtagStats)
        .map(stats => ({
          hashtags: [stats.hashtag],
          tweetCount: stats.tweetCount,
          totalLikes: stats.totalLikes,
          totalRetweets: stats.totalRetweets,
          totalEngagement: stats.totalLikes + stats.totalRetweets,
          engagementRate: (stats.totalLikes + stats.totalRetweets) / Math.max(stats.tweetCount, 1)
        }))
        .sort((a, b) => b.totalEngagement - a.totalEngagement)
        .slice(0, limit); // Limite appliquée seulement au résultat final

      logger.info(`✅ Hashtags tendance analysés: ${processedHashtags.length} résultats sur ${Object.keys(hashtagStats).length} hashtags uniques`);
      return processedHashtags;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des hashtags tendance:', error);
      return [];
    }
  }

  /**
   * Analyse des mentions tendance
   */
  async analyzeTrendingMentions(cutoffTime, limit) {
    try {
      // Récupérer TOUTES les mentions avec le plus d'engagement (sans limite)
      const trendingMentions = await Tweet.findAll({
        where: {
          created_at: { [Op.gte]: cutoffTime },
          moderation_status: 'approved',
          deleted_at: null,
          mentions: { [Op.ne]: null }
        },
        attributes: [
          'mentions',
          [fn('COUNT', col('id')), 'tweet_count']
        ],
        group: ['mentions'],
        order: [
          [fn('COUNT', col('id')), 'DESC']
        ]
        // Suppression de la limite pour récupérer toutes les mentions
      });

      logger.info(`📊 Récupération de ${trendingMentions.length} mentions uniques pour l'analyse...`);

      // Traiter les résultats
      const processedMentions = trendingMentions.map(item => {
        const mentions = item.getDataValue('mentions') || [];
        const tweetCount = parseInt(item.getDataValue('tweet_count'));
        
        return {
          mentions,
          tweetCount,
          totalLikes: 0, // Simplifié pour éviter les erreurs SQL
          totalRetweets: 0, // Simplifié pour éviter les erreurs SQL
          totalEngagement: 0,
          engagementRate: 0
        };
      });

      // Appliquer la limite seulement au résultat final
      const limitedMentions = processedMentions.slice(0, limit);
      logger.info(`✅ Mentions tendance analysées: ${limitedMentions.length} résultats sur ${processedMentions.length} mentions uniques`);
      
      return limitedMentions;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des mentions tendance:', error);
      return [];
    }
  }

  /**
   * Analyse des mots-clés tendance
   */
  async analyzeTrendingKeywords(cutoffTime, limit) {
    try {
      // Analyse basique des mots-clés dans le contenu
      // Cette méthode peut être étendue avec NLP
      const trendingKeywords = await Tweet.findAll({
        where: {
          created_at: { [Op.gte]: cutoffTime },
          moderation_status: 'approved',
          deleted_at: null,
          content: { [Op.ne]: null }
        },
        attributes: [
          'content',
          [fn('COUNT', col('id')), 'tweet_count']
        ],
        group: ['content'],
        order: [
          [fn('COUNT', col('id')), 'DESC']
        ]
        // Suppression de la limite pour récupérer tous les mots-clés
      });

      logger.info(`📊 Récupération de ${trendingKeywords.length} mots-clés uniques pour l'analyse...`);

      // Traiter les résultats
      const processedKeywords = trendingKeywords.map(item => {
        const content = item.getDataValue('content');
        const tweetCount = parseInt(item.getDataValue('tweet_count'));
        
        return {
          content: content.substring(0, 100), // Limiter la longueur
          tweetCount,
          totalLikes: 0, // Simplifié pour éviter les erreurs SQL
          totalRetweets: 0, // Simplifié pour éviter les erreurs SQL
          totalEngagement: 0,
          engagementRate: 0
        };
      });

      // Appliquer la limite seulement au résultat final
      const limitedKeywords = processedKeywords.slice(0, limit);
      logger.info(`✅ Mots-clés tendance analysés: ${limitedKeywords.length} résultats sur ${processedKeywords.length} mots-clés uniques`);
      
      return limitedKeywords;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des mots-clés tendance:', error);
      return [];
    }
  }

  /**
   * Analyse des catégories tendance
   */
  async analyzeTrendingCategories(cutoffTime, limit) {
    try {
      // Catégorisation basique basée sur le contenu et les hashtags
      // Cette méthode peut être étendue avec ML/NLP
      const categories = {
        news: ['#actualité', '#news', '#breaking'],
        entertainment: ['#fun', '#humour', '#meme'],
        technology: ['#tech', '#innovation', '#ai'],
        sports: ['#sport', '#football', '#basketball'],
        politics: ['#politique', '#gouvernement', '#élection']
      };

      const categoryAnalysis = {};

      for (const [category, keywords] of Object.entries(categories)) {
        try {
          // Approche simplifiée : compter les tweets avec des hashtags correspondants
          let categoryTweets = 0;
          
          // Récupérer TOUS les tweets avec des hashtags correspondants (sans limite)
          const matchingTweets = await Tweet.findAll({
            where: {
              created_at: { [Op.gte]: cutoffTime },
              moderation_status: 'approved',
              deleted_at: null,
              hashtags: { [Op.ne]: null }
            },
            attributes: ['id', 'hashtags']
            // Suppression de la limite pour récupérer tous les tweets
          });

          logger.info(`📊 Catégorie ${category}: analyse de ${matchingTweets.length} tweets...`);

          // Compter manuellement les tweets correspondants
          for (const tweet of matchingTweets) {
            const hashtags = tweet.hashtags || [];
            const hasMatchingHashtag = hashtags.some(hashtag => 
              keywords.some(keyword => 
                hashtag.toLowerCase().includes(keyword.toLowerCase().replace('#', ''))
              )
            );
            
            if (hasMatchingHashtag) {
              categoryTweets++;
            }
          }

          if (categoryTweets > 0) {
            categoryAnalysis[category] = {
              name: category,
              tweetCount: categoryTweets,
              trendScore: this.calculateCategoryTrendScore(categoryTweets, 24) // timeWindow fixe à 24h
            };
          }
        } catch (categoryError) {
          logger.warn(`⚠️ Erreur lors de l'analyse de la catégorie ${category}:`, categoryError);
          // Continuer avec les autres catégories
        }
      }

      // Trier par score de tendance
      const sortedCategories = Object.values(categoryAnalysis)
        .sort((a, b) => b.trendScore - a.trendScore)
        .slice(0, limit);

      logger.info(`✅ Catégories tendance analysées: ${sortedCategories.length} résultats`);
      return sortedCategories;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des catégories tendance:', error);
      return [];
    }
  }

  /**
   * Calcul du score de tendance d'une catégorie
   */
  calculateCategoryTrendScore(tweetCount, timeWindow = 24) {
    // Score basé sur le volume de tweets et la fenêtre temporelle
    const volumeScore = Math.log10(tweetCount + 1) * 20;
    const timeScore = Math.max(0, 100 - timeWindow * 2); // Bonus pour les fenêtres courtes
    
    return Math.min(volumeScore + timeScore, 100);
  }

  // Méthodes d'analyse du momentum (à implémenter selon les besoins)

  async analyzeEngagementVelocity(cutoffTime, limit) {
    // Implémentation de l'analyse de vélocité d'engagement
    return [];
  }

  async analyzeViralGrowth(cutoffTime, limit) {
    // Implémentation de l'analyse de croissance virale
    return [];
  }

  async analyzeActivityPeaks(cutoffTime, limit) {
    // Implémentation de l'analyse des pics d'activité
    return [];
  }

  async analyzeTrendCycles(cutoffTime, limit) {
    // Implémentation de l'analyse des cycles de tendance
    return [];
  }

  // Méthodes de génération de résumés

  generateTrendingSummary(analysis) {
    return {
      totalTrends: (analysis.viral?.length || 0) + (analysis.topics?.hashtags?.length || 0),
      viralCount: analysis.viral?.length || 0,
      topTrendingTopic: analysis.topics?.hashtags?.[0]?.hashtags?.[0] || 'Aucun',
      momentumLevel: this.calculateMomentumLevel(analysis.momentum),
      overallTrendingScore: this.calculateOverallTrendingScore(analysis)
    };
  }

  generateTopicSummary(topics) {
    return {
      totalTopics: (topics.hashtags?.length || 0) + (topics.mentions?.length || 0) + (topics.keywords?.length || 0),
      topHashtag: topics.hashtags?.[0]?.hashtags?.[0] || 'Aucun',
      topMention: topics.mentions?.[0]?.mentions?.[0] || 'Aucun',
      topKeyword: topics.keywords?.[0]?.content?.substring(0, 20) || 'Aucun'
    };
  }

  generateMomentumSummary(momentum) {
    return {
      velocityLevel: this.calculateVelocityLevel(momentum.velocity),
      growthLevel: this.calculateGrowthLevel(momentum.growth),
      peakActivity: momentum.peaks?.length > 0 ? 'Élevée' : 'Normale',
      trendStrength: this.calculateTrendStrength(momentum)
    };
  }

  // Méthodes de calcul des niveaux

  calculateMomentumLevel(momentum) {
    if (!momentum) return 'Faible';
    
    const velocityScore = this.calculateVelocityScore(momentum.velocity);
    const growthScore = this.calculateGrowthScore(momentum.growth);
    
    const totalScore = (velocityScore + growthScore) / 2;
    
    if (totalScore >= 80) return 'Très élevé';
    if (totalScore >= 60) return 'Élevé';
    if (totalScore >= 40) return 'Moyen';
    if (totalScore >= 20) return 'Faible';
    return 'Très faible';
  }

  calculateVelocityLevel(velocity) {
    if (!velocity || velocity.length === 0) return 'Faible';
    
    const avgVelocity = velocity.reduce((sum, item) => sum + (item.velocity || 0), 0) / velocity.length;
    
    if (avgVelocity >= 0.8) return 'Très élevée';
    if (avgVelocity >= 0.6) return 'Élevée';
    if (avgVelocity >= 0.4) return 'Moyenne';
    if (avgVelocity >= 0.2) return 'Faible';
    return 'Très faible';
  }

  calculateGrowthLevel(growth) {
    if (!growth || growth.length === 0) return 'Faible';
    
    const avgGrowth = growth.reduce((sum, item) => sum + (item.growthRate || 0), 0) / growth.length;
    
    if (avgGrowth >= 0.8) return 'Très élevé';
    if (avgGrowth >= 0.6) return 'Élevé';
    if (avgGrowth >= 0.4) return 'Moyen';
    if (avgGrowth >= 0.2) return 'Faible';
    return 'Très faible';
  }

  calculateTrendStrength(momentum) {
    if (!momentum) return 0;
    
    const velocityScore = this.calculateVelocityScore(momentum.velocity);
    const growthScore = this.calculateGrowthScore(momentum.growth);
    const peakScore = momentum.peaks?.length > 0 ? 80 : 40;
    
    return Math.round((velocityScore + growthScore + peakScore) / 3);
  }

  calculateVelocityScore(velocity) {
    if (!velocity || velocity.length === 0) return 0;
    
    const avgVelocity = velocity.reduce((sum, item) => sum + (item.velocity || 0), 0) / velocity.length;
    return Math.min(avgVelocity * 100, 100);
  }

  calculateGrowthScore(growth) {
    if (!growth || growth.length === 0) return 0;
    
    const avgGrowth = growth.reduce((sum, item) => sum + (item.growthRate || 0), 0) / growth.length;
    return Math.min(avgGrowth * 100, 100);
  }

  calculateOverallTrendingScore(analysis) {
    const viralScore = (analysis.viral?.length || 0) / 50 * 100; // Normalisé sur 50
    const topicScore = (analysis.topics?.hashtags?.length || 0) / 50 * 100;
    const momentumScore = this.calculateTrendStrength(analysis.momentum);
    
    return Math.round((viralScore + topicScore + momentumScore) / 3);
  }

  // Méthodes d'initialisation et de maintenance

  async loadExistingTrends() {
    // Charger les tendances existantes depuis la base de données
    try {
      // Implémentation du chargement des tendances
      logger.info('📈 Tendances existantes chargées');
    } catch (error) {
      logger.error('❌ Erreur lors du chargement des tendances:', error);
    }
  }

  startRealTimeAnalysis() {
    // Démarrer l'analyse en temps réel
    setInterval(async () => {
      try {
        await this.updateTrendingData();
      } catch (error) {
        logger.error('❌ Erreur lors de la mise à jour des tendances:', error);
      }
    }, 2 * 60 * 1000); // Toutes les 2 minutes

    // Nettoyage du cache
    setInterval(() => {
      this.cleanupCache();
    }, 10 * 60 * 1000); // 10 minutes
  }

  async updateTrendingData() {
    try {
      // Mettre à jour les données de tendance
      const trends = await this.analyzeTrends({ timeWindow: 1, limit: 20 });
      
      // Mettre à jour le cache des tendances actives
      this.activeTrends.set('current', trends);
      this.trendingMetrics.lastUpdate = new Date();
      this.trendingMetrics.totalTrends = trends.summary.totalTrends;
      
      logger.info(`📈 Tendances mises à jour: ${trends.summary.totalTrends} tendances actives`);
    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour des tendances:', error);
    }
  }

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
      logger.info(`🧹 Cache des tendances nettoyé: ${cleanedCount} entrées supprimées`);
    }
  }

  /**
   * Obtient les statistiques du service
   */
  getStats() {
    return {
      ...this.trendingMetrics,
      cacheSize: this.cache.size,
      activeTrends: this.activeTrends.size,
      trendingTopics: this.trendingTopics.size,
      viralContent: this.viralContent.size,
      lastUpdate: this.trendingMetrics.lastUpdate
    };
  }

  /**
   * Obtient les tendances actives
   */
  getActiveTrends() {
    return this.activeTrends.get('current') || null;
  }
}

module.exports = new TrendingAnalysisService();
