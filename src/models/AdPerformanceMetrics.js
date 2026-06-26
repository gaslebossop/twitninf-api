/**
 * 📊 Modèle de Métriques de Performance Publicitaire Avancées
 * 
 * Stocke des métriques détaillées pour l'analyse et l'optimisation
 * des campagnes publicitaires
 */

const { DataTypes, Model } = require('sequelize');

class AdPerformanceMetrics extends Model {}

// Schema de la table
const adPerformanceMetricsSchema = {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  
  // Référence à la publicité
  advertisement_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'advertisements',
      key: 'id'
    }
  },
  
  // Période de mesure
  measurement_period: {
    type: DataTypes.ENUM('hourly', 'daily', 'weekly', 'monthly'),
    allowNull: false,
    defaultValue: 'daily'
  },
  
  period_start: {
    type: DataTypes.DATE,
    allowNull: false
  },
  
  period_end: {
    type: DataTypes.DATE,
    allowNull: false
  },
  
  // Métriques d'impression
  total_impressions: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  unique_impressions: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  impression_frequency: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0,
    comment: 'Fréquence moyenne d\'impression par utilisateur'
  },
  
  // Métriques de clic
  total_clicks: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  unique_clicks: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  click_through_rate: {
    type: DataTypes.DECIMAL(5, 4),
    defaultValue: 0,
    comment: 'Taux de clic (clics / impressions)'
  },
  
  // Métriques d'engagement
  total_engagements: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  engagement_rate: {
    type: DataTypes.DECIMAL(5, 4),
    defaultValue: 0,
    comment: 'Taux d\'engagement (engagements / impressions)'
  },
  
  likes_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  retweets_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  replies_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  shares_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  bookmarks_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  // Métriques de conversion
  conversions: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  
  conversion_rate: {
    type: DataTypes.DECIMAL(5, 4),
    defaultValue: 0,
    comment: 'Taux de conversion (conversions / clics)'
  },
  
  // Métriques financières
  total_spend: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
    comment: 'Dépense totale en TWC'
  },
  
  cost_per_impression: {
    type: DataTypes.DECIMAL(8, 4),
    defaultValue: 0,
    comment: 'Coût par impression'
  },
  
  cost_per_click: {
    type: DataTypes.DECIMAL(8, 4),
    defaultValue: 0,
    comment: 'Coût par clic'
  },
  
  cost_per_engagement: {
    type: DataTypes.DECIMAL(8, 4),
    defaultValue: 0,
    comment: 'Coût par engagement'
  },
  
  cost_per_conversion: {
    type: DataTypes.DECIMAL(8, 4),
    defaultValue: 0,
    comment: 'Coût par conversion'
  },
  
  return_on_ad_spend: {
    type: DataTypes.DECIMAL(8, 4),
    defaultValue: 0,
    comment: 'Retour sur investissement publicitaire'
  },
  
  // Métriques de qualité
  quality_score: {
    type: DataTypes.DECIMAL(3, 2),
    defaultValue: 0.5,
    comment: 'Score de qualité global (0-1)'
  },
  
  relevance_score: {
    type: DataTypes.DECIMAL(3, 2),
    defaultValue: 0.5,
    comment: 'Score de pertinence (0-1)'
  },
  
  user_satisfaction_score: {
    type: DataTypes.DECIMAL(3, 2),
    defaultValue: 0.5,
    comment: 'Score de satisfaction utilisateur (0-1)'
  },
  
  // Métriques comportementales
  average_time_on_ad: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: 'Temps moyen passé sur la publicité (ms)'
  },
  
  bounce_rate: {
    type: DataTypes.DECIMAL(5, 4),
    defaultValue: 0,
    comment: 'Taux de rebond'
  },
  
  scroll_depth: {
    type: DataTypes.DECIMAL(5, 4),
    defaultValue: 0,
    comment: 'Profondeur de scroll moyenne'
  },
  
  // Métriques démographiques
  age_distribution: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: 'Distribution par âge des utilisateurs'
  },
  
  gender_distribution: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: 'Distribution par genre'
  },
  
  location_distribution: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: 'Distribution géographique'
  },
  
  device_distribution: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: 'Distribution par type d\'appareil'
  },
  
  // Métriques temporelles
  hourly_performance: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: 'Performance par heure de la journée'
  },
  
  daily_performance: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: 'Performance par jour de la semaine'
  },
  
  // Métriques de ciblage
  targeting_accuracy: {
    type: DataTypes.DECIMAL(3, 2),
    defaultValue: 0.5,
    comment: 'Précision du ciblage (0-1)'
  },
  
  audience_overlap: {
    type: DataTypes.DECIMAL(3, 2),
    defaultValue: 0,
    comment: 'Chevauchement avec d\'autres campagnes'
  },
  
  // Métriques de concurrence
  competitive_position: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: 'Position concurrentielle'
  },
  
  market_share: {
    type: DataTypes.DECIMAL(5, 4),
    defaultValue: 0,
    comment: 'Part de marché dans la catégorie'
  },
  
  // Métriques d'optimisation
  optimization_opportunities: {
    type: DataTypes.JSON,
    defaultValue: [],
    comment: 'Opportunités d\'optimisation identifiées'
  },
  
  performance_trends: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: 'Tendances de performance'
  },
  
  // Métadonnées
  data_quality_score: {
    type: DataTypes.DECIMAL(3, 2),
    defaultValue: 1.0,
    comment: 'Score de qualité des données (0-1)'
  },
  
  last_updated: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  
  // Indicateurs de performance
  performance_grade: {
    type: DataTypes.ENUM('A+', 'A', 'B+', 'B', 'C+', 'C', 'D', 'F'),
    allowNull: true,
    comment: 'Note de performance globale'
  },
  
  status: {
    type: DataTypes.ENUM('active', 'paused', 'completed', 'optimizing'),
    defaultValue: 'active'
  }
};

// Options du modèle
const modelOptions = {
  tableName: 'ad_performance_metrics',
  timestamps: true,
  indexes: [
    {
      fields: ['advertisement_id', 'period_start', 'period_end']
    },
    {
      fields: ['measurement_period', 'period_start']
    },
    {
      fields: ['performance_grade']
    },
    {
      fields: ['quality_score']
    },
    {
      fields: ['click_through_rate']
    },
    {
      fields: ['engagement_rate']
    },
    {
      fields: ['cost_per_click']
    }
  ]
};

// Fonction pour initialiser le modèle avec sequelize
function initAdPerformanceMetricsModel(sequelize) {
  AdPerformanceMetrics.init(adPerformanceMetricsSchema, {
    ...modelOptions,
    sequelize
  });
}

// Méthodes d'instance
AdPerformanceMetrics.prototype.calculatePerformanceGrade = function() {
  const ctr = this.click_through_rate || 0;
  const engagement = this.engagement_rate || 0;
  const quality = this.quality_score || 0;
  const cost = this.cost_per_click || 0;
  
  // Calculer un score composite
  const compositeScore = (ctr * 0.3 + engagement * 0.3 + quality * 0.2 + (1 - Math.min(cost, 1)) * 0.2);
  
  // Convertir en note
  if (compositeScore >= 0.9) return 'A+';
  if (compositeScore >= 0.8) return 'A';
  if (compositeScore >= 0.7) return 'B+';
  if (compositeScore >= 0.6) return 'B';
  if (compositeScore >= 0.5) return 'C+';
  if (compositeScore >= 0.4) return 'C';
  if (compositeScore >= 0.3) return 'D';
  return 'F';
};

AdPerformanceMetrics.prototype.getOptimizationSuggestions = function() {
  const suggestions = [];
  
  if (this.click_through_rate < 0.02) {
    suggestions.push({
      type: 'ctr',
      priority: 'high',
      message: 'CTR faible - Améliorer le contenu créatif ou le ciblage',
      expected_improvement: '20-30%'
    });
  }
  
  if (this.engagement_rate < 0.05) {
    suggestions.push({
      type: 'engagement',
      priority: 'high',
      message: 'Engagement faible - Optimiser le contenu et les appels à l\'action',
      expected_improvement: '15-25%'
    });
  }
  
  if (this.cost_per_click > 0.5) {
    suggestions.push({
      type: 'cost',
      priority: 'medium',
      message: 'Coût par clic élevé - Ajuster les enchères ou améliorer la pertinence',
      expected_improvement: '10-20%'
    });
  }
  
  if (this.quality_score < 0.6) {
    suggestions.push({
      type: 'quality',
      priority: 'high',
      message: 'Score de qualité faible - Améliorer la pertinence du contenu',
      expected_improvement: '25-40%'
    });
  }
  
  return suggestions;
};

AdPerformanceMetrics.prototype.calculateROI = function(revenue = 0) {
  if (this.total_spend === 0) return 0;
  return (revenue - this.total_spend) / this.total_spend;
};

// Méthodes statiques
AdPerformanceMetrics.getTopPerformers = async function(limit = 10, timeWindow = 7) {
  const startDate = new Date(Date.now() - timeWindow * 24 * 60 * 60 * 1000);
  
  return await this.findAll({
    where: {
      period_start: { [require('sequelize').Op.gte]: startDate }
    },
    order: [['quality_score', 'DESC']],
    limit: limit
  });
};

AdPerformanceMetrics.getPerformanceTrends = async function(advertisementId, timeWindow = 30) {
  const startDate = new Date(Date.now() - timeWindow * 24 * 60 * 60 * 1000);
  
  return await this.findAll({
    where: {
      advertisement_id: advertisementId,
      period_start: { [require('sequelize').Op.gte]: startDate }
    },
    order: [['period_start', 'ASC']]
  });
};

AdPerformanceMetrics.calculateBenchmarks = async function(category = null) {
  const whereClause = category ? { category } : {};
  
  const metrics = await this.findAll({
    where: whereClause,
    attributes: [
      [require('sequelize').fn('AVG', require('sequelize').col('click_through_rate')), 'avg_ctr'],
      [require('sequelize').fn('AVG', require('sequelize').col('engagement_rate')), 'avg_engagement'],
      [require('sequelize').fn('AVG', require('sequelize').col('cost_per_click')), 'avg_cpc'],
      [require('sequelize').fn('AVG', require('sequelize').col('quality_score')), 'avg_quality'],
      [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'total_campaigns']
    ]
  });
  
  return metrics[0] || {};
};

// Associations
AdPerformanceMetrics.associate = (models) => {
  AdPerformanceMetrics.belongsTo(models.Advertisement, {
    foreignKey: 'advertisement_id',
    as: 'advertisement'
  });
};

module.exports = AdPerformanceMetrics;
module.exports.initAdPerformanceMetricsModel = initAdPerformanceMetricsModel;
module.exports.adPerformanceMetricsSchema = adPerformanceMetricsSchema;
module.exports.modelOptions = modelOptions;
