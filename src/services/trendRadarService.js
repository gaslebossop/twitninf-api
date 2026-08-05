/**
 * Radar de tendances — volet « veille sémantique » des analytics prédictifs (Pro).
 *
 * Surveille ce qui décolle sur la plateforme, le compare aux SUJETS PROPRES de
 * chaque abonné Pro, et envoie une notification avec une idée de tweet quand un
 * sujet proche du sien perce.
 *
 * ── Ce qui compte comme « qui perce » ─────────────────────────────────────
 * Pas « beaucoup mentionné » : ACCÉLÉRATION. On compare le volume des dernières
 * heures à ce que le même terme faisait les jours précédents. Un hashtag
 * populaire en continu n'est pas une nouvelle ; un terme qui triple en une
 * demi-journée, si.
 *
 * Deux garde-fous, dictés par la réalité de la base :
 *  - il faut plusieurs AUTEURS DISTINCTS. Un seul compte qui répète un mot
 *    quinze fois ne fait pas une tendance, et la table contient d'importantes
 *    rafales scriptées mono-compte qui rempliraient le radar de faux signaux ;
 *  - il faut un volume plancher. Passer de 1 à 3 mentions, c'est +200 %
 *    d'accélération et zéro information.
 *
 * ── Pourquoi une notification et pas un écran ─────────────────────────────
 * L'intérêt d'un sujet qui perce est périssable : le découvrir le lendemain en
 * ouvrant un onglet n'a plus de valeur. D'où le push — mais plafonné par jour,
 * parce qu'un avantage payant qui se met à harceler devient une raison de
 * résilier.
 */

const { sequelize, User, Notification } = require('../models');
const { queryRead } = require('../database/readReplica');
const { createLocalEmbedQuery, cosineSimilarity } = require('./policiercongo/policiercongoV2Embeddings');
const codex = require('./codexTextClient');
const { TIER } = require('../constants/subscriptionTiers');
const { isSubscriptionActive } = require('../utils/subscriptionHelpers');
const logger = require('../utils/logger');

// ── Réglages de détection ──────────────────────────────────────────────────

/** Fenêtre « chaude » : ce qui se dit maintenant. */
const RECENT_HOURS = 12;
/** Référence : ce que le terme faisait avant, pour mesurer l'écart. */
const BASELINE_DAYS = 7;
/** En dessous, le terme n'a pas assez de matière pour qu'on en parle. */
const MIN_RECENT_MENTIONS = 4;
/** Nombre d'auteurs distincts requis — anti rafale mono-compte. */
const MIN_DISTINCT_AUTHORS = 3;
/** Le terme doit faire au moins ×2,5 par rapport à son rythme habituel. */
const MIN_ACCELERATION = 2.5;
/** Proximité sémantique minimale entre le sujet et les thèmes de l'auteur. */
const MIN_TOPIC_AFFINITY = 0.62;

// ── Réglages de notification ───────────────────────────────────────────────

/** Un abonné ne reçoit pas plus d'idées que ça par jour, quoi qu'il se passe. */
const MAX_IDEAS_PER_DAY = 2;
/** Un même sujet ne redéclenche pas de notification avant ce délai. */
const TOPIC_COOLDOWN_DAYS = 5;
/** Tweets de l'auteur servant à établir ses thèmes. */
const USER_PROFILE_TWEETS = 25;
const USER_PROFILE_DAYS = 60;

/** Marqueur porté par `metadata.kind` — pas de nouvelle valeur d'ENUM à migrer
 * (même contournement que les demandes de suivi, voir `Notification`). */
const NOTIFICATION_KIND = 'trend_idea';

const embed = createLocalEmbedQuery({ isQuery: false });

/**
 * Mots vides français + bruit propre à un réseau social.
 * Sans cette liste, le « sujet qui perce » du jour est invariablement « pour ».
 */
const STOPWORDS = new Set([
  'alors', 'apres', 'après', 'aussi', 'autre', 'autres', 'avait', 'avant', 'avec', 'avoir',
  'bien', 'beaucoup', 'cela', 'celle', 'celui', 'cependant', 'ces', 'cest', 'cette', 'ceux',
  'chaque', 'chez', 'comme', 'comment', 'dans', 'depuis', 'des', 'deux', 'dire', 'donc',
  'dont', 'elle', 'elles', 'encore', 'entre', 'etaient', 'etait', 'etre', 'être', 'faire',
  'fais', 'fait', 'faut', 'hier', 'ici', 'jamais', 'jour', 'jours', 'juste', 'les', 'leur',
  'leurs', 'lui', 'mais', 'meme', 'même', 'moins', 'mon', 'nous', 'oui', 'par', 'parce',
  'pareil', 'pas', 'pendant', 'peu', 'peut', 'plus', 'pour', 'pourquoi', 'quand', 'que',
  'quel', 'quelle', 'quelque', 'quelques', 'qui', 'quoi', 'sans', 'ses', 'seulement', 'son',
  'sont', 'sous', 'suis', 'sur', 'tous', 'tout', 'toute', 'toutes', 'tres', 'très', 'trop',
  'une', 'vers', 'voir', 'vos', 'votre', 'vous', 'vraiment',
  // Bruit de plateforme : omniprésent, donc jamais informatif comme « sujet ».
  'twitninf', 'tweet', 'tweets', 'rt', 'https', 'http', 'www', 'com',
]);

/** Découpe un texte en termes candidats. */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}#\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && w.length <= 30 && !STOPWORDS.has(w.replace('#', '')));
}

/**
 * Tweets d'une fenêtre temporelle, avec leur auteur.
 * Les réponses sont exclues : elles reprennent le vocabulaire du fil parent et
 * gonfleraient artificiellement les termes déjà présents.
 */
async function fetchWindow(startDate, endDate, limit = 4000) {
  const WHERE = `
    WHERE t.deleted_at IS NULL
      AND t.parent_tweet_id IS NULL
      AND COALESCE(t.is_retweet, false) = false
      AND t.created_at >= :startDate
      AND t.created_at < :endDate`;

  const [rows, [totals]] = await Promise.all([
    queryRead(`
      SELECT t.id, t.user_id, t.content, t.hashtags, t.created_at
      FROM tweets t
      ${WHERE}
      ORDER BY t.created_at DESC
      LIMIT :limit
    `, {
      replacements: { startDate, endDate, limit },
      type: sequelize.QueryTypes.SELECT,
    }),
    queryRead(`SELECT COUNT(*)::int AS n FROM tweets t ${WHERE}`, {
      replacements: { startDate, endDate },
      type: sequelize.QueryTypes.SELECT,
    }),
  ]);

  const total = totals?.n ?? rows.length;
  /**
   * Facteur de rattrapage quand le LIMIT a tronqué la fenêtre.
   *
   * Sans lui, une fenêtre de référence plafonnée sous-compte tous les termes et
   * fait passer des sujets parfaitement stables pour des sujets qui explosent —
   * exactement le faux positif que le radar existe pour éviter. La fenêtre
   * chaude étant bien plus courte, c'est la fenêtre de référence qui saute la
   * première, donc l'erreur va toujours dans le sens du faux positif.
   */
  const scale = rows.length > 0 ? total / rows.length : 1;
  return { rows, total, scale, truncated: total > rows.length };
}

/** Compte, par terme, les occurrences et les auteurs distincts. */
function countTerms(rows) {
  const counts = new Map();

  const bump = (term, userId) => {
    const entry = counts.get(term) || { term, mentions: 0, authors: new Set() };
    entry.mentions += 1;
    entry.authors.add(userId);
    counts.set(term, entry);
  };

  rows.forEach((row) => {
    // Un terme n'est compté qu'une fois par tweet : sinon répéter un mot dans
    // un même message suffirait à le faire monter.
    const seen = new Set();

    const tags = Array.isArray(row.hashtags) ? row.hashtags : [];
    tags.forEach((tag) => {
      const t = String(tag || '').toLowerCase();
      if (t.length >= 3 && !seen.has(t)) {
        seen.add(t);
        bump(t, row.user_id);
      }
    });

    tokenize(row.content).forEach((word) => {
      if (!seen.has(word)) {
        seen.add(word);
        bump(word, row.user_id);
      }
    });
  });

  return counts;
}

/**
 * Sujets en accélération sur la plateforme.
 * @returns {Promise<Array<{term, mentions, authors, acceleration, expected}>>}
 */
async function detectRisingTopics() {
  const now = new Date();
  const recentStart = new Date(now.getTime() - RECENT_HOURS * 3600000);
  const baselineStart = new Date(recentStart.getTime() - BASELINE_DAYS * 86400000);

  const [recent, baseline] = await Promise.all([
    fetchWindow(recentStart, now),
    fetchWindow(baselineStart, recentStart),
  ]);

  if (recent.rows.length === 0) return [];

  if (baseline.truncated) {
    logger.info(
      `[TrendRadar] Fenêtre de référence tronquée (${baseline.rows.length}/${baseline.total}) — comptages remis à l'échelle ×${baseline.scale.toFixed(2)}.`,
    );
  }

  const recentCounts = countTerms(recent.rows);
  const baselineCounts = countTerms(baseline.rows);

  /** Ce que le terme ferait « normalement » sur une fenêtre de RECENT_HOURS. */
  const baselineWindows = (BASELINE_DAYS * 24) / RECENT_HOURS;

  const rising = [];
  recentCounts.forEach((entry) => {
    const authors = entry.authors.size;
    if (entry.mentions < MIN_RECENT_MENTIONS) return;
    if (authors < MIN_DISTINCT_AUTHORS) return;

    const baselineEntry = baselineCounts.get(entry.term);
    // Remis à l'échelle de la fenêtre réelle : cf. `fetchWindow`.
    const baselineMentions = (baselineEntry ? baselineEntry.mentions : 0) * baseline.scale;
    // Le +1 empêche un terme totalement nouveau d'afficher une accélération
    // infinie et de rafler toutes les places.
    const expected = (baselineMentions / baselineWindows) + 1;
    const acceleration = entry.mentions / expected;

    if (acceleration < MIN_ACCELERATION) return;

    rising.push({
      term: entry.term,
      mentions: entry.mentions,
      authors,
      baselineMentions: Math.round(baselineMentions),
      expected: Math.round(expected * 10) / 10,
      acceleration: Math.round(acceleration * 10) / 10,
    });
  });

  return rising
    .sort((a, b) => (b.acceleration * b.authors) - (a.acceleration * a.authors))
    .slice(0, 15);
}

/**
 * Vecteur moyen des sujets d'un auteur, à partir de ses tweets récents.
 * `null` si le compte n'a pas assez écrit pour qu'on prétende connaître ses thèmes.
 */
async function buildUserTopicProfile(userId) {
  const startDate = new Date(Date.now() - USER_PROFILE_DAYS * 86400000);
  const rows = await queryRead(`
    SELECT t.content
    FROM tweets t
    WHERE t.user_id::text = :userId
      AND t.deleted_at IS NULL
      AND t.parent_tweet_id IS NULL
      AND COALESCE(t.is_retweet, false) = false
      AND t.created_at >= :startDate
      AND CHAR_LENGTH(COALESCE(t.content, '')) >= 20
    ORDER BY t.created_at DESC
    LIMIT :limit
  `, {
    replacements: { userId, startDate, limit: USER_PROFILE_TWEETS },
    type: sequelize.QueryTypes.SELECT,
  });

  if (rows.length < 5) return null;

  const vectors = [];
  for (const row of rows) {
    try {
      const vec = await embed(row.content, 'passage');
      if (vec && vec.length > 0) vectors.push(vec);
    } catch {
      // Un échec d'embedding isolé ne doit pas priver l'auteur de son profil.
    }
  }
  if (vectors.length < 3) return null;

  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  vectors.forEach((v) => {
    for (let i = 0; i < dim; i += 1) centroid[i] += v[i];
  });
  for (let i = 0; i < dim; i += 1) centroid[i] /= vectors.length;

  return {
    centroid,
    sampleSize: vectors.length,
    recentTweets: rows.slice(0, 5).map((r) => r.content),
  };
}

/** Sujets du lot classés par proximité avec les thèmes de l'auteur. */
async function rankTopicsForUser(topics, profile) {
  const scored = [];
  for (const topic of topics) {
    try {
      const vec = await embed(topic.term.replace('#', ''), 'query');
      if (!vec || vec.length === 0) continue;
      const affinity = cosineSimilarity(profile.centroid, vec);
      if (affinity >= MIN_TOPIC_AFFINITY) {
        scored.push({ ...topic, affinity: Math.round(affinity * 1000) / 1000 });
      }
    } catch {
      // Terme non vectorisable : on l'ignore plutôt que d'arrêter le balayage.
    }
  }
  // Le sujet le plus utile combine « ça décolle » et « ça te ressemble ».
  return scored.sort((a, b) => (b.affinity * b.acceleration) - (a.affinity * a.acceleration));
}

/**
 * Rédige l'idée de tweet.
 * Retourne `null` si le moteur n'a rien donné : mieux vaut ne pas notifier que
 * notifier « voici une idée » sans idée dedans.
 */
async function generateTweetIdea(topic, profile) {
  const samples = (profile.recentTweets || []).slice(0, 3);

  const prompt = `Tu aides un créateur d'un réseau social francophone (TwitNinf) à saisir un sujet qui monte.

${codexPlatformContext()}

SITUATION : le sujet "${topic.term}" décolle en ce moment sur la plateforme
(${topic.mentions} mentions en ${RECENT_HOURS}h par ${topic.authors} comptes
différents, soit environ ${topic.acceleration}× son rythme habituel).

VOICI COMMENT CE CRÉATEUR ÉCRIT D'HABITUDE :
${samples.map((s, i) => `${i + 1}. ${JSON.stringify(s.slice(0, 200))}`).join('\n')}

TÂCHE : propose UN tweet qu'il pourrait publier sur ce sujet.

RÈGLES ABSOLUES :
- Écris DANS SA VOIX : même registre, même longueur typique, même niveau de langue.
- N'invente aucun fait, aucune actualité, aucun chiffre. Tu ne sais pas ce qui
  se dit précisément sur ce sujet, seulement qu'il monte. Reste sur un angle
  personnel, une question ou une opinion — jamais une information affirmée.
- 280 caractères maximum.
- Pas plus d'un hashtag.
- "angle" explique en une phrase courte pourquoi cet angle-là.

Réponds UNIQUEMENT avec ce JSON brut, sans backticks ni markdown :
{"idea":"le tweet proposé","angle":"pourquoi cet angle"}`;

  const result = await codex.generateText(prompt, { reasoningEffort: 'low' });
  if (!result.success) return null;

  const parsed = codex.parseJsonLoose(result.text);
  const idea = String(parsed?.idea || '').trim();
  if (!idea || idea.length > 320) return null;

  return { idea, angle: String(parsed?.angle || '').trim() };
}

function codexPlatformContext() {
  // Réutilise le contexte du co-pilote : une seule description de la plateforme
  // à tenir à jour, et les deux fonctionnalités parlent de la même voix.
  return require('./aiCopilotService').PLATFORM_CONTEXT;
}

// ── Anti-spam ──────────────────────────────────────────────────────────────

/** Idées déjà envoyées aujourd'hui à cet abonné. */
async function countIdeasToday(userId) {
  const since = new Date(Date.now() - 86400000);
  const [row] = await queryRead(`
    SELECT COUNT(*)::int AS n
    FROM notifications
    WHERE recipient_id::text = :userId
      AND metadata->>'kind' = :kind
      AND created_at >= :since
  `, {
    replacements: { userId, kind: NOTIFICATION_KIND, since },
    type: sequelize.QueryTypes.SELECT,
  });
  return row?.n || 0;
}

/** Sujets déjà proposés récemment — évite de resservir le même mot chaque jour. */
async function recentlyNotifiedTerms(userId) {
  const since = new Date(Date.now() - TOPIC_COOLDOWN_DAYS * 86400000);
  const rows = await queryRead(`
    SELECT metadata->>'topic' AS topic
    FROM notifications
    WHERE recipient_id::text = :userId
      AND metadata->>'kind' = :kind
      AND created_at >= :since
  `, {
    replacements: { userId, kind: NOTIFICATION_KIND, since },
    type: sequelize.QueryTypes.SELECT,
  });
  return new Set(rows.map((r) => r.topic).filter(Boolean));
}

// ── Balayage ───────────────────────────────────────────────────────────────

/** Abonnés Pro dont l'abonnement est réellement actif. */
async function fetchEligibleUsers() {
  const users = await User.findAll({
    where: { subscription_tier: TIER.PRO, premium: true },
    attributes: ['id', 'username', 'subscription_tier', 'subscription_expires_at', 'premium'],
  });
  return users.filter((u) => isSubscriptionActive(u));
}

/**
 * Un tour complet : détecte les sujets, puis notifie les abonnés concernés.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] calcule tout sans envoyer de notification.
 * @param {string}  [options.onlyUserId] restreint à un compte (test manuel).
 */
async function runRadarSweep(options = {}) {
  const { dryRun = false, onlyUserId = null } = options;
  const startedAt = Date.now();

  try {
    const topics = await detectRisingTopics();
    if (topics.length === 0) {
      logger.info('[TrendRadar] Aucun sujet en accélération sur cette fenêtre.');
      return { topics: [], notified: 0, examined: 0 };
    }

    let users = await fetchEligibleUsers();
    if (onlyUserId) users = users.filter((u) => u.id === onlyUserId);

    logger.info(`[TrendRadar] ${topics.length} sujet(s) en hausse, ${users.length} abonné(s) Pro à examiner.`);

    let notified = 0;
    const results = [];

    for (const user of users) {
      try {
        if (!dryRun && (await countIdeasToday(user.id)) >= MAX_IDEAS_PER_DAY) continue;

        const profile = await buildUserTopicProfile(user.id);
        if (!profile) continue;

        const seen = dryRun ? new Set() : await recentlyNotifiedTerms(user.id);
        const ranked = (await rankTopicsForUser(topics, profile))
          .filter((t) => !seen.has(t.term));
        if (ranked.length === 0) continue;

        const topic = ranked[0];
        const idea = await generateTweetIdea(topic, profile);
        if (!idea) continue;

        results.push({ userId: user.id, username: user.username, topic: topic.term, idea: idea.idea });

        if (!dryRun) {
          await Notification.createNotification({
            recipient_id: user.id,
            type: 'system',
            title: `« ${topic.term} » décolle en ce moment`,
            message: idea.idea,
            priority: 'normal',
            metadata: {
              kind: NOTIFICATION_KIND,
              topic: topic.term,
              acceleration: topic.acceleration,
              mentions: topic.mentions,
              authors: topic.authors,
              affinity: topic.affinity,
              idea: idea.idea,
              angle: idea.angle,
            },
          });
          notified += 1;
        }
      } catch (error) {
        logger.warn(`[TrendRadar] Échec pour @${user.username}: ${error?.message || error}`);
      }
    }

    logger.info(`[TrendRadar] Balayage terminé en ${Date.now() - startedAt}ms — ${notified} notification(s).`);
    return { topics, notified, examined: users.length, results };
  } catch (error) {
    logger.error('[TrendRadar] Balayage en échec:', error);
    return { topics: [], notified: 0, examined: 0, error: error?.message };
  }
}

/**
 * Sujets en hausse pertinents pour un auteur, SANS notifier.
 * Alimente l'onglet « Radar » de l'écran d'analytics prédictifs : l'utilisateur
 * peut venir voir de lui-même, sans attendre qu'on le pousse.
 */
async function getRadarForUser(userId) {
  const topics = await detectRisingTopics();
  if (topics.length === 0) {
    return { hasProfile: true, topics: [], generatedAt: new Date().toISOString() };
  }

  const profile = await buildUserTopicProfile(userId);
  if (!profile) {
    return {
      hasProfile: false,
      topics: [],
      message: 'Publie quelques tweets de plus pour que le radar apprenne tes sujets.',
      generatedAt: new Date().toISOString(),
    };
  }

  const ranked = await rankTopicsForUser(topics, profile);
  return {
    hasProfile: true,
    profileSampleSize: profile.sampleSize,
    topics: ranked.slice(0, 8).map((t) => ({
      term: t.term,
      mentions: t.mentions,
      authors: t.authors,
      acceleration: t.acceleration,
      affinity: t.affinity,
    })),
    windowHours: RECENT_HOURS,
    generatedAt: new Date().toISOString(),
  };
}

// ── Planification ──────────────────────────────────────────────────────────

let timer = null;

/**
 * Démarre le balayage périodique.
 *
 * Volontairement espacé : la fenêtre de détection couvre 12 h, balayer toutes
 * les dix minutes reverrait quinze fois les mêmes sujets pour le même coût CPU
 * (embeddings) et le même quota Codex.
 */
function startScheduler({ intervalMinutes = 180, delayMinutes = 5 } = {}) {
  if (timer) return;
  if (process.env.TREND_RADAR_ENABLED === 'false') {
    logger.info('[TrendRadar] Désactivé par TREND_RADAR_ENABLED=false.');
    return;
  }

  // Départ différé : au démarrage, l'API a mieux à faire que de charger le
  // modèle d'embeddings et de balayer la base.
  setTimeout(() => {
    runRadarSweep().catch(() => { /* déjà journalisé */ });
    timer = setInterval(() => {
      runRadarSweep().catch(() => { /* déjà journalisé */ });
    }, intervalMinutes * 60000);
  }, delayMinutes * 60000);

  logger.info(`[TrendRadar] Planifié toutes les ${intervalMinutes} min (premier tour dans ${delayMinutes} min).`);
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  detectRisingTopics,
  buildUserTopicProfile,
  rankTopicsForUser,
  generateTweetIdea,
  runRadarSweep,
  getRadarForUser,
  startScheduler,
  stopScheduler,
  NOTIFICATION_KIND,
};
