/**
 * Support prioritaire (palier Pro) — fils de discussion entre un utilisateur et
 * le support.
 *
 * `sequelize.sync({ force: false })` crée déjà ces tables au démarrage ; cette
 * migration existe pour les environnements où la synchronisation automatique
 * est désactivée, et pour documenter le schéma (même convention que
 * `20260731-create-sessions.js`).
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('support_tickets', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      subject: { type: Sequelize.STRING(160), allowNull: false },
      category: {
        type: Sequelize.ENUM('compte', 'abonnement', 'economie', 'moderation', 'bug', 'autre'),
        allowNull: false,
        defaultValue: 'autre',
      },
      status: {
        type: Sequelize.ENUM('open', 'pending', 'answered', 'resolved', 'closed'),
        allowNull: false,
        defaultValue: 'open',
      },
      // Figée à l'ouverture : un abonnement qui expire ne rétrograde pas un
      // ticket déjà en cours de traitement.
      priority: {
        type: Sequelize.ENUM('normal', 'high'),
        allowNull: false,
        defaultValue: 'normal',
      },
      opened_with_tier: { type: Sequelize.STRING(16), allowNull: true },
      assigned_to: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
      },
      last_message_at: { type: Sequelize.DATE, allowNull: true },
      unread_for_user: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      unread_for_staff: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      closed_at: { type: Sequelize.DATE, allowNull: true },
      metadata: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('support_tickets', ['user_id']);
    await queryInterface.addIndex('support_tickets', ['status']);
    await queryInterface.addIndex('support_tickets', ['assigned_to']);
    // File de travail du staff : prioritaires d'abord, plus anciens en tête.
    await queryInterface.addIndex('support_tickets', ['priority', 'status', 'last_message_at']);
    await queryInterface.addIndex('support_tickets', ['created_at']);

    await queryInterface.createTable('support_ticket_messages', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      ticket_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'support_tickets', key: 'id' },
        onDelete: 'CASCADE',
      },
      author_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      body: { type: Sequelize.TEXT, allowNull: false },
      // Écrit par le serveur depuis le rôle de l'auteur, jamais depuis le corps
      // de la requête — sinon on peut se fabriquer une fausse réponse officielle.
      is_staff: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_internal: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      attachments: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('support_ticket_messages', ['ticket_id', 'created_at']);
    await queryInterface.addIndex('support_ticket_messages', ['author_id']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('support_ticket_messages');
    await queryInterface.dropTable('support_tickets');
    // Les types ENUM survivent au dropTable sous Postgres : sans ça, rejouer la
    // migration échoue sur « type déjà existant ».
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_support_tickets_category";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_support_tickets_status";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_support_tickets_priority";');
  },
};
