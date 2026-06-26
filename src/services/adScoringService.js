/**
 * 🎯 Service de Scoring Publicitaire Intelligent
 * 
 * Évalue et optimise l'efficacité des publicités en temps réel
 * basé sur des algorithmes de machine learning et des métriques avancées
 */

const logger = require('../utils/logger');
const { 
  Advertisement, 
  AdImpression, 
  AdClick, 
  AdEngagement, 
  User, 
  Tweet,
  UserBehaviorData 
} = require('../models');

class AdScoringService {
  constructor() {
    this.scoringCache = new Map();
    this.performanceModels = new Map();
    this.optimizationRules = new Map();
    this.initialized = true;
    
    // Initialiser les modèles de scoring
    this.initializeScoringModels();
    
    logger.info('🎯 Service de scoring publicitaire initialisé');
  }

  /**
   * 🧠 Initialiser les modèles de scoring
   */
  initializeScoringModels() {
    // Modèle de scoring d'engagement
    this.performanceModels.set('engagement', {
      weights: {
        click_through_rate: 0.3,
        engagement_rate: 0.25,
        conversion_rate: 0.2,
        quality_score: 0.15,
        user_satisfaction: 0.1
      },
      thresholds: {
        excellent: 0.8,
        good: 0.6,
        average: 0.4,
        poor: 0.2
      }
    });

    // Modèle de scoring de ciblage
    this.performanceModels.set('targeting', {
      weights: {
        audience_match: 0.4,
        content_relevance: 0.3,
        timing_optimization: 0.2,
        competitive_advantage: 0.1
      }
    });

    // Modèle de scoring de rentabilité
    this.performanceModels.set('profitability', {
      weights: {
        cost_efficiency: 0.4,
        revenue_generation: 0.3,
        lifetime_value: 0.2,
        market_penetration: 0.1
      }
    });
  }

  /**
   * 📊 Calculer le score global d'une publicité
   */
  async calculateAdScore(advertisementId, timeWindow = 24) {
    try {
      const advertisement = await Advertisement.findByPk(advertisementId, {
        include: [{ model: Tweet, as: 'tweet' }]
      });

      if (!advertisement) {
        throw new Error('Publicité non trouvée');
      }

      // Calculer les différents scores
      const [engagementScore, targetingScore, profitabilityScore] = await Promise.all([
        this.calculateEngagementScore(advertisementId, timeWindow),
        this.calculateTargetingScore(advertisementId),
        this.calculateProfitabilityScore(advertisementId, timeWindow)
      ]);

      // Score global pondéré
      const globalScore = this.calculateWeightedScore({
        engagement: engagementScore,
        targeting: targetingScore,
        profitability: profitabilityScore
      });

      // Analyser les tendances
      const trends = await this.analyzePerformanceTrends(advertisementId, timeWindow);

      // Générer des recommandations
      const recommendations = await this.generateOptimizationRecommendations(
        advertisementId, 
        { engagementScore, targetingScore, profitabilityScore, trends }
      );

      const scoreData = {
        advertisement_id: advertisementId,
        global_score: globalScore,
        component_scores: {
          engagement: engagementScore,
          targeting: targetingScore,
          profitability: profitabilityScore
        },
        trends: trends,
        recommendations: recommendations,
        calculated_at: new Date(),
        time_window_hours: timeWindow
      };

      // Mettre en cache le score
      this.scoringCache.set(`score_${advertisementId}`, {
        data: scoreData,
        timestamp: new Date()
      });

      logger.info(`📊 Score calculé pour la publicité ${advertisementId}: ${globalScore.toFixed(3)}`);
      
      return scoreData;

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score:', error);
      throw error;
    }
  }

  /**
   * 🎯 Calculer le score d'engagement
   */
  async calculateEngagementScore(advertisementId, timeWindow) {
    try {
      const timeThreshold = new Date(Date.now() - timeWindow * 60 * 60 * 1000);

      // Récupérer les métriques d'engagement
      const [impressions, clicks, engagements] = await Promise.all([
        AdImpression.count({
          where: {
            advertisement_id: advertisementId,
            created_at: { [require('sequelize').Op.gte]: timeThreshold }
          }
        }),
        AdClick.count({
          where: {
            advertisement_id: advertisementId,
            created_at: { [require('sequelize').Op.gte]: timeThreshold }
          }
        }),
        AdEngagement.count({
          where: {
            advertisement_id: advertisementId,
            created_at: { [require('sequelize').Op.gte]: timeThreshold }
          }
        })
      ]);

      // Calculer les taux
      const clickThroughRate = impressions > 0 ? clicks / impressions : 0;
      const engagementRate = impressions > 0 ? engagements / impressions : 0;

      // Récupérer les données comportementales pour la qualité
      const behaviorData = await UserBehaviorData.findAll({
        where: {
          target_id: advertisementId,
          target_type: 'advertisement',
          timestamp: { [require('sequelize').Op.gte]: timeThreshold }
        },
        attributes: ['interaction_quality', 'context_data']
      });

      // Calculer le score de qualité moyen
      const avgQualityScore = behaviorData.length > 0 
        ? behaviorData.reduce((sum, data) => sum + (data.interaction_quality || 0), 0) / behaviorData.length
        : 0.5;

      // Calculer la satisfaction utilisateur
      const userSatisfaction = await this.calculateUserSatisfaction(advertisementId, timeWindow);

      // Appliquer le modèle de scoring
      const model = this.performanceModels.get('engagement');
      const score = (
        clickThroughRate * model.weights.click_through_rate +
        engagementRate * model.weights.engagement_rate +
        avgQualityScore * model.weights.quality_score +
        userSatisfaction * model.weights.user_satisfaction
      );

      return {
        score: Math.min(1.0, Math.max(0.0, score)),
        metrics: {
          impressions,
          clicks,
          engagements,
          click_through_rate: clickThroughRate,
          engagement_rate: engagementRate,
          quality_score: avgQualityScore,
          user_satisfaction: userSatisfaction
        }
      };

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score d\'engagement:', error);
      return { score: 0.5, metrics: {} };
    }
  }

  /**
   * 🎯 Calculer le score de ciblage
   */
  async calculateTargetingScore(advertisementId) {
    try {
      const advertisement = await Advertisement.findByPk(advertisementId, {
        include: [{ model: Tweet, as: 'tweet' }]
      });

      if (!advertisement) return { score: 0.5, metrics: {} };

      // Analyser la correspondance avec l'audience
      const audienceMatch = await this.analyzeAudienceMatch(advertisement);
      
      // Analyser la pertinence du contenu
      const contentRelevance = await this.analyzeContentRelevance(advertisement);
      
      // Analyser l'optimisation temporelle
      const timingOptimization = await this.analyzeTimingOptimization(advertisement);
      
      // Analyser l'avantage concurrentiel
      const competitiveAdvantage = await this.analyzeCompetitiveAdvantage(advertisement);

      // Appliquer le modèle de scoring
      const model = this.performanceModels.get('targeting');
      const score = (
        audienceMatch * model.weights.audience_match +
        contentRelevance * model.weights.content_relevance +
        timingOptimization * model.weights.timing_optimization +
        competitiveAdvantage * model.weights.competitive_advantage
      );

      return {
        score: Math.min(1.0, Math.max(0.0, score)),
        metrics: {
          audience_match: audienceMatch,
          content_relevance: contentRelevance,
          timing_optimization: timingOptimization,
          competitive_advantage: competitiveAdvantage
        }
      };

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score de ciblage:', error);
      return { score: 0.5, metrics: {} };
    }
  }

  /**
   * 💰 Calculer le score de rentabilité
   */
  async calculateProfitabilityScore(advertisementId, timeWindow) {
    try {
      const advertisement = await Advertisement.findByPk(advertisementId);
      if (!advertisement) return { score: 0.5, metrics: {} };

      const timeThreshold = new Date(Date.now() - timeWindow * 60 * 60 * 1000);

      // Calculer l'efficacité des coûts
      const costEfficiency = await this.calculateCostEfficiency(advertisementId, timeWindow);
      
      // Calculer la génération de revenus
      const revenueGeneration = await this.calculateRevenueGeneration(advertisementId, timeWindow);
      
      // Calculer la valeur à vie
      const lifetimeValue = await this.calculateLifetimeValue(advertisementId);
      
      // Calculer la pénétration du marché
      const marketPenetration = await this.calculateMarketPenetration(advertisementId, timeWindow);

      // Appliquer le modèle de scoring
      const model = this.performanceModels.get('profitability');
      const score = (
        costEfficiency * model.weights.cost_efficiency +
        revenueGeneration * model.weights.revenue_generation +
        lifetimeValue * model.weights.lifetime_value +
        marketPenetration * model.weights.market_penetration
      );

      return {
        score: Math.min(1.0, Math.max(0.0, score)),
        metrics: {
          cost_efficiency: costEfficiency,
          revenue_generation: revenueGeneration,
          lifetime_value: lifetimeValue,
          market_penetration: marketPenetration
        }
      };

    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score de rentabilité:', error);
      return { score: 0.5, metrics: {} };
    }
  }

  /**
   * 📈 Analyser les tendances de performance
   */
  async analyzePerformanceTrends(advertisementId, timeWindow) {
    try {
      const now = new Date();
      const periods = [
        { start: new Date(now - timeWindow * 60 * 60 * 1000), end: new Date(now - (timeWindow/2) * 60 * 60 * 1000), label: 'first_half' },
        { start: new Date(now - (timeWindow/2) * 60 * 60 * 1000), end: now, label: 'second_half' }
      ];

      const trends = {};

      for (const period of periods) {
        const [impressions, clicks, engagements] = await Promise.all([
          AdImpression.count({
            where: {
              advertisement_id: advertisementId,
              created_at: { [require('sequelize').Op.between]: [period.start, period.end] }
            }
          }),
          AdClick.count({
            where: {
              advertisement_id: advertisementId,
              created_at: { [require('sequelize').Op.between]: [period.start, period.end] }
            }
          }),
          AdEngagement.count({
            where: {
              advertisement_id: advertisementId,
              created_at: { [require('sequelize').Op.between]: [period.start, period.end] }
            }
          })
        ]);

        trends[period.label] = {
          impressions,
          clicks,
          engagements,
          click_through_rate: impressions > 0 ? clicks / impressions : 0,
          engagement_rate: impressions > 0 ? engagements / impressions : 0
        };
      }

      // Calculer les tendances
      const ctrTrend = trends.second_half.click_through_rate - trends.first_half.click_through_rate;
      const engagementTrend = trends.second_half.engagement_rate - trends.first_half.engagement_rate;
      const impressionTrend = trends.second_half.impressions - trends.first_half.impressions;

      return {
        click_through_rate_trend: ctrTrend,
        engagement_rate_trend: engagementTrend,
        impression_trend: impressionTrend,
        overall_trend: this.calculateOverallTrend(ctrTrend, engagementTrend, impressionTrend),
        periods: trends
      };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des tendances:', error);
      return { overall_trend: 'stable' };
    }
  }

  /**
   * 💡 Générer des recommandations d'optimisation
   */
  async generateOptimizationRecommendations(advertisementId, scores) {
    const recommendations = [];

    // Recommandations basées sur le score d'engagement
    if (scores.engagementScore.score < 0.4) {
      recommendations.push({
        type: 'engagement',
        priority: 'high',
        title: 'Améliorer l\'engagement',
        description: 'Le taux d\'engagement est faible. Considérez améliorer le contenu ou le ciblage.',
        actions: [
          'Optimiser le contenu créatif',
          'Ajuster les critères de ciblage',
          'Tester différents formats de publicité'
        ],
        expected_impact: 'medium'
      });
    }

    // Recommandations basées sur le score de ciblage
    if (scores.targetingScore.score < 0.5) {
      recommendations.push({
        type: 'targeting',
        priority: 'high',
        title: 'Optimiser le ciblage',
        description: 'Le ciblage peut être amélioré pour atteindre une audience plus pertinente.',
        actions: [
          'Affiner les critères démographiques',
          'Analyser les intérêts de l\'audience',
          'Optimiser les heures de diffusion'
        ],
        expected_impact: 'high'
      });
    }

    // Recommandations basées sur la rentabilité
    if (scores.profitabilityScore.score < 0.6) {
      recommendations.push({
        type: 'profitability',
        priority: 'medium',
        title: 'Optimiser la rentabilité',
        description: 'Les coûts peuvent être optimisés pour améliorer le ROI.',
        actions: [
          'Ajuster les enchères',
          'Optimiser le budget quotidien',
          'Analyser la concurrence'
        ],
        expected_impact: 'medium'
      });
    }

    // Recommandations basées sur les tendances
    if (scores.trends.overall_trend === 'declining') {
      recommendations.push({
        type: 'trend',
        priority: 'high',
        title: 'Performance en déclin',
        description: 'La performance de la publicité est en baisse. Action immédiate recommandée.',
        actions: [
          'Analyser les causes du déclin',
          'Ajuster la stratégie rapidement',
          'Considérer une pause temporaire'
        ],
        expected_impact: 'high'
      });
    }

    return recommendations;
  }

  /**
   * 🎯 Analyser la correspondance avec l'audience
   */
  async analyzeAudienceMatch(advertisement) {
    try {
      if (!advertisement.targeting_criteria) return 0.5;

      const criteria = advertisement.targeting_criteria;
      let matchScore = 0;
      let totalCriteria = 0;

      // Analyser les critères démographiques
      if (criteria.min_followers) {
        totalCriteria++;
        // Logique de correspondance basée sur les followers
        matchScore += 0.3;
      }

      if (criteria.verified_only) {
        totalCriteria++;
        matchScore += 0.2;
      }

      if (criteria.interests && criteria.interests.length > 0) {
        totalCriteria++;
        matchScore += 0.3;
      }

      if (criteria.location) {
        totalCriteria++;
        matchScore += 0.2;
      }

      return totalCriteria > 0 ? matchScore / totalCriteria : 0.5;
    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse de correspondance:', error);
      return 0.5;
    }
  }

  /**
   * 📝 Analyser la pertinence du contenu
   */
  async analyzeContentRelevance(advertisement) {
    try {
      if (!advertisement.tweet) return 0.5;

      const content = advertisement.tweet.content;
      const hashtags = advertisement.tweet.hashtags || [];
      
      // Analyse simple de la pertinence
      let relevanceScore = 0.5;

      // Bonus pour les hashtags pertinents
      if (hashtags.length > 0) {
        relevanceScore += 0.2;
      }

      // Bonus pour la longueur appropriée
      if (content && content.length > 50 && content.length < 600) {
        relevanceScore += 0.2;
      }

      // Bonus pour les mentions
      if (content && content.includes('@')) {
        relevanceScore += 0.1;
      }

      return Math.min(1.0, relevanceScore);
    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse de pertinence:', error);
      return 0.5;
    }
  }

  /**
   * ⏰ Analyser l'optimisation temporelle
   */
  async analyzeTimingOptimization(advertisement) {
    try {
      const now = new Date();
      const currentHour = now.getHours();
      
      // Heures optimales pour l'engagement (basé sur des données générales)
      const optimalHours = [9, 12, 15, 18, 21];
      const isOptimalTime = optimalHours.includes(currentHour);
      
      return isOptimalTime ? 0.8 : 0.5;
    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse temporelle:', error);
      return 0.5;
    }
  }

  /**
   * 🏆 Analyser l'avantage concurrentiel
   */
  async analyzeCompetitiveAdvantage(advertisement) {
    try {
      // Logique simple pour l'avantage concurrentiel
      let advantageScore = 0.5;

      // Bonus pour les publicités avec un budget plus élevé
      if (advertisement.budget > 100) {
        advantageScore += 0.2;
      }

      // Bonus pour les publicités avec des coûts optimisés
      if (advertisement.cost_per_impression < 0.05) {
        advantageScore += 0.2;
      }

      // Bonus pour les publicités récentes
      const ageInHours = (new Date() - advertisement.created_at) / (1000 * 60 * 60);
      if (ageInHours < 24) {
        advantageScore += 0.1;
      }

      return Math.min(1.0, advantageScore);
    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse concurrentielle:', error);
      return 0.5;
    }
  }

  /**
   * 💰 Calculer l'efficacité des coûts
   */
  async calculateCostEfficiency(advertisementId, timeWindow) {
    try {
      const timeThreshold = new Date(Date.now() - timeWindow * 60 * 60 * 1000);
      
      const [impressions, clicks] = await Promise.all([
        AdImpression.count({
          where: {
            advertisement_id: advertisementId,
            created_at: { [require('sequelize').Op.gte]: timeThreshold }
          }
        }),
        AdClick.count({
          where: {
            advertisement_id: advertisementId,
            created_at: { [require('sequelize').Op.gte]: timeThreshold }
          }
        })
      ]);

      if (impressions === 0) return 0.5;

      const ctr = clicks / impressions;
      const costPerClick = 0.10; // Coût moyen par clic
      const efficiency = ctr / costPerClick;

      return Math.min(1.0, efficiency * 10); // Normaliser
    } catch (error) {
      logger.error('❌ Erreur lors du calcul de l\'efficacité:', error);
      return 0.5;
    }
  }

  /**
   * 💵 Calculer la génération de revenus
   */
  async calculateRevenueGeneration(advertisementId, timeWindow) {
    try {
      // Logique simplifiée pour la génération de revenus
      const timeThreshold = new Date(Date.now() - timeWindow * 60 * 60 * 1000);
      
      const engagements = await AdEngagement.count({
        where: {
          advertisement_id: advertisementId,
          created_at: { [require('sequelize').Op.gte]: timeThreshold }
        }
      });

      // Estimation du revenu basé sur les engagements
      const estimatedRevenue = engagements * 0.05; // 0.05 TWC par engagement
      const maxExpectedRevenue = 10; // Revenu maximum attendu

      return Math.min(1.0, estimatedRevenue / maxExpectedRevenue);
    } catch (error) {
      logger.error('❌ Erreur lors du calcul des revenus:', error);
      return 0.5;
    }
  }

  /**
   * 🔄 Calculer la valeur à vie
   */
  async calculateLifetimeValue(advertisementId) {
    try {
      // Logique simplifiée pour la valeur à vie
      const advertisement = await Advertisement.findByPk(advertisementId);
      if (!advertisement) return 0.5;

      const budget = advertisement.budget || 0;
      const maxBudget = 1000; // Budget maximum de référence

      return Math.min(1.0, budget / maxBudget);
    } catch (error) {
      logger.error('❌ Erreur lors du calcul de la valeur à vie:', error);
      return 0.5;
    }
  }

  /**
   * 📊 Calculer la pénétration du marché
   */
  async calculateMarketPenetration(advertisementId, timeWindow) {
    try {
      const timeThreshold = new Date(Date.now() - timeWindow * 60 * 60 * 1000);
      
      const impressions = await AdImpression.count({
        where: {
          advertisement_id: advertisementId,
          created_at: { [require('sequelize').Op.gte]: timeThreshold }
        }
      });

      // Estimation de la pénétration basée sur les impressions
      const maxExpectedImpressions = 10000; // Impressions maximum attendues
      return Math.min(1.0, impressions / maxExpectedImpressions);
    } catch (error) {
      logger.error('❌ Erreur lors du calcul de la pénétration:', error);
      return 0.5;
    }
  }

  /**
   * 😊 Calculer la satisfaction utilisateur
   */
  async calculateUserSatisfaction(advertisementId, timeWindow) {
    try {
      const timeThreshold = new Date(Date.now() - timeWindow * 60 * 60 * 1000);
      
      const behaviorData = await UserBehaviorData.findAll({
        where: {
          target_id: advertisementId,
          target_type: 'advertisement',
          timestamp: { [require('sequelize').Op.gte]: timeThreshold }
        },
        attributes: ['interaction_quality', 'action_type']
      });

      if (behaviorData.length === 0) return 0.5;

      // Calculer la satisfaction basée sur la qualité des interactions
      const avgQuality = behaviorData.reduce((sum, data) => sum + (data.interaction_quality || 0), 0) / behaviorData.length;
      
      // Bonus pour les interactions positives
      const positiveInteractions = behaviorData.filter(data => 
        ['like', 'retweet', 'reply', 'share'].includes(data.action_type.replace('ad_', ''))
      ).length;
      
      const positiveRatio = positiveInteractions / behaviorData.length;
      
      return (avgQuality + positiveRatio) / 2;
    } catch (error) {
      logger.error('❌ Erreur lors du calcul de la satisfaction:', error);
      return 0.5;
    }
  }

  /**
   * 📊 Calculer le score pondéré global
   */
  calculateWeightedScore(scores) {
    const weights = {
      engagement: 0.4,
      targeting: 0.35,
      profitability: 0.25
    };

    return (
      scores.engagement.score * weights.engagement +
      scores.targeting.score * weights.targeting +
      scores.profitability.score * weights.profitability
    );
  }

  /**
   * 📈 Calculer la tendance globale
   */
  calculateOverallTrend(ctrTrend, engagementTrend, impressionTrend) {
    const positiveTrends = [ctrTrend, engagementTrend, impressionTrend].filter(trend => trend > 0).length;
    
    if (positiveTrends >= 2) return 'improving';
    if (positiveTrends === 1) return 'stable';
    return 'declining';
  }

  /**
   * 🎯 Obtenir le score en cache ou le calculer
   */
  async getAdScore(advertisementId, forceRefresh = false) {
    const cacheKey = `score_${advertisementId}`;
    const cached = this.scoringCache.get(cacheKey);
    
    if (!forceRefresh && cached && (new Date() - cached.timestamp) < 5 * 60 * 1000) {
      return cached.data;
    }

    return await this.calculateAdScore(advertisementId);
  }

  /**
   * 📊 Obtenir les scores de toutes les publicités actives
   */
  async getAllActiveAdScores() {
    try {
      const activeAds = await Advertisement.findAll({
        where: { status: 'active' },
        attributes: ['id', 'title', 'budget', 'status']
      });

      const scores = await Promise.all(
        activeAds.map(ad => this.getAdScore(ad.id))
      );

      return scores.sort((a, b) => b.global_score - a.global_score);
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des scores:', error);
      throw error;
    }
  }

  /**
   * 🔄 Nettoyer le cache des scores expirés
   */
  cleanupExpiredScores() {
    const now = new Date();
    const maxAge = 30 * 60 * 1000; // 30 minutes

    for (const [key, cached] of this.scoringCache.entries()) {
      if (now - cached.timestamp > maxAge) {
        this.scoringCache.delete(key);
      }
    }
  }
}

module.exports = new AdScoringService();
