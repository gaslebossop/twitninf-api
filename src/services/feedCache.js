'use strict';

/**
 * 🗃️ Cache de feed partagé entre tous les process du parc.
 *
 * ── Pourquoi il existe ──
 * Les moteurs de recommandation gardaient déjà des caches, mais dans des `Map`
 * en mémoire de process. Avec le process principal de A, trois répliques C et
 * le nœud B, ça faisait **cinq caches séparés** : le taux de hit était divisé
 * par cinq, et chaque C créé pendant une pointe démarrait avec un cache froid
 * qu'il remplissait en martelant la base — au pire moment.
 *
 * ── Pourquoi la réponse finale, et pas le pool classé ──
 * Le classement en mémoire coûte ~15 ms. Le reste d'une requête de feed coûte
 * bien plus : hydratation des tweets avec deux jointures imbriquées, requête
 * supplémentaire pour les parents manquants, filtre de visibilité, masquage des
 * contenus payants — soit 3 à 5 requêtes SQL par page. Cacher le pool classé
 * n'aurait économisé que les 15 ms. On cache donc la charge utile finale, celle
 * qui part au client.
 *
 * ── Ce qui rend ça sûr ──
 * 1. **La clé contient l'identifiant de l'utilisateur.** Une réponse de feed
 *    porte du contenu masqué selon les achats de CE lecteur ; elle ne doit
 *    jamais être servie à un autre. C'est l'invariant à ne pas casser.
 * 2. **Tout échec Redis est silencieux et non bloquant.** Un cache est une
 *    optimisation : s'il tombe, le feed doit ralentir, pas disparaître.
 * 3. **TTL court** (30 s par défaut) : la fenêtre de péremption maximale.
 * 4. **Invalidation ciblée** via un registre de clés par utilisateur, pour les
 *    deux cas où attendre le TTL serait visible et fautif : l'auteur qui vient
 *    de publier, et l'utilisateur qui vient d'acheter un contenu.
 *
 * ── Pourquoi un registre plutôt qu'un compteur de génération ──
 * Un compteur de génération dans la clé imposerait un `GET` supplémentaire à
 * **chaque lecture**. Le registre déplace ce coût sur l'invalidation, qui est
 * mille fois plus rare qu'une lecture de feed.
 */

const redis = require('redis');
const logger = require('../utils/logger');

const TTL_SECONDS = parseInt(process.env.FEED_CACHE_TTL_SECONDS, 10) || 30;

/**
 * ⚠️ DÉSACTIVÉ PAR DÉFAUT — mesuré comme une RÉGRESSION le 2026-08-07.
 *
 * Ce cache part d'une idée juste (mutualiser entre les cinq process ce qui
 * n'était caché qu'en mémoire de chacun) mais d'une hypothèse fausse sur le
 * trafic. Benchmark à paliers identiques, avant et après :
 *
 *   |  VU |        sans cache        |         avec cache          |
 *   | 100 | 20,1 rps · p95   102 ms  | 20,1 rps · p95   166 ms     |
 *   | 250 | 49,6 rps · p95   139 ms  | 48,9 rps · p95   614 ms     |
 *   | 500 | 98,5 rps · p95   513 ms  | 46,0 rps · p95 10 001 ms    |
 *                                      (21 % d'erreurs)
 *
 * Taux de hit relevé : **34 %**. La cause est structurelle, pas un réglage :
 * une réponse de feed est PERSONNELLE, et un utilisateur ne redemande pas la
 * même page assez souvent pour qu'un TTL de 30 s serve. Les deux tiers de
 * requêtes restantes paient alors un aller-retour Redis, un `JSON.stringify`
 * sur des instances Sequelize imbriquées, puis une écriture en trois commandes.
 * On ajoute du coût à 66 % du trafic pour en économiser sur 34 % : à 500
 * utilisateurs, ça fait basculer le cluster.
 *
 * Allonger le TTL ne sauverait rien : il faudrait des minutes de péremption sur
 * un fil social pour que le taux de hit devienne intéressant.
 *
 * **Ce qu'il faudrait cacher à la place** : ce qui est PARTAGÉ entre
 * utilisateurs — l'hydratation des tweets par identifiant, les profils
 * d'auteurs, les compteurs d'engagement. 775 tweets pour des milliers de
 * lecteurs : là, la réutilisation est massive. Le classement et le masquage,
 * eux, restent personnels et doivent rester calculés.
 *
 * Le module est conservé (testé, sans coût quand il est éteint) pour servir de
 * base à cette variante. Mettre `FEED_CACHE_ENABLED=true` pour le réactiver,
 * en connaissance de cause.
 */
const ENABLED = process.env.FEED_CACHE_ENABLED === 'true';
const PREFIX = 'feed:v1';

let client = null;
let connecting = null;
let unavailableUntil = 0;

// Compteurs exposés par /api/health pour vérifier que le cache sert vraiment,
// au lieu de le supposer.
const stats = { hits: 0, misses: 0, errors: 0, stores: 0, invalidations: 0 };

/**
 * Connexion paresseuse et partagée. Après une panne, on cesse d'essayer
 * pendant 5 s : sans ça, chaque requête de feed paierait un échec de connexion
 * et le cache rendrait le service PLUS lent que pas de cache du tout.
 */
async function getClient() {
  if (!ENABLED) return null;
  if (client && client.isReady) return client;
  if (Date.now() < unavailableUntil) return null;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const next = redis.createClient({
        socket: {
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: parseInt(process.env.REDIS_PORT, 10) || 6379,
          reconnectStrategy: (retries) => Math.min(retries * 200, 2000),
        },
        password: process.env.REDIS_PASSWORD || undefined,
      });
      // Sans ce gestionnaire, une erreur de socket devient une exception non
      // capturée qui tue le process.
      next.on('error', (error) => {
        stats.errors += 1;
        unavailableUntil = Date.now() + 5000;
        logger.warn(`[feedCache] Redis indisponible (${error.message}) — repli sans cache.`);
      });
      await next.connect();
      client = next;
      return client;
    } catch (error) {
      stats.errors += 1;
      unavailableUntil = Date.now() + 5000;
      logger.warn(`[feedCache] Connexion Redis impossible (${error.message}) — repli sans cache.`);
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

function cacheKey(scope, userId, params = {}) {
  const suffix = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join('&');
  return `${PREFIX}:${scope}:${userId}:${suffix}`;
}

function registryKey(userId) {
  return `${PREFIX}:reg:${userId}`;
}

/**
 * Enveloppe « cache-aside » autour d'un producteur.
 *
 * @param {object}   options
 * @param {string}   options.scope   nom court de la route (isole les formats)
 * @param {string}   options.userId  destinataire de la réponse — obligatoire
 * @param {object}   options.params  paramètres qui changent la réponse
 * @param {number}   [options.ttlSeconds]
 * @param {Function} producer        appelé seulement en cas de manque
 * @returns {Promise<{payload: any, hit: boolean}>}
 */
async function withFeedCache({ scope, userId, params = {}, ttlSeconds = TTL_SECONDS }, producer) {
  // Pas d'utilisateur = pas de cache. Mieux vaut ne rien cacher qu'inventer une
  // clé partagée sur des réponses personnalisées.
  if (!ENABLED || !userId) {
    return { payload: await producer(), hit: false };
  }

  const key = cacheKey(scope, userId, params);
  const redisClient = await getClient();

  if (redisClient) {
    try {
      const cached = await redisClient.get(key);
      if (cached) {
        stats.hits += 1;
        return { payload: JSON.parse(cached), hit: true };
      }
    } catch (error) {
      stats.errors += 1;
      logger.warn(`[feedCache] Lecture en échec (${error.message}).`);
    }
  }

  stats.misses += 1;
  const payload = await producer();

  // L'écriture ne doit jamais retarder la réponse : on la lance sans l'attendre.
  if (redisClient && payload !== undefined && payload !== null) {
    const serialized = safeSerialize(payload);
    if (serialized) {
      redisClient
        .multi()
        .set(key, serialized, { EX: ttlSeconds })
        .sAdd(registryKey(userId), key)
        // Le registre survit un peu plus longtemps que les entrées : il doit
        // encore exister au moment d'invalider les dernières.
        .expire(registryKey(userId), ttlSeconds * 3)
        .exec()
        .then(() => { stats.stores += 1; })
        .catch((error) => {
          stats.errors += 1;
          logger.warn(`[feedCache] Écriture en échec (${error.message}).`);
        });
    }
  }

  return { payload, hit: false };
}

/**
 * Les instances Sequelize se sérialisent mal et un feed peut être volumineux.
 * On refuse silencieusement de cacher ce qui dépasse 1 Mo plutôt que de saturer
 * Redis avec quelques réponses géantes.
 */
function safeSerialize(payload) {
  try {
    const serialized = JSON.stringify(payload);
    if (!serialized || serialized.length > 1_000_000) return null;
    return serialized;
  } catch (error) {
    logger.warn(`[feedCache] Charge non sérialisable (${error.message}).`);
    return null;
  }
}

/**
 * Invalide tout le feed caché d'un utilisateur.
 *
 * À appeler quand attendre le TTL serait visible et fautif : publication (son
 * propre tweet doit apparaître tout de suite) et achat d'un contenu payant (le
 * masquage est figé dans la réponse cachée).
 *
 * Les feeds des ABONNÉS restent périmés jusqu'au TTL, et c'est assumé :
 * quelques dizaines de secondes de retard sur le fil des autres est le prix du
 * cache, alors que ne pas voir son propre tweet passe pour un bug.
 */
async function invalidateUserFeed(userId) {
  if (!ENABLED || !userId) return;
  const redisClient = await getClient();
  if (!redisClient) return;
  try {
    const keys = await redisClient.sMembers(registryKey(userId));
    if (keys.length) await redisClient.del(keys);
    await redisClient.del(registryKey(userId));
    stats.invalidations += 1;
  } catch (error) {
    stats.errors += 1;
    logger.warn(`[feedCache] Invalidation en échec (${error.message}).`);
  }
}

/**
 * Variante middleware, pour les routes qu'on ne peut pas envelopper.
 *
 * `GET /api/tweets` a une douzaine de branches (vidéo, tri par
 * recommandation, tri chronologique, replis…) et autant d'appels à `res.json`
 * dispersés. Restructurer ce handler pour en extraire un producteur unique
 * serait un refactor risqué pour un gain de cache. On intercepte donc `res.json`
 * : le handler n'est pas modifié, et seules les réponses 200 non marquées en
 * échec sont retenues.
 *
 * @param {string} scope
 * @param {string[]} paramNames  paramètres de requête qui changent la réponse
 */
function feedCacheRoute(scope, paramNames = []) {
  return async function feedCacheMiddleware(req, res, next) {
    const userId = req.user && req.user.id;
    if (!ENABLED || !userId) return next();

    const params = {};
    for (const name of paramNames) {
      if (req.params && req.params[name] !== undefined) params[name] = req.params[name];
      else if (req.query && req.query[name] !== undefined) params[name] = req.query[name];
    }

    const key = cacheKey(scope, userId, params);
    const redisClient = await getClient();

    if (redisClient) {
      try {
        const cached = await redisClient.get(key);
        if (cached) {
          stats.hits += 1;
          return res.json(JSON.parse(cached));
        }
      } catch (error) {
        stats.errors += 1;
        logger.warn(`[feedCache] Lecture en échec (${error.message}).`);
      }
    }

    stats.misses += 1;

    const sendJson = res.json.bind(res);
    res.json = (body) => {
      // Ne jamais cacher une erreur : une panne passagère resterait servie
      // pendant tout le TTL, ce qui transforme un incident d'une seconde en
      // incident d'une minute.
      const cacheable = redisClient
        && res.statusCode === 200
        && body
        && body.success !== false;
      if (cacheable) {
        const serialized = safeSerialize(body);
        if (serialized) {
          redisClient
            .multi()
            .set(key, serialized, { EX: TTL_SECONDS })
            .sAdd(registryKey(userId), key)
            .expire(registryKey(userId), TTL_SECONDS * 3)
            .exec()
            .then(() => { stats.stores += 1; })
            .catch(() => { stats.errors += 1; });
        }
      }
      return sendJson(body);
    };

    return next();
  };
}

function getStats() {
  const total = stats.hits + stats.misses;
  return {
    enabled: ENABLED,
    ttl_seconds: TTL_SECONDS,
    ...stats,
    hit_rate: total ? Number((stats.hits / total).toFixed(3)) : null,
  };
}

async function close() {
  if (client) {
    try { await client.quit(); } catch { /* fermeture au mieux */ }
    client = null;
  }
}

module.exports = { withFeedCache, feedCacheRoute, invalidateUserFeed, getStats, close, TTL_SECONDS };
