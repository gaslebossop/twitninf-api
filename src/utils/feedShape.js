'use strict';

/**
 * Mise en forme du fil : où placer les réponses.
 *
 * Isolé du routeur parce que c'est la seule pièce ici qui porte un invariant
 * vérifiable sans base ni serveur — et parce que cet invariant s'est déjà
 * cassé une fois en production.
 */

/**
 * Profondeur maximale d'un fil affiché d'un bloc dans le feed.
 *
 * Alignée sur `MAX_THREAD_DEPTH` du recommandeur Rust (`recommender.rs`) : le
 * moteur ne sert jamais de chaîne plus profonde, et l'API n'a aucune raison
 * d'en tronquer une qu'il a jugée affichable.
 */
const MAX_THREAD_DEPTH = 4;

/**
 * Place chaque réponse JUSTE APRÈS le tweet auquel elle répond, et écarte
 * celles dont le parent n'est pas dans la page.
 *
 * ── Fils profonds ────────────────────────────────────────────────────────
 * Une réponse à une réponse est servie comme le reste du fil. La version
 * précédente ne rattachait les réponses qu'aux RACINES : dès que le
 * recommandeur Rust a commencé à envoyer des chaînes complètes (racine →
 * réponse → réponse), le maillon du bas retombait dans le cas « parent absent »
 * et disparaissait — alors que son parent était juste là, deux lignes plus
 * haut.
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
  if (list.length === 0) return [];

  const byId = new Map(list.map((tweet) => [String(tweet.id), tweet]));

  // Une seule réponse par parent — au-delà, le fil de découverte devient un fil
  // de conversation. C'est la PREMIÈRE rencontrée qui est retenue, donc la
  // mieux classée : la liste arrive dans l'ordre du scoring.
  const childOf = new Map();
  for (const tweet of list) {
    if (!tweet.parent_tweet_id) continue;
    const parentId = String(tweet.parent_tweet_id);
    // Parent absent de la page : la réponse est écartée. Mieux vaut un tweet de
    // moins qu'une ligne hors sujet.
    if (!byId.has(parentId)) continue;
    if (childOf.has(parentId)) continue;
    childOf.set(parentId, tweet);
  }

  // Chaque bloc est un fil complet : [racine, réponse, réponse à la réponse…].
  // Les blocs, pas les tweets, sont l'unité d'émission — c'est ce qui rend
  // l'adjacence indestructible par la suite.
  const blocks = [];
  for (const tweet of list) {
    // Une réponse rejoint le bloc de son parent, ou n'est pas servie du tout :
    // dans les deux cas elle n'ouvre jamais un bloc.
    if (tweet.parent_tweet_id) continue;

    const block = [tweet];
    const seen = new Set([String(tweet.id)]);
    let cursor = tweet;
    while (block.length < MAX_THREAD_DEPTH) {
      const next = childOf.get(String(cursor.id));
      // `seen` protège d'un cycle parent/enfant en base : sans lui, deux tweets
      // qui se répondent mutuellement boucleraient jusqu'à la profondeur max à
      // chaque page servie.
      if (!next || seen.has(String(next.id))) break;
      block.push(next);
      seen.add(String(next.id));
      cursor = next;
    }
    blocks.push(block);
  }

  const merged = [];
  // Distance depuis la dernière réponse insérée, pour ne pas enchaîner les
  // fils. Initialisée à `minGap` : la première réponse rencontrée est admise.
  let sinceLastReply = minGap;

  for (const block of blocks) {
    merged.push(block[0]);
    sinceLastReply += 1;

    if (block.length === 1) continue;
    // Fil trop rapproché du précédent : on garde la racine seule plutôt que de
    // décaler la réponse ailleurs. `minGap` espace les fils, il ne déplace
    // jamais une réponse loin de son parent.
    if (sinceLastReply < minGap) continue;

    for (const reply of block.slice(1)) merged.push(reply);
    sinceLastReply = 0;
  }

  return merged;
}

module.exports = { spaceOutReplies };
