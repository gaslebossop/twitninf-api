const { DataTypes } = require('sequelize');

/**
 * Trace d'une alerte « ton tweet décolle », pour ne la lever qu'une fois.
 *
 * Sans cette table, le job de détection préviendrait à chaque passage tant
 * que le tweet reste au-dessus du seuil — soit une notification toutes les
 * cinq minutes pendant des heures, exactement au moment où l'auteur est le
 * plus sollicité. La ligne est donc autant un enregistrement qu'un verrou.
 *
 * On garde la mesure qui a déclenché (rythme observé, rythme habituel) : sans
 * elle, impossible de savoir après coup si le seuil est bien réglé.
 */

const TweetVelocityAlert = (sequelize) => sequelize.define('TweetVelocityAlert', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tweets', key: 'id' },
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  /** Engagements cumulés au moment de l'alerte. */
  engagements: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  /** Engagements qu'un tweet ordinaire de ce compte atteint au même âge. */
  baseline: {
    type: DataTypes.DECIMAL(12, 3),
    allowNull: false,
  },
  /** engagements / baseline — le multiple annoncé à l'auteur. */
  ratio: {
    type: DataTypes.DECIMAL(10, 3),
    allowNull: false,
  },
  /** Âge du tweet à la détection, en minutes. */
  tweet_age_minutes: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
}, {
  tableName: 'tweet_velocity_alerts',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['tweet_id'] },
    { fields: ['user_id', 'created_at'] },
  ],
});

module.exports = TweetVelocityAlert;
