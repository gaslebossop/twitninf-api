'use strict';

/**
 * Charge HTTP locale et progressive pour un lot cree par capacityDataLifecycle.
 * Le generateur doit tourner sur le VPS et ne cible que 127.0.0.1.
 *
 * Il ne declenche aucune mutation like/retweet dans l'API : ces interactions
 * sont deja presentes dans le jeu synthetique. Cela mesure les lectures feed,
 * le classement NeuralRank et l'hydratation PostgreSQL sans entrainer le CTR.
 * Les impressions Redis temporaires du lot sont supprimees automatiquement.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { createClient } = require('redis');
const config = require('../src/config/config');

const action = String(process.argv[2] || 'plan').toLowerCase();
const args = parseArgs(process.argv.slice(3));
const runId = String(args['run-id'] || process.env.CAPACITY_RUN_ID || '');
const RUN_ID_RE = /^capacity-\d{8}T\d{6}-[a-f0-9]{6}$/;
const apiBase = String(process.env.CAPACITY_API_BASE || 'http://127.0.0.1:3001').replace(/\/$/, '');
const userCount = intEnv('CAPACITY_USERS', 105000, 1, 150000);
const tweetCount = intEnv('CAPACITY_TWEETS', 21000, 1, userCount);
const tokenPoolSize = intEnv('CAPACITY_TOKEN_POOL', Math.min(userCount, 12000), 1, userCount);
const durationSeconds = intEnv('CAPACITY_STEP_SECONDS', 15, 5, 120);
const steps = parseSteps(process.env.CAPACITY_CONCURRENCY || '5,10,20,40,80,120,180,260,360');
const requestTimeoutMs = intEnv('CAPACITY_REQUEST_TIMEOUT_MS', 10000, 1000, 30000);
const profile = String(process.env.CAPACITY_PROFILE || 'mixed').toLowerCase();
const slaP95Ms = intEnv('CAPACITY_SLA_P95_MS', 1000, 100, 10000);
const slaP99Ms = intEnv('CAPACITY_SLA_P99_MS', 2000, 100, 20000);
const hardP95Ms = intEnv('CAPACITY_HARD_P95_MS', 5000, slaP95Ms, 30000);
const hardErrorRate = numberEnv('CAPACITY_HARD_ERROR_RATE', 0.05, 0.001, 1);

if (!RUN_ID_RE.test(runId)) fail('run id invalide');
if (!['mixed', 'api', 'neural_cold', 'neural_hot'].includes(profile)) {
  fail('CAPACITY_PROFILE doit valoir mixed, api, neural_cold ou neural_hot');
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(apiBase)) {
  fail(`cible HTTP non locale refusee: ${apiBase}`);
}
if (action === 'benchmark' && process.env.CONFIRM_CAPACITY_BENCHMARK !== runId) {
  fail('CONFIRM_CAPACITY_BENCHMARK doit etre exactement egal au run id');
}

const dbPool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.username,
  password: config.database.password,
  ssl: config.database.dialectOptions?.ssl || false,
  max: 2,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 10000,
  application_name: `capacity-load-${runId}`,
});

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith('--')) continue;
    const [key, inlineValue] = value.slice(2).split('=', 2);
    if (inlineValue !== undefined) out[key] = inlineValue;
    else if (values[i + 1] && !values[i + 1].startsWith('--')) out[key] = values[++i];
    else out[key] = true;
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

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    fail(`${name} doit etre entre ${min} et ${max}`);
  }
  return value;
}

function parseSteps(raw) {
  const parsed = String(raw).split(',').map(value => Number(value.trim()));
  if (!parsed.length || parsed.some(value => !Number.isInteger(value) || value < 1 || value > 2000)) {
    fail('CAPACITY_CONCURRENCY invalide (liste de 1..2000)');
  }
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function fail(message) {
  throw new Error(`REFUS SECURITE: ${message}`);
}

function deterministicUuid(kind, index) {
  const hash = crypto.createHash('md5').update(`${runId}:${kind}:${index}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function runPrefix() {
  return crypto.createHash('sha256').update(runId).digest('hex').slice(0, 8);
}

function makeToken(userIndex) {
  return jwt.sign({
    id: deterministicUuid('user', userIndex),
    username: `cb_${runPrefix()}_${String(userIndex).padStart(6, '0')}`,
    email: null,
    verified: false,
    premium: false,
    subscription_tier: 'free',
    role: 'user',
    moderation_permissions: {},
    is_suspended: false,
    purpose: 'capacity_benchmark',
    capacity_run_id: runId,
  }, config.jwt.secret, { expiresIn: '30m' });
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

function summarizeRecords(records, durationMs) {
  const latencies = records.map(record => record.latencyMs).sort((a, b) => a - b);
  const success = records.filter(record => record.status >= 200 && record.status < 400).length;
  const errors = records.length - success;
  const statuses = {};
  const endpoints = {};
  for (const record of records) {
    statuses[record.status] = (statuses[record.status] || 0) + 1;
    if (!endpoints[record.endpoint]) endpoints[record.endpoint] = [];
    endpoints[record.endpoint].push(record);
  }
  const endpointSummary = {};
  for (const [name, values] of Object.entries(endpoints)) {
    const endpointLatencies = values.map(value => value.latencyMs).sort((a, b) => a - b);
    const endpointSuccess = values.filter(value => value.status >= 200 && value.status < 400).length;
    const engineLatencies = values.map(value => value.engineLatencyMs).filter(Number.isFinite).sort((a, b) => a - b);
    endpointSummary[name] = {
      requests: values.length,
      rps: round(values.length / (durationMs / 1000), 2),
      error_rate: round((values.length - endpointSuccess) / Math.max(1, values.length), 5),
      p50_ms: percentile(endpointLatencies, 0.50),
      p95_ms: percentile(endpointLatencies, 0.95),
      p99_ms: percentile(endpointLatencies, 0.99),
      engine_p95_ms: percentile(engineLatencies, 0.95),
      cache_hit_rate: round(values.filter(value => value.cacheHit === true).length / Math.max(1, values.filter(value => value.cacheHit !== null).length), 5),
    };
  }
  return {
    requests: records.length,
    success,
    errors,
    error_rate: round(errors / Math.max(1, records.length), 5),
    rps: round(records.length / (durationMs / 1000), 2),
    p50_ms: percentile(latencies, 0.50),
    p95_ms: percentile(latencies, 0.95),
    p99_ms: percentile(latencies, 0.99),
    max_ms: percentile(latencies, 1),
    statuses,
    endpoints: endpointSummary,
  };
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function chooseRequest(sequence, userIndex) {
  const bucket = (sequence * 48271) % 100;
  if (profile === 'neural_cold' || profile === 'neural_hot') {
    return {
      name: profile,
      url: `${apiBase}/api/neural-rank/recommendations?mode=for_you&limit=20&offset=0`,
    };
  }
  if (profile === 'api') {
    if (bucket < 50) {
      const offset = ((sequence * 7) % 5) * 20;
      return {
        name: 'public_feed',
        url: `${apiBase}/api/tweets?limit=20&offset=${offset}&type=all&sort=latest`,
      };
    }
    if (bucket < 80) {
      const tweetIndex = ((sequence * 3571 + userIndex * 17) % tweetCount) + 1;
      return {
        name: 'tweet_detail',
        url: `${apiBase}/api/tweets/${deterministicUuid('tweet', tweetIndex)}`,
      };
    }
    return {
      name: 'js_recommendations',
      url: `${apiBase}/api/recommendations?limit=10&offset=0`,
    };
  }
  if (bucket < 40) {
    return {
      name: 'neural_rank',
      url: `${apiBase}/api/neural-rank/recommendations?mode=for_you&limit=20&offset=0`,
    };
  }
  if (bucket < 70) {
    const offset = ((sequence * 7) % 5) * 20;
    return {
      name: 'public_feed',
      url: `${apiBase}/api/tweets?limit=20&offset=${offset}&type=all&sort=latest`,
    };
  }
  if (bucket < 90) {
    const tweetIndex = ((sequence * 3571 + userIndex * 17) % tweetCount) + 1;
    return {
      name: 'tweet_detail',
      url: `${apiBase}/api/tweets/${deterministicUuid('tweet', tweetIndex)}`,
    };
  }
  return {
    name: 'js_recommendations',
    url: `${apiBase}/api/recommendations?limit=10&offset=0`,
  };
}

async function oneRequest(sequence, tokens) {
  const userIndex = (sequence % tokenPoolSize) + 1;
  const selected = chooseRequest(sequence, userIndex);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const started = process.hrtime.bigint();
  let status = 0;
  let engineLatencyMs = null;
  let cacheHit = null;
  try {
    const response = await fetch(selected.url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${tokens[userIndex - 1]}`,
        accept: 'application/json',
        'accept-encoding': 'gzip, deflate',
        'x-twitninf-client': 'mobile-expo',
        'user-platform': userIndex % 2 ? 'android' : 'ios',
        'x-device-id': `capacity-${runPrefix()}-${userIndex}`,
        'user-agent': 'TwitninfCapacityBenchmark/1.0',
      },
      signal: controller.signal,
    });
    status = response.status;
    const body = await response.text();
    if (selected.name.startsWith('neural_') && body.length < 2_000_000) {
      try {
        const parsed = JSON.parse(body);
        engineLatencyMs = Number(parsed?.data?.latency_ms);
        if (!Number.isFinite(engineLatencyMs)) engineLatencyMs = null;
        cacheHit = typeof parsed?.data?.cache_hit === 'boolean' ? parsed.data.cache_hit : null;
      } catch { /* metriques HTTP conservees */ }
    }
  } catch (error) {
    status = error?.name === 'AbortError' ? 598 : 599;
  } finally {
    clearTimeout(timeout);
  }
  return {
    endpoint: selected.name,
    status,
    latencyMs: Number(process.hrtime.bigint() - started) / 1e6,
    engineLatencyMs,
    cacheHit,
  };
}

function execFilePromise(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout: 3000 }, (error, stdout) => {
      resolve(error ? null : String(stdout || '').trim());
    });
  });
}

function memAvailableMb() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = text.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    return match ? round(Number(match[1]) / 1024, 1) : null;
  } catch {
    return null;
  }
}

function loadAverage() {
  try {
    return fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).slice(0, 3).map(Number);
  } catch {
    return [];
  }
}

function pm2Snapshot() {
  try {
    const list = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 5000 }));
    const app = list.find(item => item.name === 'twitninf-api');
    if (!app) return null;
    return {
      pid: Number(app.pid || 0),
      status: app.pm2_env?.status || 'unknown',
      restarts: Number(app.pm2_env?.restart_time || 0),
      rss_mb: round(Number(app.monit?.memory || 0) / 1024 / 1024, 1),
      cpu_percent: Number(app.monit?.cpu || 0),
    };
  } catch {
    return null;
  }
}

async function systemSample(redisClient, apiPid) {
  const sample = {
    at: new Date().toISOString(),
    load_average: loadAverage(),
    mem_available_mb: memAvailableMb(),
    api_cpu_percent: null,
    api_rss_mb: null,
    postgres_backends: null,
    postgres_active: null,
    redis_clients: null,
    redis_used_memory_mb: null,
  };
  if (apiPid) {
    const ps = await execFilePromise('ps', ['-p', String(apiPid), '-o', '%cpu=,rss=']);
    if (ps) {
      const [cpu, rss] = ps.trim().split(/\s+/).map(Number);
      sample.api_cpu_percent = Number.isFinite(cpu) ? cpu : null;
      sample.api_rss_mb = Number.isFinite(rss) ? round(rss / 1024, 1) : null;
    }
  }
  try {
    const { rows } = await dbPool.query(`
      SELECT COUNT(*)::int AS backends,
             COUNT(*) FILTER (WHERE state = 'active')::int AS active
      FROM pg_stat_activity WHERE datname = current_database()
    `);
    sample.postgres_backends = rows[0].backends;
    sample.postgres_active = rows[0].active;
  } catch { /* charge HTTP prioritaire */ }
  try {
    const info = await redisClient.info('clients');
    const memory = await redisClient.info('memory');
    sample.redis_clients = Number(info.match(/^connected_clients:(\d+)/m)?.[1] || 0);
    sample.redis_used_memory_mb = round(Number(memory.match(/^used_memory:(\d+)/m)?.[1] || 0) / 1024 / 1024, 2);
  } catch { /* charge HTTP prioritaire */ }
  return sample;
}

function summarizeSamples(samples) {
  const max = (field) => {
    const values = samples.map(sample => sample[field]).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  };
  const min = (field) => {
    const values = samples.map(sample => sample[field]).filter(Number.isFinite);
    return values.length ? Math.min(...values) : null;
  };
  const load1 = samples.map(sample => sample.load_average?.[0]).filter(Number.isFinite);
  return {
    samples: samples.length,
    max_load_1m: load1.length ? Math.max(...load1) : null,
    min_mem_available_mb: min('mem_available_mb'),
    max_api_cpu_percent: max('api_cpu_percent'),
    max_api_rss_mb: max('api_rss_mb'),
    max_postgres_backends: max('postgres_backends'),
    max_postgres_active: max('postgres_active'),
    max_redis_clients: max('redis_clients'),
    max_redis_used_memory_mb: max('redis_used_memory_mb'),
  };
}

async function runStep(concurrency, tokens, redisClient, apiPid, sequenceState) {
  const records = [];
  const samples = [];
  let sampling = false;
  const startedAt = Date.now();
  const deadline = startedAt + durationSeconds * 1000;
  const sampleTimer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try { samples.push(await systemSample(redisClient, apiPid)); } finally { sampling = false; }
  }, 1000);

  async function worker() {
    while (Date.now() < deadline) {
      const current = sequenceState.value++;
      records.push(await oneRequest(current, tokens));
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    samples.push(await systemSample(redisClient, apiPid));
  } finally {
    clearInterval(sampleTimer);
  }
  const durationMs = Date.now() - startedAt;
  return {
    concurrency,
    duration_ms: durationMs,
    ...summarizeRecords(records, durationMs),
    system: summarizeSamples(samples),
  };
}

async function prewarmNeural(tokens) {
  if (profile !== 'neural_hot') return null;
  const records = [];
  let next = 0;
  async function worker() {
    while (next < tokens.length) {
      const current = next++;
      records.push(await oneRequest(current, tokens));
    }
  }
  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(10, tokens.length) }, () => worker()));
  return summarizeRecords(records, Date.now() - started);
}

function redisOptions() {
  return {
    socket: { host: config.redis.host, port: config.redis.port, connectTimeout: 10000 },
    password: config.redis.password || undefined,
    database: config.redis.db || 0,
  };
}

async function deleteKeysInChunks(client, keys) {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    if (chunk.length) deleted += await client.del(chunk);
  }
  return deleted;
}

async function cleanupSyntheticRedis(client) {
  const syntheticUsers = new Set();
  for (let index = 1; index <= userCount; index += 1) syntheticUsers.add(deterministicUuid('user', index));

  const keysToDelete = [];
  const patterns = [
    'twitninf:reco:*',
    'twitninf:profile:*',
    'twitninf:seen:*',
    'twitninf:ctr:imp:*',
    'seen:*',
    'feedback:author:*',
    'feedback:hashtag:*',
  ];
  for (const pattern of patterns) {
    for await (const rawKey of client.scanIterator({ MATCH: pattern, COUNT: 1000 })) {
      const key = String(rawKey);
      const parts = key.split(':');
      let userId = null;
      if (key.startsWith('twitninf:reco:')) userId = parts[2];
      else if (key.startsWith('twitninf:profile:')) userId = parts[2];
      else if (key.startsWith('twitninf:seen:')) userId = parts[2];
      else if (key.startsWith('twitninf:ctr:imp:')) userId = parts[3];
      else if (key.startsWith('seen:')) userId = parts[1];
      else if (key.startsWith('feedback:author:')) userId = parts[2];
      else if (key.startsWith('feedback:hashtag:')) userId = parts[2];
      if (userId && syntheticUsers.has(userId)) keysToDelete.push(key);
    }
  }

  const pendingMembers = [];
  try {
    for await (const item of client.zScanIterator('twitninf:ctr:pending', { COUNT: 1000 })) {
      const value = String(item?.value ?? item);
      const userId = value.split(':', 1)[0];
      if (syntheticUsers.has(userId)) pendingMembers.push(value);
    }
  } catch (error) {
    if (!String(error.message).includes('WRONGTYPE')) throw error;
  }
  for (let i = 0; i < pendingMembers.length; i += 500) {
    await client.zRem('twitninf:ctr:pending', pendingMembers.slice(i, i + 500));
  }
  return {
    deleted_keys: await deleteKeysInChunks(client, keysToDelete),
    deleted_pending_impressions: pendingMembers.length,
    matched_keys: keysToDelete.length,
  };
}

async function assertSeeded() {
  const { rows } = await dbPool.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM users WHERE is_data_test IS TRUE AND data_test_batch_id = $1) AS users,
      (SELECT COUNT(*)::bigint FROM tweets WHERE is_data_test IS TRUE AND data_test_batch_id = $1) AS tweets
  `, [runId]);
  const actualUsers = Number(rows[0].users);
  const actualTweets = Number(rows[0].tweets);
  if (actualUsers !== userCount || actualTweets !== tweetCount) {
    fail(`lot absent/incomplet: users=${actualUsers}/${userCount}, tweets=${actualTweets}/${tweetCount}`);
  }
  return { users: actualUsers, tweets: actualTweets };
}

async function apiPreflight(token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${apiBase}/api/neural-rank/health`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-twitninf-client': 'mobile-expo',
        'user-platform': 'android',
        'x-device-id': `capacity-${runPrefix()}-preflight`,
      },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) fail(`API/NeuralRank indisponible: HTTP ${response.status} ${body.slice(0, 200)}`);
    return { status: response.status, body: body.slice(0, 500) };
  } finally {
    clearTimeout(timeout);
  }
}

function capacityEstimate(stepResults) {
  const eligible = stepResults.filter(step => (
    step.error_rate <= 0.01 &&
    step.p95_ms <= slaP95Ms &&
    step.p99_ms <= slaP99Ms &&
    (step.system.max_postgres_backends === null || step.system.max_postgres_backends < 90)
  ));
  const sustainable = eligible.sort((a, b) => b.rps - a.rps)[0] || null;
  if (!sustainable) return { sustainable_rps: 0, safe_rps: 0, note: 'aucun palier ne respecte le SLA' };
  const safeRps = sustainable.rps * 0.70;
  return {
    sustainable_rps: sustainable.rps,
    safe_rps_30pct_headroom: round(safeRps, 2),
    sustainable_concurrency: sustainable.concurrency,
    sla: { max_error_rate: 0.01, p95_ms: slaP95Ms, p99_ms: slaP99Ms },
    estimated_simultaneous_active_users: {
      light_one_request_per_30s: Math.floor(safeRps * 30),
      typical_one_request_per_12s: Math.floor(safeRps * 12),
      heavy_one_request_per_5s: Math.floor(safeRps * 5),
    },
  };
}

async function benchmark() {
  const dataset = await assertSeeded();
  // Les insertions massives changent fortement les distributions. Actualiser
  // les statistiques avant le chrono evite de mesurer de mauvais plans SQL.
  if (process.env.CAPACITY_SKIP_ANALYZE !== 'YES') {
    await dbPool.query('ANALYZE users, tweets, tweet_likes, tweet_retweets, user_follows, user_behavior_data');
  }
  const pm2Before = pm2Snapshot();
  if (!pm2Before || pm2Before.status !== 'online' || !pm2Before.pid) fail('processus PM2 twitninf-api indisponible');

  process.stdout.write(`${JSON.stringify({ event: 'tokens_start', count: tokenPoolSize })}\n`);
  const tokenStarted = Date.now();
  const tokens = Array.from({ length: tokenPoolSize }, (_, index) => makeToken(index + 1));
  process.stdout.write(`${JSON.stringify({ event: 'tokens_ready', duration_ms: Date.now() - tokenStarted })}\n`);
  const preflight = await apiPreflight(tokens[0]);

  const redisClient = createClient(redisOptions());
  redisClient.on('error', () => {});
  await redisClient.connect();
  const cleanupBefore = await cleanupSyntheticRedis(redisClient);
  const prewarm = await prewarmNeural(tokens);
  const startedAt = new Date();
  const stepResults = [];
  const sequenceState = { value: profile === 'neural_cold' ? tokenPoolSize : 0 };
  let stopReason = null;

  try {
    for (const concurrency of steps) {
      const result = await runStep(concurrency, tokens, redisClient, pm2Before.pid, sequenceState);
      stepResults.push(result);
      process.stdout.write(`${JSON.stringify({ event: 'load_step', ...result })}\n`);
      const pm2Now = pm2Snapshot();
      if (!pm2Now || pm2Now.status !== 'online') stopReason = 'api_offline';
      else if (pm2Now.restarts > pm2Before.restarts) stopReason = 'api_restarted';
      else if (result.error_rate > hardErrorRate) stopReason = `error_rate>${hardErrorRate}`;
      else if (result.p95_ms > hardP95Ms) stopReason = `p95>${hardP95Ms}ms`;
      else if (result.system.min_mem_available_mb !== null && result.system.min_mem_available_mb < 1024) stopReason = 'available_memory<1GB';
      else if (result.system.max_postgres_backends !== null && result.system.max_postgres_backends >= 90) stopReason = 'postgres_connections>=90';
      if (stopReason) break;
    }
  } finally {
    // Toujours avant la fenetre d'attribution CTR de 30 minutes.
    var cacheCleanup = await cleanupSyntheticRedis(redisClient); // eslint-disable-line no-var
    await redisClient.quit();
  }

  const pm2After = pm2Snapshot();
  const endedAt = new Date();
  const report = {
    ok: !stopReason || !['api_offline', 'api_restarted', 'available_memory<1GB', 'postgres_connections>=90'].includes(stopReason),
    run_id: runId,
    generated_at: endedAt.toISOString(),
    generator: { host: apiBase, same_server: true, token_pool: tokenPoolSize },
    profile,
    dataset,
    preflight,
    configuration: {
      concurrency_steps: steps,
      step_seconds: durationSeconds,
      timeout_ms: requestTimeoutMs,
      sla_p95_ms: slaP95Ms,
      sla_p99_ms: slaP99Ms,
      hard_p95_ms: hardP95Ms,
      hard_error_rate: hardErrorRate,
    },
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_seconds: round((endedAt - startedAt) / 1000, 2),
    stop_reason: stopReason,
    pm2_before: pm2Before,
    pm2_after: pm2After,
    cache_cleanup_before: cleanupBefore,
    prewarm,
    cache_cleanup_after: cacheCleanup,
    steps: stepResults,
    capacity_estimate: capacityEstimate(stepResults),
    limitations: [
      'Le generateur tourne sur le meme VPS : resultat volontairement conservateur.',
      'Cette estimation porte sur HTTP/API et NeuralRank, pas sur les connexions Socket.IO inactives.',
      'Les interactions sociales sont pre-semees en base ; la charge soutenue reste en lecture pour ne pas polluer le modele CTR.',
    ],
  };
  const outputDir = path.resolve(__dirname, '../reports/capacity');
  fs.mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `${runId}-${profile}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report, report_path: reportPath };
}

async function cleanupCacheOnly() {
  if (process.env.CONFIRM_CAPACITY_CLEANUP !== runId && process.env.CONFIRM_CAPACITY_BENCHMARK !== runId) {
    fail('confirmation exacte requise pour cleanup-cache');
  }
  const redisClient = createClient(redisOptions());
  redisClient.on('error', () => {});
  await redisClient.connect();
  try {
    return await cleanupSyntheticRedis(redisClient);
  } finally {
    await redisClient.quit();
  }
}

async function plan() {
  return {
    ok: true,
    action: 'plan',
    run_id: runId,
    api_base: apiBase,
    users: userCount,
    tweets: tweetCount,
    token_pool: tokenPoolSize,
    profile,
    concurrency_steps: steps,
    step_seconds: durationSeconds,
    estimated_max_duration_seconds: steps.length * durationSeconds,
    mutation_routes_used: false,
    redis_cleanup_automatic: true,
  };
}

async function main() {
  let result;
  try {
    if (action === 'plan') result = await plan();
    else if (action === 'benchmark') result = await benchmark();
    else if (action === 'cleanup-cache') result = await cleanupCacheOnly();
    else fail(`action inconnue: ${action}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await dbPool.end();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
