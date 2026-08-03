const { DataTypes } = require('sequelize');

/**
 * Visite d'un profil, agrégée par (visiteur, visité, jour).
 *
 * L'agrégation n'est pas une optimisation, c'est la règle de vie privée : on
 * enregistre QUI est passé, pas combien de fois ni à quelle heure. Un journal
 * horodaté de chaque ouverture de profil dirait à un abonné à quel moment
 * précis quelqu'un pense à lui — ce n'est pas la fonctionnalité vendue, et ce
 * n'est pas une donnée qu'on veut détenir.
 *
 * `viewer_hidden` porte la contrepartie : un abonné peut consulter sans
 * laisser de trace. La visite est quand même écrite (elle sert aux compteurs
 * agrégés) mais l'identité n'est jamais restituée.
 */

const ProfileView = (sequelize) => sequelize.define('ProfileView', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  /** Profil consulté. */
  profile_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  viewer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  /** Jour de la visite (minuit UTC) — la clé d'agrégation. */
  viewed_on: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  /** Nombre de passages ce jour-là ; jamais restitué au visité. */
  view_count: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
  },
  /** Visite en mode discret : comptée, jamais nommée. */
  viewer_hidden: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  /** Palier du visiteur au moment de la visite, pour l'audit du mode discret. */
  viewer_tier: {
    type: DataTypes.STRING(16),
    allowNull: true,
  },
}, {
  tableName: 'profile_views',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['profile_id', 'viewer_id', 'viewed_on'] },
    // La restitution : les visites d'un profil, les plus récentes d'abord.
    { fields: ['profile_id', 'viewed_on'] },
    // La purge de rétention.
    { fields: ['viewed_on'] },
  ],
});

module.exports = ProfileView;
