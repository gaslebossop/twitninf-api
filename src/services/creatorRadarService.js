const { Tweet, TweetVelocityAlert, Notification } = require('../models');
const { sequelize } = require('../database/index');
const {
  VELOCITY_ALERT_MULTIPLIER,
  VELOCITY_ALERT_MIN_ENGAGEMENTS,
  VELOCITY_ALERT_MAX_TWEET_AGE_MS,
} = require('../constants/premiumMarket');
const logger = require('../utils/logger');

/**
 * Deux avantages abonné qui partagent le même matériau — la vitesse.
 *
 * - **Radar des comptes qui montent** : qui gagne des abonnés vite, dans ton
 *   univers, avant que tout le monde le sache.
 * - **Alerte de tweet qui décolle** : ton tweet sort de ta propre courbe, on
 *   te prévient pendant que ça compte encore.
 *
 * Dans les deux cas la mesure est RELATIVE. Un compte qui gagne 40 abonnés
 * quand il en a 100 monte ; le même gain sur un compte de 50 000 ne veut rien
 * dire. Un classement en valeur absolue ne ferait que ressortir les plus gros
 * comptes, qui n'ont besoin de personne pour être trouvés.
 */

let velocityTimer = null;
const VELOCITY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Comptes en croissance, pondérés par l'affinité avec l'utilisateur.
 *
 * L'affinité est le nombre d'abonnements en commun : c'est le signal le plus
 * lisible dont on dispose sans passer par le moteur de similarité, et il
 * suffit à éviter un radar qui recommanderait la même poignée de comptes à
 * tout le monde.
 *
 * Les comptes déjà suivis sont exclus — recommander quelqu'un qu'on suit
 * déjà est le meilleur moyen de faire passer le radar pour inutile.
 */
async function risingAccounts(userId, { days = 7, limit = 20 } = {}) {
  const window = Math.min(Math.max(parseInt(days, 10) || 7, 1), 30);
  const max = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

  const rows = await sequelize.query(`
    WITH recent AS (
      SELECT following_id, COUNT(*)::int AS new_followers
      FROM user_follows
      WHERE status = 'active'
        AND created_at >= NOW() - (:window || ' days')::interval
      GROUP BY following_id
      HAVING COUNT(*) >= 3
    ),
    totals AS (
      SELECT following_id, COUNT(*)::int AS total_followers
      FROM user_follows
      WHERE status = 'active'
      GROUP BY following_id
    ),
    mine AS (
      SELECT following_id FROM user_follows
      WHERE follower_id = :userId AND status = 'active'
    ),
    affinity AS (
      -- Abonnements en commun : combien de comptes que JE suis suivent aussi
      -- ce compte. Deux jointures sur user_follows, jamais un COUNT(*) sur
      -- une jointure large — ça gonflerait le score des gros comptes.
      SELECT f2.following_id, COUNT(DISTINCT f1.following_id)::int AS common
      FROM mine f1
      JOIN user_follows f3 ON f3.follower_id = f1.following_id AND f3.status = 'active'
      JOIN user_follows f2 ON f2.following_id = f3.following_id AND f2.status = 'active'
      GROUP BY f2.following_id
    )
    SELECT
      u.id, u.username, u.full_name, u.avatar, u.verified, u.verification_style,
      u.premium, u.subscription_tier, u.bio,
      r.new_followers,
      COALESCE(t.total_followers, 0) AS total_followers,
      COALESCE(a.common, 0) AS common_follows,
      -- Croissance relative : le gain récent rapporté à la taille du compte,
      -- plafonné pour qu'un compte neuf à 3 abonnés ne rafle pas la tête.
      (r.new_followers::numeric / GREATEST(COALESCE(t.total_followers, 0), 10)) AS growth_rate
    FROM recent r
    JOIN users u ON u.id = r.following_id
    LEFT JOIN totals t ON t.following_id = r.following_id
    LEFT JOIN affinity a ON a.following_id = r.following_id
    WHERE u.is_active = true
      AND u.is_suspended = false
      AND u.id <> :userId
      AND u.id NOT IN (SELECT following_id FROM mine)
    ORDER BY (r.new_followers::numeric / GREATEST(COALESCE(t.total_followers, 0), 10))
             * (1 + LEAST(COALESCE(a.common, 0), 20) * 0.15) DESC
    LIMIT :limit
  `, {
    replacements: { userId: String(userId), window: String(window), limit: max },
    type: sequelize.QueryTypes.SELECT,
  });

  return rows.map((r) => ({
    user: {
      id: r.id,
      username: r.username,
      full_name: r.full_name,
      avatar: r.avatar,
      bio: r.bio,
      verified: r.verified,
      verification_style: r.verification_style,
      premium: r.premium,
      subscription_tier: r.subscription_tier,
    },
    new_followers: r.new_followers,
    total_followers: r.total_followers,
    common_follows: r.common_follows,
    growth_rate: Math.round(Number(r.growth_rate) * 1000) / 1000,
    window_days: window,
  }));
}

/**
 * Rythme habituel d'un auteur : engagements médians par heure d'âge, mesurés
 * sur ses 30 derniers tweets originaux.
 *
 * Médiane et non moyenne : un seul tweet viral dans l'historique tirerait la
 * moyenne assez haut pour que plus rien ne déclenche jamais — exactement
 * l'auteur pour qui l'alerte compte le plus.
 */
async function baselineFor(userId) {
  const rows = await sequelize.query(`
    SELECT
      t.id,
      EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 AS age_hours,
      (COUNT(DISTINCT l.id) + COUNT(DISTINCT rt.id) + COUNT(DISTINCT rp.id))::int AS engagements
    FROM tweets t
    LEFT JOIN tweet_likes l ON l.tweet_id = t.id
    LEFT JOIN tweet_retweets rt ON rt.tweet_id = t.id
    LEFT JOIN tweets rp ON rp.parent_tweet_id = t.id AND rp.deleted_at IS NULL
    WHERE t.user_id = :userId
      AND t.deleted_at IS NULL
      AND t.parent_tweet_id IS NULL
      AND t.created_at < NOW() - INTERVAL '48 hours'
    GROUP BY t.id, t.created_at
    ORDER BY t.created_at DESC
    LIMIT 30
  `, {
    replacements: { userId: String(userId) },
    type: sequelize.QueryTypes.SELECT,
  });

  // Moins de cinq tweets de référence : pas de base fiable, donc pas
  // d'alerte. Prévenir un compte neuf que « son tweet décolle » à trois likes
  // décrédibiliserait la fonctionnalité en une notification.
  if (rows.length < 5) return null;

  const perHour = rows
    .map((r) => Number(r.engagements) / Math.max(Number(r.age_hours), 1))
    .sort((a, b) => a - b);
  const mid = Math.floor(perHour.length / 2);
  const median = perHour.length % 2
    ? perHour[mid]
    : (perHour[mid - 1] + perHour[mid]) / 2;

  return median;
}

/**
 * Cherche les tweets récents qui dépassent le rythme habituel de leur auteur
 * et prévient une seule fois par tweet (contrainte d'unicité en base).
 */
async function scanVelocity({ limit = 300 } = {}) {
  const since = new Date(Date.now() - VELOCITY_ALERT_MAX_TWEET_AGE_MS);

  const candidates = await sequelize.query(`
    SELECT
      t.id, t.user_id, t.created_at,
      EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 AS age_hours,
      (COUNT(DISTINCT l.id) + COUNT(DISTINCT rt.id) + COUNT(DISTINCT rp.id))::int AS engagements
    FROM tweets t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN tweet_likes l ON l.tweet_id = t.id
    LEFT JOIN tweet_retweets rt ON rt.tweet_id = t.id
    LEFT JOIN tweets rp ON rp.parent_tweet_id = t.id AND rp.deleted_at IS NULL
    WHERE t.created_at >= :since
      AND t.deleted_at IS NULL
      AND t.parent_tweet_id IS NULL
      AND t.moderation_status = 'approved'
      AND u.subscription_tier <> 'free'
      AND u.premium = true
      AND (u.subscription_expires_at IS NULL OR u.subscription_expires_at > NOW())
      AND NOT EXISTS (SELECT 1 FROM tweet_velocity_alerts a WHERE a.tweet_id = t.id)
    GROUP BY t.id, t.user_id, t.created_at
    HAVING (COUNT(DISTINCT l.id) + COUNT(DISTINCT rt.id) + COUNT(DISTINCT rp.id)) >= :minEngagements
    ORDER BY t.created_at DESC
    LIMIT :limit
  `, {
    replacements: {
      since,
      minEngagements: VELOCITY_ALERT_MIN_ENGAGEMENTS,
      limit,
    },
    type: sequelize.QueryTypes.SELECT,
  });

  // Une seule base par auteur, même s'il a plusieurs tweets en lice.
  const baselines = new Map();
  let alerted = 0;

  for (const row of candidates) {
    try {
      const key = String(row.user_id);
      if (!baselines.has(key)) baselines.set(key, await baselineFor(row.user_id));
      const baseline = baselines.get(key);
      if (baseline === null || baseline <= 0) continue;

      const ageHours = Math.max(Number(row.age_hours), 0.25);
      const rate = Number(row.engagements) / ageHours;
      const ratio = rate / baseline;
      if (ratio < VELOCITY_ALERT_MULTIPLIER) continue;

      await TweetVelocityAlert.create({
        tweet_id: row.id,
        user_id: row.user_id,
        engagements: Number(row.engagements),
        baseline,
        ratio,
        tweet_age_minutes: Math.round(ageHours * 60),
      });
      alerted += 1;

      await Notification.createNotification({
        recipient_id: row.user_id,
        tweet_id: row.id,
        type: 'system',
        title: 'Ton tweet décolle',
        message: `Il va ${Math.round(ratio)}× plus vite que d'habitude (${row.engagements} interactions).`,
        priority: 'high',
        content: {
          kind: 'tweet_velocity',
          tweet_id: row.id,
          ratio: Math.round(ratio * 10) / 10,
          engagements: Number(row.engagements),
        },
      });
    } catch (e) {
      // La contrainte d'unicité peut sauter si deux passages se croisent :
      // ce n'est pas une erreur, c'est le verrou qui fait son travail.
      if (!String(e.message || '').includes('unique')) {
        logger.warn(`[radar] Alerte de vitesse ${row.id} en échec: ${e.message}`);
      }
    }
  }

  if (alerted) logger.info(`[radar] ${alerted} tweet(s) en décollage signalé(s)`);
  return alerted;
}

/** Historique des alertes de décollage d'un compte. */
async function velocityHistory(userId, { limit = 30 } = {}) {
  const rows = await TweetVelocityAlert.findAll({
    where: { user_id: userId },
    include: [{ model: Tweet, as: 'tweet', attributes: ['id', 'content', 'created_at'] }],
    order: [['created_at', 'DESC']],
    limit: Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100),
  });

  return rows.map((r) => ({
    id: r.id,
    tweet_id: r.tweet_id,
    tweet: r.tweet ? { id: r.tweet.id, content: r.tweet.content, created_at: r.tweet.created_at } : null,
    engagements: r.engagements,
    ratio: Number(r.ratio),
    detected_at: r.created_at,
    tweet_age_minutes: r.tweet_age_minutes,
  }));
}

function startVelocityWorker() {
  if (velocityTimer) return;
  velocityTimer = setInterval(() => {
    scanVelocity().catch((e) => logger.error('[radar] Passage de vitesse en échec:', e));
  }, VELOCITY_INTERVAL_MS);
  if (typeof velocityTimer.unref === 'function') velocityTimer.unref();
  logger.info('[radar] Détection de décollage démarrée');
}

function stopVelocityWorker() {
  if (velocityTimer) clearInterval(velocityTimer);
  velocityTimer = null;
}

module.exports = {
  risingAccounts,
  baselineFor,
  scanVelocity,
  velocityHistory,
  startVelocityWorker,
  stopVelocityWorker,
};
