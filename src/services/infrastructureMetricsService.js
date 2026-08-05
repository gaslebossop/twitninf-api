'use strict';

const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
let previousCpu = null;

function round(value, precision = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function readCpuPercent() {
  const current = os.cpus().reduce((summary, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: summary.idle + cpu.times.idle, total: summary.total + total };
  }, { idle: 0, total: 0 });
  const prior = previousCpu;
  previousCpu = current;
  if (!prior) return null;
  const totalDelta = current.total - prior.total;
  const idleDelta = current.idle - prior.idle;
  return totalDelta > 0 ? round(100 * (1 - idleDelta / totalDelta), 1) : null;
}

async function command(file, args, options = {}) {
  try {
    const result = await execFileAsync(file, args, {
      timeout: 2500,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
    return { ok: true, stdout: String(result.stdout || '').trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || '').trim(),
      error: String(error.stderr || error.message || 'commande impossible').trim(),
    };
  }
}

async function readPm2Processes() {
  if (process.platform !== 'linux') return [];
  const result = await command('/usr/bin/pm2', ['jlist'], {
    env: { ...process.env, PM2_HOME: process.env.PM2_HOME || '/home/debian/.pm2' },
  });
  if (!result.ok) return [];
  try {
    const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
    return payload
      .filter((item) => String(item.name || '').startsWith('twitninf-api'))
      .map((item) => ({
        name: item.name,
        status: item.pm2_env?.status || 'unknown',
        cpu_percent: Number(item.monit?.cpu || 0),
        memory_mb: round(Number(item.monit?.memory || 0) / 1024 / 1024, 1),
        restarts: Number(item.pm2_env?.restart_time || 0),
        uptime_seconds: item.pm2_env?.pm_uptime
          ? Math.max(0, Math.round((Date.now() - Number(item.pm2_env.pm_uptime)) / 1000))
          : null,
        role: item.pm2_env?.NODE_ROLE || null,
        instance: item.pm2_env?.INSTANCE_ID || null,
        port: Number(item.pm2_env?.PORT || 0) || null,
      }));
  } catch {
    return [];
  }
}

async function readServiceState(unit) {
  if (process.platform !== 'linux') return 'unknown';
  const result = await command('/usr/bin/systemctl', ['is-active', unit]);
  return result.ok ? result.stdout : (result.stdout || 'inactive');
}

async function collectNodeMetrics() {
  const totalMb = os.totalmem() / 1024 / 1024;
  const freeMb = os.freemem() / 1024 / 1024;
  const [processes, nginx, postgresql, redis, recommender, fraud, fraudDetector, autoscaler] = await Promise.all([
    readPm2Processes(),
    readServiceState('nginx.service'),
    readServiceState('postgresql.service'),
    readServiceState('redis-server.service'),
    readServiceState('rust-recommender.service'),
    readServiceState('fraud-dashboard.service'),
    readServiceState('fraude-service-detector.service'),
    readServiceState('twitninf-autoscaler.timer'),
  ]);

  return {
    collected_at: new Date().toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    cpu_percent: readCpuPercent(),
    cpu_count: os.cpus().length,
    load_average: os.loadavg().map((value) => round(value, 2)),
    memory: {
      total_mb: round(totalMb, 0),
      available_mb: round(freeMb, 0),
      used_percent: round(100 * (1 - freeMb / Math.max(1, totalMb)), 1),
    },
    uptime_seconds: Math.round(os.uptime()),
    processes,
    services: { nginx, postgresql, redis, recommender, fraud_dashboard: fraud, fraud_detector: fraudDetector, autoscaler },
    api: {
      role: process.env.NODE_ROLE || 'all',
      instance: process.env.INSTANCE_ID || null,
      port: Number(process.env.PORT || 3001),
      policiercongo_local: process.env.POLICIERCONGO_LOCAL_ENABLED !== 'false',
    },
  };
}

module.exports = { collectNodeMetrics };
