const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const axios = require('axios');

// Import des modèles et services
const { Tweet, TweetLike, TweetRetweet, TweetBookmark, User, Notification } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../database');
const { feedCacheRoute } = require('../services/feedCache');
const { processPendingTweet } = require('../services/geminiService');
const semanticSimilarityService = require('../services/semanticSimilarityService');
const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const { checkUserBanStrict, checkUserBanReadOnly } = require('../middleware/banMiddleware');
const { ultraSafeClean } = require('../utils/circularRefCleaner');
const { engagementTargetId, resolveEngagementTarget } = require('../utils/engagementTarget');
const { stripInternalTweetFields } = require('../utils/stripInternalTweetFields');
const { assertTweetLength } = require('../utils/tweetLimits');
const tweetTranslationService = require('../services/tweetTranslationService');
const spotifyService = require('../services/spotifyService');
const paidContentService = require('../services/paidContentService');
const { requireContentAccess, assertAccessible } = require('../middleware/paidContentAccess');
const tweetEditService = require('../services/tweetEditService');
const TweetRecommendationService = require('../services/tweetRecommendationService');
const RealtimeQueueService = require('../services/realtimeQueueService');
const { upload, videoService } = require('../services/videoService');
const { requireFlag } = require('../middleware/featureFlagMiddleware');
const tweetImageService = require('../services/tweetImageService');
const tweetAudioService = require('../services/tweetAudioService');
const ContentQualityService = require('../services/contentQualityService');
const logger = require('../utils/logger');
const { maybeExpireSubscription } = require('../utils/subscriptionHelpers');
const { maybeRenewSuperHearts, isSuperHeartEligible } = require('../utils/superHeartHelpers');

/**
 * Réception des images de tweet. En mémoire puis recompressées : le fichier
 * d'origine n'atteint jamais le disque, donc aucun nettoyage à faire si
 * l'envoi échoue en cours de route.
 */
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: tweetImageService.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!tweetImageService.isAcceptedMimetype(file.mimetype)) {
      return cb(new Error('Format d\'image non pris en charge'));
    }
    cb(null, true);
  },
});

/** Même logique que `imageUpload`, pour les messages vocaux joints à un tweet. */
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: tweetAudioService.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!tweetAudioService.isAcceptedMimetype(file.mimetype)) {
      return cb(new Error('Format audio non pris en charge'));
    }
    cb(null, true);
  },
});

// 🎯 Retargeting hook — batch créé à chaque interaction utilisateur
const retargetingHook = require('../services/retargetingHook');

// 🎯 Import du module de ciblage étendu (chemin absolu pour compatibilité VPS)
let targetingService = null;
try {
  const targetingPath = path.resolve(__dirname, '..', '..', '..', 'targeting');
  const targeting = require(targetingPath);
  targetingService = targeting.targetingService || targeting.default || null;
} catch (e) {
  try {
    // Fallback chemin local (structure IAFILTRE)
    const targeting = require('../../targeting');
    targetingService = targeting.targetingService || null;
  } catch (e2) {
    logger.warn('⚠️ [tweetRoutes] Module targeting non trouvé, injection pub désactivée');
  }
}


// Initialiser les services
const tweetRecommendationService = new TweetRecommendationService();
const realtimeQueueService = new RealtimeQueueService();

// 🚀 Nouveaux moteurs de recommandation (remplacent BERT)
const similarity = require('../services/similarity');
const rustClient = require('../services/rustRecommenderClient');
const videoRecommendationService = require('../services/videoRecommendationService');

// 📊 Tracking CTR pour l'algorithme Rust
const ctrTracker = require('../services/ctrTracker');
const {
  AbTestRequestError,
  normalizeExperimentRequest,
  assertEligible: assertAbTestEligible,
  createExperiment: createAbTestExperiment,
  cancelExperiment: cancelAbTestExperiment,
  moderateAndActivateExperiment,
} = require('../services/tweetAbTestService');

// Middleware de validation des erreurs
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Données invalides',
      errors: errors.array()
    });
  }
  next();
};

/**
 * Écrit un résultat de modération automatique sans pouvoir écraser un verdict
 * communautaire déjà rendu.
 *
 * Le verrou de ligne règle aussi la course entre les deux traitements :
 * - si l'automatisation écrit d'abord, la revue passe ensuite et a le dernier mot ;
 * - si la revue écrit d'abord, l'automatisation voit `community_review.final`
 *   et abandonne sa mise à jour.
 */
async function applyAutomatedTweetUpdate(tweetId, patch) {
  return Tweet.sequelize.transaction(async (tx) => {
    const current = await Tweet.findByPk(tweetId, {
      transaction: tx,
      lock: tx.LOCK.UPDATE,
      paranoid: false,
    });
    if (!current) return null;

    if (current.metadata?.community_review?.final === true) {
      logger.info(
        `[tweetRoutes] résultat automatique ignoré pour ${tweetId} : `
        + `verdict communautaire final « ${current.metadata.community_review.verdict} »`,
      );
      return null;
    }

    const { metadata, ...fields } = patch;
    await current.update({
      ...fields,
      ...(metadata ? { metadata: { ...(current.metadata || {}), ...metadata } } : {}),
    }, { transaction: tx });
    return current;
  });
}

/**
 * Même priorité pour les sanctions de compte automatiques. La lecture du
 * verdict et l'écriture du ban partagent le verrou du tweet avec la revue :
 * aucune suspension automatique ne peut donc arriver après son verdict final.
 */
async function applyAutomaticSuspension(tweetId, userId, buildPatch) {
  return Tweet.sequelize.transaction(async (tx) => {
    const currentTweet = await Tweet.findByPk(tweetId, {
      transaction: tx,
      lock: tx.LOCK.UPDATE,
      paranoid: false,
    });
    if (!currentTweet || currentTweet.metadata?.community_review?.final === true) return null;

    const user = await User.findByPk(userId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!user) return null;

    await user.update(buildPatch(user), { transaction: tx });
    return user;
  });
}

// ========================================
// ROUTES PUBLIQUES (sans authentification)
// ========================================

/**
 * GET /api/tweets
 * Récupérer la liste des tweets publics
 * Authentification optionnelle pour récupérer l'état des likes/retweets de l'utilisateur
 */
router.get('/', [
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  query('type').optional().isIn(['all', 'tweets', 'replies', 'retweets', 'quotes', 'video']).withMessage('Type de tweet invalide'),
  query('sort').optional().isIn(['latest', 'popular', 'trending', 'recommended', 'personalized', 'ultra_recommended', 'similarity']).withMessage('Tri invalide'),
  handleValidationErrors
], authenticateToken,
// Le cache vient APRÈS `authenticateToken` : la clé a besoin de `req.user.id`,
// et surtout une réponse de timeline dépend de qui la demande (comptes privés,
// blocages, contenus payants). Sans utilisateur identifié, le middleware se
// retire de lui-même.
feedCacheRoute('tweets', ['limit', 'offset', 'type', 'sort', 'algorithm', 'context']),
async (req, res) => {
  try {
    const {
      limit = 100,
      offset = 0,
      type = 'all',
      sort = 'latest',
      algorithm = 'ultra_hybrid',
      context = 'discovery'
    } = req.query;

    // 🚀 Utiliser le NOUVEAU moteur de recommandation VIDÉO JS (TikTok-Like)
    if ((sort === 'recommended' || sort === 'personalized' || sort === 'ultra_recommended' || sort === 'similarity') && type === 'video') {
      try {
        const userId = req.user ? String(req.user.id) : null;

        if (userId && videoRecommendationService._initialized) {
          const forceReload = req.query.force_reload === 'true';
          const videoLimit = req.query.limit ? parseInt(req.query.limit) : 2;
          const videoOffset = req.query.offset ? parseInt(req.query.offset) : 0;

          const recommendations = videoRecommendationService.recommend(userId, {
            limit: videoLimit,
            offset: videoOffset,
            forceRefresh: forceReload
          });

          if (recommendations && recommendations.length > 0) {
            const videoIds = recommendations.map(r => r.videoId);

            // Fetcher les vidéos complètes
            const dbVideos = await Tweet.findAll({
              where: { id: { [Op.in]: videoIds }, deleted_at: null, is_data_test: false },
              include: [
                {
                  model: User,
                  as: 'author',
                  attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization'],
                  where: { is_active: true }
                }
              ]
            });

            // Remettre dans l'ordre du moteur et enrichir
            const dbMap = {};
            for (const v of dbVideos) dbMap[v.id] = v;

            // AUDIT R1-07 (2026-08-19) : 6 requêtes par vidéo (jusqu'à 600 si
            // `limit=100`, la validation le permettait) — regroupées comme en
            // R1-01/R1-02, mêmes helpers.
            const preparedVideos = [];
            for (const r of recommendations) {
              const dbVideo = dbMap[r.videoId];
              if (dbVideo) preparedVideos.push({ videoData: dbVideo.toJSON(), vId: String(dbVideo.id), r });
            }

            const videoStatsIds = preparedVideos.map(({ vId }) => vId);
            const [vLikes, vRts, vReplies, vLiked, vRetweeted] = await Promise.all([
              TweetLike.countLikesForTweets(videoStatsIds),
              TweetRetweet.countRetweetsForTweets(videoStatsIds),
              Tweet.countRepliesForTweets(videoStatsIds),
              TweetLike.likedTweetIdsForUser(userId, videoStatsIds),
              TweetRetweet.retweetedTweetIdsForUser(userId, videoStatsIds),
            ]);

            const enrichedVideos = preparedVideos.map(({ videoData, vId, r }) => {
              const lCount = vLikes.get(vId) || 0;
              const rtCount = vRts.get(vId) || 0;
              const repCount = vReplies.get(vId) || 0;
              const isLiked = vLiked.has(vId);
              const isRetweeted = vRetweeted.has(vId);

              // Construct standard tweet structure for the app
              videoData.stats = {
                likes: lCount,
                retweets: rtCount,
                replies: repCount,
                views: videoData.view_count || 0
              };

              videoData.user_interaction = {
                is_liked: isLiked,
                is_retweeted: isRetweeted,
                is_seen: r.is_seen
              };

              // Legacy root-level fields for backward compatibility
              videoData.like_count = lCount;
              videoData.retweet_count = rtCount;
              videoData.reply_count = repCount;
              videoData.is_liked = isLiked;
              videoData.is_retweeted = isRetweeted;
              videoData.ai_score = r.ai_score;
              videoData.primary_signal = r.primary_signal;

              return videoData;
            });

            await paidContentService.maskTweets(enrichedVideos, userId);

            return res.json({
              success: true,
              message: 'Vidéos recommandées via Moteur TikTok-Like JS',
              data: ultraSafeClean({
                tweets: enrichedVideos,
                pagination: {
                  total: enrichedVideos.length,
                  limit: videoLimit,
                  offset: videoOffset,
                  hasMore: recommendations.length === videoLimit
                },
                algorithm: 'tiktok_like_hybrid_js',
                metadata: { pipeline: 'CandidateGen + HybridScore + Diversity + Exploration' }
              })
            });
          }
        }
      } catch (error) {
        logger.error('❌ Erreur moteur vidéo recommendation:', error);
      }
    }

    // 🚀 Utiliser le NOUVEAU moteur de similarité JS pour les TWEETS
    if ((sort === 'recommended' || sort === 'personalized' || sort === 'ultra_recommended' || sort === 'similarity') && type !== 'video') {
      try {
        const engine = similarity.getEngine();
        const userId = req.user ? String(req.user.id) : null;

        if (userId && engine._initialized) {
          logger.info(`✨ [SIMILARITY ENGINE] Recommandations rapides pour ${userId}`);

          // Déterminer le filtre strict de type
          let tweetTypeFilter = null;
          if (type === 'video') tweetTypeFilter = 'video';
          else if (type === 'tweets') tweetTypeFilter = 'tweet';

          // 1. Obtenir les recommandations du moteur en mémoire (< 10ms)
          const recommendations = engine.getRecommendations(userId, parseInt(limit), {
            offset: parseInt(offset),
            tweetType: tweetTypeFilter
          });

          if (recommendations && recommendations.length > 0) {
            const tweetIds = recommendations.map(r => r.tweetId);

            // 2. Fetcher les tweets complets depuis PostgreSQL
            const dbTweets = await Tweet.findAll({
              where: { id: { [Op.in]: tweetIds }, deleted_at: null, is_data_test: false },
              include: [
                {
                  model: User,
                  as: 'author',
                  attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization'],
                  where: { is_active: true }
                },
                {
                  model: Tweet,
                  as: 'originalTweet',
                  include: [{ model: User, as: 'author', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization'] }]
                }
              ]
            });

            // 3. Remettre dans l'ordre exact du moteur et enrichir
            const dbTweetsMap = {};
            for (const t of dbTweets) dbTweetsMap[t.id] = t;

            // AUDIT R1-01 (2026-08-19) : 5 requêtes SÉQUENTIELLES par tweet
            // (≈501 allers-retours pour une page de 100) remplacées par les
            // helpers groupés déjà utilisés en R1-01/ancêtres plus bas dans
            // ce fichier (:834, :898) — même motif, 501 → 6.
            const preparedTweets = [];
            for (const r of recommendations) {
              const dbTweet = dbTweetsMap[r.tweetId];
              if (dbTweet) {
                const tweetData = stripInternalTweetFields(dbTweet.toJSON());

                // Si ce n'est pas une citation ou un retweet, on ne veut pas l'aspect "citation" ou "réponse à" dans le fil
                if (!tweetData.is_quote && !tweetData.is_retweet) {
                  tweetData.originalTweet = null;
                  tweetData.original_tweet_id = null;
                  tweetData.parent_tweet_id = null;
                  tweetData.parentTweet = null;
                }

                preparedTweets.push({ tweetData, r });
              }
            }

            const statsIds = preparedTweets.map(({ tweetData }) => String(engagementTargetId(tweetData)));
            const [likesMap, rtMap, repliesMap, likedSet, rtSet] = await Promise.all([
              TweetLike.countLikesForTweets(statsIds),
              TweetRetweet.countRetweetsForTweets(statsIds),
              Tweet.countRepliesForTweets(statsIds),
              TweetLike.likedTweetIdsForUser(userId, statsIds),
              TweetRetweet.retweetedTweetIdsForUser(userId, statsIds),
            ]);

            const enrichedTweets = preparedTweets.map(({ tweetData, r }) => {
              // Un retweet pur emprunte les compteurs de son original.
              const sId = String(engagementTargetId(tweetData));
              const ownStats = sId === String(tweetData.id);
              const lCount = likesMap.get(sId) || 0;
              const rtCount = rtMap.get(sId) || 0;
              const repCount = repliesMap.get(sId) || 0;
              const iLiked = likedSet.has(sId);
              const iRetweeted = rtSet.has(sId);

              tweetData.stats = {
                likes: lCount,
                retweets: rtCount,
                replies: repCount,
                views: (ownStats ? tweetData.view_count : tweetData.originalTweet?.view_count) || 0
              };

              tweetData.user_interaction = {
                is_liked: iLiked,
                is_retweeted: iRetweeted
              };

              // Champs plats pour compatibilité mobile
              tweetData.like_count = lCount;
              tweetData.retweet_count = rtCount;
              tweetData.reply_count = repCount;
              tweetData.is_liked = iLiked;
              tweetData.is_retweeted = iRetweeted;

              // Inclure les infos de debug (score, freshness, collab, etc.)
              tweetData.ai_score = r.score;
              tweetData.similarity_components = r.components;

              return tweetData;
            });

            // --- 🎯 INJECTION PUBLICITAIRE CIBLÉE I.A ---
            try {
              if (targetingService && targetingService.getRelevantAdsForUser) {
                const activeAds = targetingService.getRelevantAdsForUser(userId, Math.ceil(enrichedTweets.length / 3));
                if (activeAds && activeAds.length > 0) {
                  const uIds = [...new Set(activeAds.map(ad => ad.user_id))];
                  let uMap = {};
                  const adUsers = await User.findAll({
                    where: { id: uIds },
                    attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
                  });
                  adUsers.forEach(u => { uMap[u.id] = u.toJSON(); });

                  let adIndex = 0;
                  for (let i = 2; i < enrichedTweets.length && adIndex < activeAds.length; i += 4) {
                    const ad = activeAds[adIndex];
                    const mediaArray = ad.image_url ? [ad.image_url] : [];
                    const adTweet = {
                      id: `ad-${ad.id}`,
                      is_ad: true,
                      content: ad.text_content || '',
                      media_urls: JSON.stringify(mediaArray),
                      created_at: ad.created_at || new Date().toISOString(),
                      author: uMap[ad.user_id] || { id: ad.user_id, username: 'Sponsorise', full_name: 'Publicité Ciblée', verified: true, verification_style: 'gold' },
                      like_count: 0, retweet_count: 0, reply_count: 0,
                      is_liked: false, is_retweeted: false,
                      stats: { likes: 0, retweets: 0, replies: 0, views: ad.current_views },
                      ad_data: { id: ad.id, max_views: ad.max_views, current_views: ad.current_views, redirect_url: ad.redirect_url || null }
                    };
                    enrichedTweets.splice(i, 0, adTweet);
                    targetingService.recordAdMetric(ad.id, 'view');
                    adIndex++;
                  }
                }
              }
            } catch (e) {
              logger.error('Erreur injection pubs dans similarities:', e);
            }

            await paidContentService.maskTweets(enrichedTweets, userId);

            const safeData = ultraSafeClean({
              tweets: enrichedTweets,
              pagination: { total: enrichedTweets.length, limit: parseInt(limit), offset: parseInt(offset) },
              algorithm: 'fast_similarity_js',
              metadata: { pipeline: 'Content + Collab + Freshness + Discovery', active_ads_injected: true }
            });

            return res.json({
              success: true,
              message: 'Tweets générés par Moteur de Similarité Rapide',
              data: safeData
            });
          }
        }

        // Fallback si moteur pas prêt
        logger.info(`📋 [Fallback] Moteur de similarité non prêt, tweets récents pour ${userId}`);
      } catch (error) {
        logger.error('❌ Erreur moteur similarité:', error);
        logger.info('📋 Fallback vers la méthode classique');
      }
    }

    // Méthode classique pour les autres types de tri
    // Clause WHERE simplifiée pour une meilleure pagination
    let whereClause = {
      is_private: false,
      is_data_test: false,
      deleted_at: null,
      moderation_status: 'approved' // Seulement les tweets approuvés pour la simplicité
    };

    // Filtrer par type
    if (type === 'replies') {
      whereClause = { ...whereClause, parent_tweet_id: { [Op.ne]: null } };
    } else if (type === 'retweets') {
      whereClause = { ...whereClause, is_retweet: true };
    } else if (type === 'quotes') {
      whereClause = { ...whereClause, is_quote: true };
    } else if (type === 'video') {
      whereClause = { ...whereClause, tweet_type: 'video' };
    } else if (type === 'tweets') {
      whereClause = { ...whereClause, parent_tweet_id: null, is_retweet: false, is_quote: false, tweet_type: { [Op.ne]: 'video' } };
    } else {
      // all: originaux OU retweets OU quotes (exclut les réponses)
      whereClause = {
        ...whereClause,
        [Op.or]: [
          { [Op.and]: [{ parent_tweet_id: null }, { is_retweet: false }, { is_quote: false }] },
          { is_retweet: true },
          { is_quote: true }
        ]
      };
    }

    // Définir l'ordre
    let orderClause = [['created_at', 'DESC']];
    if (sort === 'popular') {
      orderClause = [['view_count', 'DESC'], ['created_at', 'DESC']];
    } else if (sort === 'trending') {
      // Logique pour les tweets tendance (basée sur l'engagement récent)
      orderClause = [['created_at', 'DESC']];
    }

    // AUDIT R2-03 (2026-08-19) : le `COUNT(*)` de pagination plus bas portait
    // sur le même prédicat que ce `findAll` — donc juste, mais quasiment la
    // table entière (is_private/is_data_test/deleted_at/moderation_status +
    // le `OR` de type), sur la route la plus appelée de l'API, à chaque
    // page. `limit + 1` donne `hasMore` sans requête supplémentaire ; `total`
    // n'était de toute façon lu par aucun écran côté app (vérifié).
    const requestedLimit = parseInt(limit);
    const rawTweets = await Tweet.findAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization'],
          where: { is_active: true }
        },
        {
          model: Tweet,
          as: 'originalTweet',
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
          }]
        }
      ],
      order: orderClause,
      limit: requestedLimit + 1,
      offset: parseInt(offset)
    });
    const hasMore = rawTweets.length > requestedLimit;
    const tweets = rawTweets.slice(0, requestedLimit);

    // Récupérer l'ID de l'utilisateur connecté (obligatoire maintenant)
    const userId = req.user.id;

    // AUDIT R1-02 (2026-08-19) : ~500 requêtes déferlant d'un coup sur un pool
    // de 10 connexions (5 par tweet × 100), remplacées par les mêmes helpers
    // groupés qu'en R1-01. 501 → 6.
    const preparedTweets = tweets.map((tweet) => {
      const tweetData = stripInternalTweetFields(tweet.toJSON());

      // Si ce n'est pas une citation ou un retweet, on ne veut pas l'aspect "citation" ou "réponse à" dans le fil
      if (!tweetData.is_quote && !tweetData.is_retweet) {
        tweetData.originalTweet = null;
        tweetData.original_tweet_id = null;
        tweetData.parent_tweet_id = null;
        tweetData.parentTweet = null;
      }

      return { tweet, tweetData };
    });

    const classicStatsIds = preparedTweets.map(({ tweetData }) => String(engagementTargetId(tweetData)));
    const [classicLikes, classicRts, classicReplies, classicLiked, classicRetweeted] = await Promise.all([
      TweetLike.countLikesForTweets(classicStatsIds),
      TweetRetweet.countRetweetsForTweets(classicStatsIds),
      Tweet.countRepliesForTweets(classicStatsIds),
      TweetLike.likedTweetIdsForUser(userId, classicStatsIds),
      TweetRetweet.retweetedTweetIdsForUser(userId, classicStatsIds),
    ]);

    const enrichedTweets = preparedTweets.map(({ tweet, tweetData }) => {
      // Un retweet pur ne porte aucun engagement propre : ses compteurs et
      // l'état d'interaction sont ceux du tweet d'origine.
      const statsId = String(engagementTargetId(tweetData));
      const isOwnStats = statsId === String(tweet.id);

      return {
        ...tweetData,
        stats: {
          likes: classicLikes.get(statsId) || 0,
          retweets: classicRts.get(statsId) || 0,
          replies: classicReplies.get(statsId) || 0,
          views: (isOwnStats ? tweet.view_count : tweetData.originalTweet?.view_count) || 0
        },
        user_interaction: {
          is_liked: classicLiked.has(statsId),
          is_retweeted: classicRetweeted.has(statsId)
        }
      };
    });

    // --- 🎯 INJECTION PUBLICITAIRE CIBLÉE I.A CLASSIQUE ---
    try {
      if (targetingService && targetingService.getRelevantAdsForUser) {
        const activeAds = targetingService.getRelevantAdsForUser(userId, Math.ceil(enrichedTweets.length / 3));
        if (activeAds && activeAds.length > 0) {
          const uIds = [...new Set(activeAds.map(ad => ad.user_id))];
          let uMap = {};
          const adUsers = await User.findAll({
            where: { id: uIds },
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
          });
          adUsers.forEach(u => { uMap[u.id] = u.toJSON(); });

          let adIndex = 0;
          for (let i = 2; i < enrichedTweets.length && adIndex < activeAds.length; i += 4) {
            const ad = activeAds[adIndex];
            const mediaArray = ad.image_url ? [ad.image_url] : [];
            const adTweet = {
              id: `ad-${ad.id}`,
              is_ad: true,
              content: ad.text_content || '',
              media_urls: JSON.stringify(mediaArray),
              created_at: ad.created_at || new Date().toISOString(),
              author: uMap[ad.user_id] || { id: ad.user_id, username: 'Sponsorise', full_name: 'Publicité Ciblée', verified: true, verification_style: 'gold' },
              like_count: 0, retweet_count: 0, reply_count: 0,
              is_liked: false, is_retweeted: false,
              stats: { likes: 0, retweets: 0, replies: 0, views: ad.current_views },
              ad_data: { id: ad.id, max_views: ad.max_views, current_views: ad.current_views, redirect_url: ad.redirect_url || null }
            };
            enrichedTweets.splice(i, 0, adTweet);
            targetingService.recordAdMetric(ad.id, 'view');
            adIndex++;
          }
        }
      }
    } catch (e) {
      logger.error('Erreur injection pubs dans classic:', e);
    }

    // Contenus payants : dernière étape avant l'envoi, volontairement.
    // C'est le seul point par lequel passent TOUTES les listes, quel que soit
    // le moteur de recommandation qui les a construites ; masquer plus haut
    // laisserait une branche non couverte, et cette branche servirait alors
    // gratuitement du contenu vendu.
    try {
      await paidContentService.maskTweets(enrichedTweets, userId);
    } catch (e) {
      logger.error('Masquage des contenus payants en échec:', e);
      // On ne sert pas un fil non masqué : mieux vaut une page vide qu'un
      // contenu payant distribué gratuitement.
      return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
    }

    res.json({
      success: true,
      message: 'Tweets récupérés avec succès',
      data: {
        tweets: enrichedTweets,
        pagination: {
          limit: requestedLimit,
          offset: parseInt(offset),
          hasMore
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des tweets:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/tweets/:id
 * Récupérer un tweet spécifique par son ID
 * Authentification requise pour renvoyer l'état d'interaction (is_liked, is_retweeted)
 */
router.get('/:id', [
  authenticateToken,
  param('id').isString().notEmpty().withMessage('ID de tweet invalide'),
  handleValidationErrors
], feedCacheRoute('tweet', ['id']), async (req, res) => {
  try {
    const { id } = req.params;

    // --- INTERCEPTION POUR LES PUBLICITÉS CIBLÉES ---
    if (id.startsWith('ad-')) {
      const adId = id.replace('ad-', '');
      let ad = null;
      if (targetingService && targetingService.getAdById) {
        ad = targetingService.getAdById(adId);
      }

      if (!ad) {
        return res.status(404).json({ success: false, message: 'Publicité non trouvée' });
      }

      const adAuthor = await User.findByPk(ad.user_id, {
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
      });

      const fallbackAuthor = {
        id: ad.user_id,
        username: 'Sponsorise',
        full_name: 'Publicité Ciblée',
        avatar: null,
        verified: true,
        verification_style: 'gold',
        premium: true
      };

      const enrichedTweet = {
        id: id,
        is_ad: true,
        content: ad.text_content || '',
        media_urls: JSON.stringify(ad.image_url ? [ad.image_url] : []),
        created_at: ad.created_at || new Date().toISOString(),
        author: adAuthor ? adAuthor.toJSON() : fallbackAuthor,
        stats: { likes: 0, retweets: 0, replies: 0, views: ad.current_views },
        user_interaction: { is_liked: false, is_retweeted: false },
        replies: [],
        ad_data: { id: ad.id, max_views: ad.max_views, current_views: ad.current_views, redirect_url: ad.redirect_url || null }
      };

      return res.json({ success: true, message: 'Publicité récupérée', data: enrichedTweet });
    }
    // --- FIN INTERCEPTION ---

    const tweet = await Tweet.findOne({
      where: {
        id,
        is_private: false,
        // Exclure les tweets non éligibles aux recommandations
        moderation_status: {
          [Op.notIn]: ['not_eligible', 'rejected']
        }
      },
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
        },
        {
          model: Tweet,
          as: 'parentTweet',
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'profile_customization']
          }]
        },
        {
          model: Tweet,
          as: 'replies',
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'profile_customization']
          }],
          order: [['created_at', 'ASC']],
          limit: 10
        }
      ]
    });

    if (!tweet) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    // Incrémenter le compteur de vues.
    //
    // Volontairement pas attendu : personne ne lit le résultat de cette
    // écriture, et l'attendre ajoutait un aller-retour SQL avant la réponse.
    // Le `catch` est obligatoire — sans lui, un échec deviendrait un rejet de
    // promesse non gérée, qui tue le process sous Node 16+.
    tweet.increment('view_count').catch((err) => {
      logger.warn(`Increment view_count echoue pour ${tweet.id}: ${err.message}`);
    });

    // Enrichir avec statistiques et état d'interaction pour l'utilisateur courant
    const userId = req.user?.id;
    let enrichedTweet = stripInternalTweetFields(tweet.toJSON());

    // Sur un retweet pur, l'engagement appartient au tweet d'origine.
    const statsId = engagementTargetId(enrichedTweet);
    const isOwnStats = statsId === String(tweet.id);

    // Cette route ne charge pas `originalTweet` : on lit le compteur de vues
    // directement en base plutôt que de le déduire d'une relation absente,
    // sinon un retweet affiche 0 vue au lieu de celles de l'original.
    // Ces six lectures sont indépendantes les unes des autres : enchaînées en
    // `await` successifs, elles coûtaient six allers-retours SQL en série
    // avant que la réponse ne parte. En parallèle, c'est le temps de la plus
    // lente.
    const [
      statsViewsRow,
      likeCount,
      retweetCount,
      replyCount,
      isLiked,
      isRetweeted,
    ] = await Promise.all([
      isOwnStats ? null : Tweet.findByPk(statsId, { attributes: ['view_count'] }),
      TweetLike.countTweetLikes(statsId),
      TweetRetweet.countTweetRetweets(statsId),
      Tweet.count({ where: { parent_tweet_id: statsId, is_data_test: false } }),
      userId ? TweetLike.hasUserLikedTweet(userId, statsId) : false,
      userId ? TweetRetweet.hasUserRetweetedTweet(userId, statsId) : false,
    ]);

    const statsViews = isOwnStats
      ? (enrichedTweet.view_count || 0)
      : (statsViewsRow?.view_count || 0);

    enrichedTweet = {
      ...enrichedTweet,
      stats: {
        likes: likeCount,
        retweets: retweetCount,
        replies: replyCount,
        views: statsViews
      },
      user_interaction: {
        is_liked: isLiked,
        is_retweeted: isRetweeted
      }
    };

    // Enrichir sommairement les réponses (statistiques de base + pas d'agrégats lourds).
    //
    // Cinq requêtes par réponse, soit cinquante pour dix réponses, et cinq en
    // série pour chacune. On agrège maintenant les cinq mêmes informations
    // pour toutes les réponses d'un coup : cinq requêtes au total, lancées en
    // parallèle. Le rendu est identique, seul le nombre d'allers-retours change.
    if (Array.isArray(enrichedTweet.replies) && enrichedTweet.replies.length > 0) {
      const replyIds = enrichedTweet.replies.map((r) => String(r.id));

      const [rLikes, rRetweets, rReplies, rLikedByMe, rRetweetedByMe] = await Promise.all([
        TweetLike.countLikesForTweets(replyIds),
        TweetRetweet.countRetweetsForTweets(replyIds),
        Tweet.countRepliesForTweets(replyIds),
        TweetLike.likedTweetIdsForUser(userId, replyIds),
        TweetRetweet.retweetedTweetIdsForUser(userId, replyIds),
      ]);

      enrichedTweet.replies = enrichedTweet.replies.map((reply) => {
        const rid = String(reply.id);
        return {
          ...reply,
          stats: {
            likes: rLikes.get(rid) || 0,
            retweets: rRetweets.get(rid) || 0,
            replies: rReplies.get(rid) || 0,
            views: reply.view_count || 0
          },
          user_interaction: {
            is_liked: rLikedByMe.has(rid),
            is_retweeted: rRetweetedByMe.has(rid)
          }
        };
      });
    }

    // Construire toute la chaine de conversation, de la racine au parent
    // direct. La relation Sequelize `parentTweet` ne contient qu'un niveau :
    // sans cette remontee, ouvrir une reponse isolait le message et cassait la
    // lecture naturelle d'un thread.
    //
    // AUDIT R1-09 (2026-08-19) : l'ancienne version remontait un niveau par
    // aller-retour (jusqu'à 50 `SELECT` strictement séquentiels sur un fil
    // profond). Une CTE récursive ramène en une seule requête la liste
    // ordonnée des identifiants valides — mêmes filtres qu'avant (compte non
    // privé, modération non rejetée) appliqués À CHAQUE NIVEAU de la
    // récursion, donc la remontée s'arrête bien dès qu'un ancêtre échoue à
    // ces filtres, exactement comme le `break` de l'ancienne boucle (les
    // ancêtres au-delà ne sont plus atteignables une fois la chaîne coupée).
    // `depth < 50` reproduit le même garde-fou de profondeur, qui protège
    // aussi contre un cycle de données corrompu.
    let ancestorsData = [];
    const rootParentId = enrichedTweet.parent_tweet_id;

    if (rootParentId) {
      const ancestorIdRows = await sequelize.query(`
        WITH RECURSIVE ancestor_chain AS (
          SELECT id, parent_tweet_id, 1 AS depth
          FROM tweets
          WHERE id = :rootParentId
            AND is_private = false
            AND moderation_status NOT IN ('not_eligible', 'rejected')
          UNION ALL
          SELECT t.id, t.parent_tweet_id, ac.depth + 1
          FROM tweets t
          JOIN ancestor_chain ac ON t.id = ac.parent_tweet_id
          WHERE t.is_private = false
            AND t.moderation_status NOT IN ('not_eligible', 'rejected')
            AND ac.depth < 50
        )
        SELECT id FROM ancestor_chain ORDER BY depth DESC
      `, {
        replacements: { rootParentId: String(rootParentId) },
        type: sequelize.QueryTypes.SELECT
      });

      const orderedIds = ancestorIdRows.map((r) => String(r.id));

      if (orderedIds.length > 0) {
        // Un seul findAll groupé, comme pour les réponses juste au-dessus,
        // puis réordonné en mémoire selon l'ordre racine → parent direct
        // rendu par la CTE (findAll ne garantit pas l'ordre du IN).
        const ancestorInstances = await Tweet.findAll({
          where: { id: orderedIds },
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
          }]
        });
        const ancestorById = new Map(ancestorInstances.map((a) => [String(a.id), a]));
        ancestorsData = orderedIds
          .map((id) => ancestorById.get(id))
          .filter(Boolean)
          .map((a) => stripInternalTweetFields(a.toJSON()));
      }
    }

    // Même regroupement que pour les réponses : cinq requêtes pour toute la
    // chaîne, au lieu de cinq par ancêtre. Sur un fil profond, c'était la
    // seconde source d'allers-retours après les réponses.
    const ancestorStatsIds = ancestorsData.map((a) => String(engagementTargetId(a)));

    if (ancestorsData.length > 0) {
      const [aLikes, aRetweets, aReplies, aLikedByMe, aRetweetedByMe] = await Promise.all([
        TweetLike.countLikesForTweets(ancestorStatsIds),
        TweetRetweet.countRetweetsForTweets(ancestorStatsIds),
        Tweet.countRepliesForTweets(ancestorStatsIds),
        TweetLike.likedTweetIdsForUser(userId, ancestorStatsIds),
        TweetRetweet.retweetedTweetIdsForUser(userId, ancestorStatsIds),
      ]);

      enrichedTweet.thread_ancestors = ancestorsData.map((ancestorData) => {
        const sid = String(engagementTargetId(ancestorData));
        return {
          ...ancestorData,
          stats: {
            likes: aLikes.get(sid) || 0,
            retweets: aRetweets.get(sid) || 0,
            replies: aReplies.get(sid) || 0,
            views: ancestorData.view_count || 0
          },
          user_interaction: {
            is_liked: aLikedByMe.has(sid),
            is_retweeted: aRetweetedByMe.has(sid)
          }
        };
      });
    } else {
      enrichedTweet.thread_ancestors = [];
    }

    // Traduction du fil, jointe a la reponse.
    //
    // L'app la demandait dans un SECOND appel, declenche une fois le tweet
    // affiche : la page se montait en francais puis basculait, d'ou une
    // saccade visible sur tout compte dont la langue de lecture n'est pas la
    // langue source. Un lecteur francophone ne voyait rien, faute de
    // traduction a charger.
    //
    // On renvoie donc directement la traduction du tweet, de ses ancetres et
    // de ses reponses dans la langue du lecteur, en une requete groupee. Le
    // bouton de changement de langue continue de passer par
    // /tweets/:id/translations : il sert a demander UNE AUTRE langue que
    // celle du compte, ce que cette pre-traduction ne couvre pas.
    // La langue de lecture n'est PAS dans le jeton (voir le payload construit
    // par authService) : la lire ici plutot que de l'ajouter au JWT, ou elle
    // resterait figee sur l'ancienne valeur jusqu'a la prochaine connexion.
    const translatableIds = [enrichedTweet, ...(enrichedTweet.thread_ancestors || []), ...(enrichedTweet.replies || [])]
      .filter((t) => t && t.translation_enabled)
      .map((t) => String(t.id));

    if (userId && translatableIds.length > 0) {
      const reader = await User.findByPk(userId, { attributes: ['preferred_language'] });
      const readerLanguage = String(reader?.preferred_language || '').trim().toLowerCase();

      if (readerLanguage) {
        try {
          const translations = await tweetTranslationService.getTranslationsForLanguage(
            translatableIds,
            readerLanguage,
          );
          const attach = (t) => {
            if (t && t.translation_enabled) {
              // `null` explicite et non `undefined` : le client distingue
              // « pas encore traduit » de « rien a traduire », et n'a donc
              // aucune raison de relancer un appel pour un tweet deja traite.
              t.translation = translations[String(t.id)] || null;
            }
            return t;
          };
          attach(enrichedTweet);
          (enrichedTweet.thread_ancestors || []).forEach(attach);
          (enrichedTweet.replies || []).forEach(attach);
          enrichedTweet.translation_language = readerLanguage;
        } catch (err) {
          // Une traduction absente ne doit pas faire echouer l'ouverture d'un
          // tweet : le client retombe sur son appel differe.
          logger.warn(`Traductions non jointes au tweet ${id}: ${err.message}`);
        }
      }
    }

    // Enregistrer la vue pour le CTR tracking (algorithme Rust).
    if (userId && !id.startsWith('ad-')) {
      ctrTracker.trackTweetView(userId, id).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });
    }

    // Contenu payant : le tweet ouvert, ses ancêtres et ses réponses passent
    // par le même masquage. Un fil ouvert sur une réponse afficherait sinon
    // en clair, dans `thread_ancestors`, le tweet verrouillé qui le lance.
    try {
      await paidContentService.maskTweets(
        [enrichedTweet, ...(enrichedTweet.thread_ancestors || []), ...(enrichedTweet.replies || [])],
        userId,
      );
    } catch (e) {
      logger.error('Masquage des contenus payants en échec (détail):', e);
      return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
    }

    // Historique d'édition : joint au tweet pour que la mention « modifié »
    // s'affiche sans second appel — sans elle, l'édition serait invisible.
    try {
      enrichedTweet.edit_info = await tweetEditService.summaryFor(enrichedTweet.id);
    } catch (e) {
      logger.warn(`Historique d'édition non joint au tweet ${id}: ${e.message}`);
    }

    res.json({
      success: true,
      message: 'Tweet récupéré avec succès',
      data: enrichedTweet
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération du tweet:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/tweets/:id/similar
 * Récupérer 3 tweets similaires via le moteur local (Comparaison vectorielle locale)
 * Marche uniquement pour les tweets originaux
 */
router.get('/:id/similar', [
  authenticateToken,
  param('id').isString().notEmpty().withMessage('ID de tweet invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // 1. Vérifier si le tweet existe et est un original
    const sourceTweet = await Tweet.findByPk(id);
    if (!sourceTweet) {
      return res.status(404).json({ success: false, message: 'Tweet source non trouvé' });
    }

    if (sourceTweet.parent_tweet_id) {
      return res.status(400).json({ success: false, message: 'La recherche de similitude est réservée aux tweets originaux' });
    }

    // 2. Récupérer un pool de candidats récents (50 derniers tweets originaux approuvés)
    // ⚠️ Sans `include` sur l'auteur, `tweet.toJSON()` plus bas ne contient
    // aucune clé `author` : côté mobile ça retombait sur les valeurs par
    // défaut ("Utilisateur", @ vide, pas d'avatar) pour CHAQUE tweet similaire.
    const candidates = await Tweet.findAll({
      where: {
        id: { [Op.ne]: id },
        parent_tweet_id: null,
        deleted_at: null,
        moderation_status: 'approved'
      },
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
        }
      ],
      order: [['created_at', 'DESC']],
      limit: 50
    });

    if (candidates.length === 0) {
      return res.json({ success: true, data: [], source: 'none' });
    }

    // 3. Utiliser l'algorithme sémantique ELITE (100% JS / Transformers.js / E5-Base)
    // C'est le même modèle ultra-performant utilisé par PolicierCongo
    logger.info(`🧠 [Similar] Recherche sémantique JS (E5-Base) pour tweet ${id}`);
    const similarTweets = await semanticSimilarityService.getSimilarTweets(sourceTweet, candidates, 3);
    
    let sourceUsed = 'JS_Semantic_E5';
    if (similarTweets.length === 0) {
      // Fallback très léger si pas de match sémantique (prendre les derniers)
      similarTweets.push(...candidates.slice(0, 3));
      sourceUsed = 'JS_Fallback_Recent';
      logger.info(`⚡ [Similar] Aucun match sémantique fort, fallback sur les plus récents`);
    }

    // AUDIT R1-06 (2026-08-19) : 5 requêtes par tweet similaire, en 2 vagues
    // séquentielles — regroupées comme dans le reste du fichier.
    const similarIds = similarTweets.map((tweet) => String(tweet.id));
    const [simLikes, simRts, simReplies, simLiked, simRetweeted] = await Promise.all([
      TweetLike.countLikesForTweets(similarIds),
      TweetRetweet.countRetweetsForTweets(similarIds),
      Tweet.countRepliesForTweets(similarIds),
      TweetLike.likedTweetIdsForUser(userId, similarIds),
      TweetRetweet.retweetedTweetIdsForUser(userId, similarIds),
    ]);

    const enrichedTweets = similarTweets.map((tweet) => {
      const tweetData = tweet.toJSON();
      const tid = String(tweet.id);

      tweetData.stats = {
        likes: simLikes.get(tid) || 0,
        retweets: simRts.get(tid) || 0,
        replies: simReplies.get(tid) || 0,
        views: tweetData.view_count || 0
      };

      tweetData.user_interaction = {
        is_liked: simLiked.has(tid),
        is_retweeted: simRetweeted.has(tid)
      };

      return tweetData;
    });

    const similarPage = enrichedTweets.slice(0, 3);
    if (!(await paidContentService.maskTweetsOrFail(similarPage, userId, res))) return;

    res.json({
      success: true,
      message: `3 tweets similaires récupérés via ${sourceUsed}`,
      source: sourceUsed,
      data: similarPage
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des tweets similaires locaux:', error);
    res.status(500).json({ success: false, message: 'Erreur interne' });
  }
});

// ========================================
// ROUTES PROTÉGÉES (avec authentification)
// ========================================

/**
 * POST /api/tweets/media
 * Envoie une image à joindre à un tweet, et renvoie son URL publique.
 *
 * En deux temps (envoyer l'image, puis publier le tweet qui la référence)
 * plutôt qu'en un seul multipart : l'image part pendant que l'auteur finit
 * d'écrire, la publication reste une requête JSON légère, et un brouillon
 * repris plus tard n'a pas à renvoyer les fichiers déjà transférés.
 *
 * `requireFlag` rend un 404 tant que le drapeau `tweet.images` n'est pas
 * ouvert pour l'appelant : la route existe en production bien avant d'être
 * accessible, et c'est le palier de déploiement qui l'ouvre — sans redéployer.
 */
router.post(
  '/media',
  [authenticateToken, denySuspended, requireFlag('tweet.images'), imageUpload.single('image')],
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Fichier manquant (champ "image")' });
      }

      const url = await tweetImageService.storeUploadedImage(req.file.buffer, req.user.id);
      return res.status(201).json({ success: true, data: { url } });
    } catch (error) {
      logger.error('Erreur upload image de tweet:', error);
      return res.status(500).json({ success: false, message: 'Impossible d\'envoyer cette image' });
    }
  }
);

/**
 * Envoie un message vocal à joindre à un tweet, et renvoie son URL publique.
 * Même découpage en deux temps que `POST /media` pour les images.
 */
router.post(
  '/audio',
  [authenticateToken, denySuspended, audioUpload.single('audio')],
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'Fichier manquant (champ "audio")' });
      }

      const url = await tweetAudioService.storeUploadedAudio(req.file.buffer, req.user.id, req.file.mimetype);
      const duration = tweetAudioService.sanitizeAudioDuration(req.body?.duration);
      return res.status(201).json({ success: true, data: { url, duration } });
    } catch (error) {
      logger.error('Erreur upload message vocal de tweet:', error);
      return res.status(500).json({ success: false, message: 'Impossible d\'envoyer ce message vocal' });
    }
  }
);

/**
 * POST /api/tweets
 * Créer un nouveau tweet
 */
router.post('/', [
  authenticateToken,
  denySuspended,
  // Une image se suffit à elle-même : un tweet sans texte est valide s'il en
  // porte une. Sans cette exception, publier une photo obligerait à écrire
  // quelque chose par-dessus.
  body('content').trim().custom(async (value, meta) => {
    const images = tweetImageService.sanitizeMediaUrls(meta.req.body?.media_urls);
    const audio = tweetAudioService.sanitizeAudioUrl(meta.req.body?.audio_url);
    if (!value && images.length === 0 && !audio) {
      throw new Error('Le contenu ne peut pas être vide');
    }
    return assertTweetLength(value, meta);
  }),
  body('parent_tweet_id').optional().isUUID().withMessage('ID de tweet parent invalide'),
  body('media_urls').optional().isArray().withMessage('Les URLs des médias doivent être un tableau'),
  body('is_private').optional().isBoolean().withMessage('Le statut privé doit être un booléen'),
  body('is_sensitive').optional().isBoolean().withMessage('Le statut sensible doit être un booléen'),
  body('translation_enabled').optional().isBoolean().withMessage('L\'option de traduction doit être un booléen'),
  body('spotify_track').optional().isObject().withMessage('spotify_track doit être un objet'),
  body('audio_url').optional().isString().withMessage('audio_url doit être une chaîne'),
  body('audio_duration').optional().isInt({ min: 1 }).withMessage('audio_duration doit être un entier positif'),
  handleValidationErrors,
  // Répondre à un contenu payant non acheté : la réponse s'afficherait sous
  // un texte que son auteur n'a jamais lu, et le fil de discussion d'un tweet
  // vendu deviendrait le seul endroit où en parler sans l'avoir payé.
  requireContentAccess({ param: null, bodyField: 'parent_tweet_id' }),
], async (req, res) => {
  try {
    // Vérification manuelle du système de ban
    const user = req.user;

    // Vérifier si l'utilisateur est suspendu
    if (user.is_suspended) {
      let message = 'Action non autorisée - ';
      let reason = '';

      message += 'Compte banni';
      reason = user.suspension_reason || 'Violation des conditions d\'utilisation';

      return res.status(403).json({
        success: false,
        message: message,
        ban_info: {
          suspended: user.is_suspended,
          reason: reason,
          suspended_until: user.suspended_until,
          remaining_days: user.suspended_until ? Math.ceil((new Date(user.suspended_until) - new Date()) / (1000 * 60 * 60 * 24)) : null
        }
      });
    }

    const {
      content,
      parent_tweet_id,
      media_urls = [],
      is_private = false,
      is_sensitive = false,
      location,
      language = 'fr',
      ab_test,
      translation_enabled = false,
      spotify_track = null,
      audio_url = null,
      audio_duration = null
    } = req.body;

    const userId = req.user.id;

    // Le client peut envoyer n'importe quoi dans `spotify_track` : on ne
    // garde que la forme attendue, avec des URLs pointant réellement vers
    // Spotify (voir `spotifyService.sanitizeSpotifyTrack`).
    const sanitizedSpotifyTrack = spotify_track ? spotifyService.sanitizeSpotifyTrack(spotify_track) : null;

    // Même raisonnement que pour `media_urls` : seule une URL émise par
    // cette API (via `POST /api/tweets/audio`) entre dans `audio_url`.
    const sanitizedAudioUrl = tweetAudioService.sanitizeAudioUrl(audio_url);
    const sanitizedAudioDuration = sanitizedAudioUrl ? tweetAudioService.sanitizeAudioDuration(audio_duration) : null;

    /**
     * « Traduction (bêta) » : option Pro uniquement. Le palier est revérifié
     * en base (le client peut envoyer n'importe quoi) et un refus est explicite
     * plutôt que silencieux — sinon l'auteur croirait son tweet traduit alors
     * qu'aucune traduction n'existerait jamais.
     */
    let translationEnabled = false;
    if (translation_enabled === true) {
      translationEnabled = await tweetTranslationService.canUseTranslation(req.user);
      if (!translationEnabled) {
        return res.status(403).json({
          success: false,
          message: 'La traduction automatique est réservée aux abonnés Pro actifs.',
          code: 'TRANSLATION_REQUIRES_PRO'
        });
      }
    }
    let experimentRequest = null;
    try {
      experimentRequest = normalizeExperimentRequest(ab_test, content);
      if (experimentRequest) {
        await assertAbTestEligible({
          userId,
          client: req.headers['x-twitninf-client'],
          parentTweetId: parent_tweet_id,
          isPrivate: is_private,
        });
      }
    } catch (abError) {
      if (abError instanceof AbTestRequestError) {
        return res.status(abError.status).json({ success: false, message: abError.message });
      }
      throw abError;
    }

    let original_tweet_id = null;
    let final_tweet_type = 'tweet';

    // Vérifier si c'est une réponse et si le tweet parent existe
    if (parent_tweet_id) {
      const parentTweet = await Tweet.findByPk(parent_tweet_id);
      if (!parentTweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet parent non trouvé'
        });
      }

      // Vérifier si l'utilisateur peut répondre au tweet
      if (parentTweet.is_private && parentTweet.user_id !== userId) {
        return res.status(403).json({
          success: false,
          message: 'Vous ne pouvez pas répondre à ce tweet privé'
        });
      }

      // Propager l'ID original (le haut de la conversation/vidéo)
      original_tweet_id = parentTweet.original_tweet_id || parentTweet.id;
      final_tweet_type = 'reply';

      // 📊 Track comment pour l'algorithme Rust
      ctrTracker.trackComment(userId, parent_tweet_id, null, String(parentTweet.user_id)).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });

      // 🎬 [VideoReco] If reply to a video, notify interaction
      if (parentTweet.tweet_type === 'video') {
        videoRecommendationService.onInteraction(userId, parent_tweet_id, 'comment');
      }
    }

    // Créer le tweet en statut "pending" pour traitement asynchrone
    const creationTransaction = experimentRequest ? await sequelize.transaction() : null;
    let tweet;
    let abExperiment = null;
    try {
      tweet = await Tweet.create({
        content,
        user_id: userId,
        parent_tweet_id,
        original_tweet_id,
        tweet_type: final_tweet_type,
        // Seules les images que cette API a émises entrent ici. Accepter une
        // URL arbitraire ferait charger un serveur tiers à chaque affichage du
        // tweet, ce qui livrerait l'IP et l'heure de lecture de tous ceux qui
        // le croisent. Voir `services/tweetImageService`.
        media_urls: tweetImageService.sanitizeMediaUrls(media_urls),
        is_private,
        is_sensitive,
        location,
        language,
        translation_enabled: translationEnabled,
        spotify_track: sanitizedSpotifyTrack,
        audio_url: sanitizedAudioUrl,
        audio_duration: sanitizedAudioDuration,
        moderation_status: 'pending', // En attente de traitement
        metadata: {
          source: req.userPlatform || 'web',
          device: req.headers['user-agent'] || 'unknown',
          ip_address: req.ip,
          created_at: new Date().toISOString(),
          pending_processing: true,
          ...(experimentRequest ? {
            ab_test: {
              status: 'pending',
              platform_scope: 'windows',
              variant_count: experimentRequest.contents.length,
            },
          } : {}),
        }
      }, creationTransaction ? { transaction: creationTransaction } : undefined);

      if (experimentRequest) {
        abExperiment = await createAbTestExperiment({
          tweetId: tweet.id,
          authorId: userId,
          contents: experimentRequest.contents,
          transaction: creationTransaction,
        });
      }
      if (creationTransaction) await creationTransaction.commit();
    } catch (creationError) {
      if (creationTransaction) await creationTransaction.rollback();
      throw creationError;
    }

    // Récupérer le tweet avec l'auteur
    const tweetWithAuthor = await Tweet.findByPk(tweet.id, {
      include: [{
        model: User,
        as: 'author',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
      }]
    });

    // 🎯 NOUVEAU SYSTÈME DE QUEUE: Ajout à la queue de traitement
    try {
      const TweetQueueService = require('../services/tweetQueueService');
      const tweetQueueService = new TweetQueueService();

      logger.info(`📥 Ajout du nouveau tweet ${tweet.id} à la queue de traitement`);
      await tweetQueueService.addTweetToQueue(tweet.id, userId);

    } catch (error) {
      logger.error(`❌ Erreur lors de l'ajout du tweet à la queue:`, error);
      // Ne pas faire échouer la création du tweet pour cette erreur
    }

    // Traitement asynchrone en arrière-plan (Gemini + PolicierCongo)
    // On lance le traitement sans attendre la réponse pour une meilleure performance
    setImmediate(async () => {
      try {
        const author = await User.findByPk(userId, { attributes: ['username'] });
        if (!author) {
          logger.warn(`Auteur non trouvé pour le tweet ${tweet.id}`);
          return;
        }

        logger.info(`🚀 Lancement du traitement asynchrone pour le tweet ${tweet.id}`);

        // Traiter le tweet avec Gemini + PolicierCongo
        const processResult = await processPendingTweet(
          tweet.id,
          content,
          author.username,
          !!parent_tweet_id
        );

        if (processResult.success) {
          // Le verdict communautaire, s'il existe déjà, reste prioritaire.
          const automatedUpdate = await applyAutomatedTweetUpdate(tweet.id, {
            moderation_status: processResult.moderation_status,
            moderation_reason: processResult.moderation_reason,
            metadata: {
              processing_result: processResult,
              processed_at: processResult.processed_at
            }
          });
          if (!automatedUpdate) {
            if (abExperiment) {
              await cancelAbTestExperiment(abExperiment.id, 'community_verdict_final');
            }
            return;
          }

          if (abExperiment) {
            if (processResult.moderation_status === 'approved') {
              await moderateAndActivateExperiment(abExperiment.id, author.username);
            } else {
              await cancelAbTestExperiment(
                abExperiment.id,
                `control_${processResult.moderation_status || 'not_approved'}`,
              );
            }
          }

          logger.info(`✅ Tweet ${tweet.id} traité avec succès: ${processResult.moderation_status}`);

          // 🌍 Traduction (bêta) — seulement après un verdict « approved » :
          // traduire un tweet rejeté ou non éligible dépenserait du LLM pour un
          // contenu que personne ne verra jamais dans le fil.
          if (translationEnabled && processResult.moderation_status === 'approved') {
            tweetTranslationService.translateTweet(tweet.id).catch((err) => {
              logger.warn(`[translation] Traduction du tweet ${tweet.id} échouée: ${err.message}`);
            });
          }

          // 🎬 [VideoReco] Notify the engine if it's a video
          if (tweet.tweet_type === 'video' && processResult.moderation_status === 'approved') {
            videoRecommendationService.onNewVideo(tweet.id, {
              user_id: userId,
              content: content,
              hashtags: tweet.hashtags
            });
          }

          // Si le tweet est approuvé, l'ajouter automatiquement comme tweet à tester
          if (processResult.moderation_status === 'approved') {
            try {
              // Marquer le tweet comme tweet à tester dans le système progressif
              await applyAutomatedTweetUpdate(tweet.id, {
                recommendation_group: 'initial', // Groupe initial pour test
                view_count: 0, // Commencer à 0 vues
                metadata: {
                  progressive_testing: {
                    added_at: new Date().toISOString(),
                    status: 'testing',
                    group: 'initial',
                    reason: 'Nouveau tweet ajouté automatiquement pour test'
                  }
                }
              });

              const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
              const recommendationEngine = new ProgressiveRecommendationEngine();
              await recommendationEngine.addNewTweet(tweet.id);
              logger.info(`🧪 Tweet ${tweet.id} ajouté automatiquement comme tweet à tester (groupe initial)`);
            } catch (recError) {
              logger.error(`❌ Erreur lors de l'ajout du tweet ${tweet.id} au système de test:`, recError);
            }
          }

          // Gérer les notifications selon le résultat
          if (processResult.moderation_status === 'rejected') {
            await handleRejectedTweet(tweet, userId, processResult);

            // 📢 Notification pour tweet rejeté
            try {
              await Notification.createNotification({
                recipient_id: userId,
                sender_id: userId,
                tweet_id: tweet.id,
                type: 'system',
                title: 'Tweet rejeté',
                message: 'Votre tweet a été rejeté pour violation des règles.',
                content: {
                  reason: processResult.gemini_result?.reason || null,
                  score: processResult.gemini_result?.score || null,
                  decision: 'ban'
                },
                priority: 'high',
              });
              logger.info(`📢 Notification créée pour tweet rejeté ${tweet.id}`);
            } catch (notifError) {
              logger.error(`❌ Erreur lors de la création de la notification pour tweet rejeté ${tweet.id}:`, notifError);
            }

            // 🚨 BAN AUTOMATIQUE si Gemini dit "ban"
            if (processResult.gemini_result?.decision === 'ban') {
              try {
                const user = await applyAutomaticSuspension(tweet.id, userId, (currentUser) => {
                  const oneWeekFromNow = new Date();
                  oneWeekFromNow.setDate(oneWeekFromNow.getDate() + 7);
                  return {
                    is_suspended: true,
                    suspended_at: new Date(),
                    suspended_until: oneWeekFromNow,
                    suspension_reason: `Ban automatique: ${processResult.gemini_result.reason || 'Contenu interdit'}`,
                    suspension_meta: {
                      ...(currentUser.suspension_meta || {}),
                      auto_ban: true,
                      gemini_decision: 'ban',
                      tweet_id: tweet.id
                    }
                  };
                });
                if (user) {
                  logger.info(`🚨 BAN AUTOMATIQUE pour @${user.username}`);
                  logger.info(`🔒 UTILISATEUR @${user.username} BANNI POUR 1 SEMAINE`);
                } else {
                  logger.info(
                    `[tweetRoutes] ban automatique ignoré pour ${tweet.id} : `
                    + 'verdict communautaire final déjà rendu',
                  );
                }
              } catch (banError) {
                logger.error(`❌ Erreur lors du ban automatique pour l'utilisateur ${userId}:`, banError);
              }
            }

          } else if (processResult.moderation_status === 'not_eligible') {
            // Tweet non éligible aux recommandations mais visible sur le profil
            logger.info(`⚠️ Tweet ${tweet.id} marqué comme non éligible aux recommandations`);

            // 📢 Notification pour l'utilisateur
            try {
              await Notification.createNotification({
                recipient_id: userId,
                sender_id: userId,
                tweet_id: tweet.id,
                type: 'system',
                title: 'Tweet non éligible aux recommandations',
                message: 'Votre tweet n\'est pas éligible aux recommandations.',
                content: {
                  reason: processResult.gemini_result?.reason || null,
                  score: processResult.gemini_result?.score || null,
                  decision: 'not_eligible'
                },
                priority: 'low',
              });
              logger.info(`📢 Notification créée pour tweet non éligible ${tweet.id}`);
            } catch (notifError) {
              logger.error(`❌ Erreur lors de la création de la notification pour tweet non éligible ${tweet.id}:`, notifError);
            }

            // Inscription au registre qualité du compte. Jusqu'ici, un tweet
            // écarté des recommandations n'avait AUCUNE conséquence : on
            // pouvait en accumuler indéfiniment. Le premier cas ne coûte
            // toujours rien de plus que la notification ci-dessus ; c'est la
            // récidive sous 14 jours qui réduit temporairement la portée.
            // Voir `services/contentQualityService.js`.
            try {
              await ContentQualityService.record({
                userId,
                tweetId: tweet.id,
                kind: ContentQualityService.KIND.NOT_ELIGIBLE,
                reason: processResult.gemini_result?.reason || null,
                metadata: { score: processResult.gemini_result?.score ?? null },
              });
            } catch (qualityError) {
              logger.warn(`[contentQuality] non-éligibilité ${tweet.id} non enregistrée: ${qualityError.message}`);
            }

          } else if (processResult.moderation_status === 'approved') {
            await handleApprovedTweet(tweet, userId, processResult);
            // 🔔 Notifier tous les abonnés (followers) de l'auteur, 1 notif max par token
            try {
              // Uniquement pour les tweets originaux (pas de réponses/retweets/quotes)
              const isOriginalTweet = !tweet.parent_tweet_id && !tweet.is_retweet && !tweet.is_quote;
              if (!isOriginalTweet) {
                logger.info(`Fanout followers ignoré (non original): tweet ${tweet.id}`);
              } else {
                // AUDIT R3-07 (2026-08-19) : l'ancienne version chargeait TOUS
                // les abonnés en mémoire (aucune limite), rechargeait leurs
                // profils via un `IN (...)` de la même taille, puis créait
                // une notification PAR ABONNÉ en série (`await` dans un
                // `for`, chacune rouvrant en plus une lecture de l'abonné
                // pour son push). À 200 000 abonnés : ~200 000 lignes lues
                // deux fois, ~200 000 `INSERT` l'un après l'autre — plus
                // d'une heure, une connexion du pool occupée du début à la
                // fin. Le `SELECT DISTINCT ON` fait en une requête la
                // jointure et la déduplication par token (même sémantique
                // qu'avant : un seul destinataire retenu par token
                // identique, les abonnés sans token enregistré sont
                // ignorés), et un unique `bulkCreate` remplace la boucle
                // d'`INSERT`.
                const recipientRows = await sequelize.query(`
                  SELECT DISTINCT ON (u.id_notif) uf.follower_id AS recipient_id, u.id_notif
                  FROM user_follows uf
                  JOIN users u ON u.id = uf.follower_id
                  WHERE uf.following_id = :authorId
                    AND uf.status = 'active'
                    AND u.id_notif IS NOT NULL
                  ORDER BY u.id_notif, uf.follower_id
                `, {
                  replacements: { authorId: String(userId) },
                  type: sequelize.QueryTypes.SELECT
                });

                if (recipientRows.length > 0) {
                  const fanoutTitle = `@${author.username} a publié un nouveau tweet`;
                  const now = new Date();
                  await Notification.bulkCreate(recipientRows.map((r) => ({
                    recipient_id: r.recipient_id,
                    sender_id: userId,
                    tweet_id: tweet.id,
                    type: 'system',
                    title: fanoutTitle,
                    message: 'Nouveau tweet',
                    created_at: now,
                    updated_at: now
                  })));

                  // Push envoyés par lots de 100 (limite documentée de l'API
                  // Expo pour un body en tableau) au lieu d'un appel réseau
                  // par abonné — le seul rapport gain/effort qui vaille la
                  // peine ici sans introduire de file d'attente externe.
                  for (let i = 0; i < recipientRows.length; i += 100) {
                    const chunk = recipientRows.slice(i, i + 100);
                    try {
                      await axios.post('https://exp.host/--/api/v2/push/send', chunk.map((r) => ({
                        to: r.id_notif,
                        sound: 'default',
                        title: fanoutTitle,
                        body: 'Nouveau tweet',
                        data: { type: 'system', tweet_id: tweet.id, sender_id: userId }
                      })), {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 5000
                      });
                    } catch (pushError) {
                      logger.warn('Envoi push par lot (fanout followers) échoué:', pushError?.message || pushError);
                    }
                  }
                }
              }
            } catch (fanoutError) {
              logger.warn('Fanout notifications followers échoué:', fanoutError?.message || fanoutError);
            }
          }

          // Gérer la réponse policier si nécessaire
          if (processResult.police_response?.success) {
            await handlePoliceResponse(tweet, userId, processResult.police_response);
          }

        } else {
          if (abExperiment) {
            await cancelAbTestExperiment(abExperiment.id, 'control_moderation_failed');
          }
          logger.error(`❌ Échec du traitement du tweet ${tweet.id}:`, processResult.error);
          // Fallback: approuver le tweet en cas d'erreur
          await applyAutomatedTweetUpdate(tweet.id, {
            moderation_status: 'approved',
            metadata: {
              processing_error: processResult.error,
              processed_at: processResult.processed_at
            }
          });
        }
      } catch (error) {
        if (abExperiment) {
          await cancelAbTestExperiment(abExperiment.id, 'processing_error').catch(() => {});
        }
        logger.error(`❌ Erreur lors du traitement asynchrone du tweet ${tweet.id}:`, error);
        // Fallback: approuver le tweet en cas d'erreur
        await applyAutomatedTweetUpdate(tweet.id, {
          moderation_status: 'approved',
          metadata: {
            processing_error: error.message,
            processed_at: new Date().toISOString()
          }
        });
      }
    });



    // Créer des notifications pour les mentions
    if (tweet.mentions && tweet.mentions.length > 0) {
      for (const mention of tweet.mentions) {
        const mentionedUser = await User.findOne({
          where: { username: mention.substring(1) } // Enlever le @
        });

        if (mentionedUser && mentionedUser.id !== userId) {
          await Notification.createMentionNotification(
            userId,
            tweet.id,
            mentionedUser.id
          );
        }
      }
    }

    // Créer une notification de réponse si c'est une réponse
    if (parent_tweet_id) {
      const parentTweet = await Tweet.findByPk(parent_tweet_id);
      if (parentTweet && parentTweet.user_id !== userId) {
        await Notification.createReplyNotification(
          userId,
          tweet.id,
          parent_tweet_id,
          parentTweet.user_id
        );
      }

      // Mettre à jour la queue en temps réel pour le tweet parent (nouvelle réponse)
      await realtimeQueueService.updateRepliesRealtime(parent_tweet_id, userId);
    }

    logger.info(`Nouveau tweet créé: ${tweet.id} par l'utilisateur ${userId}`);

    // 🎯 RETARGETING & SIMILARITY
    if (parent_tweet_id) {
      // C'est une réponse/comment : on track sur le tweet PARENT
      retargetingHook.trackComment({
        userId: String(userId),
        tweetId: String(parent_tweet_id),
        tweetContent: content || '',
        authorUsername: '',
        mediaUrls: tweet.media_urls || []
      });
      // Similarité
      similarity.getEngine().onInteraction(String(userId), String(parent_tweet_id), 'comment', content || '');
    } else {
      // C'est un tweet original
      retargetingHook.trackPost({
        userId: String(userId),
        tweetId: String(tweet.id),
        tweetContent: content || '',
        mediaUrls: tweet.media_urls || []
      });
      // Similarité
      similarity.getEngine().onNewTweet(String(tweet.id), String(userId), content || '', tweet.media_urls || [], tweet.parent_tweet_id);
    }

    // Rafale de publication : un post isolé ne déclenche rien, seul le
    // rythme compte — la décision (10 tweets / 10 min) se prend côté Rust,
    // voir `rustRecommenderClient.recordPostForVelocity`. Fire-and-forget :
    // ne doit jamais retarder ni faire échouer la publication elle-même.
    rustClient.recordPostForVelocity(String(userId));

    // Embedding sémantique — alimente la nouvelle source de candidats par
    // similarité de contenu (voir rust-recommender/src/embeddings.rs).
    // Fire-and-forget, même raison que ci-dessus.
    rustClient.embedTweet(String(tweet.id), content || '');

    res.status(201).json({
      success: true,
      message: 'Tweet créé avec succès',
      data: abExperiment ? {
        ...tweetWithAuthor.toJSON(),
        ab_test: {
          experiment_id: abExperiment.id,
          status: 'pending',
          variant_count: abExperiment.variants.length,
        },
      } : tweetWithAuthor
    });

  } catch (error) {
    logger.error('Erreur lors de la création du tweet:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/tweets/video
 * Uploader une vidéo (limite 1 minute, compressée via FFMPEG)
 */
router.post('/video', authenticateToken, denySuspended, (req, res, next) => {
  // On laisse Multer gérer le stream entièrement pour éviter les conflits
  // La progression d'upload est déjà gérée côté mobile via XHR.upload.onprogress
  next();
}, upload.single('video'), async (req, res) => {
  try {
    const user = req.user;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Aucun fichier vidéo fourni.' });
    }

    const {
      content = '',
      is_private = false,
      language = 'fr',
      overlay_texts,
      uploadId: uploadSessionId // On essaye de le choper aussi dans le body
    } = req.body;

    const userId = user.id;
    const { v4: uuidv4 } = require('uuid');
    const videoId = uuidv4();

    // Étape 1 : Créer le tweet immédiatement en statut 'pending'
    const tweet = await Tweet.create({
      id: videoId,
      content: content,
      user_id: userId,
      tweet_type: 'video',
      media_urls: [],
      moderation_status: 'pending', // 'pending' est le status ENUM autorisé en DB
      language,
      metadata: {
        source: req.userPlatform || 'web',
        device: req.headers['user-agent'] || 'unknown',
        ip_address: req.ip,
        created_at: new Date().toISOString(),
        video_processing_status: 'processing',
        overlay_texts: overlay_texts ? (typeof overlay_texts === 'string' ? JSON.parse(overlay_texts) : overlay_texts) : []
      }
    });

    // Étape 2 : Répondre au client immédiatement (202 Accepted)
    res.status(202).json({
      success: true,
      message: 'Vidéo reçue, compression en cours...',
      data: {
        id: tweet.id,
        moderation_status: 'pending'
      }
    });

    // Identifiant unique pour le salon socket (priorité à l'id passé en query/body)
    const socketRoomId = req.query.uploadId || uploadSessionId || videoId;

    /**
     * Habillage demandé par l'app : textes incrustés, étalonnage, coupure du
     * son. Il est appliqué pendant le transcodage déjà prévu — le téléphone
     * envoie la vidéo BRUTE et une description de l'habillage, jamais une
     * vidéo déjà réencodée, qui subirait ici une seconde compression.
     *
     * Les champs arrivent en multipart, donc en chaînes : `videoEditService`
     * s'occupe de les interpréter et de refuser ce qui n'a pas de sens.
     */
    const editSpec = {
      muted: req.body.muted,
      filter: req.body.filter,
      overlays: req.body.overlays,
    };
    const hasEdit = editSpec.muted !== undefined
      || editSpec.filter !== undefined
      || editSpec.overlays !== undefined;

    // Étape 3 : Traitement en arrière-plan (Compression + Thumbnail)
    setImmediate(async () => {
      try {
        logger.info(`🎞️ [Background] Début compression vidéo pour ${videoId}`);
        const processResult = await videoService.processVideo(
          req.file.path,
          videoId,
          socketRoomId,
          hasEdit ? editSpec : null,
        );

        if (!processResult || !processResult.publicUrl) {
          throw new Error('Échec du traitement vidéo.');
        }

        // Mettre à jour le tweet avec les URLs finales et status approuvé
        await tweet.update({
          media_urls: [processResult.publicUrl, processResult.publicThumbnailUrl].filter(Boolean),
          moderation_status: 'approved',
          metadata: {
            ...tweet.metadata,
            video_processing_status: 'ready',
            video_processing_percent: 100,
            video_info: {
              duration: processResult.duration
            }
          }
        });

        // Notifications et Recommandations
        try {
          similarity.getEngine().onNewTweet(String(tweet.id), String(userId), content, tweet.media_urls, null, null, 'video');
          videoRecommendationService.onNewVideo(tweet.id, { user_id: userId, content: content, hashtags: tweet.hashtags });

          const io = req.app.get('io');
          if (io) {
            io.to(`video_upload_${socketRoomId}`).emit('video_ready', { tweetId: tweet.id, media_urls: tweet.media_urls });
          }
        } catch (err) {
          logger.error('Erreur integration post-compression:', err);
        }

        logger.info(`✅ [Background] Vidéo ${videoId} prête.`);

      } catch (error) {
        logger.error(`❌ [Background] Erreur traitement vidéo ${videoId}:`, error);
        await tweet.update({ moderation_status: 'rejected', moderation_reason: error.message });

        const io = req.app.get('io');
        if (io) {
          io.to(`video_upload_${socketRoomId}`).emit('video_error', { tweetId: tweet.id, message: error.message });
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de l\'upload de la vidéo:', error);
    // Cleanup if possible? Usually handled in service.
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur interne du serveur lors de l\'upload.'
    });
  }
});


/**
 * PUT /api/tweets/:id
 * Mettre à jour un tweet
 */
router.put('/:id', [
  authenticateToken,
  param('id').isUUID().withMessage('ID de tweet invalide'),
  body('content').trim().isLength({ min: 1 }).withMessage('Le contenu ne peut pas être vide')
    .custom(assertTweetLength),
  body('media_urls').optional().isArray().withMessage('Les URLs des médias doivent être un tableau'),
  body('is_private').optional().isBoolean().withMessage('Le statut privé doit être un booléen'),
  body('is_sensitive').optional().isBoolean().withMessage('Le statut sensible doit être un booléen'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const {
      content,
      media_urls,
      is_private,
      is_sensitive
    } = req.body;

    // Récupérer le tweet
    const tweet = await Tweet.findByPk(id);
    if (!tweet) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    // Vérifier que l'utilisateur est l'auteur du tweet
    if (tweet.user_id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Vous n\'êtes pas autorisé à modifier ce tweet'
      });
    }

    // Le CONTENU passe par le service d'édition : abonnement actif, fenêtre
    // de 30 minutes, historique public. Cette route réécrivait auparavant le
    // texte de n'importe quel tweet, à n'importe quel âge, sans laisser de
    // trace — un tweet vieux de six mois pouvait devenir autre chose en
    // gardant ses retweets et ses réponses.
    //
    // Les autres champs (médias, confidentialité, sensibilité) restent libres :
    // ils ne changent pas ce que le tweet DIT, et les restreindre reviendrait
    // à faire payer le fait de masquer une image mal cadrée.
    if (typeof content === 'string' && content !== tweet.content) {
      try {
        await tweetEditService.applyEdit({
          tweetId: tweet.id,
          editorId: userId,
          newContent: content,
        });
      } catch (error) {
        if (error instanceof tweetEditService.TweetEditError) {
          const status = error.code === 'subscription_required' ? 403
            : error.code === 'not_found' ? 404
              : error.code === 'forbidden' ? 403 : 400;
          return res.status(status).json({
            success: false,
            message: error.message,
            code: error.code,
          });
        }
        throw error;
      }
    }

    await tweet.update({
      media_urls,
      is_private,
      is_sensitive
    });

    // Récupérer le tweet mis à jour avec l'auteur
    const updatedTweet = await Tweet.findByPk(id, {
      include: [{
        model: User,
        as: 'author',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
      }]
    });

    logger.info(`Tweet mis à jour: ${id} par l'utilisateur ${userId}`);

    res.json({
      success: true,
      message: 'Tweet mis à jour avec succès',
      data: updatedTweet
    });

  } catch (error) {
    logger.error('Erreur lors de la mise à jour du tweet:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/tweets/:id/edit-history
 * Historique des modifications — PUBLIC, et c'est le point.
 *
 * Une édition consultable par tous est une correction ; une édition
 * silencieuse est une réécriture. C'est cette route qui fait la différence
 * entre les deux, donc elle n'est pas réservée à l'auteur.
 */
router.get('/:id/edit-history', [
  authenticateToken,
  param('id').isUUID().withMessage('ID de tweet invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const history = await tweetEditService.historyFor(req.params.id);
    res.json({ success: true, data: { revisions: history } });
  } catch (error) {
    logger.error('Erreur historique d\'édition:', error);
    res.status(500).json({ success: false, message: 'Historique indisponible' });
  }
});

/**
 * GET /api/tweets/:id/editability
 * L'auteur peut-il encore modifier, et combien de temps lui reste-t-il.
 * Sert à afficher le compte à rebours plutôt qu'un bouton qui échoue.
 */
router.get('/:id/editability', [
  authenticateToken,
  param('id').isUUID().withMessage('ID de tweet invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const tweet = await Tweet.findByPk(req.params.id, {
      attributes: ['id', 'user_id', 'created_at']
    });
    if (!tweet) {
      return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    }
    if (String(tweet.user_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Ce tweet n\'est pas le tien' });
    }
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at']
    });
    res.json({ success: true, data: await tweetEditService.editabilityFor(tweet, user) });
  } catch (error) {
    logger.error('Erreur état d\'édition:', error);
    res.status(500).json({ success: false, message: 'État d\'édition indisponible' });
  }
});

/**
 * DELETE /api/tweets/:id
 * Supprimer un tweet
 */
router.delete('/:id', [
  authenticateToken,
  param('id').isUUID().withMessage('ID de tweet invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Récupérer le tweet
    const tweet = await Tweet.findByPk(id);
    if (!tweet) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    // Vérifier que l'utilisateur est l'auteur du tweet
    if (tweet.user_id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Vous n\'êtes pas autorisé à supprimer ce tweet'
      });
    }

    // Supprimer le tweet (soft delete)
    await tweet.destroy();

    logger.info(`Tweet supprimé: ${id} par l'utilisateur ${userId}`);

    // Frein de vélocité (1h, ×0.5) — supprimer un tweet est légitime la
    // plupart du temps, mais c'est aussi le geste d'un nettoyage après coup.
    // Fire-and-forget, ne doit jamais retarder la réponse.
    rustClient.triggerVelocityThrottle(String(userId), 'tweet_delete');

    res.json({
      success: true,
      message: 'Tweet supprimé avec succès'
    });

  } catch (error) {
    logger.error('Erreur lors de la suppression du tweet:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/tweets/:id/like
 * Liker/Unliker un tweet
 */
router.post('/:id/like', [
  authenticateToken,
  checkUserBanStrict, // Vérifier que l'utilisateur n'est pas banni
  param('id').isUUID().withMessage('ID de tweet invalide'),
  handleValidationErrors,
  // Aimer un texte qu'on n'a pas pu lire n'a pas de sens, et le compteur
  // servirait de preuve sociale à un contenu que personne n'a acheté.
  requireContentAccess(),
], async (req, res) => {
  try {
    const userId = req.user.id;

    // Un like posé sur un retweet appartient au tweet d'origine : les
    // compteurs affichés sont ceux de l'original, l'écriture doit donc viser
    // la même ligne sous peine de ne jamais faire bouger le nombre affiché.
    const { tweet: requested, targetTweet: tweet, targetId: id } =
      await resolveEngagementTarget(Tweet, req.params.id);
    if (!requested) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    // Vérifier si l'utilisateur a déjà liké le tweet
    const existingLike = await TweetLike.findOne({
      where: {
        tweet_id: id,
        user_id: userId
      }
    });

    if (existingLike) {
      // Unliker le tweet
      await existingLike.destroy();

      // 📊 Track unlike pour l'algorithme Rust
      ctrTracker.trackUnlike(userId, id, String(tweet.user_id)).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });

      // Mettre à jour la queue en temps réel (unlike)
      await realtimeQueueService.decrementLikesRealtime(id, userId);
      await realtimeQueueService.syncTweetInteractions(id);

      // 🎬 [VideoReco] Real-time engine sync (unlike)
      if (tweet.tweet_type === 'video') {
        videoRecommendationService.offInteraction(String(userId), String(id), 'like');
      }

      logger.info(`Like supprimé: utilisateur ${userId} a unliké le tweet ${id}`);

      res.json({
        success: true,
        message: 'Like supprimé avec succès',
        data: { liked: false }
      });
    } else {
      // Liker le tweet
      const like = await TweetLike.create({
        tweet_id: id,
        user_id: userId,
        metadata: {
          source: req.userPlatform || 'web',
          device: req.headers['user-agent'] || 'unknown',
          ip_address: req.ip
        }
      });

      // 📊 Enregistrer l'action pour le CTR tracking (algorithme Rust)
      ctrTracker.trackTweetLike(userId, id, String(tweet.user_id)).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });

      // Créer une notification de like
      if (tweet.user_id !== userId) {
        await Notification.createLikeNotification(
          userId,
          id,
          tweet.user_id
        );
      }

      // Mettre à jour la queue en temps réel (like)
      await realtimeQueueService.updateLikesRealtime(id, userId);

      logger.info(`Like créé: utilisateur ${userId} a liké le tweet ${id}`);

      // 🎯 RETARGETING & SIMILARITY
      {
        const tweetAuthor = tweet.author || await User.findByPk(tweet.user_id, { attributes: ['username'] }).catch(() => null);
        retargetingHook.trackLike({
          userId: String(userId),
          tweetId: String(id),
          tweetContent: tweet.content || '',
          authorUsername: tweetAuthor?.username || '',
          mediaUrls: Array.isArray(tweet.media_urls) ? tweet.media_urls : []
        });

        similarity.getEngine().onInteraction(String(userId), String(id), 'like', tweet.content || '');

        // 🎬 [VideoReco] New video engine interaction
        if (tweet.tweet_type === 'video') {
          videoRecommendationService.onInteraction(String(userId), String(id), 'like');
        }
      }

      res.json({
        success: true,
        message: 'Tweet liké avec succès',
        data: { liked: true }
      });
    }

  } catch (error) {
    logger.error('Erreur lors du like/unlike du tweet:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/tweets/:id/super-like
 * Pose un Super Cœur — pression longue sur le cœur côté mobile. Réservé aux
 * abonnés Pro, solde limité renouvelé tous les `SUPER_HEART_RENEW_DAYS`
 * jours (voir `src/utils/superHeartHelpers.js`).
 *
 * Idempotent une fois posé : rejouer l'appel sur un Super Cœur déjà en place
 * ne consomme rien de plus. Le retirer se fait via la route `like` ci-dessus
 * (elle détruit la ligne quel que soit `is_super`) et ne rend JAMAIS le
 * cœur consommé — c'est la règle explicitement demandée par la proposition.
 */
router.post('/:id/super-like', [
  authenticateToken,
  checkUserBanStrict,
  param('id').isUUID().withMessage('ID de tweet invalide'),
  handleValidationErrors,
  requireContentAccess(),
], async (req, res) => {
  try {
    const userId = req.user.id;

    const { tweet: requested, targetTweet: tweet, targetId: id } =
      await resolveEngagementTarget(Tweet, req.params.id);
    if (!requested) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    // Vérification d'éligibilité + décompte du solde dans une transaction
    // avec verrou de ligne : sans ça, deux poses concurrentes (sur deux
    // tweets différents) partant d'un solde de 1 peuvent toutes les deux lire
    // "il en reste" avant que l'une des deux n'écrive la décrémentation, et le
    // solde final ne baisse que d'un cœur pour deux Super Cœurs posés.
    let outcome;
    try {
      outcome = await sequelize.transaction(async (t) => {
        const user = await User.findByPk(userId, {
          attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at', 'super_hearts_remaining', 'super_hearts_renew_at'],
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!user) {
          const err = new Error('Utilisateur non trouvé');
          err.statusCode = 404;
          throw err;
        }

        await maybeExpireSubscription(user, t);
        await maybeRenewSuperHearts(user, t);

        if (!isSuperHeartEligible(user)) {
          const err = new Error('Le Super Cœur est réservé aux abonnés Pro.');
          err.statusCode = 403;
          err.code = 'SUPER_HEART_NOT_ELIGIBLE';
          throw err;
        }

        const existingLike = await TweetLike.findOne({
          where: { tweet_id: id, user_id: userId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (existingLike && existingLike.is_super) {
          return { alreadySuper: true, created: false, remaining: user.super_hearts_remaining };
        }

        if (user.super_hearts_remaining <= 0) {
          const renewsAt = user.super_hearts_renew_at ? new Date(user.super_hearts_renew_at) : null;
          const err = new Error(
            renewsAt
              ? `Plus de Super Cœur disponible. Prochain renouvellement le ${renewsAt.toLocaleDateString('fr-FR')}.`
              : 'Plus de Super Cœur disponible.'
          );
          err.statusCode = 403;
          err.code = 'SUPER_HEART_EXHAUSTED';
          throw err;
        }

        // Distinct de `created_at` : un like classique posé plus tôt peut
        // être promu bien après sa création — voir spotlightService, qui
        // s'appuie dessus pour dater le boost au bon moment.
        const superLikedAt = new Date();
        const created = !existingLike;

        if (existingLike) {
          // La pression longue fait passer un like classique préexistant en
          // Super Cœur sans créer une seconde ligne (unicité user_id/tweet_id).
          existingLike.is_super = true;
          existingLike.super_liked_at = superLikedAt;
          await existingLike.save({ transaction: t });
        } else {
          await TweetLike.create({
            tweet_id: id,
            user_id: userId,
            is_super: true,
            super_liked_at: superLikedAt,
            metadata: {
              source: req.userPlatform || 'web',
              device: req.headers['user-agent'] || 'unknown',
              ip_address: req.ip
            }
          }, { transaction: t });
        }

        user.super_hearts_remaining -= 1;
        await user.save({ transaction: t });

        return { alreadySuper: false, created, remaining: user.super_hearts_remaining };
      });
    } catch (txError) {
      if (txError.statusCode) {
        return res.status(txError.statusCode).json({
          success: false,
          message: txError.message,
          ...(txError.code ? { code: txError.code } : {}),
        });
      }
      throw txError;
    }

    if (outcome.alreadySuper) {
      return res.json({
        success: true,
        message: 'Déjà en Super Cœur',
        data: { liked: true, is_super: true, super_hearts_remaining: outcome.remaining },
      });
    }

    // Effets de bord non transactionnels (notifications, tracking, moteurs de
    // recommandation) : uniquement à la création d'un like, jamais à la
    // promotion d'un like déjà notifié — même règle que la route `like`.
    if (outcome.created) {
      ctrTracker.trackTweetLike(userId, id, String(tweet.user_id)).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });

      if (tweet.user_id !== userId) {
        await Notification.createLikeNotification(userId, id, tweet.user_id);
      }

      await realtimeQueueService.updateLikesRealtime(id, userId);

      const tweetAuthor = tweet.author || await User.findByPk(tweet.user_id, { attributes: ['username'] }).catch(() => null);
      retargetingHook.trackLike({
        userId: String(userId),
        tweetId: String(id),
        tweetContent: tweet.content || '',
        authorUsername: tweetAuthor?.username || '',
        mediaUrls: Array.isArray(tweet.media_urls) ? tweet.media_urls : []
      });

      similarity.getEngine().onInteraction(String(userId), String(id), 'like', tweet.content || '');

      if (tweet.tweet_type === 'video') {
        videoRecommendationService.onInteraction(String(userId), String(id), 'like');
      }
    }

    logger.info(`Super Cœur posé: utilisateur ${userId} sur le tweet ${id}`);

    res.json({
      success: true,
      message: 'Super Cœur posé avec succès',
      data: { liked: true, is_super: true, super_hearts_remaining: outcome.remaining },
    });

  } catch (error) {
    logger.error('Erreur lors de la pose du Super Cœur:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/tweets/:id/retweet
 * Retweeter/Unretweeter un tweet
 */
router.post('/:id/retweet', [
  authenticateToken,
  checkUserBanStrict, // Vérifier que l'utilisateur n'est pas banni
  param('id').isUUID().withMessage('ID de tweet invalide'),
  body('comment').optional().trim()
    .custom((value, { req }) => {
      if (!req.user?.verified && value && value.length > 600) {
        throw new Error('Le commentaire ne peut pas dépasser 600 caractères');
      }
      return true;
    }),
  handleValidationErrors,
  // Un retweet REPUBLIE le contenu à un autre public. Sans ce contrôle, un
  // seul acheteur suffisait à le diffuser gratuitement à tous ses abonnés.
  requireContentAccess(),
], async (req, res) => {
  try {
    const { comment } = req.body;
    const userId = req.user.id;

    // Retweeter un retweet retweete l'original (sémantique Twitter) : sans
    // cette résolution on empilait des retweets de retweets, chacun avec ses
    // propres compteurs à zéro.
    const { tweet: requested, targetTweet: tweet, targetId: id } =
      await resolveEngagementTarget(Tweet, req.params.id);
    if (!requested) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    // Vérifier si l'utilisateur a déjà retweeté le tweet
    const existingRetweet = await TweetRetweet.findOne({
      where: {
        tweet_id: id,
        user_id: userId
      }
    });

    if (existingRetweet) {
      // Unretweeter le tweet: supprimer TOUS les doublons potentiels de cet utilisateur
      const wasType = existingRetweet.retweet_type;
      const wasComment = existingRetweet.comment;

      await TweetRetweet.destroy({
        where: {
          tweet_id: id,
          user_id: userId
        }
      });

      // 📊 Track unretweet pour l'algorithme Rust
      ctrTracker.trackUnretweet(userId, id, String(tweet.user_id)).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });

      try {
        if (wasType === 'retweet') {
          // Supprimer tous les retweets simples de cet utilisateur pour ce tweet
          await Tweet.destroy({
            where: { user_id: userId, original_tweet_id: id, is_retweet: true, tweet_type: 'retweet' }
          });
        } else if (wasType === 'quote') {
          // Supprimer le quote spécifique
          await Tweet.destroy({
            where: { user_id: userId, original_tweet_id: id, is_quote: true, tweet_type: 'quote', content: wasComment || '' }
          });
        }
      } catch (cleanupErr) {
        logger.warn('Nettoyage unretweet échoué:', cleanupErr?.message || cleanupErr);
      }

      // Mettre à jour la queue en temps réel (unretweet)
      await realtimeQueueService.decrementRetweetsRealtime(id, userId);
      await realtimeQueueService.syncTweetInteractions(id);

      // 🎬 [VideoReco] Real-time engine sync (unretweet)
      if (tweet.tweet_type === 'video') {
        videoRecommendationService.offInteraction(String(userId), String(id), 'retweet');
      }

      logger.info(`Retweet supprimé: utilisateur ${userId} a unretweeté le tweet ${id}`);

      return res.json({
        success: true,
        message: 'Retweet supprimé avec succès',
        data: { retweeted: false }
      });
    } else {
      // Créer l'entrée de retweet
      await TweetRetweet.create({
        tweet_id: id,
        user_id: userId,
        retweet_type: comment ? 'quote' : 'retweet',
        metadata: {
          source: req.userPlatform || 'web',
          device: req.headers['user-agent'] || 'unknown',
          ip_address: req.ip
        }
      });

      // 📊 Enregistrer l'action pour le CTR tracking (algorithme Rust)
      ctrTracker.trackTweetRetweet(userId, id, String(tweet.user_id)).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });

      // 🎬 [VideoReco] New video engine interaction for retweet/quote
      if (tweet.tweet_type === 'video') {
        videoRecommendationService.onInteraction(String(userId), String(id), comment ? 'comment' : 'repost');
      }

      // Créer un Tweet enfant pour feed (quote avec contenu, retweet simple sans contenu)
      if (comment && comment.trim().length > 0) {
        const childTweet = await Tweet.create({
          content: comment,
          user_id: userId,
          original_tweet_id: id,
          is_quote: true,
          is_retweet: false,
          tweet_type: 'quote',
          media_urls: [],
          is_private: false,
          is_sensitive: false,
          language: 'fr',
          moderation_status: 'pending',
          metadata: {
            source: req.userPlatform || 'web',
            device: req.headers['user-agent'] || 'unknown',
            ip_address: req.ip,
            created_via: 'retweet_quote',
            pending_processing: true
          }
        });

        // Traiter le quote tweet avec Gemini + PolicierCongo en arrière-plan
        setImmediate(async () => {
          try {
            const author = await User.findByPk(userId, { attributes: ['username'] });
            if (!author) {
              logger.warn(`Auteur non trouvé pour le tweet cité ${childTweet.id}`);
              return;
            }

            logger.info(`🚀 Lancement du traitement asynchrone pour le tweet cité ${childTweet.id}`);

            const processResult = await processPendingTweet(
              childTweet.id,
              comment,
              author.username,
              false // un quote n'est pas une réponse
            );

            if (processResult.success) {
              const automatedUpdate = await applyAutomatedTweetUpdate(childTweet.id, {
                moderation_status: processResult.moderation_status,
                moderation_reason: processResult.moderation_reason,
                metadata: {
                  processing_result: processResult,
                  processed_at: processResult.processed_at
                }
              });
              if (!automatedUpdate) return;

              logger.info(`✅ Tweet cité ${childTweet.id} traité avec succès: ${processResult.moderation_status}`);

              // Si le tweet cité est approuvé, l'ajouter au système de recommandation progressive
              if (processResult.moderation_status === 'approved') {
                try {
                  const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
                  const recommendationEngine = new ProgressiveRecommendationEngine();
                  await recommendationEngine.addNewTweet(childTweet.id);
                  logger.info(`🎯 Tweet cité ${childTweet.id} ajouté au système de recommandation progressive`);
                } catch (recError) {
                  logger.error(`❌ Erreur lors de l'ajout du tweet cité ${childTweet.id} au système de recommandation:`, recError);
                }
              }

              if (processResult.moderation_status === 'rejected') {
                await handleRejectedTweet(childTweet, userId, processResult);
              } else if (processResult.moderation_status === 'not_eligible') {
                // Notification allégée pour not_eligible
                try {
                  await Notification.createNotification({
                    recipient_id: userId,
                    sender_id: userId,
                    tweet_id: childTweet.id,
                    type: 'system',
                    title: 'Tweet cité non éligible aux recommandations',
                    message: 'Votre tweet cité n\'est pas éligible aux recommandations.',
                    content: {
                      reason: processResult.gemini_result?.reason || null,
                      score: processResult.gemini_result?.score || null,
                      decision: 'not_eligible'
                    },
                    priority: 'low',
                  });
                } catch (notifErr) {
                  logger.warn('Notification not_eligible (quote) échouée:', notifErr?.message || notifErr);
                }
              } else if (processResult.moderation_status === 'approved') {
                await handleApprovedTweet(childTweet, userId, processResult);
              }

              // Réponse automatique PolicierCongo si nécessaire
              if (processResult.police_response?.success) {
                await handlePoliceResponse(childTweet, userId, processResult.police_response);
              }
            } else {
              logger.error(`❌ Échec du traitement du tweet cité ${childTweet.id}:`, processResult.error);
              await applyAutomatedTweetUpdate(childTweet.id, {
                moderation_status: 'approved',
                metadata: {
                  processing_error: processResult.error,
                  processed_at: processResult.processed_at
                }
              });
            }
          } catch (error) {
            logger.error(`❌ Erreur lors du traitement asynchrone du tweet cité ${childTweet.id}:`, error);
            await applyAutomatedTweetUpdate(childTweet.id, {
              moderation_status: 'approved',
              metadata: {
                processing_error: error.message,
                processed_at: new Date().toISOString()
              }
            });
          }
        });
      } else {
        await Tweet.create({
          content: '',
          user_id: userId,
          original_tweet_id: id,
          is_quote: false,
          is_retweet: true,
          tweet_type: 'retweet',
          media_urls: [],
          is_private: false,
          is_sensitive: false,
          language: 'fr',
          moderation_status: 'approved',
          metadata: { source: req.userPlatform || 'web', device: req.headers['user-agent'] || 'unknown', ip_address: req.ip, created_via: 'retweet_simple' }
        });
      }

      // Créer une notification de retweet
      if (tweet.user_id !== userId) {
        try {
          await Notification.createRetweetNotification(userId, id, tweet.user_id);
        } catch (notifErr) {
          logger.warn('Création notification retweet échouée:', notifErr?.message || notifErr);
        }
      }

      // Mettre à jour la queue en temps réel (retweet)
      await realtimeQueueService.updateRetweetsRealtime(id, userId);

      logger.info(`Retweet créé: utilisateur ${userId} a retweeté le tweet ${id}${comment ? ' (quote)' : ''}`);

      // 🎯 RETARGETING & SIMILARITY
      {
        const tweetAuthor = tweet.author || await User.findByPk(tweet.user_id, { attributes: ['username'] }).catch(() => null);
        const typeAction = (comment && comment.trim().length > 0) ? 'quote' : 'retweet';

        if (typeAction === 'quote') {
          retargetingHook.trackQuote({
            userId: String(userId),
            tweetId: String(id),
            tweetContent: tweet.content || '',
            authorUsername: tweetAuthor?.username || '',
            mediaUrls: Array.isArray(tweet.media_urls) ? tweet.media_urls : []
          });
        } else {
          retargetingHook.trackRetweet({
            userId: String(userId),
            tweetId: String(id),
            tweetContent: tweet.content || '',
            authorUsername: tweetAuthor?.username || '',
            mediaUrls: Array.isArray(tweet.media_urls) ? tweet.media_urls : []
          });
        }

        similarity.getEngine().onInteraction(String(userId), String(id), typeAction, tweet.content || '');
      }

      return res.json({
        success: true,
        message: comment ? 'Tweet cité avec succès' : 'Tweet retweeté avec succès',
        data: { retweeted: true }
      });
    }

  } catch (error) {
    logger.error('Erreur lors du retweet/unretweet du tweet:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/tweets/translations/batch
 * Traductions de plusieurs tweets dans UNE langue.
 *
 * C'est la route du fil : sans elle, afficher une page de tweets dans la
 * langue du lecteur coûterait un appel par carte.
 */
router.post('/translations/batch', [
  authenticateToken,
  body('tweet_ids').isArray({ min: 1, max: 100 }).withMessage('tweet_ids doit être un tableau de 1 à 100 identifiants'),
  body('language').isString().withMessage('Langue invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const language = String(req.body.language || '').trim().toLowerCase();

    // Contenus payants : cette route rend du texte de tweet, en lot. Les
    // verrouillés non achetés sont retirés de la demande — sinon le fil
    // récupérait par la bande la traduction de ce qu'il n'a pas le droit
    // d'afficher.
    const requestedIds = req.body.tweet_ids.filter(Boolean).map(String);
    const lockMap = await paidContentService.accessMapFor({
      viewerId: req.user.id,
      contentType: 'tweet',
      contentIds: requestedIds,
    });
    const readableIds = requestedIds.filter((id) => {
      const entry = lockMap.get(String(id));
      return !entry || entry.hasAccess;
    });

    const translations = readableIds.length
      ? await tweetTranslationService.getTranslationsForLanguage(readableIds, language)
      : [];

    res.json({
      success: true,
      message: 'Traductions récupérées avec succès',
      data: { language, translations }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération groupée des traductions:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/tweets/:id/translations
 * Traductions IA disponibles d'un tweet (fonctionnalité « Traduction bêta »).
 *
 * Lecture seule et sans appel au LLM : tout a été généré à la publication.
 * Un retweet renvoie les traductions du tweet d'origine — c'est bien ce
 * texte-là qui s'affiche sur la carte.
 */
router.get('/:id/translations', [
  param('id').isUUID().withMessage('ID de tweet invalide'),
  handleValidationErrors,
  // Cette route est publique et rend le TEXTE du tweet, traduit. Sur un
  // contenu payant, c'était la marchandise servie en clair à qui savait
  // l'adresse — sans même être connecté.
  requireContentAccess(),
], async (req, res) => {
  try {
    // `targetTweet` et pas `tweet` : sur un retweet pur, c'est l'original qui
    // porte l'option et la langue source, comme il porte déjà son contenu.
    const { tweet, targetTweet, targetId } = await resolveEngagementTarget(Tweet, req.params.id);
    if (!tweet) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    const source = targetTweet || tweet;
    const translations = await tweetTranslationService.getTranslations(targetId);

    res.json({
      success: true,
      message: 'Traductions récupérées avec succès',
      data: {
        tweet_id: targetId,
        source_language: source.language || null,
        // Faux vide et vrai vide ne se soignent pas pareil côté app : sans ce
        // drapeau, un tweet dont la génération vient d'échouer serait présenté
        // comme un tweet sans option de traduction.
        translation_enabled: !!source.translation_enabled,
        translations
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des traductions:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/tweets/:id/likes
 * Récupérer la liste des utilisateurs qui ont liké un tweet
 */
router.get('/:id/likes', [
  param('id').isUUID().withMessage('ID de tweet invalide'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    // La liste des likeurs d'un retweet est celle du tweet d'origine, en
    // cohérence avec le compteur affiché sur la carte.
    const { tweet, targetId: id } = await resolveEngagementTarget(Tweet, req.params.id);
    if (!tweet) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    const likes = await TweetLike.getTweetLikes(id, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      includeUser: true
    });

    const totalCount = await TweetLike.countTweetLikes(id);

    res.json({
      success: true,
      message: 'Likes récupérés avec succès',
      data: {
        likes,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + likes.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des likes:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/tweets/:id/retweets
 * Récupérer la liste des utilisateurs qui ont retweeté un tweet
 */
router.get('/:id/retweets', [
  param('id').isUUID().withMessage('ID de tweet invalide'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    // Même logique que /likes : les retweeteurs listés sont ceux de l'original.
    const { tweet, targetId: id } = await resolveEngagementTarget(Tweet, req.params.id);
    if (!tweet) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    const retweets = await TweetRetweet.getTweetRetweets(id, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      includeUser: true
    });

    const totalCount = await TweetRetweet.countTweetRetweets(id);

    res.json({
      success: true,
      message: 'Retweets récupérés avec succès',
      data: {
        retweets,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + retweets.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des retweets:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

  /**
   * GET /api/tweets/:id/replies
   * Récupérer toutes les réponses à un tweet spécifique
   * NOUVELLE ROUTE OPTIMISÉE pour afficher les réponses
   */
  router.get('/:id/replies', [
    authenticateToken,
    param('id').isUUID().withMessage('ID de tweet invalide'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
    query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
    query('sort').optional().isIn(['latest', 'oldest', 'popular']).withMessage('Tri invalide'),
    handleValidationErrors
  ], async (req, res) => {
    try {
      const { id } = req.params;
      const { limit = 20, offset = 0, sort = 'latest', nested = 'false' } = req.query;
      const isNested = nested === 'true';
      const userId = req.user.id;

      // Vérifier que le tweet parent existe
      const parentTweet = await Tweet.findByPk(id, {
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
          }
        ]
      });

      if (!parentTweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet parent non trouvé'
        });
      }

      // Définir l'ordre selon le paramètre de tri
      let orderClause = [['created_at', 'DESC']];
      if (sort === 'oldest') {
        orderClause = [['created_at', 'ASC']];
      } else if (sort === 'popular') {
        // Tri par engagement (likes + retweets)
        orderClause = [['view_count', 'DESC'], ['created_at', 'DESC']];
      }

      // Définir la condition WHERE selon le mode (imbriqué ou standard)
      const whereClause = {
        is_private: false,
        is_data_test: false,
        moderation_status: 'approved'
      };

      if (isNested) {
        // Mode imbriqué : tout l'arbre de conversation (utile pour le CommentSheet vidéo)
        whereClause[Op.or] = [
          { parent_tweet_id: id },
          { original_tweet_id: id }
        ];
      } else {
        // Mode standard : seulement les réponses directes (évite les doublons et les "fausses citations")
        whereClause.parent_tweet_id = id;
      }

      // Définir l'inclusion (parentTweet provoque un aspect "cité" sur mobile si présent)
      const inclusions = [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization'],
          where: { is_active: true }
        }
      ];

      if (isNested) {
        inclusions.push({
          model: Tweet,
          as: 'parentTweet',
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username']
          }]
        });
      }

      // Récupérer les réponses
      const replies = await Tweet.findAll({
        where: whereClause,
        include: inclusions,
        order: orderClause,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      // Enrichir les réponses avec les statistiques et l'état des interactions.
      //
      // Cinq requêtes par réponse, soit cent pour une page de vingt, et cinq
      // en série pour chacune. On agrège les cinq mêmes informations pour
      // toute la page d'un coup, et on y joint les deux compteurs du parent
      // ainsi que le total de pagination — tout est indépendant, donc lancé en
      // parallèle. Résultat identique, huit requêtes au lieu de cent trois.
      const replyIds = replies.map((r) => String(r.id));
      const parentId = String(parentTweet.id);

      const [
        rLikes,
        rRetweets,
        rReplies,
        rLikedByMe,
        rRetweetedByMe,
        totalReplies,
        parentLikes,
        parentRetweets,
      ] = await Promise.all([
        TweetLike.countLikesForTweets(replyIds),
        TweetRetweet.countRetweetsForTweets(replyIds),
        Tweet.countRepliesForTweets(replyIds),
        TweetLike.likedTweetIdsForUser(userId, replyIds),
        TweetRetweet.retweetedTweetIdsForUser(userId, replyIds),
        Tweet.count({ where: whereClause }),
        TweetLike.countTweetLikes(parentId),
        TweetRetweet.countTweetRetweets(parentId),
      ]);

      const enrichedReplies = replies.map((reply) => {
        const replyData = reply.toJSON();
        const rid = String(reply.id);

        return {
          ...replyData,
          stats: {
            likes: rLikes.get(rid) || 0,
            retweets: rRetweets.get(rid) || 0,
            replies: rReplies.get(rid) || 0,
            views: reply.view_count || 0
          },
          user_interaction: {
            is_liked: rLikedByMe.has(rid),
            is_retweeted: rRetweetedByMe.has(rid)
          }
        };
      });

      // Informations sur le tweet parent
      const parentTweetInfo = {
        id: parentTweet.id,
        content: parentTweet.content,
        author: parentTweet.author,
        created_at: parentTweet.created_at,
        stats: {
          likes: parentLikes,
          retweets: parentRetweets,
          replies: totalReplies,
          views: parentTweet.view_count || 0
        }
      };

      // Le parent part dans le même masquage que les réponses : sans lui, il
      // suffisait d'ouvrir le fil de discussion d'un tweet payant pour en lire
      // le texte complet, sans jamais passer par le fil ni par sa page.
      if (!(await paidContentService.maskTweetsOrFail(
        [parentTweetInfo, ...enrichedReplies],
        userId,
        res,
      ))) return;

      res.json({
        success: true,
        message: 'Réponses récupérées avec succès',
        data: {
          parent_tweet: parentTweetInfo,
          replies: enrichedReplies,
          pagination: {
            total: totalReplies,
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: offset + enrichedReplies.length < totalReplies
          },
          summary: {
            total_replies: totalReplies,
            replies_loaded: enrichedReplies.length,
            sort_method: sort
          }
        }
      });

    } catch (error) {
      logger.error('Erreur lors de la récupération des réponses:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur interne du serveur'
      });
    }
  });

  // ========================================
  // FONCTIONS HELPER POUR LE TRAITEMENT ASYNCHRONE
  // ========================================

  /**
   * Gère un tweet rejeté par Gemini
   */
  async function handleRejectedTweet(tweet, userId, processResult) {
    try {
      logger.info(`🚫 Gestion du tweet rejeté ${tweet.id}: ${processResult.moderation_reason}`);

      // Créer une notification de rejet
      await Notification.createNotification({
        recipient_id: userId,
        sender_id: userId,
        tweet_id: tweet.id,
        type: 'system',
        title: 'Tweet supprimé pour non-respect des règles',
        message: 'Votre tweet a été retiré car il enfreint nos règles de contenu.',
        content: {
          reason: processResult.gemini_result?.reason || null,
          score: processResult.gemini_result?.score || null,
          decision: 'ban'
        },
        priority: 'high',
      });

      // Compter les bans et suspendre le compte à partir de 3
      const banCount = await Tweet.count({
        where: {
          user_id: userId,
          moderation_status: 'rejected',
          moderation_reason: { [Op.iLike]: 'gemini_ban%' },
        }
      });

      logger.info(`🚫 Comptage des bans pour l'utilisateur ${userId}: ${banCount}`);

      if (banCount >= 3) {
        const authorUser = await applyAutomaticSuspension(tweet.id, userId, (currentUser) => ({
          is_active: true,
          is_suspended: true,
          suspended_at: new Date(),
          suspension_reason: 'Récurrence de contenus interdits (>=3) détectés par KOSPORAI',
          suspension_meta: {
            ...(currentUser.suspension_meta || {}),
            auto_ban: true,
            auto_ban_source: 'rejected_content_threshold',
            tweet_id: tweet.id,
            rejected_count: banCount,
          },
        }));
        if (authorUser) {
          logger.warn(`🚫 Compte suspendu pour l'utilisateur ${userId} après ${banCount} bans`);

          // Notification de suspension
          await Notification.createNotification({
            recipient_id: userId,
            sender_id: userId,
            type: 'system',
            title: 'Compte suspendu',
            message: 'Votre compte a été suspendu après 3 contenus interdits détectés.',
            content: { bans: banCount, last_tweet_id: tweet.id },
            priority: 'urgent',
          });
        }
      }
    } catch (error) {
      logger.error(`❌ Erreur lors de la gestion du tweet rejeté ${tweet.id}:`, error);
    }
  }

  /**
   * Gère un tweet approuvé par Gemini
   */
  async function handleApprovedTweet(tweet, userId, processResult) {
    try {
      logger.info(`✅ Gestion du tweet approuvé ${tweet.id}`);

      // Si le tweet n'est pas éligible aux recommandations, créer une notification
      if (processResult.gemini_result?.decision === 'not_eligible') {
        await Notification.createNotification({
          recipient_id: userId,
          sender_id: userId,
          tweet_id: tweet.id,
          type: 'system',
          title: 'Tweet non éligible à la recommandation',
          message: 'Votre tweet a été classé comme non éligible aux recommandations.',
          content: {
            reason: processResult.gemini_result?.reason || null,
            score: processResult.gemini_result?.score || null,
            decision: 'not_eligible'
          },
          priority: 'low',
        });
      }
    } catch (error) {
      logger.error(`❌ Erreur lors de la gestion du tweet approuvé ${tweet.id}:`, error);
    }
  }

  /**
   * Gère la réponse automatique de PolicierCongo
   */
  async function handlePoliceResponse(tweet, userId, policeResponse) {
    try {
      logger.info(`🚔 Gestion de la réponse policier pour le tweet ${tweet.id}`);

      // ID du compte policiercongo
      const POLICE_ACCOUNT_ID = 'a13a7745-448f-4faa-892a-f6ea140f2f5b';

      // Créer la réponse du policier
      const policeTweet = await Tweet.create({
        content: policeResponse.response,
        user_id: POLICE_ACCOUNT_ID,
        parent_tweet_id: tweet.id, // Réponse au tweet original
        is_private: false,
        is_sensitive: false,
        language: 'fr',
        moderation_status: 'approved', // Approuvé automatiquement
        metadata: {
          source: 'auto_police_response',
          original_tweet_id: tweet.id,
          original_author: tweet.author?.username || 'unknown',
          generated_at: new Date().toISOString()
        }
      });

      logger.info(`🚔 Réponse policier automatique créée: ${policeTweet.id} pour le tweet ${tweet.id}`);

      // Créer une notification pour l'auteur du tweet original
      await Notification.createNotification({
        recipient_id: userId,
        sender_id: POLICE_ACCOUNT_ID,
        tweet_id: policeTweet.id,
        type: 'reply',
        title: 'Policier Congo a répondu à votre tweet',
        message: 'Policier Congo a répondu à votre tweet !',
        content: {
          reply_tweet_id: policeTweet.id,
          original_tweet_id: tweet.id
        },
        priority: 'normal',
      });

    } catch (error) {
      logger.error(`❌ Erreur lors de la gestion de la réponse policier pour le tweet ${tweet.id}:`, error);
    }
  }

  /**
   * POST /api/tweets/views/increment
   * Incrémenter les vues de plusieurs tweets en une seule requête (optimisé)
   */
  router.post('/views/increment', [
    body('tweetIds').isArray({ min: 1, max: 50 }).withMessage('tweetIds doit être un tableau de 1 à 50 éléments'),
    body('tweetIds.*').isUUID().withMessage('Chaque tweetId doit être un UUID valide'),
    body('source').optional().isIn(['explore']).withMessage('source doit valoir "explore"'),
    handleValidationErrors
  ], authenticateToken, async (req, res) => {
    try {
      const { tweetIds, source } = req.body;
      const userId = req.user.id;

      logger.info(`👁️ Incrémentation des vues pour ${tweetIds.length} tweets par l'utilisateur ${userId}`);

      // Vérifier que les tweets existent et sont publics
      const tweets = await Tweet.findAll({
        where: {
          id: { [Op.in]: tweetIds },
          deleted_at: null,
          is_private: false
        },
        attributes: ['id', 'view_count']
      });

      if (tweets.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Aucun tweet valide trouvé'
        });
      }

      // Incrémenter les vues en batch
      const validTweetIds = tweets.map(tweet => tweet.id);

      // `source: 'explore'` incrémente aussi `explore_view_count`, dans le
      // même aller-retour — lu uniquement par la monétisation pour reformuler
      // cette part en clics. Sans `source`, comportement inchangé (le fil n'a
      // pas besoin de le passer).
      const viewIncrement = { view_count: sequelize.literal('view_count + 1') };
      if (source === 'explore') {
        viewIncrement.explore_view_count = sequelize.literal('explore_view_count + 1');
      }

      await Tweet.update(
        viewIncrement,
        {
          where: {
            id: { [Op.in]: validTweetIds }
          }
        }
      );

      // Mettre à jour la tweet_queue en temps réel pour chaque tweet
      const updatePromises = validTweetIds.map(async (tweetId) => {
        try {
          // Récupérer le groupe actuel du tweet
          const [tweetInfo] = await sequelize.query(`
          SELECT recommendation_group FROM tweets WHERE id = :tweetId
        `, {
            replacements: { tweetId },
            type: sequelize.QueryTypes.SELECT
          });

          const currentGroup = tweetInfo?.recommendation_group || 'initial';

          // Mettre à jour la queue en temps réel
          await realtimeQueueService.updateViewsRealtime(tweetId, userId, currentGroup);
        } catch (error) {
          logger.error(`❌ Erreur mise à jour queue pour tweet ${tweetId}:`, error);
        }
      });

      // Attendre que toutes les mises à jour soient terminées
      await Promise.all(updatePromises);

      logger.info(`✅ ${validTweetIds.length} vues incrémentées avec succès et queue mise à jour`);

      res.json({
        success: true,
        data: {
          updated: validTweetIds.length,
          tweetIds: validTweetIds
        },
        message: `${validTweetIds.length} vues mises à jour`
      });

    } catch (error) {
      logger.error('❌ Erreur lors de l\'incrémentation des vues:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'incrémentation des vues',
        error: error.message
      });
    }
  });

  /**
   * POST /api/tweets/clicks/increment
   * Incrémenter les clics Explorer de plusieurs tweets (paie uniquement — ne
   * touche jamais `view_count` ni la queue temps réel de l'algo).
   */
  router.post('/clicks/increment', [
    body('tweetIds').isArray({ min: 1, max: 50 }).withMessage('tweetIds doit être un tableau de 1 à 50 éléments'),
    body('tweetIds.*').isUUID().withMessage('Chaque tweetId doit être un UUID valide'),
    handleValidationErrors
  ], authenticateToken, async (req, res) => {
    try {
      const { tweetIds } = req.body;
      const userId = req.user.id;

      logger.info(`🖱️ Incrémentation des clics Explorer pour ${tweetIds.length} tweets par l'utilisateur ${userId}`);

      const tweets = await Tweet.findAll({
        where: {
          id: { [Op.in]: tweetIds },
          deleted_at: null,
          is_private: false
        },
        attributes: ['id']
      });

      if (tweets.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Aucun tweet valide trouvé'
        });
      }

      const validTweetIds = tweets.map(tweet => tweet.id);

      await Tweet.update(
        { explore_click_count: sequelize.literal('explore_click_count + 1') },
        {
          where: {
            id: { [Op.in]: validTweetIds }
          }
        }
      );

      logger.info(`✅ ${validTweetIds.length} clics Explorer incrémentés avec succès`);

      res.json({
        success: true,
        data: {
          updated: validTweetIds.length,
          tweetIds: validTweetIds
        },
        message: `${validTweetIds.length} clics mis à jour`
      });

    } catch (error) {
      logger.error('❌ Erreur lors de l\'incrémentation des clics Explorer:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'incrémentation des clics Explorer',
        error: error.message
      });
    }
  });

/**
 * POST /api/tweets/:id/bookmark
 * Ajouter/Retirer un tweet des favoris
 */
router.post('/:id/bookmark', [
  authenticateToken,
  checkUserBanStrict,
  param('id').isUUID().withMessage('ID de tweet invalide'),
  handleValidationErrors,
  requireContentAccess(),
], async (req, res) => {
  try {
    const userId = req.user.id;

    // Comme le like, un favori posé sur un retweet vise l'original.
    const { tweet: requested, targetTweet, targetId: id } =
      await resolveEngagementTarget(Tweet, req.params.id);
    if (!requested) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    // Vrai bascule persistée — l'ancienne route ne stockait rien et
    // répondait toujours `bookmarked: true`.
    const bookmarked = await TweetBookmark.toggle(userId, id);

    // 📊 Track bookmark pour l'algorithme Rust
    ctrTracker.trackBookmark(userId, id, String(targetTweet.user_id)).catch(err => {
      logger.warn(`CTR tracking error: ${err.message}`);
    });

    res.json({
      success: true,
      message: bookmarked ? 'Tweet ajouté aux favoris' : 'Tweet retiré des favoris',
      data: { bookmarked, tweet_id: id }
    });
  } catch (error) {
    logger.error('Erreur lors du bookmark:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/tweets/:id/share
 * Partager un tweet (via lien direct, email, etc.)
 */
router.post('/:id/share', [
  authenticateToken,
  checkUserBanReadOnly,
  param('id').isUUID().withMessage('ID de tweet invalide'),
  handleValidationErrors,
  requireContentAccess(),
], async (req, res) => {
  try {
    const userId = req.user.id;

    // Partager un retweet doit produire le lien du tweet d'origine, pas celui
    // d'une ligne de retweet qui n'affiche rien par elle-même.
    const { tweet: requested, targetTweet, targetId: id } =
      await resolveEngagementTarget(Tweet, req.params.id);
    if (!requested) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    // 📊 Track share pour l'algorithme Rust
    ctrTracker.trackShare(userId, id, String(targetTweet.user_id)).catch(err => {
      logger.warn(`CTR tracking error: ${err.message}`);
    });

    // Générer un lien shareable unique
    const shareLink = `https://twitninf.app/tweets/${id}`;

    res.json({
      success: true,
      message: 'Tweet partagé avec succès',
      data: {
        share_link: shareLink,
        tweet_id: id
      }
    });
  } catch (error) {
    logger.error('Erreur lors du partage:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

  module.exports = router;
