/**
 * Programme de monétisation : condition supplémentaire à l'abonnement payant
 * avant de pouvoir toucher des récompenses tweet. Toujours une validation
 * manuelle, même quand les seuils objectifs (vues, abonnés, qualité des
 * abonnés) sont atteints.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'monetization_program_status', {
      type: Sequelize.ENUM('none', 'pending', 'approved', 'rejected'),
      allowNull: false,
      defaultValue: 'none',
    });

    await queryInterface.addColumn('users', 'monetization_applied_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addColumn('users', 'monetization_reviewed_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addColumn('users', 'monetization_reviewed_by', {
      type: Sequelize.UUID,
      allowNull: true,
    });

    await queryInterface.addColumn('users', 'monetization_rejection_reason', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.addIndex('users', ['monetization_program_status'], {
      name: 'users_monetization_program_status_idx',
    });

    console.log('OK: users.monetization_program_status + colonnes associées');
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('users', 'users_monetization_program_status_idx').catch(() => {});
    await queryInterface.removeColumn('users', 'monetization_rejection_reason');
    await queryInterface.removeColumn('users', 'monetization_reviewed_by');
    await queryInterface.removeColumn('users', 'monetization_reviewed_at');
    await queryInterface.removeColumn('users', 'monetization_applied_at');
    await queryInterface.removeColumn('users', 'monetization_program_status');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_users_monetization_program_status";');
    console.log('OK: colonnes monetization_program_status retirées');
  },
};
