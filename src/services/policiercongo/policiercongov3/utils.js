'use strict';

const crypto = require('crypto');

function clip(value, max = 8000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 48))}\n…[tronqué ${text.length - max + 48} caractères]`;
}

function safeJson(value, max = 30000) {
  try {
    return clip(JSON.stringify(value, jsonReplacer), max);
  } catch (error) {
    return JSON.stringify({ error: 'serialization_failed', message: error.message });
  }
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

function newId(prefix = 'pc3') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function abortError() {
  const error = new Error('Opération annulée');
  error.name = 'AbortError';
  return error;
}

async function withTimeout(promiseOrFactory, timeoutMs, label = 'operation', signal) {
  if (signal?.aborted) throw abortError();
  let timeout;
  const task = typeof promiseOrFactory === 'function' ? promiseOrFactory() : promiseOrFactory;
  const timed = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timeout après ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([task, timed]);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function redact(value) {
  if (!value || typeof value !== 'object') return value;
  const secretPattern = /(token|secret|password|authorization|cookie|api[_-]?key)/i;
  if (Array.isArray(value)) return value.map(redact);
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    clean[key] = secretPattern.test(key) ? '[redacted]' : redact(item);
  }
  return clean;
}

function asPlain(value) {
  if (value === null || value === undefined) return value;
  if (typeof value.toJSON === 'function') return value.toJSON();
  return JSON.parse(JSON.stringify(value, jsonReplacer));
}

class KeyedLock {
  constructor() {
    this.tails = new Map();
  }

  async run(key, task) {
    const lockKey = String(key || 'global');
    const previous = this.tails.get(lockKey) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.tails.set(lockKey, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(lockKey) === tail) this.tails.delete(lockKey);
    }
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

module.exports = {
  clip,
  safeJson,
  stableStringify,
  hash,
  newId,
  delay,
  withTimeout,
  normalizeWhitespace,
  redact,
  asPlain,
  KeyedLock,
  mapWithConcurrency,
  abortError
};
