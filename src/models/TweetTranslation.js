const { DataTypes, Model } = require('sequelize');

/**
 * Traduction générée par IA d'un tweet (fonctionnalité « Traduction bêta », Pro).
 *
 * Une ligne par couple (tweet, langue cible). L'index unique rend la génération
 * idempotente : relancer la traduction d'un tweet met à jour les lignes
 * existantes au lieu d'en empiler des doublons.
 *
 * Le texte source n'est PAS recopié ici : le tweet reste la seule source de
 * vérité du contenu original. Si l'auteur modifie son tweet, `source_hash`
 * permet de repérer les traductions devenues obsolètes sans les afficher à
 * tort comme fidèles.
 */
class TweetTranslation extends Model {}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'tweets',
      key: 'id'
    }
  },
  /** Code ISO 639-1 de la langue cible (ex. 'en', 'pt-BR' resterait hors périmètre) */
  language: {
    type: DataTypes.STRING(8),
    allowNull: false
  },
  /** Langue détectée/déclarée du tweet d'origine */
  source_language: {
    type: DataTypes.STRING(8),
    allowNull: true
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  /** Empreinte du texte source au moment de la traduction (voir en-tête) */
  source_hash: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  /** Fournisseur utilisé — 'codex' aujourd'hui, gardé explicite pour l'audit */
  provider: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'codex'
  },
  model: {
    type: DataTypes.STRING(64),
    allowNull: true
  }
};

const options = {
  modelName: 'TweetTranslation',
  tableName: 'tweet_translations',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['tweet_id', 'language'] },
    { fields: ['tweet_id'] }
  ]
};

function initTweetTranslationModel(sequelize) {
  TweetTranslation.init(schema, { ...options, sequelize });
  return TweetTranslation;
}

module.exports = TweetTranslation;
module.exports.initTweetTranslationModel = initTweetTranslationModel;
