const { DataTypes, Model } = require('sequelize');

class Conversation extends Model {
  toJSON() {
    const { rewriteMediaUrl } = require('../utils/publicMediaOrigin');
    const values = { ...this.get() };
    if (values.avatar) values.avatar = rewriteMediaUrl(values.avatar);
    return values;
  }
}

const conversationSchema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  type: {
    type: DataTypes.ENUM('direct', 'group'),
    allowNull: false,
    defaultValue: 'direct'
  },
  title: {
    type: DataTypes.STRING(120),
    allowNull: true
  },
  avatar: {
    type: DataTypes.STRING(512),
    allowNull: true
  },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  is_archived: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {}
  }
};

const modelOptions = {
  modelName: 'Conversation',
  tableName: 'conversations',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['type'] },
    { fields: ['created_by'] },
    { fields: ['created_at'] }
  ]
};

function initConversationModel(sequelize) {
  Conversation.init(conversationSchema, {
    ...modelOptions,
    sequelize
  });
}

module.exports = Conversation;
module.exports.initConversationModel = initConversationModel;
