'use strict';

/** Solde persistant du générateur de tweets à la demande. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'tweet_generation_credits', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addConstraint('users', {
      fields: ['tweet_generation_credits'],
      type: 'check',
      where: { tweet_generation_credits: { [Sequelize.Op.gte]: 0 } },
      name: 'users_tweet_generation_credits_nonnegative',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeConstraint('users', 'users_tweet_generation_credits_nonnegative');
    await queryInterface.removeColumn('users', 'tweet_generation_credits');
  },
};
