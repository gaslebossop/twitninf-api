const { DataTypes, Model } = require('sequelize');

/**
 * Vue d'une story par un utilisateur.
 *
 * L'index unique (story_id, viewer_id) est ce qui rend `POST /:id/view`
 * idempotent : le compteur `views_count` de la story n'est incrémenté que
 * lorsque la ligne vient réellement d'être créée.
 */
class StoryView extends Model {}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  story_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'stories',
      key: 'id'
    }
  },
  viewer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  reaction: {
    type: DataTypes.STRING(16),
    allowNull: true
  }
};

const options = {
  modelName: 'StoryView',
  tableName: 'story_views',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['story_id', 'viewer_id'] },
    { fields: ['viewer_id'] }
  ]
};

function initStoryViewModel(sequelize) {
  StoryView.init(schema, { ...options, sequelize });
  return StoryView;
}

module.exports = StoryView;
module.exports.initStoryViewModel = initStoryViewModel;
