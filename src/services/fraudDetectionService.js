const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// Redis key constants — must match the Rust service
const QUEUES = {
  login:       'fraud:queue:login',
  transaction: 'fraud:queue:transaction',
  request:     'fraud:queue:request',
};

const BLOCKED_IP_PREFIX = 'fraud:blocked:ip:';

// How long (ms) to wait for Rust response before failing open
const TIMEOUT_MS = 250;

class FraudDetectionService {
  constructor() {
    // Publisher — sends requests to Rust
    this._pub = null;
    // Subscriber/reader — reads results back (uses a dedicated connection for BLPOP)
    this._sub = null;
    this._ready = false;
    this._connecting = false;
  }

  async connect(redisConfig = {}) {
    if (this._ready || this._connecting) return;
    this._connecting = true;

    const password = redisConfig.password || process.env.REDIS_PASSWORD || null;
    const auth = password ? `:${password}@` : '';
    const url = `redis://${auth}${redisConfig.host || '127.0.0.1'}:${redisConfig.port || 6379}`;

    try {
      // We need TWO connections: one for publishing (LPUSH) and one for blocking reads (BLPOP).
      // BLPOP blocks the connection, so we can't multiplex it with LPUSH.
      this._pub = createClient({ url });
      this._sub = createClient({ url });

      this._pub.on('error', (e) => logger.warn('[fraud] redis pub error:', e.message));
      this._sub.on('error', (e) => logger.warn('[fraud] redis sub error:', e.message));

      await Promise.all([this._pub.connect(), this._sub.connect()]);
      this._ready = true;
      logger.info('[fraud] FraudDetectionService connected to Redis');
    } catch (e) {
      logger.warn('[fraud] Could not connect to Redis — fraud checks disabled:', e.message);
      this._ready = false;
    } finally {
      this._connecting = false;
    }
  }

  // ─── Fast IP block check (O(1), no round-trip to Rust) ──────────────────────
  async isIpBlocked(ip) {
    if (!this._ready) return false;
    try {
      const val = await this._pub.get(`${BLOCKED_IP_PREFIX}${ip}`);
      return val === '1';
    } catch {
      return false;
    }
  }

  // ─── Core: push to queue, wait for result via BLPOP ─────────────────────────
  async _sendAndWait(queueKey, payload) {
    if (!this._ready) return null;

    const correlationId = uuidv4();
    const resultKey = `fraud:result:${correlationId}`;

    const envelope = JSON.stringify({ correlation_id: correlationId, payload });

    try {
      // Push the request onto the Rust worker's queue
      await this._pub.lPush(queueKey, envelope);

      // Wait for the Rust worker to push the result back (with timeout)
      const result = await Promise.race([
        this._sub.blPop(resultKey, 0),              // blocks until result
        new Promise((resolve) =>
          setTimeout(() => resolve(null), TIMEOUT_MS) // timeout fallback
        ),
      ]);

      if (!result) {
        logger.debug(`[fraud] timeout waiting for result on ${resultKey}`);
        return null;
      }

      return JSON.parse(result.element);
    } catch (e) {
      logger.warn('[fraud] _sendAndWait error:', e.message);
      return null;
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Analyse a login attempt.
   * @param {object} opts
   * @param {string} opts.userId
   * @param {string} opts.ip
   * @param {string} [opts.country]
   * @param {string} [opts.city]
   * @param {number} [opts.latitude]
   * @param {number} [opts.longitude]
   * @param {string} [opts.deviceId]
   * @param {string} [opts.userAgent]
   * @param {boolean} [opts.success]
   * @param {boolean} [opts.mfaUsed]
   * @returns {Promise<FraudResult|null>}
   */
  async analyzeLogin({ userId, ip, country = '', city = '', latitude = 0, longitude = 0,
    deviceId = '', userAgent = '', success = false, mfaUsed = false }) {
    const payload = {
      user_id:    userId,
      ip_address: ip,
      country,
      city,
      latitude,
      longitude,
      device_id:  deviceId,
      user_agent: userAgent,
      success,
      mfa_used:   mfaUsed,
    };
    return this._sendAndWait(QUEUES.login, payload);
  }

  /**
   * Analyse a payment transaction.
   */
  async analyzeTransaction({ userId, ip, amount, currency = 'EUR', merchantId = '',
    merchantName = '', merchantCountry = 'FR', category = '', cardToken = '',
    billingZip = '', shippingZip = null, isOnline = true }) {
    const payload = {
      user_id:          userId,
      ip_address:       ip,
      amount,
      currency,
      merchant_id:      merchantId,
      merchant_name:    merchantName,
      merchant_country: merchantCountry,
      category,
      card_token:       cardToken,
      billing_zip:      billingZip,
      shipping_zip:     shippingZip,
      is_online:        isOnline,
    };
    return this._sendAndWait(QUEUES.transaction, payload);
  }

  /**
   * Analyse an API request.
   */
  async analyzeRequest({ userId, ip, endpoint, method = 'GET', userAgent = '',
    responseCode = 200, payloadSize = 0, queryParams = '', bodySample = '' }) {
    const payload = {
      user_id:       userId,
      ip_address:    ip,
      endpoint,
      method,
      user_agent:    userAgent,
      response_code: responseCode,
      payload_size:  payloadSize,
      query_params:  queryParams,
      body_sample:   bodySample,
    };
    return this._sendAndWait(QUEUES.request, payload);
  }

  // ─── Health check ─────────────────────────────────────────────────────────
  isReady() { return this._ready; }
}

// Singleton
const fraudService = new FraudDetectionService();

module.exports = fraudService;
