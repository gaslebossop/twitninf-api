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
  // Catégorie structurée (voir src/config/reportCategories.js).
  // Colonne TEXT et non ENUM Postgres : la table existe déjà en prod, un ENUM
  // serait à faire évoluer par ALTER TYPE à chaque nouvelle catégorie. La
  // validation des valeurs se fait côté applicatif.
  category: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Précision libre du signaleur — désormais FACULTATIVE (sauf catégorie
  // « other »). L'exiger était le principal frein au signalement.
  details: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Surface d'origine : permet de voir quel client génère quoi.
  source: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Fiabilité du signaleur AU MOMENT du signalement (figée : elle évoluera,
  // mais la décision prise ce jour-là doit rester auditable).
  reporter_weight: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  // Poids de ce signalement = gravité catégorie × fiabilité signaleur.
  weighted_score: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  // Score agrégé de la cible au moment de l'escalade.
  target_score: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  auto_escalated: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  escalated_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  escalation_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Date d'envoi de la notification de résolution au signaleur.
  reporter_notified_at: {
    type: DataTypes.DATE,
    allowNull: true
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
    },
    // File de modération : trier les signalements ouverts par priorité.
    {
      fields: ['status', 'priority']
    },
    {
      fields: ['category']
    }
  ]
});

module.exports = Report;
