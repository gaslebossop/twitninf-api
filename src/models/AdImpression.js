const { DataTypes, Model } = require('sequelize');

class AdImpression extends Model {}

module.exports = (sequelize) => {
  AdImpression.init({
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
    modelName: 'AdImpression',
    tableName: 'ad_impressions',
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
        fields: ['timestamp']
      },
      {
        fields: ['advertisement_id', 'user_id']
      }
    ]
  });

  return AdImpression;
};
