const { DataTypes, Model } = require('sequelize');

/**
 * Une réaction (emoji) par utilisateur et par message — comme Instagram/
 * WhatsApp, choisir un nouvel emoji remplace le précédent au lieu de
 * s'additionner (contrainte unique sur message_id+user_id, voir `upsert` dans
 * messageRoutes.js).
 */
class MessageReaction extends Model {}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  message_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'messages',
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
  emoji: {
    type: DataTypes.STRING(8),
    allowNull: false
  }
};

const options = {
  modelName: 'MessageReaction',
  tableName: 'message_reactions',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['message_id', 'user_id'], unique: true },
    { fields: ['message_id'] }
  ]
};

function initMessageReactionModel(sequelize) {
  MessageReaction.init(schema, { ...options, sequelize });
  return MessageReaction;
}

module.exports = MessageReaction;
module.exports.initMessageReactionModel = initMessageReactionModel;
