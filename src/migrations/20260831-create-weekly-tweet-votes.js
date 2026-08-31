/**
 * Vote hebdomadaire de la communauté pour le meilleur tweet de la semaine
 * (proposition La Forge). Table entièrement nouvelle : `sequelize.sync({
 * alter: false })` la crée déjà au démarrage à partir du modèle
 * `WeeklyTweetVote` ; ce fichier documente le DDL et permet un rejeu manuel,
 * même patron que `20260820-create-tweet-bookmarks.js`.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS weekly_tweet_votes (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tweet_id UUID NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
        week_start DATE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, week_start)
      );
      CREATE INDEX IF NOT EXISTS idx_weekly_tweet_votes_tweet_week ON weekly_tweet_votes (tweet_id, week_start);
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP TABLE IF EXISTS weekly_tweet_votes;
    `);
  },
};
