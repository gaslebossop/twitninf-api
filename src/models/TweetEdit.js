const { DataTypes } = require('sequelize');

/**
 * Version précédente d'un tweet modifié.
 *
 * Une ligne est écrite AVANT chaque modification, avec le texte tel qu'il
 * était. L'historique est donc complet sans avoir à toucher la table
 * `tweets` : le tweet ne porte que sa version courante, et le nombre
 * d'éditions se déduit du nombre de lignes ici.
 *
 * L'historique est PUBLIC, et c'est la condition qui rend l'édition
 * acceptable : sans lui, on peut faire dire n'importe quoi à un tweet que
 * mille personnes ont déjà retweeté. Avec lui, la modification est un fait
 * consultable, pas une réécriture silencieuse.
 */

const TweetEdit = (sequelize) => sequelize.define('TweetEdit', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tweet_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tweets', key: 'id' },
  },
  /**
   * Auteur de la modification. Aujourd'hui toujours l'auteur du tweet, mais
   * la colonne existe pour qu'une correction faite par le staff (contenu
   * illégal, données personnelles) reste distinguable dans l'historique.
   */
  edited_by: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  /** Numéro de version remplacée : 1 pour le texte d'origine. */
  revision: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  previous_content: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  new_content: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
}, {
  tableName: 'tweet_edits',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['tweet_id', 'revision'] },
    { fields: ['edited_by'] },
  ],
});

module.exports = TweetEdit;
