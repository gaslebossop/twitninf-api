const { DataTypes } = require('sequelize');

/**
 * Compte suspecté de copier un abonné (pseudo, photo ou bio).
 *
 * Une alerte n'est PAS une sanction : elle n'affecte ni la visibilité ni le
 * statut du compte signalé. C'est un rapport adressé à la personne copiée,
 * qui décide. Un système qui restreindrait automatiquement sur ressemblance
 * de pseudo frapperait surtout des homonymes de bonne foi.
 *
 * `dismissed_at` est ce qui empêche la fonctionnalité de devenir insupportable :
 * une alerte écartée ne revient jamais, même si le scan la retrouve.
 */

const ImpersonationAlert = (sequelize) => sequelize.define('ImpersonationAlert', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  /** Compte protégé, destinataire de l'alerte. */
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  /** Compte suspect. */
  suspect_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  /**
   * Ce qui a déclenché : pseudo proche, avatar identique, bio recopiée.
   * Plusieurs motifs peuvent s'accumuler sur une même alerte — c'est la
   * combinaison qui fait la gravité, pas un motif isolé.
   */
  reasons: {
    type: DataTypes.JSONB,
    defaultValue: [],
  },
  /** Score global 0–1, sert au tri de la liste. */
  score: {
    type: DataTypes.DECIMAL(4, 3),
    allowNull: false,
  },
  /** Pseudo du suspect au moment de la détection — il peut en changer ensuite. */
  suspect_username_at_detection: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('open', 'reported', 'dismissed'),
    defaultValue: 'open',
  },
  /** Signalement déposé depuis l'alerte, pour ne pas en créer deux. */
  report_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  dismissed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  notified_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'impersonation_alerts',
  timestamps: true,
  underscored: true,
  indexes: [
    // Un couple (protégé, suspect) ne donne qu'une alerte, jamais une par scan.
    { unique: true, fields: ['user_id', 'suspect_id'] },
    { fields: ['user_id', 'status'] },
  ],
});

module.exports = ImpersonationAlert;
