'use strict';

// Superviseur des simulations declenchees depuis le panel Windows. Il ne lance
// que le scenario GET versionne, avec un lot synthetique marque et nettoye dans
// un finally. Aucun chemin/argument arbitraire ne vient de la requete HTTP.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const args = parseArgs(process.argv.slice(2));
const runId = String(args['run-id'] || '');
const users = boundedInteger(args.users, 1, 10000, 'users');
const durationSeconds = boundedInteger(args.duration, 5, 300, 'duration');
const intervalMs = boundedInteger(args.interval, 1000, 60000, 'interval');
const estimatedRps = Math.round((users * 1000 / intervalMs) * 100) / 100;
const syntheticTweetCount = Math.max(1, Math.floor(users / 4));
const likesPerUser = Math.min(2, syntheticTweetCount);
const followsPerUser = users > 1 ? 1 : 0;
const runPattern = /^capacity-\d{8}T\d{6}-[a-f0-9]{6}$/;

if (!runPattern.test(runId)) throw new Error('run id invalide');
if (estimatedRps > 1000) throw new Error('plafond de 1000 requetes/s depasse');

const root = path.resolve(__dirname, '..');
const reportDirectory = path.join(root, 'reports', 'admin-load');
const currentFile = path.join(reportDirectory, 'current.json');
const jobFile = path.join(reportDirectory, `${runId}.json`);
const logFile = path.join(reportDirectory, `${runId}.log`);
const lifecycleScript = path.join(__dirname, 'capacityDataLifecycle.js');
const benchmarkScript = path.join(__dirname, 'clusterLoadBenchmark.js');

fs.mkdirSync(reportDirectory, { recursive: true });
let activeChild = null;
let stopping = false;
let stopReason = null;
let seeded = false;
let state = {
  id: runId,
  pid: process.pid,
  status: 'preparing',
  stage: 'initialisation',
  users,
  duration_seconds: durationSeconds,
  interval_ms: intervalMs,
  estimated_rps: estimatedRps,
  created_at: new Date().toISOString(),
  started_at: null,
  finished_at: null,
  cleanup: { attempted: false, verified: false },
  result: null,
  error: null,
  stop_reason: null,
};

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith('--')) continue;
    const key = values[index].slice(2);
    parsed[key] = values[index + 1] && !values[index + 1].startsWith('--') ? values[++index] : true;
  }
  return parsed;
}

function boundedInteger(value, min, max, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} doit etre compris entre ${min} et ${max}`);
  }
  return parsed;
}

function atomicWrite(file, payload) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function save(patch = {}) {
  state = { ...state, ...patch, updated_at: new Date().toISOString() };
  atomicWrite(jobFile, state);
  atomicWrite(currentFile, state);
}

function appendLog(source, value) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${source}: ${value}`, 'utf8');
}

function runNode(script, commandArgs, env, { acceptExitTwo = false, onLine = null } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let pending = '';
    const child = spawn(process.execPath, [script, ...commandArgs], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout = (stdout + text).slice(-2_000_000);
      appendLog('stdout', text);
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      if (onLine) lines.forEach((line) => onLine(line));
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr = (stderr + text).slice(-500_000);
      appendLog('stderr', text);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0 || (acceptExitTwo && code === 2)) return resolve({ code, signal, stdout, stderr });
      const error = new Error(`commande terminee avec code=${code} signal=${signal || 'none'}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function parseFinalJson(output) {
  for (let index = output.lastIndexOf('\n{'); index >= 0; index = output.lastIndexOf('\n{', index - 1)) {
    try { return JSON.parse(output.slice(index + 1)); } catch { /* cherche le bloc precedent */ }
  }
  try { return JSON.parse(output); } catch { return null; }
}

function edgeHealth() {
  return new Promise((resolve) => {
    // Depuis A, le domaine public ressort avec l'IP du VPS et peut etre refuse
    // par l'anti-fraude. Sonder Nginx en loopback exerce bien le repartiteur et
    // les backends, sans confondre un blocage d'IP source avec une panne.
    const request = http.get({
      host: '127.0.0.1', port: 80, path: '/api/health', timeout: 3000,
      headers: { host: '51.210.11.74', 'user-agent': 'TwitninfLoadHealthGuard/1.0' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStableEdge() {
  const deadline = Date.now() + 60_000;
  let consecutiveSuccesses = 0;
  save({ stage: 'attente_stabilite_repartiteur' });
  while (Date.now() < deadline) {
    if (stopping) throw new Error(stopReason || 'simulation arretee');
    consecutiveSuccesses = await edgeHealth() ? consecutiveSuccesses + 1 : 0;
    if (consecutiveSuccesses >= 3) return;
    await sleep(1000);
  }
  throw new Error('repartiteur instable apres 60 secondes; simulation non lancee');
}

function startHealthGuard() {
  let consecutiveFailures = 0;
  let checking = false;
  // L'autoscaler est autonome et peut lancer plusieurs processus Node a froid.
  // Le garde laisse ce demarrage finir, sans jamais demander lui-meme un C.
  const graceUntil = Date.now() + 45_000;
  const timer = setInterval(async () => {
    if (checking || stopping || Date.now() < graceUntil) return;
    checking = true;
    try {
      consecutiveFailures = await edgeHealth() ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= 5 && activeChild) {
        stopReason = 'arret_urgence: repartiteur API indisponible 5 fois de suite';
        stopping = true;
        save({ status: 'stopping', stage: 'arret_urgence', stop_reason: stopReason });
        activeChild.kill('SIGTERM');
      }
    } finally {
      checking = false;
    }
  }, 2000);
  timer.unref();
  return () => clearInterval(timer);
}

async function cleanup() {
  save({ stage: 'nettoyage', cleanup: { ...state.cleanup, attempted: true } });
  const env = {
    ALLOW_SMALL_CAPACITY_CANARY: 'YES',
    CAPACITY_USERS: String(users),
    CAPACITY_TWEETS: String(syntheticTweetCount),
    CAPACITY_LIKES_PER_USER: String(likesPerUser),
    CAPACITY_FOLLOWS_PER_USER: String(followsPerUser),
    CONFIRM_CAPACITY_CLEANUP: runId,
  };
  try {
    await runNode(lifecycleScript, ['cleanup', '--run-id', runId], env);
  } catch (error) {
    appendLog('cleanup', `${error.message}\n${error.stderr || ''}\n`);
  }
  try {
    await runNode(lifecycleScript, ['verify', '--run-id', runId], env);
    save({ cleanup: { attempted: true, verified: true } });
  } catch (error) {
    save({ cleanup: { attempted: true, verified: false, error: String(error.stderr || error.message).slice(-2000) } });
  }
}

function handleStop(signal) {
  if (stopping) return;
  stopping = true;
  stopReason = `arret demande (${signal})`;
  save({ status: 'stopping', stage: 'arret_demande', stop_reason: stopReason });
  if (activeChild) activeChild.kill('SIGTERM');
}

process.on('SIGTERM', () => handleStop('SIGTERM'));
process.on('SIGINT', () => handleStop('SIGINT'));

async function main() {
  save();
  const sharedEnv = {
    ALLOW_SMALL_CAPACITY_CANARY: 'YES',
    CAPACITY_USERS: String(users),
    CAPACITY_TWEETS: String(syntheticTweetCount),
    CAPACITY_LIKES_PER_USER: String(likesPerUser),
    CAPACITY_RETWEETS_PER_USER: '1',
    CAPACITY_FOLLOWS_PER_USER: String(followsPerUser),
    CAPACITY_BEHAVIOR_PER_USER: '2',
  };

  try {
    save({ status: 'preparing', stage: 'creation_donnees', started_at: new Date().toISOString() });
    seeded = true;
    await runNode(lifecycleScript, ['seed', '--run-id', runId], {
      ...sharedEnv,
      CONFIRM_CAPACITY_SEED: runId,
    });
    if (stopping) throw new Error(stopReason || 'simulation arretee');

    await waitForStableEdge();
    if (stopping) throw new Error(stopReason || 'simulation arretee');

    save({ status: 'running', stage: 'simulation' });
    const stopGuard = startHealthGuard();
    let benchmark;
    try {
      benchmark = await runNode(benchmarkScript, ['benchmark', '--run-id', runId], {
        ...sharedEnv,
        CONFIRM_CLUSTER_BENCHMARK: runId,
        CLUSTER_VU_STEPS: String(users),
        CLUSTER_STEP_SECONDS: String(durationSeconds),
        CLUSTER_THINK_TIME_MS: String(intervalMs),
        CLUSTER_HARD_P95_MS: '3000',
        CLUSTER_HARD_ERROR_RATE: '0.02',
      }, {
        acceptExitTwo: true,
        onLine: (line) => {
          try {
            const event = JSON.parse(line);
            if (event.event === 'load_step') save({ result: event });
          } catch { /* lignes de progression non JSON */ }
        },
      });
    } finally {
      stopGuard();
    }
    const result = parseFinalJson(benchmark.stdout) || state.result;
    if (stopping) throw new Error(stopReason || 'simulation arretee');
    save({ result, stop_reason: result?.stop_reason || null });
  } catch (error) {
    save({
      status: stopping ? 'aborted' : 'failed',
      error: stopping ? null : String(error.stderr || error.stack || error.message).slice(-5000),
      stop_reason: stopReason || state.stop_reason,
    });
  } finally {
    if (seeded) await cleanup();
    const finalStatus = state.status === 'failed' || state.status === 'aborted'
      ? state.status
      : state.result?.ok === false ? 'completed_with_limits' : 'completed';
    save({ status: finalStatus, stage: 'terminee', pid: null, finished_at: new Date().toISOString() });
  }
}

main().catch((error) => {
  save({ status: 'failed', stage: 'terminee', pid: null, error: String(error.stack || error), finished_at: new Date().toISOString() });
  process.exitCode = 1;
});
