'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const express = require('express');
const { authenticateToken, requireAdminRole } = require('../middleware/authMiddleware');
const { collectNodeMetrics } = require('../services/infrastructureMetricsService');
const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);
const router = express.Router();
const RUN_ID_RE = /^capacity-\d{8}T\d{6}-[a-f0-9]{6}$/;
const REPLICA_RE = /^c(?:[1-9]|[12]\d|3[0-2])$/;
const DEFAULT_MAX_REPLICAS = 32;
const ACTIVE_JOB_STATES = new Set(['preparing', 'running', 'stopping']);
const REPORT_DIRECTORY = path.resolve(__dirname, '../../reports/admin-load');
const CURRENT_JOB_FILE = path.join(REPORT_DIRECTORY, 'current.json');
const SUPERVISOR_SCRIPT = path.resolve(__dirname, '../../scripts/adminLoadSimulation.js');
const AUTOSCALER = '/usr/local/sbin/twitninf-autoscaler';
const AUTOSCALER_UPSTREAMS = '/etc/nginx/twitninf-autoscale-upstreams.conf';
const AUTOSCALER_CACHE_MS = 1500;
let lastAutoscalerStatus = null;
let lastAutoscalerStatusAt = 0;
let autoscalerStatusPromise = null;

router.use(authenticateToken, requireAdminRole);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, payload) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function processExists(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 2) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function currentJob() {
  const job = readJson(CURRENT_JOB_FILE);
  if (!job) return null;
  if (ACTIVE_JOB_STATES.has(job.status) && !processExists(job.pid)) {
    return { ...job, status: 'failed', stage: 'processus_interrompu', pid: null, error: 'Le superviseur ne tourne plus.' };
  }
  return job;
}

function parseAutoscalerOutput(output) {
  const lines = String(output || '').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const payload = JSON.parse(line);
      if (payload.event === 'status') return payload;
    } catch { /* sortie sudo/pm2 non JSON */ }
  }
  return null;
}

async function autoscalerStatus() {
  if (process.platform !== 'linux') return null;
  if (lastAutoscalerStatus && Date.now() - lastAutoscalerStatusAt < AUTOSCALER_CACHE_MS) {
    return lastAutoscalerStatus;
  }
  if (autoscalerStatusPromise) return autoscalerStatusPromise;
  autoscalerStatusPromise = (async () => {
    try {
      const { stdout } = await execFileAsync('/usr/bin/sudo', ['-n', AUTOSCALER, '--status'], {
        timeout: 6000,
        maxBuffer: 1024 * 1024,
      });
      const status = parseAutoscalerOutput(stdout);
      if (status) {
        lastAutoscalerStatus = status;
        lastAutoscalerStatusAt = Date.now();
      }
      // Pendant un scale-out le verrou est occupe. Garder le dernier etat connu
      // evite d'afficher tous les C comme arretes pendant leur demarrage.
      return status || lastAutoscalerStatus;
    } catch (error) {
      logger.warn('[infrastructure] statut autoscaler indisponible', { error: error.message });
      return lastAutoscalerStatus;
    } finally {
      autoscalerStatusPromise = null;
    }
  })();
  return autoscalerStatusPromise;
}

async function remoteNodeMetrics() {
  const secret = String(process.env.INTERNAL_SECRET || '');
  if (!secret) return null;
  const url = process.env.INFRASTRUCTURE_NODE_B_URL || 'http://10.8.0.2:3001/api/internal/infrastructure/node';
  try {
    const response = await axios.get(url, {
      headers: { 'x-internal-secret': secret },
      timeout: 2500,
      validateStatus: (status) => status === 200,
    });
    return response.data?.node || null;
  } catch (error) {
    logger.warn('[infrastructure] metriques du noeud B indisponibles', { error: error.message });
    return null;
  }
}

function trafficOf(autoscaler, id) {
  const raw = autoscaler?.backends?.[id] || {};
  return {
    requests_30s: Number(raw.requests || 0),
    requests_per_second: Math.round(Number(raw.requests || 0) / 30 * 100) / 100,
    p95_ms: Math.round(Number(raw.p95_seconds || 0) * 100000) / 100,
    error_rate: Number(raw.error_rate || 0),
  };
}

function processFor(metrics, name, port) {
  return metrics?.processes?.find((item) => item.name === name || (port != null && item.port === port)) || null;
}

function configuredReplicas() {
  try {
    const content = fs.readFileSync(AUTOSCALER_UPSTREAMS, 'utf8');
    return [...content.matchAll(/#\s*(c(?:[1-9]|[12]\d|3[0-2]))\b/gi)].map((match) => match[1].toUpperCase());
  } catch {
    return [];
  }
}

function buildNodes(local, remote, autoscaler) {
  const active = new Set((autoscaler?.active_replicas || configuredReplicas()).map((value) => String(value).toUpperCase()));
  const nodes = [
    {
      id: 'A', label: 'VPS A', kind: 'principal', host: 'A', online: Boolean(local),
      cpu_percent: local?.cpu_percent ?? null, memory: local?.memory || null,
      process: processFor(local, 'twitninf-api', 3001), traffic: trafficOf(autoscaler, 'A'),
    },
    {
      id: 'B', label: 'VPS B', kind: 'secondaire', host: 'B', online: Boolean(remote),
      cpu_percent: remote?.cpu_percent ?? null, memory: remote?.memory || null,
      process: processFor(remote, 'twitninf-api', 3001), traffic: trafficOf(autoscaler, 'B'),
    },
  ];
  const replicaIndexes = new Set([1, 2, 3]);
  for (const id of active) {
    const match = id.match(/^C(\d+)$/);
    if (match) replicaIndexes.add(Number(match[1]));
  }
  for (const process of local?.processes || []) {
    const match = String(process.name || '').match(/^twitninf-api-c(\d+)$/);
    if (match) replicaIndexes.add(Number(match[1]));
  }
  for (const index of [...replicaIndexes].sort((a, b) => a - b)) {
    const id = `C${index}`;
    const proc = processFor(local, `twitninf-api-c${index}`, null);
    nodes.push({
      id, label: id, kind: 'replica_elastique', host: 'A', online: active.has(id) && proc?.status === 'online',
      cpu_percent: proc?.cpu_percent ?? null,
      memory: proc ? { total_mb: proc.memory_mb, available_mb: null, used_percent: null } : null,
      process: proc, traffic: trafficOf(autoscaler, id),
    });
  }
  return nodes;
}

function buildServices(local, remote, nodes) {
  const webNodes = nodes.filter((node) => node.online).map((node) => node.id);
  const active = (value) => value === 'active';
  return [
    { id: 'web', name: 'API web', nodes: webNodes, detail: 'Trafic utilisateur reparti par Nginx' },
    { id: 'edge', name: 'Nginx / load balancer', nodes: active(local?.services?.nginx) ? ['A'] : [], detail: 'Point d entree public' },
    { id: 'worker', name: 'Worker + PolicierCongo', nodes: processFor(local, 'twitninf-worker', 3004)?.status === 'online' ? ['A'] : [], detail: 'Analyse semantique et tendances' },
    { id: 'postgres', name: 'PostgreSQL', nodes: [
      ...(active(local?.services?.postgresql) ? ['A (primaire)'] : []),
      ...(active(remote?.services?.postgresql) ? ['B (replica)'] : []),
    ], detail: 'Ecriture sur A, lectures lourdes possibles sur B' },
    { id: 'redis', name: 'Redis', nodes: active(local?.services?.redis) ? ['A'] : [], detail: 'Cache et coordination du cluster' },
    { id: 'recommender', name: 'Recommandeur Rust', nodes: active(local?.services?.recommender) ? ['A'] : [], detail: 'Classement neural et tracking CTR' },
    { id: 'fraud', name: 'Detection fraude Rust', nodes: active(local?.services?.fraud_detector) || active(local?.services?.fraud_dashboard) ? ['A'] : [], detail: 'Detection temps reel et tableau de bord fraude' },
    { id: 'autoscaler', name: 'Autoscaler C dynamiques', nodes: active(local?.services?.autoscaler) ? ['A'] : [], detail: 'Cree ou retire les replicas web selon la charge et la RAM' },
  ];
}

function validateLoad(body) {
  const users = Number(body.users);
  const duration = Number(body.duration_seconds);
  const interval = Number(body.interval_ms);
  if (!Number.isInteger(users) || users < 1 || users > 10000) return { error: 'users doit etre entre 1 et 10000' };
  if (!Number.isInteger(duration) || duration < 5 || duration > 300) return { error: 'duration_seconds doit etre entre 5 et 300' };
  if (!Number.isInteger(interval) || interval < 1000 || interval > 60000) return { error: 'interval_ms doit etre entre 1000 et 60000' };
  const estimatedRps = Math.round(users * 1000 / interval * 100) / 100;
  if (estimatedRps > 1000) return { error: 'Le plafond de securite est de 1000 requetes/s' };
  if (String(body.confirmation || '') !== `SIMULER ${users}`) return { error: `Tapez exactement SIMULER ${users}` };
  return { users, duration, interval, estimatedRps };
}

function makeRunId() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  return `capacity-${timestamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function spawnAutoscaler(flag, replica = null) {
  const args = ['-n', AUTOSCALER, flag];
  if (replica) args.push(replica);
  const child = spawn('/usr/bin/sudo', args, { detached: true, stdio: 'ignore' });
  child.unref();
}

router.get('/status', async (_req, res) => {
  try {
    const [local, remote, autoscaler] = await Promise.all([
      collectNodeMetrics(), remoteNodeMetrics(), autoscalerStatus(),
    ]);
    const nodes = buildNodes(local, remote, autoscaler);
    const activeReplicas = nodes.filter((node) => node.kind === 'replica_elastique' && node.online).map((node) => node.id.toLowerCase());
    return res.json({
      success: true,
      collected_at: new Date().toISOString(),
      nodes,
      services: buildServices(local, remote, nodes),
      cluster: {
        active_replicas: activeReplicas,
        max_replicas: Number(autoscaler?.max_replicas || DEFAULT_MAX_REPLICAS),
        additional_replica_capacity: Number(autoscaler?.additional_replica_capacity || 0),
        memory_available_mb: Number(autoscaler?.memory_available_mb || local?.memory?.available_mb || 0),
        memory_reserved_mb: Number(autoscaler?.memory_reserved_mb || 2500),
        replica_memory_budget_mb: Number(autoscaler?.replica_memory_budget_mb || 512),
        total_requests_30s: Number(autoscaler?.all?.requests || 0),
        p95_ms: Math.round(Number(autoscaler?.all?.p95_seconds || 0) * 100000) / 100,
        error_rate: Number(autoscaler?.all?.error_rate || 0),
        a_online: Boolean(local), b_online: Boolean(remote),
      },
      load_test: currentJob(),
      limits: { max_users: 10000, max_duration_seconds: 300, min_interval_ms: 1000, max_estimated_rps: 1000 },
    });
  } catch (error) {
    logger.error('[infrastructure] lecture du cluster impossible', { error: error.stack || error.message });
    return res.status(503).json({ success: false, message: 'Etat du cluster indisponible' });
  }
});

router.post('/load-tests', (req, res) => {
  const existing = currentJob();
  if (existing && ACTIVE_JOB_STATES.has(existing.status)) {
    return res.status(409).json({ success: false, message: 'Une simulation est deja en cours', load_test: existing });
  }
  const validated = validateLoad(req.body || {});
  if (validated.error) return res.status(400).json({ success: false, message: validated.error });
  fs.mkdirSync(REPORT_DIRECTORY, { recursive: true });
  const id = makeRunId();
  const child = spawn(process.execPath, [
    SUPERVISOR_SCRIPT,
    '--run-id', id,
    '--users', String(validated.users),
    '--duration', String(validated.duration),
    '--interval', String(validated.interval),
  ], { cwd: path.resolve(__dirname, '../..'), detached: true, stdio: 'ignore' });
  child.unref();
  // Reserve le slot avant de repondre : deux clics rapproches ne peuvent pas
  // demarrer deux superviseurs pendant que le premier initialise son fichier.
  if (readJson(CURRENT_JOB_FILE)?.id !== id) {
    writeJsonAtomic(CURRENT_JOB_FILE, {
      id, pid: child.pid, status: 'preparing', stage: 'initialisation',
      users: validated.users, duration_seconds: validated.duration,
      interval_ms: validated.interval, estimated_rps: validated.estimatedRps,
      created_at: new Date().toISOString(), started_at: null, finished_at: null,
      cleanup: { attempted: false, verified: false }, result: null, error: null, stop_reason: null,
    });
  }
  logger.warn('[infrastructure] simulation de charge lancee', {
    admin_id: req.user.id, run_id: id, users: validated.users,
    duration_seconds: validated.duration, interval_ms: validated.interval,
    estimated_rps: validated.estimatedRps,
  });
  return res.status(202).json({ success: true, id, pid: child.pid });
});

router.post('/load-tests/:id/stop', (req, res) => {
  if (!RUN_ID_RE.test(req.params.id)) return res.status(400).json({ success: false, message: 'Identifiant invalide' });
  const job = currentJob();
  if (!job || job.id !== req.params.id || !ACTIVE_JOB_STATES.has(job.status) || !processExists(job.pid)) {
    return res.status(409).json({ success: false, message: 'Cette simulation ne tourne pas' });
  }
  process.kill(Number(job.pid), 'SIGTERM');
  logger.warn('[infrastructure] arret de simulation demande', { admin_id: req.user.id, run_id: job.id });
  return res.status(202).json({ success: true, message: 'Arret et nettoyage demandes' });
});

router.post('/replicas/scale-out', (req, res) => {
  spawnAutoscaler('--force-up');
  logger.warn('[infrastructure] scale-out manuel', { admin_id: req.user.id });
  return res.status(202).json({ success: true, message: 'Creation du prochain replica demandee' });
});

router.post('/replicas/:id/:action', (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  const action = String(req.params.action || '').toLowerCase();
  if (!REPLICA_RE.test(id) || !['start', 'restart'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Action ou replica invalide' });
  }
  spawnAutoscaler(`--${action}`, id);
  logger.warn('[infrastructure] action replica', { admin_id: req.user.id, replica: id, action });
  return res.status(202).json({ success: true, message: `${action} demande pour ${id.toUpperCase()}` });
});

router.delete('/replicas/:id', (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!REPLICA_RE.test(id)) return res.status(400).json({ success: false, message: 'Replica invalide' });
  spawnAutoscaler('--delete', id);
  logger.warn('[infrastructure] suppression replica', { admin_id: req.user.id, replica: id });
  return res.status(202).json({ success: true, message: `Suppression demandee pour ${id.toUpperCase()}` });
});

module.exports = router;
module.exports.validateLoad = validateLoad;
