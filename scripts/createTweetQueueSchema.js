'use strict';

const models = require('../src/models');

async function main() {
  await models.sequelize.query(`
    ALTER TABLE tweets ADD COLUMN IF NOT EXISTS progressive_testing_status TEXT NOT NULL DEFAULT 'testing';
    ALTER TABLE tweets ADD COLUMN IF NOT EXISTS progressive_added_at TIMESTAMPTZ NULL;
    ALTER TABLE tweets ADD COLUMN IF NOT EXISTS progressive_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS tweet_queue (
      id UUID PRIMARY KEY,
      tweet_id UUID NOT NULL UNIQUE REFERENCES tweets(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      queue_status TEXT NOT NULL DEFAULT 'approved',
      queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ NULL,
      approved_at TIMESTAMPTZ NULL,
      rejected_at TIMESTAMPTZ NULL,
      rejection_reason TEXT NULL,
      current_group TEXT NOT NULL DEFAULT 'initial',
      total_views NUMERIC NOT NULL DEFAULT 0,
      total_likes INTEGER NOT NULL DEFAULT 0,
      total_retweets INTEGER NOT NULL DEFAULT 0,
      total_replies INTEGER NOT NULL DEFAULT 0,
      group_views_initial NUMERIC NOT NULL DEFAULT 0,
      group_views_expansion NUMERIC NOT NULL DEFAULT 0,
      group_views_viral NUMERIC NOT NULL DEFAULT 0,
      group_views_massive NUMERIC NOT NULL DEFAULT 0,
      current_ratio NUMERIC NOT NULL DEFAULT 0,
      processing_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tweet_queue_status_group ON tweet_queue(queue_status, current_group);
    CREATE INDEX IF NOT EXISTS idx_tweet_queue_tweet_id ON tweet_queue(tweet_id);
    CREATE INDEX IF NOT EXISTS idx_tweet_queue_user_id ON tweet_queue(user_id);
    CREATE INDEX IF NOT EXISTS idx_tweets_progressive_testing_status ON tweets(progressive_testing_status);
  `);
  console.log(JSON.stringify({ ok: true }));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => models.sequelize.close());
