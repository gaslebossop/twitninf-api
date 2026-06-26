/**
 * Deux paliers d'abonnement payant : plus, pro (en plus du gratuit).
 * premium reste synchronisé : true si l'utilisateur a un abonnement actif (plus ou pro).
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'subscription_tier', {
      type: Sequelize.ENUM('free', 'plus', 'pro'),
      allowNull: false,
      defaultValue: 'free',
    });

    await queryInterface.addColumn('users', 'subscription_expires_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addIndex('users', ['subscription_tier'], {
      name: 'users_subscription_tier_idx',
    });

    // Anciens premium bool → palier Pro (accès complet), sans date de fin (comportement inchangé)
    await queryInterface.sequelize.query(`
      UPDATE users
      SET subscription_tier = 'pro',
          subscription_expires_at = NULL
      WHERE premium = true;
    `);

    await queryInterface.sequelize.query(`
      UPDATE users
      SET subscription_tier = 'free'
      WHERE premium IS NOT TRUE OR premium IS NULL;
    `);

    console.log('OK: users.subscription_tier / subscription_expires_at');
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('users', 'users_subscription_tier_idx').catch(() => {});
    await queryInterface.removeColumn('users', 'subscription_expires_at');
    await queryInterface.removeColumn('users', 'subscription_tier');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_users_subscription_tier";');
    console.log('OK: subscription columns removed');
  },
};
