const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// Redis key constants — must match the Rust service
const QUEUES = {
  login:       'fraud:queue:login',
  transaction: 'fraud:queue:transaction',
  request:     'fraud:queue:request',
  authorize:   'fraud:queue:authorize_transaction',
};

const BLOCKED_IP_PREFIX = 'fraud:blocked:ip:';

// How long (seconds) to wait for Rust response before failing open.
// Timeout appliqué CÔTÉ REDIS (BLPOP) → la connexion se libère seule, pas de
// blocage orphelin côté Node. 0.25s = budget de latence sur le login.
const TIMEOUT_S = 0.25;
// Purchases are fail-closed and may need database-derived graph analysis before
// Rust answers. This budget is intentionally separate from navigation/login.
const AUTHORIZATION_TIMEOUT_S = 2;

// Nombre de connexions de lecture dédiées au BLPOP. Un BLPOP bloque sa connexion ;
// un petit pool round-robin évite le head-of-line blocking quand plusieurs
// logins/paiements sont analysés en parallèle, sans ouvrir une connexion par requête.
const READER_POOL_SIZE = 6;

class FraudDetectionService {
  constructor() {
    // Publisher — sends requests to Rust (LPUSH, GET)
    this._pub = null;
    // Pool de connexions de lecture pour BLPOP (résultats Rust)
    this._readers = [];
    this._rr = 0; // index round-robin
    this._ready = false;
    this._connecting = false;
    this._redisConfig = {};
    this._reconnectTimer = null;
    this._retryDelayMs = 1000;
  }

  async connect(redisConfig = {}) {
    this._redisConfig = { ...this._redisConfig, ...redisConfig };
    if (this._ready || this._connecting) return;
    this._connecting = true;

    const password = this._redisConfig.password || process.env.REDIS_PASSWORD || null;
    const auth = password ? `:${password}@` : '';
    const url = `redis://${auth}${this._redisConfig.host || '127.0.0.1'}:${this._redisConfig.port || 6379}`;

    try {
      // 1 connexion d'écriture (LPUSH/GET) + un pool de lecteurs (BLPOP).
      // BLPOP bloque sa connexion : on ne peut pas le multiplexer avec LPUSH.
      this._pub = createClient({ url });
      this._pub.on('error', (e) => logger.warn('[fraud] redis pub error:', e.message));

      this._readers = [];
      for (let i = 0; i < READER_POOL_SIZE; i++) {
        const r = createClient({ url });
        r.on('error', (e) => logger.warn(`[fraud] redis reader#${i} error:`, e.message));
        this._readers.push(r);
      }

      await Promise.all([this._pub.connect(), ...this._readers.map((r) => r.connect())]);
      this._ready = true;
      this._retryDelayMs = 1000;
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      logger.info(`[fraud] FraudDetectionService connected to Redis (${READER_POOL_SIZE} readers)`);
    } catch (e) {
      logger.warn('[fraud] Could not connect to Redis — fraud checks disabled:', e.message);
      this._ready = false;
      const clients = [this._pub, ...this._readers].filter(Boolean);
      for (const client of clients) {
        try {
          if (client.isOpen) client.disconnect();
        } catch {
          // Best effort: a partially opened client can already be closed.
        }
      }
      this._pub = null;
      this._readers = [];
      this._scheduleReconnect();
    } finally {
      this._connecting = false;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._ready) return;
    const delay = this._retryDelayMs;
    this._retryDelayMs = Math.min(this._retryDelayMs * 2, 30000);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect(this._redisConfig).catch((error) => {
        logger.warn('[fraud] Redis reconnect failed:', error.message);
      });
    }, delay);
    this._reconnectTimer.unref?.();
  }

  // ─── Fast IP block check (O(1), no round-trip to Rust) ──────────────────────
  async isIpBlocked(ip) {
    if (!this.isReady()) return false;
    try {
      const val = await this._pub.get(`${BLOCKED_IP_PREFIX}${ip}`);
      return val === '1';
    } catch {
      return false;
    }
  }

  // ─── Fire-and-forget: push to queue without waiting for a result ────────────
  // Utilisé pour l'analyse des requêtes API (volume élevé) où l'on n'a pas besoin
  // du verdict en synchrone — Rust met à jour la réputation/blocklist IP, qui sera
  // consultée (O(1)) à la requête suivante. Rust met le résultat en expire 5s.
  _fireAndForget(queueKey, payload) {
    if (!this.isReady()) return;
    const correlationId = uuidv4();
    const envelope = JSON.stringify({ correlation_id: correlationId, payload });
    this._pub.lPush(queueKey, envelope).catch((e) =>
      logger.debug('[fraud] _fireAndForget lpush error:', e.message)
    );
  }

  // ─── Core: push to queue, wait for result via BLPOP ─────────────────────────
  async _sendAndWait(queueKey, payload, timeoutSeconds = TIMEOUT_S) {
    if (!this.isReady() || this._readers.length === 0) {
      if (!this._pub?.isOpen) {
        this._ready = false;
        this._scheduleReconnect();
      }
      return null;
    }

    const correlationId = uuidv4();
    const resultKey = `fraud:result:${correlationId}`;
    const envelope = JSON.stringify({ correlation_id: correlationId, payload });

    // Sélection round-robin d'un lecteur dédié au BLPOP.
    const reader = this._readers[this._rr % this._readers.length];
    this._rr = (this._rr + 1) % this._readers.length;

    try {
      // Empile la requête sur la file du worker Rust
      await this._pub.lPush(queueKey, envelope);

      // Attend le résultat avec un timeout CÔTÉ REDIS : la connexion se libère
      // automatiquement si Rust ne répond pas à temps (fail-open, pas d'orphelin).
      const result = await this._reader_blpop(reader, resultKey, timeoutSeconds);

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

  // BLPOP avec timeout Redis-side. Isolé pour faciliter les tests/mocks.
  async _reader_blpop(reader, key, timeoutSeconds) {
    return reader.blPop(key, timeoutSeconds);
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
   * Strong transaction authorization. Unlike the legacy analysis calls this is
   * fail-closed: null means the caller must not mutate a wallet.
   */
  async authorizeTransaction(payload) {
    return this._sendAndWait(QUEUES.authorize, payload, AUTHORIZATION_TIMEOUT_S);
  }

  /**
   * Analyse an API request (fire-and-forget — chemin haute fréquence).
   * Le verdict n'est pas attendu : Rust met à jour la réputation/blocklist IP,
   * consultée en O(1) à la requête suivante via isIpBlocked().
   */
  analyzeRequest({ userId, ip, endpoint, method = 'GET', userAgent = '',
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
    this._fireAndForget(QUEUES.request, payload);
    // Compat: certains appelants chaînent .then()/.catch() sur le retour.
    return Promise.resolve(null);
  }

  // ─── Health check ─────────────────────────────────────────────────────────
  isReady() {
    return Boolean(
      this._ready
      && this._pub?.isReady
      && this._readers.length === READER_POOL_SIZE
      && this._readers.every((reader) => reader.isReady)
    );
  }
}

// Singleton
const fraudService = new FraudDetectionService();

module.exports = fraudService;
