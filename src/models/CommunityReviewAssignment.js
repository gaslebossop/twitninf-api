const { DataTypes } = require('sequelize');

/**
 * L'attribution d'un item de revue à UNE personne du jury (BÊTA).
 *
 * Pourquoi une table plutôt que « le premier qui vote gagne » : sans
 * attribution, tout le monde recevait le même item dans le même ordre, les
 * mêmes trois personnes les plus rapides tranchaient l'essentiel de la file, et
 * les votes suivants se prenaient un 409 « revue déjà close » en pleine figure.
 * Le jury est maintenant désigné à l'avance — au plus `PANEL_SIZE` places par
 * item, une par personne, jamais reprise.
 *
 * L'unicité `(item_id, reviewer_id)` est ce qui garantit qu'un même contenu
 * n'est JAMAIS proposé deux fois à la même personne : la ligne subsiste même
 * après le vote et même après expiration, elle sert d'historique autant que de
 * réservation.
 */
const CommunityReviewAssignment = (sequelize) => sequelize.define('CommunityReviewAssignment', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  item_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  reviewer_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  /**
   * `pending`  place réservée, la personne n'a pas encore tranché
   * `voted`    elle a voté — la ligne devient de l'historique
   * `expired`  elle a laissé passer le délai : la PLACE est rendue aux autres,
   *            mais l'item ne lui sera jamais reproposé (voir l'unicité).
   */
  status: {
    type: DataTypes.ENUM('pending', 'voted', 'expired'),
    defaultValue: 'pending',
    allowNull: false
  },
  /**
   * Sans échéance, quelqu'un qui ouvre la page et ferme l'app immobiliserait
   * une place du jury indéfiniment, et l'item n'atteindrait jamais la majorité.
   */
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false
  }
}, {
  tableName: 'community_review_assignments',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { unique: true, fields: ['item_id', 'reviewer_id'] },
    { fields: ['reviewer_id', 'status'] },
    { fields: ['item_id', 'status'] },
    { fields: ['status', 'expires_at'] }
  ]
});

module.exports = CommunityReviewAssignment;
