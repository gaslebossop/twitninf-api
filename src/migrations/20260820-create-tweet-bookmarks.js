/**
 * Favoris persistes (POST /api/tweets/:id/bookmark ne stockait rien avant
 * ca). Idempotente : le meme DDL est aussi joue par src/database/migrate.js,
 * seul chemin execute en production.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS tweet_bookmarks (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tweet_id UUID NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, tweet_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tweet_bookmarks_tweet ON tweet_bookmarks (tweet_id);
      CREATE INDEX IF NOT EXISTS idx_tweet_bookmarks_user ON tweet_bookmarks (user_id, created_at DESC);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS tweet_bookmarks;
    `);
  },
};
