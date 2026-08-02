const { DataTypes } = require('sequelize');

/**
 * Le vote d'une personne sur un item de revue communautaire (BÊTA).
 *
 * L'unicité (item, votant) est portée par un index UNIQUE en base et pas
 * seulement par une vérification applicative : deux requêtes simultanées
 * passeraient toutes les deux le test « a-t-il déjà voté ? » avant que l'une
 * n'ait écrit. C'est la base qui tranche, le code se contente de rattraper
 * l'erreur d'unicité.
 */
const CommunityReviewVote = (sequelize) => sequelize.define('CommunityReviewVote', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  item_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  voter_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  verdict: {
    type: DataTypes.ENUM('compliant', 'violation'),
    allowNull: false
  },
  /**
   * ⚠ HISTORIQUE — plus jamais alimentée depuis la suppression du questionnaire
   * de gravité. Le juré tranche conforme / non conforme et rien d'autre ; le
   * palier de sanction est choisi ensuite par un modèle arbitre sur le seul
   * texte (voir `communityReviewAdjudicator`).
   *
   * La colonne est conservée parce que les lignes antérieures portent de vraies
   * réponses (`{ motif, gravite }`, ou l'encore plus ancienne forme à dix
   * booléens) : ce sont elles qui expliquent les sanctions déjà exécutées, les
   * effacer détruirait la traçabilité de dossiers clos.
   */
  severity_answers: {
    type: DataTypes.JSONB,
    allowNull: true
  }
}, {
  tableName: 'community_review_votes',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { unique: true, fields: ['item_id', 'voter_id'] },
    { fields: ['voter_id'] }
  ]
});

module.exports = CommunityReviewVote;
