/**
 * Places d'invitation : billets signés d'un événement, et journal des passages
 * à l'entrée.
 *
 * `sequelize.sync({ force: false })` crée déjà ces tables au démarrage ; cette
 * migration existe pour les environnements où la synchronisation automatique
 * est désactivée, et pour documenter le schéma.
 *
 * `tier` et `status` sont des VARCHAR et non des ENUM Postgres : les valeurs
 * sont fermées mais amenées à s'étendre, et Sequelize n'ajoute jamais une
 * valeur à un type énuméré existant — chaque palier ajouté demanderait un
 * `ALTER TYPE` joué à la main en production.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('event_passes', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },

      event_slug: { type: Sequelize.STRING(64), allowNull: false },
      // Recopiés depuis l'événement à l'émission : une place est un document,
      // ce qui est imprimé dessus ne doit plus changer.
      event_name: { type: Sequelize.STRING(120), allowNull: false },
      event_date: { type: Sequelize.DATE, allowNull: true },
      event_place: { type: Sequelize.STRING(120), allowNull: true },

      code: { type: Sequelize.STRING(24), allowNull: false, unique: true },
      serial: { type: Sequelize.INTEGER, allowNull: false },

      tier: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'standard' },
      status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'valid' },

      guest_name: { type: Sequelize.STRING(80), allowNull: true },
      guest_user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
      },

      max_scans: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      scans_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      first_scanned_at: { type: Sequelize.DATE, allowNull: true },
      last_scanned_at: { type: Sequelize.DATE, allowNull: true },
      scanned_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
      },

      expires_at: { type: Sequelize.DATE, allowNull: true },
      revoked_reason: { type: Sequelize.STRING(160), allowNull: true },
      note: { type: Sequelize.STRING(160), allowNull: true },
      metadata: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },

      created_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
      },

      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    // Le numéro de place doit être unique dans son événement : c'est ce couple
    // qu'on lit à voix haute à la porte. La contrainte vit en base, un contrôle
    // applicatif laisserait passer deux émissions de lot simultanées.
    await queryInterface.addIndex('event_passes', ['event_slug', 'serial'], { unique: true });
    await queryInterface.addIndex('event_passes', ['event_slug', 'status']);
    await queryInterface.addIndex('event_passes', ['guest_user_id']);

    await queryInterface.createTable('event_pass_scans', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      // Nullable : un code inconnu ou mal signé ne pointe vers aucune place,
      // et c'est justement la ligne la plus intéressante du journal.
      pass_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'event_passes', key: 'id' },
        onDelete: 'CASCADE',
      },
      event_slug: { type: Sequelize.STRING(64), allowNull: true },
      code_attempt: { type: Sequelize.STRING(48), allowNull: true },
      result: { type: Sequelize.STRING(20), allowNull: false },
      scanned_by: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
      },
      device_label: { type: Sequelize.STRING(60), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('event_pass_scans', ['event_slug', 'created_at']);
    await queryInterface.addIndex('event_pass_scans', ['pass_id']);
    await queryInterface.addIndex('event_pass_scans', ['result']);

    console.log('OK: tables event_passes et event_pass_scans creees');
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('event_pass_scans');
    await queryInterface.dropTable('event_passes');
    console.log('OK: tables event_passes et event_pass_scans supprimees');
  },
};
