const { DataTypes } = require('sequelize');

const ModerationAction = (sequelize) => sequelize.define('ModerationAction', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  type: {
    type: DataTypes.ENUM('ban', 'suspend', 'delete', 'warn', 'approve', 'reject'),
    allowNull: false
  },
  target_type: {
    type: DataTypes.ENUM('user', 'tweet', 'comment'),
    allowNull: false
  },
  target_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  moderator_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  duration: {
    type: DataTypes.INTEGER, // en jours, null pour permanent
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('active', 'expired', 'reversed'),
    defaultValue: 'active'
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  reversed_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  reversed_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  reversal_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  metadata: {
    type: DataTypes.JSONB,
    allowNull: true
  }
}, {
  tableName: 'moderation_actions',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['type', 'status']
    },
    {
      fields: ['target_id', 'target_type']
    },
    {
      fields: ['moderator_id']
    },
    {
      fields: ['created_at']
    },
    {
      fields: ['expires_at']
    }
  ]
});

module.exports = ModerationAction;
