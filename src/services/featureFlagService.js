'use strict';

/**
 * 🚩 Service des drapeaux de fonctionnalité.
 *
 * Rôle : rendre l'évaluation assez peu coûteuse pour qu'on ose la faire
 * partout, y compris dans un chemin chaud comme le fil.
 *
 * ── Le chemin de lecture, du plus proche au plus lointain ──
 *   1. **Cache mémoire du process** (quelques secondes). Le cas normal :
 *      évaluer un drapeau ne touche alors ni Redis ni Postgres.
 *   2. **Redis**, partagé par tous les process du parc. Sert au démarrage
 *      d'une nouvelle instance et après expiration du cache mémoire, pour
 *      qu'une montée en charge ne se traduise pas par une rafale de requêtes
 *      SQL identiques.
 *   3. **Postgres**, uniquement quand les deux précédents sont froids.
 *
 * Le jeu de définitions tient en un seul document JSON : quelques dizaines de
 * drapeaux, quelques kilo-octets. On le charge donc EN ENTIER, jamais drapeau
 * par drapeau — un aller-retour, puis tout est local.
 *
 * ── Propagation d'un changement ──
 * Une écriture publie sur le canal Redis `feature-flags:invalidate`. Les
 * autres process vident leur cache mémoire en quelques millisecondes. Si la
 * publication échoue (Redis coupé), le TTL du cache mémoire garantit la
 * convergence en quelques secondes : la panne ralentit la propagation, elle
 * ne la casse pas.
 *
 * ── Règle de dégradation ──
 * Toute panne d'infrastructure rend un drapeau ÉTEINT, jamais allumé, et ne
 * lève jamais. Un drapeau sert à protéger du code neuf : en cas de doute, on
 * sert l'ancien comportement, celui qui est éprouvé.
 */

const redis = require('redis');
const logger = require('../utils/logger');
const evaluator = require('./featureFlagEvaluator');

const REDIS_KEY = 'feature-flags:definitions:v1';
const REDIS_CHANNEL = 'feature-flags:invalidate';
const REDIS_TTL_SECONDS = parseInt(process.env.FEATURE_FLAGS_REDIS_TTL, 10) || 300;
const MEMORY_TTL_MS = parseInt(process.env.FEATURE_FLAGS_MEMORY_TTL_MS, 10) || 5000;
const LAZY_TTL_SECONDS = 300;

let memoryCache = null;
let memoryCacheExpiresAt = 0;
let inflightLoad = null;

let client = null;
let subscriber = null;
let connecting = null;
let unavailableUntil = 0;

const stats = {
  memoryHits: 0,
  redisHits: 0,
  dbLoads: 0,
  invalidations: 0,
  errors: 0,
};

// ───────────────────────────── Redis ─────────────────────────────

function createRedisClient() {
  return redis.createClient({
    socket: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      reconnectStrategy: (retries) => Math.min(retries * 200, 2000),
    },
    password: process.env.REDIS_PASSWORD || undefined,
  });
}

/**
 * Connexion paresseuse et partagée, avec fenêtre d'abandon après panne : sans
 * elle, chaque évaluation paierait un échec de connexion et le cache coûterait
 * plus cher que l'absence de cache.
 */
async function getClient() {
  if (client && client.isReady) return client;
  if (Date.now() < unavailableUntil) return null;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const next = createRedisClient();
      next.on('error', (error) => {
        stats.errors += 1;
        unavailableUntil = Date.now() + 5000;
        logger.warn(`[featureFlags] Redis indisponible (${error.message}) — repli sur la base.`);
      });
      await next.connect();
      client = next;
      await subscribeToInvalidations();
      return client;
    } catch (error) {
      stats.errors += 1;
      unavailableUntil = Date.now() + 5000;
      logger.warn(`[featureFlags] Connexion Redis impossible (${error.message}).`);
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/**
 * Un client Redis en mode abonné ne peut plus exécuter de commandes : il en
 * faut donc un second, dédié. C'est le prix de la propagation instantanée.
 */
async function subscribeToInvalidations() {
  if (subscriber) return;
  try {
    subscriber = createRedisClient();
    subscriber.on('error', () => {
      /* Silencieux : la perte de l'abonnement retombe sur le TTL mémoire. */
    });
    await subscriber.connect();
    await subscriber.subscribe(REDIS_CHANNEL, () => {
      memoryCache = null;
      memoryCacheExpiresAt = 0;
      stats.invalidations += 1;
    });
  } catch (error) {
    subscriber = null;
    logger.warn(`[featureFlags] Abonnement aux invalidations impossible (${error.message}).`);
  }
}

// ───────────────────── Chargement des définitions ─────────────────────

async function loadFromDatabase() {
  const { FeatureFlag } = require('../models');
  stats.dbLoads += 1;

  const rows = await FeatureFlag.findAll({
    where: { archived_at: null },
    order: [['key', 'ASC']],
  });

  const definitions = {};
  for (const row of rows) {
    definitions[row.key] = row.toDefinition();
  }
  return definitions;
}

/**
 * Jeu complet des définitions actives, en passant par les trois niveaux de
 * cache. `inflightLoad` évite qu'une rafale de requêtes arrivant sur un cache
 * froid déclenche N chargements concurrents (« stampede ») — un seul part, les
 * autres attendent son résultat.
 */
async function getDefinitions() {
  if (memoryCache && Date.now() < memoryCacheExpiresAt) {
    stats.memoryHits += 1;
    return memoryCache;
  }
  if (inflightLoad) return inflightLoad;

  inflightLoad = (async () => {
    const redisClient = await getClient();

    if (redisClient) {
      try {
        const cached = await redisClient.get(REDIS_KEY);
        if (cached) {
          stats.redisHits += 1;
          memoryCache = JSON.parse(cached);
          memoryCacheExpiresAt = Date.now() + MEMORY_TTL_MS;
          return memoryCache;
        }
      } catch (error) {
        stats.errors += 1;
      }
    }

    let definitions;
    try {
      definitions = await loadFromDatabase();
    } catch (error) {
      stats.errors += 1;
      logger.error(`[featureFlags] Lecture des drapeaux impossible: ${error.message}`);
      // Un jeu vide = tout éteint. Voir la règle de dégradation en tête.
      return memoryCache || {};
    }

    memoryCache = definitions;
    memoryCacheExpiresAt = Date.now() + MEMORY_TTL_MS;

    if (redisClient) {
      try {
        await redisClient.set(REDIS_KEY, JSON.stringify(definitions), { EX: REDIS_TTL_SECONDS });
      } catch (error) {
        stats.errors += 1;
      }
    }

    return definitions;
  })().finally(() => {
    inflightLoad = null;
  });

  return inflightLoad;
}

/** À appeler après toute écriture. Vide les trois niveaux et prévient le parc. */
async function invalidate() {
  memoryCache = null;
  memoryCacheExpiresAt = 0;

  const redisClient = await getClient();
  if (!redisClient) return;
  try {
    await redisClient.del(REDIS_KEY);
    await redisClient.publish(REDIS_CHANNEL, String(Date.now()));
  } catch (error) {
    stats.errors += 1;
  }
}

/**
 * Purge les attributs coûteux mis en cache pour UN utilisateur.
 *
 * À appeler après tout changement qui rend le cache faux — aujourd'hui la
 * seule source est l'appartenance beta (`is_beta`). Sans cet appel, un compte
 * qu'on vient d'admettre reste jusqu'à cinq minutes sur l'ancien
 * comportement, sans erreur, sans log, et avec une interface qui lui promet
 * déjà la nouveauté.
 *
 * La clé n'est connue que d'ici : les appelants passent un identifiant, pas
 * un format de clé.
 */
async function invalidateUserContext(userId) {
  if (!userId) return;
  const redisClient = await getClient();
  if (!redisClient) return;
  try {
    await redisClient.del(`feature-flags:ctx:${userId}`);
  } catch (error) {
    stats.errors += 1;
  }
}

// ───────────────────── Construction du contexte ─────────────────────

function accountAgeDays(createdAt) {
  if (!createdAt) return null;
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

/**
 * Contexte à partir d'une instance User déjà chargée. Aucun accès base : les
 * appelants qui ont déjà l'utilisateur sous la main (la plupart des routes
 * authentifiées) ne paient rien.
 *
 * ⚠️ `createdAt` et non `created_at` : sur une instance Sequelize, lire
 * `.created_at` renvoie toujours `undefined`, et l'ancienneté du compte
 * vaudrait silencieusement `null` pour tout le monde.
 */
function contextFromUser(user, extra = {}) {
  if (!user) return { ...extra };
  const stats_ = user.stats || {};
  return {
    user_id: user.id ? String(user.id) : null,
    username: user.username || null,
    role: user.role || 'user',
    verified: Boolean(user.verified),
    premium: Boolean(user.premium),
    subscription_tier: user.subscription_tier || 'free',
    account_age_days: accountAgeDays(user.createdAt || user.created_at),
    followers: Number(stats_.followers) || 0,
    tweets: Number(stats_.tweets) || 0,
    preferred_language: user.preferred_language || null,
    is_data_test: Boolean(user.is_data_test),
    ...extra,
  };
}

/** Attributs techniques, lus sur les en-têtes du client officiel. */
function contextFromHeaders(req) {
  if (!req || typeof req.get !== 'function') return {};
  return {
    platform: (req.get('User-Platform') || '').toLowerCase() || null,
    app_version: req.get('X-App-Version') || null,
    client: req.get('X-TwitNinf-Client') || null,
    device_id: req.get('X-Device-ID') || null,
  };
}

/**
 * Résout les attributs coûteux, et seulement ceux qu'au moins un drapeau
 * référence réellement. Le résultat est mis en cache Redis 5 minutes par
 * utilisateur : le pays et le solde ne changent pas assez vite pour justifier
 * une lecture par requête.
 */
async function resolveLazyAttributes(context, definitions) {
  const needed = new Set();
  for (const flag of Object.values(definitions)) {
    for (const attribute of evaluator.referencedAttributes(flag)) {
      if (evaluator.LAZY_ATTRIBUTES.includes(attribute)) needed.add(attribute);
    }
  }
  if (needed.size === 0 || !context.user_id) return context;

  const cacheKey = `feature-flags:ctx:${context.user_id}`;
  const redisClient = await getClient();

  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) return { ...context, ...JSON.parse(cached) };
    } catch (error) {
      stats.errors += 1;
    }
  }

  const resolved = {};

  if (needed.has('country')) {
    try {
      const { QueryTypes } = require('sequelize');
      const { sequelize } = require('../models');
      const [row] = await sequelize.query(
        `SELECT country_code FROM user_location_events
          WHERE user_id = :userId AND country_code IS NOT NULL
          ORDER BY captured_at DESC LIMIT 1`,
        { replacements: { userId: context.user_id }, type: QueryTypes.SELECT }
      );
      resolved.country = row ? row.country_code : null;
    } catch (error) {
      resolved.country = null;
    }
  }

  if (needed.has('nf_balance')) {
    try {
      const { UserWallet } = require('../models');
      const { getPlatformCurrency } = require('../economy/platformCurrency');
      const currency = await getPlatformCurrency();
      const wallet = currency
        ? await UserWallet.findOne({
            where: { user_id: context.user_id, currency_id: currency.id },
            attributes: ['balance'],
          })
        : null;
      resolved.nf_balance = wallet ? Number(wallet.balance) : 0;
    } catch (error) {
      resolved.nf_balance = null;
    }
  }

  if (needed.has('is_beta')) {
    try {
      const { BetaMember } = require('../models');
      const row = await BetaMember.findOne({
        where: { user_id: context.user_id, status: 'approved' },
        attributes: ['user_id'],
      });
      resolved.is_beta = Boolean(row);
    } catch (error) {
      // Une panne vaut « pas membre », donc l'ancien comportement — jamais un
      // etat intermediaire ou l'app afficherait la beta sans y avoir droit.
      resolved.is_beta = false;
    }
  }

  if (redisClient) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(resolved), { EX: LAZY_TTL_SECONDS });
    } catch (error) {
      stats.errors += 1;
    }
  }

  return { ...context, ...resolved };
}

/**
 * Contexte complet depuis une requête Express. Charge l'utilisateur si le JWT
 * ne suffit pas — le jeton ne porte ni l'ancienneté du compte, ni les
 * compteurs, ni la langue de lecture.
 */
async function contextFromRequest(req) {
  const headers = contextFromHeaders(req);
  const userId = req?.user?.id;
  if (!userId) return headers;

  try {
    const { User } = require('../models');
    const user = await User.findByPk(userId, {
      attributes: [
        'id',
        'username',
        'role',
        'verified',
        'premium',
        'subscription_tier',
        'preferred_language',
        'is_data_test',
        'stats',
        'createdAt',
      ],
    });
    if (user) return contextFromUser(user, headers);
  } catch (error) {
    stats.errors += 1;
  }

  // Repli sur ce que porte le jeton : moins riche, mais suffisant pour les
  // ciblages courants (rôle, palier d'abonnement) et jamais bloquant.
  return contextFromUser(req.user, headers);
}

// ───────────────────── API publique du service ─────────────────────

/** Décision détaillée pour un drapeau. Ne lève jamais. */
/**
 * Évalue UN drapeau.
 *
 * ⚠️ Résout les attributs coûteux, comme `resolveAll` — et seulement ceux que
 * CE drapeau référence. Sans cela, `isEnabled()` et le middleware `requireFlag`
 * évalueraient un ciblage sur `country`, `nf_balance` ou `is_beta` comme si
 * l'attribut était absent : le segment ne matcherait jamais, silencieusement,
 * et le drapeau retomberait sur son palier global. Le même drapeau répondrait
 * alors « oui » à l'app (qui passe par `/resolve`) et « non » à une garde
 * serveur — deux vérités pour un seul drapeau.
 */
async function evaluateFlag(key, context = {}) {
  try {
    const definitions = await getDefinitions();
    const definition = definitions[key];
    if (!definition) return evaluator.evaluate(undefined, context);

    // Un seul drapeau à considérer : inutile de résoudre les attributs que
    // seuls les AUTRES drapeaux référencent.
    const fullContext = await resolveLazyAttributes(context, { [key]: definition });
    return evaluator.evaluate(definition, fullContext);
  } catch (error) {
    stats.errors += 1;
    return { enabled: false, variant: null, payload: null, reason: 'error', bucket: null, rule: null };
  }
}

/** Réponse courte pour le code applicatif : `if (await isEnabled(...))`. */
async function isEnabled(key, context = {}) {
  const decision = await evaluateFlag(key, context);
  return decision.enabled;
}

/** Variante servie (`null` si le drapeau est OFF ou purement booléen). */
async function getVariant(key, context = {}) {
  const decision = await evaluateFlag(key, context);
  return decision.enabled ? decision.variant : null;
}

/**
 * Tous les drapeaux résolus pour un contexte, en un seul passage — c'est ce
 * que l'app mobile récupère au démarrage, pour n'avoir ensuite aucun appel
 * réseau à faire quand elle teste un drapeau à l'écran.
 */
async function resolveAll(context = {}, { includeReasons = false } = {}) {
  const definitions = await getDefinitions();
  const fullContext = await resolveLazyAttributes(context, definitions);

  const flags = {};
  for (const [key, definition] of Object.entries(definitions)) {
    const decision = evaluator.evaluate(definition, fullContext);
    flags[key] = includeReasons
      ? decision
      : {
          enabled: decision.enabled,
          variant: decision.variant,
          payload: decision.payload,
        };
  }
  return { flags, context: fullContext };
}

function getStats() {
  return { ...stats, cached: Boolean(memoryCache), size: memoryCache ? Object.keys(memoryCache).length : 0 };
}

module.exports = {
  getDefinitions,
  invalidate,
  invalidateUserContext,
  contextFromUser,
  contextFromHeaders,
  contextFromRequest,
  resolveLazyAttributes,
  evaluateFlag,
  isEnabled,
  getVariant,
  resolveAll,
  getStats,
  evaluator,
};
