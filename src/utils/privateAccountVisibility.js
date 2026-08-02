/**
 * Visibilité des comptes privés.
 *
 * Un compte privé (`users.is_private_account`) a demandé à n'être lisible que
 * de ses abonnés ACCEPTÉS. Ça vaut pour son profil, mais aussi — et c'est ce
 * qui était troué — pour ses publications dès qu'elles quittent son profil :
 * fil de recommandations, tendances, recherche, vidéos.
 *
 * ⚠ Le réglage `tweets.is_private` déjà présent dans les requêtes est une
 * autre chose : c'est la visibilité d'UN tweet, décidée à la publication. Un
 * compte privé publie des tweets `is_private = false` tout à fait normaux —
 * c'est le COMPTE qui est fermé, pas le message. Les deux filtres sont donc
 * nécessaires et aucun ne remplace l'autre.
 *
 * Le lien de suivi doit être `active` : une demande encore `pending` n'ouvre
 * rien, c'est tout l'intérêt d'un compte privé.
 */

/**
 * Condition SQL vraie quand `alias` (une ligne de `users`) est lisible par le
 * spectateur. À injecter dans un WHERE, ou dans un ON de LEFT JOIN.
 *
 * @param {string} alias   alias de la table `users` dans la requête
 * @param {string} viewer  expression SQL de l'id du spectateur (paramètre lié,
 *                         jamais une valeur interpolée)
 */
function visibleAuthorSql(alias = 'u', viewer = ':userId::uuid') {
  return `(
    ${alias}.is_private_account = false
    OR ${alias}.id = ${viewer}
    OR EXISTS (
      SELECT 1 FROM user_follows vf
      WHERE vf.follower_id = ${viewer}
        AND vf.following_id = ${alias}.id
        AND vf.status = 'active'
    )
  )`;
}

/** Ids que `viewerId` suit avec une demande ACCEPTÉE. */
async function activeFollowingIds(UserFollow, viewerId) {
  if (!viewerId) return new Set();
  const rows = await UserFollow.findAll({
    where: { follower_id: viewerId, status: 'active' },
    attributes: ['following_id'],
    raw: true,
  });
  return new Set(rows.map((r) => String(r.following_id)));
}

/** Auteur d'un tweet, quelle que soit la forme renvoyée par le moteur. */
function authorOf(tweet) {
  return tweet?.author || tweet?.user || tweet?.User || null;
}

/** Tweet d'origine d'un retweet, quelle que soit la forme. */
function originalOf(tweet) {
  return tweet?.originalTweet || tweet?.original_tweet || tweet?.original || null;
}

/**
 * Retire d'une liste déjà construite les tweets qu'un compte privé ne veut pas
 * montrer à ce spectateur.
 *
 * Filtre de SORTIE, appliqué au niveau de la route, et c'est délibéré : les
 * moteurs de recommandation (progressif, similarité, Rust) raisonnent en
 * scores et en vecteurs, ils n'ont aucune notion de confidentialité. Les
 * patcher un par un laisserait forcément un chemin non couvert au prochain
 * moteur ajouté ; ici, tout ce qui sort par cette route passe par la même
 * porte.
 *
 * ⚠ La confidentialité est RELUE EN BASE, jamais prise sur l'objet auteur
 * fourni. Les `include` Sequelize des routes listent leurs attributs à la main
 * et aucun ne demande `is_private_account` : se fier au champ le laisserait
 * `undefined`, donc « public », et le filtre ne bloquerait rien du tout tout en
 * ayant l'air de fonctionner. La relecture coûte une requête sur une poignée
 * d'ids et ne dépend d'aucun appelant.
 *
 * ⚠ La liste peut revenir plus courte que `limit`. C'est le bon compromis :
 * la compléter demanderait de relancer le moteur, et une page un peu courte
 * vaut mieux qu'une fuite.
 */
async function filterVisibleTweets(tweets, viewerId, { User, UserFollow, Op }) {
  if (!Array.isArray(tweets) || tweets.length === 0) return tweets || [];

  const authorIds = new Set();
  for (const tweet of tweets) {
    const author = authorOf(tweet);
    if (author?.id) authorIds.add(String(author.id));
    const original = originalOf(tweet);
    const originalAuthor = original && authorOf(original);
    if (originalAuthor?.id) authorIds.add(String(originalAuthor.id));
  }
  if (authorIds.size === 0) return tweets;

  const privateRows = await User.findAll({
    where: { id: { [Op.in]: [...authorIds] }, is_private_account: true },
    attributes: ['id'],
    raw: true,
  });
  // Aucun compte privé dans la page : le cas de très loin le plus fréquent,
  // et on s'arrête avant de charger le graphe de suivi.
  if (privateRows.length === 0) return tweets;

  const privateIds = new Set(privateRows.map((r) => String(r.id)));
  const following = await activeFollowingIds(UserFollow, viewerId);

  const visible = (author) => {
    if (!author?.id) return true;
    const id = String(author.id);
    if (!privateIds.has(id)) return true;
    if (viewerId && id === String(viewerId)) return true;
    return following.has(id);
  };

  return tweets.filter((tweet) => {
    if (!visible(authorOf(tweet))) return false;
    // Un compte public qui retweete un compte privé ne le rend pas public.
    const original = originalOf(tweet);
    if (original && !visible(authorOf(original))) return false;
    return true;
  });
}

module.exports = {
  visibleAuthorSql,
  activeFollowingIds,
  filterVisibleTweets,
};
