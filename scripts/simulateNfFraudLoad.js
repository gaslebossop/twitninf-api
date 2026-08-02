#!/usr/bin/env node
'use strict';

/**
 * Générateur de charge NF synthétique pour le moteur anti-fraude Rust.
 *
 * Ce script n'appelle aucune route de paiement et n'accède pas à PostgreSQL.
 * Il envoie des faits entièrement synthétiques sur la file Redis interne
 * `fraud:queue:authorize_transaction`, puis mesure les décisions du moteur.
 *
 * Sécurité :
 *   - Redis doit être local (localhost/127.0.0.1/::1) ;
 *   - aucune charge n'est envoyée sans --confirm-synthetic-load ;
 *   - débit, concurrence, comptes et événements ont des plafonds stricts.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { createClient } = require('redis');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const QUEUE = 'fraud:queue:authorize_transaction';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const DEFAULTS = Object.freeze({
  events: 10_000,
  accounts: 500,
  concurrency: 32,
  rate: 250,
  timeoutMs: 5_000,
  seed: 20_260_730,
  fraudRate: 0.35,
  minDetectionRate: 0.90,
  maxLegitimateBlockRate: 0.02,
  report: '',
  dryRun: false,
  confirmed: false,
});

const LIMITS = Object.freeze({
  events: 1_000_000,
  accounts: 100_000,
  concurrency: 200,
  rate: 2_000,
  timeoutMs: 30_000,
});

function usage() {
  console.log(`
Simulation de trafic NF synthétique (aucun vrai paiement)

Usage:
  node scripts/simulateNfFraudLoad.js --dry-run [options]
  node scripts/simulateNfFraudLoad.js --confirm-synthetic-load [options]

Options:
  --events N                    Nombre d'autorisations (défaut: ${DEFAULTS.events}, max: ${LIMITS.events})
  --accounts N                  Comptes synthétiques (défaut: ${DEFAULTS.accounts}, max: ${LIMITS.accounts})
  --concurrency N               Requêtes simultanées (défaut: ${DEFAULTS.concurrency}, max: ${LIMITS.concurrency})
  --rate N                      Débit cible en événements/s (défaut: ${DEFAULTS.rate}, max: ${LIMITS.rate})
  --fraud-rate N                Part des scénarios suspects, entre 0 et 1 (défaut: ${DEFAULTS.fraudRate})
  --timeout-ms N                Délai de réponse par événement (défaut: ${DEFAULTS.timeoutMs})
  --seed N                      Graine déterministe (défaut: ${DEFAULTS.seed})
  --min-detection-rate N        Seuil de réussite des cas suspects (défaut: ${DEFAULTS.minDetectionRate})
  --max-legitimate-block-rate N Seuil de faux blocages légitimes (défaut: ${DEFAULTS.maxLegitimateBlockRate})
  --report PATH                 Écrit aussi le rapport JSON dans PATH
  --dry-run                     Génère le plan sans se connecter à Redis
  --confirm-synthetic-load      Confirmation obligatoire pour envoyer la charge
  --help                        Affiche cette aide

Variables:
  REDIS_URL                     Doit désigner Redis sur la boucle locale
                                (défaut: redis://127.0.0.1:6379)
`);
}

function fail(message) {
  throw new Error(message);
}

function parseInteger(name, raw, min, max) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} doit être un entier entre ${min} et ${max}`);
  }
  return value;
}

function parseRatio(name, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${name} doit être un nombre entre 0 et 1`);
  }
  return value;
}

function parseArgs(argv) {
  const config = { ...DEFAULTS };
  const valueOptions = new Map([
    ['--events', (value) => { config.events = parseInteger('--events', value, 1, LIMITS.events); }],
    ['--accounts', (value) => { config.accounts = parseInteger('--accounts', value, 4, LIMITS.accounts); }],
    ['--concurrency', (value) => { config.concurrency = parseInteger('--concurrency', value, 1, LIMITS.concurrency); }],
    ['--rate', (value) => { config.rate = parseInteger('--rate', value, 1, LIMITS.rate); }],
    ['--timeout-ms', (value) => { config.timeoutMs = parseInteger('--timeout-ms', value, 500, LIMITS.timeoutMs); }],
    ['--seed', (value) => { config.seed = parseInteger('--seed', value, 1, 0x7fffffff); }],
    ['--fraud-rate', (value) => { config.fraudRate = parseRatio('--fraud-rate', value); }],
    ['--min-detection-rate', (value) => { config.minDetectionRate = parseRatio('--min-detection-rate', value); }],
    ['--max-legitimate-block-rate', (value) => { config.maxLegitimateBlockRate = parseRatio('--max-legitimate-block-rate', value); }],
    ['--report', (value) => { config.report = String(value); }],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      config.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      config.dryRun = true;
      continue;
    }
    if (arg === '--confirm-synthetic-load') {
      config.confirmed = true;
      continue;
    }
    const setter = valueOptions.get(arg);
    if (!setter) fail(`Option inconnue: ${arg}`);
    if (index + 1 >= argv.length) fail(`Valeur manquante pour ${arg}`);
    setter(argv[index + 1]);
    index += 1;
  }

  config.concurrency = Math.min(config.concurrency, config.events);
  return config;
}

function safeRedisUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail('REDIS_URL invalide');
  }
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) {
    fail('REDIS_URL doit utiliser redis:// ou rediss://');
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    fail(`Cible Redis refusée (${host}) : seule la boucle locale du VPS est autorisée`);
  }
  return parsed.toString();
}

function redisConnectionOptions() {
  if (process.env.REDIS_URL) {
    return { url: safeRedisUrl(process.env.REDIS_URL) };
  }

  const host = String(process.env.REDIS_HOST || '127.0.0.1').trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    fail(`Cible Redis refusée (${host}) : seule la boucle locale du VPS est autorisée`);
  }
  const port = parseInteger(
    'REDIS_PORT',
    process.env.REDIS_PORT || '6379',
    1,
    65_535
  );
  return {
    socket: { host, port },
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function eventRandom(seed, index) {
  return mulberry32((seed ^ Math.imul(index + 1, 0x9E3779B1)) >>> 0);
}

function chooseScenario(random, fraudRate) {
  if (random() >= fraudRate) return 'legitimate';
  const suspicious = random();
  if (suspicious < 0.30) return 'velocity_burst';
  if (suspicious < 0.55) return 'shared_payment_ring';
  if (suspicious < 0.75) return 'mule_fan_in';
  return 'laundering_cycle';
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function buildEvent(config, runId, index) {
  const random = eventRandom(config.seed, index);
  const scenario = chooseScenario(random, config.fraudRate);
  const senderIndex = index % config.accounts;
  let recipientIndex = Math.floor(random() * config.accounts);
  if (recipientIndex === senderIndex) {
    recipientIndex = (recipientIndex + 1) % config.accounts;
  }

  const authorizationId = `loadtest-${runId}-auth-${index}`;
  const sender = `loadtest-${runId}-account-${senderIndex}`;
  const recipient = `loadtest-${runId}-account-${recipientIndex}`;
  const amount = round(8 + random() * 18, 4);

  const payload = {
    authorization_id: authorizationId,
    request_hash: sha256(`${runId}:${index}:${scenario}:${sender}:${recipient}:${amount}`),
    user_id: sender,
    transaction_kind: 'p2p_transfer',
    direction: 'outbound',
    amount,
    amount_eur: round(amount * 10, 4),
    currency_id: 'synthetic-nf',
    counterparty_user_id: recipient,
    merchant_id: 'synthetic-p2p-load-test',
    payment_fingerprint: `loadtest-payment-${senderIndex}`,
    device_fingerprint: `loadtest-device-${senderIndex}`,
    ip_fingerprint: `loadtest-ip-${senderIndex}`,
    account: {
      age_days: 180 + Math.floor(random() * 720),
      verified: true,
      email_verified: true,
      phone_verified: random() > 0.2,
      suspended: false,
      last_activity_age_hours: 1 + random() * 12,
    },
    wallet: {
      exists: true,
      locked: false,
      balance: 1_000,
      total_earned: 2_500,
      total_spent: 1_500,
      total_purchased: 800,
      age_days: 180,
    },
    history: {
      completed_count: 60,
      outbound_count: 30,
      count_10m: random() > 0.5 ? 0 : 1,
      count_1h: 1,
      count_24h: 2,
      avg_daily_count_30d: 2,
      median_amount_eur: 150,
      mad_amount_eur: 55,
      p95_amount_eur: 420,
      hours_since_last_transaction: 8,
      failed_count_24h: 0,
    },
    network: {
      recipient_account_age_days: 300,
      recipient_is_restricted: false,
      recipient_unique_senders_7d: 1,
      sender_unique_recipients_7d: 3,
      reciprocal_amount_ratio_24h: 0,
      shortest_cycle_length_7d: 0,
      rapid_forward_ratio_24h: 0,
    },
    fingerprints: {
      device_seen_before: true,
      ip_seen_before: true,
      payment_seen_before: true,
      device_account_count_30d: 1,
      ip_account_count_24h: 1,
      payment_account_count_30d: 1,
    },
    prior_risk: {
      state: 'CLEAR',
      rolling_score: 0,
      authorizations_24h: 2,
      declines_24h: 0,
      reviews_7d: 0,
      replay_mismatches_30d: 0,
    },
  };

  if (scenario === 'velocity_burst') {
    payload.history.count_10m = 8 + Math.floor(random() * 8);
    payload.history.count_1h = 20;
    payload.history.count_24h = 35;
    payload.history.failed_count_24h = 2 + Math.floor(random() * 3);
  } else if (scenario === 'shared_payment_ring') {
    payload.history.count_10m = 4 + Math.floor(random() * 4);
    payload.fingerprints.device_account_count_30d = 5 + Math.floor(random() * 5);
    payload.fingerprints.payment_account_count_30d = 4 + Math.floor(random() * 5);
    payload.fingerprints.ip_account_count_24h = 8;
    payload.device_fingerprint = 'loadtest-shared-ring-device';
    payload.payment_fingerprint = 'loadtest-shared-ring-payment';
    payload.ip_fingerprint = 'loadtest-shared-ring-ip';
  } else if (scenario === 'mule_fan_in') {
    payload.amount = round(180 + random() * 120, 4);
    payload.amount_eur = round(payload.amount * 10, 4);
    payload.network.recipient_account_age_days = 1 + random() * 3;
    payload.network.recipient_unique_senders_7d = 10 + Math.floor(random() * 20);
    payload.network.sender_unique_recipients_7d = 14;
    payload.network.rapid_forward_ratio_24h = 0.82 + random() * 0.12;
    payload.fingerprints.ip_account_count_24h = 9;
    payload.fingerprints.device_account_count_30d = 2;
  } else if (scenario === 'laundering_cycle') {
    payload.amount = round(250 + random() * 300, 4);
    payload.amount_eur = round(payload.amount * 10, 4);
    payload.network.shortest_cycle_length_7d = 2 + Math.floor(random() * 2);
    payload.network.reciprocal_amount_ratio_24h = 0.85 + random() * 0.1;
    payload.network.rapid_forward_ratio_24h = 0.88 + random() * 0.1;
    payload.fingerprints.device_account_count_30d = 4;
    payload.device_fingerprint = 'loadtest-laundering-device';
  }

  return {
    correlationId: `nf-load-${runId}-${index}`,
    expectedRequestHash: payload.request_hash,
    scenario,
    suspicious: scenario !== 'legitimate',
    severe: scenario === 'shared_payment_ring' || scenario === 'laundering_cycle',
    payload,
  };
}

function emptyCounter() {
  return {
    sent: 0,
    responses: 0,
    APPROVE: 0,
    MONITOR: 0,
    REVIEW: 0,
    DECLINE: 0,
    errors: 0,
  };
}

function createStats() {
  return {
    total: emptyCounter(),
    scenarios: new Map(),
    suspiciousResponses: 0,
    suspiciousDetected: 0,
    legitimateResponses: 0,
    legitimateBlocked: 0,
    severeResponses: 0,
    severeFrozen: 0,
    integrityMismatches: 0,
    latenciesMs: [],
    errors: [],
  };
}

function scenarioCounter(stats, name) {
  if (!stats.scenarios.has(name)) stats.scenarios.set(name, emptyCounter());
  return stats.scenarios.get(name);
}

function recordSent(stats, event) {
  stats.total.sent += 1;
  scenarioCounter(stats, event.scenario).sent += 1;
}

function recordError(stats, event, error) {
  stats.total.errors += 1;
  scenarioCounter(stats, event.scenario).errors += 1;
  if (stats.errors.length < 20) {
    stats.errors.push({
      correlationId: event.correlationId,
      scenario: event.scenario,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordDecision(stats, event, decision, latencyMs) {
  const verdict = String(decision.decision || '').toUpperCase();
  if (!['APPROVE', 'MONITOR', 'REVIEW', 'DECLINE'].includes(verdict)) {
    recordError(stats, event, new Error(`Décision inconnue: ${verdict || '(vide)'}`));
    return;
  }

  stats.total.responses += 1;
  stats.total[verdict] += 1;
  const counter = scenarioCounter(stats, event.scenario);
  counter.responses += 1;
  counter[verdict] += 1;
  stats.latenciesMs.push(latencyMs);

  if (
    decision.authorization_id !== event.payload.authorization_id
    || decision.request_hash !== event.expectedRequestHash
  ) {
    stats.integrityMismatches += 1;
  }

  if (event.suspicious) {
    stats.suspiciousResponses += 1;
    if (verdict !== 'APPROVE') stats.suspiciousDetected += 1;
  } else {
    stats.legitimateResponses += 1;
    if (verdict === 'REVIEW' || verdict === 'DECLINE') {
      stats.legitimateBlocked += 1;
    }
  }

  if (event.severe) {
    stats.severeResponses += 1;
    if (decision.wallet_action === 'FREEZE') stats.severeFrozen += 1;
  }
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return round(sorted[Math.max(0, index)], 2);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function publicConfig(config) {
  return {
    events: config.events,
    accounts: config.accounts,
    concurrency: config.concurrency,
    rate: config.rate,
    timeoutMs: config.timeoutMs,
    seed: config.seed,
    fraudRate: config.fraudRate,
    minDetectionRate: config.minDetectionRate,
    maxLegitimateBlockRate: config.maxLegitimateBlockRate,
  };
}

function buildReport(config, stats, runId, durationMs, mode) {
  const scenarios = {};
  const sortedLatencies = [...stats.latenciesMs].sort((a, b) => a - b);
  for (const [name, counter] of [...stats.scenarios.entries()].sort()) {
    scenarios[name] = counter;
  }

  return {
    runId,
    mode,
    generatedAt: new Date().toISOString(),
    safety: {
      syntheticOnly: true,
      paymentApiCalled: false,
      databaseAccessed: false,
      redisTargetPolicy: 'loopback-only',
    },
    config: publicConfig(config),
    durationSeconds: round(durationMs / 1_000, 3),
    achievedRate: durationMs > 0 ? round(stats.total.responses / (durationMs / 1_000), 2) : 0,
    transport: {
      sent: stats.total.sent,
      responses: stats.total.responses,
      errors: stats.total.errors,
      errorRate: round(ratio(stats.total.errors, stats.total.sent), 4),
      integrityMismatches: stats.integrityMismatches,
    },
    decisions: {
      APPROVE: stats.total.APPROVE,
      MONITOR: stats.total.MONITOR,
      REVIEW: stats.total.REVIEW,
      DECLINE: stats.total.DECLINE,
    },
    quality: {
      suspiciousDetectionRate: round(
        ratio(stats.suspiciousDetected, stats.suspiciousResponses),
        4
      ),
      legitimateBlockRate: round(
        ratio(stats.legitimateBlocked, stats.legitimateResponses),
        4
      ),
      severeFreezeRate: round(ratio(stats.severeFrozen, stats.severeResponses), 4),
    },
    latencyMs: {
      p50: percentile(sortedLatencies, 0.50),
      p95: percentile(sortedLatencies, 0.95),
      p99: percentile(sortedLatencies, 0.99),
      max: sortedLatencies.length > 0 ? round(sortedLatencies.at(-1), 2) : 0,
    },
    scenarios,
    sampleErrors: stats.errors,
  };
}

function printPlan(config) {
  const previewStats = new Map();
  const previewRunId = 'preview';
  for (let index = 0; index < config.events; index += 1) {
    const event = buildEvent(config, previewRunId, index);
    previewStats.set(event.scenario, (previewStats.get(event.scenario) || 0) + 1);
  }

  console.log('\nPlan de charge NF synthétique');
  console.log('----------------------------------------');
  console.log(`Événements       : ${config.events.toLocaleString('fr-FR')}`);
  console.log(`Comptes          : ${config.accounts.toLocaleString('fr-FR')}`);
  console.log(`Débit cible      : ${config.rate.toLocaleString('fr-FR')} événements/s`);
  console.log(`Concurrence      : ${config.concurrency}`);
  console.log(`Durée théorique  : ${round(config.events / config.rate, 1)} s`);
  console.log(`Graine           : ${config.seed}`);
  console.log('Scénarios        :');
  for (const [name, count] of [...previewStats.entries()].sort()) {
    console.log(`  - ${name.padEnd(21)} ${count.toLocaleString('fr-FR')}`);
  }
  console.log('\nAucun paiement, solde ou compte réel ne sera utilisé.');
}

async function runWorker({
  client,
  config,
  runId,
  stats,
  nextIndex,
  startedAt,
  stopRequested,
}) {
  const timeoutSeconds = Math.max(1, Math.ceil(config.timeoutMs / 1_000));

  while (!stopRequested.value) {
    const index = nextIndex.value;
    nextIndex.value += 1;
    if (index >= config.events) break;

    const scheduledAt = startedAt + (index * 1_000) / config.rate;
    const waitMs = scheduledAt - performance.now();
    if (waitMs > 1) await sleep(waitMs);
    if (stopRequested.value) break;

    const event = buildEvent(config, runId, index);
    const envelope = JSON.stringify({
      correlation_id: event.correlationId,
      payload: event.payload,
    });
    const resultKey = `fraud:result:${event.correlationId}`;
    recordSent(stats, event);

    const requestStartedAt = performance.now();
    try {
      await client.lPush(QUEUE, envelope);
      const response = await client.brPop(resultKey, timeoutSeconds);
      if (!response) {
        recordError(stats, event, new Error(`timeout après ${config.timeoutMs} ms`));
        continue;
      }
      let decision;
      try {
        decision = JSON.parse(response.element);
      } catch {
        recordError(stats, event, new Error('réponse JSON invalide'));
        continue;
      }
      if (decision.error) {
        recordError(stats, event, new Error(`moteur: ${decision.error}`));
        continue;
      }
      recordDecision(stats, event, decision, performance.now() - requestStartedAt);
    } catch (error) {
      recordError(stats, event, error);
    }
  }
}

async function executeLoad(config) {
  const redisOptions = redisConnectionOptions();
  const rootClient = createClient({
    ...redisOptions,
    socket: {
      ...(redisOptions.socket || {}),
      connectTimeout: 3_000,
      reconnectStrategy: false,
    },
  });
  const redisErrors = [];
  rootClient.on('error', (error) => {
    if (redisErrors.length < 5) redisErrors.push(error.message);
  });

  await rootClient.connect();
  const pong = await rootClient.ping();
  if (pong !== 'PONG') fail('Redis local ne répond pas correctement');

  const workerClients = [];
  try {
    for (let index = 0; index < config.concurrency; index += 1) {
      const client = rootClient.duplicate();
      client.on('error', (error) => {
        if (redisErrors.length < 5) redisErrors.push(error.message);
      });
      await client.connect();
      workerClients.push(client);
    }

    const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
    const stats = createStats();
    const nextIndex = { value: 0 };
    const stopRequested = { value: false };
    const startedAt = performance.now();

    const handleSignal = () => {
      stopRequested.value = true;
      console.error('\nArrêt demandé : les événements déjà en vol se terminent.');
    };
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);

    console.log(`\nCharge démarrée — run ${runId}`);
    console.log(`File interne: ${QUEUE} | Redis: boucle locale uniquement`);

    const progressTimer = setInterval(() => {
      const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1_000);
      const completed = stats.total.responses + stats.total.errors;
      const percent = round((completed / config.events) * 100, 1);
      const currentRate = round(completed / elapsedSeconds, 1);
      console.log(
        `[${percent.toFixed(1)}%] ${completed.toLocaleString('fr-FR')}/${config.events.toLocaleString('fr-FR')} `
        + `| ${currentRate}/s | erreurs=${stats.total.errors}`
      );
    }, 5_000);
    progressTimer.unref();

    try {
      await Promise.all(workerClients.map((client) => runWorker({
        client,
        config,
        runId,
        stats,
        nextIndex,
        startedAt,
        stopRequested,
      })));
    } finally {
      clearInterval(progressTimer);
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
    }

    const durationMs = performance.now() - startedAt;
    const report = buildReport(config, stats, runId, durationMs, 'redis-worker');
    if (redisErrors.length > 0) report.redisErrors = redisErrors;
    return report;
  } finally {
    await Promise.allSettled(workerClients.map((client) => client.quit()));
    if (rootClient.isOpen) await rootClient.quit();
  }
}

function printReport(report) {
  console.log('\nRapport anti-fraude NF');
  console.log('----------------------------------------');
  console.log(`Run              : ${report.runId}`);
  console.log(`Réponses         : ${report.transport.responses.toLocaleString('fr-FR')}/${report.transport.sent.toLocaleString('fr-FR')}`);
  console.log(`Débit obtenu     : ${report.achievedRate.toLocaleString('fr-FR')}/s`);
  console.log(`Erreurs transport: ${(report.transport.errorRate * 100).toFixed(2)}%`);
  console.log(`Décisions        : APPROVE=${report.decisions.APPROVE} MONITOR=${report.decisions.MONITOR} REVIEW=${report.decisions.REVIEW} DECLINE=${report.decisions.DECLINE}`);
  console.log(`Détection suspect: ${(report.quality.suspiciousDetectionRate * 100).toFixed(2)}%`);
  console.log(`Blocage légitime : ${(report.quality.legitimateBlockRate * 100).toFixed(2)}%`);
  console.log(`Gel cas sévères  : ${(report.quality.severeFreezeRate * 100).toFixed(2)}%`);
  console.log(`Latence          : p50=${report.latencyMs.p50} ms p95=${report.latencyMs.p95} ms p99=${report.latencyMs.p99} ms max=${report.latencyMs.max} ms`);
  if (report.transport.integrityMismatches > 0) {
    console.log(`Anomalies intégrité: ${report.transport.integrityMismatches}`);
  }
  if (report.sampleErrors.length > 0) {
    console.log('Premières erreurs:');
    for (const error of report.sampleErrors.slice(0, 5)) {
      console.log(`  - ${error.scenario}: ${error.error}`);
    }
  }
}

function evaluateReport(config, report) {
  const failures = [];
  if (report.transport.errorRate > 0.01) {
    failures.push(`taux d'erreur transport ${(report.transport.errorRate * 100).toFixed(2)}% > 1%`);
  }
  if (report.transport.integrityMismatches > 0) {
    failures.push(`${report.transport.integrityMismatches} réponse(s) avec identifiant/hash incohérent`);
  }
  if (report.quality.suspiciousDetectionRate < config.minDetectionRate) {
    failures.push(
      `détection suspecte ${(report.quality.suspiciousDetectionRate * 100).toFixed(2)}% `
      + `< ${(config.minDetectionRate * 100).toFixed(2)}%`
    );
  }
  if (report.quality.legitimateBlockRate > config.maxLegitimateBlockRate) {
    failures.push(
      `blocage légitime ${(report.quality.legitimateBlockRate * 100).toFixed(2)}% `
      + `> ${(config.maxLegitimateBlockRate * 100).toFixed(2)}%`
    );
  }
  return failures;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    usage();
    return;
  }

  printPlan(config);
  if (config.dryRun) {
    console.log('\nMode aperçu terminé : aucune connexion Redis effectuée.');
    return;
  }
  if (!config.confirmed) {
    fail('Charge annulée : ajoutez --confirm-synthetic-load après avoir vérifié le plan');
  }

  const report = await executeLoad(config);
  printReport(report);

  if (config.report) {
    fs.writeFileSync(config.report, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    console.log(`Rapport JSON écrit: ${config.report}`);
  }

  const failures = evaluateReport(config, report);
  if (failures.length > 0) {
    console.error('\nTEST ÉCHOUÉ');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 2;
  } else {
    console.log('\nTEST RÉUSSI — seuils de transport et de détection respectés.');
  }
}

main().catch((error) => {
  console.error(`\nErreur: ${error.message}`);
  process.exitCode = 1;
});
