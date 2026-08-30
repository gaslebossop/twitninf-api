const { QueryTypes, literal } = require('sequelize');
const logger = require('../utils/logger');
const webPushService = require('./webPushService');
const featureFlagService = require('./featureFlagService');
const { getRecommendations } = require('./rustRecommenderClient');

/**
 * Relance quotidienne adaptative — décision, contenu, envoi.
 *
 * Remplace les trois rappels LOCAUX à heures fixes (12 h / 16 h / 20 h) que
 * l'app posait elle-même. Trois différences de fond :
 *
 *  1. L'heure est APPRISE par personne (`activityProfileService`), pas
 *     décidée une fois pour toutes.
 *  2. Elle ne part que vers quelqu'un qui n'est PAS déjà revenu. Relancer un
 *     utilisateur actif ne gagne aucune ouverture et coûte une désinstallation.
 *  3. Le message porte un vrai contenu choisi pour lui. S'il n'y en a pas,
 *     on n'envoie rien — un rappel générique est ce qu'on cherche à
 *     supprimer, pas à replanifier.
 *
 * ── Concurrence ────────────────────────────────────────────────────────
 * Aucun verrou n'est posé ici, et c'est délibéré : `setupCronJobs()` n'est
 * appelé que derrière `NODE_ROLE=worker`, donc un seul process au monde
 * exécute cette fonction. Ajouter un verrou Redis donnerait l'illusion que
 * l'invariant est local à ce fichier, alors qu'il tient au découpage des
 * rôles côté serveur.
 */

const PARIS_TIMEZONE = 'Europe/Paris';
const FLAG_KEY = 'notif.relance';

/** Deux relances par jour au maximum. */
const MAX_NUDGES_PER_DAY = 2;

/**
 * Silence exigé avant de relancer. Quelqu'un vu il y a moins de six heures
 * n'a pas besoin qu'on lui rappelle l'application : il vient d'y être.
 */
const INACTIVITY_HOURS = 6;

/**
 * Délai laissé à une relance pour produire une ouverture. Au-delà, une
 * visite n'est plus attribuable à la notification.
 */
const OPEN_WINDOW_HOURS = 2;

/** Relances ignorées d'affilée avant la mise en pause. */
const FATIGUE_THRESHOLD = 3;

/** Durée de la pause de fatigue. */
const FATIGUE_PAUSE_DAYS = 7;

/**
 * Tolérance autour du créneau. Le planificateur passe au quart d'heure ; une
 * fenêtre d'une heure pleine absorbe un redémarrage du worker sans faire
 * sauter la relance du jour, tout en gardant la notification dans l'heure
 * apprise.
 */
const SLOT_WINDOW_MINUTES = 59;

/** Longueur de l'extrait de tweet mis dans le corps de la notification. */
const EXCERPT_LENGTH = 120;

/** Même exclusion que l'apprentissage : ces événements ne prouvent aucune présence. */
const BACKGROUND_ACTIONS = ['system_stats_sync', 'device_motion_noise'];

/** Heure et jour courants dans le fuseau des utilisateurs, pas celui du process. */
function parisNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: PARIS_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const day = `${get('year')}-${get('month')}-${get('day')}`;

  // `getUTCDay` sur une date reconstruite serait faux au changement d'heure ;
  // on lit le jour tel que le fuseau cible le nomme.
  const weekday = get('weekday').toLowerCase();
  const isWeekend = weekday.startsWith('sam') || weekday.startsWith('dim');

  return { hour, minute, day, isWeekend };
}

/**
 * Le créneau est-il atteint ?
 *
 * On n'exige pas l'heure pile : le planificateur ne passe que quatre fois par
 * heure, et un tour manqué ne doit pas annuler la journée.
 */
function slotIsDue(slots, { hour, minute, isWeekend }) {
  const list = (isWeekend ? slots?.weekend : slots?.weekday) || [];
  return list.some((slotHour) => slotHour === hour && minute <= SLOT_WINDOW_MINUTES);
}

/** Coupe proprement, sur un mot, et n'ajoute l'ellipse que si on a coupé. */
function excerpt(content, max = EXCERPT_LENGTH) {
  const clean = String(content || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Les candidats du tour courant.
 *
 * Tout est filtré en SQL et non en JavaScript : la sélection tourne toutes
 * les quinze minutes, et ramener toute la table pour la filtrer en mémoire
 * ne tiendrait pas si la base d'abonnés grandit.
 *
 * `last_seen` vient de `user_behavior_data` et non d'une colonne sur `users` :
 * il n'existe aucune colonne de dernière activité sur le compte, et
 * l'inventer ici obligerait à l'écrire à chaque requête de l'app.
 */
async function selectCandidates(now = new Date()) {
  const { sequelize } = require('../models');
  const { day } = parisNow(now);

  return sequelize.query(
    `SELECT s.user_id,
            s.slots,
            s.slots_source,
            s.consecutive_ignored,
            s.last_tweet_id,
            s.nudges_today,
            s.nudges_day
       FROM user_nudge_state s
      WHERE (s.paused_until IS NULL OR s.paused_until <= (:now)::timestamptz)
        AND (s.nudges_day IS DISTINCT FROM :day OR s.nudges_today < :maxPerDay)
        AND (s.last_nudge_at IS NULL OR s.last_nudge_at <= (:now)::timestamptz - ((:inactivity)::int * INTERVAL '1 hour'))
        AND EXISTS (SELECT 1 FROM web_push_subscriptions w WHERE w.user_id = s.user_id)
        AND NOT EXISTS (
              SELECT 1 FROM user_behavior_data b
               WHERE b.user_id = s.user_id
                 AND b.timestamp > (:now)::timestamptz - ((:inactivity)::int * INTERVAL '1 hour')
                 AND b.action_type NOT IN (:excluded)
            )`,
    {
      replacements: {
        now,
        day,
        maxPerDay: MAX_NUDGES_PER_DAY,
        inactivity: INACTIVITY_HOURS,
        excluded: BACKGROUND_ACTIONS,
      },
      type: QueryTypes.SELECT,
    }
  );
}

/**
 * Choisit le tweet à mettre en avant, ou `null`.
 *
 * `excludeSeen` fait écarter par le moteur Rust ce que la personne a déjà vu
 * (set `twitninf:seen:<user>`) : sans lui, la relance proposerait le haut de
 * son fil, c'est-à-dire ce qu'elle a justement déjà lu avant de partir.
 */
async function pickTweet(userId, avoidTweetId) {
  let tweetIds = [];
  try {
    const result = await getRecommendations(userId, {
      mode: 'for_you',
      limit: 5,
      excludeSeen: true,
    });
    tweetIds = Array.isArray(result?.tweetIds) ? result.tweetIds : [];
  } catch (error) {
    logger.warn(`[relance] recommandeur indisponible pour ${userId}: ${error.message}`);
    return null;
  }

  const candidates = tweetIds.filter((id) => String(id) !== String(avoidTweetId));
  if (!candidates.length) return null;

  const { Tweet, User } = require('../models');
  const tweet = await Tweet.findOne({
    where: { id: candidates },
    attributes: ['id', 'content', 'user_id', 'created_at'],
    include: [{ model: User, as: 'author', attributes: ['id', 'username', 'full_name'] }],
  });

  if (!tweet) return null;

  const body = excerpt(tweet.content);
  // Un tweet sans texte (média seul) ne donne aucune accroche lisible dans
  // une notification : mieux vaut ne rien envoyer que « … ».
  if (!body) return null;

  const author = tweet.author?.full_name || tweet.author?.username;
  if (!author) return null;

  return { id: tweet.id, author, body };
}

/**
 * Constate les ouvertures des relances précédentes et applique la fatigue.
 *
 * Tourne AVANT la sélection : une personne qui vient d'ouvrir doit voir son
 * compteur d'ignorés remis à zéro avant qu'on décide de la mettre en pause.
 */
async function settleOpens(now = new Date()) {
  const { sequelize } = require('../models');

  const [, meta] = await sequelize.query(
    `WITH verdicts AS (
       SELECT s.user_id,
              EXISTS (
                SELECT 1 FROM user_behavior_data b
                 WHERE b.user_id = s.user_id
                   AND b.timestamp > s.last_nudge_at
                   AND b.timestamp <= s.last_nudge_at + ((:window)::int * INTERVAL '1 hour')
                   AND b.action_type NOT IN (:excluded)
              ) AS opened
         FROM user_nudge_state s
        WHERE s.last_nudge_at IS NOT NULL
          AND s.last_nudge_at <= (:now)::timestamptz - ((:window)::int * INTERVAL '1 hour')
          AND s.last_tweet_id IS NOT NULL
     )
     UPDATE user_nudge_state s
        SET consecutive_ignored = CASE WHEN v.opened THEN 0 ELSE s.consecutive_ignored + 1 END,
            total_opened        = s.total_opened + CASE WHEN v.opened THEN 1 ELSE 0 END,
            paused_until        = CASE
                                    WHEN NOT v.opened AND s.consecutive_ignored + 1 >= :threshold
                                    THEN (:now)::timestamptz + ((:pause)::int * INTERVAL '1 day')
                                    ELSE s.paused_until
                                  END,
            -- Le verdict est rendu : on efface le tweet pour ne pas le
            -- rejuger au tour suivant, ce qui incrémenterait le compteur
            -- d'ignorés à chaque passage du cron.
            last_tweet_id       = NULL,
            updated_at          = (:now)::timestamptz
       FROM verdicts v
      WHERE v.user_id = s.user_id`,
    {
      replacements: {
        now,
        window: OPEN_WINDOW_HOURS,
        threshold: FATIGUE_THRESHOLD,
        pause: FATIGUE_PAUSE_DAYS,
        excluded: BACKGROUND_ACTIONS,
      },
    }
  );

  return meta?.rowCount || 0;
}

/** Envoie la relance d'une personne, et enregistre ce qui vient d'être fait. */
async function nudgeOne(candidate, now, day) {
  const { UserNudgeState } = require('../models');
  const userId = candidate.user_id;

  const tweet = await pickTweet(userId, candidate.last_tweet_id);
  if (!tweet) return false;

  const result = await webPushService.sendToUser(userId, {
    title: tweet.author,
    body: tweet.body,
    url: `/tweet/${tweet.id}`,
    tag: `relance-${tweet.id}`,
  });

  // Zéro envoi veut dire que tous les abonnements ont été purgés entre la
  // sélection et maintenant. Ne rien inscrire : sinon on brûlerait le quota
  // du jour pour une notification que personne n'a reçue.
  if (!result || result.sent === 0) return false;

  const sameDay = candidate.nudges_day === day;
  await UserNudgeState.update(
    {
      last_nudge_at: now,
      last_tweet_id: tweet.id,
      nudges_day: day,
      nudges_today: sameDay ? (candidate.nudges_today || 0) + 1 : 1,
      total_sent: literal('total_sent + 1'),
    },
    { where: { user_id: userId } }
  );

  return true;
}

/**
 * Un tour de planificateur. Appelé au quart d'heure.
 *
 * Le drapeau est évalué PAR UTILISATEUR et non une fois pour la fonction :
 * c'est ce qui permet d'ouvrir la fonctionnalité aux membres beta seuls,
 * puis d'élargir sans toucher au code.
 */
async function runScheduler(now = new Date()) {
  const clock = parisNow(now);

  await settleOpens(now);

  const candidates = await selectCandidates(now);
  const due = candidates.filter((candidate) => slotIsDue(candidate.slots, clock));
  if (!due.length) return { considered: candidates.length, due: 0, sent: 0 };

  let sent = 0;
  for (const candidate of due) {
    try {
      const allowed = await featureFlagService.isEnabled(FLAG_KEY, { user_id: String(candidate.user_id) });
      if (!allowed) continue;
      if (await nudgeOne(candidate, now, clock.day)) sent += 1;
    } catch (error) {
      logger.warn(`[relance] échec pour ${candidate.user_id}: ${error.message}`);
    }
  }

  if (sent > 0) {
    logger.info(`[relance] ${sent} relance(s) envoyée(s) sur ${due.length} candidat(s) à ${clock.hour}h`);
  }

  return { considered: candidates.length, due: due.length, sent };
}

module.exports = {
  runScheduler,
  settleOpens,
  selectCandidates,
  // Exportées pour les tests : la logique de décision doit être vérifiable
  // sans base ni recommandeur.
  slotIsDue,
  excerpt,
  parisNow,
  FLAG_KEY,
  MAX_NUDGES_PER_DAY,
  INACTIVITY_HOURS,
  FATIGUE_THRESHOLD,
  FATIGUE_PAUSE_DAYS,
};
