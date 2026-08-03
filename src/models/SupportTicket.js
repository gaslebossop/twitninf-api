const { DataTypes } = require('sequelize');

/**
 * Ticket de support — accès direct au support, avantage du palier Pro.
 *
 * Distinct de `UnbanTicket`, qui traite un cas unique (contester un bannissement)
 * avec son propre circuit de décision. Ici c'est un fil de discussion ouvert :
 * question, bug, problème de paiement, signalement d'un compte.
 *
 * `priority` est figée À LA CRÉATION à partir du palier de l'auteur, et n'est
 * pas relue depuis l'utilisateur ensuite : un abonné qui ouvre un ticket puis
 * laisse expirer son abonnement garde le traitement prioritaire sur CE ticket.
 * L'inverse — rétrograder un ticket en cours de traitement — reviendrait à
 * reprendre un avantage déjà payé.
 */

const SupportTicket = (sequelize) => sequelize.define('SupportTicket', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  subject: {
    type: DataTypes.STRING(160),
    allowNull: false,
    validate: { len: [3, 160] },
  },
  category: {
    type: DataTypes.ENUM(
      'compte',        // connexion, profil, sécurité
      'abonnement',    // facturation, palier, expiration
      'economie',      // NF, portefeuille, virements
      'moderation',    // décision de modération contestée
      'bug',
      'autre',
    ),
    defaultValue: 'autre',
  },
  status: {
    type: DataTypes.ENUM(
      'open',      // ouvert, personne ne l'a encore pris
      'pending',   // le support attend une réponse de l'utilisateur
      'answered',  // le support a répondu
      'resolved',
      'closed',
    ),
    defaultValue: 'open',
  },
  /** `high` pour un abonné Pro — c'est tout l'objet de l'avantage. */
  priority: {
    type: DataTypes.ENUM('normal', 'high'),
    defaultValue: 'normal',
  },
  /** Palier au moment de l'ouverture, conservé pour l'audit de l'avantage. */
  opened_with_tier: {
    type: DataTypes.STRING(16),
    allowNull: true,
  },
  assigned_to: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  /** Tri de la file côté staff sans avoir à agréger les messages. */
  last_message_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  /** Pastilles « non lu » de part et d'autre, sans relire tout le fil. */
  unread_for_user: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  unread_for_staff: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  closed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  /** Contexte technique joint à l'ouverture (version de l'app, plateforme). */
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
}, {
  tableName: 'support_tickets',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['status'] },
    { fields: ['assigned_to'] },
    // La file de travail du staff : les prioritaires d'abord, les plus vieux en tête.
    { fields: ['priority', 'status', 'last_message_at'] },
    { fields: ['created_at'] },
  ],
});

module.exports = SupportTicket;
