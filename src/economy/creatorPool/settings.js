/**
 * Réglages du pot créateur, modifiables SANS redéploiement.
 *
 * Les valeurs par défaut vivent ici ; la table `monetization_settings` ne
 * contient que les écarts volontaires. Une clé absente en base retombe donc
 * sur le défaut du code, et supprimer une ligne annule un réglage au lieu de
 * le remettre à zéro.
 *
 * Ce qui se règle ici déplace de l'argent réel : chaque lecture est donc
 * bornée. Une valeur aberrante en base (part de pot à 5, poids négatifs) est
 * ramenée dans son intervalle et signalée, jamais appliquée telle quelle —
 * une faute de frappe en base ne doit pas pouvoir vider la trésorerie.
 */

const { sequelize } = require('../../database/index');
const logger = require('../../utils/logger');

const DEFAULTS = {
  /** Part des entrées de trésorerie de la période reversée aux créateurs. */
  poolShareOfInflows: 0.5,

  /**
   * Part maximale du SOLDE de trésorerie qu'une clôture peut engager.
   *
   * Second garde-fou, indépendant du premier : les entrées d'une semaine
   * exceptionnelle (une grosse campagne pub) peuvent dépasser ce que la
   * trésorerie détient réellement au moment de la clôture, puisqu'elle a pu
   * dépenser entre-temps. `rewardFromTreasury` refuserait alors les derniers
   * versements de la file — les créateurs seraient payés dans l'ordre
   * d'encaissement, ce qui n'est pas un partage.
   */
  maxDrawOfTreasuryBalance: 0.35,

  /** Pondération des composantes de qualité. Leur somme n'a pas à valoir 1. */
  weights: {
    attention: 0.45,
    retention: 0.25,
    dau: 0.20,
    penalty: 0.10,
  },

  /**
   * Plancher de qualité.
   *
   * Personne ne tombe à zéro : un créateur éligible qui a publié et été vu
   * touche quelque chose, sinon le classement percentile transforme la
   * dernière place en sanction. `0.05` = un vingtième de la meilleure qualité
   * à volume égal.
   */
  qualityFloor: 0.05,

  /** Décote appliquée à l'attention estimée faute de dwell réel. */
  attentionProxyDiscount: 0.5,

  /**
   * Plafond de dwell par vue, en millisecondes. Repris de `scout/data.go`
   * (`LEAST(..., 600000)`) : un écran resté ouvert toute la nuit n'est pas de
   * l'attention.
   */
  dwellCapMs: 600000,

  /** En dessous, la part n'est pas écrite : elle coûterait plus cher à afficher qu'elle ne vaut. */
  minPayoutNf: 0.01,

  /** Récompenses supplémentaires — multiplicateurs de poids, voir `bonuses.js`. */
  bonuses: {
    audienceRevealer: { enabled: true, multiplier: 1.10, minRatioToAverage: 2.0 },
    deepAttention: { enabled: true, multiplier: 1.05, minPercentile: 0.90 },
  },

  /** Récidive qualité : fenêtre et escalade. Voir `services/contentQualityService.js`. */
  quality: {
    recurrenceWindowDays: 14,
    /** Durées de restriction, en jours, par rang de récidive (2ᵉ fait, 3ᵉ, 4ᵉ…). */
    escalationDays: [1, 3, 7],
    /** Au-delà de la dernière marche, un vrai avertissement daté entre au registre Rust. */
    strikePolicyBeyondEscalation: 'unoriginal',
  },
};

const CACHE_TTL_MS = 60_000;
let cache = null;
let cachedAt = 0;

function clampNumber(value, fallback, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) {
    logger.warn(`[creatorPool] réglage ${label}=${n} hors de [${min}, ${max}] — ramené dans l'intervalle`);
    return Math.min(max, Math.max(min, n));
  }
  return n;
}

function sanitize(raw) {
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  if (!raw || typeof raw !== 'object') return s;

  s.poolShareOfInflows = clampNumber(raw.poolShareOfInflows, s.poolShareOfInflows, 0, 1, 'poolShareOfInflows');
  s.maxDrawOfTreasuryBalance = clampNumber(raw.maxDrawOfTreasuryBalance, s.maxDrawOfTreasuryBalance, 0, 1, 'maxDrawOfTreasuryBalance');
  s.qualityFloor = clampNumber(raw.qualityFloor, s.qualityFloor, 0, 1, 'qualityFloor');
  s.attentionProxyDiscount = clampNumber(raw.attentionProxyDiscount, s.attentionProxyDiscount, 0, 1, 'attentionProxyDiscount');
  s.dwellCapMs = clampNumber(raw.dwellCapMs, s.dwellCapMs, 1000, 3600000, 'dwellCapMs');
  s.minPayoutNf = clampNumber(raw.minPayoutNf, s.minPayoutNf, 0, 1000, 'minPayoutNf');

  if (raw.weights && typeof raw.weights === 'object') {
    for (const k of ['attention', 'retention', 'dau', 'penalty']) {
      s.weights[k] = clampNumber(raw.weights[k], s.weights[k], 0, 1, `weights.${k}`);
    }
  }

  if (raw.bonuses && typeof raw.bonuses === 'object') {
    const b = raw.bonuses;
    if (b.audienceRevealer) {
      s.bonuses.audienceRevealer.enabled = b.audienceRevealer.enabled !== false;
      s.bonuses.audienceRevealer.multiplier = clampNumber(
        b.audienceRevealer.multiplier, 1.10, 1, 2, 'bonuses.audienceRevealer.multiplier');
      s.bonuses.audienceRevealer.minRatioToAverage = clampNumber(
        b.audienceRevealer.minRatioToAverage, 2.0, 1, 20, 'bonuses.audienceRevealer.minRatioToAverage');
    }
    if (b.deepAttention) {
      s.bonuses.deepAttention.enabled = b.deepAttention.enabled !== false;
      s.bonuses.deepAttention.multiplier = clampNumber(
        b.deepAttention.multiplier, 1.05, 1, 2, 'bonuses.deepAttention.multiplier');
      s.bonuses.deepAttention.minPercentile = clampNumber(
        b.deepAttention.minPercentile, 0.90, 0, 1, 'bonuses.deepAttention.minPercentile');
    }
  }

  if (raw.quality && typeof raw.quality === 'object') {
    s.quality.recurrenceWindowDays = Math.round(clampNumber(
      raw.quality.recurrenceWindowDays, s.quality.recurrenceWindowDays, 1, 365, 'quality.recurrenceWindowDays'));
    if (Array.isArray(raw.quality.escalationDays) && raw.quality.escalationDays.length > 0) {
      s.quality.escalationDays = raw.quality.escalationDays
        .map((d, i) => Math.round(clampNumber(d, 1, 1, 90, `quality.escalationDays[${i}]`)))
        .slice(0, 10);
    }
    if (typeof raw.quality.strikePolicyBeyondEscalation === 'string') {
      s.quality.strikePolicyBeyondEscalation = raw.quality.strikePolicyBeyondEscalation;
    }
  }

  return s;
}

/**
 * Réglages effectifs. Cache court : la clôture hebdomadaire lit ces valeurs
 * en boucle, mais un réglage changé en base doit être pris en compte sans
 * redémarrer l'API.
 */
async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;

  let stored = null;
  try {
    const rows = await sequelize.query(
      `SELECT value FROM monetization_settings WHERE key = 'creator_pool' LIMIT 1`,
      { type: sequelize.QueryTypes.SELECT }
    );
    stored = rows[0]?.value || null;
    if (typeof stored === 'string') stored = JSON.parse(stored);
  } catch (e) {
    // Table absente (première mise en service) ou base indisponible : les
    // défauts du code suffisent à faire tourner une clôture correcte.
    logger.warn(`[creatorPool] réglages non lus, défauts appliqués: ${e.message}`);
  }

  cache = sanitize(stored);
  cachedAt = Date.now();
  return cache;
}

/** Écrit un jeu de réglages partiel et invalide le cache local. */
async function updateSettings(patch) {
  const current = await getSettings({ fresh: true });
  const merged = sanitize({ ...current, ...(patch || {}) });
  await sequelize.query(
    `INSERT INTO monetization_settings (key, value, updated_at)
     VALUES ('creator_pool', CAST(:value AS jsonb), NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    { replacements: { value: JSON.stringify(merged) } }
  );
  cache = merged;
  cachedAt = Date.now();
  return merged;
}

function invalidate() {
  cache = null;
  cachedAt = 0;
}

module.exports = { DEFAULTS, getSettings, updateSettings, invalidate, sanitize };
