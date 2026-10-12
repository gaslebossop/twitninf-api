/**
 * Application du shadowban HORS des fils servis par le moteur Rust.
 *
 * ── Le trou que ça bouche ──
 * Le niveau de restriction (`clean` → `ghosted`) vit dans le moteur Rust, et
 * lui seul le consultait : il fermait « Pour toi », la Découverte, les
 * Tendances et le fil d'abonnement. Tout ce que l'API sert elle-même l'ignorait
 * — recherche, suggestions de comptes, hashtags tendance, réponses sous un
 * tweet, notifications. Un compte `ghosted` restait donc trouvable, suggéré,
 * lu en réponse et notifié chez tout le monde : la sanction ne se voyait que
 * dans un seul écran.
 *
 * ── Ce qui ferme quoi (pour les AUTRES — l'auteur voit toujours tout le sien) ──
 *   monitoring  plus suggéré, hors tendances
 *   suppressed  + absent de la recherche, réponses masquées sous les tweets
 *               des autres
 *   ghosted     + ses j'aime, reposts, abonnements, mentions et réponses ne
 *               notifient plus personne
 *
 * ── D'où viennent les niveaux ──
 * Les mêmes clés Redis que le chemin chaud du moteur
 * (`rust-recommender/src/shadowban/store.rs`) : la décision manuelle
 * `admin:shadowban:{id}` et le niveau dérivé des avertissements
 * `shadowban:level:{id}`. Le plus sévère des deux l'emporte, comme dans
 * `shadowban_load_levels`. Redis est partagé par les deux VPS et le moteur.
 *
 * Un Redis indisponible ne bloque rien : on rend « aucun niveau connu » et la
 * requête est servie. Un cache mémoire de 30 s évite un aller-retour par
 * requête de recherche.
 */

const redis = require('redis');
const logger = require('../utils/logger');

const RANK = { clean: 0, monitoring: 1, suppressed: 2, ghosted: 3 };
const CACHE_MS = 30_000;

let client = null;
let connecting = null;
let unavailableUntil = 0;
const cache = new Map(); // userId → { level, at }

async function getClient() {
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
      next.on('error', (e) => logger.warn(`[shadowbanGate] redis: ${e.message}`));
      await next.connect();
      client = next;
      return client;
    } catch (e) {
      logger.warn(`[shadowbanGate] Redis indisponible: ${e.message}`);
      unavailableUntil = Date.now() + 5000;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/** Normalise une valeur Redis (« Suppressed », « suppressed », marqueur clean…). */
function parseLevel(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase();
  if (v in RANK) return v;
  // Valeur inconnue : même règle que le moteur, une lecture ratée ne lève
  // pas une restriction en silence.
  return v.includes('clean') ? 'clean' : 'suppressed';
}

/**
 * Niveaux effectifs d'un lot de comptes. Rend une Map ne contenant QUE les
 * comptes restreints (niveau ≠ clean).
 */
async function levelsFor(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length) return out;

  const now = Date.now();
  const missing = [];
  for (const id of ids) {
    const hit = cache.get(id);
    if (hit && now - hit.at < CACHE_MS) {
      if (hit.level !== 'clean') out.set(id, hit.level);
    } else {
      missing.push(id);
    }
  }
  if (!missing.length) return out;

  const c = await getClient();
  if (!c) return out;
  try {
    const [manual, derived] = await Promise.all([
      c.mGet(missing.map((id) => `admin:shadowban:${id}`)),
      c.mGet(missing.map((id) => `shadowban:level:${id}`)),
    ]);
    missing.forEach((id, i) => {
      const a = parseLevel(manual[i]);
      const b = parseLevel(derived[i]);
      const level = [a, b].filter(Boolean).sort((x, y) => RANK[y] - RANK[x])[0] || 'clean';
      cache.set(id, { level, at: now });
      if (level !== 'clean') out.set(id, level);
    });
  } catch (e) {
    logger.warn(`[shadowbanGate] lecture des niveaux: ${e.message}`);
  }
  if (cache.size > 20000) cache.clear();
  return out;
}

async function levelOf(userId) {
  return (await levelsFor([userId])).get(String(userId)) || 'clean';
}

/** Oublie le niveau en cache (après une décision de modération). */
function invalidate(userId) {
  if (userId) cache.delete(String(userId));
}

const atLeast = (level, min) => RANK[level || 'clean'] >= RANK[min];

/**
 * Retire d'une liste les éléments dont l'auteur est restreint au moins à
 * `min`. Le lecteur garde toujours ses propres éléments.
 *
 * @param {Array} list
 * @param {string|null} viewerId
 * @param {(item) => string|undefined} authorOf
 * @param {'monitoring'|'suppressed'|'ghosted'} min
 */
async function hideRestricted(list, viewerId, authorOf, min) {
  if (!Array.isArray(list) || !list.length) return list || [];
  const levels = await levelsFor(list.map(authorOf));
  if (!levels.size) return list;
  const me = viewerId ? String(viewerId) : null;
  return list.filter((item) => {
    const author = authorOf(item);
    if (!author || String(author) === me) return true;
    return !atLeast(levels.get(String(author)), min);
  });
}

/**
 * Faut-il taire une notification dont `senderId` est l'auteur ? Seules les
 * notifications sociales (j'aime, repost, abonnement, mention, réponse,
 * citation) sont concernées : un message système n'a pas d'expéditeur.
 */
const SOCIAL_TYPES = new Set(['like', 'retweet', 'follow', 'mention', 'reply', 'quote']);
async function shouldMuteNotification({ sender_id: senderId, recipient_id: recipientId, type }) {
  if (!senderId || !SOCIAL_TYPES.has(type)) return false;
  if (recipientId && String(recipientId) === String(senderId)) return false;
  return atLeast(await levelOf(senderId), 'ghosted');
}

/**
 * Tous les comptes restreints connus, pour le panneau de modération : niveau
 * effectif, origine (décision manuelle ou avertissements), motif et date de
 * fin quand Redis en porte une.
 */
async function listRestricted() {
  const c = await getClient();
  if (!c) throw new Error('Redis indisponible');
  const ids = new Set();
  for await (const key of c.scanIterator({ MATCH: 'admin:shadowban:*', COUNT: 500 })) {
    const k = Array.isArray(key) ? key : [key];
    for (const one of k) {
      const id = one.slice('admin:shadowban:'.length);
      if (/^[0-9a-f-]{36}$/i.test(id)) ids.add(id);
    }
  }
  for await (const key of c.scanIterator({ MATCH: 'shadowban:level:*', COUNT: 500 })) {
    const k = Array.isArray(key) ? key : [key];
    for (const one of k) ids.add(one.slice('shadowban:level:'.length));
  }
  const list = [...ids];
  if (!list.length) return [];

  const [manual, derived, reasons] = await Promise.all([
    c.mGet(list.map((id) => `admin:shadowban:${id}`)),
    c.mGet(list.map((id) => `shadowban:level:${id}`)),
    c.mGet(list.map((id) => `admin:shadowban:reason:${id}`)),
  ]);
  const ttls = await Promise.all(list.map((id) => c.ttl(`admin:shadowban:${id}`)));

  const out = [];
  list.forEach((id, i) => {
    const m = parseLevel(manual[i]);
    const d = parseLevel(derived[i]);
    const level = [m, d].filter(Boolean).sort((x, y) => RANK[y] - RANK[x])[0] || 'clean';
    if (level === 'clean') return;
    let reason = reasons[i] || null;
    try { const parsed = JSON.parse(reason); reason = parsed?.reason ?? reason; } catch { /* texte brut */ }
    out.push({
      user_id: id,
      level,
      source: m && RANK[m] >= RANK[d || 'clean'] ? 'manual' : 'strikes',
      reason: typeof reason === 'string' ? reason : null,
      expires_at: m && ttls[i] > 0 ? new Date(Date.now() + ttls[i] * 1000).toISOString() : null,
    });
  });
  return out.sort((a, b) => RANK[b.level] - RANK[a.level]);
}

module.exports = {
  listRestricted,
  levelsFor,
  levelOf,
  invalidate,
  hideRestricted,
  shouldMuteNotification,
  atLeast,
};
