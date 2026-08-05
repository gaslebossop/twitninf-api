'use strict';

/**
 * Jeu de donnees synthetique isole pour les tests de capacite.
 *
 * Garde-fous importants :
 * - run id obligatoire et strict ;
 * - confirmation contenant exactement le run id ;
 * - chaque ligne directement creee porte is_data_test + data_test_batch_id ;
 * - aucune interaction ne cible les utilisateurs/tweets existants ;
 * - le nettoyage accepte un lot partiel interrompu, mais seulement via son marqueur exact ;
 * - jamais de mode "nettoyer tous les tests".
 *
 * Exemples :
 *   node scripts/capacityDataLifecycle.js plan --run-id capacity-20260731T120000-a1b2c3
 *   CONFIRM_CAPACITY_SEED=<run-id> node scripts/capacityDataLifecycle.js seed --run-id <run-id>
 *   CONFIRM_CAPACITY_CLEANUP=<run-id> node scripts/capacityDataLifecycle.js cleanup --run-id <run-id>
 *   node scripts/capacityDataLifecycle.js verify --run-id <run-id>
 */

const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');
const config = require('../src/config/config');

const action = String(process.argv[2] || 'plan').toLowerCase();
const args = parseArgs(process.argv.slice(3));
const runId = String(args['run-id'] || process.env.CAPACITY_RUN_ID || '');
const RUN_ID_RE = /^capacity-\d{8}T\d{6}-[a-f0-9]{6}$/;
const allowSmallCanary = process.env.ALLOW_SMALL_CAPACITY_CANARY === 'YES';
const userCount = intEnv('CAPACITY_USERS', allowSmallCanary ? 100 : 105000, 1, 150000);
const tweetCount = intEnv('CAPACITY_TWEETS', allowSmallCanary ? 25 : 21000, 1, userCount);
const likesPerUser = intEnv('CAPACITY_LIKES_PER_USER', allowSmallCanary ? 2 : 3, 1, 8);
const retweetsPerUser = intEnv('CAPACITY_RETWEETS_PER_USER', 1, 1, 4);
const followsPerUser = intEnv('CAPACITY_FOLLOWS_PER_USER', allowSmallCanary ? 1 : 2, 0, 5);
const behaviorPerUser = intEnv('CAPACITY_BEHAVIOR_PER_USER', allowSmallCanary ? 2 : 3, 1, 8);
const minFreeDiskGb = Number(process.env.CAPACITY_MIN_FREE_DISK_GB || 15);

if (!RUN_ID_RE.test(runId)) {
  fail('run id invalide. Format requis: capacity-YYYYMMDDTHHMMSS-abcdef');
}
if (!allowSmallCanary && userCount <= 100000 && action === 'seed') {
  fail('le test complet doit creer plus de 100000 comptes (CAPACITY_USERS > 100000)');
}

const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.username,
  password: config.database.password,
  ssl: config.database.dialectOptions?.ssl || false,
  max: 2,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 10000,
  application_name: `capacity-lifecycle-${runId}`,
});

const DIRECT_TABLES = [
  'users',
  'tweets',
  'tweet_likes',
  'tweet_retweets',
  'user_follows',
  'user_behavior_data',
];

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith('--')) continue;
    const [rawKey, inlineValue] = value.slice(2).split('=', 2);
    if (inlineValue !== undefined) out[rawKey] = inlineValue;
    else if (values[i + 1] && !values[i + 1].startsWith('--')) out[rawKey] = values[++i];
    else out[rawKey] = true;
  }
  return out;
}

function intEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} doit etre un entier entre ${min} et ${max}`);
  }
  return value;
}

function fail(message) {
  throw new Error(`REFUS SECURITE: ${message}`);
}

function expectedCounts() {
  return {
    users: userCount,
    tweets: tweetCount,
    tweet_likes: userCount * likesPerUser,
    tweet_retweets: userCount * retweetsPerUser,
    user_follows: userCount * followsPerUser,
    user_behavior_data: userCount * behaviorPerUser,
  };
}

function syntheticPrefix() {
  return crypto.createHash('sha256').update(runId).digest('hex').slice(0, 8);
}

function idSql(kind, indexSql) {
  const hash = `md5($1 || ':${kind}:' || (${indexSql})::text)`;
  return `(substring(${hash},1,8)||'-'||substring(${hash},9,4)||'-'||substring(${hash},13,4)||'-'||substring(${hash},17,4)||'-'||substring(${hash},21,12))::uuid`;
}

function diskFreeGb() {
  if (process.platform !== 'linux') return null;
  try {
    const output = execFileSync('df', ['-Pk', '/'], { encoding: 'utf8' }).trim().split('\n').pop();
    const availableKb = Number(output.trim().split(/\s+/)[3]);
    return availableKb / 1024 / 1024;
  } catch {
    return null;
  }
}

async function assertDatabaseTarget(client) {
  const result = await client.query(`
    SELECT current_database() AS database,
           current_user AS db_user,
           pg_is_in_recovery() AS in_recovery
  `);
  const info = result.rows[0];
  if (info.database !== 'twitninf') fail(`base inattendue: ${info.database}`);
  if (info.in_recovery) fail('la base cible est en lecture seule/recovery');
  const freeGb = diskFreeGb();
  if (freeGb !== null && freeGb < minFreeDiskGb && action === 'seed') {
    fail(`espace disque VPS insuffisant: ${freeGb.toFixed(1)} Go libres`);
  }
  return { database: info.database, db_user: info.db_user, free_disk_gb: freeGb };
}

async function ensureMarkerColumns(client) {
  for (const table of DIRECT_TABLES) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS is_data_test BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS data_test_batch_id TEXT NULL`);
  }
  await client.query('CREATE INDEX IF NOT EXISTS idx_users_data_test_batch ON users(data_test_batch_id)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_tweets_data_test_batch ON tweets(data_test_batch_id)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_likes_data_test_batch ON tweet_likes(data_test_batch_id)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_retweets_data_test_batch ON tweet_retweets(data_test_batch_id)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_follows_data_test_batch ON user_follows(data_test_batch_id)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_behavior_data_test_batch ON user_behavior_data(data_test_batch_id)');
}

async function countsForRun(client) {
  const result = {};
  for (const table of DIRECT_TABLES) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::bigint AS count FROM ${table} WHERE is_data_test IS TRUE AND data_test_batch_id = $1`,
      [runId],
    );
    result[table] = Number(rows[0].count);
  }
  return result;
}

async function globalTestCounts(client) {
  const result = {};
  for (const table of DIRECT_TABLES) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::bigint AS count FROM ${table} WHERE is_data_test IS TRUE`,
    );
    result[table] = Number(rows[0].count);
  }
  return result;
}

async function seedUsers(client, passwordHash) {
  const uid = idSql('user', 'gs');
  const prefix = syntheticPrefix();
  await client.query(`
    INSERT INTO users (
      id, username, full_name, email, password, platform, is_active,
      is_suspended, email_verified, phone_verified, verified, premium, role,
      stats, preferences, moderation_permissions, moderation_history,
      is_data_test, data_test_batch_id, created_at, updated_at, last_activity
    )
    SELECT
      ${uid},
      'cb_${prefix}_' || lpad(gs::text, 6, '0'),
      'Capacity Bot ' || gs,
      NULL,
      $2,
      CASE WHEN gs % 2 = 0 THEN 'android' ELSE 'ios' END::enum_users_platform,
      TRUE, FALSE, TRUE, FALSE, FALSE, FALSE, 'user'::enum_users_role,
      jsonb_build_object('followers', ${followsPerUser}, 'following', ${followsPerUser}, 'tweets', CASE WHEN gs <= ${tweetCount} THEN 1 ELSE 0 END, 'likes', ${likesPerUser}, 'retweets', ${retweetsPerUser}),
      '{"language":"fr","theme":"dark","notifications":{"push":false,"email":false,"sms":false}}'::jsonb,
      '{}'::jsonb,
      '[]'::jsonb,
      TRUE, $1,
      NOW() - ((gs % 10080)::text || ' minutes')::interval,
      NOW(), NOW()
    FROM generate_series(1, ${userCount}) AS gs
  `, [runId, passwordHash]);
}

async function seedTweets(client) {
  const tid = idSql('tweet', 'gs');
  const uid = idSql('user', 'gs');
  const prefix = syntheticPrefix();
  await client.query(`
    INSERT INTO tweets (
      id, content, user_id, parent_tweet_id, original_tweet_id, tweet_type,
      is_retweet, is_quote, media_urls, hashtags, mentions, urls, language,
      is_private, view_count, click_count, moderation_status, recommendation_group,
      metadata, is_data_test, data_test_batch_id, created_at, updated_at
    )
    SELECT
      ${tid},
      'Publication synthetique de capacite ${prefix} #' || gs,
      ${uid}, NULL, NULL, 'tweet'::enum_tweets_tweet_type,
      FALSE, FALSE, '[]'::jsonb, jsonb_build_array('#capacity'), '[]'::jsonb,
      '[]'::jsonb, 'fr', FALSE, 0, 0, 'approved', 'initial',
      jsonb_build_object('source', 'capacity_benchmark', 'batch_id', $1),
      TRUE, $1,
      NOW() - ((gs % 10080)::text || ' minutes')::interval,
      NOW()
    FROM generate_series(1, ${tweetCount}) AS gs
  `, [runId]);
}

async function seedLikes(client) {
  const uid = idSql('user', 'u');
  const target = `(((u * 37 + j * 7919) % ${tweetCount}) + 1)`;
  const tid = idSql('tweet', target);
  const lid = idSql('like', `(u * 100 + j)`);
  await client.query(`
    INSERT INTO tweet_likes (
      id, user_id, tweet_id, like_type, metadata,
      is_data_test, data_test_batch_id, created_at, updated_at
    )
    SELECT ${lid}, ${uid}, ${tid}, 'like'::enum_tweet_likes_like_type,
           jsonb_build_object('source', 'capacity_benchmark', 'batch_id', $1),
           TRUE, $1, NOW() - (((u + j) % 10080)::text || ' minutes')::interval, NOW()
    FROM generate_series(1, ${userCount}) AS u
    CROSS JOIN generate_series(1, ${likesPerUser}) AS j
    ON CONFLICT DO NOTHING
  `, [runId]);
}

async function seedRetweets(client) {
  const uid = idSql('user', 'u');
  const target = `(((u * 53 + j * 6151) % ${tweetCount}) + 1)`;
  const tid = idSql('tweet', target);
  const rid = idSql('retweet', `(u * 100 + j)`);
  await client.query(`
    INSERT INTO tweet_retweets (
      id, user_id, tweet_id, retweet_type, comment, metadata,
      is_data_test, data_test_batch_id, created_at, updated_at
    )
    SELECT ${rid}, ${uid}, ${tid}, 'retweet'::enum_tweet_retweets_retweet_type, NULL,
           jsonb_build_object('source', 'capacity_benchmark', 'batch_id', $1),
           TRUE, $1, NOW() - (((u + j) % 10080)::text || ' minutes')::interval, NOW()
    FROM generate_series(1, ${userCount}) AS u
    CROSS JOIN generate_series(1, ${retweetsPerUser}) AS j
    ON CONFLICT DO NOTHING
  `, [runId]);
}

async function seedFollows(client) {
  if (followsPerUser === 0) return;
  const follower = idSql('user', 'u');
  const followingIndex = `(((u - 1 + j * 7919) % ${userCount}) + 1)`;
  const following = idSql('user', followingIndex);
  const fid = idSql('follow', `(u * 100 + j)`);
  await client.query(`
    INSERT INTO user_follows (
      id, follower_id, following_id, status, notifications_enabled, metadata,
      is_data_test, data_test_batch_id, created_at, updated_at
    )
    SELECT ${fid}, ${follower}, ${following}, 'active'::enum_user_follows_status,
           FALSE, jsonb_build_object('source', 'capacity_benchmark', 'batch_id', $1),
           TRUE, $1, NOW() - (((u + j) % 10080)::text || ' minutes')::interval, NOW()
    FROM generate_series(1, ${userCount}) AS u
    CROSS JOIN generate_series(1, ${followsPerUser}) AS j
    WHERE ${follower} <> ${following}
    ON CONFLICT DO NOTHING
  `, [runId]);
}

async function seedBehavior(client) {
  const uid = idSql('user', 'u');
  const target = `(((u * 71 + j * 3571) % ${tweetCount}) + 1)`;
  const tid = idSql('tweet', target);
  await client.query(`
    INSERT INTO user_behavior_data (
      user_id, action_type, target_id, target_type, context_data,
      timestamp, duration_ms, interaction_quality, processed,
      is_data_test, data_test_batch_id, created_at, updated_at
    )
    SELECT ${uid},
           (ARRAY['tweet_view','tweet_like','tweet_retweet','content_skip','tweet_share']::enum_user_behavior_data_action_type[])[((j - 1) % 5) + 1],
           (${tid})::text, 'tweet'::enum_user_behavior_data_target_type,
           json_build_object('source', 'capacity_benchmark', 'batch_id', $1, 'feed_position', j),
           NOW() - (((u + j) % 10080)::text || ' minutes')::interval,
           400 + ((u * j) % 12000), 0.50, TRUE,
           TRUE, $1, NOW(), NOW()
    FROM generate_series(1, ${userCount}) AS u
    CROSS JOIN generate_series(1, ${behaviorPerUser}) AS j
  `, [runId]);
}

async function seed(client) {
  if (process.env.CONFIRM_CAPACITY_SEED !== runId) {
    fail('CONFIRM_CAPACITY_SEED doit etre exactement egal au run id');
  }
  await ensureMarkerColumns(client);
  const before = await countsForRun(client);
  if (Object.values(before).some(count => count !== 0)) {
    fail(`le lot existe deja: ${JSON.stringify(before)}`);
  }

  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash(`capacity-only-${runId}`, 8);
  const startedAt = Date.now();
  await client.query("SET statement_timeout = '20min'");
  const stages = [
    ['users', () => seedUsers(client, passwordHash)],
    ['tweets', () => seedTweets(client)],
    ['likes', () => seedLikes(client)],
    ['retweets', () => seedRetweets(client)],
    ['follows', () => seedFollows(client)],
    ['behavior', () => seedBehavior(client)],
  ];
  for (const [name, run] of stages) {
    const stageStart = Date.now();
    await run();
    process.stdout.write(`${JSON.stringify({ event: 'seed_stage', stage: name, duration_ms: Date.now() - stageStart })}\n`);
  }
  const actual = await countsForRun(client);
  const expected = expectedCounts();
  for (const [table, count] of Object.entries(expected)) {
    if (actual[table] !== count) fail(`comptage ${table}: attendu ${count}, obtenu ${actual[table]}`);
  }
  return { ok: true, action: 'seed', run_id: runId, expected, actual, duration_ms: Date.now() - startedAt };
}

async function deleteChunked(client, table, whereSql, params, chunkSize = 20000) {
  let total = 0;
  while (true) {
    const { rowCount } = await client.query(`
      WITH doomed AS (
        SELECT ctid FROM ${table} WHERE ${whereSql} LIMIT ${chunkSize}
      )
      DELETE FROM ${table} target USING doomed
      WHERE target.ctid = doomed.ctid
    `, params);
    total += rowCount;
    if (rowCount < chunkSize) return total;
  }
}

async function cleanup(client) {
  if (process.env.CONFIRM_CAPACITY_CLEANUP !== runId) {
    fail('CONFIRM_CAPACITY_CLEANUP doit etre exactement egal au run id');
  }
  await ensureMarkerColumns(client);
  const before = await countsForRun(client);
  // Un seed interrompu peut avoir cree seulement une partie du lot. Le marqueur
  // exact du run reste la barriere de securite : on refuse uniquement quand il
  // n'existe strictement rien a nettoyer pour ce marqueur.
  if (Object.values(before).every((count) => Number(count) === 0)) {
    fail(`aucune donnee synthetique trouvee pour ce lot: ${JSON.stringify(before)}`);
  }

  const deleted = {};
  // Certaines routes GET consultées par le benchmark enregistrent une visite
  // de profil. `profile_views` ne porte pas les marqueurs is_data_test : on ne
  // supprime donc que les lignes dont le profil OU le visiteur appartient au
  // lot strictement identifié. Sans cette étape, la FK vers users bloque le
  // nettoyage final alors que toutes les tables directement semées sont déjà
  // vides.
  const profileViews = await client.query(`
    DELETE FROM profile_views pv
    USING users u
    WHERE (pv.profile_id = u.id OR pv.viewer_id = u.id)
      AND u.is_data_test IS TRUE
      AND u.data_test_batch_id = $1
  `, [runId]);
  deleted.profile_views = profileViews.rowCount;
  const ordered = ['user_behavior_data', 'tweet_likes', 'tweet_retweets', 'user_follows', 'tweets', 'users'];
  for (const table of ordered) {
    deleted[table] = await deleteChunked(
      client,
      table,
      'is_data_test IS TRUE AND data_test_batch_id = $1',
      [runId],
    );
    process.stdout.write(`${JSON.stringify({ event: 'cleanup_stage', table, deleted: deleted[table] })}\n`);
  }

  const after = await countsForRun(client);
  if (Object.values(after).some(count => count !== 0)) {
    fail(`residus apres nettoyage: ${JSON.stringify(after)}`);
  }
  for (const table of ordered) {
    await client.query(`VACUUM (ANALYZE) ${table}`);
  }
  return { ok: true, action: 'cleanup', run_id: runId, before, deleted, after };
}

async function verify(client) {
  await ensureMarkerColumns(client);
  const counts = await countsForRun(client);
  const prefix = `cb_${syntheticPrefix()}_%`;
  const usernameRows = await client.query('SELECT COUNT(*)::bigint AS count FROM users WHERE username LIKE $1', [prefix]);
  return {
    ok: Object.values(counts).every(count => count === 0) && Number(usernameRows.rows[0].count) === 0,
    action: 'verify',
    run_id: runId,
    counts,
    username_prefix_rows: Number(usernameRows.rows[0].count),
    all_test_rows: await globalTestCounts(client),
  };
}

async function plan(client, target) {
  await ensureMarkerColumns(client);
  return {
    ok: true,
    action: 'plan',
    run_id: runId,
    target,
    canary: allowSmallCanary,
    requested: expectedCounts(),
    existing_for_run: await countsForRun(client),
    existing_all_test_rows: await globalTestCounts(client),
    protections: {
      strict_run_id: true,
      exact_confirmation: true,
      isolated_targets_only: true,
      marker_pair_required: true,
      cleanup_all_mode: false,
    },
  };
}

async function main() {
  const client = await pool.connect();
  try {
    const target = await assertDatabaseTarget(client);
    let result;
    if (action === 'plan') result = await plan(client, target);
    else if (action === 'seed') result = await seed(client);
    else if (action === 'cleanup') result = await cleanup(client);
    else if (action === 'verify') result = await verify(client);
    else fail(`action inconnue: ${action}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (action === 'verify' && !result.ok) process.exitCode = 2;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
