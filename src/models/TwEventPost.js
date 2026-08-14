/**
 * Le livre d'or d'un événement.
 *
 * ── Pourquoi ça existe ────────────────────────────────────────────────────
 * Une page d'événement qui ne contient qu'une liste de quêtes est une liste de
 * corvées : on la remplit une fois, on n'y revient pas. Le livre d'or est la
 * seule partie de l'événement qui soit du CONTENU — écrit par les gens, lu par
 * les gens, différent à chaque visite. C'est ce qui fait revenir.
 *
 * Un message par compte et par événement : l'index unique le garantit. Sans
 * lui, la page deviendrait un fil de discussion, avec la modération et le
 * spam qui vont avec — pour un événement qui dure huit jours, c'est un coût
 * qu'on ne veut pas.
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const TwEventPost = sequelize.define('TwEventPost', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    event_slug: { type: DataTypes.STRING(64), allowNull: false },
    message: {
      type: DataTypes.STRING(280),
      allowNull: false,
      comment: 'Le mot laissé. Longueur d\'un tweet, volontairement.',
    },
    hidden: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Masqué par la modération, sans être supprimé.',
    },
  }, {
    tableName: 'tw_event_posts',
    timestamps: true,
    underscored: true,
    indexes: [
      // Un mot par compte et par événement.
      {
        fields: ['user_id', 'event_slug'],
        unique: true,
        name: 'tw_event_posts_unique',
      },
      // La lecture du livre : les derniers d'abord.
      { fields: ['event_slug', 'hidden', 'created_at'] },
    ],
  });

  return TwEventPost;
};
