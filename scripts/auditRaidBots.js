'use strict';

const fs = require('fs');
const path = require('path');
const models = require('../src/models');

function parseArgs(argv) {
  const args = {
    days: 7,
    threshold: 70,
    limit: 50,
    save: false,
    json: false,
    output: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--save') args.save = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--days') args.days = Number(argv[++i]);
    else if (arg.startsWith('--days=')) args.days = Number(arg.slice('--days='.length));
    else if (arg === '--threshold') args.threshold = Number(argv[++i]);
    else if (arg.startsWith('--threshold=')) args.threshold = Number(arg.slice('--threshold='.length));
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length));
    else if (arg === '--output') args.output = argv[++i];
    else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
  }

  if (!Number.isFinite(args.days) || args.days < 1 || args.days > 365) {
    throw new Error('--days doit etre entre 1 et 365');
  }
  if (!Number.isFinite(args.threshold) || args.threshold < 1 || args.threshold > 100) {
    throw new Error('--threshold doit etre entre 1 et 100');
  }
  if (!Number.isFinite(args.limit) || args.limit < 1 || args.limit > 500) {
    throw new Error('--limit doit etre entre 1 et 500');
  }

  args.days = Math.floor(args.days);
  args.threshold = Math.floor(args.threshold);
  args.limit = Math.floor(args.limit);
  return args;
}

async function tableExists(tableName) {
  const [row] = await models.sequelize.query(
    `SELECT to_regclass(:tableName) IS NOT NULL AS exists`,
    {
      replacements: { tableName: `public.${tableName}` },
      type: models.sequelize.QueryTypes.SELECT
    }
  );
  return row.exists;
}

async function ensureUsefulTables() {
  const tableNames = [
    'users',
    'tweets',
    'tweet_likes',
    'tweet_retweets',
    'user_follows',
    'user_behavior_data',
    'bot_reputations'
  ];

  const entries = await Promise.all(tableNames.map(async table => [table, await tableExists(table)]));
  return Object.fromEntries(entries);
}

function intervalFromDays(days) {
  return `${days} days`;
}

async function runAudit(args, tables) {
  if (!tables.users) {
    throw new Error('Table users introuvable');
  }

  const query = `
    WITH
    recent_likes AS (
      SELECT tl.user_id, tl.tweet_id, tl.created_at, t.user_id AS target_author_id
      FROM tweet_likes tl
      LEFT JOIN tweets t ON t.id = tl.tweet_id
      WHERE tl.created_at >= NOW() - CAST(:window AS interval)
    ),
    recent_retweets AS (
      SELECT tr.user_id, tr.tweet_id, tr.created_at, t.user_id AS target_author_id
      FROM tweet_retweets tr
      LEFT JOIN tweets t ON t.id = tr.tweet_id
      WHERE tr.created_at >= NOW() - CAST(:window AS interval)
    ),
    recent_follows AS (
      SELECT follower_id AS user_id, following_id, created_at
      FROM user_follows
      WHERE created_at >= NOW() - CAST(:window AS interval)
        AND COALESCE(status::text, 'active') = 'active'
    ),
    recent_tweets AS (
      SELECT id, user_id, parent_tweet_id, original_tweet_id, tweet_type, content, created_at
      FROM tweets
      WHERE created_at >= NOW() - CAST(:window AS interval)
        AND deleted_at IS NULL
    ),
    recent_behavior AS (
      SELECT user_id, action_type::text AS action_type, target_id, target_type::text AS target_type,
             timestamp, duration_ms, ip_address, device_info::text AS device_key
      FROM user_behavior_data
      WHERE timestamp >= NOW() - CAST(:window AS interval)
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
        WHERE created_at >= NOW() - CAST(:window AS interval)
      ) u
      WHERE username ~ '^twitninfuser[0-9]+$'
        AND created_bucket_user_count >= 20
        AND created_bucket_sequential_count >= 20
    ),
    follow_counts AS (
      SELECT
        user_id,
        COUNT(*)::int AS follows_recent,
        COUNT(DISTINCT following_id)::int AS distinct_follow_targets,
        MAX(bucket_count)::int AS max_follows_per_hour
      FROM (
        SELECT user_id, following_id, date_trunc('hour', created_at) AS bucket, COUNT(*) OVER (PARTITION BY user_id, date_trunc('hour', created_at)) AS bucket_count
        FROM recent_follows
      ) s
      GROUP BY user_id
    ),
    like_counts AS (
      SELECT
        user_id,
        COUNT(*)::int AS likes_recent,
        COUNT(DISTINCT tweet_id)::int AS distinct_liked_tweets,
        COUNT(DISTINCT target_author_id)::int AS distinct_liked_authors,
        MAX(bucket_count)::int AS max_likes_per_hour
      FROM (
        SELECT user_id, tweet_id, target_author_id, date_trunc('hour', created_at) AS bucket, COUNT(*) OVER (PARTITION BY user_id, date_trunc('hour', created_at)) AS bucket_count
        FROM recent_likes
      ) s
      GROUP BY user_id
    ),
    retweet_counts AS (
      SELECT
        user_id,
        COUNT(*)::int AS retweets_recent,
        COUNT(DISTINCT tweet_id)::int AS distinct_retweeted_tweets,
        COUNT(DISTINCT target_author_id)::int AS distinct_retweeted_authors,
        MAX(bucket_count)::int AS max_retweets_per_hour
      FROM (
        SELECT user_id, tweet_id, target_author_id, date_trunc('hour', created_at) AS bucket, COUNT(*) OVER (PARTITION BY user_id, date_trunc('hour', created_at)) AS bucket_count
        FROM recent_retweets
      ) s
      GROUP BY user_id
    ),
    tweet_counts AS (
      SELECT
        user_id,
        COUNT(*)::int AS tweets_recent,
        COUNT(*) FILTER (WHERE parent_tweet_id IS NOT NULL OR tweet_type::text = 'reply')::int AS replies_recent,
        COUNT(DISTINCT left(regexp_replace(lower(COALESCE(content, '')), '\\s+', ' ', 'g'), 80))::int AS distinct_text_prefixes,
        MAX(bucket_count)::int AS max_tweets_per_hour
      FROM (
        SELECT user_id, parent_tweet_id, tweet_type, content, date_trunc('hour', created_at) AS bucket, COUNT(*) OVER (PARTITION BY user_id, date_trunc('hour', created_at)) AS bucket_count
        FROM recent_tweets
      ) s
      GROUP BY user_id
    ),
    behavior_counts AS (
      SELECT
        user_id,
        COUNT(*)::int AS behavior_events_recent,
        COUNT(DISTINCT action_type)::int AS distinct_behavior_actions,
        COUNT(DISTINCT target_id) FILTER (WHERE target_id IS NOT NULL)::int AS distinct_behavior_targets,
        COUNT(DISTINCT ip_address) FILTER (WHERE ip_address IS NOT NULL)::int AS distinct_ips,
        COUNT(DISTINCT device_key) FILTER (WHERE device_key IS NOT NULL AND device_key <> '{}')::int AS distinct_devices,
        AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL)::float AS avg_duration_ms,
        COUNT(*) FILTER (WHERE action_type IN ('tap_gesture', 'device_motion_noise', 'keyboard_rhythm', 'scroll_jitter'))::int AS human_signal_events,
        MAX(bucket_count)::int AS max_behavior_per_hour
      FROM (
        SELECT *, COUNT(*) OVER (PARTITION BY user_id, date_trunc('hour', timestamp)) AS bucket_count
        FROM recent_behavior
      ) s
      GROUP BY user_id
    ),
    follow_raid_targets AS (
      SELECT following_id, date_trunc('hour', created_at) AS bucket, COUNT(DISTINCT user_id)::int AS users_in_raid
      FROM recent_follows
      GROUP BY following_id, date_trunc('hour', created_at)
      HAVING COUNT(DISTINCT user_id) >= 8
    ),
    follow_raid_users AS (
      SELECT rf.user_id, COUNT(*)::int AS follow_raid_hits, MAX(frt.users_in_raid)::int AS largest_follow_raid
      FROM recent_follows rf
      JOIN follow_raid_targets frt ON frt.following_id = rf.following_id AND frt.bucket = date_trunc('hour', rf.created_at)
      GROUP BY rf.user_id
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
    behavior_raid_targets AS (
      SELECT action_type, target_id, date_trunc('hour', timestamp) AS bucket, COUNT(DISTINCT user_id)::int AS users_in_raid
      FROM recent_behavior
      WHERE target_id IS NOT NULL
        AND action_type IN ('tweet_like', 'tweet_retweet', 'tweet_reply', 'user_follow', 'profile_view', 'tweet_report')
      GROUP BY action_type, target_id, date_trunc('hour', timestamp)
      HAVING COUNT(DISTINCT user_id) >= 8
    ),
    behavior_raid_users AS (
      SELECT rb.user_id, COUNT(*)::int AS behavior_raid_hits, MAX(brt.users_in_raid)::int AS largest_behavior_raid
      FROM recent_behavior rb
      JOIN behavior_raid_targets brt
        ON brt.action_type = rb.action_type
       AND brt.target_id = rb.target_id
       AND brt.bucket = date_trunc('hour', rb.timestamp)
      GROUP BY rb.user_id
    ),
    global_follow_counts AS (
      SELECT follower_id AS user_id, COUNT(*)::int AS following_total
      FROM user_follows
      WHERE COALESCE(status::text, 'active') = 'active'
      GROUP BY follower_id
    ),
    global_follower_counts AS (
      SELECT following_id AS user_id, COUNT(*)::int AS followers_total
      FROM user_follows
      WHERE COALESCE(status::text, 'active') = 'active'
      GROUP BY following_id
    ),
    assembled AS (
      SELECT
        u.id,
        u.username,
        u.full_name,
        u.created_at,
        u.is_active,
        u.is_suspended,
        u.ban_count,
        u.role::text AS role,
        COALESCE(gf.following_total, 0) AS following_total,
        COALESCE(gr.followers_total, 0) AS followers_total,
        COALESCE(fc.follows_recent, 0) AS follows_recent,
        COALESCE(fc.distinct_follow_targets, 0) AS distinct_follow_targets,
        COALESCE(fc.max_follows_per_hour, 0) AS max_follows_per_hour,
        COALESCE(lc.likes_recent, 0) AS likes_recent,
        COALESCE(lc.distinct_liked_tweets, 0) AS distinct_liked_tweets,
        COALESCE(lc.distinct_liked_authors, 0) AS distinct_liked_authors,
        COALESCE(lc.max_likes_per_hour, 0) AS max_likes_per_hour,
        COALESCE(rc.retweets_recent, 0) AS retweets_recent,
        COALESCE(rc.distinct_retweeted_tweets, 0) AS distinct_retweeted_tweets,
        COALESCE(rc.distinct_retweeted_authors, 0) AS distinct_retweeted_authors,
        COALESCE(rc.max_retweets_per_hour, 0) AS max_retweets_per_hour,
        COALESCE(tc.tweets_recent, 0) AS tweets_recent,
        COALESCE(tc.replies_recent, 0) AS replies_recent,
        COALESCE(tc.distinct_text_prefixes, 0) AS distinct_text_prefixes,
        COALESCE(tc.max_tweets_per_hour, 0) AS max_tweets_per_hour,
        COALESCE(bc.behavior_events_recent, 0) AS behavior_events_recent,
        COALESCE(bc.distinct_behavior_actions, 0) AS distinct_behavior_actions,
        COALESCE(bc.distinct_behavior_targets, 0) AS distinct_behavior_targets,
        COALESCE(bc.distinct_ips, 0) AS distinct_ips,
        COALESCE(bc.distinct_devices, 0) AS distinct_devices,
        COALESCE(bc.avg_duration_ms, 0) AS avg_duration_ms,
        COALESCE(bc.human_signal_events, 0) AS human_signal_events,
        COALESCE(bc.max_behavior_per_hour, 0) AS max_behavior_per_hour,
        COALESCE(afu.created_bucket_user_count, 0) AS created_bucket_user_count,
        COALESCE(afu.created_bucket_sequential_count, 0) AS created_bucket_sequential_count,
        COALESCE(fru.follow_raid_hits, 0) AS follow_raid_hits,
        COALESCE(fru.largest_follow_raid, 0) AS largest_follow_raid,
        COALESCE(lru.like_raid_hits, 0) AS like_raid_hits,
        COALESCE(lru.largest_like_raid, 0) AS largest_like_raid,
        COALESCE(bru.behavior_raid_hits, 0) AS behavior_raid_hits,
        COALESCE(bru.largest_behavior_raid, 0) AS largest_behavior_raid
      FROM users u
      LEFT JOIN global_follow_counts gf ON gf.user_id = u.id
      LEFT JOIN global_follower_counts gr ON gr.user_id = u.id
      LEFT JOIN follow_counts fc ON fc.user_id = u.id
      LEFT JOIN like_counts lc ON lc.user_id = u.id
      LEFT JOIN retweet_counts rc ON rc.user_id = u.id
      LEFT JOIN tweet_counts tc ON tc.user_id = u.id
      LEFT JOIN behavior_counts bc ON bc.user_id = u.id
      LEFT JOIN account_farm_users afu ON afu.user_id = u.id
      LEFT JOIN follow_raid_users fru ON fru.user_id = u.id
      LEFT JOIN like_raid_users lru ON lru.user_id = u.id
      LEFT JOIN behavior_raid_users bru ON bru.user_id = u.id
      WHERE COALESCE(u.role::text, 'user') = 'user'
    ),
    scored AS (
      SELECT
        *,
        (
          CASE WHEN follow_raid_hits >= 3 THEN 75 ELSE 0 END +
          CASE WHEN like_raid_hits >= 3 THEN 70 ELSE 0 END +
          CASE WHEN behavior_raid_hits >= 5 THEN 70 ELSE 0 END +
          CASE WHEN created_bucket_sequential_count >= 20 THEN 70 ELSE 0 END +
          CASE WHEN max_follows_per_hour >= 20 THEN 18 WHEN max_follows_per_hour >= 10 THEN 10 ELSE 0 END +
          CASE WHEN max_likes_per_hour >= 60 THEN 18 WHEN max_likes_per_hour >= 30 THEN 10 ELSE 0 END +
          CASE WHEN max_retweets_per_hour >= 25 THEN 16 WHEN max_retweets_per_hour >= 12 THEN 9 ELSE 0 END +
          CASE WHEN max_tweets_per_hour >= 20 THEN 14 WHEN max_tweets_per_hour >= 10 THEN 8 ELSE 0 END +
          CASE WHEN following_total >= 100 AND followers_total <= 3 THEN 14 WHEN following_total >= 50 AND followers_total <= 2 THEN 8 ELSE 0 END +
          CASE WHEN follows_recent >= 40 AND distinct_follow_targets >= 30 THEN 14 ELSE 0 END +
          CASE WHEN likes_recent >= 100 AND distinct_liked_authors <= 5 THEN 12 ELSE 0 END +
          CASE WHEN retweets_recent >= 40 AND distinct_retweeted_authors <= 5 THEN 10 ELSE 0 END +
          CASE WHEN tweets_recent >= 8 AND distinct_text_prefixes <= GREATEST(2, CEIL(tweets_recent * 0.35)) THEN 12 ELSE 0 END +
          CASE WHEN behavior_events_recent >= 100 AND distinct_behavior_targets <= 10 THEN 10 ELSE 0 END +
          CASE WHEN behavior_events_recent >= 60 AND human_signal_events = 0 THEN 8 ELSE 0 END +
          CASE WHEN distinct_ips >= 5 THEN 8 ELSE 0 END +
          CASE WHEN ban_count >= 2 THEN 8 WHEN ban_count = 1 THEN 4 ELSE 0 END
        )::int AS raw_score
      FROM assembled
    )
    SELECT
      *,
      LEAST(100, raw_score)::int AS bot_score,
      CASE
        WHEN LEAST(100, raw_score) >= 85 THEN 'bot_raid_probable'
        WHEN LEAST(100, raw_score) >= :threshold THEN 'suspect_raid'
        WHEN LEAST(100, raw_score) >= 45 THEN 'a_surveillance'
        ELSE 'ok'
      END AS classification,
      array_remove(ARRAY[
        CASE WHEN follow_raid_hits >= 3 THEN 'follow_raid_coordonne' END,
        CASE WHEN like_raid_hits >= 3 THEN 'like_raid_coordonne' END,
        CASE WHEN behavior_raid_hits >= 5 THEN 'raid_comportemental_coordonne' END,
        CASE WHEN created_bucket_sequential_count >= 20 THEN 'account_farm_creation_massive' END,
        CASE WHEN max_follows_per_hour >= 10 THEN 'follow_burst' END,
        CASE WHEN max_likes_per_hour >= 30 THEN 'like_burst' END,
        CASE WHEN max_retweets_per_hour >= 12 THEN 'retweet_burst' END,
        CASE WHEN max_tweets_per_hour >= 10 THEN 'tweet_reply_burst' END,
        CASE WHEN following_total >= 50 AND followers_total <= 3 THEN 'ratio_following_followers_anormal' END,
        CASE WHEN likes_recent >= 100 AND distinct_liked_authors <= 5 THEN 'likes_concentres' END,
        CASE WHEN retweets_recent >= 40 AND distinct_retweeted_authors <= 5 THEN 'retweets_concentres' END,
        CASE WHEN tweets_recent >= 8 AND distinct_text_prefixes <= GREATEST(2, CEIL(tweets_recent * 0.35)) THEN 'contenu_repetitif' END,
        CASE WHEN behavior_events_recent >= 60 AND human_signal_events = 0 THEN 'absence_signaux_humains' END,
        CASE WHEN distinct_ips >= 5 THEN 'multi_ip' END,
        CASE WHEN ban_count >= 1 THEN 'historique_ban' END
      ], NULL) AS reasons
    FROM scored
    ORDER BY bot_score DESC, follow_raid_hits DESC, like_raid_hits DESC, behavior_raid_hits DESC, likes_recent DESC
  `;

  const rows = await models.sequelize.query(query, {
    replacements: {
      window: intervalFromDays(args.days),
      threshold: args.threshold
    },
    type: models.sequelize.QueryTypes.SELECT
  });

  return rows;
}

async function saveReputations(rows, threshold) {
  const suspects = rows.filter(row => row.bot_score >= threshold);
  if (suspects.length === 0) return 0;

  await models.sequelize.query(
    `
      INSERT INTO bot_reputations (user_id, signals_count, score, classification, updated_at)
      VALUES ${suspects.map((_, i) => `(:user_id_${i}, :signals_count_${i}, :score_${i}, :classification_${i}, NOW())`).join(', ')}
      ON CONFLICT (user_id) DO UPDATE SET
        signals_count = EXCLUDED.signals_count,
        score = EXCLUDED.score,
        classification = EXCLUDED.classification,
        updated_at = NOW()
    `,
    {
      replacements: Object.fromEntries(
        suspects.flatMap((row, i) => [
          [`user_id_${i}`, row.id],
          [`signals_count_${i}`, Array.isArray(row.reasons) ? row.reasons.length : 0],
          [`score_${i}`, row.bot_score],
          [`classification_${i}`, row.bot_score >= 85 ? 'bot' : 'suspicious']
        ])
      )
    }
  );

  return suspects.length;
}

function summarize(rows, args, savedCount, tables) {
  const suspects = rows.filter(row => row.bot_score >= args.threshold);
  const probableBots = rows.filter(row => row.bot_score >= 85);
  const watch = rows.filter(row => row.bot_score >= 45 && row.bot_score < args.threshold);

  const reasonCounts = new Map();
  for (const row of suspects) {
    for (const reason of row.reasons || []) {
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    window_days: args.days,
    threshold: args.threshold,
    total_users_analyzed: rows.length,
    suspicious_accounts: suspects.length,
    probable_bot_accounts: probableBots.length,
    watchlist_accounts: watch.length,
    saved_reputations: savedCount,
    tables,
    reason_counts: Object.fromEntries([...reasonCounts.entries()].sort((a, b) => b[1] - a[1])),
    top_suspicious_accounts: suspects.slice(0, args.limit).map(row => ({
      id: row.id,
      username: row.username,
      score: row.bot_score,
      classification: row.classification,
      reasons: row.reasons,
      metrics: {
        followers_total: row.followers_total,
        following_total: row.following_total,
        follows_recent: row.follows_recent,
        max_follows_per_hour: row.max_follows_per_hour,
        follow_raid_hits: row.follow_raid_hits,
        largest_follow_raid: row.largest_follow_raid,
        likes_recent: row.likes_recent,
        max_likes_per_hour: row.max_likes_per_hour,
        like_raid_hits: row.like_raid_hits,
        largest_like_raid: row.largest_like_raid,
        retweets_recent: row.retweets_recent,
        max_retweets_per_hour: row.max_retweets_per_hour,
        tweets_recent: row.tweets_recent,
        replies_recent: row.replies_recent,
        max_tweets_per_hour: row.max_tweets_per_hour,
        behavior_events_recent: row.behavior_events_recent,
        behavior_raid_hits: row.behavior_raid_hits,
        largest_behavior_raid: row.largest_behavior_raid,
        distinct_ips: row.distinct_ips,
        human_signal_events: row.human_signal_events,
        created_bucket_user_count: row.created_bucket_user_count,
        created_bucket_sequential_count: row.created_bucket_sequential_count
      }
    }))
  };
}

function printHuman(summary) {
  console.log(`Audit raid bots - fenetre ${summary.window_days} jour(s), seuil ${summary.threshold}`);
  console.log(`Utilisateurs analyses: ${summary.total_users_analyzed}`);
  console.log(`Comptes suspects: ${summary.suspicious_accounts}`);
  console.log(`Bots raid probables: ${summary.probable_bot_accounts}`);
  console.log(`A surveiller: ${summary.watchlist_accounts}`);
  if (summary.saved_reputations) {
    console.log(`Scores sauvegardes dans bot_reputations: ${summary.saved_reputations}`);
  }
  console.log('');
  console.log('Raisons principales:');
  for (const [reason, count] of Object.entries(summary.reason_counts).slice(0, 12)) {
    console.log(`- ${reason}: ${count}`);
  }
  console.log('');
  console.log('Top comptes suspects:');
  for (const account of summary.top_suspicious_accounts.slice(0, 20)) {
    console.log(`- ${account.username} (${account.id}) score=${account.score} ${account.classification} raisons=${account.reasons.join(', ')}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tables = await ensureUsefulTables();
  const missingCritical = ['tweet_likes', 'tweet_retweets', 'user_follows', 'user_behavior_data']
    .filter(table => !tables[table]);

  if (missingCritical.length > 0) {
    console.error(`Attention: tables manquantes pour certains signaux: ${missingCritical.join(', ')}`);
  }

  const rows = await runAudit(args, tables);
  const savedCount = args.save && tables.bot_reputations
    ? await saveReputations(rows, args.threshold)
    : 0;

  const summary = summarize(rows, args, savedCount, tables);
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2));
    console.error(`Rapport ecrit: ${outputPath}`);
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHuman(summary);
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => models.sequelize.close());
