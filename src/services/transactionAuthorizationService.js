const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { v4: uuidv4 } = require('uuid');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../database');
const { runMigrations } = require('../config/role');
const fraudService = require('./fraudDetectionService');
const logger = require('../utils/logger');

const requestStorage = new AsyncLocalStorage();
const AUTHORIZED_DECISIONS = new Set(['APPROVE', 'MONITOR']);
const BLOCKED_DECISIONS = new Set(['REVIEW', 'DECLINE']);
const VALID_DECISIONS = new Set([...AUTHORIZED_DECISIONS, ...BLOCKED_DECISIONS]);
const VALID_ACTIONS = new Set(['NONE', 'MONITOR', 'RESTRICT', 'FREEZE']);
const NON_OVERRIDABLE_MANUAL_REVIEW_REASONS = new Set([
  'missing_authorization_identity',
  'invalid_transaction_facts',
  'wallet_already_frozen',
  'account_suspended',
  'idempotency_replay_history',
  'coordinated_payment_fraud',
  'coordinated_laundering_ring',
]);
const AUTO_IDEMPOTENCY_BUCKET_MS = 5000;
// Un portefeuille RESTRICTED refuse toute dépense. Sans horizon, une seule
// décision limite bloquait le compte pour toujours, et chaque nouvelle
// tentative empirait le score : tout le monde finissait en revue permanente.
// La restriction expire donc d'elle-même si aucune décision bloquante ne la
// renouvelle. FROZEN, lui, reste manuel — c'est le seul état définitif.
const RESTRICTION_TTL = "INTERVAL '72 hours'";
const RESTRICTION_IS_ACTIVE = `(
  wallet_risk_profiles.risk_state = 'RESTRICTED'
  AND wallet_risk_profiles.restricted_at IS NOT NULL
  AND wallet_risk_profiles.restricted_at > NOW() - ${RESTRICTION_TTL}
)`;

class TransactionRiskError extends Error {
  constructor(message, code, httpStatus = 403, details = {}) {
    super(message);
    this.name = 'TransactionRiskError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmac(value, namespace) {
  if (value == null || String(value).trim() === '') return '';
  const key = process.env.FRAUD_DATA_HASH_KEY
    || process.env.JWT_SECRET
    || process.env.SESSION_SECRET
    || 'local-development-fraud-key';
  return crypto
    .createHmac('sha256', key)
    .update(`${namespace}:${String(value).trim()}`)
    .digest('hex');
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedString(value, max = 160) {
  return value == null ? '' : String(value).trim().slice(0, max);
}

function requestContextMiddleware(req, _res, next) {
  const suppliedKey = boundedString(req.get('Idempotency-Key') || req.get('X-Idempotency-Key'), 200);
  // Un User-Agent identifie une version d'application, pas un appareil :
  // l'utiliser ici reliait artificiellement tous les clients Expo entre eux.
  const deviceSource = req.get('X-Device-Id')
    || req.get('X-Device-Token')
    || req.body?.deviceToken
    || req.body?.device_id
    || '';
  const paymentSource = req.body?.paymentToken
    || req.body?.cardToken
    || req.body?.providerPaymentId
    || req.body?.applePayTransactionId
    || '';
  const bodyDigest = sha256(stableStringify(req.body || {}));

  const context = {
    suppliedKey,
    automaticSeed: `${req.method}:${req.originalUrl || req.url}:${bodyDigest}`,
    requestId: boundedString(req.get('X-Request-Id'), 160) || uuidv4(),
    endpoint: boundedString(req.originalUrl || req.url, 300),
    deviceFingerprint: hmac(deviceSource, 'device'),
    ipFingerprint: hmac(req.ip || req.socket?.remoteAddress || '', 'ip'),
    paymentFingerprint: hmac(paymentSource, 'payment'),
    userAgentFamily: hmac(req.get('User-Agent') || '', 'user-agent'),
  };

  requestStorage.run(context, next);
}

class TransactionAuthorizationService {
  constructor() {
    this._initialization = null;
  }

  /**
   * Le registre doit exister avant le moindre mouvement de valeur — mais
   * « exister » et « le créer » ne sont pas le même travail.
   *
   * Le DDL ci-dessous (quatre tables, six index) est une migration : jouée par
   * chaque instance web et par chaque réplique C au démarrage, elle faisait
   * converger N processus sur les mêmes CREATE TABLE / ALTER TABLE, et pesait
   * plusieurs secondes avant que le process n'accepte sa première requête.
   * Elle revient donc au process qui porte déjà les migrations.
   *
   * Les autres nœuds ne sautent pas la vérification pour autant : ils
   * *constatent* le schéma au lieu de le construire. C'est une seule lecture du
   * catalogue, et elle échoue si une table manque — la propriété qui compte
   * (pas de démarrage en fail-open) est conservée, seul le coût disparaît.
   */
  async initialize() {
    if (!this._initialization) {
      const prepare = runMigrations
        ? () => this._ensureSchema()
        : () => this._assertSchema();
      this._initialization = prepare().catch((error) => {
        this._initialization = null;
        throw error;
      });
    }
    return this._initialization;
  }

  async _assertSchema() {
    const [rows] = await sequelize.query(`
      SELECT
        to_regclass('public.wallet_risk_profiles')            AS profiles,
        to_regclass('public.transaction_risk_authorizations') AS authorizations,
        to_regclass('public.transaction_risk_events')         AS events
    `);
    const found = Array.isArray(rows) ? rows[0] : rows;
    const missing = Object.entries(found || {})
      .filter(([, oid]) => !oid)
      .map(([name]) => name);

    if (missing.length) {
      // Volontairement fatal : sans registre durable, toute autorisation de
      // transaction serait rendue sans trace ni protection anti-rejeu.
      throw new Error(
        `[transaction-risk] Schéma d'autorisation absent (${missing.join(', ')}). `
        + 'Le process worker doit avoir démarré au moins une fois pour le créer.'
      );
    }
    logger.info('[transaction-risk] Durable authorization schema verified');
  }

  async _ensureSchema() {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS wallet_risk_profiles (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        risk_state VARCHAR(20) NOT NULL DEFAULT 'CLEAR',
        rolling_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        last_decision VARCHAR(20) NULL,
        last_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
        decline_count INTEGER NOT NULL DEFAULT 0,
        review_count INTEGER NOT NULL DEFAULT 0,
        replay_mismatch_count INTEGER NOT NULL DEFAULT 0,
        review_required BOOLEAN NOT NULL DEFAULT FALSE,
        restricted_at TIMESTAMPTZ NULL,
        frozen_at TIMESTAMPTZ NULL,
        manual_trust_until TIMESTAMPTZ NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (risk_state IN ('CLEAR', 'MONITOR', 'RESTRICTED', 'FROZEN'))
      );
    `);
    await sequelize.query(`
      ALTER TABLE wallet_risk_profiles
      ADD COLUMN IF NOT EXISTS manual_trust_until TIMESTAMPTZ NULL;
    `);
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS transaction_risk_authorizations (
        id UUID PRIMARY KEY,
        idempotency_key VARCHAR(64) NOT NULL UNIQUE,
        request_hash VARCHAR(64) NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        currency_id UUID NULL REFERENCES virtual_currencies(id) ON DELETE SET NULL,
        counterparty_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
        transaction_kind VARCHAR(60) NOT NULL,
        direction VARCHAR(20) NOT NULL,
        amount NUMERIC(20,8) NOT NULL,
        amount_eur NUMERIC(20,8) NOT NULL DEFAULT 0,
        merchant_id VARCHAR(160) NULL,
        device_fingerprint VARCHAR(64) NULL,
        ip_fingerprint VARCHAR(64) NULL,
        payment_fingerprint VARCHAR(64) NULL,
        decision VARCHAR(20) NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        risk_score DOUBLE PRECISION NULL,
        confidence DOUBLE PRECISION NULL,
        wallet_action VARCHAR(20) NULL,
        engine_version VARCHAR(80) NULL,
        reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
        signals JSONB NOT NULL DEFAULT '[]'::jsonb,
        expires_at TIMESTAMPTZ NULL,
        consumed_at TIMESTAMPTZ NULL,
        linked_transaction_id UUID NULL REFERENCES transactions(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (status IN ('PENDING', 'AUTHORIZED', 'REVIEW', 'DECLINED', 'CONSUMED', 'EXPIRED'))
      );
    `);
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS transaction_risk_events (
        id UUID PRIMARY KEY,
        authorization_id UUID NULL REFERENCES transaction_risk_authorizations(id) ON DELETE SET NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        decision VARCHAR(20) NULL,
        risk_score DOUBLE PRECISION NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_risk_auth_user_created
        ON transaction_risk_authorizations (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_risk_auth_device_created
        ON transaction_risk_authorizations (device_fingerprint, created_at DESC)
        WHERE device_fingerprint IS NOT NULL AND device_fingerprint <> '';
      CREATE INDEX IF NOT EXISTS idx_risk_auth_ip_created
        ON transaction_risk_authorizations (ip_fingerprint, created_at DESC)
        WHERE ip_fingerprint IS NOT NULL AND ip_fingerprint <> '';
      CREATE INDEX IF NOT EXISTS idx_risk_auth_payment_created
        ON transaction_risk_authorizations (payment_fingerprint, created_at DESC)
        WHERE payment_fingerprint IS NOT NULL AND payment_fingerprint <> '';
      CREATE INDEX IF NOT EXISTS idx_risk_auth_status_expiry
        ON transaction_risk_authorizations (status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_risk_events_user_created
        ON transaction_risk_events (user_id, created_at DESC);
    `);
    logger.info('[transaction-risk] Durable authorization schema ready');
  }

  _operationContext(userId, operation, overrides = {}) {
    const request = requestStorage.getStore() || {};
    const suppliedKey = boundedString(overrides.idempotencyKey || request.suppliedKey, 200);
    const autoBucket = Math.floor(Date.now() / AUTO_IDEMPOTENCY_BUCKET_MS);
    const autoSeed = `${request.automaticSeed || uuidv4()}:${operation}:${autoBucket}`;
    const idempotencySource = suppliedKey
      ? `client:${userId}:${suppliedKey}:${operation}`
      : `auto:${userId}:${autoSeed}`;

    return {
      idempotencyKey: hmac(idempotencySource, 'idempotency'),
      requestId: request.requestId || uuidv4(),
      endpoint: request.endpoint || 'internal',
      deviceFingerprint: overrides.deviceFingerprint
        || request.deviceFingerprint
        || '',
      ipFingerprint: overrides.ipFingerprint
        || request.ipFingerprint
        || '',
      paymentFingerprint: overrides.paymentFingerprint
        || (overrides.paymentToken ? hmac(overrides.paymentToken, 'payment') : '')
        || request.paymentFingerprint
        || '',
      userAgentFamily: request.userAgentFamily || '',
      suppliedIdempotency: Boolean(suppliedKey),
    };
  }

  _normalizeOperation(input) {
    const normalized = {
      userId: boundedString(input.userId, 64),
      transactionKind: boundedString(input.transactionKind, 60).toLowerCase(),
      direction: boundedString(input.direction || 'outbound', 20).toLowerCase(),
      amount: finiteNumber(input.amount),
      amountEur: finiteNumber(input.amountEur),
      currencyId: input.currencyId ? boundedString(input.currencyId, 64) : null,
      counterpartyUserId: input.counterpartyUserId
        ? boundedString(input.counterpartyUserId, 64)
        : null,
      merchantId: boundedString(input.merchantId, 160).toLowerCase(),
      paymentMethod: boundedString(input.paymentMethod, 80).toUpperCase(),
      itemType: boundedString(input.itemType, 80).toLowerCase(),
      itemId: boundedString(input.itemId, 160),
    };
    if (!normalized.userId || !normalized.transactionKind) {
      throw new TransactionRiskError(
        'Contexte de transaction incomplet',
        'RISK_CONTEXT_INVALID',
        500
      );
    }
    if (!(normalized.amount > 0) || normalized.amount > 1e12) {
      throw new TransactionRiskError('Montant invalide', 'RISK_AMOUNT_INVALID', 400);
    }
    return normalized;
  }

  _requestHash(operation, context) {
    return sha256(stableStringify({
      ...operation,
      deviceFingerprint: context.deviceFingerprint,
      paymentFingerprint: context.paymentFingerprint,
    }));
  }

  async _claimAuthorization(operation, context, requestHash) {
    const authorizationId = uuidv4();
    const [, metadata] = await sequelize.query(`
      INSERT INTO transaction_risk_authorizations (
        id, idempotency_key, request_hash, user_id, currency_id,
        counterparty_user_id, transaction_kind, direction, amount, amount_eur,
        merchant_id, device_fingerprint, ip_fingerprint, payment_fingerprint,
        status, expires_at, created_at, updated_at
      ) VALUES (
        :id, :idempotencyKey, :requestHash, :userId, :currencyId,
        :counterpartyUserId, :transactionKind, :direction, :amount, :amountEur,
        :merchantId, :deviceFingerprint, :ipFingerprint, :paymentFingerprint,
        'PENDING', NOW() + INTERVAL '15 seconds', NOW(), NOW()
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `, {
      replacements: {
        id: authorizationId,
        idempotencyKey: context.idempotencyKey,
        requestHash,
        ...operation,
        deviceFingerprint: context.deviceFingerprint,
        ipFingerprint: context.ipFingerprint,
        paymentFingerprint: context.paymentFingerprint,
      },
    });

    // Sequelize's metadata differs across pg versions; always read by the
    // unique key, which also gives one deterministic path under concurrency.
    const rows = await sequelize.query(`
      SELECT *
      FROM transaction_risk_authorizations
      WHERE idempotency_key = :idempotencyKey
      LIMIT 1
    `, {
      type: QueryTypes.SELECT,
      replacements: { idempotencyKey: context.idempotencyKey },
    });
    const row = rows[0];
    if (!row) {
      throw new TransactionRiskError(
        'Impossible de créer la preuve d’autorisation',
        'RISK_AUTHORIZATION_CREATE_FAILED',
        503
      );
    }

    if (row.request_hash !== requestHash) {
      await this._recordReplayMismatch(row, operation.userId, requestHash);
      throw new TransactionRiskError(
        'Cette clé d’opération a déjà été utilisée avec un contenu différent',
        'TRANSACTION_REPLAY_MISMATCH',
        409
      );
    }
    if (row.status === 'CONSUMED') {
      throw new TransactionRiskError(
        'Cette transaction a déjà été exécutée',
        'TRANSACTION_ALREADY_PROCESSED',
        409,
        { transactionId: row.linked_transaction_id }
      );
    }
    if (row.status === 'AUTHORIZED' && row.expires_at && new Date(row.expires_at) > new Date()) {
      return { row, claimed: false, cached: true };
    }
    if (row.status === 'REVIEW' || row.status === 'DECLINED') {
      return { row, claimed: false, cached: true };
    }
    if (row.id !== authorizationId) {
      const ageMs = Date.now() - new Date(row.updated_at).getTime();
      if (row.status === 'PENDING' && ageMs < 5000) {
        throw new TransactionRiskError(
          'Cette transaction est déjà en cours de vérification',
          'TRANSACTION_AUTHORIZATION_IN_PROGRESS',
          409
        );
      }
      await sequelize.query(`
        UPDATE transaction_risk_authorizations
        SET status = 'PENDING', decision = NULL, risk_score = NULL,
            confidence = NULL, wallet_action = NULL, reasons = '[]'::jsonb,
            signals = '[]'::jsonb, expires_at = NOW() + INTERVAL '15 seconds',
            updated_at = NOW()
        WHERE id = :id AND request_hash = :requestHash
      `, { replacements: { id: row.id, requestHash } });
    }

    return { row: { ...row, id: row.id || authorizationId }, claimed: true, cached: false };
  }

  async _recordReplayMismatch(row, userId, attemptedHash) {
    await sequelize.transaction(async (dbTransaction) => {
      await sequelize.query(`
        INSERT INTO wallet_risk_profiles (
          user_id, risk_state, rolling_score, last_decision, last_reasons,
          replay_mismatch_count, review_required, updated_at
        ) VALUES (
          :userId, 'MONITOR', 55, 'REPLAY_MISMATCH',
          '["idempotency_replay_mismatch"]'::jsonb, 1, TRUE, NOW()
        )
        ON CONFLICT (user_id) DO UPDATE SET
          risk_state = CASE
            WHEN wallet_risk_profiles.risk_state = 'FROZEN' THEN 'FROZEN'
            WHEN ${RESTRICTION_IS_ACTIVE} THEN 'RESTRICTED'
            ELSE 'MONITOR'
          END,
          rolling_score = GREATEST(wallet_risk_profiles.rolling_score, 55),
          last_decision = 'REPLAY_MISMATCH',
          last_reasons = '["idempotency_replay_mismatch"]'::jsonb,
          replay_mismatch_count = wallet_risk_profiles.replay_mismatch_count + 1,
          review_required = TRUE,
          updated_at = NOW()
      `, { replacements: { userId }, transaction: dbTransaction });
      await this._insertEvent({
        authorizationId: row.id,
        userId,
        eventType: 'REPLAY_MISMATCH',
        decision: 'DECLINE',
        riskScore: 90,
        details: {
          expectedHash: row.request_hash,
          attemptedHash,
        },
      }, dbTransaction);
    });
  }

  async _collectFeatures(operation, context, authorizationId) {
    const common = {
      userId: operation.userId,
      currencyId: operation.currencyId,
      counterpartyUserId: operation.counterpartyUserId,
      authorizationId,
      transactionKind: operation.transactionKind,
      direction: operation.direction,
      deviceFingerprint: context.deviceFingerprint,
      ipFingerprint: context.ipFingerprint,
      paymentFingerprint: context.paymentFingerprint,
      amount: operation.amount,
    };

    const [
      accountRows,
      walletRows,
      historyRows,
      fingerprintRows,
      priorRows,
      networkRows,
    ] = await Promise.all([
      sequelize.query(`
        SELECT
          GREATEST(0, EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0) AS age_days,
          COALESCE(verified, FALSE) AS verified,
          COALESCE(email_verified, FALSE) AS email_verified,
          COALESCE(phone_verified, FALSE) AS phone_verified,
          COALESCE(is_suspended, FALSE) AS suspended,
          COALESCE(EXTRACT(EPOCH FROM (NOW() - last_activity)) / 3600.0, 99999) AS last_activity_age_hours
        FROM users WHERE id = :userId
      `, { type: QueryTypes.SELECT, replacements: common }),
      operation.currencyId ? sequelize.query(`
        SELECT
          TRUE AS exists,
          COALESCE(is_locked, FALSE) AS locked,
          balance::float8 AS balance,
          total_earned::float8 AS total_earned,
          total_spent::float8 AS total_spent,
          total_purchased::float8 AS total_purchased,
          GREATEST(0, EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0) AS age_days
        FROM user_wallets
        WHERE user_id = :userId AND currency_id = :currencyId
        LIMIT 1
      `, { type: QueryTypes.SELECT, replacements: common }) : Promise.resolve([]),
      sequelize.query(`
        WITH manual_clear AS (
          SELECT MAX(created_at) AS cleared_at
          FROM transaction_risk_events
          WHERE user_id = :userId AND event_type = 'MANUAL_CLEAR'
        ),
        completed AS (
          SELECT
            amount_eur::float8 AS eur,
            created_at
          FROM transaction_risk_authorizations
          WHERE user_id = :userId
            AND id <> :authorizationId
            AND status = 'CONSUMED'
            AND transaction_kind = :transactionKind
            AND direction = :direction
            AND amount_eur > 0
            AND created_at >= NOW() - INTERVAL '90 days'
        ),
        outbound AS (
          SELECT COUNT(*)::bigint AS count
          FROM transactions
          WHERE status = 'COMPLETED'
            AND from_user_id = :userId
            AND created_at >= NOW() - INTERVAL '90 days'
        ),
        distribution AS (
          SELECT
            percentile_cont(0.5) WITHIN GROUP (ORDER BY eur) AS median_eur,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY eur) AS p95_eur
          FROM completed
        ),
        deviations AS (
          SELECT percentile_cont(0.5) WITHIN GROUP (
            ORDER BY ABS(c.eur - COALESCE(d.median_eur, 0))
          ) AS mad_eur
          FROM completed c CROSS JOIN distribution d
        ),
        attempts AS (
          SELECT
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '10 minutes') AS count_10m,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour') AS count_1h,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS count_24h,
            COUNT(*) FILTER (
              WHERE created_at >= NOW() - INTERVAL '24 hours'
                AND status IN ('DECLINED', 'REVIEW')
            ) AS failed_24h
          FROM transaction_risk_authorizations
          WHERE user_id = :userId AND id <> :authorizationId
            -- Une validation manuelle ouvre une nouvelle fenêtre de risque :
            -- les refus déjà examinés restent audités, mais ne rebloquent pas
            -- immédiatement le paiement suivant.
            AND created_at > COALESCE(
              (SELECT cleared_at FROM manual_clear),
              '-infinity'::timestamptz
            )
        )
        SELECT
          COUNT(c.created_at)::bigint AS completed_count,
          COALESCE(o.count, 0)::bigint AS outbound_count,
          COALESCE(a.count_10m, 0)::bigint AS count_10m,
          COALESCE(a.count_1h, 0)::bigint AS count_1h,
          COALESCE(a.count_24h, 0)::bigint AS count_24h,
          (COUNT(c.*) FILTER (WHERE c.created_at >= NOW() - INTERVAL '30 days') / 30.0)::float8 AS avg_daily_count_30d,
          COALESCE(d.median_eur, 0)::float8 AS median_amount_eur,
          COALESCE(v.mad_eur, 0)::float8 AS mad_amount_eur,
          COALESCE(d.p95_eur, 0)::float8 AS p95_amount_eur,
          COALESCE(EXTRACT(EPOCH FROM (NOW() - MAX(c.created_at))) / 3600.0, 99999)::float8 AS hours_since_last_transaction,
          COALESCE(a.failed_24h, 0)::bigint AS failed_count_24h
        FROM distribution d
        CROSS JOIN deviations v
        CROSS JOIN attempts a
        CROSS JOIN outbound o
        LEFT JOIN completed c ON TRUE
        GROUP BY d.median_eur, d.p95_eur, v.mad_eur,
                 a.count_10m, a.count_1h, a.count_24h, a.failed_24h, o.count
      `, { type: QueryTypes.SELECT, replacements: common }),
      sequelize.query(`
        SELECT
          CASE WHEN :deviceFingerprint = '' THEN TRUE ELSE EXISTS (
            SELECT 1 FROM transaction_risk_authorizations
            WHERE user_id = :userId AND device_fingerprint = :deviceFingerprint
              AND id <> :authorizationId AND status IN ('AUTHORIZED', 'CONSUMED')
          ) END AS device_seen_before,
          CASE WHEN :ipFingerprint = '' THEN TRUE ELSE EXISTS (
            SELECT 1 FROM transaction_risk_authorizations
            WHERE user_id = :userId AND ip_fingerprint = :ipFingerprint
              AND id <> :authorizationId AND status IN ('AUTHORIZED', 'CONSUMED')
          ) END AS ip_seen_before,
          CASE WHEN :paymentFingerprint = '' THEN TRUE ELSE EXISTS (
            SELECT 1 FROM transaction_risk_authorizations
            WHERE user_id = :userId AND payment_fingerprint = :paymentFingerprint
              AND id <> :authorizationId AND status IN ('AUTHORIZED', 'CONSUMED')
          ) END AS payment_seen_before,
          CASE WHEN :deviceFingerprint = '' THEN 0 ELSE (
            SELECT COUNT(DISTINCT user_id) FROM transaction_risk_authorizations
            WHERE device_fingerprint = :deviceFingerprint
              AND created_at >= NOW() - INTERVAL '30 days'
          ) END::bigint AS device_account_count_30d,
          CASE WHEN :ipFingerprint = '' THEN 0 ELSE (
            SELECT COUNT(DISTINCT user_id) FROM transaction_risk_authorizations
            WHERE ip_fingerprint = :ipFingerprint
              AND created_at >= NOW() - INTERVAL '24 hours'
          ) END::bigint AS ip_account_count_24h,
          CASE WHEN :paymentFingerprint = '' THEN 0 ELSE (
            SELECT COUNT(DISTINCT user_id) FROM transaction_risk_authorizations
            WHERE payment_fingerprint = :paymentFingerprint
              AND created_at >= NOW() - INTERVAL '30 days'
          ) END::bigint AS payment_account_count_30d
      `, { type: QueryTypes.SELECT, replacements: common }),
      sequelize.query(`
        WITH manual_clear AS (
          SELECT MAX(created_at) AS cleared_at
          FROM transaction_risk_events
          WHERE user_id = :userId AND event_type = 'MANUAL_CLEAR'
        )
        SELECT
          CASE
            WHEN COALESCE(risk_state, 'CLEAR') = 'RESTRICTED'
              AND COALESCE(restricted_at, '-infinity'::timestamptz)
                  <= NOW() - ${RESTRICTION_TTL}
              THEN 'MONITOR'
            ELSE COALESCE(risk_state, 'CLEAR')
          END AS state,
          COALESCE(rolling_score, 0)::float8 AS rolling_score,
          COALESCE(manual_trust_until > NOW(), FALSE) AS manual_trust_active,
          (
            SELECT COUNT(*) FROM transaction_risk_authorizations
            WHERE user_id = :userId AND id <> :authorizationId
              AND created_at >= NOW() - INTERVAL '24 hours'
              AND created_at > COALESCE(manual_clear.cleared_at, '-infinity'::timestamptz)
          )::bigint AS authorizations_24h,
          (
            SELECT COUNT(*) FROM transaction_risk_authorizations
            WHERE user_id = :userId AND id <> :authorizationId
              AND status = 'DECLINED' AND created_at >= NOW() - INTERVAL '24 hours'
              AND created_at > COALESCE(manual_clear.cleared_at, '-infinity'::timestamptz)
          )::bigint AS declines_24h,
          (
            SELECT COUNT(*) FROM transaction_risk_authorizations
            WHERE user_id = :userId AND id <> :authorizationId
              AND status = 'REVIEW' AND created_at >= NOW() - INTERVAL '7 days'
              AND created_at > COALESCE(manual_clear.cleared_at, '-infinity'::timestamptz)
          )::bigint AS reviews_7d,
          (
            SELECT COUNT(*) FROM transaction_risk_events
            WHERE user_id = :userId
              AND event_type = 'REPLAY_MISMATCH'
              AND created_at >= NOW() - INTERVAL '30 days'
          )::bigint AS replay_mismatches_30d
        FROM wallet_risk_profiles
        CROSS JOIN manual_clear
        WHERE user_id = :userId
      `, { type: QueryTypes.SELECT, replacements: common }),
      operation.counterpartyUserId ? sequelize.query(`
        WITH recipient AS (
          SELECT
            GREATEST(0, EXTRACT(EPOCH FROM (NOW() - u.created_at)) / 86400.0) AS age_days,
            COALESCE(
              p.risk_state = 'FROZEN'
              OR (
                p.risk_state = 'RESTRICTED'
                AND COALESCE(p.restricted_at, '-infinity'::timestamptz)
                    > NOW() - ${RESTRICTION_TTL}
              ),
              FALSE
            ) AS restricted
          FROM users u
          LEFT JOIN wallet_risk_profiles p ON p.user_id = u.id
          WHERE u.id = :counterpartyUserId
        ),
        recent AS (
          SELECT from_user_id, to_user_id, amount::float8 AS amount, created_at
          FROM transactions
          WHERE status = 'COMPLETED'
            AND type IN ('TRANSFER', 'SYSTEM')
            AND currency_id = :currencyId
            AND created_at >= NOW() - INTERVAL '7 days'
            AND from_user_id IS NOT NULL
            AND from_user_id <> to_user_id
        ),
        flow AS (
          SELECT
            COALESCE(SUM(amount) FILTER (
              WHERE from_user_id = :counterpartyUserId
                AND to_user_id = :userId
                AND created_at >= NOW() - INTERVAL '24 hours'
            ), 0) AS reciprocal,
            COALESCE(SUM(amount) FILTER (
              WHERE to_user_id = :counterpartyUserId
                AND created_at >= NOW() - INTERVAL '24 hours'
            ), 0) AS recipient_in,
            COALESCE(SUM(amount) FILTER (
              WHERE from_user_id = :counterpartyUserId
                AND created_at >= NOW() - INTERVAL '24 hours'
            ), 0) AS recipient_out
          FROM recent
        ),
        rapid_flow AS (
          SELECT COALESCE(SUM(outgoing.amount), 0) AS forwarded
          FROM recent outgoing
          WHERE outgoing.from_user_id = :counterpartyUserId
            AND outgoing.created_at >= NOW() - INTERVAL '24 hours'
            AND EXISTS (
              SELECT 1
              FROM recent incoming
              WHERE incoming.to_user_id = :counterpartyUserId
                AND incoming.created_at <= outgoing.created_at
                AND incoming.created_at >= outgoing.created_at - INTERVAL '2 hours'
            )
        )
        SELECT
          COALESCE((SELECT age_days FROM recipient), 0)::float8 AS recipient_account_age_days,
          COALESCE((SELECT restricted FROM recipient), FALSE) AS recipient_is_restricted,
          (SELECT COUNT(DISTINCT from_user_id) FROM recent WHERE to_user_id = :counterpartyUserId)::bigint
            AS recipient_unique_senders_7d,
          (SELECT COUNT(DISTINCT to_user_id) FROM recent WHERE from_user_id = :userId)::bigint
            AS sender_unique_recipients_7d,
          LEAST(1, flow.reciprocal / GREATEST(:amount, 0.00000001))::float8
            AS reciprocal_amount_ratio_24h,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM recent
              WHERE from_user_id = :counterpartyUserId AND to_user_id = :userId
            ) THEN 2
            WHEN EXISTS (
              SELECT 1
              FROM recent first_hop
              JOIN recent second_hop
                ON second_hop.from_user_id = first_hop.to_user_id
              WHERE first_hop.from_user_id = :counterpartyUserId
                AND second_hop.to_user_id = :userId
            ) THEN 3
            ELSE 0
          END::smallint AS shortest_cycle_length_7d,
          LEAST(1, rapid_flow.forwarded / GREATEST(flow.recipient_in, 0.00000001))::float8
            AS rapid_forward_ratio_24h
        FROM flow CROSS JOIN rapid_flow
      `, { type: QueryTypes.SELECT, replacements: common }) : Promise.resolve([]),
    ]);

    const account = accountRows[0] || {};
    const wallet = walletRows[0] || {};
    const history = historyRows[0] || {};
    const fingerprints = fingerprintRows[0] || {};
    const priorRisk = priorRows[0] || {};
    const network = networkRows[0] || {};

    return {
      account: {
        age_days: finiteNumber(account.age_days),
        verified: Boolean(account.verified),
        email_verified: Boolean(account.email_verified),
        phone_verified: Boolean(account.phone_verified),
        suspended: Boolean(account.suspended),
        last_activity_age_hours: finiteNumber(account.last_activity_age_hours, 99999),
      },
      wallet: {
        exists: Boolean(wallet.exists),
        locked: Boolean(wallet.locked),
        balance: finiteNumber(wallet.balance),
        total_earned: finiteNumber(wallet.total_earned),
        total_spent: finiteNumber(wallet.total_spent),
        total_purchased: finiteNumber(wallet.total_purchased),
        age_days: finiteNumber(wallet.age_days),
      },
      history: {
        completed_count: finiteNumber(history.completed_count),
        outbound_count: finiteNumber(history.outbound_count),
        count_10m: finiteNumber(history.count_10m),
        count_1h: finiteNumber(history.count_1h),
        count_24h: finiteNumber(history.count_24h),
        avg_daily_count_30d: finiteNumber(history.avg_daily_count_30d),
        median_amount_eur: finiteNumber(history.median_amount_eur),
        mad_amount_eur: finiteNumber(history.mad_amount_eur),
        p95_amount_eur: finiteNumber(history.p95_amount_eur),
        hours_since_last_transaction: finiteNumber(history.hours_since_last_transaction, 99999),
        failed_count_24h: finiteNumber(history.failed_count_24h),
      },
      network: {
        recipient_account_age_days: finiteNumber(network.recipient_account_age_days),
        recipient_is_restricted: Boolean(network.recipient_is_restricted),
        recipient_unique_senders_7d: finiteNumber(network.recipient_unique_senders_7d),
        sender_unique_recipients_7d: finiteNumber(network.sender_unique_recipients_7d),
        reciprocal_amount_ratio_24h: finiteNumber(network.reciprocal_amount_ratio_24h),
        shortest_cycle_length_7d: finiteNumber(network.shortest_cycle_length_7d),
        rapid_forward_ratio_24h: finiteNumber(network.rapid_forward_ratio_24h),
      },
      fingerprints: {
        device_seen_before: Boolean(fingerprints.device_seen_before),
        ip_seen_before: Boolean(fingerprints.ip_seen_before),
        payment_seen_before: Boolean(fingerprints.payment_seen_before),
        device_account_count_30d: finiteNumber(fingerprints.device_account_count_30d),
        ip_account_count_24h: finiteNumber(fingerprints.ip_account_count_24h),
        payment_account_count_30d: finiteNumber(fingerprints.payment_account_count_30d),
      },
      prior_risk: {
        state: boundedString(priorRisk.state || 'CLEAR', 20),
        rolling_score: finiteNumber(priorRisk.rolling_score),
        manual_trust_active: Boolean(priorRisk.manual_trust_active),
        authorizations_24h: finiteNumber(priorRisk.authorizations_24h),
        declines_24h: finiteNumber(priorRisk.declines_24h),
        reviews_7d: finiteNumber(priorRisk.reviews_7d),
        replay_mismatches_30d: finiteNumber(priorRisk.replay_mismatches_30d),
      },
    };
  }

  _cachedDecision(row) {
    return {
      authorization_id: row.id,
      request_hash: row.request_hash,
      decision: row.decision,
      risk_score: finiteNumber(row.risk_score),
      confidence: finiteNumber(row.confidence),
      wallet_action: row.wallet_action || 'NONE',
      valid_for_seconds: row.expires_at
        ? Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000))
        : 0,
      reasons: Array.isArray(row.reasons) ? row.reasons : [],
      signals: Array.isArray(row.signals) ? row.signals : [],
      engine_version: row.engine_version || 'unknown',
      cached: true,
    };
  }

  _validateRustDecision(decision, authorizationId, requestHash) {
    if (!decision || decision.error) {
      throw new TransactionRiskError(
        'Le moteur anti-fraude a refusé la vérification',
        'RISK_ENGINE_INVALID_RESPONSE',
        503
      );
    }
    if (decision.authorization_id !== authorizationId || decision.request_hash !== requestHash) {
      throw new TransactionRiskError(
        'La preuve du moteur anti-fraude ne correspond pas à la transaction',
        'RISK_ENGINE_PROOF_MISMATCH',
        503
      );
    }
    if (!VALID_DECISIONS.has(decision.decision) || !VALID_ACTIONS.has(decision.wallet_action)) {
      throw new TransactionRiskError(
        'Décision anti-fraude inconnue',
        'RISK_ENGINE_DECISION_INVALID',
        503
      );
    }
    const actionMatchesDecision = (
      (decision.decision === 'APPROVE' && decision.wallet_action === 'NONE')
      || (decision.decision === 'MONITOR' && ['NONE', 'MONITOR'].includes(decision.wallet_action))
      || (decision.decision === 'REVIEW' && ['MONITOR', 'RESTRICT'].includes(decision.wallet_action))
      || (decision.decision === 'DECLINE' && ['RESTRICT', 'FREEZE'].includes(decision.wallet_action))
    );
    const score = Number(decision.risk_score);
    const confidence = Number(decision.confidence);
    if (
      !actionMatchesDecision
      || !Number.isFinite(score)
      || score < 0
      || score > 100
      || !Number.isFinite(confidence)
      || confidence < 0
      || confidence > 1
      || !Array.isArray(decision.reasons)
      || !Array.isArray(decision.signals)
      || decision.reasons.length > 20
      || decision.signals.length > 80
    ) {
      throw new TransactionRiskError(
        'Preuve anti-fraude incohérente',
        'RISK_ENGINE_PROOF_INVALID',
        503
      );
    }
    return decision;
  }

  async authorize(input, overrides = {}) {
    await this.initialize();

    const operation = this._normalizeOperation(input);
    const context = this._operationContext(operation.userId, operation.transactionKind, overrides);
    const requestHash = this._requestHash(operation, context);
    const claim = await this._claimAuthorization(operation, context, requestHash);

    let decision;
    if (claim.cached) {
      decision = this._cachedDecision(claim.row);
    } else {
      const features = await this._collectFeatures(operation, context, claim.row.id);
      const payload = {
        authorization_id: claim.row.id,
        request_hash: requestHash,
        user_id: operation.userId,
        transaction_kind: operation.transactionKind,
        direction: operation.direction,
        amount: operation.amount,
        amount_eur: operation.amountEur,
        currency_id: operation.currencyId || '',
        counterparty_user_id: operation.counterpartyUserId,
        merchant_id: operation.merchantId,
        payment_fingerprint: context.paymentFingerprint,
        device_fingerprint: context.deviceFingerprint,
        ip_fingerprint: context.ipFingerprint,
        ...features,
      };

      let rustDecision;
      try {
        rustDecision = await fraudService.authorizeTransaction(payload);
      } catch (error) {
        logger.error('[transaction-risk] Rust authorization failed:', error.message);
        rustDecision = null;
      }
      if (!rustDecision) {
        await sequelize.query(`
          UPDATE transaction_risk_authorizations
          SET status = 'EXPIRED', expires_at = NOW(), updated_at = NOW()
          WHERE id = :id AND status = 'PENDING'
        `, { replacements: { id: claim.row.id } });
        throw new TransactionRiskError(
          'Vérification de sécurité momentanément indisponible. Aucun débit n’a été effectué.',
          'RISK_ENGINE_UNAVAILABLE',
          503
        );
      }

      decision = this._validateRustDecision(rustDecision, claim.row.id, requestHash);
      decision = this._applyManualTrustOverride(decision, features.prior_risk);
      await this._persistDecision(operation.userId, decision);
    }

    if (!AUTHORIZED_DECISIONS.has(decision.decision)) {
      const code = decision.decision === 'REVIEW'
        ? 'TRANSACTION_REQUIRES_REVIEW'
        : 'TRANSACTION_DECLINED';

      // Un portefeuille en revue manuelle refuse TOUT, indéfiniment, jusqu'à
      // ce qu'un Gardien le libère. Le message générique laissait croire à un
      // refus ponctuel : on réessaie, chaque tentative compte comme un refus
      // de plus, et le score empire. C'est le seul état qu'on nomme — les
      // autres refus restent muets, pour ne pas expliquer à un fraudeur quelle
      // règle il vient de déclencher.
      const walletHeld = Array.isArray(decision.reasons)
        && decision.reasons.some((reason) => reason === 'wallet_pending_manual_review'
          || reason === 'wallet_already_frozen');

      throw new TransactionRiskError(
        walletHeld
          ? 'Ton portefeuille est en revue manuelle : les paiements sont suspendus le temps de la vérification. Aucun débit n’a été effectué.'
          : 'Transaction refusée par la protection anti-fraude. Aucun débit n’a été effectué.',
        walletHeld ? 'WALLET_UNDER_REVIEW' : code,
        403,
        {
          authorizationId: decision.authorization_id,
          decision: decision.decision,
          riskScore: decision.risk_score,
          reviewRequired: decision.decision === 'REVIEW',
        }
      );
    }

    return {
      id: decision.authorization_id,
      requestHash,
      decision: decision.decision,
      riskScore: finiteNumber(decision.risk_score),
      confidence: finiteNumber(decision.confidence),
      walletAction: decision.wallet_action,
      engineVersion: decision.engine_version,
      reasons: decision.reasons || [],
      expiresAt: new Date(Date.now() + finiteNumber(decision.valid_for_seconds, 90) * 1000),
      exempt: false,
    };
  }

  _applyManualTrustOverride(decision, priorRisk) {
    if (!priorRisk?.manual_trust_active) return decision;

    const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];
    if (reasons.some((reason) => NON_OVERRIDABLE_MANUAL_REVIEW_REASONS.has(reason))) {
      return decision;
    }

    if (decision.decision === 'APPROVE' && finiteNumber(decision.risk_score) === 0) {
      return decision;
    }

    logger.info(
      `[transaction-risk] Manual trust override applied to ${decision.authorization_id}`
    );
    return {
      ...decision,
      decision: 'APPROVE',
      risk_score: 0,
      confidence: 1,
      wallet_action: 'NONE',
      valid_for_seconds: 90,
      reasons: ['manual_review_approved'],
      signals: [
        {
          code: 'manual_review_approved',
          family: 'manual_review',
          probability: 0,
          reliability: 1,
          impact: 0,
          detail: 'Fenêtre de confiance ouverte après validation manuelle',
        },
        ...(Array.isArray(decision.signals) ? decision.signals : []),
      ].slice(0, 80),
      engine_version: boundedString(`${decision.engine_version}+manual-trust`, 80),
    };
  }

  async _persistDecision(userId, decision) {
    const authorized = AUTHORIZED_DECISIONS.has(decision.decision);
    const status = authorized
      ? 'AUTHORIZED'
      : (decision.decision === 'REVIEW' ? 'REVIEW' : 'DECLINED');
    const validSeconds = authorized
      ? Math.max(15, Math.min(180, finiteNumber(decision.valid_for_seconds, 90)))
      : 0;

    await sequelize.transaction(async (dbTransaction) => {
      const persistedRows = await sequelize.query(`
        UPDATE transaction_risk_authorizations
        SET decision = :decision,
            status = :status,
            risk_score = :riskScore,
            confidence = :confidence,
            wallet_action = :walletAction,
            engine_version = :engineVersion,
            reasons = CAST(:reasons AS jsonb),
            signals = CAST(:signals AS jsonb),
            expires_at = CASE
              WHEN :authorized THEN NOW() + (:validSeconds * INTERVAL '1 second')
              ELSE NOW()
            END,
            updated_at = NOW()
        WHERE id = :authorizationId AND status = 'PENDING'
        RETURNING id
      `, {
        type: QueryTypes.SELECT,
        replacements: {
          authorizationId: decision.authorization_id,
          decision: decision.decision,
          status,
          riskScore: finiteNumber(decision.risk_score),
          confidence: finiteNumber(decision.confidence),
          walletAction: decision.wallet_action,
          engineVersion: boundedString(decision.engine_version, 80),
          reasons: JSON.stringify(decision.reasons || []),
          signals: JSON.stringify(decision.signals || []),
          authorized,
          validSeconds,
        },
        transaction: dbTransaction,
      });
      if (persistedRows.length !== 1) {
        throw new TransactionRiskError(
          'La fenêtre de cette autorisation a expiré',
          'TRANSACTION_AUTHORIZATION_STALE',
          409
        );
      }

      const nextState = decision.wallet_action === 'FREEZE'
        ? 'FROZEN'
        : (decision.wallet_action === 'RESTRICT'
          ? 'RESTRICTED'
          : (decision.wallet_action === 'MONITOR' ? 'MONITOR' : 'CLEAR'));
      await sequelize.query(`
        INSERT INTO wallet_risk_profiles (
          user_id, risk_state, rolling_score, last_decision, last_reasons,
          decline_count, review_count, review_required, restricted_at, frozen_at, updated_at
        ) VALUES (
          :userId, :nextState, :riskScore, :decision, CAST(:reasons AS jsonb),
          CASE WHEN :decision = 'DECLINE' THEN 1 ELSE 0 END,
          CASE WHEN :decision = 'REVIEW' THEN 1 ELSE 0 END,
          :reviewRequired,
          CASE WHEN :nextState IN ('RESTRICTED', 'FROZEN') THEN NOW() ELSE NULL END,
          CASE WHEN :nextState = 'FROZEN' THEN NOW() ELSE NULL END,
          NOW()
        )
        ON CONFLICT (user_id) DO UPDATE SET
          risk_state = CASE
            WHEN wallet_risk_profiles.risk_state = 'FROZEN' THEN 'FROZEN'
            WHEN EXCLUDED.risk_state = 'FROZEN' THEN 'FROZEN'
            WHEN EXCLUDED.risk_state = 'RESTRICTED' THEN 'RESTRICTED'
            WHEN ${RESTRICTION_IS_ACTIVE} THEN 'RESTRICTED'
            ELSE EXCLUDED.risk_state
          END,
          rolling_score = (wallet_risk_profiles.rolling_score * 0.72) + (EXCLUDED.rolling_score * 0.28),
          last_decision = EXCLUDED.last_decision,
          last_reasons = EXCLUDED.last_reasons,
          decline_count = wallet_risk_profiles.decline_count
            + CASE WHEN :decision = 'DECLINE' THEN 1 ELSE 0 END,
          review_count = wallet_risk_profiles.review_count
            + CASE WHEN :decision = 'REVIEW' THEN 1 ELSE 0 END,
          review_required = CASE
            WHEN wallet_risk_profiles.risk_state = 'FROZEN'
              OR EXCLUDED.risk_state IN ('FROZEN', 'RESTRICTED') THEN TRUE
            WHEN ${RESTRICTION_IS_ACTIVE} THEN TRUE
            ELSE FALSE
          END,
          restricted_at = CASE
            WHEN EXCLUDED.risk_state IN ('RESTRICTED', 'FROZEN') THEN NOW()
            WHEN wallet_risk_profiles.risk_state = 'FROZEN'
              THEN wallet_risk_profiles.restricted_at
            WHEN ${RESTRICTION_IS_ACTIVE} THEN wallet_risk_profiles.restricted_at
            ELSE NULL
          END,
          frozen_at = COALESCE(wallet_risk_profiles.frozen_at, EXCLUDED.frozen_at),
          updated_at = NOW()
      `, {
        replacements: {
          userId,
          nextState,
          riskScore: finiteNumber(decision.risk_score),
          decision: decision.decision,
          reasons: JSON.stringify(decision.reasons || []),
          reviewRequired: BLOCKED_DECISIONS.has(decision.decision),
        },
        transaction: dbTransaction,
      });

      if (decision.wallet_action === 'FREEZE') {
        await sequelize.query(`
          UPDATE user_wallets
          SET is_locked = TRUE,
              lock_reason = :reason,
              updated_at = NOW()
          WHERE user_id = :userId AND is_locked = FALSE
        `, {
          replacements: {
            userId,
            reason: `[Anti-fraude temps réel] ${decision.authorization_id}`,
          },
          transaction: dbTransaction,
        });
      }

      await this._insertEvent({
        authorizationId: decision.authorization_id,
        userId,
        eventType: 'DECISION',
        decision: decision.decision,
        riskScore: finiteNumber(decision.risk_score),
        details: {
          walletAction: decision.wallet_action,
          confidence: finiteNumber(decision.confidence),
          reasons: decision.reasons || [],
          engineVersion: decision.engine_version,
        },
      }, dbTransaction);
    });
  }

  async consume(authorization, linkedTransactionId, dbTransaction) {
    if (!authorization || authorization.exempt) return;
    if (!dbTransaction) {
      throw new TransactionRiskError(
        'La preuve anti-fraude doit être consommée dans la transaction du wallet',
        'RISK_ATOMIC_CONSUMPTION_REQUIRED',
        500
      );
    }

    const [, metadata] = await sequelize.query(`
      UPDATE transaction_risk_authorizations
      SET status = 'CONSUMED',
          consumed_at = NOW(),
          linked_transaction_id = :linkedTransactionId,
          updated_at = NOW()
      WHERE id = :authorizationId
        AND request_hash = :requestHash
        AND status = 'AUTHORIZED'
        AND decision IN ('APPROVE', 'MONITOR')
        AND expires_at > NOW()
    `, {
      replacements: {
        authorizationId: authorization.id,
        requestHash: authorization.requestHash,
        linkedTransactionId,
      },
      transaction: dbTransaction,
    });

    const affectedRows = typeof metadata === 'number' ? metadata : metadata?.rowCount;
    if (affectedRows !== 1) {
      const rows = await sequelize.query(`
        SELECT status, linked_transaction_id, expires_at
        FROM transaction_risk_authorizations
        WHERE id = :authorizationId
      `, {
        type: QueryTypes.SELECT,
        replacements: { authorizationId: authorization.id },
        transaction: dbTransaction,
      });
      const row = rows[0];
      throw new TransactionRiskError(
        row?.status === 'CONSUMED'
          ? 'Cette transaction a déjà été exécutée'
          : 'L’autorisation anti-fraude a expiré avant le débit',
        row?.status === 'CONSUMED'
          ? 'TRANSACTION_ALREADY_PROCESSED'
          : 'TRANSACTION_AUTHORIZATION_EXPIRED',
        409,
        { transactionId: row?.linked_transaction_id || null }
      );
    }

    await this._insertEvent({
      authorizationId: authorization.id,
      userId: null,
      eventType: 'CONSUMED',
      decision: authorization.decision,
      riskScore: authorization.riskScore,
      details: { linkedTransactionId },
    }, dbTransaction, true);
  }

  async _insertEvent(event, dbTransaction, resolveUser = false) {
    await sequelize.query(`
      INSERT INTO transaction_risk_events (
        id, authorization_id, user_id, event_type, decision, risk_score, details, created_at
      ) VALUES (
        :id,
        :authorizationId,
        ${resolveUser
    ? '(SELECT user_id FROM transaction_risk_authorizations WHERE id = :authorizationId)'
    : ':userId'},
        :eventType,
        :decision,
        :riskScore,
        CAST(:details AS jsonb),
        NOW()
      )
    `, {
      replacements: {
        id: uuidv4(),
        authorizationId: event.authorizationId || null,
        userId: event.userId || null,
        eventType: event.eventType,
        decision: event.decision || null,
        riskScore: event.riskScore == null ? null : finiteNumber(event.riskScore),
        details: JSON.stringify(event.details || {}),
      },
      transaction: dbTransaction,
    });
  }

  riskMetadata(authorization) {
    if (!authorization || authorization.exempt) {
      return { riskExempt: true, riskExemptReason: authorization?.reason || 'explicit_exemption' };
    }
    return {
      riskAuthorizationId: authorization.id,
      riskDecision: authorization.decision,
      riskScore: authorization.riskScore,
      riskConfidence: authorization.confidence,
      riskEngineVersion: authorization.engineVersion,
    };
  }

  async setManualWalletState({ userId, frozen, reason, reviewerUserId }) {
    await this.initialize();
    return sequelize.transaction(async (dbTransaction) => {
      const [, walletMetadata] = await sequelize.query(`
        UPDATE user_wallets
        SET is_locked = :frozen,
            lock_reason = CASE WHEN :frozen THEN :reason ELSE NULL END,
            updated_at = NOW()
        WHERE user_id = :userId
      `, {
        replacements: {
          userId,
          frozen: Boolean(frozen),
          reason: boundedString(reason, 240) || 'Décision manuelle du Gardien',
        },
        transaction: dbTransaction,
      });

      await sequelize.query(`
        INSERT INTO wallet_risk_profiles (
          user_id, risk_state, rolling_score, last_decision, last_reasons,
          review_required, restricted_at, frozen_at, manual_trust_until, updated_at
        ) VALUES (
          :userId, :state, :score, :decision, CAST(:reasons AS jsonb),
          FALSE,
          CASE WHEN :frozen THEN NOW() ELSE NULL END,
          CASE WHEN :frozen THEN NOW() ELSE NULL END,
          CASE WHEN :frozen THEN NULL ELSE NOW() + INTERVAL '24 hours' END,
          NOW()
        )
        ON CONFLICT (user_id) DO UPDATE SET
          risk_state = EXCLUDED.risk_state,
          rolling_score = EXCLUDED.rolling_score,
          last_decision = EXCLUDED.last_decision,
          last_reasons = EXCLUDED.last_reasons,
          decline_count = CASE WHEN :frozen THEN wallet_risk_profiles.decline_count ELSE 0 END,
          review_count = CASE WHEN :frozen THEN wallet_risk_profiles.review_count ELSE 0 END,
          review_required = FALSE,
          restricted_at = EXCLUDED.restricted_at,
          frozen_at = EXCLUDED.frozen_at,
          manual_trust_until = EXCLUDED.manual_trust_until,
          updated_at = NOW()
      `, {
        replacements: {
          userId,
          frozen: Boolean(frozen),
          state: frozen ? 'FROZEN' : 'CLEAR',
          score: frozen ? 100 : 0,
          decision: frozen ? 'MANUAL_FREEZE' : 'MANUAL_CLEAR',
          reasons: JSON.stringify([boundedString(reason, 240) || 'manual_review']),
        },
        transaction: dbTransaction,
      });

      await this._insertEvent({
        authorizationId: null,
        userId,
        eventType: frozen ? 'MANUAL_FREEZE' : 'MANUAL_CLEAR',
        decision: frozen ? 'DECLINE' : 'APPROVE',
        riskScore: frozen ? 100 : 0,
        details: {
          reason: boundedString(reason, 240) || null,
          reviewerUserId: reviewerUserId || null,
        },
      }, dbTransaction);

      return {
        frozen: Boolean(frozen),
        affectedWallets: typeof walletMetadata === 'number'
          ? walletMetadata
          : (walletMetadata?.rowCount || 0),
      };
    });
  }

  async listRiskCases({ state = null, limit = 100 } = {}) {
    await this.initialize();
    const normalizedState = state
      ? boundedString(state, 20).toUpperCase()
      : null;
    if (normalizedState && !['CLEAR', 'MONITOR', 'RESTRICTED', 'FROZEN'].includes(normalizedState)) {
      throw new TransactionRiskError('État risque invalide', 'RISK_STATE_INVALID', 400);
    }
    return sequelize.query(`
      SELECT
        p.user_id,
        u.username,
        p.risk_state,
        p.rolling_score,
        p.last_decision,
        p.last_reasons,
        p.decline_count,
        p.review_count,
        p.replay_mismatch_count,
        p.review_required,
        p.restricted_at,
        p.frozen_at,
        p.updated_at,
        latest.id AS latest_authorization_id,
        latest.transaction_kind,
        latest.decision AS latest_authorization_decision,
        latest.risk_score AS latest_authorization_score,
        latest.confidence AS latest_authorization_confidence,
        latest.wallet_action AS latest_wallet_action,
        latest.signals AS latest_signals,
        latest.created_at AS latest_authorization_at
      FROM wallet_risk_profiles p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN LATERAL (
        SELECT id, transaction_kind, decision, risk_score, confidence,
               wallet_action, signals, created_at
        FROM transaction_risk_authorizations
        WHERE user_id = p.user_id
        ORDER BY created_at DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE (:state IS NULL OR p.risk_state = :state)
      ORDER BY
        CASE p.risk_state
          WHEN 'FROZEN' THEN 1
          WHEN 'RESTRICTED' THEN 2
          WHEN 'MONITOR' THEN 3
          ELSE 4
        END,
        p.updated_at DESC
      LIMIT :limit
    `, {
      type: QueryTypes.SELECT,
      replacements: {
        state: normalizedState,
        limit: Math.max(1, Math.min(500, Number(limit) || 100)),
      },
    });
  }

  static isRiskError(error) {
    return error instanceof TransactionRiskError
      || (error && typeof error.code === 'string' && (
        error.code.startsWith('RISK_')
        || error.code.startsWith('TRANSACTION_')
      ));
  }
}

const transactionAuthorizationService = new TransactionAuthorizationService();

module.exports = transactionAuthorizationService;
module.exports.TransactionRiskError = TransactionRiskError;
module.exports.requestContextMiddleware = requestContextMiddleware;
