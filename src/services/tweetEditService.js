const { TweetEdit, Tweet, User } = require('../models');
const { sequelize } = require('../database/index');
const { isSubscriptionActive, isUltraActive } = require('../utils/subscriptionHelpers');
const {
  TWEET_EDIT_WINDOW_MS,
  TWEET_EDIT_MAX_REVISIONS,
  TWEET_EDIT_MAX_REVISIONS_ULTRA,
} = require('../constants/premiumMarket');

/**
 * Édition d'un tweet publié — avantage abonné.
 *
 * Avant ce service, `PUT /api/tweets/:id` réécrivait le contenu sans aucune
 * limite : n'importe quel compte, à n'importe quel moment, sans trace. C'est
 * le point important de ce fichier — il ne s'agit pas seulement d'ajouter un
 * avantage payant, mais de fermer une porte qui était grande ouverte. Un
 * tweet vieux de six mois pouvait devenir n'importe quoi tout en gardant ses
 * retweets, ses réponses et sa portée.
 *
 * Trois règles, toutes vérifiées ici :
 * - abonnement actif (Plus ou Pro) ;
 * - dans les 30 minutes suivant la publication ;
 * - historique public écrit avant la modification.
 *
 * Un compte Ultra obtient DEUX FOIS plus de révisions, et rien d'autre : la
 * fenêtre de 30 minutes ne s'achète pas. Elle protège ceux qui ont retweeté un
 * texte précis, alors que le compteur de révisions ne protège personne
 * (l'historique est public) — il empêche seulement un tweet de devenir une
 * ardoise.
 *
 * Le staff passe outre les deux premières (`asStaff`) : retirer une donnée
 * personnelle d'un tweet ancien est une obligation, pas un avantage payant.
 */

class TweetEditError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TweetEditError';
    this.code = code;
  }
}

/** Révisions autorisées sur un tweet, selon le palier de son auteur. */
function maxRevisionsFor(author) {
  return isUltraActive(author) ? TWEET_EDIT_MAX_REVISIONS_ULTRA : TWEET_EDIT_MAX_REVISIONS;
}

/** Millisecondes restantes pour modifier ; 0 si la fenêtre est fermée. */
function remainingWindowMs(tweet) {
  const published = new Date(tweet.created_at || tweet.createdAt).getTime();
  if (!Number.isFinite(published)) return 0;
  return Math.max(0, published + TWEET_EDIT_WINDOW_MS - Date.now());
}

/**
 * Résumé d'édition joint à l'affichage d'un tweet.
 *
 * Renvoie `null` quand le tweet n'a jamais été modifié : c'est le cas de la
 * quasi-totalité d'entre eux, et un objet vide sur chaque tweet du fil
 * n'apporterait que du poids.
 */
async function summaryFor(tweetId) {
  const count = await TweetEdit.count({ where: { tweet_id: tweetId } });
  if (!count) return null;
  const last = await TweetEdit.findOne({
    where: { tweet_id: tweetId },
    order: [['revision', 'DESC']],
    attributes: ['created_at', 'revision'],
  });
  return {
    edited: true,
    revisions: count,
    last_edited_at: last?.created_at || null,
  };
}

/** Historique complet, public : c'est ce qui rend l'édition acceptable. */
async function historyFor(tweetId) {
  const rows = await TweetEdit.findAll({
    where: { tweet_id: tweetId },
    order: [['revision', 'ASC']],
    include: [{ model: User, as: 'editor', attributes: ['id', 'username'] }],
  });
  return rows.map((r) => ({
    revision: r.revision,
    previous_content: r.previous_content,
    new_content: r.new_content,
    edited_at: r.created_at,
    edited_by: r.editor ? { id: r.editor.id, username: r.editor.username } : null,
  }));
}

/**
 * État d'édition pour l'auteur : peut-il modifier, et jusqu'à quand.
 * Alimente le bouton « Modifier » sans le faire tenter pour rien.
 */
async function editabilityFor(tweet, user) {
  const revisions = await TweetEdit.count({ where: { tweet_id: tweet.id } });
  const remaining = remainingWindowMs(tweet);
  const subscribed = isSubscriptionActive(user);
  const maxRevisions = maxRevisionsFor(user);

  let reason = null;
  if (!subscribed) reason = 'subscription_required';
  else if (remaining <= 0) reason = 'window_closed';
  else if (revisions >= maxRevisions) reason = 'max_revisions';

  return {
    can_edit: reason === null,
    reason,
    remaining_ms: remaining,
    revisions_used: revisions,
    max_revisions: maxRevisions,
    window_ms: TWEET_EDIT_WINDOW_MS,
  };
}

/**
 * Applique une modification de contenu.
 *
 * L'ancienne version est écrite AVANT la nouvelle, dans la même transaction :
 * si l'écriture de l'historique échoue, la modification n'a pas lieu. Un
 * tweet modifié sans trace serait pire que pas d'édition du tout.
 */
async function applyEdit({ tweetId, editorId, newContent, asStaff = false }) {
  return sequelize.transaction(async (t) => {
    const tweet = await Tweet.findByPk(tweetId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!tweet) throw new TweetEditError('Tweet non trouvé', 'not_found');

    if (!asStaff && String(tweet.user_id) !== String(editorId)) {
      throw new TweetEditError('Ce tweet n\'est pas le tien', 'forbidden');
    }

    const previous = String(tweet.content || '');
    const next = String(newContent || '');
    if (!next.trim()) throw new TweetEditError('Le contenu ne peut pas être vide', 'empty');
    if (previous === next) {
      // Rien à écrire : une révision identique polluerait l'historique et
      // consommerait une des révisions pour rien.
      return { tweet, revision: null, unchanged: true };
    }

    if (!asStaff) {
      const author = await User.findByPk(editorId, {
        attributes: ['id', 'subscription_tier', 'subscription_expires_at', 'premium'],
        transaction: t,
      });
      if (!isSubscriptionActive(author)) {
        throw new TweetEditError(
          'La modification d\'un tweet publié est réservée aux abonnés.',
          'subscription_required',
        );
      }
      if (remainingWindowMs(tweet) <= 0) {
        throw new TweetEditError(
          'La fenêtre de modification de 30 minutes est passée.',
          'window_closed',
        );
      }
      const maxRevisions = maxRevisionsFor(author);
      const used = await TweetEdit.count({ where: { tweet_id: tweet.id }, transaction: t });
      if (used >= maxRevisions) {
        throw new TweetEditError(
          `Ce tweet a déjà été modifié ${maxRevisions} fois.`,
          'max_revisions',
        );
      }
    }

    const lastRevision = await TweetEdit.max('revision', {
      where: { tweet_id: tweet.id },
      transaction: t,
    });
    const revision = (Number.isFinite(lastRevision) ? lastRevision : 0) + 1;

    await TweetEdit.create({
      tweet_id: tweet.id,
      edited_by: editorId,
      revision,
      previous_content: previous,
      new_content: next,
    }, { transaction: t });

    await tweet.update({ content: next }, { transaction: t });

    return { tweet, revision, unchanged: false };
  });
}

module.exports = {
  TweetEditError,
  applyEdit,
  summaryFor,
  historyFor,
  editabilityFor,
  remainingWindowMs,
  TWEET_EDIT_WINDOW_MS,
  TWEET_EDIT_MAX_REVISIONS,
  TWEET_EDIT_MAX_REVISIONS_ULTRA,
  maxRevisionsFor,
};
