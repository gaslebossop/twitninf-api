const { DataTypes } = require('sequelize');

/**
 * Pseudo mis en vente par son porteur.
 *
 * `replacement_username` est obligatoire et vérifié À LA MISE EN VENTE, pas à
 * l'achat : au moment où l'acheteur paie, le vendeur doit libérer son pseudo
 * instantanément, et il faut bien qu'il en porte un autre. Le demander à ce
 * moment-là voudrait dire soit bloquer la vente en attendant sa réponse, soit
 * lui attribuer d'autorité un identifiant qu'il n'a pas choisi.
 *
 * Le pseudo de repli est réservé dès la mise en vente (une ligne dans
 * `username_reservations` posée par le service) : sans réservation, quelqu'un
 * peut le prendre entre-temps et l'échange casse au pire moment, une fois
 * l'acheteur débité.
 */

const UsernameListing = (sequelize) => sequelize.define('UsernameListing', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  seller_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  /** Pseudo vendu, en minuscules — la comparaison ne doit pas dépendre de la casse. */
  username: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  /** Pseudo que le vendeur portera après la vente. */
  replacement_username: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  currency_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'virtual_currencies', key: 'id' },
  },
  price_twc: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('active', 'sold', 'canceled', 'invalid'),
    defaultValue: 'active',
  },
  /**
   * `invalid` couvre le cas où le vendeur a changé de pseudo par un autre
   * chemin après la mise en vente : l'annonce ne porte plus sur rien. On la
   * neutralise plutôt que de la supprimer, pour que l'acheteur qui l'avait en
   * favori comprenne ce qui s'est passé.
   */
  invalidated_reason: {
    type: DataTypes.STRING(160),
    allowNull: true,
  },
  sold_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  buyer_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  views_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
}, {
  tableName: 'username_listings',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['status', 'created_at'] },
    { fields: ['seller_id'] },
    { fields: ['username'] },
  ],
});

module.exports = UsernameListing;
