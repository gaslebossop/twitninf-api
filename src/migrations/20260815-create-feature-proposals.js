/**
 * La Forge : les fonctionnalités proposées par les utilisateurs.
 *
 * `sequelize.sync({ force: false })` crée déjà cette table au démarrage du
 * worker ; cette migration existe pour les environnements où la
 * synchronisation automatique est désactivée, et pour documenter le schéma.
 *
 * Rien ici n'ajoute de valeur à un ENUM existant : les deux types sont créés
 * avec la table. C'est justement pourquoi une table neuve est sans risque là
 * où une colonne ajoutée à un modèle existant ne l'est pas.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('feature_proposals', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      author_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE'
      },
      title: { type: Sequelize.STRING(120), allowNull: false },
      body: { type: Sequelize.TEXT, allowNull: false },
      area: {
        type: Sequelize.ENUM('feed', 'profil', 'messages', 'economie', 'carte', 'video', 'autre'),
        allowNull: false,
        defaultValue: 'autre'
      },
      status: {
        type: Sequelize.ENUM('received', 'reviewing', 'accepted', 'built', 'declined'),
        allowNull: false,
        defaultValue: 'received'
      },
      reward_nf: { type: Sequelize.DECIMAL(18, 2), allowNull: true },
      // Séparé de `reward_nf` : l'un est la décision, l'autre le versement
      // effectif. Les confondre rendrait impossible de distinguer « pas encore
      // payé » de « payé », donc impossible de rejouer sans payer deux fois.
      reward_paid_at: { type: Sequelize.DATE, allowNull: true },
      staff_note: { type: Sequelize.TEXT, allowNull: true },
      decided_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
      },
      decided_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW }
    });

    await queryInterface.addIndex('feature_proposals', ['author_id', 'created_at']);
    await queryInterface.addIndex('feature_proposals', ['status', 'created_at']);
    await queryInterface.addIndex('feature_proposals', ['reward_paid_at']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('feature_proposals');
    // Les types ENUM survivent au `dropTable` sous PostgreSQL et bloqueraient
    // un rejeu de la migration.
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_feature_proposals_area";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_feature_proposals_status";');
  }
};
