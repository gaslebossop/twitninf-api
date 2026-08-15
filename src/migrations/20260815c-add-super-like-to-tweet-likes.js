'use strict';

/** Marque un like posé en pression longue (Super Cœur) plutôt qu'un like classique. */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('tweet_likes', 'is_super', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('tweet_likes', 'is_super');
  },
};
