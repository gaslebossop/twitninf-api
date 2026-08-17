/**
 * Place d'invitation à un événement : un billet nominatif, un code unique
 * signé, une entrée.
 *
 * ── Pourquoi une table à part, et pas une colonne sur `tw_events` ─────────
 * `tw_events` décrit un événement DANS l'application (une DA, des quêtes, une
 * période). Une place, elle, existe pour un événement RÉEL : une soirée, un
 * lancement, un plateau. Les deux peuvent se rejoindre — `event_slug` peut
 * reprendre le slug d'un `tw_event` — mais l'un ne dépend pas de l'autre :
 * on doit pouvoir imprimer des places pour une soirée dont l'application ne
 * sait rien, et un événement in-app n'a le plus souvent aucune place.
 * D'où un `event_slug` en texte, sans clé étrangère.
 *
 * ── Pourquoi l'événement est recopié sur chaque place ─────────────────────
 * `event_name`, `event_date` et `event_place` sont dénormalisés exprès. Une
 * place est un DOCUMENT : ce qui est imprimé dessus ne doit plus jamais
 * changer. Si l'horaire de la soirée bouge après l'envoi des invitations, les
 * places déjà distribuées gardent ce qui a été annoncé, et c'est le seul
 * comportement défendable devant quelqu'un qui se présente à la porte.
 *
 * ── Pourquoi du texte et pas des ENUM Postgres ────────────────────────────
 * `tier` et `status` sont des valeurs fermées, validées côté modèle. Le projet
 * a déjà payé le prix des vrais ENUM : chaque valeur ajoutée demande un
 * `ALTER TYPE` que `sync({ alter: false })` ne joue jamais, et la création
 * échoue en production avec « invalid input value for enum ».
 */

const { DataTypes } = require('sequelize');

const TIERS = ['standard', 'vip', 'staff', 'presse'];
const STATUSES = ['valid', 'used', 'revoked'];

module.exports = (sequelize) => {
  const EventPass = sequelize.define('EventPass', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    event_slug: {
      type: DataTypes.STRING(64),
      allowNull: false,
      comment: 'Identifiant de l\'événement (peut reprendre un slug tw_events)',
    },
    event_name: { type: DataTypes.STRING(120), allowNull: false },
    event_date: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Date affichée sur la place. Indicative : ne conditionne rien.',
    },
    event_place: { type: DataTypes.STRING(120), allowNull: true },

    code: {
      type: DataTypes.STRING(24),
      allowNull: false,
      unique: true,
      comment: 'Code lisible imprimé sur la place (NINF-XXXX-XXXX)',
    },
    serial: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Numéro de la place dans son événement, à partir de 1',
    },

    tier: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'standard',
      validate: { isIn: [TIERS] },
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'valid',
      validate: { isIn: [STATUSES] },
      comment: 'valid | used | revoked — fait foi à l\'entrée',
    },

    guest_name: { type: DataTypes.STRING(80), allowNull: true },
    guest_user_id: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Compte twitninf destinataire, si la place a été attribuée',
    },

    max_scans: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      comment: 'Nombre d\'entrées autorisées. 1 sauf laissez-passer d\'équipe.',
    },
    scans_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    first_scanned_at: { type: DataTypes.DATE, allowNull: true },
    last_scanned_at: { type: DataTypes.DATE, allowNull: true },
    scanned_by: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'Dernier compte ayant validé cette place à l\'entrée',
    },

    expires_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Au-delà, la place est refusée. NULL = pas d\'expiration.',
    },
    revoked_reason: { type: DataTypes.STRING(160), allowNull: true },
    note: {
      type: DataTypes.STRING(160),
      allowNull: true,
      comment: 'Note interne, jamais imprimée sur la place',
    },
    metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },

    created_by: { type: DataTypes.UUID, allowNull: true },
  }, {
    tableName: 'event_passes',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['code'], unique: true },
      // Deux places ne peuvent pas porter le même numéro dans le même
      // événement : c'est ce couple qu'on lit à voix haute à la porte.
      { fields: ['event_slug', 'serial'], unique: true },
      { fields: ['event_slug', 'status'] },
      { fields: ['guest_user_id'] },
    ],
  });

  /**
   * Peut-elle encore ouvrir la porte ? Cette méthode ne consomme rien : elle
   * répond sur l'état lu. La consommation, elle, se fait sous verrou dans
   * `eventPassService.redeem` — sans quoi deux téléphones qui scannent la même
   * place à une seconde d'intervalle la valideraient tous les deux.
   */
  EventPass.prototype.refusalReason = function refusalReason(now = new Date()) {
    if (this.status === 'revoked') return 'REVOKED';
    if (this.expires_at && new Date(this.expires_at) < now) return 'EXPIRED';
    if (this.scans_count >= this.max_scans) return 'ALREADY_USED';
    if (this.status === 'used') return 'ALREADY_USED';
    return null;
  };

  /** Ce que voit l'invité : sa place, jamais les notes internes. */
  EventPass.prototype.toPublicJSON = function toPublicJSON() {
    return {
      id: this.id,
      code: this.code,
      serial: this.serial,
      tier: this.tier,
      status: this.status,
      guest_name: this.guest_name,
      event_slug: this.event_slug,
      event_name: this.event_name,
      event_date: this.event_date,
      event_place: this.event_place,
      expires_at: this.expires_at,
      scans_count: this.scans_count,
      max_scans: this.max_scans,
      first_scanned_at: this.first_scanned_at,
    };
  };

  /** Vue de l'organisateur : tout, y compris ce qui ne s'imprime pas. */
  EventPass.prototype.toAdminJSON = function toAdminJSON() {
    return {
      ...this.toPublicJSON(),
      guest_user_id: this.guest_user_id,
      note: this.note,
      revoked_reason: this.revoked_reason,
      last_scanned_at: this.last_scanned_at,
      scanned_by: this.scanned_by,
      created_by: this.created_by,
      created_at: this.createdAt,
    };
  };

  EventPass.TIERS = TIERS;
  EventPass.STATUSES = STATUSES;

  return EventPass;
};
