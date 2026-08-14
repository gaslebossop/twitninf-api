/**
 * Spotlight : le tweet ayant reçu le plus de likes hier (jour calendaire
 * Europe/Paris), calculé une fois par nuit plutôt qu'agrégé à chaque requête
 * du fil. Voir `DailySpotlight` pour le schéma et `spotlightRoutes` pour la
 * lecture côté client.
 */

const { Op, fn, col, literal } = require('sequelize');
const logger = require('../utils/logger');
const { instantForZonedHour, zonedDayKey } = require('../utils/timezone');

const SPOTLIGHT_TIME_ZONE = 'Europe/Paris';

// Nombre minimal de likes reçus hier pour qu'un tweet devienne le Spotlight.
// Constante nommée pour rester un changement d'une ligne si le seuil doit
// monter (éviter un gagnant anecdotique à 1 like sur une nuit très calme).
const MIN_SPOTLIGHT_LIKES = 1;

/**
 * Calcule (si besoin) et enregistre le Spotlight du jour calendaire d'hier.
 * Idempotent : si la ligne du jour existe déjà avec un statut définitif
 * (`computed` ou `no_winner`), ne refait rien — le cron peut être relancé
 * après un redémarrage sans dupliquer le travail.
 */
async function computeYesterdaySpotlight() {
  const { DailySpotlight, Tweet, TweetLike } = require('../models');

  const now = new Date();
  const todayStart = instantForZonedHour(now, 0, SPOTLIGHT_TIME_ZONE, 0);
  const yesterdayStart = instantForZonedHour(now, 0, SPOTLIGHT_TIME_ZONE, -1);
  const spotlightDate = zonedDayKey(yesterdayStart, SPOTLIGHT_TIME_ZONE);

  const existing = await DailySpotlight.getForDate(spotlightDate);
  if (existing && ['computed', 'no_winner'].includes(existing.status)) {
    logger.info(`[Spotlight] ${spotlightDate} déjà calculé (${existing.status}), rien à faire`);
    return existing;
  }

  const winner = await TweetLike.findOne({
    where: {
      created_at: { [Op.gte]: yesterdayStart, [Op.lt]: todayStart }
    },
    include: [{
      model: Tweet,
      as: 'tweet',
      attributes: [],
      where: {
        is_private: false,
        moderation_status: { [Op.notIn]: ['not_eligible', 'rejected'] }
      },
      required: true
    }],
    attributes: ['tweet_id', [fn('COUNT', col('TweetLike.id')), 'like_count']],
    group: ['tweet_id'],
    order: [[literal('like_count'), 'DESC']],
    raw: true
  });

  const likeCount = winner ? Number(winner.like_count) || 0 : 0;
  const payload = winner && likeCount >= MIN_SPOTLIGHT_LIKES
    ? { tweet_id: winner.tweet_id, like_count: likeCount, status: 'computed', computed_at: new Date() }
    : { tweet_id: null, like_count: 0, status: 'no_winner', computed_at: new Date() };

  const [row] = await DailySpotlight.upsert({ spotlight_date: spotlightDate, ...payload });

  logger.info(`[Spotlight] ${spotlightDate}: ${payload.status}` + (payload.tweet_id ? ` (tweet ${payload.tweet_id}, ${likeCount} likes)` : ''));

  return row;
}

module.exports = {
  SPOTLIGHT_TIME_ZONE,
  MIN_SPOTLIGHT_LIKES,
  computeYesterdaySpotlight
};
