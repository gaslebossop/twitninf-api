/**
 * Sessions de connexion : jetons de rafraîchissement opaques, hachés, avec
 * rotation et détection de rejeu.
 *
 * `sequelize.sync({ force: false })` crée déjà cette table au démarrage ; cette
 * migration existe pour les environnements où la synchronisation automatique
 * est désactivée, et pour documenter le schéma.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('sessions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      // SHA-256 hexadécimal du jeton opaque — le jeton lui-même n'est jamais stocké.
      refresh_token_hash: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      // Relie toutes les rotations successives d'une même connexion.
      family_id: { type: Sequelize.UUID, allowNull: false },
      device_id: { type: Sequelize.STRING(128), allowNull: true },
      platform: { type: Sequelize.STRING(32), allowNull: true },
      app_version: { type: Sequelize.STRING(32), allowNull: true },
      user_agent: { type: Sequelize.STRING(255), allowNull: true },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      last_used_at: { type: Sequelize.DATE, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      revoked_reason: { type: Sequelize.STRING(64), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('sessions', ['user_id', 'revoked_at']);
    await queryInterface.addIndex('sessions', ['family_id']);
    await queryInterface.addIndex('sessions', ['expires_at']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('sessions');
  },
};
