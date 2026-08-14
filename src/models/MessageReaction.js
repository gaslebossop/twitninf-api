const { DataTypes, Model } = require('sequelize');

/**
 * Une réaction (emoji) par utilisateur et par message — comme Instagram/
 * WhatsApp, choisir un nouvel emoji remplace le précédent au lieu de
 * s'additionner (contrainte unique sur message_id+user_id, voir `upsert` dans
 * messageRoutes.js).
 */
class MessageReaction extends Model {}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  message_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'messages',
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
  // 32 et non 8 : un emoji composé dépasse largement 8 caractères — une
  // famille « 👨‍👩‍👧‍👦 » en fait 11, un drapeau arc-en-ciel 6, une teinte de
  // peau 4. Avec 8, le sélecteur libre échouait en « value too long » côté
  // Postgres. Doit rester aligné sur MAX_EMOJI_LENGTH (utils/emoji).
  emoji: {
    type: DataTypes.STRING(32),
    allowNull: false
  }
};

const options = {
  modelName: 'MessageReaction',
  tableName: 'message_reactions',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['message_id', 'user_id'], unique: true },
    { fields: ['message_id'] }
  ]
};

function initMessageReactionModel(sequelize) {
  MessageReaction.init(schema, { ...options, sequelize });
  return MessageReaction;
}

module.exports = MessageReaction;
module.exports.initMessageReactionModel = initMessageReactionModel;
