const { DataTypes, Model } = require('sequelize');
const logger = require('../utils/logger');

class AdCampaign extends Model {
  // Méthode pour obtenir les statistiques de la campagne
  async getCampaignStats() {
    const campaign = this.toJSON();
    
    // Calculer les statistiques en temps réel
    const totalImpressions = await this.getTotalImpressions();
    const totalClicks = await this.getTotalClicks();
    const totalEngagements = await this.getTotalEngagements();
    const totalSpent = await this.getTotalSpent();
    
    return {
      ...campaign,
      stats: {
        total_impressions: totalImpressions,
        total_clicks: totalClicks,
        total_engagements: totalEngagements,
        total_spent: totalSpent,
        ctr: totalImpressions > 0 ? (totalClicks / totalImpressions * 100).toFixed(2) : 0,
        engagement_rate: totalImpressions > 0 ? (totalEngagements / totalImpressions * 100).toFixed(2) : 0,
        cost_per_impression: totalImpressions > 0 ? (totalSpent / totalImpressions).toFixed(4) : 0,
        cost_per_click: totalClicks > 0 ? (totalSpent / totalClicks).toFixed(4) : 0
      }
    };
  }

  // Méthode pour vérifier si une campagne est active
  isActive() {
    const now = new Date();
    return this.status === 'active' && 
           this.start_date <= now && 
           (this.end_date === null || this.end_date >= now);
  }

  // Méthode pour vérifier si le budget est épuisé
  async isBudgetExhausted() {
    const spent = await this.getTotalSpent();
    return spent >= this.total_budget;
  }

  // Méthode pour calculer le total dépensé
  async getTotalSpent() {
    const advertisements = await this.getAdvertisements();
    let totalSpent = 0;
    
    for (const ad of advertisements) {
      totalSpent += await ad.getTotalSpent();
    }
    
    return totalSpent;
  }

  // Méthode pour obtenir le budget restant
  async getRemainingBudget() {
    const spent = await this.getTotalSpent();
    return Math.max(0, this.total_budget - spent);
  }

  // Méthode pour obtenir le total d'impressions
  async getTotalImpressions() {
    const advertisements = await this.getAdvertisements();
    let totalImpressions = 0;
    
    for (const ad of advertisements) {
      totalImpressions += await ad.countImpressions();
    }
    
    return totalImpressions;
  }

  // Méthode pour obtenir le total de clics
  async getTotalClicks() {
    const advertisements = await this.getAdvertisements();
    let totalClicks = 0;
    
    for (const ad of advertisements) {
      totalClicks += await ad.countClicks();
    }
    
    return totalClicks;
  }

  // Méthode pour obtenir le total d'engagements
  async getTotalEngagements() {
    const advertisements = await this.getAdvertisements();
    let totalEngagements = 0;
    
    for (const ad of advertisements) {
      totalEngagements += await ad.countEngagements();
    }
    
    return totalEngagements;
  }

  // Méthode pour obtenir les publicités actives
  async getActiveAdvertisements() {
    return await this.getAdvertisements({
      where: {
        status: 'active'
      }
    });
  }

  // Méthode pour mettre en pause la campagne
  async pause() {
    this.status = 'paused';
    await this.save();
    
    // Mettre en pause toutes les publicités actives
    const activeAds = await this.getActiveAdvertisements();
    for (const ad of activeAds) {
      ad.status = 'paused';
      await ad.save();
    }
  }

  // Méthode pour reprendre la campagne
  async resume() {
    this.status = 'active';
    await this.save();
    
    // Reprendre toutes les publicités en pause
    const pausedAds = await this.getAdvertisements({
      where: {
        status: 'paused'
      }
    });
    
    for (const ad of pausedAds) {
      if (ad.isActive()) {
        ad.status = 'active';
        await ad.save();
      }
    }
  }
}

module.exports = (sequelize) => {
  AdCampaign.init({
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    objective: {
      type: DataTypes.ENUM('awareness', 'engagement', 'traffic', 'conversions'),
      allowNull: false,
      defaultValue: 'awareness'
    },
    total_budget: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false
    },
    daily_budget: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('draft', 'pending', 'active', 'paused', 'completed', 'cancelled'),
      allowNull: false,
      defaultValue: 'draft'
    },
    start_date: {
      type: DataTypes.DATE,
      allowNull: false
    },
    end_date: {
      type: DataTypes.DATE,
      allowNull: true
    },
    targeting_criteria: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    },
    performance_data: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    }
  }, {
    sequelize,
    modelName: 'AdCampaign',
    tableName: 'ad_campaigns',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['user_id']
      },
      {
        fields: ['status']
      },
      {
        fields: ['start_date', 'end_date']
      },
      {
        fields: ['status', 'start_date', 'end_date']
      }
    ]
  });

  return AdCampaign;
};
