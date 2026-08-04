'use strict';

const { QueryTypes } = require('sequelize');
const { SUBSCRIPTION_TWEET_CREDITS } = require('../constants/tweetGeneration');

/**
 * Marqueur durable : le crédit de bienvenue vise les abonnés déjà présents le
 * jour du lancement. Sans marqueur, un UPDATE au démarrage rendrait 5 crédits
 * à tous ceux qui les ont consommés à chaque redémarrage du serveur.
 */
const BACKFILL_KEY = '20260804_active_subscribers_tweet_credits_v1';

async function runSubscriberTweetCreditBackfill(sequelize) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS app_schema_backfills (
        backfill_key VARCHAR(160) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `, { transaction });

    const marker = await sequelize.query(`
      INSERT INTO app_schema_backfills (backfill_key)
      VALUES (:backfillKey)
      ON CONFLICT (backfill_key) DO NOTHING
      RETURNING backfill_key;
    `, {
      replacements: { backfillKey: BACKFILL_KEY },
      type: QueryTypes.SELECT,
      transaction,
    });

    if (marker.length === 0) {
      return { applied: false, credited: 0 };
    }

    const creditedUsers = await sequelize.query(`
      UPDATE users
      SET tweet_generation_credits = GREATEST(
        COALESCE(tweet_generation_credits, 0),
        :minimumCredits
      )
      WHERE premium = true
        AND subscription_tier IN ('plus', 'pro')
        AND (subscription_expires_at IS NULL OR subscription_expires_at > NOW())
        AND COALESCE(tweet_generation_credits, 0) < :minimumCredits
      RETURNING id;
    `, {
      replacements: { minimumCredits: SUBSCRIPTION_TWEET_CREDITS },
      type: QueryTypes.SELECT,
      transaction,
    });

    return { applied: true, credited: creditedUsers.length };
  });
}

module.exports = {
  BACKFILL_KEY,
  runSubscriberTweetCreditBackfill,
};
