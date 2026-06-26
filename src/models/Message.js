const { DataTypes, Model } = require('sequelize');

class Message extends Model {}

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
  sender_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: {
      len: [1, 3000]
    }
  },
  message_type: {
    type: DataTypes.ENUM('text', 'system'),
    allowNull: false,
    defaultValue: 'text'
  },
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {}
  },
  deleted_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
};

const options = {
  modelName: 'Message',
  tableName: 'messages',
  timestamps: true,
  underscored: true,
  paranoid: true,
  indexes: [
    { fields: ['conversation_id', 'created_at'] },
    { fields: ['sender_id'] },
    { fields: ['deleted_at'] }
  ]
};

function initMessageModel(sequelize) {
  Message.init(schema, {
    ...options,
    sequelize
  });
}

module.exports = Message;
module.exports.initMessageModel = initMessageModel;
