/**
 * Auteur a crediter pour une interaction envoyee au recommandeur Rust.
 *
 * ── Pourquoi le serveur doit le resoudre lui-meme ───────────────────────────
 * Le tracker Rust ne fait trois choses qu'a condition de connaitre l'auteur du
 * tweet (voir `handlers/tracking.rs`) :
 *
 *   * `record_like_cooccurrence` — le filtrage collaboratif entier, qui ne se
 *     declenche que sur un LIKE **avec** `author_id`. C'est le seul signal
 *     capable de rapprocher deux comptes sans rapport thematique dont les
 *     publics se recouvrent ; aucun embedding ne le remplace ;
 *   * `record_author_feedback` — le boost temps reel de 30 minutes, qui agit
 *     sur la page suivante de la meme session ;
 *   * `record_arm_reward` — le bras du bandit d'exploration.
 *
 * Or `author_id` etait laisse a la charge du client, et aucun des deux clients
 * ne le joignait sur un like ou un retweet : les trois mecanismes ne se sont
 * donc jamais declenches. Le corriger cote client seul aurait laisse dehors
 * tout le parc deja installe — une application distribuee hors des stores met
 * des semaines a se mettre a jour. Le serveur, lui, connait le `tweetId` :
 * il peut retrouver l'auteur sans que personne ne mette a jour quoi que ce
 * soit.
 *
 * Le client continue de l'envoyer quand il le sait (c'est gratuit pour lui, il
 * a deja l'objet tweet en main) ; ce module n'est consulte qu'a defaut.
 *
 * ── Retweet pur : c'est l'auteur d'ORIGINE ──────────────────────────────────
 * Meme regle que `utils/engagementTarget` : un retweet pur n'a pas d'existence
 * propre cote engagement. Crediter le retweeteur ferait apprendre au moteur
 * une affinite pour quelqu'un qui n'a rien ecrit, et laisserait l'auteur reel
 * sans signal. Une citation, elle, est un post a part entiere : son auteur est
 * bien celui qui a cite.
 */

const { sequelize } = require('../database');
const { QueryTypes } = require('sequelize');
const logger = require('../utils/logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Duree de vie d'une entree.
 *
 * L'auteur d'un tweet ne change jamais : ce cache pourrait etre eternel. Il
 * expire quand meme, pour qu'un tweet supprime finisse par sortir de la
 * memoire du process au lieu d'y rester jusqu'au prochain redemarrage.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Plafond d'entrees. Au-dela, on vide les plus anciennes.
 *
 * Sans plafond, un fil tres actif ferait grossir cette Map indefiniment — une
 * fuite lente, invisible en developpement, qui ne se voit qu'au bout de
 * plusieurs jours de production.
 */
const CACHE_MAX = 5000;

/** tweetId -> { authorId: string|null, at: number } */
const cache = new Map();

function readCache(tweetId) {
  const hit = cache.get(tweetId);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(tweetId);
    return undefined;
  }
  return hit.authorId;
}

function writeCache(tweetId, authorId) {
  // `Map` conserve l'ordre d'insertion : les premieres cles sont les plus
  // anciennes, on peut donc elaguer sans tenir de structure supplementaire.
  if (cache.size >= CACHE_MAX) {
    const overflow = cache.size - CACHE_MAX + 1;
    let removed = 0;
    for (const key of cache.keys()) {
      cache.delete(key);
      if (++removed >= overflow) break;
    }
  }
  cache.set(tweetId, { authorId, at: Date.now() });
}

/**
 * Auteur a crediter pour une interaction sur `tweetId`.
 *
 * @param {string} tweetId
 * @returns {Promise<string|null>} UUID de l'auteur, ou `null` si le tweet est
 *   introuvable ou si la base repond mal. Jamais de throw : un tracking est un
 *   agrement, il ne doit pas faire echouer la requete qui le porte.
 */
async function resolveInteractionAuthor(tweetId) {
  const id = String(tweetId || '');
  if (!UUID_RE.test(id)) return null;

  const cached = readCache(id);
  if (cached !== undefined) return cached;

  try {
    const rows = await sequelize.query(
      `
      SELECT COALESCE(ot.user_id, t.user_id)::text AS author_id
      FROM tweets t
      LEFT JOIN tweets ot
        ON ot.id = t.original_tweet_id
       AND ot.deleted_at IS NULL
       -- Retweet PUR seulement : une citation garde son propre auteur.
       AND COALESCE(t.is_retweet, false) = true
       AND COALESCE(t.is_quote, false) = false
      WHERE t.id = :tweetId
      LIMIT 1
      `,
      { replacements: { tweetId: id }, type: QueryTypes.SELECT },
    );

    const authorId = rows?.[0]?.author_id ? String(rows[0].author_id) : null;
    // Un `null` se met en cache aussi : un tweet supprime ne doit pas relancer
    // une requete a chaque interaction qui trainerait encore dessus.
    writeCache(id, authorId);
    return authorId;
  } catch (error) {
    logger.warn(`[interactionAuthor] resolution impossible pour ${id}: ${error.message}`);
    return null;
  }
}

/**
 * Renvoie `provided` s'il est deja un UUID valide, sinon interroge la base.
 * C'est la forme attendue sur les routes de tracking.
 */
async function coalesceAuthorId(provided, tweetId) {
  const given = String(provided || '');
  if (UUID_RE.test(given)) return given;
  return resolveInteractionAuthor(tweetId);
}

module.exports = {
  resolveInteractionAuthor,
  coalesceAuthorId,
  // Exporte pour les tests : vider entre deux cas evite qu'ils se contaminent.
  _clearCache: () => cache.clear(),
};
