const { DataTypes, Model } = require('sequelize');

/**
 * « Story à la une » : collection nommée, épinglée sur le profil, qui survit
 * à l'expiration 24 h des stories qu'elle contient (voir la purge dans
 * storyRoutes.js, qui épargne toute story référencée par une une).
 */
class StoryHighlight extends Model {}

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
  title: {
    type: DataTypes.STRING(40),
    allowNull: false,
    defaultValue: 'À la une'
  },
  /** Vignette : reprise d'une story de la collection, ou personnalisée. */
  cover_url: {
    type: DataTypes.STRING(768),
    allowNull: true
  },
  /** Ordre d'affichage sur le profil (croissant). */
  position: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  }
};

const options = {
  modelName: 'StoryHighlight',
  tableName: 'story_highlights',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id', 'position'] }
  ]
};

function initStoryHighlightModel(sequelize) {
  StoryHighlight.init(schema, { ...options, sequelize });
  return StoryHighlight;
}

module.exports = StoryHighlight;
module.exports.initStoryHighlightModel = initStoryHighlightModel;
