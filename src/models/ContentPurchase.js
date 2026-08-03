const { DataTypes } = require('sequelize');

/**
 * Achat d'un contenu à l'unité. C'est le titre d'accès de l'acheteur.
 *
 * Les montants sont recopiés ligne par ligne (prix, commission, net créateur)
 * plutôt que recalculés à la lecture : le taux de commission peut changer, le
 * prix du créateur aussi, et une facture qui bouge après coup n'est pas une
 * facture. Les identifiants des deux écritures du grand livre sont conservés
 * pour pouvoir remonter d'un achat contesté jusqu'aux mouvements réels.
 *
 * L'accès est définitif : pas de date d'expiration. Un accès qui expire
 * transformerait un achat à l'unité en location, ce qui n'est pas ce qui a
 * été vendu à l'acheteur au moment du clic.
 */

const ContentPurchase = (sequelize) => sequelize.define('ContentPurchase', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  paid_content_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'paid_contents', key: 'id' },
  },
  buyer_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  /** Recopié depuis le verrou : le créateur peut changer, la vente non. */
  creator_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
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
  creator_net_twc: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: false,
  },
  platform_fee_rate: {
    type: DataTypes.DECIMAL(6, 4),
    allowNull: false,
  },
  /** Écriture de débit de l'acheteur vers la trésorerie. */
  spend_transaction_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  /** Écriture de reversement de la trésorerie vers le créateur. */
  payout_transaction_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  /**
   * Remboursement — prévu dès la première version.
   *
   * Un contenu supprimé ou retiré par la modération après paiement laisse
   * sinon l'acheteur avec un débit et rien en face, et c'est le genre
   * d'incident qui coûte bien plus cher que la vente elle-même.
   */
  refunded_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  refund_reason: {
    type: DataTypes.STRING(160),
    allowNull: true,
  },
  refund_transaction_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
}, {
  tableName: 'content_purchases',
  timestamps: true,
  underscored: true,
  indexes: [
    // On n'achète pas deux fois le même contenu : la contrainte est en base,
    // pas seulement dans le service — deux clics simultanés passeraient.
    { unique: true, fields: ['paid_content_id', 'buyer_id'] },
    { fields: ['buyer_id', 'created_at'] },
    { fields: ['creator_id', 'created_at'] },
  ],
});

module.exports = ContentPurchase;
