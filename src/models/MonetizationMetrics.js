const { DataTypes, Model } = require('sequelize');
const logger = require('../utils/logger');

class MonetizationMetrics extends Model {
  // Méthode pour calculer le RPM (Revenue Per Mille) d'un tweet
  async calculateRPM() {
    const views = await this.getViews();
    const clicks = await this.getClicks();
    const revenue = await this.getRevenue();
    
    if (views === 0) return 0;
    
    // RPM = (Revenue / Views) * 1000
    return (revenue / views) * 1000;
  }

  // Méthode pour obtenir les vues d'un tweet
  async getViews() {
    const tweet = await this.sequelize.models.Tweet.findByPk(this.tweet_id);
    return await tweet.countViews();
  }

  // Méthode pour obtenir les clics éligibles
  async getClicks() {
    return this.eligible_clicks || 0;
  }

  // Méthode pour obtenir les revenus
  async getRevenue() {
    return this.revenue || 0;
  }

  // Méthode pour mettre à jour les métriques de monétisation
  async updateMetrics(metrics) {
    const { views, clicks, revenue } = metrics;
    
    this.views = views;
    this.eligible_clicks = clicks;
    this.revenue = revenue;
    this.rpm = await this.calculateRPM();
    this.last_updated = new Date();
    
    return await this.save();
  }

  // Méthode statique pour obtenir les tweets éligibles à la monétisation
  static async getEligibleTweets(userId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      minViews = 1000, // Minimum de vues pour être éligible
      minEngagement = 0.01 // Taux d'engagement minimum (1%)
    } = options;

    const { Op } = require('sequelize');

    // Récupérer les tweets avec leurs métriques de monétisation
    const tweets = await this.sequelize.models.Tweet.findAll({
      where: {
        user_id: userId,
        moderation_status: 'approved',
        deleted_at: null,
        is_private: false
      },
      include: [
        {
          model: this,
          as: 'monetizationMetrics',
          required: false
        },
        {
          model: this.sequelize.models.User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium']
        }
      ],
      order: [['created_at', 'DESC']],
      limit,
      offset
    });

    // Filtrer les tweets éligibles
    const eligibleTweets = [];
    
    for (const tweet of tweets) {
      const views = await tweet.countViews();
      const likes = await tweet.countLikes();
      const engagement = views > 0 ? likes / views : 0;
      
      // Vérifier les critères d'éligibilité
      if (views >= minViews && engagement >= minEngagement) {
        const metrics = tweet.monetizationMetrics || await this.create({
          tweet_id: tweet.id,
          views: views,
          eligible_clicks: 0,
          revenue: 0,
          rpm: 0,
          is_eligible: true
        });
        
        eligibleTweets.push({
          ...tweet.toJSON(),
          monetizationMetrics: metrics
        });
      }
    }

    return eligibleTweets;
  }

  // Méthode statique pour calculer les revenus totaux d'un utilisateur
  static async getUserTotalRevenue(userId, period = 'month') {
    const { Op } = require('sequelize');
    
    let dateFilter = {};
    const now = new Date();
    
    switch (period) {
      case 'day':
        dateFilter = {
          [Op.gte]: new Date(now.getFullYear(), now.getMonth(), now.getDate())
        };
        break;
      case 'week':
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        dateFilter = { [Op.gte]: weekAgo };
        break;
      case 'month':
        dateFilter = {
          [Op.gte]: new Date(now.getFullYear(), now.getMonth(), 1)
        };
        break;
      case 'year':
        dateFilter = {
          [Op.gte]: new Date(now.getFullYear(), 0, 1)
        };
        break;
      default:
        // Tous les temps
        break;
    }

    const metrics = await this.findAll({
      where: {
        ...dateFilter
      },
      include: [
        {
          model: this.sequelize.models.Tweet,
          as: 'tweet',
          where: { user_id: userId },
          attributes: []
        }
      ]
    });

    const totalRevenue = metrics.reduce((sum, metric) => sum + (metric.revenue || 0), 0);
    const totalViews = metrics.reduce((sum, metric) => sum + (metric.views || 0), 0);
    const totalClicks = metrics.reduce((sum, metric) => sum + (metric.eligible_clicks || 0), 0);
    const averageRPM = totalViews > 0 ? (totalRevenue / totalViews) * 1000 : 0;

    return {
      totalRevenue,
      totalViews,
      totalClicks,
      averageRPM,
      period,
      metricsCount: metrics.length
    };
  }

  // Méthode statique pour simuler des clics et revenus (pour les tests)
  static async simulateEngagement(tweetId) {
    const metric = await this.findOne({
      where: { tweet_id: tweetId }
    });

    if (!metric) return null;

    // Simulation de clics basée sur les vues
    const clickRate = Math.random() * 0.05; // 0-5% de taux de clic
    const newClicks = Math.floor(metric.views * clickRate);
    
    // Simulation de revenus (CPC moyen de 0.05€)
    const cpc = 0.05;
    const newRevenue = newClicks * cpc;
    
    // Mettre à jour les métriques
    metric.eligible_clicks = newClicks;
    metric.revenue = newRevenue;
    metric.rpm = await metric.calculateRPM();
    metric.last_updated = new Date();
    
    return await metric.save();
  }

  // Méthode statique pour initialiser le modèle
  static initMonetizationMetricsModel(sequelize) {
    return this.init({
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      tweet_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'tweets',
          key: 'id'
        }
      },
      views: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      eligible_clicks: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      revenue: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0.00
      },
      rpm: {
        type: DataTypes.DECIMAL(10, 4),
        defaultValue: 0.0000
      },
      is_eligible: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      last_updated: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
      }
    }, {
      sequelize,
      modelName: 'MonetizationMetrics',
      tableName: 'monetization_metrics',
      timestamps: true,
      indexes: [
        {
          fields: ['tweet_id']
        },
        {
          fields: ['is_eligible']
        },
        {
          fields: ['last_updated']
        }
      ]
    });
  }
}

module.exports = MonetizationMetrics;
