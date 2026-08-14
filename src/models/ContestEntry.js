const { DataTypes, Model } = require('sequelize');

/**
 * Participation d'un utilisateur à un concours.
 *
 * ── Pourquoi l'éligibilité est réévaluée au tirage ───────────────────────
 * Les conditions sont vérifiées une première fois à l'inscription, pour
 * refuser tout de suite quelqu'un qui n'a pas encore aimé le tweet et lui
 * dire quoi faire. Mais rien n'empêche de tout cocher, de participer, puis de
 * se désabonner dans la foulée. Le statut reste donc `pending` jusqu'au
 * tirage, où tout est recontrôlé : c'est l'état AU MOMENT DU TIRAGE qui
 * décide, pas celui au moment du clic.
 *
 * `rejected_reason` garde la raison en clair pour que le participant sache
 * pourquoi il n'était pas dans la liste finale, plutôt que de disparaître
 * sans explication.
 */
class ContestEntry extends Model {}

const schema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  contest_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'contests', key: 'id' }
  },

  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' }
  },

  status: {
    type: DataTypes.ENUM('pending', 'eligible', 'rejected'),
    allowNull: false,
    defaultValue: 'pending'
  },

  rejected_reason: {
    type: DataTypes.STRING(80),
    allowNull: true
  },

  is_winner: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },

  // Rang du gagnant (1 = premier tiré). Nul pour les non-gagnants.
  rank: {
    type: DataTypes.INTEGER,
    allowNull: true
  },

  entered_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
};

const options = {
  modelName: 'ContestEntry',
  tableName: 'contest_entries',
  timestamps: true,
  underscored: true,
  indexes: [
    // Une seule participation par personne : la contrainte vit en base, pas
    // dans le contrôleur — deux requêtes simultanées passeraient un simple
    // `findOne` avant insertion.
    { unique: true, fields: ['contest_id', 'user_id'] },
    { fields: ['contest_id', 'is_winner'] },
    { fields: ['user_id'] }
  ]
};

function initContestEntryModel(sequelize) {
  ContestEntry.init(schema, { ...options, sequelize });
  return ContestEntry;
}

module.exports = ContestEntry;
module.exports.initContestEntryModel = initContestEntryModel;
