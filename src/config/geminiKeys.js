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
 * Les clés viennent EXCLUSIVEMENT de `GEMINI_API_KEYS` (liste séparée par des
 * virgules). Une liste de repli en clair vivait ici : le dépôt part en public,
 * et l'historique git garde de toute façon la trace de ce qui y a figuré — ces
 * clés-là sont donc à révoquer côté Google, pas seulement à déplacer.
 *
 * Pool vide = aucune requête tentée. Les appelants ont tous un chemin
 * « Gemini non configuré » ; échouer là, visiblement, vaut mieux que de
 * repartir en douce sur une clé codée en dur que personne ne pense à changer.
 */

const KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

if (KEYS.length === 0) {
  // Pas `throw` : la modération et les résumés savent se passer de Gemini, et
  // faire planter l'API entière au démarrage pour ça serait disproportionné.
  console.warn('[geminiKeys] GEMINI_API_KEYS absente ou vide — les appels Gemini seront ignorés.');
}

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
 * @returns {string[]} au moins une clé tant que le pool n'est pas vide, même si
 *   toutes ont été écartées : mieux vaut une tentative vouée à échouer
 *   bruyamment qu'un silence sans requête. Tableau vide si rien n'est
 *   configuré du tout.
 */
function keysInRotationOrder() {
  const live = KEYS.filter((k) => !disabled.has(k));
  const pool = live.length > 0 ? live : KEYS;
  if (pool.length === 0) return [];
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
