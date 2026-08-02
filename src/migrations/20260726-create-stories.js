/**
 * Stories éphémères (24 h) + registre des vues.
 *
 * `sequelize.sync({ force: false })` crée déjà ces tables au démarrage ; cette
 * migration existe pour les environnements où la synchronisation automatique
 * est désactivée, et pour documenter le schéma.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('stories', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      media_url: { type: Sequelize.STRING(768), allowNull: false },
      media_type: { type: Sequelize.ENUM('image', 'video'), allowNull: false, defaultValue: 'image' },
      thumbnail_url: { type: Sequelize.STRING(768), allowNull: true },
      caption: { type: Sequelize.STRING(280), allowNull: true },
      duration_ms: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 5000 },
      views_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      likes_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      metadata: { type: Sequelize.JSONB, defaultValue: {} },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      deleted_at: { type: Sequelize.DATE, allowNull: true },
    });

    await queryInterface.addIndex('stories', ['user_id', 'expires_at']);
    await queryInterface.addIndex('stories', ['expires_at']);
    await queryInterface.addIndex('stories', ['created_at']);
    await queryInterface.addIndex('stories', ['deleted_at']);

    await queryInterface.createTable('story_views', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      story_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'stories', key: 'id' },
        onDelete: 'CASCADE',
      },
      viewer_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      reaction: { type: Sequelize.STRING(16), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('story_views', ['story_id', 'viewer_id'], { unique: true });
    await queryInterface.addIndex('story_views', ['viewer_id']);

    console.log('OK: tables stories + story_views creees');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('story_views');
    await queryInterface.dropTable('stories');
    console.log('OK: tables stories + story_views supprimees');
  },
};
