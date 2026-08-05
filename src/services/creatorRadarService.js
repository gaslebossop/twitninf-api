const { Tweet, TweetVelocityAlert, Notification } = require('../models');
const { sequelize } = require('../database/index');
const { queryRead } = require('../database/readReplica');
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

  const rows = await queryRead(`
    WITH recent AS (
      SELECT f.following_id, COUNT(*)::int AS new_followers
      FROM user_follows f
      JOIN users follower ON follower.id = f.follower_id
      WHERE f.status = 'active'
        AND f.created_at >= NOW() - (:window || ' days')::interval
        AND COALESCE(f.is_data_test, false) = false
        -- Les comptes de charge ont longtemps dominé les petits volumes
        -- réels. Un seul lot synthétique suffisait alors à fabriquer tout
        -- le classement.
        AND COALESCE(follower.is_data_test, false) = false
      GROUP BY f.following_id
      -- Sur le réseau actuel, trois nouveaux abonnés en sept jours ne
      -- laissaient qu'un compte. Le score relatif, plus bas, se charge déjà
      -- de classer le signal : un gain réel suffit pour être candidat.
      HAVING COUNT(*) >= 1
    ),
    totals AS (
      SELECT f.following_id, COUNT(*)::int AS total_followers
      FROM user_follows f
      JOIN users follower ON follower.id = f.follower_id
      WHERE f.status = 'active'
        AND COALESCE(f.is_data_test, false) = false
        AND COALESCE(follower.is_data_test, false) = false
      GROUP BY f.following_id
    ),
    mine AS (
      SELECT following_id FROM user_follows
      WHERE follower_id = :userId
        AND status = 'active'
        AND COALESCE(is_data_test, false) = false
    ),
    affinity AS (
      -- Abonnements en commun : combien de comptes que JE suis suivent aussi
      -- ce compte. Une seule jointure suffit — la version précédente en
      -- rajoutait une troisième sur la même clé, qui ne changeait pas le
      -- résultat (le COUNT DISTINCT la rattrapait) mais multipliait les
      -- lignes intermédiaires par le nombre d'abonnés de chaque compte.
      SELECT f3.following_id, COUNT(DISTINCT f1.following_id)::int AS common
      FROM mine f1
      JOIN user_follows f3 ON f3.follower_id = f1.following_id AND f3.status = 'active'
        AND COALESCE(f3.is_data_test, false) = false
      GROUP BY f3.following_id
    )
    SELECT
      u.id, u.username, u.full_name, u.avatar, u.verified, u.verification_style,
      u.premium, u.subscription_tier, u.bio,
      r.new_followers,
      COALESCE(t.total_followers, 0) AS total_followers,
      COALESCE(a.common, 0) AS common_follows,
      EXISTS (SELECT 1 FROM mine m WHERE m.following_id = u.id) AS is_following,
      -- Croissance relative : le gain récent rapporté à la taille du compte,
      -- plafonné pour qu'un compte neuf à 3 abonnés ne rafle pas la tête.
      (r.new_followers::numeric / GREATEST(COALESCE(t.total_followers, 0), 10)) AS growth_rate
    FROM recent r
    JOIN users u ON u.id = r.following_id
    LEFT JOIN totals t ON t.following_id = r.following_id
    LEFT JOIN affinity a ON a.following_id = r.following_id
    WHERE u.is_active = true
      AND u.is_suspended = false
      AND COALESCE(u.is_data_test, false) = false
      AND u.id <> :userId
      -- Un compte déjà suivi peut justement être celui qui perce. Le
      -- masquer vidait presque toujours le radar sur un petit graphe.
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
    is_following: Boolean(r.is_following),
    growth_rate: Math.round(Number(r.growth_rate) * 1000) / 1000,
    window_days: window,
  }));
}

/**
 * Tweets publics qui accélèrent dans l'univers du compte connecté.
 *
 * L'affinité vient du graphe (abonnement direct, second degré) et des
 * interactions récentes. Quand ce graphe est encore vide, les vrais signaux
 * globaux restent disponibles : un nouveau compte ne doit pas voir un écran
 * vide indéfiniment. La vitesse est comparée à la médiane de la fenêtre,
 * avec un plancher adapté au faible volume actuel.
 */
async function nicheTrendingTweets(userId, { days = 7, limit = 20 } = {}) {
  const window = Math.min(Math.max(parseInt(days, 10) || 7, 1), 30);
  const max = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

  const rows = await queryRead(`
    WITH mine AS (
      SELECT following_id
      FROM user_follows
      WHERE follower_id = :userId
        AND status = 'active'
        AND COALESCE(is_data_test, false) = false
    ),
    network_signals AS (
      SELECT following_id AS author_id, 1.0::numeric AS weight
      FROM mine
      UNION ALL
      SELECT f.following_id, 0.65::numeric
      FROM mine m
      JOIN user_follows f ON f.follower_id = m.following_id AND f.status = 'active'
        AND COALESCE(f.is_data_test, false) = false
      UNION ALL
      SELECT t.user_id, 0.80::numeric
      FROM tweet_likes l
      JOIN tweets t ON t.id = l.tweet_id
      WHERE l.user_id = :userId
        AND COALESCE(l.is_data_test, false) = false
        AND l.created_at >= NOW() - INTERVAL '60 days'
      UNION ALL
      SELECT t.user_id, 0.85::numeric
      FROM tweet_retweets rt
      JOIN tweets t ON t.id = rt.tweet_id
      WHERE rt.user_id = :userId
        AND COALESCE(rt.is_data_test, false) = false
        AND rt.created_at >= NOW() - INTERVAL '60 days'
      UNION ALL
      SELECT parent.user_id, 0.75::numeric
      FROM tweets reply
      JOIN tweets parent ON parent.id = reply.parent_tweet_id
      WHERE reply.user_id = :userId
        AND reply.deleted_at IS NULL
        AND COALESCE(reply.is_data_test, false) = false
        AND reply.created_at >= NOW() - INTERVAL '60 days'
    ),
    affinity AS (
      SELECT author_id, MAX(weight)::numeric AS score
      FROM network_signals
      WHERE author_id <> :userId
      GROUP BY author_id
    ),
    likes AS (
      SELECT l.tweet_id, COUNT(DISTINCT l.id)::int AS count
      FROM tweet_likes l
      JOIN tweets liked ON liked.id = l.tweet_id
      JOIN users actor ON actor.id = l.user_id
      WHERE COALESCE(actor.is_data_test, false) = false
        AND COALESCE(l.is_data_test, false) = false
        AND liked.created_at >= NOW() - (:window || ' days')::interval
      GROUP BY l.tweet_id
    ),
    retweets AS (
      SELECT rt.tweet_id, COUNT(DISTINCT rt.id)::int AS count
      FROM tweet_retweets rt
      JOIN tweets reposted ON reposted.id = rt.tweet_id
      JOIN users actor ON actor.id = rt.user_id
      WHERE COALESCE(actor.is_data_test, false) = false
        AND COALESCE(rt.is_data_test, false) = false
        AND reposted.created_at >= NOW() - (:window || ' days')::interval
      GROUP BY rt.tweet_id
    ),
    replies AS (
      SELECT reply.parent_tweet_id AS tweet_id, COUNT(DISTINCT reply.id)::int AS count
      FROM tweets reply
      JOIN tweets parent ON parent.id = reply.parent_tweet_id
      JOIN users actor ON actor.id = reply.user_id
      WHERE reply.parent_tweet_id IS NOT NULL
        AND reply.deleted_at IS NULL
        AND COALESCE(reply.is_data_test, false) = false
        AND COALESCE(actor.is_data_test, false) = false
        AND parent.created_at >= NOW() - (:window || ' days')::interval
      GROUP BY reply.parent_tweet_id
    ),
    candidates AS (
      SELECT
        t.id, t.content, t.created_at, t.media_urls, t.hashtags,
        t.view_count,
        u.id AS author_id, u.username, u.full_name, u.avatar, u.verified,
        u.verification_style, u.premium, u.subscription_tier,
        COALESCE(l.count, 0)::int AS likes,
        COALESCE(rt.count, 0)::int AS retweets,
        COALESCE(rp.count, 0)::int AS replies,
        (COALESCE(l.count, 0) + COALESCE(rt.count, 0) + COALESCE(rp.count, 0))::int AS engagements,
        GREATEST(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600.0, 0.25) AS age_hours,
        COALESCE(a.score, 0)::numeric AS niche_affinity
      FROM tweets t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN likes l ON l.tweet_id = t.id
      LEFT JOIN retweets rt ON rt.tweet_id = t.id
      LEFT JOIN replies rp ON rp.tweet_id = t.id
      LEFT JOIN affinity a ON a.author_id = t.user_id
      WHERE t.created_at >= NOW() - (:window || ' days')::interval
        AND t.deleted_at IS NULL
        AND t.parent_tweet_id IS NULL
        AND COALESCE(t.is_retweet, false) = false
        AND t.is_private = false
        AND t.moderation_status = 'approved'
        AND COALESCE(t.is_data_test, false) = false
        AND u.id <> :userId
        AND u.is_active = true
        AND u.is_suspended = false
        AND COALESCE(u.is_data_test, false) = false
        AND COALESCE(u.is_private_account, false) = false
        -- Ne jamais renvoyer le texte complet d'un contenu payant depuis une
        -- route qui ne passe pas par le masque et le contrôle d'achat.
        AND NOT EXISTS (
          SELECT 1 FROM paid_contents pc
          WHERE pc.content_type = 'tweet'
            AND pc.content_id = t.id
            AND pc.is_active = true
        )
        -- Un auteur affinitaire doit quand même avoir un signal observable.
        -- Le repli global est plus exigeant et ne remplit que la fin du lot.
        AND (
          (a.score > 0 AND (
            COALESCE(l.count, 0) + COALESCE(rt.count, 0) + COALESCE(rp.count, 0) > 0
            OR COALESCE(t.view_count, 0) >= 5
          ))
          OR (a.score IS NULL AND (
            COALESCE(l.count, 0) + COALESCE(rt.count, 0) + COALESCE(rp.count, 0) >= 2
            OR COALESCE(t.view_count, 0) >= 15
          ))
        )
    ),
    benchmark AS (
      SELECT COALESCE(
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY engagements::numeric / GREATEST(age_hours, 1)
        ),
        0
      )::numeric AS median_pace
      FROM candidates
    ),
    ranked AS (
      SELECT c.*,
        (c.engagements::numeric / GREATEST(c.age_hours, 1))
          / GREATEST(b.median_pace, 0.05) AS velocity_ratio,
        (
          LN(2 + c.engagements * 3 + LEAST(COALESCE(c.view_count, 0), 500) * 0.08)
          / SQRT(GREATEST(c.age_hours, 1))
        ) * (1 + c.niche_affinity * 1.5) AS momentum_score
      FROM candidates c
      CROSS JOIN benchmark b
    )
    SELECT *,
      ARRAY_REMOVE(ARRAY[
        CASE WHEN niche_affinity >= 0.99 THEN 'followed_account'::text END,
        CASE WHEN niche_affinity > 0 AND niche_affinity < 0.99 THEN 'network_affinity'::text END,
        CASE WHEN velocity_ratio >= 2 THEN 'fast_engagement'::text END,
        CASE WHEN COALESCE(view_count, 0) >= 20 THEN 'high_reach'::text END
      ], NULL) AS reasons
    FROM ranked
    -- D'abord la niche ; le global n'est qu'un repli si le lot n'est pas
    -- rempli, au lieu de se mélanger en permanence aux vrais voisins.
    ORDER BY CASE WHEN niche_affinity > 0 THEN 0 ELSE 1 END,
             momentum_score DESC, engagements DESC, created_at DESC
    LIMIT :limit
  `, {
    replacements: { userId: String(userId), window: String(window), limit: max },
    type: sequelize.QueryTypes.SELECT,
  });

  return rows.map((r) => ({
    tweet: {
      id: r.id,
      content: r.content,
      created_at: r.created_at,
      media_urls: Array.isArray(r.media_urls) ? r.media_urls : [],
      hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
      author: {
        id: r.author_id,
        username: r.username,
        full_name: r.full_name,
        avatar: r.avatar,
        verified: Boolean(r.verified),
        verification_style: r.verification_style,
        premium: Boolean(r.premium),
        subscription_tier: r.subscription_tier,
      },
    },
    engagements: Number(r.engagements) || 0,
    likes: Number(r.likes) || 0,
    retweets: Number(r.retweets) || 0,
    replies: Number(r.replies) || 0,
    velocity_ratio: Math.round((Number(r.velocity_ratio) || 0) * 10) / 10,
    niche_affinity: Math.round((Number(r.niche_affinity) || 0) * 100) / 100,
    reasons: Array.isArray(r.reasons) ? r.reasons : [],
    window_hours: Math.max(1, Math.min(window * 24, Math.round(Number(r.age_hours) || 1))),
  }));
}

/** Médiane d'une liste de nombres. Exportée pour être testable seule. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Tweets de référence : au moins autant, sinon la médiane ne veut rien dire. */
const BASELINE_MIN_TWEETS = 5;

/**
 * Rythme habituel d'un auteur AU MÊME ÂGE que le tweet observé.
 *
 * La première version divisait les engagements de chaque tweet passé par son
 * âge TOTAL : un tweet d'un mois donnait « 0,02 interaction/heure ». Or
 * l'engagement est massivement concentré dans les premières heures. On
 * comparait donc la pointe d'un tweet de deux heures à la moyenne étalée d'un
 * tweet de trente jours — le rapport partait à 40× pour une publication
 * parfaitement ordinaire, et l'alerte annonçait un décollage à tout le monde.
 *
 * On mesure maintenant, pour chacun des 30 derniers tweets originaux, les
 * engagements reçus pendant SES `ageHours` premières heures. Le rapport
 * compare enfin deux choses de même nature, et le multiplicateur annoncé à
 * l'auteur veut dire quelque chose.
 *
 * Médiane et non moyenne : un seul tweet viral dans l'historique tirerait la
 * moyenne assez haut pour que plus rien ne déclenche jamais — exactement
 * l'auteur pour qui l'alerte compte le plus.
 */
async function baselineFor(userId, ageHours = 24) {
  // Fenêtre bornée : sous 15 minutes le bruit domine, au-delà de 48 heures on
  // sort de la fenêtre d'alerte de toute façon.
  const window = Math.min(Math.max(Number(ageHours) || 1, 0.25), 48);

  const rows = await queryRead(`
    SELECT
      t.id,
      (
        COUNT(DISTINCT l.id) FILTER (
          WHERE l.created_at <= t.created_at + (:window || ' hours')::interval
        )
        + COUNT(DISTINCT rt.id) FILTER (
          WHERE rt.created_at <= t.created_at + (:window || ' hours')::interval
        )
        + COUNT(DISTINCT rp.id) FILTER (
          WHERE rp.created_at <= t.created_at + (:window || ' hours')::interval
        )
      )::int AS engagements
    FROM tweets t
    LEFT JOIN tweet_likes l ON l.tweet_id = t.id
    LEFT JOIN tweet_retweets rt ON rt.tweet_id = t.id
    LEFT JOIN tweets rp ON rp.parent_tweet_id = t.id AND rp.deleted_at IS NULL
    WHERE t.user_id = :userId
      AND t.deleted_at IS NULL
      AND t.parent_tweet_id IS NULL
      -- Le tweet de référence doit avoir EU le temps de vivre la fenêtre
      -- entière, sinon on comparerait à un historique tronqué.
      AND t.created_at < NOW() - (:window || ' hours')::interval
    GROUP BY t.id, t.created_at
    ORDER BY t.created_at DESC
    LIMIT 30
  `, {
    replacements: { userId: String(userId), window: String(window) },
    type: sequelize.QueryTypes.SELECT,
  });

  // Moins de cinq tweets de référence : pas de base fiable, donc pas
  // d'alerte. Prévenir un compte neuf que « son tweet décolle » à trois likes
  // décrédibiliserait la fonctionnalité en une notification.
  if (rows.length < BASELINE_MIN_TWEETS) return null;

  return median(rows.map((r) => Number(r.engagements)));
}

/**
 * Cherche les tweets récents qui dépassent le rythme habituel de leur auteur
 * et prévient une seule fois par tweet (contrainte d'unicité en base).
 */
async function scanVelocity({ limit = 300 } = {}) {
  const since = new Date(Date.now() - VELOCITY_ALERT_MAX_TWEET_AGE_MS);

  const candidates = await queryRead(`
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

  // Une base par auteur ET par tranche d'âge : deux tweets du même auteur
  // publiés à des heures différentes ne se comparent pas au même historique.
  const baselines = new Map();
  let alerted = 0;

  for (const row of candidates) {
    try {
      const ageHours = Math.max(Number(row.age_hours), 0.25);
      // Tranches d'une demi-heure : assez fin pour rester juste, assez large
      // pour ne pas relancer la requête à chaque tweet d'un même auteur.
      const bucket = Math.max(0.5, Math.round(ageHours * 2) / 2);
      const key = `${row.user_id}:${bucket}`;
      if (!baselines.has(key)) baselines.set(key, await baselineFor(row.user_id, bucket));
      const baseline = baselines.get(key);
      if (baseline === null || baseline <= 0) continue;

      // Les deux termes sont des engagements sur une même durée de vie :
      // le rapport est enfin homogène.
      const ratio = Number(row.engagements) / baseline;
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
  const pass = () => {
    scanVelocity().catch((e) => logger.error('[radar] Passage de vitesse en échec:', e));
  };
  // Un premier passage peu après le démarrage : sinon un redémarrage toutes
  // les quelques minutes (déploiement, `pm2 restart`) repousse indéfiniment
  // la détection, et un tweet qui décolle est justement ce qu'on ne peut pas
  // signaler en retard.
  const kickoff = setTimeout(pass, 60 * 1000);
  if (typeof kickoff.unref === 'function') kickoff.unref();
  velocityTimer = setInterval(pass, VELOCITY_INTERVAL_MS);
  if (typeof velocityTimer.unref === 'function') velocityTimer.unref();
  logger.info('[radar] Détection de décollage démarrée');
}

function stopVelocityWorker() {
  if (velocityTimer) clearInterval(velocityTimer);
  velocityTimer = null;
}

module.exports = {
  risingAccounts,
  nicheTrendingTweets,
  baselineFor,
  median,
  scanVelocity,
  velocityHistory,
  startVelocityWorker,
  stopVelocityWorker,
  BASELINE_MIN_TWEETS,
};
