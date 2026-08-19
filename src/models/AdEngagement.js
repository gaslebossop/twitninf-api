const { DataTypes, Model } = require('sequelize');

class AdEngagement extends Model {
  /** Pendant de `AdImpression.countByAdvertisementIds` — même contrat. */
  static async countByAdvertisementIds(advertisementIds = []) {
    const ids = [...new Set(advertisementIds.map(String))].filter(Boolean);
    if (ids.length === 0) return new Map();

    const rows = await this.findAll({
      where: { advertisement_id: ids },
      attributes: [
        'advertisement_id',
        [this.sequelize.fn('COUNT', this.sequelize.col('id')), 'count'],
      ],
      group: ['advertisement_id'],
      raw: true,
    });

    return new Map(rows.map((r) => [String(r.advertisement_id), Number(r.count) || 0]));
  }
}

module.exports = (sequelize) => {
  AdEngagement.init({
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    advertisement_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'advertisements',
        key: 'id'
      }
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    engagement_type: {
      type: DataTypes.ENUM('like', 'retweet', 'reply', 'share', 'bookmark'),
      allowNull: false
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    context: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {}
    }
  }, {
    sequelize,
    modelName: 'AdEngagement',
    tableName: 'ad_engagements',
    timestamps: false,
    underscored: true,
    indexes: [
      {
        fields: ['advertisement_id']
      },
      {
        fields: ['user_id']
      },
      {
        fields: ['engagement_type']
      },
      {
        fields: ['timestamp']
      },
      {
        fields: ['advertisement_id', 'user_id']
      }
    ]
  });

  return AdEngagement;
};
