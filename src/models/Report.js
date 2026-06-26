const { DataTypes } = require('sequelize');

const Report = (sequelize) => sequelize.define('Report', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  type: {
    type: DataTypes.ENUM('tweet', 'user', 'comment'),
    allowNull: false
  },
  reporter_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  target_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  target_type: {
    type: DataTypes.ENUM('tweet', 'user', 'comment'),
    allowNull: false
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  severity: {
    type: DataTypes.ENUM('low', 'medium', 'high', 'critical'),
    defaultValue: 'medium'
  },
  status: {
    type: DataTypes.ENUM('pending', 'investigating', 'resolved', 'dismissed'),
    defaultValue: 'pending'
  },
  priority: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  moderator_notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  resolved_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  resolved_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  resolution_action: {
    type: DataTypes.ENUM('none', 'warn', 'suspend', 'ban', 'delete'),
    allowNull: true
  },
  resolution_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'reports',
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
      fields: ['reporter_id']
    },
    {
      fields: ['severity']
    },
    {
      fields: ['created_at']
    }
  ]
});

module.exports = Report;
