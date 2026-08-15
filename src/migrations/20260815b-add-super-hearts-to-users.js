'use strict';

/**
 * Solde de Super Cœurs (like arc-en-ciel réservé au palier Pro, La Forge).
 * Renouvelé paresseusement tous les N jours à la lecture — voir
 * `src/utils/superHeartHelpers.js` — pas de cron dédié.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'super_hearts_remaining', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addConstraint('users', {
      fields: ['super_hearts_remaining'],
      type: 'check',
      where: { super_hearts_remaining: { [Sequelize.Op.gte]: 0 } },
      name: 'users_super_hearts_remaining_nonnegative',
    });
    await queryInterface.addColumn('users', 'super_hearts_renew_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeConstraint('users', 'users_super_hearts_remaining_nonnegative');
    await queryInterface.removeColumn('users', 'super_hearts_remaining');
    await queryInterface.removeColumn('users', 'super_hearts_renew_at');
  },
};
