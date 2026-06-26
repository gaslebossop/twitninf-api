/**
 * 🎯 Service de Tracking Publicitaire Avancé
 * 
 * Collecte des données comportementales détaillées pour optimiser
 * l'efficacité des publicités et améliorer le ciblage
 */

const logger = require('../utils/logger');
const { 
  UserBehaviorData, 
  AdImpression, 
  AdClick, 
  AdEngagement, 
  User, 
  Tweet,
  Advertisement 
} = require('../models');

class AdvancedAdTrackingService {
  constructor() {
    this.trackingCache = new Map();
    this.sessionData = new Map();
    this.performanceMetrics = new Map();
    this.initialized = true;
    logger.info('🎯 Service de tracking publicitaire avancé initialisé');
  }

  /**
   * 📊 Enregistrer une interaction publicitaire détaillée
   */
  async trackAdInteraction(advertisementId, userId, interactionType, detailedContext = {}) {
    try {
      const timestamp = new Date();
      
      // Récupérer les données de l'utilisateur et de la publicité
      const [user, advertisement] = await Promise.all([
        User.findByPk(userId),
        Advertisement.findByPk(advertisementId, {
          include: [{ model: Tweet, as: 'tweet' }]
        })
      ]);

      if (!user || !advertisement) {
        throw new Error('Utilisateur ou publicité non trouvé');
      }

      // Calculer le contexte enrichi
      const enrichedContext = await this.enrichInteractionContext(
        user, 
        advertisement, 
        interactionType, 
        detailedContext
      );

      // Enregistrer dans UserBehaviorData avec des données spécialisées
      await UserBehaviorData.create({
        user_id: userId,
        action_type: `ad_${interactionType}`,
        target_id: advertisementId,
        target_type: 'advertisement',
        context_data: {
          ...enrichedContext,
          ad_category: advertisement.creative_data?.category,
          ad_budget: advertisement.budget,
          ad_campaign_id: advertisement.campaign_id,
          ad_targeting: advertisement.targeting_criteria,
          user_engagement_history: await this.getUserEngagementHistory(userId),
          session_context: await this.getSessionContext(userId),
          device_context: detailedContext.device_info || {},
          temporal_context: this.getTemporalContext(timestamp)
        },
        duration_ms: detailedContext.duration_ms || null,
        location_data: detailedContext.location_data || null,
        device_info: detailedContext.device_info || {},
        interaction_quality: await this.calculateInteractionQuality(
          interactionType, 
          enrichedContext
        ),
        timestamp: timestamp
      });

      // Mettre à jour les métriques de performance en temps réel
      await this.updatePerformanceMetrics(advertisementId, userId, interactionType, enrichedContext);

      // Enregistrer dans les tables spécialisées
      await this.recordSpecializedAdData(advertisementId, userId, interactionType, enrichedContext);

      logger.info(`📊 Interaction publicitaire trackée: ${interactionType} pour l'annonce ${advertisementId}`);
      
      return {
        success: true,
        interactionId: `ad_${advertisementId}_${userId}_${timestamp.getTime()}`,
        enrichedContext,
        qualityScore: enrichedContext.interaction_quality
      };

    } catch (error) {
      logger.error('❌ Erreur lors du tracking publicitaire:', error);
      throw error;
    }
  }

  /**
   * 🧠 Enrichir le contexte d'interaction avec des données prédictives
   */
  async enrichInteractionContext(user, advertisement, interactionType, context) {
    const enrichedContext = {
      ...context,
      
      // Données utilisateur enrichies
      user_profile: {
        account_age_days: Math.floor((new Date() - user.created_at) / (1000 * 60 * 60 * 24)),
        followers_count: user.stats?.followers || 0,
        following_count: user.stats?.following || 0,
        tweets_count: user.stats?.tweets || 0,
        verified: user.verified,
        premium: user.premium,
        activity_level: await this.calculateUserActivityLevel(user.id),
        engagement_rate: await this.calculateUserEngagementRate(user.id),
        content_preferences: await this.analyzeUserContentPreferences(user.id),
        optimal_posting_times: await this.analyzeOptimalPostingTimes(user.id)
      },

      // Données publicitaires enrichies
      ad_analysis: {
        content_sentiment: await this.analyzeContentSentiment(advertisement.tweet?.content),
        hashtag_relevance: await this.analyzeHashtagRelevance(advertisement.tweet?.hashtags, user.id),
        media_engagement_potential: await this.analyzeMediaEngagement(advertisement.tweet?.media_urls),
        competitive_landscape: await this.analyzeCompetitiveLandscape(advertisement),
        optimal_timing: await this.analyzeOptimalTiming(advertisement, user.id)
      },

      // Contexte comportemental
      behavioral_context: {
        scroll_velocity: context.scroll_velocity || null,
        time_on_screen: context.time_on_screen || null,
        interaction_sequence: await this.getRecentInteractionSequence(user.id),
        attention_patterns: await this.analyzeAttentionPatterns(user.id),
        engagement_triggers: await this.identifyEngagementTriggers(user.id)
      },

      // Contexte environnemental
      environmental_context: {
        current_trends: await this.getCurrentTrends(),
        user_mood_indicators: await this.analyzeUserMoodIndicators(user.id),
        social_context: await this.analyzeSocialContext(user.id),
        competitive_context: await this.analyzeCompetitiveContext(advertisement, user.id)
      }
    };

    return enrichedContext;
  }

  /**
   * 📈 Calculer la qualité d'interaction publicitaire
   */
  async calculateInteractionQuality(interactionType, context) {
    let qualityScore = 0.5; // Score de base

    // Facteurs de qualité basés sur le type d'interaction
    const interactionWeights = {
      'view': 0.1,
      'impression': 0.2,
      'click': 0.6,
      'like': 0.7,
      'retweet': 0.9,
      'reply': 0.8,
      'share': 0.85,
      'bookmark': 0.75,
      'profile_visit': 0.65,
      'follow': 0.95
    };

    qualityScore = interactionWeights[interactionType] || 0.5;

    // Ajustements basés sur le contexte
    if (context.time_on_screen > 3000) qualityScore += 0.1; // +3 secondes
    if (context.scroll_velocity < 0.5) qualityScore += 0.05; // Scroll lent
    if (context.user_profile.engagement_rate > 0.1) qualityScore += 0.1; // Utilisateur engagé
    if (context.ad_analysis.content_sentiment > 0.7) qualityScore += 0.05; // Contenu positif

    return Math.min(1.0, Math.max(0.0, qualityScore));
  }

  /**
   * 📊 Mettre à jour les métriques de performance en temps réel
   */
  async updatePerformanceMetrics(advertisementId, userId, interactionType, context) {
    const key = `ad_${advertisementId}`;
    
    if (!this.performanceMetrics.has(key)) {
      this.performanceMetrics.set(key, {
        total_interactions: 0,
        interaction_types: {},
        user_segments: {},
        time_distribution: {},
        quality_scores: [],
        conversion_funnel: {
          impressions: 0,
          clicks: 0,
          engagements: 0,
          conversions: 0
        }
      });
    }

    const metrics = this.performanceMetrics.get(key);
    
    // Mettre à jour les compteurs
    metrics.total_interactions++;
    metrics.interaction_types[interactionType] = (metrics.interaction_types[interactionType] || 0) + 1;
    
    // Segmenter par type d'utilisateur
    const userSegment = this.categorizeUser(context.user_profile);
    metrics.user_segments[userSegment] = (metrics.user_segments[userSegment] || 0) + 1;
    
    // Distribution temporelle
    const hour = new Date().getHours();
    metrics.time_distribution[hour] = (metrics.time_distribution[hour] || 0) + 1;
    
    // Scores de qualité
    metrics.quality_scores.push(context.interaction_quality);
    
    // Entonnoir de conversion
    if (interactionType === 'impression') metrics.conversion_funnel.impressions++;
    if (interactionType === 'click') metrics.conversion_funnel.clicks++;
    if (['like', 'retweet', 'reply', 'share'].includes(interactionType)) {
      metrics.conversion_funnel.engagements++;
    }

    this.performanceMetrics.set(key, metrics);
  }

  /**
   * 🎯 Analyser les préférences de contenu de l'utilisateur
   */
  async analyzeUserContentPreferences(userId) {
    try {
      const recentTweets = await Tweet.findAll({
        where: { user_id: userId },
        limit: 100,
        order: [['created_at', 'DESC']]
      });

      const preferences = {
        hashtag_preferences: {},
        content_length_preference: 'mixed',
        media_preference: 'mixed',
        sentiment_preference: 'neutral',
        topic_preferences: {},
        engagement_patterns: {}
      };

      // Analyser les hashtags
      recentTweets.forEach(tweet => {
        if (tweet.hashtags) {
          tweet.hashtags.forEach(tag => {
            preferences.hashtag_preferences[tag] = (preferences.hashtag_preferences[tag] || 0) + 1;
          });
        }
      });

      // Analyser la longueur du contenu
      const avgLength = recentTweets.reduce((sum, tweet) => sum + (tweet.content?.length || 0), 0) / recentTweets.length;
      if (avgLength < 50) preferences.content_length_preference = 'short';
      else if (avgLength > 200) preferences.content_length_preference = 'long';

      return preferences;
    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des préférences:', error);
      return {};
    }
  }

  /**
   * ⏰ Analyser les heures optimales de publication
   */
  async analyzeOptimalPostingTimes(userId) {
    try {
      const userInteractions = await UserBehaviorData.findAll({
        where: { user_id: userId },
        attributes: ['timestamp', 'action_type'],
        limit: 1000,
        order: [['timestamp', 'DESC']]
      });

      const hourlyActivity = {};
      userInteractions.forEach(interaction => {
        const hour = new Date(interaction.timestamp).getHours();
        hourlyActivity[hour] = (hourlyActivity[hour] || 0) + 1;
      });

      // Trouver les heures de pic d'activité
      const sortedHours = Object.entries(hourlyActivity)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3)
        .map(([hour]) => parseInt(hour));

      return {
        peak_hours: sortedHours,
        activity_distribution: hourlyActivity,
        optimal_posting_window: this.calculateOptimalWindow(hourlyActivity)
      };
    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des heures optimales:', error);
      return { peak_hours: [9, 14, 20], activity_distribution: {}, optimal_posting_window: '9-11' };
    }
  }

  /**
   * 🧠 Analyser le sentiment du contenu
   */
  async analyzeContentSentiment(content) {
    if (!content) return 0.5;

    // Analyse simple basée sur les mots-clés
    const positiveWords = ['génial', 'super', 'excellent', 'parfait', 'merci', 'bravo', 'félicitations'];
    const negativeWords = ['nul', 'terrible', 'horrible', 'déçu', 'problème', 'erreur', 'bug'];

    const words = content.toLowerCase().split(/\s+/);
    let positiveCount = 0;
    let negativeCount = 0;

    words.forEach(word => {
      if (positiveWords.some(pw => word.includes(pw))) positiveCount++;
      if (negativeWords.some(nw => word.includes(nw))) negativeCount++;
    });

    const total = positiveCount + negativeCount;
    if (total === 0) return 0.5;

    return positiveCount / total;
  }

  /**
   * 📱 Obtenir le contexte de session
   */
  async getSessionContext(userId) {
    const sessionKey = `session_${userId}`;
    
    if (!this.sessionData.has(sessionKey)) {
      this.sessionData.set(sessionKey, {
        session_start: new Date(),
        interactions_count: 0,
        pages_visited: [],
        time_spent: 0,
        engagement_score: 0
      });
    }

    return this.sessionData.get(sessionKey);
  }

  /**
   * 🎯 Catégoriser l'utilisateur pour le ciblage
   */
  categorizeUser(userProfile) {
    if (userProfile.verified && userProfile.followers_count > 10000) return 'influencer';
    if (userProfile.followers_count > 1000) return 'active_user';
    if (userProfile.activity_level > 0.7) return 'highly_active';
    if (userProfile.activity_level > 0.4) return 'moderately_active';
    return 'casual_user';
  }

  /**
   * 📊 Obtenir les métriques de performance d'une publicité
   */
  getAdvertisementPerformanceMetrics(advertisementId) {
    const key = `ad_${advertisementId}`;
    const metrics = this.performanceMetrics.get(key);
    
    if (!metrics) {
      return {
        total_interactions: 0,
        conversion_rate: 0,
        engagement_rate: 0,
        quality_score: 0,
        user_segments: {},
        recommendations: []
      };
    }

    const conversionRate = metrics.conversion_funnel.clicks / Math.max(metrics.conversion_funnel.impressions, 1);
    const engagementRate = metrics.conversion_funnel.engagements / Math.max(metrics.conversion_funnel.impressions, 1);
    const avgQualityScore = metrics.quality_scores.reduce((sum, score) => sum + score, 0) / metrics.quality_scores.length;

    return {
      total_interactions: metrics.total_interactions,
      conversion_rate: conversionRate,
      engagement_rate: engagementRate,
      quality_score: avgQualityScore || 0,
      user_segments: metrics.user_segments,
      time_distribution: metrics.time_distribution,
      recommendations: this.generateRecommendations(metrics)
    };
  }

  /**
   * 💡 Générer des recommandations d'optimisation
   */
  generateRecommendations(metrics) {
    const recommendations = [];

    // Recommandations basées sur les segments d'utilisateurs
    const topSegment = Object.entries(metrics.user_segments)
      .sort(([,a], [,b]) => b - a)[0];
    
    if (topSegment) {
      recommendations.push({
        type: 'targeting',
        message: `Cibler davantage les utilisateurs de type "${topSegment[0]}"`,
        impact: 'high'
      });
    }

    // Recommandations basées sur la distribution temporelle
    const peakHour = Object.entries(metrics.time_distribution)
      .sort(([,a], [,b]) => b - a)[0];
    
    if (peakHour) {
      recommendations.push({
        type: 'timing',
        message: `Publier davantage à ${peakHour[0]}h pour maximiser l'engagement`,
        impact: 'medium'
      });
    }

    // Recommandations basées sur la qualité
    const avgQuality = metrics.quality_scores.reduce((sum, score) => sum + score, 0) / metrics.quality_scores.length;
    if (avgQuality < 0.6) {
      recommendations.push({
        type: 'content',
        message: 'Améliorer la qualité du contenu pour augmenter l\'engagement',
        impact: 'high'
      });
    }

    return recommendations;
  }

  /**
   * 🔄 Nettoyer les données de session expirées
   */
  cleanupExpiredSessions() {
    const now = new Date();
    const maxAge = 30 * 60 * 1000; // 30 minutes

    for (const [key, sessionData] of this.sessionData.entries()) {
      if (now - sessionData.session_start > maxAge) {
        this.sessionData.delete(key);
      }
    }
  }

  /**
   * 📊 Exporter les données de performance pour analyse
   */
  async exportPerformanceData(advertisementId, dateRange = {}) {
    try {
      const startDate = dateRange.start || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const endDate = dateRange.end || new Date();

      const interactions = await UserBehaviorData.findAll({
        where: {
          target_id: advertisementId,
          target_type: 'advertisement',
          timestamp: {
            [require('sequelize').Op.between]: [startDate, endDate]
          }
        },
        include: [{ model: User, as: 'user', attributes: ['id', 'username', 'stats'] }]
      });

      return {
        advertisement_id: advertisementId,
        date_range: { start: startDate, end: endDate },
        total_interactions: interactions.length,
        interactions_by_type: this.groupBy(interactions, 'action_type'),
        user_segments: this.analyzeUserSegments(interactions),
        performance_metrics: this.getAdvertisementPerformanceMetrics(advertisementId),
        raw_data: interactions.map(interaction => ({
          user_id: interaction.user_id,
          action_type: interaction.action_type,
          timestamp: interaction.timestamp,
          context_data: interaction.context_data,
          interaction_quality: interaction.interaction_quality
        }))
      };
    } catch (error) {
      logger.error('❌ Erreur lors de l\'export des données:', error);
      throw error;
    }
  }

  // Méthodes utilitaires
  groupBy(array, key) {
    return array.reduce((groups, item) => {
      const group = item[key];
      groups[group] = groups[group] || [];
      groups[group].push(item);
      return groups;
    }, {});
  }

  analyzeUserSegments(interactions) {
    const segments = {};
    interactions.forEach(interaction => {
      const userProfile = interaction.context_data?.user_profile;
      if (userProfile) {
        const segment = this.categorizeUser(userProfile);
        segments[segment] = (segments[segment] || 0) + 1;
      }
    });
    return segments;
  }

  calculateOptimalWindow(hourlyActivity) {
    const sortedHours = Object.entries(hourlyActivity)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 2)
      .map(([hour]) => parseInt(hour));
    
    if (sortedHours.length === 2) {
      return `${Math.min(...sortedHours)}-${Math.max(...sortedHours)}`;
    }
    return `${sortedHours[0]}-${sortedHours[0] + 2}`;
  }
}

module.exports = new AdvancedAdTrackingService();
