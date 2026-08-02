'use strict';

const fs = require('fs');
const models = require('../src/models');

const output = process.argv[2] || '/home/debian/api/tmp/raid-bot-suspects.csv';

function csv(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

async function main() {
  const rows = await models.sequelize.query(
    `
      WITH
      recent_likes AS (
        SELECT tl.user_id, tl.tweet_id, tl.created_at
        FROM tweet_likes tl
        WHERE tl.created_at >= NOW() - INTERVAL '30 days'
      ),
      like_raid_targets AS (
        SELECT tweet_id, date_trunc('hour', created_at) AS bucket, COUNT(DISTINCT user_id)::int AS users_in_raid
        FROM recent_likes
        GROUP BY tweet_id, date_trunc('hour', created_at)
        HAVING COUNT(DISTINCT user_id) >= 8
      ),
      like_raid_users AS (
        SELECT rl.user_id, COUNT(*)::int AS like_raid_hits, MAX(lrt.users_in_raid)::int AS largest_like_raid
        FROM recent_likes rl
        JOIN like_raid_targets lrt ON lrt.tweet_id = rl.tweet_id AND lrt.bucket = date_trunc('hour', rl.created_at)
        GROUP BY rl.user_id
      ),
      account_farm_users AS (
        SELECT id AS user_id, created_bucket_user_count, created_bucket_sequential_count
        FROM (
          SELECT
            id,
            username,
            COUNT(*) OVER (PARTITION BY date_trunc('hour', created_at))::int AS created_bucket_user_count,
            COUNT(*) FILTER (WHERE username ~ '^twitninfuser[0-9]+$') OVER (PARTITION BY date_trunc('hour', created_at))::int AS created_bucket_sequential_count
          FROM users
          WHERE created_at >= NOW() - INTERVAL '30 days'
        ) u
        WHERE username ~ '^twitninfuser[0-9]+$'
          AND created_bucket_user_count >= 20
          AND created_bucket_sequential_count >= 20
      )
      SELECT
        u.id,
        u.username,
        u.created_at,
        COALESCE(lru.like_raid_hits, 0)::int AS like_raid_hits,
        COALESCE(lru.largest_like_raid, 0)::int AS largest_like_raid,
        COALESCE(afu.created_bucket_user_count, 0)::int AS created_bucket_user_count,
        COALESCE(afu.created_bucket_sequential_count, 0)::int AS created_bucket_sequential_count,
        LEAST(100,
          CASE WHEN COALESCE(lru.like_raid_hits, 0) >= 3 THEN 70 ELSE 0 END +
          CASE WHEN COALESCE(afu.created_bucket_sequential_count, 0) >= 20 THEN 70 ELSE 0 END
        )::int AS score,
        array_remove(ARRAY[
          CASE WHEN COALESCE(lru.like_raid_hits, 0) >= 3 THEN 'like_raid_coordonne' END,
          CASE WHEN COALESCE(afu.created_bucket_sequential_count, 0) >= 20 THEN 'account_farm_creation_massive' END
        ], NULL) AS reasons
      FROM users u
      LEFT JOIN like_raid_users lru ON lru.user_id = u.id
      LEFT JOIN account_farm_users afu ON afu.user_id = u.id
      WHERE COALESCE(u.role::text, 'user') = 'user'
        AND (
          COALESCE(lru.like_raid_hits, 0) >= 3
          OR COALESCE(afu.created_bucket_sequential_count, 0) >= 20
        )
      ORDER BY score DESC, u.username ASC
    `,
    { type: models.sequelize.QueryTypes.SELECT }
  );

  const header = [
    'id',
    'username',
    'created_at',
    'score',
    'reasons',
    'like_raid_hits',
    'largest_like_raid',
    'created_bucket_user_count',
    'created_bucket_sequential_count'
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.id,
      row.username,
      new Date(row.created_at).toISOString(),
      row.score,
      (row.reasons || []).join('|'),
      row.like_raid_hits,
      row.largest_like_raid,
      row.created_bucket_user_count,
      row.created_bucket_sequential_count
    ].map(csv).join(','));
  }

  fs.writeFileSync(output, `${lines.join('\n')}\n`);
  console.log(JSON.stringify({
    count: rows.length,
    output,
    first20: rows.slice(0, 20).map(row => ({
      username: row.username,
      id: row.id,
      score: row.score,
      reasons: row.reasons
    }))
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => models.sequelize.close());
