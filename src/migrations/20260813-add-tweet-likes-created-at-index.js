/**
 * Index composite `(created_at, tweet_id)` sur `tweet_likes`.
 *
 * Sert le job Spotlight (`spotlightService.computeYesterdaySpotlight`) : il
 * filtre les likes d'une fenêtre `created_at` puis regroupe par `tweet_id`.
 * Sans cet index, ce `GROUP BY` scanne toute la table à chaque exécution.
 */

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.addIndex('tweet_likes', ['created_at', 'tweet_id'], {
      name: 'tweet_likes_created_at_tweet_id',
    });
    console.log('OK: index tweet_likes_created_at_tweet_id cree');
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('tweet_likes', 'tweet_likes_created_at_tweet_id');
    console.log('OK: index tweet_likes_created_at_tweet_id supprime');
  },
};
