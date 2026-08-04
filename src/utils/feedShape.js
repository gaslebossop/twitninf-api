'use strict';

/**
 * Mise en forme du fil : où placer les réponses.
 *
 * Isolé du routeur parce que c'est la seule pièce ici qui porte un invariant
 * vérifiable sans base ni serveur — et parce que cet invariant s'est déjà
 * cassé une fois en production.
 */

/**
 * Place chaque réponse JUSTE APRÈS le tweet auquel elle répond, et écarte
 * celles dont le parent n'est pas dans la page.
 *
 * ── Le bug d'origine ─────────────────────────────────────────────────────
 * La version précédente séparait la liste en `others` (sans parent) et
 * `replies` (avec parent), puis réinsérait une réponse tous les `minGap`
 * tweets. Le placement ne tenait aucun compte du parent : une réponse
 * atterrissait entre deux tweets sans rapport. D'où des réponses orphelines
 * dans le fil — « complètement d'accord » posé entre deux inconnus, sans le
 * message auquel il répond.
 *
 * ── Pourquoi le fil doit garantir l'adjacence ────────────────────────────
 * La requête joint le tweet parent et l'envoie avec la réponse
 * (`parentTweet`), l'intention étant que le client dessine une carte de
 * contexte au-dessus. Mais les clients rendent une liste plate et déduisent le
 * fil de l'ADJACENCE (`isThreadParent` / `isThreadChild` dans `TweetRow`) :
 * aucun n'a jamais lu ce champ. Plutôt que de réclamer un changement dans
 * chaque client (mobile, Windows), c'est le fil qui garantit ici l'invariant
 * dont ils dépendent déjà.
 *
 * `minGap` garde son rôle d'origine — ne pas noyer le fil sous les réponses —
 * mais s'applique à l'ÉCART entre deux fils affichés, plus à une position
 * arbitraire.
 *
 * @param {Array<object>} tweets  Fil ordonné par le scoring.
 * @param {number} minGap         Tweets minimum entre deux réponses affichées.
 * @returns {Array<object>}       Fil où toute réponse suit immédiatement son parent.
 */
function spaceOutReplies(tweets, minGap = 4) {
  const list = Array.isArray(tweets) ? tweets : [];
  const roots = list.filter((tweet) => !tweet.parent_tweet_id);
  if (roots.length === list.length) return roots;

  const rootIds = new Set(roots.map((tweet) => String(tweet.id)));

  // Réponses rattachables : leur parent est diffusé dans cette même page. Les
  // autres sont écartées — mieux vaut un tweet de moins qu'une ligne hors sujet.
  const repliesByParent = new Map();
  for (const tweet of list) {
    if (!tweet.parent_tweet_id) continue;
    const parentId = String(tweet.parent_tweet_id);
    if (!rootIds.has(parentId)) continue;
    if (!repliesByParent.has(parentId)) repliesByParent.set(parentId, []);
    repliesByParent.get(parentId).push(tweet);
  }
  if (repliesByParent.size === 0) return roots;

  const merged = [];
  // Distance depuis la dernière réponse insérée, pour ne pas enchaîner les
  // fils. Initialisée à `minGap` : la première réponse rencontrée est admise.
  let sinceLastReply = minGap;

  for (const root of roots) {
    merged.push(root);
    sinceLastReply += 1;

    const replies = repliesByParent.get(String(root.id));
    if (!replies || sinceLastReply < minGap) continue;

    // Une seule réponse par parent : au-delà, le fil devient une conversation
    // et n'a plus sa place dans un feed de découverte.
    merged.push(replies[0]);
    sinceLastReply = 0;
  }

  return merged;
}

module.exports = { spaceOutReplies };
