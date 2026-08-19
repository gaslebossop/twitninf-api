const { DataTypes, Model } = require('sequelize');
const logger = require('../utils/logger');

class Advertisement extends Model {
  /**
   * AUDIT R1-04 (2026-08-19) : équivalent de `getAdStats()`/`getTotalSpent()`
   * pour un LOT de publicités — 3 requêtes groupées au lieu de 4 par
   * publicité (dont un `findByPk` redondant quand l'appelant a déjà les
   * instances en main). Retourne une Map id → { impressions, clicks,
   * engagements, spent, ctr, engagement_rate }.
   */
  static async statsForIds(advertisements = []) {
    const ids = advertisements.map((ad) => String(ad.id));
    const [impressionsMap, clicksMap, engagementsMap] = await Promise.all([
      this.sequelize.models.AdImpression.countByAdvertisementIds(ids),
      this.sequelize.models.AdClick.countByAdvertisementIds(ids),
      this.sequelize.models.AdEngagement.countByAdvertisementIds(ids),
    ]);

    const stats = new Map();
    for (const ad of advertisements) {
      const id = String(ad.id);
      const impressions = impressionsMap.get(id) || 0;
      const clicks = clicksMap.get(id) || 0;
      const engagements = engagementsMap.get(id) || 0;
      stats.set(id, {
        impressions,
        clicks,
        engagements,
        spent: impressions * ad.cost_per_impression,
        ctr: impressions > 0 ? (clicks / impressions * 100).toFixed(2) : 0,
        engagement_rate: impressions > 0 ? (engagements / impressions * 100).toFixed(2) : 0,
      });
    }
    return stats;
  }

  // Méthode pour obtenir les statistiques de la publicité
  async getAdStats() {
    const ad = this.toJSON();
    const stats = (await Advertisement.statsForIds([this])).get(String(this.id));

    return {
      ...ad,
      stats: {
        impressions: stats.impressions,
        clicks: stats.clicks,
        engagements: stats.engagements,
        ctr: stats.ctr,
        engagement_rate: stats.engagement_rate
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
