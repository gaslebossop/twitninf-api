/**
 * Journal des passages à l'entrée — les admissions ET les refus.
 *
 * ── Pourquoi journaliser les refus ────────────────────────────────────────
 * `event_passes.scans_count` dit qu'une place est entrée. Il ne dit pas qu'on
 * a essayé de la faire entrer trois fois de plus, ni qu'un code inventé a été
 * présenté douze fois de suite. À une porte, ce sont précisément ces
 * tentatives-là qu'on veut voir : elles arrivent au moment où quelqu'un
 * discute avec l'équipe, pas après coup dans un rapport.
 *
 * ── Pourquoi `pass_id` est nullable ───────────────────────────────────────
 * Un code inconnu ou mal signé ne correspond à aucune place. C'est justement
 * la ligne la plus intéressante du journal : on garde le code présenté tel
 * quel, tronqué, sans qu'il pointe vers quoi que ce soit.
 */

const { DataTypes } = require('sequelize');

const RESULTS = [
  'admitted',       // entrée validée
  'already_used',   // place déjà passée
  'revoked',        // place annulée par l'organisation
  'expired',        // hors fenêtre
  'bad_signature',  // code fabriqué ou abîmé
  'unknown',        // code bien formé mais inconnu
  'wrong_event',    // place valide, mais pour un autre événement
];

module.exports = (sequelize) => {
  const EventPassScan = sequelize.define('EventPassScan', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    pass_id: { type: DataTypes.UUID, allowNull: true },
    event_slug: { type: DataTypes.STRING(64), allowNull: true },
    code_attempt: {
      type: DataTypes.STRING(48),
      allowNull: true,
      comment: 'Ce qui a été présenté, tronqué — sert à reconnaître une série',
    },
    result: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: { isIn: [RESULTS] },
    },
    scanned_by: { type: DataTypes.UUID, allowNull: true },
    device_label: {
      type: DataTypes.STRING(60),
      allowNull: true,
      comment: 'Poste de contrôle, saisi par l\'équipe (« Entrée principale »)',
    },
  }, {
    tableName: 'event_pass_scans',
    timestamps: true,
    underscored: true,
    updatedAt: false,
    indexes: [
      { fields: ['event_slug', 'created_at'] },
      { fields: ['pass_id'] },
      { fields: ['result'] },
    ],
  });

  EventPassScan.RESULTS = RESULTS;

  return EventPassScan;
};
