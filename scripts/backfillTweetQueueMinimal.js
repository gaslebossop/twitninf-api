'use strict';

const models = require('../src/models');

async function main() {
  await models.sequelize.query(`
    INSERT INTO tweet_queue (
      id, tweet_id, user_id, queue_status, queued_at, approved_at,
      current_group, total_views,
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
      CASE WHEN COALESCE(t.recommendation_group::text, 'initial') = 'initial' THEN COALESCE(t.view_count, 0) ELSE 0 END,
      CASE WHEN COALESCE(t.recommendation_group::text, 'initial') = 'expansion' THEN COALESCE(t.view_count, 0) ELSE 0 END,
      CASE WHEN COALESCE(t.recommendation_group::text, 'initial') = 'viral' THEN COALESCE(t.view_count, 0) ELSE 0 END,
      CASE WHEN COALESCE(t.recommendation_group::text, 'initial') = 'massive' THEN COALESCE(t.view_count, 0) ELSE 0 END,
      0,
      jsonb_build_object('backfilled_at', NOW(), 'source', 'codex_minimal_queue_backfill'),
      NOW(),
      NOW()
    FROM tweets t
    WHERE t.deleted_at IS NULL
      AND t.parent_tweet_id IS NULL
      AND t.moderation_status = 'approved'
      AND t.is_private IS FALSE
    ON CONFLICT (tweet_id) DO UPDATE SET
      queue_status = 'approved',
      total_views = EXCLUDED.total_views,
      current_group = EXCLUDED.current_group,
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
  console.log(JSON.stringify({ ok: true, approved_queue: queueCount.count }));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => models.sequelize.close());
