const { DataTypes, Model } = require('sequelize');

class ConversationParticipant extends Model {}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  conversation_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'conversations',
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
  role: {
    type: DataTypes.ENUM('owner', 'admin', 'member'),
    allowNull: false,
    defaultValue: 'member'
  },
  last_read_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  is_muted: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
};

const options = {
  modelName: 'ConversationParticipant',
  tableName: 'conversation_participants',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['conversation_id', 'user_id'] },
    { fields: ['user_id'] },
    { fields: ['conversation_id'] }
  ]
};

function initConversationParticipantModel(sequelize) {
  ConversationParticipant.init(schema, {
    ...options,
    sequelize
  });
}

module.exports = ConversationParticipant;
module.exports.initConversationParticipantModel = initConversationParticipantModel;
