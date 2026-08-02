const { DataTypes, Model } = require('sequelize');

/** Appartenance d'une story à une « une », avec son rang de lecture. */
class StoryHighlightItem extends Model {}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  highlight_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'story_highlights',
      key: 'id'
    }
  },
  story_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'stories',
      key: 'id'
    }
  },
  position: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  }
};

const options = {
  modelName: 'StoryHighlightItem',
  tableName: 'story_highlight_items',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['highlight_id', 'story_id'] },
    { fields: ['story_id'] }
  ]
};

function initStoryHighlightItemModel(sequelize) {
  StoryHighlightItem.init(schema, { ...options, sequelize });
  return StoryHighlightItem;
}

module.exports = StoryHighlightItem;
module.exports.initStoryHighlightItemModel = initStoryHighlightItemModel;
