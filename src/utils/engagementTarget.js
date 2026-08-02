/**
 * Résolution de la cible d'engagement d'un tweet.
 *
 * Un retweet pur n'a pas d'existence propre côté engagement : les likes, les
 * retweets, les réponses et les vues appartiennent au tweet d'origine. Les
 * compteurs affichés ET les interactions écrites doivent donc porter sur
 * l'original, sinon les deux ne pointent pas sur la même ligne : le compteur
 * lu reste à zéro pendant que le like s'enregistre sur la ligne du retweet
 * (c'est ce qui laissait des likes orphelins sur des lignes `is_retweet`).
 *
 * Une citation (`is_quote`) est un post à part entière, avec son propre
 * contenu : elle conserve ses propres compteurs.
 */

/** Vrai si le tweet est un retweet pur (pas une citation) avec un original. */
function isPureRetweet(tweet) {
  if (!tweet) return false;
  const type = String(tweet.tweet_type || '').toLowerCase();
  const flaggedRetweet = Boolean(tweet.is_retweet) || type === 'retweet';
  return flaggedRetweet && !tweet.is_quote && Boolean(tweet.original_tweet_id);
}

/**
 * Id de la ligne qui porte réellement l'engagement pour ce tweet.
 * Renvoie l'original pour un retweet pur, le tweet lui-même sinon.
 */
function engagementTargetId(tweet) {
  if (!tweet) return null;
  return isPureRetweet(tweet) ? String(tweet.original_tweet_id) : String(tweet.id);
}

/**
 * Variante à partir d'un id seul : charge le tweet pour décider.
 * `Tweet` est le modèle Sequelize (passé en paramètre pour éviter un cycle
 * d'imports avec `models/index.js`).
 *
 * Renvoie `{ tweet, targetId, redirected }` — `tweet` est la ligne demandée
 * (null si introuvable), `targetId` la ligne à muter, `redirected` indique
 * qu'on a basculé sur l'original.
 */
async function resolveEngagementTarget(Tweet, tweetId) {
  const tweet = await Tweet.findByPk(tweetId);
  if (!tweet) return { tweet: null, targetId: null, redirected: false };

  const targetId = engagementTargetId(tweet);
  const redirected = targetId !== String(tweet.id);

  // Sur une cible redirigée, l'appelant a besoin de l'original (auteur pour la
  // notification, tweet_type pour les moteurs vidéo…), pas de la ligne retweet.
  const targetTweet = redirected ? await Tweet.findByPk(targetId) : tweet;

  // Original supprimé entre-temps : on retombe sur la ligne demandée plutôt
  // que d'écrire sur une clé étrangère morte.
  if (!targetTweet) {
    return { tweet, targetTweet: tweet, targetId: String(tweet.id), redirected: false };
  }

  return { tweet, targetTweet, targetId, redirected };
}

/**
 * Expression SQL donnant l'id porteur de l'engagement, pour les requêtes
 * brutes. `alias` est l'alias de la table `tweets` dans la requête.
 */
function engagementTargetSql(alias = 't') {
  return `CASE
      WHEN (${alias}.is_retweet = true OR ${alias}.tweet_type = 'retweet')
       AND ${alias}.is_quote = false
       AND ${alias}.original_tweet_id IS NOT NULL
      THEN ${alias}.original_tweet_id
      ELSE ${alias}.id
    END`;
}

module.exports = {
  isPureRetweet,
  engagementTargetId,
  resolveEngagementTarget,
  engagementTargetSql,
};
