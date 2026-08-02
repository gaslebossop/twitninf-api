const { DataTypes, Model } = require('sequelize');

/**
 * Story éphémère (24 h) façon Instagram.
 *
 * `expires_at` est stocké explicitement plutôt que recalculé depuis
 * `created_at` : la durée de vie peut varier (story épinglée, contenu
 * sponsorisé) et un index sur la colonne rend le filtrage du fil trivial.
 */
class Story extends Model {
  isExpired() {
    const expiresAt = this.expires_at ? new Date(this.expires_at).getTime() : 0;
    return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
  }
}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  media_url: {
    type: DataTypes.STRING(768),
    allowNull: false
  },
  media_type: {
    type: DataTypes.ENUM('image', 'video'),
    allowNull: false,
    defaultValue: 'image'
  },
  thumbnail_url: {
    type: DataTypes.STRING(768),
    allowNull: true
  },
  caption: {
    type: DataTypes.STRING(280),
    allowNull: true
  },
  // Durée d'affichage côté client (ms). Les images restent 5 s comme Instagram.
  duration_ms: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 5000
  },
  views_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  likes_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {}
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false
  },
  deleted_at: {
    type: DataTypes.DATE,
    allowNull: true
  }
};

const options = {
  modelName: 'Story',
  tableName: 'stories',
  timestamps: true,
  underscored: true,
  paranoid: true,
  indexes: [
    { fields: ['user_id', 'expires_at'] },
    { fields: ['expires_at'] },
    { fields: ['created_at'] },
    { fields: ['deleted_at'] }
  ]
};

function initStoryModel(sequelize) {
  Story.init(schema, { ...options, sequelize });
  return Story;
}

module.exports = Story;
module.exports.initStoryModel = initStoryModel;
