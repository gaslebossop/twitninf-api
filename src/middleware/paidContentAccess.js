const { Tweet } = require('../models');
const paidContentService = require('../services/paidContentService');
const logger = require('../utils/logger');

/**
 * Interdit d'interagir avec un contenu payant qu'on n'a pas acheté.
 *
 * Le masquage à la lecture ne suffisait pas : on pouvait liker, retweeter,
 * répondre et mettre en favori un texte qu'on n'avait jamais lu. Un retweet
 * en particulier REPUBLIE le contenu — et la route de traduction en rendait
 * purement et simplement le texte, sans même demander d'être connecté.
 *
 * Le contrôle porte sur le tweet visé ET sur son original : un retweet pur
 * n'a pas de texte propre, l'interaction vise l'original, et c'est l'original
 * qui est vendu.
 *
 * L'auteur et les acheteurs passent (`hasAccess`). En cas d'erreur, on refuse :
 * pour une écriture, l'échec ouvert est le mauvais côté.
 */

const LOCKED_MESSAGE = 'Débloque ce contenu pour interagir avec lui.';

async function assertAccessible(tweetIds, viewerId) {
  const ids = [...new Set(tweetIds.filter(Boolean).map(String))];
  if (!ids.length) return true;

  const map = await paidContentService.accessMapFor({
    viewerId: viewerId || null,
    contentType: 'tweet',
    contentIds: ids,
  });
  if (!map.size) return true;

  for (const id of ids) {
    const entry = map.get(String(id));
    if (entry && !entry.hasAccess) return false;
  }
  return true;
}

/**
 * @param {object}  options
 * @param {string}  [options.param]     nom du paramètre d'URL portant l'id du tweet
 * @param {string}  [options.bodyField] champ du corps portant l'id (réponses)
 */
function requireContentAccess({ param = 'id', bodyField = null } = {}) {
  return async (req, res, next) => {
    try {
      const requestedId = (param && req.params?.[param])
        || (bodyField && req.body?.[bodyField])
        || null;
      // Pas de cible : rien à protéger ici (un tweet racine, par exemple).
      if (!requestedId) return next();

      const tweet = await Tweet.findByPk(requestedId, {
        attributes: ['id', 'original_tweet_id'],
      });
      // Tweet inexistant : on laisse la route répondre « introuvable »
      // elle-même, son message est plus juste que le nôtre.
      if (!tweet) return next();

      const accessible = await assertAccessible(
        [tweet.id, tweet.original_tweet_id],
        req.user?.id,
      );
      if (accessible) return next();

      return res.status(403).json({
        success: false,
        message: LOCKED_MESSAGE,
        code: 'PAID_CONTENT_LOCKED',
      });
    } catch (error) {
      logger.error('[paidContentAccess] Contrôle d\'accès en échec:', error);
      return res.status(500).json({
        success: false,
        message: 'Erreur interne du serveur',
      });
    }
  };
}

module.exports = { requireContentAccess, assertAccessible, LOCKED_MESSAGE };
