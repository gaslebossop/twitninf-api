/**
 * Pool de clés Gemini, en rotation.
 *
 * Pourquoi un pool et pas une clé : le palier gratuit de l'API limite le nombre
 * de requêtes PAR MINUTE. Une seule clé tient un usage régulier mais pas une
 * rafale — et la modération produit exactement des rafales (dix signalements
 * d'un coup sur un même contenu, un lot de mise en file qui rattrape l'arriéré).
 * Constaté en prod le 2026-07-28 : les 47 items ouverts de la revue
 * communautaire étaient tous bloqués en `anonymization_status = 'failed'`, avec
 * un 429 « quota exceeded » derrière chacun. Le contenu n'avait rien de
 * problématique, il était juste arrivé au mauvais moment.
 *
 * Les clés sont en clair dans le dépôt — c'était déjà le cas dans les deux
 * services qui les utilisaient, et les rassembler ici ne l'aggrave pas ; ça
 * évite en revanche qu'une clé révoquée soit corrigée à un endroit sur deux.
 * `GEMINI_API_KEYS` (liste séparée par des virgules) prend le dessus quand elle
 * est définie, ce qui permet de sortir les clés du dépôt sans toucher au code.
 */

const FALLBACK_KEYS = [
  'AIzaSyD--8mAE-Wwr6em-iJNZFpfaR8JX-p3CO0',
  'AIzaSyAWqaeqcKXy5eGv5XwAcSmpfEnUlUXV7AM',
  'AIzaSyAym2vUwH85VbgX2MzQJ3rULYfsCcY_XIE',
  'AIzaSyBEat6WA9Kx0-PAsY3vNdwSqEOPMVF9GSc',
  'AIzaSyBvBnqQvezndbMdisr8j1GAwF183xEIwvs',
  'AIzaSyAetk-R-AllglFwWclFsrVLm7Q1AQFdKlE',
  'AIzaSyDf0cgSNzBCgJLzOtb05wPsk7fMO5UtMUo',
  'AIzaSyCYOfKUVUkToCeHTvRuyfatgrTUipq0YDk',
  'AIzaSyAmlveZzsCWMXuAycMwGMiXcjl_YDkxLDc',
];

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

const KEYS = GEMINI_KEYS.length > 0 ? GEMINI_KEYS : FALLBACK_KEYS;

/**
 * Clés écartées pour la durée du process : celles qui ont répondu autre chose
 * qu'un dépassement de quota (révoquée, projet supprimé, facturation coupée).
 * Les réessayer à chaque appel ferait perdre une tentative par clé morte, et il
 * y en a réellement dans la liste. Volontairement NON persisté : un blocage
 * temporaire côté Google se répare au prochain redémarrage plutôt que de
 * condamner la clé pour toujours.
 */
const disabled = new Set();

let cursor = 0;

/**
 * Les clés à essayer, dans l'ordre, en repartant d'un point différent à chaque
 * appel. Sans ce décalage, tout le trafic taperait la clé n°1 jusqu'à son
 * plafond avant de découvrir la suivante — le pool ne servirait que de secours
 * au lieu de répartir la charge.
 *
 * @returns {string[]} au moins une clé, même si toutes ont été écartées : mieux
 *   vaut une tentative vouée à échouer bruyamment qu'un silence sans requête.
 */
function keysInRotationOrder() {
  const live = KEYS.filter((k) => !disabled.has(k));
  const pool = live.length > 0 ? live : KEYS;
  const start = cursor % pool.length;
  cursor = (cursor + 1) % pool.length;
  return [...pool.slice(start), ...pool.slice(0, start)];
}

/** Écarte une clé qui a échoué pour autre chose qu'un quota. */
function disableKey(key) {
  disabled.add(key);
}

/** Un 429 ne condamne pas la clé — il dit juste « pas maintenant ». */
const isQuotaError = (error) => /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(String(error?.message || ''));

module.exports = { KEYS, keysInRotationOrder, disableKey, isQuotaError };
