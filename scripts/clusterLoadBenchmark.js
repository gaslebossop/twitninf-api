'use strict';

// Charge GET réaliste du cluster nginx A/B. À exécuter sur A uniquement avec
// un lot isolé créé par capacityDataLifecycle.js. Les IP 127.100/8 à 127.139/8
// donnent jusqu'à 10 000 clés de hash distinctes sans trafic externe. L'action
// `map` ne touche pas à la base et sert à vérifier A/B/C après un changement.

const crypto = require('crypto');
const http = require('http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const config = require('../src/config/config');

const action = String(process.argv[2] || 'plan').toLowerCase();
const runId = String(process.argv[process.argv.indexOf('--run-id') + 1] || '');
const userCount = intEnv('CAPACITY_USERS', 1000, 1, 10000);
const tweetCount = intEnv('CAPACITY_TWEETS', Math.max(1, Math.floor(userCount / 4)), 1, userCount);
const steps = String(process.env.CLUSTER_VU_STEPS || String(userCount))
  .split(',').map(Number).filter(Number.isInteger).sort((a, b) => a - b);
const stepSeconds = intEnv('CLUSTER_STEP_SECONDS', 20, 5, 120);
const thinkTimeMs = intEnv('CLUSTER_THINK_TIME_MS', 12000, 1000, 60000);
const timeoutMs = intEnv('CLUSTER_REQUEST_TIMEOUT_MS', 10000, 1000, 30000);
const hardP95Ms = intEnv('CLUSTER_HARD_P95_MS', 3000, 100, 30000);
const hardErrorRate = numberEnv('CLUSTER_HARD_ERROR_RATE', 0.02, 0, 1);
const skipMapping = process.env.CLUSTER_SKIP_MAPPING === 'YES';

if (!/^capacity-\d{8}T\d{6}-[a-f0-9]{6}$/.test(runId)) fail('run id invalide');
if (!steps.length || steps.some(value => value < 1 || value > userCount)) fail('paliers invalides');
if (action === 'benchmark' && process.env.CONFIRM_CLUSTER_BENCHMARK !== runId) {
  fail('confirmation exacte requise');
}

const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.username,
  password: config.database.password,
  ssl: config.database.dialectOptions?.ssl || false,
  max: 2,
  application_name: `cluster-load-${runId}`,
});

function fail(message) { throw new Error(`REFUS SECURITE: ${message}`); }
function intEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name} invalide`);
  return value;
}
function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < min || value > max) fail(`${name} invalide`);
  return value;
}
function uuid(kind, index) {
  const hash = crypto.createHash('md5').update(`${runId}:${kind}:${index}`).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`;
}
function prefix() { return crypto.createHash('sha256').update(runId).digest('hex').slice(0, 8); }
function token(index) {
  return jwt.sign({
    id: uuid('user', index), username: `cb_${prefix()}_${String(index).padStart(6, '0')}`,
    verified: false, premium: false, subscription_tier: 'free', role: 'user',
    moderation_permissions: {}, is_suspended: false, purpose: 'capacity_benchmark',
    capacity_run_id: runId,
  }, config.jwt.secret, { expiresIn: '30m' });
}
function localAddress(index) {
  const value = index - 1;
  return `127.${100 + Math.floor(value / 250)}.${1 + value % 250}.1`;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] * 100) / 100;
}
function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function request(user, path, parseBody = false) {
  return new Promise(resolve => {
    const started = process.hrtime.bigint();
    const req = http.request({
      host: '127.0.0.1', port: 80, method: 'GET', path,
      localAddress: user.localAddress, agent: user.agent, timeout: timeoutMs,
      headers: {
        host: '51.210.11.74', authorization: `Bearer ${user.token}`,
        accept: 'application/json', 'accept-encoding': 'identity',
        'x-twitninf-client': 'mobile-expo', 'user-platform': user.index % 2 ? 'android' : 'ios',
        'x-device-id': `capacity-${prefix()}-${user.index}`,
        'user-agent': 'TwitninfClusterCapacity/1.0', connection: 'keep-alive',
      },
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (parseBody && bytes < 2_000_000) chunks.push(chunk); });
      response.on('end', () => {
        let body = null;
        if (parseBody) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} }
        resolve({ status: response.statusCode || 0, latencyMs: Number(process.hrtime.bigint() - started) / 1e6, bytes, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', error => resolve({ status: error.message === 'timeout' ? 598 : 599, latencyMs: Number(process.hrtime.bigint() - started) / 1e6, bytes: 0, body: null }));
    req.end();
  });
}

function choose(sequence, userIndex) {
  const bucket = sequence * 48271 % 100;
  if (bucket < 45) return { endpoint: 'feed', path: `/api/tweets?limit=20&offset=${sequence * 7 % 100}&type=all&sort=latest` };
  if (bucket < 70) return { endpoint: 'tweet', path: `/api/tweets/${uuid('tweet', (sequence * 3571 + userIndex * 17) % tweetCount + 1)}` };
  if (bucket < 90) return { endpoint: 'recommendations', path: '/api/recommendations?limit=10&offset=0' };
  return { endpoint: 'neural', path: '/api/neural-rank/recommendations?mode=for_you&limit=20&offset=0' };
}

async function mapUsers(users) {
  let cursor = 0;
  const counts = { A: 0, B: 0, C1: 0, C2: 0, C3: 0, unknown: 0 };
  let errors = 0;
  async function worker() {
    while (true) {
      const position = cursor++;
      if (position >= users.length) return;
      const response = await request(users[position], '/api/health', true);
      const autoscale = String(response.body?.instance || '').match(/^autoscale-c([1-3])$/);
      const node = autoscale
        ? `C${autoscale[1]}`
        : response.body?.policiercongo_local === true
          ? 'A'
          : response.body?.policiercongo_local === false
            ? 'B'
            : 'unknown';
      users[position].node = node;
      counts[node]++;
      if (response.status !== 200 || node === 'unknown') errors++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(50, users.length) }, worker));
  return { counts, errors, error_rate: round(errors / users.length, 5) };
}

function buildUsers(count) {
  return Array.from({ length: count }, (_, value) => {
    const index = value + 1;
    return {
      index,
      token: token(index),
      localAddress: localAddress(index),
      node: 'unknown',
      agent: new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 }),
    };
  });
}

function group(values) {
  const latencies = values.map(item => item.latencyMs).sort((a, b) => a - b);
  const success = values.filter(item => item.status >= 200 && item.status < 400).length;
  return { requests: values.length, error_rate: round((values.length - success) / Math.max(1, values.length), 5), p50_ms: percentile(latencies, .5), p95_ms: percentile(latencies, .95), p99_ms: percentile(latencies, .99) };
}
function summarize(records, durationMs) {
  const nodes = {}, endpoints = {}, statuses = {};
  for (const record of records) {
    (nodes[record.node] ||= []).push(record);
    (endpoints[record.endpoint] ||= []).push(record);
    statuses[record.status] = (statuses[record.status] || 0) + 1;
  }
  return { ...group(records), rps: round(records.length / (durationMs / 1000), 2), statuses,
    nodes: Object.fromEntries(Object.entries(nodes).map(([name, values]) => [name, group(values)])),
    endpoints: Object.fromEntries(Object.entries(endpoints).map(([name, values]) => [name, group(values)])) };
}

async function runStep(users, sequence) {
  const records = [], started = Date.now(), deadline = started + stepSeconds * 1000;
  async function virtualUser(user) {
    await sleep(user.index * 7919 % thinkTimeMs);
    while (Date.now() < deadline) {
      const selected = choose(sequence.value++, user.index);
      const response = await request(user, selected.path);
      records.push({ ...response, body: undefined, node: user.node, endpoint: selected.endpoint });
      const delay = Math.floor(thinkTimeMs * (0.8 + ((user.index * 3571 + sequence.value) % 4000) / 10000));
      if (Date.now() + delay >= deadline) break;
      await sleep(delay);
    }
  }
  await Promise.all(users.map(virtualUser));
  const duration = Date.now() - started;
  return { virtual_users: users.length, duration_ms: duration, ...summarize(records, duration) };
}

async function assertSeeded() {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*) FROM users WHERE is_data_test AND data_test_batch_id=$1)::int users,
    (SELECT count(*) FROM tweets WHERE is_data_test AND data_test_batch_id=$1)::int tweets`, [runId]);
  if (rows[0].users !== userCount || rows[0].tweets !== tweetCount) fail(`lot incomplet ${JSON.stringify(rows[0])}`);
  return rows[0];
}

async function benchmark() {
  const dataset = await assertSeeded();
  const maxUsers = Math.max(...steps);
  const users = buildUsers(maxUsers);
  const mapping = skipMapping
    ? { skipped: true, reason: 'distribution already verified independently' }
    : await mapUsers(users);
  if (!skipMapping && (mapping.errors || !mapping.counts.A || !mapping.counts.B)) {
    fail(`mapping invalide ${JSON.stringify(mapping)}`);
  }
  const results = [], sequence = { value: 0 };
  let stop_reason = null;
  try {
    for (const step of steps) {
      const result = await runStep(users.slice(0, step), sequence);
      results.push(result);
      process.stdout.write(`${JSON.stringify({ event: 'load_step', ...result })}\n`);
      if (result.error_rate > hardErrorRate) stop_reason = `error_rate>${hardErrorRate}`;
      else if (result.p95_ms > hardP95Ms) stop_reason = `p95>${hardP95Ms}`;
      if (stop_reason) break;
    }
  } finally { users.forEach(user => user.agent.destroy()); }
  return { ok: !stop_reason, run_id: runId, dataset, mapping, configuration: { steps, stepSeconds, thinkTimeMs, mutation_routes_used: false }, stop_reason, steps: results };
}

async function mapOnly() {
  const users = buildUsers(userCount);
  try {
    return { ok: true, run_id: runId, users: userCount, mapping: await mapUsers(users) };
  } finally {
    users.forEach(user => user.agent.destroy());
  }
}

async function main() {
  try {
    const result = action === 'plan'
      ? { ok: true, run_id: runId, users: userCount, tweets: tweetCount, steps, stepSeconds, thinkTimeMs, mutation_routes_used: false }
      : action === 'benchmark' ? await benchmark()
        : action === 'map' ? await mapOnly()
          : fail('action inconnue');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
  } finally { await pool.end(); }
}

main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
