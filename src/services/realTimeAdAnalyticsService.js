/**
 * 📊 Service d'Analytics Publicitaires en Temps Réel
 * 
 * Fournit des analytics détaillés et en temps réel pour les annonceurs
 * avec des tableaux de bord interactifs et des alertes intelligentes
 */

const logger = require('../utils/logger');
const { 
  Advertisement, 
  AdCampaign,
  AdImpression, 
  AdClick, 
  AdEngagement,
  User,
  UserBehaviorData,
  AdPerformanceMetrics 
} = require('../models');

class RealTimeAdAnalyticsService {
  constructor() {
    this.analyticsCache = new Map();
    this.realTimeMetrics = new Map();
    this.alertThresholds = new Map();
    this.initialized = true;
    
    // Initialiser les seuils d'alerte par défaut
    this.initializeDefaultAlertThresholds();
    
    logger.info('📊 Service d\'analytics publicitaires en temps réel initialisé');
  }

  /**
   * 📊 Obtenir les analytics en temps réel pour une publicité
   */
  async getRealTimeAnalytics(advertisementId, timeWindow = 24) {
    try {
      const cacheKey = `analytics_${advertisementId}_${timeWindow}`;
      const cached = this.analyticsCache.get(cacheKey);
      
      // Vérifier le cache (mise à jour toutes les 5 minutes)
      if (cached && (new Date() - cached.timestamp) < 5 * 60 * 1000) {
        return cached.data;
      }

      const advertisement = await Advertisement.findByPk(advertisementId, {
        include: [{ model: AdCampaign, as: 'campaign' }]
      });

      if (!advertisement) {
        throw new Error('Publicité non trouvée');
      }

      // Calculer les métriques en temps réel
      const realTimeMetrics = await this.calculateRealTimeMetrics(advertisementId, timeWindow);
      
      // Calculer les tendances
      const trends = await this.calculateTrends(advertisementId, timeWindow);
      
      // Calculer les insights
      const insights = await this.generateInsights(advertisementId, realTimeMetrics, trends);
      
      // Calculer les recommandations
      const recommendations = await this.generateRecommendations(advertisementId, realTimeMetrics, trends);
      
      // Vérifier les alertes
      const alerts = await this.checkAlerts(advertisementId, realTimeMetrics);

      const analytics = {
        advertisement_id: advertisementId,
        advertisement_name: advertisement.title,
        campaign_name: advertisement.campaign?.name,
        time_window_hours: timeWindow,
        last_updated: new Date(),
        real_time_metrics: realTimeMetrics,
        trends: trends,
        insights: insights,
        recommendations: recommendations,
        alerts: alerts,
        performance_grade: this.calculatePerformanceGrade(realTimeMetrics),
        benchmark_comparison: await this.getBenchmarkComparison(advertisementId, realTimeMetrics)
      };

      // Mettre en cache
      this.analyticsCache.set(cacheKey, {
        data: analytics,
        timestamp: new Date()
      });

      logger.info(`📊 Analytics en temps réel générés pour la publicité ${advertisementId}`);
      
      return analytics;

    } catch (error) {
      logger.error('❌ Erreur lors de la génération des analytics:', error);
      throw error;
    }
  }

  /**
   * 📈 Obtenir les analytics pour une campagne
   */
  async getCampaignAnalytics(campaignId, timeWindow = 24) {
    try {
      const campaign = await AdCampaign.findByPk(campaignId, {
        include: [{ model: Advertisement, as: 'advertisements' }]
      });

      if (!campaign) {
        throw new Error('Campagne non trouvée');
      }

      // Obtenir les analytics pour toutes les publicités de la campagne
      const advertisementAnalytics = await Promise.all(
        campaign.advertisements.map(ad => this.getRealTimeAnalytics(ad.id, timeWindow))
      );

      // Agréger les métriques
      const aggregatedMetrics = this.aggregateCampaignMetrics(advertisementAnalytics);
      
      // Calculer les tendances de campagne
      const campaignTrends = this.calculateCampaignTrends(advertisementAnalytics);
      
      // Générer les insights de campagne
      const campaignInsights = this.generateCampaignInsights(aggregatedMetrics, campaignTrends);
      
      // Générer les recommandations de campagne
      const campaignRecommendations = this.generateCampaignRecommendations(aggregatedMetrics, campaignTrends);

      return {
        campaign_id: campaignId,
        campaign_name: campaign.name,
        time_window_hours: timeWindow,
        last_updated: new Date(),
        aggregated_metrics: aggregatedMetrics,
        campaign_trends: campaignTrends,
        campaign_insights: campaignInsights,
        campaign_recommendations: campaignRecommendations,
        advertisement_analytics: advertisementAnalytics,
        performance_grade: this.calculateCampaignPerformanceGrade(aggregatedMetrics)
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la génération des analytics de campagne:', error);
      throw error;
    }
  }

  /**
   * 📊 Calculer les métriques en temps réel
   */
  async calculateRealTimeMetrics(advertisementId, timeWindow) {
    try {
      const timeThreshold = new Date(Date.now() - timeWindow * 60 * 60 * 1000);

      // Récupérer les données de base
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

      // Récupérer les données comportementales détaillées
      const behaviorData = await UserBehaviorData.findAll({
        where: {
          target_id: advertisementId,
          target_type: 'advertisement',
          timestamp: { [require('sequelize').Op.gte]: timeThreshold }
        },
        attributes: ['action_type', 'interaction_quality', 'context_data', 'timestamp']
      });

      // Calculer les métriques dérivées
      const clickThroughRate = impressions > 0 ? clicks / impressions : 0;
      const engagementRate = impressions > 0 ? engagements / impressions : 0;
      const avgQualityScore = behaviorData.length > 0 
        ? behaviorData.reduce((sum, data) => sum + (data.interaction_quality || 0), 0) / behaviorData.length
        : 0.5;

      // Calculer les métriques temporelles
      const hourlyMetrics = this.calculateHourlyMetrics(behaviorData);
      
      // Calculer les métriques démographiques
      const demographicMetrics = await this.calculateDemographicMetrics(advertisementId, timeThreshold);
      
      // Calculer les métriques de coût
      const costMetrics = await this.calculateCostMetrics(advertisementId, timeWindow);

      return {
        impressions,
        clicks,
        engagements,
        click_through_rate: clickThroughRate,
        engagement_rate: engagementRate,
        quality_score: avgQualityScore,
        hourly_metrics: hourlyMetrics,
        demographic_metrics: demographicMetrics,
        cost_metrics: costMetrics,
        behavior_breakdown: this.analyzeBehaviorBreakdown(behaviorData),
        performance_indicators: this.calculatePerformanceIndicators(impressions, clicks, engagements, avgQualityScore)
      };

    } catch (error) {
      logger.error('❌ Erreur lors du calcul des métriques:', error);
      return {};
    }
  }

  /**
   * 📈 Calculer les tendances
   */
  async calculateTrends(advertisementId, timeWindow) {
    try {
      const now = new Date();
      const currentPeriod = new Date(now - timeWindow * 60 * 60 * 1000);
      const previousPeriod = new Date(now - (timeWindow * 2) * 60 * 60 * 1000);

      // Comparer avec la période précédente
      const [currentMetrics, previousMetrics] = await Promise.all([
        this.calculateRealTimeMetrics(advertisementId, timeWindow),
        this.calculateRealTimeMetrics(advertisementId, timeWindow, previousPeriod)
      ]);

      // Calculer les variations
      const trends = {
        impressions_trend: this.calculateTrend(currentMetrics.impressions, previousMetrics.impressions),
        clicks_trend: this.calculateTrend(currentMetrics.clicks, previousMetrics.clicks),
        engagement_trend: this.calculateTrend(currentMetrics.engagement_rate, previousMetrics.engagement_rate),
        ctr_trend: this.calculateTrend(currentMetrics.click_through_rate, previousMetrics.click_through_rate),
        quality_trend: this.calculateTrend(currentMetrics.quality_score, previousMetrics.quality_score),
        cost_trend: this.calculateTrend(currentMetrics.cost_metrics?.cost_per_click, previousMetrics.cost_metrics?.cost_per_click)
      };

      // Analyser les patterns temporels
      const temporalPatterns = this.analyzeTemporalPatterns(currentMetrics.hourly_metrics);
      
      // Analyser les tendances de performance
      const performanceTrends = this.analyzePerformanceTrends(currentMetrics, previousMetrics);

      return {
        ...trends,
        temporal_patterns: temporalPatterns,
        performance_trends: performanceTrends,
        overall_trend: this.calculateOverallTrend(trends)
      };

    } catch (error) {
      logger.error('❌ Erreur lors du calcul des tendances:', error);
      return {};
    }
  }

  /**
   * 💡 Générer des insights
   */
  async generateInsights(advertisementId, metrics, trends) {
    const insights = [];

    // Insight sur les performances
    if (metrics.click_through_rate > 0.05) {
      insights.push({
        type: 'performance',
        priority: 'positive',
        title: 'Excellent taux de clic',
        description: `Votre CTR de ${(metrics.click_through_rate * 100).toFixed(2)}% dépasse la moyenne du marché`,
        impact: 'high',
        actionable: true
      });
    } else if (metrics.click_through_rate < 0.01) {
      insights.push({
        type: 'performance',
        priority: 'negative',
        title: 'CTR faible',
        description: `Votre CTR de ${(metrics.click_through_rate * 100).toFixed(2)}% est en dessous de la moyenne`,
        impact: 'high',
        actionable: true
      });
    }

    // Insight sur les tendances
    if (trends.ctr_trend.direction === 'increasing' && trends.ctr_trend.percentage > 20) {
      insights.push({
        type: 'trend',
        priority: 'positive',
        title: 'Amélioration du CTR',
        description: `Votre CTR a augmenté de ${trends.ctr_trend.percentage.toFixed(1)}% cette période`,
        impact: 'medium',
        actionable: false
      });
    }

    // Insight sur le timing
    const peakHour = this.findPeakHour(metrics.hourly_metrics);
    if (peakHour) {
      insights.push({
        type: 'timing',
        priority: 'informational',
        title: 'Heure de pic identifiée',
        description: `Vos meilleures performances sont à ${peakHour}h`,
        impact: 'medium',
        actionable: true
      });
    }

    // Insight sur la qualité
    if (metrics.quality_score > 0.8) {
      insights.push({
        type: 'quality',
        priority: 'positive',
        title: 'Haute qualité d\'engagement',
        description: 'Vos utilisateurs s\'engagent de manière très positive',
        impact: 'medium',
        actionable: false
      });
    }

    return insights;
  }

  /**
   * 🎯 Générer des recommandations
   */
  async generateRecommendations(advertisementId, metrics, trends) {
    const recommendations = [];

    // Recommandations basées sur le CTR
    if (metrics.click_through_rate < 0.02) {
      recommendations.push({
        type: 'ctr_optimization',
        priority: 'high',
        title: 'Améliorer le taux de clic',
        description: 'Votre CTR est en dessous de la moyenne du marché',
        actions: [
          'Optimiser le titre et la description',
          'Améliorer l\'image ou la vidéo',
          'Affiner le ciblage pour une meilleure pertinence',
          'Tester différents appels à l\'action'
        ],
        expected_improvement: '20-40%',
        effort: 'medium'
      });
    }

    // Recommandations basées sur l'engagement
    if (metrics.engagement_rate < 0.05) {
      recommendations.push({
        type: 'engagement_optimization',
        priority: 'high',
        title: 'Augmenter l\'engagement',
        description: 'Le taux d\'engagement peut être amélioré',
        actions: [
          'Créer du contenu plus interactif',
          'Poser des questions pour encourager les réponses',
          'Utiliser des hashtags pertinents',
          'Optimiser le timing de publication'
        ],
        expected_improvement: '15-30%',
        effort: 'medium'
      });
    }

    // Recommandations basées sur les coûts
    if (metrics.cost_metrics?.cost_per_click > 0.5) {
      recommendations.push({
        type: 'cost_optimization',
        priority: 'medium',
        title: 'Optimiser les coûts',
        description: 'Le coût par clic est élevé',
        actions: [
          'Ajuster les enchères',
          'Améliorer la pertinence pour réduire les coûts',
          'Cibler des audiences moins concurrentielles',
          'Optimiser la qualité de l\'annonce'
        ],
        expected_improvement: '10-25%',
        effort: 'low'
      });
    }

    // Recommandations basées sur les tendances
    if (trends.overall_trend === 'declining') {
      recommendations.push({
        type: 'trend_reversal',
        priority: 'high',
        title: 'Inverser la tendance négative',
        description: 'Les performances sont en déclin',
        actions: [
          'Analyser les causes du déclin',
          'Rafraîchir le contenu créatif',
          'Ajuster la stratégie de ciblage',
          'Considérer une pause temporaire'
        ],
        expected_improvement: 'Variable',
        effort: 'high'
      });
    }

    return recommendations;
  }

  /**
   * 🚨 Vérifier les alertes
   */
  async checkAlerts(advertisementId, metrics) {
    const alerts = [];
    const thresholds = this.alertThresholds.get(advertisementId) || this.getDefaultThresholds();

    // Alerte CTR faible
    if (metrics.click_through_rate < thresholds.ctr_minimum) {
      alerts.push({
        type: 'ctr_low',
        severity: 'warning',
        title: 'CTR en dessous du seuil',
        message: `CTR actuel: ${(metrics.click_through_rate * 100).toFixed(2)}% (seuil: ${(thresholds.ctr_minimum * 100).toFixed(2)}%)`,
        timestamp: new Date(),
        actionable: true
      });
    }

    // Alerte coût élevé
    if (metrics.cost_metrics?.cost_per_click > thresholds.cpc_maximum) {
      alerts.push({
        type: 'cost_high',
        severity: 'warning',
        title: 'Coût par clic élevé',
        message: `CPC actuel: ${metrics.cost_metrics.cost_per_click.toFixed(2)} TWC (seuil: ${thresholds.cpc_maximum.toFixed(2)} TWC)`,
        timestamp: new Date(),
        actionable: true
      });
    }

    // Alerte budget épuisé
    if (metrics.cost_metrics?.budget_utilization > thresholds.budget_utilization_maximum) {
      alerts.push({
        type: 'budget_high',
        severity: 'critical',
        title: 'Budget fortement utilisé',
        message: `Utilisation du budget: ${(metrics.cost_metrics.budget_utilization * 100).toFixed(1)}%`,
        timestamp: new Date(),
        actionable: true
      });
    }

    // Alerte qualité faible
    if (metrics.quality_score < thresholds.quality_minimum) {
      alerts.push({
        type: 'quality_low',
        severity: 'warning',
        title: 'Score de qualité faible',
        message: `Score de qualité: ${metrics.quality_score.toFixed(2)} (seuil: ${thresholds.quality_minimum.toFixed(2)})`,
        timestamp: new Date(),
        actionable: true
      });
    }

    return alerts;
  }

  /**
   * 📊 Calculer les métriques horaires
   */
  calculateHourlyMetrics(behaviorData) {
    const hourlyData = {};
    
    // Initialiser les heures
    for (let i = 0; i < 24; i++) {
      hourlyData[i] = {
        impressions: 0,
        clicks: 0,
        engagements: 0,
        quality_scores: []
      };
    }

    // Agréger les données par heure
    behaviorData.forEach(data => {
      const hour = new Date(data.timestamp).getHours();
      
      if (data.action_type.includes('impression')) {
        hourlyData[hour].impressions++;
      } else if (data.action_type.includes('click')) {
        hourlyData[hour].clicks++;
      } else if (data.action_type.includes('engagement')) {
        hourlyData[hour].engagements++;
      }
      
      if (data.interaction_quality) {
        hourlyData[hour].quality_scores.push(data.interaction_quality);
      }
    });

    // Calculer les métriques dérivées
    Object.keys(hourlyData).forEach(hour => {
      const data = hourlyData[hour];
      data.click_through_rate = data.impressions > 0 ? data.clicks / data.impressions : 0;
      data.engagement_rate = data.impressions > 0 ? data.engagements / data.impressions : 0;
      data.avg_quality_score = data.quality_scores.length > 0 
        ? data.quality_scores.reduce((sum, score) => sum + score, 0) / data.quality_scores.length
        : 0.5;
    });

    return hourlyData;
  }

  /**
   * 👥 Calculer les métriques démographiques
   */
  async calculateDemographicMetrics(advertisementId, timeThreshold) {
    try {
      const behaviorData = await UserBehaviorData.findAll({
        where: {
          target_id: advertisementId,
          target_type: 'advertisement',
          timestamp: { [require('sequelize').Op.gte]: timeThreshold }
        },
        include: [{
          model: User,
          as: 'user',
          attributes: ['id', 'stats', 'verified', 'premium']
        }]
      });

      const demographics = {
        user_segments: {},
        device_distribution: {},
        engagement_by_segment: {}
      };

      behaviorData.forEach(data => {
        const user = data.user;
        
        // Segmenter par type d'utilisateur
        let segment = 'casual';
        if (user.verified) segment = 'verified';
        else if (user.premium) segment = 'premium';
        else if (user.stats?.followers > 1000) segment = 'influencer';
        
        demographics.user_segments[segment] = (demographics.user_segments[segment] || 0) + 1;
        
        // Distribution des appareils
        if (data.device_info?.device_type) {
          const deviceType = data.device_info.device_type;
          demographics.device_distribution[deviceType] = (demographics.device_distribution[deviceType] || 0) + 1;
        }
      });

      return demographics;
    } catch (error) {
      logger.error('❌ Erreur lors du calcul des métriques démographiques:', error);
      return {};
    }
  }

  /**
   * 💰 Calculer les métriques de coût
   */
  async calculateCostMetrics(advertisementId, timeWindow) {
    try {
      const advertisement = await Advertisement.findByPk(advertisementId);
      if (!advertisement) return {};

      const timeThreshold = new Date(Date.now() - timeWindow * 60 * 60 * 1000);

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

      const totalSpend = (impressions * advertisement.cost_per_impression) + 
                        (clicks * advertisement.cost_per_click) + 
                        (engagements * advertisement.cost_per_engagement);

      const budget = advertisement.budget || 0;
      const budgetUtilization = budget > 0 ? totalSpend / budget : 0;

      return {
        total_spend: totalSpend,
        cost_per_impression: advertisement.cost_per_impression,
        cost_per_click: advertisement.cost_per_click,
        cost_per_engagement: advertisement.cost_per_engagement,
        budget_utilization: budgetUtilization,
        remaining_budget: Math.max(0, budget - totalSpend),
        efficiency_score: this.calculateEfficiencyScore(impressions, clicks, totalSpend)
      };
    } catch (error) {
      logger.error('❌ Erreur lors du calcul des métriques de coût:', error);
      return {};
    }
  }

  /**
   * 📊 Analyser la répartition des comportements
   */
  analyzeBehaviorBreakdown(behaviorData) {
    const breakdown = {
      action_types: {},
      quality_distribution: {},
      temporal_distribution: {}
    };

    behaviorData.forEach(data => {
      const actionType = data.action_type.replace('ad_', '');
      breakdown.action_types[actionType] = (breakdown.action_types[actionType] || 0) + 1;
      
      if (data.interaction_quality) {
        const qualityRange = Math.floor(data.interaction_quality * 10) / 10;
        breakdown.quality_distribution[qualityRange] = (breakdown.quality_distribution[qualityRange] || 0) + 1;
      }
      
      const hour = new Date(data.timestamp).getHours();
      breakdown.temporal_distribution[hour] = (breakdown.temporal_distribution[hour] || 0) + 1;
    });

    return breakdown;
  }

  /**
   * 📈 Calculer les indicateurs de performance
   */
  calculatePerformanceIndicators(impressions, clicks, engagements, qualityScore) {
    const ctr = impressions > 0 ? clicks / impressions : 0;
    const engagementRate = impressions > 0 ? engagements / impressions : 0;
    
    // Score composite de performance
    const performanceScore = (ctr * 0.4 + engagementRate * 0.3 + qualityScore * 0.3);
    
    // Grade de performance
    let grade = 'F';
    if (performanceScore >= 0.8) grade = 'A+';
    else if (performanceScore >= 0.7) grade = 'A';
    else if (performanceScore >= 0.6) grade = 'B+';
    else if (performanceScore >= 0.5) grade = 'B';
    else if (performanceScore >= 0.4) grade = 'C+';
    else if (performanceScore >= 0.3) grade = 'C';
    else if (performanceScore >= 0.2) grade = 'D';

    return {
      performance_score: performanceScore,
      performance_grade: grade,
      ctr_percentile: this.calculatePercentile(ctr, 'ctr'),
      engagement_percentile: this.calculatePercentile(engagementRate, 'engagement'),
      quality_percentile: this.calculatePercentile(qualityScore, 'quality')
    };
  }

  /**
   * 📊 Calculer une tendance
   */
  calculateTrend(current, previous) {
    if (!previous || previous === 0) {
      return { direction: 'stable', percentage: 0 };
    }
    
    const percentage = ((current - previous) / previous) * 100;
    const direction = percentage > 5 ? 'increasing' : percentage < -5 ? 'decreasing' : 'stable';
    
    return { direction, percentage: Math.abs(percentage) };
  }

  /**
   * 📈 Analyser les patterns temporels
   */
  analyzeTemporalPatterns(hourlyMetrics) {
    const patterns = {
      peak_hour: null,
      low_hour: null,
      consistency_score: 0,
      optimal_posting_times: []
    };

    let maxActivity = 0;
    let minActivity = Infinity;
    let totalActivity = 0;
    let variance = 0;

    Object.entries(hourlyMetrics).forEach(([hour, data]) => {
      const activity = data.impressions + data.clicks + data.engagements;
      totalActivity += activity;
      
      if (activity > maxActivity) {
        maxActivity = activity;
        patterns.peak_hour = parseInt(hour);
      }
      
      if (activity < minActivity) {
        minActivity = activity;
        patterns.low_hour = parseInt(hour);
      }
    });

    const avgActivity = totalActivity / 24;
    
    // Calculer la variance pour la cohérence
    Object.values(hourlyMetrics).forEach(data => {
      const activity = data.impressions + data.clicks + data.engagements;
      variance += Math.pow(activity - avgActivity, 2);
    });
    
    patterns.consistency_score = 1 - (Math.sqrt(variance / 24) / avgActivity);
    
    // Identifier les heures optimales (top 3)
    const sortedHours = Object.entries(hourlyMetrics)
      .sort(([,a], [,b]) => (b.impressions + b.clicks + b.engagements) - (a.impressions + a.clicks + a.engagements))
      .slice(0, 3)
      .map(([hour]) => parseInt(hour));
    
    patterns.optimal_posting_times = sortedHours;

    return patterns;
  }

  /**
   * 📊 Analyser les tendances de performance
   */
  analyzePerformanceTrends(current, previous) {
    return {
      performance_direction: this.calculateTrend(
        current.performance_indicators?.performance_score || 0,
        previous.performance_indicators?.performance_score || 0
      ),
      efficiency_trend: this.calculateTrend(
        current.cost_metrics?.efficiency_score || 0,
        previous.cost_metrics?.efficiency_score || 0
      )
    };
  }

  /**
   * 📊 Calculer la tendance globale
   */
  calculateOverallTrend(trends) {
    const positiveTrends = Object.values(trends).filter(trend => trend.direction === 'increasing').length;
    const negativeTrends = Object.values(trends).filter(trend => trend.direction === 'decreasing').length;
    
    if (positiveTrends > negativeTrends) return 'improving';
    if (negativeTrends > positiveTrends) return 'declining';
    return 'stable';
  }

  /**
   * 🏆 Calculer la note de performance
   */
  calculatePerformanceGrade(metrics) {
    const score = metrics.performance_indicators?.performance_score || 0;
    
    if (score >= 0.8) return 'A+';
    if (score >= 0.7) return 'A';
    if (score >= 0.6) return 'B+';
    if (score >= 0.5) return 'B';
    if (score >= 0.4) return 'C+';
    if (score >= 0.3) return 'C';
    if (score >= 0.2) return 'D';
    return 'F';
  }

  /**
   * 📊 Obtenir la comparaison avec les benchmarks
   */
  async getBenchmarkComparison(advertisementId, metrics) {
    try {
      // Récupérer les benchmarks du marché (données simulées)
      const marketBenchmarks = {
        average_ctr: 0.025,
        average_engagement_rate: 0.08,
        average_quality_score: 0.65,
        average_cpc: 0.15
      };

      return {
        ctr_comparison: {
          current: metrics.click_through_rate,
          benchmark: marketBenchmarks.average_ctr,
          performance: metrics.click_through_rate > marketBenchmarks.average_ctr ? 'above' : 'below',
          difference_percentage: ((metrics.click_through_rate - marketBenchmarks.average_ctr) / marketBenchmarks.average_ctr) * 100
        },
        engagement_comparison: {
          current: metrics.engagement_rate,
          benchmark: marketBenchmarks.average_engagement_rate,
          performance: metrics.engagement_rate > marketBenchmarks.average_engagement_rate ? 'above' : 'below',
          difference_percentage: ((metrics.engagement_rate - marketBenchmarks.average_engagement_rate) / marketBenchmarks.average_engagement_rate) * 100
        },
        quality_comparison: {
          current: metrics.quality_score,
          benchmark: marketBenchmarks.average_quality_score,
          performance: metrics.quality_score > marketBenchmarks.average_quality_score ? 'above' : 'below',
          difference_percentage: ((metrics.quality_score - marketBenchmarks.average_quality_score) / marketBenchmarks.average_quality_score) * 100
        }
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la comparaison avec les benchmarks:', error);
      return {};
    }
  }

  // Méthodes utilitaires
  calculateEfficiencyScore(impressions, clicks, totalSpend) {
    if (totalSpend === 0) return 1.0;
    const ctr = impressions > 0 ? clicks / impressions : 0;
    return Math.min(1.0, ctr / (totalSpend / impressions));
  }

  calculatePercentile(value, metric) {
    // Logique simplifiée pour calculer le percentile
    const benchmarks = {
      ctr: { p50: 0.025, p75: 0.05, p90: 0.1 },
      engagement: { p50: 0.08, p75: 0.15, p90: 0.25 },
      quality: { p50: 0.65, p75: 0.8, p90: 0.9 }
    };
    
    const benchmark = benchmarks[metric];
    if (!benchmark) return 50;
    
    if (value >= benchmark.p90) return 90;
    if (value >= benchmark.p75) return 75;
    if (value >= benchmark.p50) return 50;
    return 25;
  }

  findPeakHour(hourlyMetrics) {
    let maxActivity = 0;
    let peakHour = null;
    
    Object.entries(hourlyMetrics).forEach(([hour, data]) => {
      const activity = data.impressions + data.clicks + data.engagements;
      if (activity > maxActivity) {
        maxActivity = activity;
        peakHour = parseInt(hour);
      }
    });
    
    return peakHour;
  }

  /**
   * ⚙️ Initialiser les seuils d'alerte par défaut
   */
  initializeDefaultAlertThresholds() {
    this.defaultThresholds = {
      ctr_minimum: 0.01,
      cpc_maximum: 0.5,
      budget_utilization_maximum: 0.8,
      quality_minimum: 0.5
    };
  }

  getDefaultThresholds() {
    return this.defaultThresholds;
  }

  /**
   * ⚙️ Configurer les seuils d'alerte pour une publicité
   */
  setAlertThresholds(advertisementId, thresholds) {
    this.alertThresholds.set(advertisementId, {
      ...this.getDefaultThresholds(),
      ...thresholds
    });
    logger.info(`⚙️ Seuils d'alerte configurés pour la publicité ${advertisementId}`);
  }

  /**
   * 🔄 Nettoyer le cache des analytics expirés
   */
  cleanupExpiredAnalytics() {
    const now = new Date();
    const maxAge = 10 * 60 * 1000; // 10 minutes

    for (const [key, cached] of this.analyticsCache.entries()) {
      if (now - cached.timestamp > maxAge) {
        this.analyticsCache.delete(key);
      }
    }
  }

  /**
   * 📊 Obtenir un résumé des performances globales
   */
  async getGlobalPerformanceSummary(timeWindow = 24) {
    try {
      const activeAds = await Advertisement.findAll({
        where: { status: 'active' },
        attributes: ['id', 'title', 'budget']
      });

      const summaries = await Promise.all(
        activeAds.map(ad => this.getRealTimeAnalytics(ad.id, timeWindow))
      );

      const globalMetrics = this.aggregateGlobalMetrics(summaries);

      return {
        time_window_hours: timeWindow,
        total_advertisements: activeAds.length,
        global_metrics: globalMetrics,
        top_performers: summaries
          .sort((a, b) => b.real_time_metrics.performance_indicators?.performance_score - a.real_time_metrics.performance_indicators?.performance_score)
          .slice(0, 5),
        alerts_summary: this.aggregateAlerts(summaries),
        last_updated: new Date()
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la génération du résumé global:', error);
      throw error;
    }
  }

  aggregateGlobalMetrics(summaries) {
    const totals = {
      impressions: 0,
      clicks: 0,
      engagements: 0,
      total_spend: 0
    };

    let totalQuality = 0;
    let qualityCount = 0;

    summaries.forEach(summary => {
      const metrics = summary.real_time_metrics;
      totals.impressions += metrics.impressions || 0;
      totals.clicks += metrics.clicks || 0;
      totals.engagements += metrics.engagements || 0;
      totals.total_spend += metrics.cost_metrics?.total_spend || 0;
      
      if (metrics.quality_score) {
        totalQuality += metrics.quality_score;
        qualityCount++;
      }
    });

    return {
      ...totals,
      average_ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : 0,
      average_engagement_rate: totals.impressions > 0 ? totals.engagements / totals.impressions : 0,
      average_quality_score: qualityCount > 0 ? totalQuality / qualityCount : 0,
      total_budget: summaries.reduce((sum, s) => sum + (s.real_time_metrics.cost_metrics?.remaining_budget || 0), 0)
    };
  }

  aggregateAlerts(summaries) {
    const alertCounts = {
      critical: 0,
      warning: 0,
      info: 0
    };

    summaries.forEach(summary => {
      summary.alerts?.forEach(alert => {
        alertCounts[alert.severity] = (alertCounts[alert.severity] || 0) + 1;
      });
    });

    return alertCounts;
  }
}

module.exports = new RealTimeAdAnalyticsService();
