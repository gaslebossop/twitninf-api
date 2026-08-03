const { DataTypes } = require('sequelize');

/**
 * Un message dans un fil de support.
 *
 * `is_staff` est écrit par le serveur à partir du rôle de l'auteur au moment de
 * l'envoi, jamais depuis le corps de la requête : sans ça, n'importe quel
 * utilisateur pourrait poster un message qui s'affiche comme une réponse
 * officielle du support dans son propre fil, capture d'écran à l'appui.
 */

const SupportTicketMessage = (sequelize) => sequelize.define('SupportTicketMessage', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  ticket_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'support_tickets', key: 'id' },
    onDelete: 'CASCADE',
  },
  author_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: { len: [1, 4000] },
  },
  is_staff: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  /**
   * Note interne : visible du staff uniquement. Le filtrage se fait dans la
   * requête côté utilisateur (`is_internal: false`), pas à l'affichage — une
   * note interne ne doit jamais transiter jusqu'au client.
   */
  is_internal: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  attachments: {
    type: DataTypes.JSONB,
    defaultValue: [],
  },
}, {
  tableName: 'support_ticket_messages',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['ticket_id', 'created_at'] },
    { fields: ['author_id'] },
  ],
});

module.exports = SupportTicketMessage;
