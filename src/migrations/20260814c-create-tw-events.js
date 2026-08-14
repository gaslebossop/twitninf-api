/**
 * Système d'événements unifié : définition, réclamations, signaux.
 *
 * Remplace le trio `events` (les couleurs) + `functional_events` (les bascules
 * par page) + `user_challenges` (les quêtes), que rien ne reliait qu'un
 * `event_slug` recopié à la main d'une table à l'autre. Les trois anciennes
 * tables ne sont PAS supprimées ici : des écrans les lisent encore, et les
 * données de l'anniversaire Kospor y vivent.
 *
 * `sequelize.sync({ force: false })` crée déjà ces tables au démarrage ; cette
 * migration existe pour les environnements où la synchronisation automatique
 * est désactivée, et pour documenter le schéma.
 *
 * ⚠️ Aucune table de progression. Elle est DÉRIVÉE des tables qui font déjà
 * autorité (`tweets`, `tweet_likes`, `transactions`) au moment de la lecture —
 * voir `services/eventQuestService.js`. Ne sont stockés que la réclamation,
 * qui n'est déductible de rien, et les signaux de navigation, que le serveur
 * ne peut pas observer.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('tw_events', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      slug: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(120), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      starts_at: { type: Sequelize.DATE, allowNull: false },
      ends_at: { type: Sequelize.DATE, allowNull: false },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      priority: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      art: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'none' },
      features: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      quests: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
      banner_message: { type: Sequelize.STRING(200), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    // Le chemin chaud : « l'événement actif le plus prioritaire », interrogé
    // par chaque compte à chaque ouverture de l'app.
    await queryInterface.addIndex('tw_events', ['is_active', 'priority']);

    await queryInterface.createTable('tw_quest_claims', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      event_slug: { type: Sequelize.STRING(64), allowNull: false },
      quest_id: { type: Sequelize.STRING(64), allowNull: false },
      granted: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      claimed_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    // La contrainte qui empêche la double remise. Elle DOIT vivre en base : un
    // contrôle applicatif laisse passer deux requêtes simultanées, et c'est
    // exactement ce que tente quelqu'un qui veut doubler un gain.
    await queryInterface.addIndex('tw_quest_claims', ['user_id', 'event_slug', 'quest_id'], {
      unique: true,
      name: 'tw_quest_claims_unique',
    });
    await queryInterface.addIndex('tw_quest_claims', ['user_id', 'event_slug']);

    await queryInterface.createTable('tw_quest_signals', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      event_slug: { type: Sequelize.STRING(64), allowNull: false },
      quest_id: { type: Sequelize.STRING(64), allowNull: false },
      idempotency_key: { type: Sequelize.STRING(160), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    // Même raison : c'est cette contrainte, et pas le code, qui fait que deux
    // envois simultanés du même signal ne comptent qu'une fois.
    await queryInterface.addIndex('tw_quest_signals', ['user_id', 'idempotency_key'], {
      unique: true,
      name: 'tw_quest_signals_unique',
    });
    await queryInterface.addIndex('tw_quest_signals', ['user_id', 'event_slug', 'quest_id']);

    console.log('OK: tables tw_events, tw_quest_claims et tw_quest_signals creees');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('tw_quest_signals');
    await queryInterface.dropTable('tw_quest_claims');
    await queryInterface.dropTable('tw_events');
    console.log('OK: tables du systeme d evenements unifie supprimees');
  },
};
