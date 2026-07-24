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

    INSERT INTO tweet_queue (
      id, tweet_id, user_id, queue_status, queued_at, approved_at,
      current_group, total_views, total_likes, total_retweets, total_replies,
      group_views_initial, group_views_expansion, group_views_viral, group_views_massive,
      current_ratio, processing_metadata, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      t.id,
      t.user_id,
      'approved',
      COALESCE(t.created_at, NOW()),
      NOW(),
      COALESCE(NULLIF(t.recommendation_group::text, 'excluded'), 'initial'),
      COALESCE(t.view_count, 0),
      COALESCE(l.likes, 0),
      COALESCE(r.retweets, 0),
      COALESCE(rep.replies, 0),
      CASE WHEN COALESCE(t.recommendation_group::text, 'initial') = 'initial' THEN COALESCE(t.view_count, 0) ELSE 0 END,
      CASE WHEN COALESCE(t.recommendation_group::text, 'initial') = 'expansion' THEN COALESCE(t.view_count, 0) ELSE 0 END,
      CASE WHEN COALESCE(t.recommendation_group::text, 'initial') = 'viral' THEN COALESCE(t.view_count, 0) ELSE 0 END,
      CASE WHEN COALESCE(t.recommendation_group::text, 'initial') = 'massive' THEN COALESCE(t.view_count, 0) ELSE 0 END,
      CASE
        WHEN COALESCE(t.view_count, 0) > 0
        THEN ROUND(((COALESCE(l.likes, 0) + COALESCE(r.retweets, 0) + COALESCE(rep.replies, 0))::numeric / GREATEST(t.view_count, 1)::numeric), 4)
        ELSE 0
      END,
      jsonb_build_object('backfilled_at', NOW(), 'source', 'codex_fix_missing_tweet_queue'),
      NOW(),
      NOW()
    FROM tweets t
    LEFT JOIN (SELECT tweet_id, COUNT(*)::int likes FROM tweet_likes GROUP BY tweet_id) l ON l.tweet_id = t.id
    LEFT JOIN (SELECT tweet_id, COUNT(*)::int retweets FROM tweet_retweets GROUP BY tweet_id) r ON r.tweet_id = t.id
    LEFT JOIN (
      SELECT parent_tweet_id, COUNT(*)::int replies
      FROM tweets
      WHERE parent_tweet_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY parent_tweet_id
    ) rep ON rep.parent_tweet_id = t.id
    WHERE t.deleted_at IS NULL
      AND t.parent_tweet_id IS NULL
      AND t.moderation_status = 'approved'
      AND t.is_private IS FALSE
    ON CONFLICT (tweet_id) DO UPDATE SET
      queue_status = 'approved',
      total_views = EXCLUDED.total_views,
      total_likes = EXCLUDED.total_likes,
      total_retweets = EXCLUDED.total_retweets,
      total_replies = EXCLUDED.total_replies,
      current_ratio = EXCLUDED.current_ratio,
      updated_at = NOW();

    UPDATE tweets
    SET progressive_testing_status = 'testing',
        progressive_added_at = COALESCE(progressive_added_at, created_at, NOW())
    WHERE deleted_at IS NULL
      AND parent_tweet_id IS NULL
      AND moderation_status = 'approved'
      AND is_private IS FALSE;
  `);

  const [queueCount] = await models.sequelize.query(
    "SELECT COUNT(*)::int AS count FROM tweet_queue WHERE queue_status='approved'",
    { type: models.sequelize.QueryTypes.SELECT }
  );
  const [testingCount] = await models.sequelize.query(
    "SELECT COUNT(*)::int AS count FROM tweets WHERE progressive_testing_status='testing' AND deleted_at IS NULL",
    { type: models.sequelize.QueryTypes.SELECT }
  );
  console.log(JSON.stringify({ ok: true, approved_queue: queueCount.count, testing_tweets: testingCount.count }));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => models.sequelize.close());
