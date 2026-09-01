const { Op } = require('sequelize');
const { ScheduledTweet, Tweet, User, Notification } = require('../models');
const { sequelize } = require('../database/index');
const { processPendingTweet } = require('./geminiService');
const { resolveTweetCharLimit } = require('../utils/tweetLimits');
const {
  SCHEDULE_MAX_HORIZON_DAYS,
  SCHEDULE_MAX_HORIZON_DAYS_ULTRA,
  SCHEDULE_MAX_PENDING,
  SCHEDULE_MAX_PENDING_ULTRA,
  SCHEDULE_MIN_LEAD_MS,
} = require('../constants/premiumMarket');
const {
  DEFAULT_TIME_ZONE,
  hourInZoneSql,
  instantForZonedHour,
  isValidTimeZone,
} = require('../utils/timezone');
const logger = require('../utils/logger');
const { isUltraRequest } = require('../utils/ultraGate');

/**
 * Publications programmées — avantage abonné.
 *
 * L'app savait déjà dire à un créateur QUAND publier (`/user-stats/best-time`)
 * mais le laissait se lever à 7 h pour le faire. C'est ce chaînon qui manque
 * ici : le meilleur créneau devient une action, pas une notification.
 *
 * Le worker est volontairement simple — un passage toutes les 30 secondes,
 * une ligne verrouillée à la fois. Une file de publication n'a aucun besoin
 * d'être à la seconde près, et un ordonnanceur distribué serait une pièce de
 * plus à surveiller pour gagner un délai que personne ne remarquera.
 */

/** Une seule instance de worker par processus. */
let workerTimer = null;
const WORKER_INTERVAL_MS = 30 * 1000;
/** Au-delà, la ligne part en `failed` et l'auteur est prévenu. */
const MAX_ATTEMPTS = 3;
/** Un verrou plus vieux que ça vient d'un processus mort : on le reprend. */
const STALE_LOCK_MS = 5 * 60 * 1000;

class ScheduleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

/**
 * Meilleures heures de publication du compte, sur 90 jours.
 *
 * Même mesure que `/api/user-stats/:id/best-time` : l'engagement MOYEN par
 * tweet publié dans le créneau, jamais l'engagement total — sinon on
 * recommanderait l'heure à laquelle l'auteur publie le plus, ce qu'il sait
 * déjà.
 */
async function bestHoursFor(userId, timeZone = DEFAULT_TIME_ZONE) {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const rows = await sequelize.query(`
    SELECT
      ${hourInZoneSql('t.created_at')} AS hour,
      COUNT(DISTINCT t.id) AS tweets,
      COUNT(DISTINCT l.id) AS likes,
      COUNT(DISTINCT rt.id) AS retweets,
      COUNT(DISTINCT rp.id) AS replies
    FROM tweets t
    LEFT JOIN tweet_likes l ON l.tweet_id = t.id
    LEFT JOIN tweet_retweets rt ON rt.tweet_id = t.id
    LEFT JOIN tweets rp ON rp.parent_tweet_id = t.id AND rp.deleted_at IS NULL
    WHERE t.user_id = :userId::uuid
      AND t.created_at >= NOW() - INTERVAL '90 days'
      AND t.deleted_at IS NULL
      AND t.parent_tweet_id IS NULL
    GROUP BY 1
  `, {
    replacements: { userId: String(userId), timeZone: zone },
    type: sequelize.QueryTypes.SELECT,
  });

  const MIN_TWEETS_PER_SLOT = 3;
  return rows
    .map((r) => ({
      hour: parseInt(r.hour, 10),
      tweets: parseInt(r.tweets, 10),
      avg: parseInt(r.tweets, 10) > 0
        ? (parseInt(r.likes, 10) + parseInt(r.retweets, 10) + parseInt(r.replies, 10))
          / parseInt(r.tweets, 10)
        : 0,
    }))
    .filter((h) => h.tweets >= MIN_TWEETS_PER_SLOT && h.avg > 0)
    .sort((a, b) => b.avg - a.avg)
    .map((h) => h.hour);
}

/**
 * Prochaine occurrence d'un des bons créneaux, à partir de `from`.
 *
 * Cherche toujours APRÈS la date demandée. Un créateur qui programme pour
 * « lundi, au meilleur moment » ne veut pas voir partir son tweet dimanche
 * soir sous prétexte que 21 h est son meilleur créneau.
 *
 * Sans historique exploitable, on publie à l'heure demandée : une
 * recommandation tirée de deux tweets serait pire que pas de recommandation.
 */
async function resolveBestTime(userId, from, timeZone = DEFAULT_TIME_ZONE) {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const hours = await bestHoursFor(userId, zone);
  if (!hours.length) return from;

  const start = new Date(from);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const hour of [...hours].sort((a, b) => a - b)) {
      // `setHours` posait l'heure dans le fuseau du PROCESSUS — UTC sur le
      // VPS. Un créneau annoncé « 19 h » à un créateur français partait donc
      // à 21 h chez lui. L'heure se pose maintenant dans SON fuseau.
      const candidate = instantForZonedHour(start, hour, zone, dayOffset);
      if (candidate > start) return candidate;
    }
  }
  return from;
}

/**
 * Bornes de programmation applicables à un compte.
 *
 * Exporté parce que la route les ANNONCE au client (`/schedule/limits`) et que
 * le service les APPLIQUE : deux valeurs résolues séparément finiraient par
 * diverger, et l'app afficherait une file de 200 places qu'un refus serveur
 * démentirait à la 51e.
 */
async function scheduleLimitsFor(userId) {
  const ultra = await isUltraRequest({ id: userId });
  return {
    horizonDays: ultra ? SCHEDULE_MAX_HORIZON_DAYS_ULTRA : SCHEDULE_MAX_HORIZON_DAYS,
    maxPending: ultra ? SCHEDULE_MAX_PENDING_ULTRA : SCHEDULE_MAX_PENDING,
  };
}

/** Programme une publication. Le palier est vérifié par la route. */
async function schedule({
  userId,
  content,
  media = [],
  replyToId = null,
  mode = 'exact',
  scheduledFor,
  timeZone = DEFAULT_TIME_ZONE,
}) {
  const text = String(content || '').trim();
  if (!text) throw new ScheduleError('Le contenu ne peut pas être vide', 'empty');

  const when = new Date(scheduledFor);
  if (Number.isNaN(when.getTime())) {
    throw new ScheduleError('Date de publication invalide', 'bad_date');
  }
  // Une date passée est presque toujours un fuseau horaire mal converti côté
  // client. Publier immédiatement serait le pire des choix : le tweet part
  // avant que l'auteur ait compris, sur un texte qu'il pensait relire.
  if (when.getTime() < Date.now() - 60 * 1000) {
    throw new ScheduleError('Cette date est déjà passée', 'past_date');
  }
  // Les deux bornes suivantes dépendent du palier : un Ultra programme six
  // mois à l'avance et garde 200 tweets en file. Le test est fait ICI, à
  // l'écriture, et jamais d'après ce que le client annonce.
  const { horizonDays, maxPending } = await scheduleLimitsFor(userId);

  const horizon = Date.now() + horizonDays * 86400000;
  if (when.getTime() > horizon) {
    throw new ScheduleError(
      `Tu ne peux pas programmer au-delà de ${horizonDays} jours`,
      'too_far',
    );
  }

  const pending = await ScheduledTweet.count({
    where: { user_id: userId, status: { [Op.in]: ['pending', 'publishing'] } },
  });
  if (pending >= maxPending) {
    throw new ScheduleError(
      `Ta file est pleine (${maxPending} publications en attente)`,
      'queue_full',
    );
  }

  return ScheduledTweet.create({
    user_id: userId,
    content: text,
    media: Array.isArray(media) ? media : [],
    reply_to_id: replyToId || null,
    mode: mode === 'best_time' ? 'best_time' : 'exact',
    scheduled_for: when,
    // Le fuseau est retenu à la programmation : le worker publie sans requête
    // HTTP, il n'a aucun autre moyen de savoir quelle heure « 8 h du matin »
    // désigne pour cet auteur.
    time_zone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE,
  });
}

async function listFor(userId, { status } = {}) {
  const where = { user_id: userId };
  if (status) where.status = status;
  const rows = await ScheduledTweet.findAll({
    where,
    order: [['scheduled_for', 'ASC']],
    limit: 200,
  });
  return rows.map(publicPayload);
}

function publicPayload(row) {
  return {
    id: row.id,
    content: row.content,
    media: row.media || [],
    reply_to_id: row.reply_to_id,
    mode: row.mode,
    scheduled_for: row.scheduled_for,
    resolved_for: row.resolved_for,
    status: row.status,
    published_tweet_id: row.published_tweet_id,
    published_at: row.published_at,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

async function update({ userId, id, content, scheduledFor, mode }) {
  const row = await ScheduledTweet.findByPk(id);
  if (!row) throw new ScheduleError('Publication introuvable', 'not_found');
  if (String(row.user_id) !== String(userId)) {
    throw new ScheduleError('Cette publication n\'est pas la tienne', 'forbidden');
  }
  // `publishing` est exclu : la ligne est entre les mains du worker, la
  // modifier reviendrait à changer un texte pendant qu'il part.
  if (row.status !== 'pending') {
    throw new ScheduleError('Cette publication n\'est plus modifiable', 'locked');
  }

  const patch = {};
  if (typeof content === 'string') {
    const text = content.trim();
    if (!text) throw new ScheduleError('Le contenu ne peut pas être vide', 'empty');
    patch.content = text;
  }
  if (scheduledFor) {
    const when = new Date(scheduledFor);
    if (Number.isNaN(when.getTime())) throw new ScheduleError('Date invalide', 'bad_date');
    if (when.getTime() < Date.now() - 60 * 1000) {
      throw new ScheduleError('Cette date est déjà passée', 'past_date');
    }
    patch.scheduled_for = when;
  }
  if (mode === 'exact' || mode === 'best_time') patch.mode = mode;

  await row.update(patch);
  return publicPayload(row);
}

async function cancel({ userId, id }) {
  const row = await ScheduledTweet.findByPk(id);
  if (!row) throw new ScheduleError('Publication introuvable', 'not_found');
  if (String(row.user_id) !== String(userId)) {
    throw new ScheduleError('Cette publication n\'est pas la tienne', 'forbidden');
  }
  if (row.status !== 'pending') {
    throw new ScheduleError('Cette publication n\'est plus annulable', 'locked');
  }
  await row.update({ status: 'canceled' });
  return publicPayload(row);
}

/**
 * Publie une ligne due.
 *
 * Le tweet est créé exactement comme via `POST /api/tweets` : statut
 * `pending`, puis modération Gemini en tâche de fond. Court-circuiter la
 * modération sur les tweets programmés en ferait la porte d'entrée évidente
 * pour tout ce qui ne passe pas en publication directe.
 */
async function publishRow(row) {
  const author = await User.findByPk(row.user_id, {
    attributes: ['id', 'username', 'is_suspended', 'subscription_tier', 'subscription_expires_at', 'premium', 'verified'],
  });
  if (!author) throw new Error('Auteur introuvable');
  // Un compte suspendu entre la programmation et l'échéance ne publie pas.
  if (author.is_suspended) throw new Error('Compte suspendu');

  // La limite de caractères est celle du palier AU MOMENT DE PUBLIER : un
  // abonnement expiré entre-temps ne doit pas faire passer un tweet de
  // 1 000 caractères écrit du temps de l'abonnement.
  const limit = await resolveTweetCharLimit(author);
  if (row.content.length > limit) {
    throw new Error(`Tweet trop long pour ton palier (${limit} caractères)`);
  }

  let parentId = null;
  let originalId = null;
  let tweetType = 'tweet';
  if (row.reply_to_id) {
    const parent = await Tweet.findByPk(row.reply_to_id);
    if (!parent) throw new Error('Tweet parent supprimé');
    parentId = parent.id;
    originalId = parent.original_tweet_id || parent.id;
    tweetType = 'reply';
  }

  const tweet = await Tweet.create({
    content: row.content,
    user_id: row.user_id,
    parent_tweet_id: parentId,
    original_tweet_id: originalId,
    tweet_type: tweetType,
    media_urls: row.media || [],
    moderation_status: 'pending',
    metadata: {
      source: 'scheduler',
      scheduled_tweet_id: row.id,
      scheduled_for: row.scheduled_for,
      created_at: new Date().toISOString(),
      pending_processing: true,
    },
  });

  try {
    const TweetQueueService = require('./tweetQueueService');
    await new TweetQueueService().addTweetToQueue(tweet.id, row.user_id);
  } catch (e) {
    logger.warn(`[scheduler] File de traitement indisponible pour ${tweet.id}: ${e.message}`);
  }

  // Modération en tâche de fond, comme pour une publication directe : la
  // faire attendre bloquerait le worker plusieurs secondes par tweet.
  setImmediate(async () => {
    try {
      await processPendingTweet(tweet.id, row.content, author.username, Boolean(parentId));
    } catch (e) {
      logger.error(`[scheduler] Modération du tweet programmé ${tweet.id}:`, e);
    }
  });

  return tweet;
}

/** Un passage du worker. Exporté pour pouvoir être déclenché dans un test. */
async function runOnce() {
  const now = new Date();
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);

  const due = await ScheduledTweet.findAll({
    where: {
      status: 'pending',
      scheduled_for: { [Op.lte]: new Date(now.getTime() + SCHEDULE_MIN_LEAD_MS) },
      [Op.or]: [{ locked_at: null }, { locked_at: { [Op.lt]: staleBefore } }],
    },
    order: [['scheduled_for', 'ASC']],
    limit: 20,
  });

  for (const row of due) {
    // Verrou pris en UPDATE conditionnel : deux processus qui liraient la
    // même ligne ne peuvent pas la publier tous les deux.
    const [claimed] = await ScheduledTweet.update(
      { status: 'publishing', locked_at: new Date() },
      { where: { id: row.id, status: 'pending' } },
    );
    if (!claimed) continue;

    try {
      if (row.mode === 'best_time') {
        const target = await resolveBestTime(
          row.user_id,
          new Date(row.scheduled_for),
          row.time_zone || DEFAULT_TIME_ZONE,
        );
        // Le meilleur créneau tombe plus tard : on repose la ligne au lieu de
        // publier maintenant. C'est tout l'objet du mode.
        if (target.getTime() > Date.now() + SCHEDULE_MIN_LEAD_MS) {
          await row.update({
            status: 'pending',
            scheduled_for: target,
            resolved_for: target,
            locked_at: null,
          });
          continue;
        }
        await row.update({ resolved_for: new Date() });
      }

      const tweet = await publishRow(row);
      await row.update({
        status: 'published',
        published_tweet_id: tweet.id,
        published_at: new Date(),
        locked_at: null,
        last_error: null,
      });
      logger.info(`[scheduler] Tweet programmé ${row.id} publié → ${tweet.id}`);
    } catch (error) {
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      await row.update({
        status: failed ? 'failed' : 'pending',
        attempts,
        locked_at: null,
        last_error: String(error.message || error).slice(0, 300),
      });
      logger.error(`[scheduler] Publication ${row.id} en échec (${attempts}/${MAX_ATTEMPTS}):`, error);

      if (failed) {
        // Prévenir est indispensable : sans notification, l'auteur croit
        // avoir publié et ne découvre le contraire que par hasard.
        try {
          await Notification.createNotification({
            recipient_id: row.user_id,
            type: 'system',
            title: 'Publication programmée non partie',
            message: String(error.message || 'Erreur inconnue').slice(0, 200),
            priority: 'high',
            content: { kind: 'scheduled_tweet_failed', scheduled_tweet_id: row.id },
          });
        } catch (e) {
          logger.warn('[scheduler] Notification d\'échec non envoyée:', e.message);
        }
      }
    }
  }

  return due.length;
}

function startWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    runOnce().catch((e) => logger.error('[scheduler] Passage en échec:', e));
  }, WORKER_INTERVAL_MS);
  // Le worker ne doit pas empêcher le processus de se terminer.
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
  logger.info('[scheduler] Worker de publication programmée démarré');
}

function stopWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

module.exports = {
  ScheduleError,
  schedule,
  scheduleLimitsFor,
  listFor,
  update,
  cancel,
  runOnce,
  startWorker,
  stopWorker,
  bestHoursFor,
  resolveBestTime,
  publicPayload,
};
