const { DataTypes, Model } = require('sequelize');

/**
 * Un gagnant par jour calendaire (Europe/Paris) : le tweet ayant reçu le plus
 * de likes la veille, calculé une fois par nuit par `spotlightService`.
 *
 * `status: 'no_winner'` (plutôt que l'absence de ligne) distingue une nuit
 * sans gagnant légitime d'une nuit où le cron n'a simplement pas tourné.
 */
class DailySpotlight extends Model {
  static async getForDate(dateStr) {
    return this.findOne({ where: { spotlight_date: dateStr } });
  }
}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  spotlight_date: {
    type: DataTypes.DATEONLY,
    allowNull: false
  },
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'tweets',
      key: 'id'
    }
  },
  like_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  status: {
    type: DataTypes.ENUM('computed', 'no_winner'),
    allowNull: false
  },
  computed_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
};

const options = {
  modelName: 'DailySpotlight',
  tableName: 'daily_spotlights',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['spotlight_date'] },
    { fields: ['tweet_id'] }
  ]
};

function initDailySpotlightModel(sequelize) {
  DailySpotlight.init(schema, { ...options, sequelize });
  return DailySpotlight;
}

module.exports = DailySpotlight;
module.exports.initDailySpotlightModel = initDailySpotlightModel;
