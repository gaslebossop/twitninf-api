/**
 * AUDIT R3-09 (2026-08-19) : `moderation_status`, `moderation_reason` et
 * `recommendation_group` sont des colonnes internes au pipeline de
 * modération/recommandation — aucun client ne les affiche (vérifié : contrairement
 * à `metadata`, dont d'autres clés comme `overlay_texts` ou `ab_test` SONT
 * lues côté client, voir le `toJSON()` de `Tweet.js` — celles-ci n'ont aucun
 * usage d'affichage identifié). Elles partaient pourtant sur toutes les
 * réponses de fil, de recherche et de recommandation, à chaque tweet.
 *
 * Volontairement une liste NOIRE, pas blanche : `moderationController.js`
 * sérialise aussi des tweets via `toJSON()` pour le tableau de bord de
 * modération, qui a lui besoin de voir `moderation_status`/`moderation_reason` —
 * une liste blanche centralisée dans `Tweet.toJSON()` casserait cet écran.
 * Cette fonction n'est donc appliquée qu'aux chemins de sortie publics
 * (fil, recherche, recommandations), jamais aux surfaces d'administration.
 */
function stripInternalTweetFields(tweetData) {
  if (!tweetData || typeof tweetData !== 'object') return tweetData;
  const { moderation_status, moderation_reason, recommendation_group, ...publicTweetData } = tweetData;
  return publicTweetData;
}

module.exports = { stripInternalTweetFields };
