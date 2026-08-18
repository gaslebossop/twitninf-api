const { DataTypes, Model } = require('sequelize');
const logger = require('../utils/logger');

class Advertisement extends Model {
  // Méthode pour obtenir les statistiques de la publicité
  async getAdStats() {
    const ad = this.toJSON();
    
    // Calculer les statistiques en temps réel
    const impressionCount = await this.countImpressions();
    const clickCount = await this.countClicks();
    const engagementCount = await this.countEngagements();
    
    return {
      ...ad,
      stats: {
        impressions: impressionCount,
        clicks: clickCount,
        engagements: engagementCount,
        ctr: clickCount > 0 ? (clickCount / impressionCount * 100).toFixed(2) : 0,
        engagement_rate: engagementCount > 0 ? (engagementCount / impressionCount * 100).toFixed(2) : 0
      }
    };
  }

  // Méthode pour vérifier si une publicité est active
  isActive() {
    const now = new Date();
    return this.status === 'active' && 
           this.start_date <= now && 
           (this.end_date === null || this.end_date >= now);
  }

  // Méthode pour vérifier si le budget est épuisé
  async isBudgetExhausted() {
    const spent = await this.getTotalSpent();
    return spent >= this.budget;
  }

  // Méthode pour calculer le total dépensé
  async getTotalSpent() {
    const impressions = await this.countImpressions();
    return impressions * this.cost_per_impression;
  }

  // Méthode pour obtenir le budget restant
  async getRemainingBudget() {
    const spent = await this.getTotalSpent();
    return Math.max(0, this.budget - spent);
  }

  // Méthode pour cibler un utilisateur spécifique
  async canTargetUser(userId) {
    if (!this.isActive()) return false;
    if (await this.isBudgetExhausted()) return false;

    // Vérifier les critères de ciblage
    const targeting = await this.getTargeting();
    if (!targeting) return true; // Pas de ciblage spécifique

    // Logique de ciblage basée sur les critères
    return await targeting.matchesUser(userId);
  }

  // Méthode pour enregistrer une impression
  async recordImpression(userId) {
    try {
      await this.sequelize.models.AdImpression.create({
        advertisement_id: this.id,
        user_id: userId,
        timestamp: new Date()
      });
    } catch (error) {
      logger.error('Erreur lors de l\'enregistrement de l\'impression:', error);
    }
  }

  // Méthode pour enregistrer un clic
  async recordClick(userId) {
    try {
      await this.sequelize.models.AdClick.create({
        advertisement_id: this.id,
        user_id: userId,
        timestamp: new Date()
      });
    } catch (error) {
      logger.error('Erreur lors de l\'enregistrement du clic:', error);
    }
  }

  // Méthode pour enregistrer un engagement
  async recordEngagement(userId, engagementType) {
    try {
      await this.sequelize.models.AdEngagement.create({
        advertisement_id: this.id,
        user_id: userId,
        engagement_type: engagementType,
        timestamp: new Date()
      });
    } catch (error) {
      logger.error('Erreur lors de l\'enregistrement de l\'engagement:', error);
    }
  }
}

module.exports = (sequelize) => {
  Advertisement.init({
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
    // Une publicité désigne SOIT un tweet, SOIT un compte — d'où les deux
    // colonnes nullables et `target_type` qui dit laquelle fait foi. `tweet_id`
    // était NOT NULL : promouvoir un compte était impossible par construction,
    // pas par choix de produit.
    target_type: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'tweet',
      validate: { isIn: [['tweet', 'profile']] }
    },
    tweet_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'tweets',
        key: 'id'
      }
    },
    /** Compte promu quand `target_type = 'profile'`. */
    target_user_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    campaign_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'ad_campaigns',
        key: 'id'
      }
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    budget: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0.00
    },
    cost_per_impression: {
      type: DataTypes.DECIMAL(8, 4),
      allowNull: false,
      defaultValue: 0.10
    },
    cost_per_click: {
      type: DataTypes.DECIMAL(8, 4),
      allowNull: false,
      defaultValue: 0.10
    },
    cost_per_engagement: {
      type: DataTypes.DECIMAL(8, 4),
      allowNull: true,
      defaultValue: 0.05
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
    max_impressions_per_day: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    max_impressions_per_user: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 1
    },
    targeting_criteria: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    },
    creative_data: {
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
    modelName: 'Advertisement',
    tableName: 'advertisements',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['user_id']
      },
      {
        fields: ['tweet_id']
      },
      {
        fields: ['target_user_id']
      },
      {
        fields: ['campaign_id']
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

  return Advertisement;
};
