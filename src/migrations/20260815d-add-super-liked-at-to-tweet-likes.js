'use strict';

/**
 * Horodatage de la pose du Super Cœur, distinct de `created_at` : un like
 * classique posé plus tôt peut être promu Super Cœur bien après sa création
 * (unicité user_id/tweet_id, voir POST /api/tweets/:id/super-like). Sans ce
 * champ, `spotlightService` scorait — ou datait — le Super Cœur au moment du
 * like d'origine plutôt qu'au moment réel de la pose.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('tweet_likes', 'super_liked_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('tweet_likes', 'super_liked_at');
  },
};
