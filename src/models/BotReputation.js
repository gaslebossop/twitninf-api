const { DataTypes, Model } = require('sequelize');

class BotReputation extends Model {
  static initBotReputationModel(sequelize) {
    return super.init({
      user_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      last_score: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      avg_score_30d: {
        type: DataTypes.FLOAT,
        defaultValue: 0
      },
      trust_level: {
        type: DataTypes.ENUM('safe', 'suspicious', 'bot'),
        defaultValue: 'safe'
      },
      updated_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
      }
    }, {
      sequelize,
      modelName: 'BotReputation',
      tableName: 'bot_reputations',
      timestamps: false, // On gère updated_at manuellement ou via Sequelize
      underscored: true
    });
  }
}

module.exports = BotReputation;
