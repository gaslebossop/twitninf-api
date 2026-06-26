/**
 * 🧠 Service de Ciblage Prédictif basé sur IA
 * 
 * Utilise l'intelligence artificielle pour optimiser le ciblage
 * des publicités et prédire les performances
 */

const logger = require('../utils/logger');
const { 
  User, 
  Tweet, 
  UserBehaviorData, 
  UserPreferences,
  Advertisement,
  AdImpression,
  AdClick,
  AdEngagement 
} = require('../models');

class PredictiveTargetingService {
  constructor() {
    this.userProfiles = new Map();
    this.predictionModels = new Map();
    this.targetingCache = new Map();
    this.initialized = true;
    
    // Initialiser les modèles prédictifs
    this.initializePredictionModels();
    
    logger.info('🧠 Service de ciblage prédictif initialisé');
  }

  /**
   * 🧠 Initialiser les modèles prédictifs
   */
  initializePredictionModels() {
    // Modèle de prédiction d'engagement
    this.predictionModels.set('engagement', {
      features: [
        'user_activity_level',
        'content_preferences',
        'optimal_timing',
        'social_influence',
        'device_usage_patterns'
      ],
      weights: {
        user_activity_level: 0.25,
        content_preferences: 0.3,
        optimal_timing: 0.2,
        social_influence: 0.15,
        device_usage_patterns: 0.1
      }
    });

    // Modèle de prédiction de conversion
    this.predictionModels.set('conversion', {
      features: [
        'purchase_intent',
        'brand_affinity',
        'price_sensitivity',
        'decision_making_speed',
        'social_proof_susceptibility'
      ],
      weights: {
        purchase_intent: 0.3,
        brand_affinity: 0.25,
        price_sensitivity: 0.2,
        decision_making_speed: 0.15,
        social_proof_susceptibility: 0.1
      }
    });

    // Modèle de prédiction de satisfaction
    this.predictionModels.set('satisfaction', {
      features: [
        'content_relevance',
        'ad_fatigue_level',
        'personalization_quality',
        'timing_appropriateness',
        'creative_appeal'
      ],
      weights: {
        content_relevance: 0.3,
        ad_fatigue_level: 0.25,
        personalization_quality: 0.2,
        timing_appropriateness: 0.15,
        creative_appeal: 0.1
      }
    });
  }

  /**
   * 🎯 Prédire la performance d'une publicité pour un utilisateur
   */
  async predictAdPerformance(advertisementId, userId) {
    try {
      const [advertisement, user] = await Promise.all([
        Advertisement.findByPk(advertisementId, {
          include: [{ model: Tweet, as: 'tweet' }]
        }),
        User.findByPk(userId)
      ]);

      if (!advertisement || !user) {
        throw new Error('Publicité ou utilisateur non trouvé');
      }

      // Construire le profil utilisateur enrichi
      const userProfile = await this.buildEnrichedUserProfile(userId);
      
      // Analyser la publicité
      const adAnalysis = await this.analyzeAdvertisement(advertisement);
      
      // Calculer les prédictions
      const predictions = await this.calculatePredictions(userProfile, adAnalysis, advertisement);

      // Générer des recommandations de ciblage
      const targetingRecommendations = await this.generateTargetingRecommendations(
        userProfile, 
        adAnalysis, 
        predictions
      );

      const result = {
        user_id: userId,
        advertisement_id: advertisementId,
        predictions: predictions,
        targeting_recommendations: targetingRecommendations,
        confidence_score: this.calculateConfidenceScore(predictions),
        calculated_at: new Date()
      };

      // Mettre en cache le résultat
      this.targetingCache.set(`prediction_${advertisementId}_${userId}`, {
        data: result,
        timestamp: new Date()
      });

      logger.info(`🧠 Prédiction calculée pour l'utilisateur ${userId} et la publicité ${advertisementId}`);
      
      return result;

    } catch (error) {
      logger.error('❌ Erreur lors de la prédiction:', error);
      throw error;
    }
  }

  /**
   * 👤 Construire un profil utilisateur enrichi
   */
  async buildEnrichedUserProfile(userId) {
    try {
      // Récupérer les données comportementales récentes
      const behaviorData = await UserBehaviorData.findAll({
        where: { user_id: userId },
        limit: 1000,
        order: [['timestamp', 'DESC']]
      });

      // Récupérer les préférences utilisateur
      const preferences = await UserPreferences.findOne({
        where: { user_id: userId }
      });

      // Analyser les patterns comportementaux
      const behavioralPatterns = this.analyzeBehavioralPatterns(behaviorData);
      
      // Analyser les préférences de contenu
      const contentPreferences = this.analyzeContentPreferences(behaviorData);
      
      // Analyser les patterns temporels
      const temporalPatterns = this.analyzeTemporalPatterns(behaviorData);
      
      // Analyser l'influence sociale
      const socialInfluence = await this.analyzeSocialInfluence(userId);
      
      // Analyser les patterns d'appareil
      const devicePatterns = this.analyzeDevicePatterns(behaviorData);

      return {
        user_id: userId,
        behavioral_patterns: behavioralPatterns,
        content_preferences: contentPreferences,
        temporal_patterns: temporalPatterns,
        social_influence: socialInfluence,
        device_patterns: devicePatterns,
        preferences: preferences?.toJSON() || {},
        activity_level: this.calculateActivityLevel(behaviorData),
        engagement_tendency: this.calculateEngagementTendency(behaviorData),
        ad_susceptibility: this.calculateAdSusceptibility(behaviorData)
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la construction du profil:', error);
      return {};
    }
  }

  /**
   * 📊 Analyser une publicité
   */
  async analyzeAdvertisement(advertisement) {
    try {
      const tweet = advertisement.tweet;
      
      // Analyser le contenu
      const contentAnalysis = this.analyzeContent(tweet?.content || '');
      
      // Analyser les hashtags
      const hashtagAnalysis = this.analyzeHashtags(tweet?.hashtags || []);
      
      // Analyser les médias
      const mediaAnalysis = this.analyzeMedia(tweet?.media_urls || []);
      
      // Analyser le ciblage actuel
      const targetingAnalysis = this.analyzeCurrentTargeting(advertisement.targeting_criteria);
      
      // Analyser la concurrence
      const competitiveAnalysis = await this.analyzeCompetition(advertisement);

      return {
        content_analysis: contentAnalysis,
        hashtag_analysis: hashtagAnalysis,
        media_analysis: mediaAnalysis,
        targeting_analysis: targetingAnalysis,
        competitive_analysis: competitiveAnalysis,
        budget_analysis: {
          budget: advertisement.budget,
          cost_per_impression: advertisement.cost_per_impression,
          cost_per_click: advertisement.cost_per_click,
          budget_efficiency: this.calculateBudgetEfficiency(advertisement)
        }
      };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse de la publicité:', error);
      return {};
    }
  }

  /**
   * 🔮 Calculer les prédictions
   */
  async calculatePredictions(userProfile, adAnalysis, advertisement) {
    try {
      // Prédiction d'engagement
      const engagementPrediction = this.predictEngagement(userProfile, adAnalysis);
      
      // Prédiction de conversion
      const conversionPrediction = this.predictConversion(userProfile, adAnalysis);
      
      // Prédiction de satisfaction
      const satisfactionPrediction = this.predictSatisfaction(userProfile, adAnalysis);
      
      // Prédiction de coût
      const costPrediction = this.predictCost(userProfile, adAnalysis, advertisement);
      
      // Prédiction de timing optimal
      const timingPrediction = this.predictOptimalTiming(userProfile, adAnalysis);

      return {
        engagement: engagementPrediction,
        conversion: conversionPrediction,
        satisfaction: satisfactionPrediction,
        cost: costPrediction,
        timing: timingPrediction,
        overall_score: this.calculateOverallPredictionScore({
          engagement: engagementPrediction,
          conversion: conversionPrediction,
          satisfaction: satisfactionPrediction
        })
      };

    } catch (error) {
      logger.error('❌ Erreur lors du calcul des prédictions:', error);
      return {};
    }
  }

  /**
   * 🎯 Prédire l'engagement
   */
  predictEngagement(userProfile, adAnalysis) {
    const model = this.predictionModels.get('engagement');
    let score = 0;

    // Score basé sur l'activité utilisateur
    const activityScore = userProfile.activity_level || 0.5;
    score += activityScore * model.weights.user_activity_level;

    // Score basé sur les préférences de contenu
    const contentScore = this.calculateContentRelevanceScore(userProfile.content_preferences, adAnalysis.content_analysis);
    score += contentScore * model.weights.content_preferences;

    // Score basé sur le timing optimal
    const timingScore = this.calculateTimingScore(userProfile.temporal_patterns, adAnalysis);
    score += timingScore * model.weights.optimal_timing;

    // Score basé sur l'influence sociale
    const socialScore = userProfile.social_influence?.influence_score || 0.5;
    score += socialScore * model.weights.social_influence;

    // Score basé sur les patterns d'appareil
    const deviceScore = this.calculateDeviceScore(userProfile.device_patterns, adAnalysis);
    score += deviceScore * model.weights.device_usage_patterns;

    return {
      score: Math.min(1.0, Math.max(0.0, score)),
      confidence: this.calculatePredictionConfidence(userProfile, 'engagement'),
      factors: {
        activity_level: activityScore,
        content_relevance: contentScore,
        timing_optimization: timingScore,
        social_influence: socialScore,
        device_compatibility: deviceScore
      }
    };
  }

  /**
   * 💰 Prédire la conversion
   */
  predictConversion(userProfile, adAnalysis) {
    const model = this.predictionModels.get('conversion');
    let score = 0;

    // Score basé sur l'intention d'achat
    const purchaseIntent = this.calculatePurchaseIntent(userProfile);
    score += purchaseIntent * model.weights.purchase_intent;

    // Score basé sur l'affinité de marque
    const brandAffinity = this.calculateBrandAffinity(userProfile, adAnalysis);
    score += brandAffinity * model.weights.brand_affinity;

    // Score basé sur la sensibilité au prix
    const priceSensitivity = this.calculatePriceSensitivity(userProfile);
    score += (1 - priceSensitivity) * model.weights.price_sensitivity; // Inverser car moins sensible = mieux

    // Score basé sur la vitesse de décision
    const decisionSpeed = this.calculateDecisionSpeed(userProfile);
    score += decisionSpeed * model.weights.decision_making_speed;

    // Score basé sur la susceptibilité à la preuve sociale
    const socialProof = this.calculateSocialProofSusceptibility(userProfile);
    score += socialProof * model.weights.social_proof_susceptibility;

    return {
      score: Math.min(1.0, Math.max(0.0, score)),
      confidence: this.calculatePredictionConfidence(userProfile, 'conversion'),
      factors: {
        purchase_intent: purchaseIntent,
        brand_affinity: brandAffinity,
        price_sensitivity: priceSensitivity,
        decision_speed: decisionSpeed,
        social_proof_susceptibility: socialProof
      }
    };
  }

  /**
   * 😊 Prédire la satisfaction
   */
  predictSatisfaction(userProfile, adAnalysis) {
    const model = this.predictionModels.get('satisfaction');
    let score = 0;

    // Score basé sur la pertinence du contenu
    const relevanceScore = this.calculateContentRelevanceScore(userProfile.content_preferences, adAnalysis.content_analysis);
    score += relevanceScore * model.weights.content_relevance;

    // Score basé sur la fatigue publicitaire
    const adFatigue = this.calculateAdFatigue(userProfile);
    score += (1 - adFatigue) * model.weights.ad_fatigue_level; // Inverser car moins de fatigue = mieux

    // Score basé sur la qualité de personnalisation
    const personalizationScore = this.calculatePersonalizationQuality(userProfile, adAnalysis);
    score += personalizationScore * model.weights.personalization_quality;

    // Score basé sur l'appropriateness du timing
    const timingAppropriateness = this.calculateTimingAppropriateness(userProfile, adAnalysis);
    score += timingAppropriateness * model.weights.timing_appropriateness;

    // Score basé sur l'attrait créatif
    const creativeAppeal = this.calculateCreativeAppeal(adAnalysis);
    score += creativeAppeal * model.weights.creative_appeal;

    return {
      score: Math.min(1.0, Math.max(0.0, score)),
      confidence: this.calculatePredictionConfidence(userProfile, 'satisfaction'),
      factors: {
        content_relevance: relevanceScore,
        ad_fatigue: adFatigue,
        personalization_quality: personalizationScore,
        timing_appropriateness: timingAppropriateness,
        creative_appeal: creativeAppeal
      }
    };
  }

  /**
   * 💰 Prédire le coût
   */
  predictCost(userProfile, adAnalysis, advertisement) {
    const baseCost = advertisement.cost_per_impression || 0.1;
    
    // Ajustements basés sur le profil utilisateur
    let costMultiplier = 1.0;
    
    // Utilisateurs très actifs = coût plus élevé
    if (userProfile.activity_level > 0.8) {
      costMultiplier += 0.2;
    }
    
    // Utilisateurs avec forte influence sociale = coût plus élevé
    if (userProfile.social_influence?.influence_score > 0.7) {
      costMultiplier += 0.3;
    }
    
    // Utilisateurs avec faible fatigue publicitaire = coût plus élevé
    const adFatigue = this.calculateAdFatigue(userProfile);
    if (adFatigue < 0.3) {
      costMultiplier += 0.1;
    }

    return {
      predicted_cost_per_impression: baseCost * costMultiplier,
      predicted_cost_per_click: (advertisement.cost_per_click || 0.1) * costMultiplier,
      cost_efficiency_score: 1 / costMultiplier,
      factors: {
        user_activity_level: userProfile.activity_level,
        social_influence: userProfile.social_influence?.influence_score,
        ad_fatigue: adFatigue
      }
    };
  }

  /**
   * ⏰ Prédire le timing optimal
   */
  predictOptimalTiming(userProfile, adAnalysis) {
    const temporalPatterns = userProfile.temporal_patterns || {};
    
    // Analyser les heures de pic d'activité
    const peakHours = temporalPatterns.peak_hours || [9, 14, 20];
    
    // Analyser les jours de la semaine optimaux
    const optimalDays = temporalPatterns.optimal_days || [1, 2, 3, 4, 5]; // Lun-Ven
    
    // Calculer le score de timing
    const currentHour = new Date().getHours();
    const currentDay = new Date().getDay();
    
    const hourScore = peakHours.includes(currentHour) ? 1.0 : 0.3;
    const dayScore = optimalDays.includes(currentDay) ? 1.0 : 0.5;
    
    const timingScore = (hourScore + dayScore) / 2;

    return {
      optimal_hours: peakHours,
      optimal_days: optimalDays,
      current_timing_score: timingScore,
      next_optimal_time: this.calculateNextOptimalTime(peakHours, optimalDays),
      confidence: 0.8
    };
  }

  /**
   * 💡 Générer des recommandations de ciblage
   */
  async generateTargetingRecommendations(userProfile, adAnalysis, predictions) {
    const recommendations = [];

    // Recommandations basées sur l'engagement
    if (predictions.engagement.score < 0.6) {
      recommendations.push({
        type: 'engagement_optimization',
        priority: 'high',
        title: 'Optimiser l\'engagement',
        description: 'Le score d\'engagement prédit est faible',
        suggestions: [
          'Ajuster le contenu pour correspondre aux préférences de l\'utilisateur',
          'Optimiser le timing de diffusion',
          'Améliorer l\'attrait créatif'
        ],
        expected_improvement: '20-30%'
      });
    }

    // Recommandations basées sur la conversion
    if (predictions.conversion.score < 0.5) {
      recommendations.push({
        type: 'conversion_optimization',
        priority: 'high',
        title: 'Optimiser la conversion',
        description: 'Le score de conversion prédit est faible',
        suggestions: [
          'Améliorer l\'intention d\'achat avec des appels à l\'action plus forts',
          'Réduire la sensibilité au prix avec des offres spéciales',
          'Utiliser la preuve sociale pour influencer la décision'
        ],
        expected_improvement: '15-25%'
      });
    }

    // Recommandations basées sur la satisfaction
    if (predictions.satisfaction.score < 0.7) {
      recommendations.push({
        type: 'satisfaction_optimization',
        priority: 'medium',
        title: 'Optimiser la satisfaction',
        description: 'Le score de satisfaction prédit peut être amélioré',
        suggestions: [
          'Réduire la fatigue publicitaire avec des publicités moins fréquentes',
          'Améliorer la personnalisation du contenu',
          'Optimiser le timing pour éviter les moments inappropriés'
        ],
        expected_improvement: '10-20%'
      });
    }

    // Recommandations basées sur le coût
    if (predictions.cost.cost_efficiency_score < 0.7) {
      recommendations.push({
        type: 'cost_optimization',
        priority: 'medium',
        title: 'Optimiser les coûts',
        description: 'Le coût prédit peut être optimisé',
        suggestions: [
          'Cibler des utilisateurs avec un coût d\'acquisition plus faible',
          'Optimiser les enchères pour réduire le coût par impression',
          'Améliorer la pertinence pour réduire les coûts'
        ],
        expected_improvement: '15-30%'
      });
    }

    return recommendations;
  }

  // Méthodes utilitaires pour l'analyse
  analyzeBehavioralPatterns(behaviorData) {
    const patterns = {
      interaction_frequency: 0,
      preferred_actions: {},
      session_duration: 0,
      engagement_depth: 0
    };

    if (behaviorData.length === 0) return patterns;

    // Analyser la fréquence d'interaction
    const timeSpan = behaviorData[0].timestamp - behaviorData[behaviorData.length - 1].timestamp;
    patterns.interaction_frequency = behaviorData.length / (timeSpan / (1000 * 60 * 60 * 24)); // Interactions par jour

    // Analyser les actions préférées
    behaviorData.forEach(data => {
      const action = data.action_type.replace('ad_', '');
      patterns.preferred_actions[action] = (patterns.preferred_actions[action] || 0) + 1;
    });

    return patterns;
  }

  analyzeContentPreferences(behaviorData) {
    const preferences = {
      hashtag_preferences: {},
      content_length_preference: 'mixed',
      media_preference: 'mixed',
      sentiment_preference: 'neutral'
    };

    // Analyser les préférences de hashtags
    behaviorData.forEach(data => {
      if (data.context_data?.hashtags) {
        data.context_data.hashtags.forEach(tag => {
          preferences.hashtag_preferences[tag] = (preferences.hashtag_preferences[tag] || 0) + 1;
        });
      }
    });

    return preferences;
  }

  analyzeTemporalPatterns(behaviorData) {
    const patterns = {
      peak_hours: [],
      optimal_days: [],
      activity_distribution: {}
    };

    // Analyser la distribution temporelle
    behaviorData.forEach(data => {
      const hour = new Date(data.timestamp).getHours();
      const day = new Date(data.timestamp).getDay();
      
      patterns.activity_distribution[hour] = (patterns.activity_distribution[hour] || 0) + 1;
    });

    // Trouver les heures de pic
    const sortedHours = Object.entries(patterns.activity_distribution)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([hour]) => parseInt(hour));
    
    patterns.peak_hours = sortedHours;

    return patterns;
  }

  async analyzeSocialInfluence(userId) {
    try {
      const user = await User.findByPk(userId);
      if (!user) return { influence_score: 0.5 };

      const followers = user.stats?.followers || 0;
      const following = user.stats?.following || 0;
      
      // Calculer le score d'influence basé sur le ratio followers/following
      const influenceScore = Math.min(1.0, followers / Math.max(following, 1));

      return {
        influence_score: influenceScore,
        followers_count: followers,
        following_count: following,
        influence_level: this.categorizeInfluenceLevel(influenceScore)
      };
    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse de l\'influence sociale:', error);
      return { influence_score: 0.5 };
    }
  }

  analyzeDevicePatterns(behaviorData) {
    const patterns = {
      device_types: {},
      os_distribution: {},
      screen_sizes: {}
    };

    behaviorData.forEach(data => {
      if (data.device_info) {
        const deviceType = data.device_info.device_type || 'unknown';
        const os = data.device_info.os || 'unknown';
        const screenSize = data.device_info.screen_size || 'unknown';
        
        patterns.device_types[deviceType] = (patterns.device_types[deviceType] || 0) + 1;
        patterns.os_distribution[os] = (patterns.os_distribution[os] || 0) + 1;
        patterns.screen_sizes[screenSize] = (patterns.screen_sizes[screenSize] || 0) + 1;
      }
    });

    return patterns;
  }

  // Méthodes de calcul de scores
  calculateActivityLevel(behaviorData) {
    if (behaviorData.length === 0) return 0.5;
    
    const timeSpan = behaviorData[0].timestamp - behaviorData[behaviorData.length - 1].timestamp;
    const days = timeSpan / (1000 * 60 * 60 * 24);
    const interactionsPerDay = behaviorData.length / days;
    
    // Normaliser entre 0 et 1
    return Math.min(1.0, interactionsPerDay / 50);
  }

  calculateEngagementTendency(behaviorData) {
    if (behaviorData.length === 0) return 0.5;
    
    const engagementActions = ['like', 'retweet', 'reply', 'share', 'bookmark'];
    const engagementCount = behaviorData.filter(data => 
      engagementActions.some(action => data.action_type.includes(action))
    ).length;
    
    return engagementCount / behaviorData.length;
  }

  calculateAdSusceptibility(behaviorData) {
    if (behaviorData.length === 0) return 0.5;
    
    const adInteractions = behaviorData.filter(data => 
      data.target_type === 'advertisement'
    ).length;
    
    return Math.min(1.0, adInteractions / behaviorData.length * 10);
  }

  // Méthodes de calcul de prédictions
  calculateContentRelevanceScore(userPreferences, contentAnalysis) {
    // Logique simplifiée pour calculer la pertinence du contenu
    let score = 0.5;
    
    if (contentAnalysis.sentiment > 0.7) score += 0.2;
    if (contentAnalysis.hashtag_count > 0) score += 0.1;
    if (contentAnalysis.media_present) score += 0.1;
    
    return Math.min(1.0, score);
  }

  calculateTimingScore(temporalPatterns, adAnalysis) {
    const currentHour = new Date().getHours();
    const peakHours = temporalPatterns.peak_hours || [];
    
    return peakHours.includes(currentHour) ? 1.0 : 0.3;
  }

  calculateDeviceScore(devicePatterns, adAnalysis) {
    // Logique simplifiée pour la compatibilité des appareils
    return 0.8; // Score par défaut
  }

  calculatePurchaseIntent(userProfile) {
    // Logique simplifiée pour l'intention d'achat
    const activityLevel = userProfile.activity_level || 0.5;
    const engagementTendency = userProfile.engagement_tendency || 0.5;
    
    return (activityLevel + engagementTendency) / 2;
  }

  calculateBrandAffinity(userProfile, adAnalysis) {
    // Logique simplifiée pour l'affinité de marque
    return 0.6; // Score par défaut
  }

  calculatePriceSensitivity(userProfile) {
    // Logique simplifiée pour la sensibilité au prix
    return 0.5; // Score par défaut
  }

  calculateDecisionSpeed(userProfile) {
    // Logique simplifiée pour la vitesse de décision
    const activityLevel = userProfile.activity_level || 0.5;
    return activityLevel;
  }

  calculateSocialProofSusceptibility(userProfile) {
    // Logique simplifiée pour la susceptibilité à la preuve sociale
    const socialInfluence = userProfile.social_influence?.influence_score || 0.5;
    return 1 - socialInfluence; // Moins d'influence = plus susceptible
  }

  calculateAdFatigue(userProfile) {
    // Logique simplifiée pour la fatigue publicitaire
    const adSusceptibility = userProfile.ad_susceptibility || 0.5;
    return 1 - adSusceptibility; // Moins susceptible = plus de fatigue
  }

  calculatePersonalizationQuality(userProfile, adAnalysis) {
    // Logique simplifiée pour la qualité de personnalisation
    return 0.7; // Score par défaut
  }

  calculateTimingAppropriateness(userProfile, adAnalysis) {
    return this.calculateTimingScore(userProfile.temporal_patterns, adAnalysis);
  }

  calculateCreativeAppeal(adAnalysis) {
    // Logique simplifiée pour l'attrait créatif
    let score = 0.5;
    
    if (adAnalysis.media_analysis?.has_media) score += 0.2;
    if (adAnalysis.content_analysis?.sentiment > 0.6) score += 0.2;
    if (adAnalysis.hashtag_analysis?.hashtag_count > 0) score += 0.1;
    
    return Math.min(1.0, score);
  }

  calculateBudgetEfficiency(advertisement) {
    const budget = advertisement.budget || 0;
    const costPerImpression = advertisement.cost_per_impression || 0.1;
    
    if (budget === 0) return 0.5;
    
    // Calculer l'efficacité basée sur le budget et les coûts
    const maxImpressions = budget / costPerImpression;
    return Math.min(1.0, maxImpressions / 10000); // Normaliser
  }

  calculateOverallPredictionScore(predictions) {
    const weights = {
      engagement: 0.4,
      conversion: 0.35,
      satisfaction: 0.25
    };
    
    return (
      predictions.engagement.score * weights.engagement +
      predictions.conversion.score * weights.conversion +
      predictions.satisfaction.score * weights.satisfaction
    );
  }

  calculateConfidenceScore(predictions) {
    // Calculer la confiance basée sur la cohérence des prédictions
    const scores = [
      predictions.engagement.score,
      predictions.conversion.score,
      predictions.satisfaction.score
    ];
    
    const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const variance = scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) / scores.length;
    const standardDeviation = Math.sqrt(variance);
    
    // Confiance inversement proportionnelle à l'écart-type
    return Math.max(0.1, 1 - standardDeviation);
  }

  calculatePredictionConfidence(userProfile, predictionType) {
    // Confiance basée sur la quantité de données disponibles
    const dataQuality = userProfile.activity_level || 0.5;
    const dataQuantity = Object.keys(userProfile).length / 10; // Normaliser
    
    return Math.min(1.0, (dataQuality + dataQuantity) / 2);
  }

  calculateNextOptimalTime(peakHours, optimalDays) {
    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay();
    
    // Trouver la prochaine heure optimale
    const nextOptimalHour = peakHours.find(hour => hour > currentHour) || peakHours[0];
    
    // Calculer le prochain moment optimal
    const nextOptimal = new Date(now);
    if (nextOptimalHour <= currentHour) {
      nextOptimal.setDate(nextOptimal.getDate() + 1);
    }
    nextOptimal.setHours(nextOptimalHour, 0, 0, 0);
    
    return nextOptimal;
  }

  categorizeInfluenceLevel(influenceScore) {
    if (influenceScore >= 0.8) return 'high';
    if (influenceScore >= 0.6) return 'medium';
    if (influenceScore >= 0.4) return 'low';
    return 'minimal';
  }

  // Méthodes d'analyse de contenu
  analyzeContent(content) {
    return {
      sentiment: this.analyzeSentiment(content),
      length: content.length,
      hashtag_count: (content.match(/#\w+/g) || []).length,
      mention_count: (content.match(/@\w+/g) || []).length,
      media_present: content.includes('http') || content.includes('www')
    };
  }

  analyzeHashtags(hashtags) {
    return {
      hashtag_count: hashtags.length,
      hashtags: hashtags,
      trending_potential: this.calculateTrendingPotential(hashtags)
    };
  }

  analyzeMedia(mediaUrls) {
    return {
      has_media: mediaUrls.length > 0,
      media_count: mediaUrls.length,
      media_types: this.categorizeMediaTypes(mediaUrls)
    };
  }

  analyzeCurrentTargeting(targetingCriteria) {
    if (!targetingCriteria) return { complexity: 0, effectiveness: 0.5 };
    
    const criteriaCount = Object.keys(targetingCriteria).length;
    return {
      complexity: criteriaCount,
      effectiveness: Math.min(1.0, criteriaCount / 5), // Plus de critères = plus efficace
      criteria: targetingCriteria
    };
  }

  async analyzeCompetition(advertisement) {
    try {
      // Logique simplifiée pour l'analyse concurrentielle
      const similarAds = await Advertisement.count({
        where: {
          status: 'active',
          id: { [require('sequelize').Op.ne]: advertisement.id }
        }
      });
      
      return {
        competitor_count: similarAds,
        competitive_intensity: Math.min(1.0, similarAds / 100),
        market_saturation: similarAds > 50 ? 'high' : similarAds > 20 ? 'medium' : 'low'
      };
    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse concurrentielle:', error);
      return { competitor_count: 0, competitive_intensity: 0, market_saturation: 'low' };
    }
  }

  // Méthodes utilitaires
  analyzeSentiment(content) {
    const positiveWords = ['génial', 'super', 'excellent', 'parfait', 'merci', 'bravo'];
    const negativeWords = ['nul', 'terrible', 'horrible', 'déçu', 'problème'];
    
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

  calculateTrendingPotential(hashtags) {
    // Logique simplifiée pour le potentiel de tendance
    return Math.min(1.0, hashtags.length / 5);
  }

  categorizeMediaTypes(mediaUrls) {
    const types = {};
    mediaUrls.forEach(url => {
      const extension = url.split('.').pop().toLowerCase();
      if (['jpg', 'jpeg', 'png', 'gif'].includes(extension)) {
        types.images = (types.images || 0) + 1;
      } else if (['mp4', 'mov', 'avi'].includes(extension)) {
        types.videos = (types.videos || 0) + 1;
      } else {
        types.other = (types.other || 0) + 1;
      }
    });
    return types;
  }

  /**
   * 🎯 Obtenir les meilleures prédictions pour une publicité
   */
  async getTopPredictions(advertisementId, limit = 100) {
    try {
      // Récupérer les utilisateurs actifs récents
      const activeUsers = await User.findAll({
        where: {
          // Filtrer les utilisateurs actifs récemment
        },
        limit: limit,
        order: [['updated_at', 'DESC']]
      });

      const predictions = await Promise.all(
        activeUsers.map(user => this.predictAdPerformance(advertisementId, user.id))
      );

      // Trier par score global
      return predictions
        .filter(pred => pred.predictions?.overall_score)
        .sort((a, b) => b.predictions.overall_score - a.predictions.overall_score);

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des prédictions:', error);
      throw error;
    }
  }

  /**
   * 🔄 Nettoyer le cache des prédictions expirées
   */
  cleanupExpiredPredictions() {
    const now = new Date();
    const maxAge = 60 * 60 * 1000; // 1 heure

    for (const [key, cached] of this.targetingCache.entries()) {
      if (now - cached.timestamp > maxAge) {
        this.targetingCache.delete(key);
      }
    }
  }
}

module.exports = new PredictiveTargetingService();
