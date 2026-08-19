/**
 * Analytics prédictifs — avantage du palier Pro.
 *
 * Estime la portée et l'engagement d'un tweet AVANT publication, à partir de
 * l'historique réel du compte. Aucun modèle entraîné ici : tout est calculé à
 * la demande sur les tweets déjà publiés par l'auteur, ce qui rend chaque
 * chiffre traçable jusqu'à une ligne de la base.
 *
 * ── Principe ──────────────────────────────────────────────────────────────
 * 1. On établit une BASE : la distribution de l'engagement des tweets
 *    originaux de l'auteur (médiane, quartiles). La médiane et non la moyenne :
 *    un seul tweet viral suffirait à fausser une moyenne, et promettre à
 *    quelqu'un l'engagement de son meilleur jour est le plus sûr moyen de
 *    décevoir.
 * 2. On mesure des FACTEURS sur ce même historique : est-ce que SES tweets avec
 *    média marchent mieux que SES tweets sans ? Chaque facteur devient un
 *    multiplicateur, ramené vers 1 quand l'échantillon est trop petit
 *    (rétrécissement bayésien — voir `shrunkMultiplier`).
 * 3. La prédiction = base × produit des multiplicateurs, restituée sous forme
 *    de FOURCHETTE et jamais de valeur unique : l'engagement d'un tweet est
 *    bruité par nature, annoncer « 42 likes » serait une fausse précision.
 *
 * ── Ce que ce service ne fait pas ─────────────────────────────────────────
 * Sans historique suffisant, il REFUSE de prédire (`hasEnoughData: false`)
 * plutôt que d'extrapoler sur deux tweets. Même règle que le « meilleur
 * créneau » : sur un avantage payant, un mauvais conseil coûte plus cher que
 * pas de conseil.
 */

const { sequelize } = require('../models');
const logger = require('../utils/logger');
const predictiveEngine = require('./predictiveModelEngine');

/** En dessous, la distribution de l'auteur n'a aucun sens statistique. */
const MIN_TWEETS_FOR_PREDICTION = 5;
/** À partir de là, on considère la base fiable (bandeau de confiance « élevée »). */
const RELIABLE_SAMPLE = 20;
/** Fenêtre d'historique par défaut — assez large pour lisser, assez courte pour rester actuelle. */
const DEFAULT_HISTORY_DAYS = 120;
/**
 * Force du rétrécissement. Avec K = 5, un facteur mesuré sur 5 tweets de chaque
 * côté ne compte qu'à moitié ; il faut une vingtaine de tweets pour qu'il
 * s'exprime pleinement.
 */
const SHRINK_K = 5;
/** Un facteur ne peut ni diviser par deux ni doubler à lui seul. */
const MULTIPLIER_FLOOR = 0.55;
const MULTIPLIER_CEIL = 1.8;
/** Un créneau horaire sous ce seuil ne pèse pas dans la recommandation d'heure. */
const MIN_TWEETS_PER_SLOT = 3;

// ── Extraction des caractéristiques d'un texte ─────────────────────────────

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/u;
const URL_RE = /https?:\/\/\S+/i;

/**
 * Décrit un texte par les seules caractéristiques qu'on saura aussi mesurer sur
 * l'historique. Toute caractéristique ajoutée ici doit avoir son équivalent
 * calculable en SQL dans `fetchAuthorHistory`, sinon le facteur n'est pas
 * comparable et n'a rien à faire dans la prédiction.
 */
function extractFeatures(content, { mediaCount = 0, publishAt = new Date() } = {}) {
  return predictiveEngine.extractFeatures(content, { mediaCount, publishAt });
}

// ── Statistiques de base ───────────────────────────────────────────────────

function quantile(sortedValues, q) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedValues[base + 1];
  return next !== undefined
    ? sortedValues[base] + rest * (next - sortedValues[base])
    : sortedValues[base];
}

function describe(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    mean: sorted.length ? sum / sorted.length : 0,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

/**
 * Multiplicateur d'un facteur, ramené vers 1 selon la taille du plus petit des
 * deux groupes comparés.
 *
 * Sans ce rétrécissement, un auteur ayant publié UN tweet avec média qui a
 * cartonné se verrait annoncer « les médias multiplient ton engagement par 6 ».
 * C'est du bruit, pas un facteur. Le poids `w` vaut 0 pour un groupe vide et
 * tend vers 1 quand les deux groupes sont fournis.
 */
function shrunkMultiplier(withValues, withoutValues) {
  const nWith = withValues.length;
  const nWithout = withoutValues.length;
  if (nWith === 0 || nWithout === 0) return null;

  const avgWith = withValues.reduce((a, b) => a + b, 0) / nWith;
  const avgWithout = withoutValues.reduce((a, b) => a + b, 0) / nWithout;

  // Un groupe de référence à zéro rendrait le ratio infini : on s'abstient.
  if (avgWithout <= 0) return null;

  const raw = avgWith / avgWithout;
  const smallest = Math.min(nWith, nWithout);
  const weight = smallest / (smallest + SHRINK_K);
  const shrunk = 1 + (raw - 1) * weight;

  return {
    value: Math.max(MULTIPLIER_FLOOR, Math.min(MULTIPLIER_CEIL, shrunk)),
    rawRatio: raw,
    sampleWith: nWith,
    sampleWithout: nWithout,
    confidence: weight,
  };
}

// ── Historique de l'auteur ─────────────────────────────────────────────────

/**
 * Tweets ORIGINAUX de l'auteur avec leur engagement réel.
 *
 * Les retweets purs sont exclus : leurs compteurs et leurs interactions visent
 * le tweet d'origine, pas celui-ci — les inclure ferait entrer dans la base
 * l'audience de quelqu'un d'autre. Les réponses le sont aussi : leur portée
 * dépend du fil parent et non du compte, elles diluent le signal.
 */
async function fetchAuthorHistory(userId, days = DEFAULT_HISTORY_DAYS) {
  const startDate = new Date(Date.now() - days * 86400000);

  const rows = await sequelize.query(`
    SELECT
      t.id,
      t.content,
      t.created_at,
      COALESCE(t.view_count, 0)::int AS views,
      COALESCE(t.click_count, 0)::int AS clicks,
      t.tweet_type,
      t.language,
      COALESCE(t.is_sensitive, false) AS is_sensitive,
      t.recommendation_group,
      EXTRACT(HOUR FROM t.created_at)::int AS hour,
      EXTRACT(DOW FROM t.created_at)::int AS day_of_week,
      CHAR_LENGTH(COALESCE(t.content, ''))::int AS length,
      CASE
        WHEN jsonb_typeof(t.media_urls) = 'array' THEN jsonb_array_length(t.media_urls)
        ELSE 0
      END::int AS media_count,
      CASE
        WHEN jsonb_typeof(t.hashtags) = 'array' THEN jsonb_array_length(t.hashtags)
        ELSE 0
      END::int AS hashtag_count,
      CASE
        WHEN jsonb_typeof(t.mentions) = 'array' THEN jsonb_array_length(t.mentions)
        ELSE 0
      END::int AS mention_count,
      (SELECT COUNT(*) FROM tweet_likes l WHERE l.tweet_id = t.id)::int AS likes,
      (SELECT COUNT(*) FROM tweet_retweets rt WHERE rt.tweet_id = t.id)::int AS retweets,
      (SELECT COUNT(*) FROM tweets rp
         WHERE rp.parent_tweet_id = t.id AND rp.deleted_at IS NULL)::int AS replies
    FROM tweets t
    WHERE t.user_id = :userId::uuid
      AND t.deleted_at IS NULL
      AND t.parent_tweet_id IS NULL
      AND COALESCE(t.is_retweet, false) = false
      AND t.created_at >= :startDate
    ORDER BY t.created_at DESC
    LIMIT 600
  `, {
    replacements: { userId, startDate },
    type: sequelize.QueryTypes.SELECT,
  });

  const history = rows.map((r) => {
    const content = r.content || '';
    return {
      id: r.id,
      content,
      createdAt: r.created_at,
      views: r.views,
      clicks: r.clicks,
      likes: r.likes,
      retweets: r.retweets,
      replies: r.replies,
      engagement: r.likes + r.retweets + r.replies,
      hour: r.hour,
      dayOfWeek: r.day_of_week,
      length: r.length,
      mediaCount: r.media_count,
      hashtagCount: r.hashtag_count,
      mentionCount: r.mention_count,
      hasMedia: r.media_count > 0,
      hasQuestion: content.includes('?'),
      hasEmoji: EMOJI_RE.test(content),
      hasLink: URL_RE.test(content),
      hasLineBreaks: content.includes('\n'),
      tweetType: r.tweet_type,
      language: r.language,
      isSensitive: Boolean(r.is_sensitive),
      recommendationGroup: r.recommendation_group,
      trackedViews: 0,
      uniqueViewers: 0,
      averageDwellMs: null,
      bookmarks: 0,
      shares: 0,
      mediaViews: 0,
      interactionQuality: null,
    };
  });

  if (history.length === 0) return history;

  // Les signaux comportementaux sont plus riches que les compteurs du tweet,
  // mais cette table a été ajoutée après les premiers comptes. Une panne ou une
  // installation ancienne ne doit donc jamais rendre l'analytics inutilisable :
  // on retombe sur les compteurs de base en cas d'indisponibilité.
  try {
    const behaviorRows = await sequelize.query(`
      SELECT
        target_id AS tweet_id,
        COUNT(*) FILTER (WHERE action_type = 'tweet_view')::int AS tracked_views,
        COUNT(DISTINCT user_id) FILTER (WHERE action_type = 'tweet_view')::int AS unique_viewers,
        AVG(duration_ms) FILTER (
          WHERE action_type IN ('tweet_view', 'media_view', 'time_spent')
            AND duration_ms > 0
        )::float AS average_dwell_ms,
        COUNT(*) FILTER (WHERE action_type = 'tweet_bookmark')::int AS bookmarks,
        COUNT(*) FILTER (WHERE action_type = 'tweet_share')::int AS shares,
        COUNT(*) FILTER (WHERE action_type = 'media_view')::int AS media_views,
        AVG(interaction_quality) FILTER (WHERE interaction_quality IS NOT NULL)::float
          AS interaction_quality
      FROM user_behavior_data
      WHERE target_type = 'tweet'
        AND target_id IN (:tweetIds)
        AND COALESCE(is_data_test, false) = false
      GROUP BY target_id
    `, {
      replacements: { tweetIds: history.map((tweet) => String(tweet.id)) },
      type: sequelize.QueryTypes.SELECT,
    });
    const byTweet = new Map(behaviorRows.map((row) => [String(row.tweet_id), row]));
    history.forEach((tweet) => {
      const behavior = byTweet.get(String(tweet.id));
      if (!behavior) return;
      tweet.trackedViews = Number(behavior.tracked_views) || 0;
      tweet.uniqueViewers = Number(behavior.unique_viewers) || 0;
      tweet.averageDwellMs = behavior.average_dwell_ms == null
        ? null
        : Number(behavior.average_dwell_ms);
      tweet.bookmarks = Number(behavior.bookmarks) || 0;
      tweet.shares = Number(behavior.shares) || 0;
      tweet.mediaViews = Number(behavior.media_views) || 0;
      tweet.interactionQuality = behavior.interaction_quality == null
        ? null
        : Number(behavior.interaction_quality);
    });
  } catch (error) {
    logger.warn(`[CreatorIntel] Signaux comportementaux ignorés: ${error.message}`);
  }

  return history;
}

async function fetchAuthorContext(userId) {
  try {
    const [row] = await sequelize.query(`
      SELECT
        u.verified,
        u.created_at,
        COALESCE(u.algorithmic_visibility_multiplier, 1)::float
          AS algorithmic_visibility_multiplier,
        (SELECT COUNT(*) FROM user_follows f
          WHERE f.following_id = u.id AND f.status = 'active')::int AS followers,
        (SELECT COUNT(*) FROM user_follows f
          WHERE f.follower_id = u.id AND f.status = 'active')::int AS following
      FROM users u
      WHERE u.id = :userId::uuid
      LIMIT 1
    `, {
      replacements: { userId },
      type: sequelize.QueryTypes.SELECT,
    });
    if (!row) return {};
    return {
      followers: Number(row.followers) || 0,
      following: Number(row.following) || 0,
      verified: Boolean(row.verified),
      accountAgeDays: row.created_at
        ? Math.max(0, (Date.now() - new Date(row.created_at).getTime()) / 86400000)
        : 0,
      algorithmicVisibilityMultiplier: Number(row.algorithmic_visibility_multiplier) || 1,
    };
  } catch (error) {
    logger.warn(`[CreatorIntel] Contexte auteur incomplet: ${error.message}`);
    return {};
  }
}

async function fetchAudienceActivity(tweetIds, days = DEFAULT_HISTORY_DAYS, authorId = null) {
  if (!tweetIds.length) return [];
  const startDate = new Date(Date.now() - days * 86400000);
  try {
    return await sequelize.query(`
      SELECT
        EXTRACT(DOW FROM timestamp)::int AS day_of_week,
        EXTRACT(HOUR FROM timestamp)::int AS hour,
        COUNT(*)::int AS interactions,
        SUM(EXP(
          -LN(2) * EXTRACT(EPOCH FROM (NOW() - timestamp)) / (30 * 86400.0)
        ))::float AS weighted_interactions,
        COUNT(DISTINCT user_id)::int AS unique_users,
        AVG(interaction_quality) FILTER (WHERE interaction_quality IS NOT NULL)::float
          AS average_quality,
        AVG(duration_ms) FILTER (WHERE duration_ms > 0)::float AS average_duration_ms
      FROM user_behavior_data
      WHERE target_type = 'tweet'
        AND target_id IN (:tweetIds)
        AND timestamp >= :startDate
        AND timestamp <= NOW() + INTERVAL '5 minutes'
        AND COALESCE(is_data_test, false) = false
        AND (:authorId IS NULL OR user_id::text <> :authorId)
        AND action_type IN (
          'tweet_view', 'tweet_like', 'tweet_retweet', 'tweet_reply',
          'tweet_share', 'tweet_bookmark', 'media_view', 'link_click'
        )
      GROUP BY EXTRACT(DOW FROM timestamp), EXTRACT(HOUR FROM timestamp)
    `, {
      replacements: { tweetIds: tweetIds.map(String), startDate, authorId: authorId ? String(authorId) : null },
      type: sequelize.QueryTypes.SELECT,
    }).then((rows) => rows.map((row) => ({
      dayOfWeek: Number(row.day_of_week),
      hour: Number(row.hour),
      interactions: Number(row.interactions) || 0,
      weightedInteractions: Number(row.weighted_interactions) || 0,
      uniqueUsers: Number(row.unique_users) || 0,
      averageQuality: row.average_quality == null ? null : Number(row.average_quality),
      averageDurationMs: row.average_duration_ms == null ? null : Number(row.average_duration_ms),
    })));
  } catch (error) {
    logger.warn(`[CreatorIntel] Horaires d'audience indisponibles: ${error.message}`);
    return [];
  }
}

// ── Facteurs ───────────────────────────────────────────────────────────────

/**
 * Chaque facteur compare deux sous-populations de l'historique de l'auteur.
 * `applies` dit si le brouillon en cours est concerné ; sinon le facteur est
 * calculé quand même (pour l'expliquer à l'utilisateur) mais n'entre pas dans
 * le produit.
 */
function buildFactors(history, features) {
  const engagementOf = (t) => t.engagement;
  const factors = [];

  const add = (key, label, explain, predicate, applies, direction = 'neutral') => {
    const withGroup = history.filter(predicate).map(engagementOf);
    const withoutGroup = history.filter((t) => !predicate(t)).map(engagementOf);
    const m = shrunkMultiplier(withGroup, withoutGroup);
    if (!m) return;
    factors.push({
      key,
      label,
      explain,
      applies,
      direction,
      multiplier: m.value,
      impactPercent: Math.round((m.value - 1) * 100),
      sample: { with: m.sampleWith, without: m.sampleWithout },
      confidence: Math.round(m.confidence * 100),
    });
  };

  // ── Média ──
  add(
    'media',
    'Image ou vidéo',
    'Comparaison entre tes tweets avec média et tes tweets sans.',
    (t) => t.hasMedia,
    features.hasMedia,
    'positive',
  );

  // ── Longueur ── Le seuil coupe à la limite du palier gratuit : c'est là que
  // le format change réellement de nature (message court vs développé).
  add(
    'length',
    'Format long',
    'Tes tweets de plus de 280 caractères face à tes tweets courts.',
    (t) => t.length > 280,
    features.length > 280,
    'neutral',
  );

  // ── Hashtags ──
  add(
    'hashtags',
    'Hashtags',
    'Tes tweets qui portent au moins un hashtag face aux autres.',
    (t) => t.hashtagCount > 0,
    features.hashtagCount > 0,
    'neutral',
  );

  // ── Question ──
  add(
    'question',
    'Question posée',
    'Une question appelle une réponse : on regarde si ça marche chez toi.',
    (t) => t.hasQuestion,
    features.hasQuestion,
    'positive',
  );

  // ── Emoji ──
  add(
    'emoji',
    'Emoji',
    'Tes tweets contenant au moins un emoji face aux autres.',
    (t) => t.hasEmoji,
    features.hasEmoji,
    'neutral',
  );

  // ── Lien externe ──
  add(
    'link',
    'Lien externe',
    'Un lien fait souvent sortir de l\'app — mesuré sur ton propre historique.',
    (t) => t.hasLink,
    features.hasLink,
    'negative',
  );

  // ── Mise en forme ──
  add(
    'linebreaks',
    'Texte aéré',
    'Tes tweets sur plusieurs lignes face à tes tweets d\'un bloc.',
    (t) => t.hasLineBreaks,
    features.hasLineBreaks,
    'positive',
  );

  // ── Mentions ──
  add(
    'mentions',
    'Mentions de comptes',
    'Mentionner quelqu\'un peut apporter son audience — ou pas.',
    (t) => t.mentionCount > 0,
    features.mentionCount > 0,
    'neutral',
  );

  // ── Jour de semaine vs week-end ──
  add(
    'weekend',
    'Publication le week-end',
    'Samedi et dimanche face au reste de la semaine.',
    (t) => t.dayOfWeek === 0 || t.dayOfWeek === 6,
    features.dayOfWeek === 0 || features.dayOfWeek === 6,
    'neutral',
  );

  return factors;
}

/**
 * Effet du créneau horaire choisi, traité à part des autres facteurs :
 * comparer « cette heure » à « toutes les autres » sur 24 classes produirait
 * des groupes minuscules. On compare donc la tranche de 3 heures autour du
 * créneau visé au reste de la journée.
 */
function buildTimeFactor(history, features) {
  const inSlot = (t) => {
    const diff = Math.min(
      Math.abs(t.hour - features.hour),
      24 - Math.abs(t.hour - features.hour),
    );
    return diff <= 1;
  };
  const withGroup = history.filter(inSlot).map((t) => t.engagement);
  const withoutGroup = history.filter((t) => !inSlot(t)).map((t) => t.engagement);
  const m = shrunkMultiplier(withGroup, withoutGroup);
  if (!m) return null;

  return {
    key: 'timeslot',
    label: `Créneau ${features.hour}h`,
    explain: 'Tes tweets publiés autour de cette heure face au reste de la journée.',
    applies: true,
    direction: 'neutral',
    multiplier: m.value,
    impactPercent: Math.round((m.value - 1) * 100),
    sample: { with: m.sampleWith, without: m.sampleWithout },
    confidence: Math.round(m.confidence * 100),
  };
}

/** Meilleures heures de l'auteur — même règle de fiabilité que `/best-time`. */
function bestHoursFrom(history) {
  const byHour = new Map();
  history.forEach((t) => {
    const cur = byHour.get(t.hour) || { hour: t.hour, tweets: 0, engagement: 0 };
    cur.tweets += 1;
    cur.engagement += t.engagement;
    byHour.set(t.hour, cur);
  });

  return [...byHour.values()]
    .filter((h) => h.tweets >= MIN_TWEETS_PER_SLOT)
    .map((h) => ({ ...h, avgEngagement: h.engagement / h.tweets }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement)
    .slice(0, 3);
}

// ── Conseils ───────────────────────────────────────────────────────────────

/**
 * Conseils actionnables, tirés UNIQUEMENT des facteurs mesurés chez l'auteur.
 * Pas de conseil générique type « publie régulièrement » : s'il n'est pas
 * adossé à un chiffre de son propre historique, il n'a rien à faire ici.
 */
function buildAdvice(factors, timeFactor, features, bestHours, baseline) {
  const advice = [];
  const byKey = Object.fromEntries(factors.map((f) => [f.key, f]));

  const suggest = (condition, icon, text, gain) => {
    if (condition) advice.push({ icon, text, gain });
  };

  // Facteurs favorables non utilisés → suggestion d'ajout.
  suggest(
    byKey.media && !features.hasMedia && byKey.media.impactPercent >= 15,
    'image',
    `Ajoute une image ou une vidéo : tes tweets illustrés font +${byKey.media?.impactPercent} % d'engagement.`,
    byKey.media?.impactPercent,
  );
  suggest(
    byKey.question && !features.hasQuestion && byKey.question.impactPercent >= 15,
    'help-circle',
    `Pose une question : celles que tu poses rapportent +${byKey.question?.impactPercent} % d'engagement.`,
    byKey.question?.impactPercent,
  );
  suggest(
    byKey.linebreaks && !features.hasLineBreaks && features.length > 200
      && byKey.linebreaks.impactPercent >= 10,
    'reorder-four',
    `Aère ton texte : tes tweets sur plusieurs lignes font +${byKey.linebreaks?.impactPercent} %.`,
    byKey.linebreaks?.impactPercent,
  );
  suggest(
    byKey.hashtags && !features.hashtagCount && byKey.hashtags.impactPercent >= 15,
    'pricetag',
    `Un hashtag pertinent t'apporte en moyenne +${byKey.hashtags?.impactPercent} %.`,
    byKey.hashtags?.impactPercent,
  );

  // Facteurs défavorables utilisés → suggestion de retrait.
  suggest(
    byKey.link && features.hasLink && byKey.link.impactPercent <= -15,
    'link',
    `Attention au lien externe : chez toi il coûte ${byKey.link?.impactPercent} % d'engagement.`,
    byKey.link?.impactPercent,
  );
  suggest(
    byKey.hashtags && features.hashtagCount > 3 && byKey.hashtags.impactPercent <= 0,
    'pricetags',
    'Trop de hashtags dilue le message, et chez toi ils ne rapportent rien.',
    byKey.hashtags?.impactPercent,
  );

  // Créneau.
  if (bestHours.length > 0) {
    const best = bestHours[0];
    const isAlreadyBest = Math.abs(best.hour - features.hour) <= 1;
    suggest(
      !isAlreadyBest && timeFactor && timeFactor.impactPercent <= -10,
      'time',
      `Ce créneau n'est pas ton meilleur : vers ${best.hour}h ton audience réagit nettement plus.`,
      null,
    );
  }

  // Longueur extrême.
  suggest(
    features.length > 0 && features.length < 40 && baseline.count >= RELIABLE_SAMPLE,
    'text',
    'Message très court : développe un peu, il y a peu de matière à réagir.',
    null,
  );
  suggest(
    features.isUppercaseHeavy,
    'alert-circle',
    'Beaucoup de majuscules : c\'est lu comme un cri, et ça freine le partage.',
    null,
  );

  return advice.slice(0, 5);
}

// ── Prédiction ─────────────────────────────────────────────────────────────

/**
 * Estime la performance d'un tweet non encore publié.
 *
 * @param {object} params
 * @param {string} params.userId       auteur
 * @param {string} params.content      texte du brouillon
 * @param {number} [params.mediaCount] nombre de médias joints
 * @param {Date|string} [params.publishAt] heure de publication envisagée
 * @param {number} [params.historyDays]
 */
async function predictTweetPerformance({
  userId,
  content,
  mediaCount = 0,
  publishAt,
  historyDays = DEFAULT_HISTORY_DAYS,
}) {
  const when = publishAt ? new Date(publishAt) : new Date();
  const [history, authorContext] = await Promise.all([
    fetchAuthorHistory(userId, historyDays),
    fetchAuthorContext(userId),
  ]);
  const audienceActivity = await fetchAudienceActivity(
    history.map((tweet) => tweet.id),
    historyDays,
    userId,
  );

  const modelResult = predictiveEngine.buildPrediction({
    history,
    content,
    mediaCount,
    publishAt: when,
    audienceActivity,
    authorContext,
  });

  if (!modelResult.hasEnoughData) {
    return {
      ...modelResult,
      historyDays,
      message: `Publie encore ${modelResult.minimumRequired - modelResult.sampleSize} tweet(s) pour que la prédiction devienne fiable.`,
      generatedAt: new Date().toISOString(),
    };
  }

  // Les facteurs binaires restent dans la réponse pour expliquer simplement
  // l'historique à l'utilisateur. Ils ne sont plus multipliés entre eux : la
  // prédiction numérique vient désormais de l'ensemble calibré ci-dessus.
  const features = extractFeatures(content, { mediaCount, publishAt: when });
  const factors = buildFactors(history, features);
  const timeFactor = buildTimeFactor(history, features);
  const allFactors = timeFactor ? [...factors, timeFactor] : factors;
  const bestHours = bestHoursFrom(history);
  const engagementStats = describe(history.map((tweet) => tweet.engagement));
  const advice = buildAdvice(factors, timeFactor, features, bestHours, engagementStats);

  // Les drivers du modèle couvrent aussi les variables continues (lisibilité,
  // densité de ponctuation, accroche, espacement, sentiment…). On les traduit
  // en conseils quand leur impact négatif est assez net.
  modelResult.drivers
    .filter((driver) => driver.impactPercent <= -8)
    .slice(0, Math.max(0, 5 - advice.length))
    .forEach((driver) => advice.push({
      icon: 'analytics-outline',
      text: `${driver.label} pèse environ ${driver.impactPercent} % dans le modèle pour ce brouillon.`,
      gain: driver.impactPercent,
    }));

  return {
    ...modelResult,
    historyDays,
    factors: allFactors.sort((a, b) => Math.abs(b.impactPercent) - Math.abs(a.impactPercent)),
    bestHours: bestHours.map((hour) => ({
      hour: hour.hour,
      avgEngagement: Math.round(hour.avgEngagement * 10) / 10,
      tweets: hour.tweets,
    })),
    advice: advice.slice(0, 7),
    audienceActivity: audienceActivity
      .sort((a, b) => b.interactions - a.interactions)
      .slice(0, 12),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Tableau de bord prédictif du compte, indépendant d'un brouillon précis :
 * ce qui marche chez l'auteur, sa tendance, ses créneaux.
 *
 * Sert l'écran « Analytics prédictifs » à l'ouverture, avant toute saisie.
 */
async function getCreatorProfile(userId, { historyDays = DEFAULT_HISTORY_DAYS } = {}) {
  const history = await fetchAuthorHistory(userId, historyDays);

  if (history.length < MIN_TWEETS_FOR_PREDICTION) {
    return {
      hasEnoughData: false,
      sampleSize: history.length,
      minimumRequired: MIN_TWEETS_FOR_PREDICTION,
      generatedAt: new Date().toISOString(),
    };
  }

  const engagementStats = describe(history.map((t) => t.engagement));
  const viewStats = describe(history.map((t) => t.views));

  // Facteurs « à vide » : on ne teste aucun brouillon, on décrit juste ce qui
  // marche. `applies` est donc faux partout et sans importance ici.
  const neutralFeatures = extractFeatures('', { mediaCount: 0, publishAt: new Date() });
  const factors = buildFactors(history, neutralFeatures);

  /**
   * Tendance : moitié récente contre moitié ancienne de la fenêtre. Sur des
   * médianes et non des sommes, sinon un mois où l'auteur a publié deux fois
   * plus apparaîtrait comme une progression alors que chaque tweet marche pareil.
   */
  const midpoint = new Date(Date.now() - (historyDays / 2) * 86400000);
  const recent = history.filter((t) => new Date(t.createdAt) >= midpoint);
  const older = history.filter((t) => new Date(t.createdAt) < midpoint);
  const recentMedian = describe(recent.map((t) => t.engagement)).median;
  const olderMedian = describe(older.map((t) => t.engagement)).median;
  const trendComparable = recent.length >= 3 && older.length >= 3 && olderMedian > 0;

  const topTweets = [...history]
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      content: t.content.slice(0, 140),
      engagement: t.engagement,
      views: t.views,
      likes: t.likes,
      retweets: t.retweets,
      replies: t.replies,
      createdAt: t.createdAt,
      hasMedia: t.hasMedia,
      length: t.length,
    }));

  return {
    hasEnoughData: true,
    sampleSize: history.length,
    historyDays,
    confidence: history.length >= RELIABLE_SAMPLE ? 'high' : 'medium',
    baseline: {
      medianEngagement: Math.round(engagementStats.median * 10) / 10,
      averageEngagement: Math.round(engagementStats.mean * 10) / 10,
      medianViews: Math.round(viewStats.median),
      bestEverEngagement: engagementStats.max,
      p90Engagement: Math.round(engagementStats.p90 * 10) / 10,
    },
    trend: trendComparable
      ? {
        comparable: true,
        recentMedian: Math.round(recentMedian * 10) / 10,
        previousMedian: Math.round(olderMedian * 10) / 10,
        changePercent: Math.round(((recentMedian - olderMedian) / olderMedian) * 100),
      }
      // Deux périodes trop maigres : afficher « +0 % » laisserait croire à une
      // stagnation mesurée alors qu'il n'y a rien à mesurer.
      : { comparable: false },
    factors: factors.sort((a, b) => Math.abs(b.impactPercent) - Math.abs(a.impactPercent)),
    bestHours: bestHoursFrom(history).map((h) => ({
      hour: h.hour,
      avgEngagement: Math.round(h.avgEngagement * 10) / 10,
      tweets: h.tweets,
    })),
    topTweets,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Texte de l'auteur le plus proche du brouillon en cours, avec ce qu'il a fait.
 * « Un tweet comme celui-là t'a rapporté X » vaut tous les pourcentages.
 *
 * Comparaison lexicale (Jaccard sur les mots) et non sémantique : ce point est
 * appelé à chaque frappe côté app, un embedding par appel coûterait trop cher
 * pour le bénéfice. Le radar de tendances, lui, prend le temps de l'embedding.
 */
async function findComparableTweets(userId, content, { limit = 3, historyDays = DEFAULT_HISTORY_DAYS } = {}) {
  const history = await fetchAuthorHistory(userId, historyDays);
  return predictiveEngine.findComparableTweets(history, content, { limit });
}

module.exports = {
  predictTweetPerformance,
  getCreatorProfile,
  findComparableTweets,
  // Exportés pour les tests et le radar de tendances.
  extractFeatures,
  fetchAuthorHistory,
  describe,
  shrunkMultiplier,
  MIN_TWEETS_FOR_PREDICTION,
  fetchAuthorContext,
  fetchAudienceActivity,
};
