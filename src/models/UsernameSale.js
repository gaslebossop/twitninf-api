const { DataTypes } = require('sequelize');

/**
 * Vente conclue d'un pseudo : la trace de l'échange.
 *
 * Distincte de l'annonce parce qu'elle ne dit pas la même chose. L'annonce
 * décrit une intention, révocable ; la vente décrit un transfert de propriété
 * qui a déplacé de l'argent et changé l'identité publique de deux comptes.
 * Elle est écrite dans la même transaction que l'échange, et n'est jamais
 * modifiée ensuite.
 *
 * C'est aussi ce qui permet de répondre à « ce compte a-t-il toujours porté
 * ce pseudo ? » — la question que pose n'importe qui devant une arnaque.
 */

const UsernameSale = (sequelize) => sequelize.define('UsernameSale', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  listing_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'username_listings', key: 'id' },
  },
  username: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  seller_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  buyer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  /** Pseudo que l'acheteur portait avant : il est libéré par l'échange. */
  buyer_previous_username: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  /** Pseudo pris par le vendeur en échange. */
  seller_new_username: {
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
  platform_fee_twc: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: false,
  },
  seller_net_twc: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: false,
  },
  platform_fee_rate: {
    type: DataTypes.DECIMAL(6, 4),
    allowNull: false,
  },
  spend_transaction_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  payout_transaction_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
}, {
  tableName: 'username_sales',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['username'] },
    { fields: ['seller_id'] },
    { fields: ['buyer_id'] },
    { fields: ['created_at'] },
  ],
});

module.exports = UsernameSale;
