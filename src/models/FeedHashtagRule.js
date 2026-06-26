const { DataTypes } = require('sequelize');

/**
 * Règle de visibilité algorithmique par hashtag (pénalité ou boost sur le score).
 * tag_normalized : sans #, minuscules.
 */
const FeedHashtagRule = (sequelize) =>
  sequelize.define(
    'FeedHashtagRule',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tag_normalized: {
        type: DataTypes.STRING(200),
        allowNull: false,
        unique: true,
      },
      /** Multiplicateur sur le score (>1 = mise en avant, <1 = pénalité) */
      multiplier: {
        type: DataTypes.DOUBLE,
        allowNull: false,
      },
      note: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      tableName: 'feed_hashtag_rules',
      timestamps: true,
      underscored: true,
      indexes: [{ fields: ['tag_normalized'] }],
    }
  );

module.exports = FeedHashtagRule;
