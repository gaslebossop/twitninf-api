/**
 * Routes NeuralRank — Proxy vers le microservice Rust de recommandation.
 *
 * Montage dans server.js : app.use('/api/neural-rank', require('./routes/neuralRankRoutes'))
 *
 * Endpoints :
 *   GET  /api/neural-rank/recommendations          → Feed personnalisé (tweets complets)
 *   POST /api/neural-rank/track                    → Tracker une interaction
 *   GET  /api/neural-rank/health                   → Santé du service Rust
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const rustClient = require('../services/rustRecommenderClient');
const paidContentService = require('../services/paidContentService');
const { sequelize } = require('../database');
const { QueryTypes } = require('sequelize');
const redis = require('redis');
const { engagementTargetSql } = require('../utils/engagementTarget');
const { visibleAuthorSql } = require('../utils/privateAccountVisibility');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Client Redis dédié à NeuralRank pour l'invalidation
let _redisClient;
async function getRedisClient() {
  if (_redisClient && _redisClient.isReady) return _redisClient;
  // Le mot de passe Redis était écrit en dur en repli. Il ne vient plus que de
  // l'environnement — comme partout ailleurs (`config/config.js`,
  // `fraudDetectionService`), qui n'ont jamais eu de repli.
  _redisClient = redis.createClient({
    socket: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    },
    password: process.env.REDIS_PASSWORD || undefined,
  });
  _redisClient.on('error', (e) => logger.warn('[NeuralRank Redis]', e.message));
  await _redisClient.connect();
  return _redisClient;
}

// Fallback vers l'engine JS progressif si le service Rust est down
let ProgressiveEngine;
function getFallbackEngine() {
  if (!ProgressiveEngine) {
    ProgressiveEngine = new (require('../services/progressiveRecommendationEngine'))();
  }
  return ProgressiveEngine;
}

/**
 * Récupère les tweets complets depuis la DB à partir d'une liste d'IDs,
 * en préservant l'ordre Rust et en incluant author + interactions utilisateur.
 */
async function fetchTweetsByIds(tweetIds, userId, experimentAssignments = []) {
  if (!tweetIds || tweetIds.length === 0) return [];
  const assignmentByTweet = new Map(
    (Array.isArray(experimentAssignments) ? experimentAssignments : [])
      .filter(assignment => assignment?.tweet_id && assignment?.variant_id)
      .map(assignment => [String(assignment.tweet_id), assignment]),
  );

  // Les ids viennent du service Rust, mais ils sont interpolés dans le SQL :
  // on n'accepte que des UUID stricts plutôt que de faire confiance à la
  // sortie d'un service tiers.
  const safeIds = tweetIds.filter(id => UUID_RE.test(String(id)));
  if (safeIds.length === 0) return [];
  const idsStr = safeIds.map(id => `'${id}'`).join(',');

  const rows = await sequelize.query(`
    SELECT
      t.id,
      t.content,
      t.created_at,
      t.is_retweet,
      t.is_quote,
      t.parent_tweet_id,
      t.media_urls,
      t.hashtags,
      t.mentions,
      t.tweet_type,
      t.original_tweet_id,
      t.translation_enabled,
      -- Tweet d'origine (les retweets purs ont volontairement content = '')
      ot.id          AS original_id,
      ot.content     AS original_content,
      ot.created_at  AS original_created_at,
      ot.is_retweet  AS original_is_retweet,
      ot.is_quote    AS original_is_quote,
      ot.parent_tweet_id AS original_parent_tweet_id,
      ot.media_urls  AS original_media_urls,
      ot.hashtags    AS original_hashtags,
      ot.mentions    AS original_mentions,
      ot.tweet_type  AS original_tweet_type,
      ot.original_tweet_id AS original_original_tweet_id,
      ot.translation_enabled AS original_translation_enabled,
      -- Tweet parent (pour les réponses recommandées : affichées avec leur contexte)
      pt.id          AS parent_id,
      pt.content     AS parent_content,
      pt.created_at  AS parent_created_at,
      pt.media_urls  AS parent_media_urls,
      -- Auteur
      u.id          AS author_id,
      u.username    AS author_username,
      u.full_name   AS author_full_name,
      u.avatar      AS author_avatar,
      u.verified    AS author_verified,
      u.verification_style AS author_verification_style,
      u.premium     AS author_premium,
      -- Personnalisation : c'est elle qui habille le nom et la pastille dans le
      -- fil. Sans elle ici, chaque carte devrait aller la chercher elle-même.
      u.subscription_tier AS author_subscription_tier,
      u.profile_customization AS author_profile_customization,
      -- Auteur du tweet d'origine
      ou.id          AS original_author_id,
      ou.username    AS original_author_username,
      ou.full_name   AS original_author_full_name,
      ou.avatar      AS original_author_avatar,
      ou.verified    AS original_author_verified,
      ou.verification_style AS original_author_verification_style,
      ou.premium     AS original_author_premium,
      ou.subscription_tier AS original_author_subscription_tier,
      ou.profile_customization AS original_author_profile_customization,
      -- Auteur du tweet parent
      pu.id          AS parent_author_id,
      pu.username    AS parent_author_username,
      pu.full_name   AS parent_author_full_name,
      pu.avatar      AS parent_author_avatar,
      pu.verified    AS parent_author_verified,
      pu.verification_style AS parent_author_verification_style,
      pu.premium     AS parent_author_premium,
      pu.subscription_tier AS parent_author_subscription_tier,
      pu.profile_customization AS parent_author_profile_customization,
      -- Stats agrégées — portées par la cible d'engagement (l'original pour un
      -- retweet pur), jamais par la ligne retweet qui n'a aucun like propre.
      COALESCE((SELECT COUNT(*) FROM tweet_likes    WHERE tweet_id = et.target_id), 0) AS likes_count,
      COALESCE((SELECT COUNT(*) FROM tweet_retweets WHERE tweet_id = et.target_id), 0) AS retweets_count,
      COALESCE((SELECT COUNT(*) FROM tweets         WHERE parent_tweet_id = et.target_id AND deleted_at IS NULL), 0) AS replies_count,
      COALESCE(stt.view_count, t.view_count, 0) AS views_count,
      -- Interactions de l'utilisateur courant — sur la même cible que les
      -- compteurs, sinon le coeur et le nombre affiché se contredisent.
      EXISTS(SELECT 1 FROM tweet_likes    WHERE tweet_id = et.target_id AND user_id = :userId::uuid) AS is_liked,
      EXISTS(SELECT 1 FROM tweet_retweets WHERE tweet_id = et.target_id AND user_id = :userId::uuid) AS is_retweeted
    FROM tweets t
    CROSS JOIN LATERAL (SELECT ${engagementTargetSql('t')} AS target_id) et
    LEFT JOIN tweets stt ON stt.id = et.target_id
    JOIN users u ON u.id = t.user_id
    LEFT JOIN tweets ot
      ON ot.id = t.original_tweet_id
      AND ot.deleted_at IS NULL
      AND ot.moderation_status = 'approved'
      AND ot.is_private = false
    LEFT JOIN users ou ON ou.id = ot.user_id AND ou.is_active = true
    LEFT JOIN tweets pt
      ON pt.id = t.parent_tweet_id
      AND pt.deleted_at IS NULL
      AND pt.moderation_status = 'approved'
      AND pt.is_private = false
    LEFT JOIN users pu ON pu.id = pt.user_id AND pu.is_active = true
    WHERE t.id IN (${idsStr})
      AND t.deleted_at IS NULL
      AND t.moderation_status = 'approved'
      AND t.is_private = false
      -- Comptes privés : le moteur Rust classe des tweets sans rien savoir de
      -- la confidentialité des comptes, c'est donc ici que ça se joue. Le
      -- filtre porte AUSSI sur l'auteur de l'original : sinon il suffisait
      -- qu'un compte public retweete un compte privé pour le rendre lisible de
      -- tous, ce qui vide le réglage de son sens.
      AND ${visibleAuthorSql('u')}
      -- Le cas "ou.id IS NULL" est conservé tel quel : la jointure est déjà
      -- LEFT et filtrée sur is_active, et le code aval sait afficher un retweet
      -- dont l'auteur d'origine a disparu. Sans ce cas, la condition partirait
      -- en NULL et ferait tomber la ligne entière.
      AND (ot.id IS NULL OR ou.id IS NULL OR ${visibleAuthorSql('ou')})
  `, {
    replacements: { userId },
    type: QueryTypes.SELECT,
  });

  // Construire un map id → row
  const byId = {};
  for (const row of rows) {
    byId[row.id] = row;
  }

  // Préserver l'ordre Rust
  const tweets = [];
  for (const id of tweetIds) {
    const row = byId[id];
    if (!row) continue;

    const isRetweet = Boolean(row.is_retweet) || row.tweet_type === 'retweet';
    const originalTweet = row.original_id && row.original_author_id ? {
      id: String(row.original_id),
      content: row.original_content || '',
      created_at: row.original_created_at,
      is_retweet: Boolean(row.original_is_retweet),
      is_quote: Boolean(row.original_is_quote),
      tweet_type: row.original_tweet_type || 'tweet',
      parent_tweet_id: row.original_parent_tweet_id || null,
      original_tweet_id: row.original_original_tweet_id || null,
      media_urls: row.original_media_urls || [],
      hashtags: row.original_hashtags || [],
      mentions: row.original_mentions || [],
      translation_enabled: Boolean(row.original_translation_enabled),
      author: {
        id: String(row.original_author_id),
        username: row.original_author_username,
        full_name: row.original_author_full_name || row.original_author_username,
        avatar: row.original_author_avatar || null,
        verified: Boolean(row.original_author_verified),
        verification_style: row.original_author_verification_style || 'default',
        premium: Boolean(row.original_author_premium),
        subscription_tier: row.original_author_subscription_tier || 'free',
        profile_customization: row.original_author_profile_customization || {},
        stats: {},
      },
    } : null;

    // Un retweet pur n'a pas de contenu propre : sans original exploitable il
    // produirait une carte entièrement vide dans les clients.
    if (isRetweet && !originalTweet) continue;
    if (isRetweet && originalTweet?.parent_tweet_id) continue;

    const isReply = Boolean(row.parent_tweet_id);
    const parentTweet = row.parent_id && row.parent_author_id ? {
      id: String(row.parent_id),
      content: row.parent_content || '',
      created_at: row.parent_created_at,
      media_urls: row.parent_media_urls || [],
      author: {
        id: String(row.parent_author_id),
        username: row.parent_author_username,
        full_name: row.parent_author_full_name || row.parent_author_username,
        avatar: row.parent_author_avatar || null,
        verified: Boolean(row.parent_author_verified),
        verification_style: row.parent_author_verification_style || 'default',
        premium: Boolean(row.parent_author_premium),
        subscription_tier: row.parent_author_subscription_tier || 'free',
        profile_customization: row.parent_author_profile_customization || {},
        stats: {},
      },
    } : null;
    // Une réponse dont le parent est supprimé/privé/non modéré n'a pas de
    // contexte affichable : elle flotterait sans ancrage dans le fil.
    if (isReply && !parentTweet) continue;

    const ownMedia = Array.isArray(row.media_urls) ? row.media_urls : [];
    const originalMedia = Array.isArray(originalTweet?.media_urls) ? originalTweet.media_urls : [];
    const hasRenderableContent = Boolean(String(row.content || '').trim())
      || ownMedia.length > 0
      || Boolean(String(originalTweet?.content || '').trim())
      || originalMedia.length > 0;
    if (!hasRenderableContent) continue;

    const assignment = assignmentByTweet.get(String(row.id));
    tweets.push({
      id: String(row.id),
      content: assignment?.content || row.content || '',
      created_at: row.created_at,
      is_retweet: row.is_retweet || false,
      is_quote: row.is_quote || false,
      tweet_type: row.tweet_type || 'tweet',
      parent_tweet_id: row.parent_tweet_id || null,
      original_tweet_id: row.original_tweet_id || null,
      originalTweet,
      parentTweet,
      media_urls: row.media_urls || [],
      hashtags: row.hashtags || [],
      mentions: row.mentions || [],
      // Sans ce champ, le fil NeuralRank n'affiche jamais la traduction : ce
      // constructeur part d'une ligne SQL, pas d'une instance Sequelize.
      translation_enabled: Boolean(row.translation_enabled),
      author: {
        id: String(row.author_id),
        username: row.author_username,
        full_name: row.author_full_name || row.author_username,
        avatar: row.author_avatar || null,
        verified: row.author_verified || false,
        verification_style: row.author_verification_style || 'default',
        premium: row.author_premium || false,
        subscription_tier: row.author_subscription_tier || 'free',
        profile_customization: row.author_profile_customization || {},
        stats: {},
      },
      stats: {
        likes: Number(row.likes_count),
        retweets: Number(row.retweets_count),
        replies: Number(row.replies_count),
        views: Number(row.views_count),
      },
      user_interaction: {
        is_liked: Boolean(row.is_liked),
        is_retweeted: Boolean(row.is_retweeted),
      },
      ...(assignment ? {
        ab_test: {
          experiment_id: String(assignment.experiment_id),
          variant_id: String(assignment.variant_id),
          variant_label: String(assignment.variant_label || ''),
          status: assignment.status === 'completed' ? 'completed' : 'active',
          is_winner: Boolean(assignment.is_winner),
        },
      } : {}),
    });
  }

  return spaceOutReplies(tweets, 4);
}

/**
 * Réétale les réponses dans le fil pour qu'il n'y en ait jamais plus d'une
 * par bloc de `minGap` tweets (une réponse tous les 4 tweets maximum), tout
 * en conservant l'ordre relatif du scoring Rust pour le reste du fil.
 */
function spaceOutReplies(tweets, minGap = 4) {
  const others = tweets.filter(tweet => !tweet.parent_tweet_id);
  const replies = tweets.filter(tweet => tweet.parent_tweet_id);
  if (!replies.length) return others;

  const merged = [];
  let replyIndex = 0;
  for (let i = 0; i < others.length; i++) {
    merged.push(others[i]);
    if ((i + 1) % minGap === 0 && replyIndex < replies.length) {
      merged.push(replies[replyIndex++]);
    }
  }
  while (replyIndex < replies.length) merged.push(replies[replyIndex++]);
  return merged;
}

/**
 * GET /api/neural-rank/recommendations
 *
 * Query params :
 *   mode    = feed | discover | trending | for_you (défaut: for_you)
 *   limit   = nombre de tweets (défaut: 50, max: 200)
 *   offset  = pagination (défaut: 0)
 */
router.get('/recommendations', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { mode = 'for_you', limit = 50, offset = 0 } = req.query;
  const limitInt = Math.min(parseInt(limit) || 50, 200);
  const offsetInt = parseInt(offset) || 0;

  try {
    const result = await rustClient.getRecommendations(userId, {
      mode,
      limit: limitInt,
      offset: offsetInt,
      enableExperiments: req.headers['x-twitninf-client'] === 'windows-electron',
    });

    logger.info(`[NeuralRank] user=${userId} mode=${mode} count=${result.count} latency=${result.latencyMs}ms cache=${result.cacheHit}`);

    // Hydrater les IDs en tweets complets
    const tweets = await fetchTweetsByIds(result.tweetIds, userId, result.experiments);

    // Contenus payants : ce fil est construit à partir d'IDs classés par le
    // service Rust, qui ne sait rien des verrous. Le masquage se fait donc ici,
    // juste avant l'envoi, comme sur toutes les autres listes.
    if (!(await paidContentService.maskTweetsOrFail(tweets, userId, res))) return;

    return res.json({
      success: true,
      engine: 'rust-neural-rank',
      data: {
        recommendations: tweets,
        count: tweets.length,
        algorithm: result.algorithm,
        latency_ms: result.latencyMs,
        cache_hit: result.cacheHit,
        pagination: {
          limit: limitInt,
          offset: offsetInt,
          hasMore: result.count >= limitInt,
          total: result.count,
        },
      },
    });
  } catch (err) {
    logger.warn(`[NeuralRank] Rust service unavailable (${err.message}), using JS fallback`);

    // Fallback JS
    try {
      const fallback = getFallbackEngine();
      const fallbackResult = await fallback.getProgressiveRecommendations(userId, {
        limit: limitInt,
        offset: offsetInt,
      });
      const recommendations = (fallbackResult.recommendations || []).filter(recommendation => {
        const tweet = recommendation?.tweet || recommendation;
        const type = String(tweet?.tweet_type || tweet?.type || '').toLowerCase();
        const original = tweet?.originalTweet || tweet?.original_tweet || null;
        const isRetweet = Boolean(tweet?.is_retweet) || type === 'retweet';
        const ownMedia = normalizeMediaList(tweet?.media_urls, tweet?.media_url, tweet?.image_url);
        const originalMedia = normalizeMediaList(original?.media_urls, original?.media_url, original?.image_url);
        const renderable = Boolean(String(tweet?.content || '').trim())
          || ownMedia.length > 0
          || Boolean(String(original?.content || '').trim())
          || originalMedia.length > 0;

        // Le moteur de secours ne sait pas vérifier "suivi ou plus de likes
        // que le parent" (pas d'accès au graphe social ici) : par prudence il
        // exclut les réponses plutôt que de les recommander sans filtre.
        return tweet?.parent_tweet_id == null
          && tweet?.parentTweetId == null
          && type !== 'reply'
          && type !== 'comment'
          && (!isRetweet || (original && original?.parent_tweet_id == null))
          && renderable;
      });

      // Le repli sert le même contenu par un autre chemin : il doit passer par
      // le même masquage, sinon une simple panne du service Rust rouvrirait
      // gratuitement tout le contenu vendu.
      if (!(await paidContentService.maskTweetsOrFail(recommendations, userId, res))) return;

      return res.json({
        success: true,
        engine: 'js-progressive-fallback',
        data: {
          recommendations,
          count: recommendations.length,
          pagination: {
            limit: limitInt,
            offset: offsetInt,
            hasMore: false,
            total: recommendations.length,
          },
        },
      });
    } catch (fallbackErr) {
      logger.error(`[NeuralRank] Fallback also failed: ${fallbackErr.message}`);
      return res.status(500).json({ success: false, error: 'Service temporairement indisponible' });
    }
  }
});

/**
 * POST /api/neural-rank/track
 *
 * Body :
 *   tweetId        {number}
 *   interactionType {string}  — 'like', 'comment', 'retweet', 'share', 'view', 'skip', 'report', 'block', 'bookmark'
 *   dwellMs        {number?}  — temps en ms passé sur le contenu
 */
router.post('/track', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { tweetId, interactionType, dwellMs, experimentId, variantId } = req.body;

  if (!tweetId || !interactionType) {
    return res.status(400).json({ success: false, error: 'tweetId et interactionType sont requis' });
  }

  const typeMap = {
    tweet_like: 'like', like: 'like',
    tweet_unlike: 'unlike', unlike: 'unlike',
    tweet_comment: 'comment', comment: 'comment',
    tweet_retweet: 'retweet', retweet: 'retweet',
    tweet_unretweet: 'unretweet', unretweet: 'unretweet',
    tweet_share: 'share', share: 'share',
    tweet_view: 'view', view: 'view',
    tweet_bookmark: 'bookmark', bookmark: 'bookmark',
    profile_view: 'profile_view',
    content_skip: 'skip', skip: 'skip',
    tweet_report: 'report', report: 'report',
    user_block: 'block', block: 'block',
  };

  const mappedType = typeMap[interactionType];
  if (!mappedType) {
    return res.status(400).json({ success: false, error: `Type d'interaction inconnu: ${interactionType}` });
  }

  try {
    const result = await rustClient.trackInteraction(
      userId,
      tweetId,
      mappedType,
      dwellMs || null,
      experimentId && variantId
        ? { experiment_id: experimentId, variant_id: variantId }
        : null,
    );
    return res.json({ success: true, data: result });
  } catch (err) {
    logger.error(`[NeuralRank] Track error: ${err.message}`);
    return res.json({ success: true, data: { tracked: false, reason: 'service_unavailable' } });
  }
});

/**
 * POST /api/neural-rank/on-publish
 *
 * Appelé après la publication d'un tweet.
 * Invalide les caches trending/discover NeuralRank pour que le nouveau tweet
 * apparaisse rapidement dans les fils des autres utilisateurs.
 *
 * Body : { tweetId: string }
 */
router.post('/on-publish', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { tweetId } = req.body;

  logger.info(`[NeuralRank] on-publish user=${userId} tweet=${tweetId}`);

  // Invalider le cache NeuralRank de l'auteur (ses propres recos)
  try {
    await rustClient.invalidateUser(userId);
  } catch { /* non-fatal */ }

  // Invalider les caches trending et discover pour tous les users via Redis
  try {
    const rc = await getRedisClient();
    // SCAN + DEL sur twitninf:reco:*:trending et twitninf:reco:*:discover
    for (const pattern of ['twitninf:reco:*:trending', 'twitninf:reco:*:discover', 'twitninf:reco:*:for_you']) {
      const keys = await rc.keys(pattern);
      if (keys.length > 0) {
        await rc.del(keys);
        logger.info(`[NeuralRank] Invalidated ${keys.length} cache keys for pattern ${pattern}`);
      }
    }
  } catch (redisErr) {
    logger.warn(`[NeuralRank] Redis invalidation failed: ${redisErr.message}`);
  }

  return res.json({ success: true, message: 'Caches NeuralRank invalidés' });
});

/**
 * GET /api/neural-rank/health
 */
router.get('/health', authenticateToken, async (req, res) => {
  const status = await rustClient.healthCheck();
  const code = status.healthy ? 200 : 503;
  return res.status(code).json({ success: true, data: status });
});

module.exports = router;

function normalizeMediaList(...values) {
  const result = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      result.push(...value.filter(Boolean));
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) result.push(...parsed.filter(Boolean));
      else result.push(value);
    } catch {
      result.push(value);
    }
  }
  return result;
}
