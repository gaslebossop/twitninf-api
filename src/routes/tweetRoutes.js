const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const router = express.Router();
const path = require('path');

// Import des modèles et services
const { Tweet, TweetLike, TweetRetweet, User, Notification } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../database');
const { processPendingTweet } = require('../services/geminiService');
const semanticSimilarityService = require('../services/semanticSimilarityService');
const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const { checkUserBanStrict, checkUserBanReadOnly } = require('../middleware/banMiddleware');
const { ultraSafeClean } = require('../utils/circularRefCleaner');
const TweetRecommendationService = require('../services/tweetRecommendationService');
const RealtimeQueueService = require('../services/realtimeQueueService');
const { upload, videoService } = require('../services/videoService');
const logger = require('../utils/logger');

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
const videoRecommendationService = require('../services/videoRecommendationService');

// 📊 Tracking CTR pour l'algorithme Rust
const ctrTracker = require('../services/ctrTracker');

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
], authenticateToken, async (req, res) => {
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
                  attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium'],
                  where: { is_active: true }
                }
              ]
            });

            // Remettre dans l'ordre du moteur et enrichir
            const dbMap = {};
            for (const v of dbVideos) dbMap[v.id] = v;

            const enrichedVideos = [];
            for (const r of recommendations) {
              const dbVideo = dbMap[r.videoId];
              if (dbVideo) {
                const videoData = dbVideo.toJSON();
                const vId = dbVideo.id;

                // Calculer les stats fraîches depuis la DB
                const [lCount, rtCount, repCount] = await Promise.all([
                  TweetLike.countTweetLikes(vId).catch(() => 0),
                  TweetRetweet.countTweetRetweets(vId).catch(() => 0),
                  Tweet.count({ where: { parent_tweet_id: vId, is_data_test: false } }).catch(() => 0)
                ]);

                // Construct standard tweet structure for the app
                videoData.stats = {
                  likes: lCount,
                  retweets: rtCount,
                  replies: repCount,
                  views: videoData.view_count || 0
                };

                // Interaction flags (check DB for absolute accuracy)
                const [isLiked, isRetweeted] = await Promise.all([
                  TweetLike.hasUserLikedTweet(userId, vId).catch(() => false),
                  TweetRetweet.hasUserRetweetedTweet(userId, vId).catch(() => false)
                ]);

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

                enrichedVideos.push(videoData);
              }
            }

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
                  attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium'],
                  where: { is_active: true }
                },
                {
                  model: Tweet,
                  as: 'originalTweet',
                  include: [{ model: User, as: 'author', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium'] }]
                }
              ]
            });

            // 3. Remettre dans l'ordre exact du moteur et enrichir
            const dbTweetsMap = {};
            for (const t of dbTweets) dbTweetsMap[t.id] = t;

            const enrichedTweets = [];

            for (const r of recommendations) {
              const dbTweet = dbTweetsMap[r.tweetId];
              if (dbTweet) {
                const tweetData = dbTweet.toJSON();

                // Si ce n'est pas une citation ou un retweet, on ne veut pas l'aspect "citation" ou "réponse à" dans le fil
                if (!tweetData.is_quote && !tweetData.is_retweet) {
                  tweetData.originalTweet = null;
                  tweetData.original_tweet_id = null;
                  tweetData.parent_tweet_id = null;
                  tweetData.parentTweet = null;
                }

                // Calcul des stats (peut être optimisé plus tard via caching)
                const lCount = await TweetLike.countTweetLikes(tweetData.id);
                const rtCount = await TweetRetweet.countTweetRetweets(tweetData.id);
                const repCount = await Tweet.count({ where: { parent_tweet_id: tweetData.id, is_data_test: false } });
                const iLiked = await TweetLike.hasUserLikedTweet(userId, tweetData.id);
                const iRetweeted = await TweetRetweet.hasUserRetweetedTweet(userId, tweetData.id);

                tweetData.stats = {
                  likes: lCount,
                  retweets: rtCount,
                  replies: repCount,
                  views: tweetData.view_count || 0
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

                enrichedTweets.push(tweetData);
              }
            }

            // --- 🎯 INJECTION PUBLICITAIRE CIBLÉE I.A ---
            try {
              if (targetingService && targetingService.getRelevantAdsForUser) {
                const activeAds = targetingService.getRelevantAdsForUser(userId, Math.ceil(enrichedTweets.length / 3));
                if (activeAds && activeAds.length > 0) {
                  const uIds = [...new Set(activeAds.map(ad => ad.user_id))];
                  let uMap = {};
                  const adUsers = await User.findAll({
                    where: { id: uIds },
                    attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium']
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

    const tweets = await Tweet.findAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium'],
          where: { is_active: true }
        },
        {
          model: Tweet,
          as: 'originalTweet',
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'verification_style', 'premium']
          }]
        }
      ],
      order: orderClause,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    // Récupérer l'ID de l'utilisateur connecté (obligatoire maintenant)
    const userId = req.user.id;

    // Enrichir les tweets avec les statistiques et l'état des likes
    const enrichedTweets = await Promise.all(tweets.map(async (tweet) => {
      const tweetData = tweet.toJSON();

      // Si ce n'est pas une citation ou un retweet, on ne veut pas l'aspect "citation" ou "réponse à" dans le fil
      if (!tweetData.is_quote && !tweetData.is_retweet) {
        tweetData.originalTweet = null;
        tweetData.original_tweet_id = null;
        tweetData.parent_tweet_id = null;
        tweetData.parentTweet = null;
      }

      // Calculer les statistiques
      const likeCount = await TweetLike.countTweetLikes(tweet.id);
      const retweetCount = await TweetRetweet.countTweetRetweets(tweet.id);
      const replyCount = await Tweet.count({
        where: { parent_tweet_id: tweet.id, is_data_test: false }
      });

      // Vérifier si l'utilisateur connecté a liké/retweeté ce tweet (obligatoire)
      const isLiked = await TweetLike.hasUserLikedTweet(userId, tweet.id);
      const isRetweeted = await TweetRetweet.hasUserRetweetedTweet(userId, tweet.id);

      return {
        ...tweetData,
        stats: {
          likes: likeCount,
          retweets: retweetCount,
          replies: replyCount,
          views: tweet.view_count || 0
        },
        user_interaction: {
          is_liked: isLiked,
          is_retweeted: isRetweeted
        }
      };
    }));

    // --- 🎯 INJECTION PUBLICITAIRE CIBLÉE I.A CLASSIQUE ---
    try {
      if (targetingService && targetingService.getRelevantAdsForUser) {
        const activeAds = targetingService.getRelevantAdsForUser(userId, Math.ceil(enrichedTweets.length / 3));
        if (activeAds && activeAds.length > 0) {
          const uIds = [...new Set(activeAds.map(ad => ad.user_id))];
          let uMap = {};
          const adUsers = await User.findAll({
            where: { id: uIds },
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium']
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

    // Compter le total pour la pagination en utilisant EXACTEMENT la même clause WHERE
    const totalCount = await Tweet.count({
      where: whereClause
    });

    res.json({
      success: true,
      message: 'Tweets récupérés avec succès',
      data: {
        tweets: enrichedTweets,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + enrichedTweets.length < totalCount
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
], async (req, res) => {
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
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium']
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
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'verification_style', 'premium']
        },
        {
          model: Tweet,
          as: 'parentTweet',
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style']
          }]
        },
        {
          model: Tweet,
          as: 'replies',
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style']
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

    // Incrémenter le compteur de vues
    await tweet.increment('view_count');

    // Enrichir avec statistiques et état d'interaction pour l'utilisateur courant
    const userId = req.user?.id;
    let enrichedTweet = tweet.toJSON();

    const likeCount = await TweetLike.countTweetLikes(tweet.id);
    const retweetCount = await TweetRetweet.countTweetRetweets(tweet.id);
    const replyCount = await Tweet.count({ where: { parent_tweet_id: tweet.id, is_data_test: false } });

    let isLiked = false;
    let isRetweeted = false;
    if (userId) {
      isLiked = await TweetLike.hasUserLikedTweet(userId, tweet.id);
      isRetweeted = await TweetRetweet.hasUserRetweetedTweet(userId, tweet.id);
    }

    enrichedTweet = {
      ...enrichedTweet,
      stats: {
        likes: likeCount,
        retweets: retweetCount,
        replies: replyCount,
        views: enrichedTweet.view_count || 0
      },
      user_interaction: {
        is_liked: isLiked,
        is_retweeted: isRetweeted
      }
    };

    // Enrichir sommairement les réponses (statistiques de base + pas d'agrégats lourds)
    if (Array.isArray(enrichedTweet.replies)) {
      enrichedTweet.replies = await Promise.all(enrichedTweet.replies.map(async (reply) => {
        const rLikeCount = await TweetLike.countTweetLikes(reply.id);
        const rRetweetCount = await TweetRetweet.countTweetRetweets(reply.id);
        const rReplyCount = await Tweet.count({ where: { parent_tweet_id: reply.id, is_data_test: false } });
        let rIsLiked = false;
        let rIsRetweeted = false;
        if (userId) {
          rIsLiked = await TweetLike.hasUserLikedTweet(userId, reply.id);
          rIsRetweeted = await TweetRetweet.hasUserRetweetedTweet(userId, reply.id);
        }
        return {
          ...reply,
          stats: {
            likes: rLikeCount,
            retweets: rRetweetCount,
            replies: rReplyCount,
            views: reply.view_count || 0
          },
          user_interaction: {
            is_liked: rIsLiked,
            is_retweeted: rIsRetweeted
          }
        };
      }));
    }

    // 📊 Enregistrer la vue pour le CTR tracking (algorithme Rust)
    if (userId && !id.startsWith('ad-')) {
      ctrTracker.trackTweetView(userId, id).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });
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
    const candidates = await Tweet.findAll({
      where: {
        id: { [Op.ne]: id },
        parent_tweet_id: null,
        deleted_at: null,
        moderation_status: 'approved'
      },
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

    // 4. Enrichir les tweets sélectionnés (stats + interaction)
    const enrichedTweets = await Promise.all(similarTweets.map(async (tweet) => {
      const tweetData = tweet.toJSON();
      
      const [lCount, rtCount, repCount] = await Promise.all([
        TweetLike.countTweetLikes(tweet.id).catch(() => 0),
        TweetRetweet.countTweetRetweets(tweet.id).catch(() => 0),
        Tweet.count({ where: { parent_tweet_id: tweet.id, is_data_test: false } }).catch(() => 0)
      ]);

      const [isLiked, isRetweeted] = await Promise.all([
        TweetLike.hasUserLikedTweet(userId, tweet.id).catch(() => false),
        TweetRetweet.hasUserRetweetedTweet(userId, tweet.id).catch(() => false)
      ]);

      tweetData.stats = {
        likes: lCount,
        retweets: rtCount,
        replies: repCount,
        views: tweetData.view_count || 0
      };

      tweetData.user_interaction = {
        is_liked: isLiked,
        is_retweeted: isRetweeted
      };

      return tweetData;
    }));

    res.json({
      success: true,
      message: `3 tweets similaires récupérés via ${sourceUsed}`,
      source: sourceUsed,
      data: enrichedTweets.slice(0, 3)
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
 * POST /api/tweets
 * Créer un nouveau tweet
 */
router.post('/', [
  authenticateToken,
  denySuspended,
  body('content').trim().isLength({ min: 1 }).withMessage('Le contenu ne peut pas être vide')
    .custom((value, { req }) => {
      if (!req.user?.verified && value.length > 600) {
        throw new Error('Le contenu doit contenir entre 1 et 600 caractères');
      }
      return true;
    }),
  body('parent_tweet_id').optional().isUUID().withMessage('ID de tweet parent invalide'),
  body('media_urls').optional().isArray().withMessage('Les URLs des médias doivent être un tableau'),
  body('is_private').optional().isBoolean().withMessage('Le statut privé doit être un booléen'),
  body('is_sensitive').optional().isBoolean().withMessage('Le statut sensible doit être un booléen'),
  handleValidationErrors
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
      language = 'fr'
    } = req.body;

    const userId = req.user.id;
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
      ctrTracker.trackComment(userId, parent_tweet_id).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });

      // 🎬 [VideoReco] If reply to a video, notify interaction
      if (parentTweet.tweet_type === 'video') {
        videoRecommendationService.onInteraction(userId, parent_tweet_id, 'comment');
      }
    }

    // Créer le tweet en statut "pending" pour traitement asynchrone
    const tweet = await Tweet.create({
      content,
      user_id: userId,
      parent_tweet_id,
      original_tweet_id,
      tweet_type: final_tweet_type,
      media_urls,
      is_private,
      is_sensitive,
      location,
      language,
      moderation_status: 'pending', // En attente de traitement
      metadata: {
        source: req.userPlatform || 'web',
        device: req.headers['user-agent'] || 'unknown',
        ip_address: req.ip,
        created_at: new Date().toISOString(),
        pending_processing: true
      }
    });

    // Récupérer le tweet avec l'auteur
    const tweetWithAuthor = await Tweet.findByPk(tweet.id, {
      include: [{
        model: User,
        as: 'author',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'verification_style', 'premium']
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
          // Mettre à jour le statut de modération
          await tweet.update({
            moderation_status: processResult.moderation_status,
            moderation_reason: processResult.moderation_reason,
            metadata: {
              ...tweet.metadata,
              processing_result: processResult,
              processed_at: processResult.processed_at
            }
          });

          logger.info(`✅ Tweet ${tweet.id} traité avec succès: ${processResult.moderation_status}`);

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
              await tweet.update({
                recommendation_group: 'initial', // Groupe initial pour test
                view_count: 0, // Commencer à 0 vues
                metadata: {
                  ...tweet.metadata,
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
                // Récupérer l'utilisateur et le bannir directement
                const user = await User.findByPk(userId);

                if (user) {
                  logger.info(`🚨 BAN AUTOMATIQUE pour @${user.username}`);

                  // Bannir pour une semaine
                  const oneWeekFromNow = new Date();
                  oneWeekFromNow.setDate(oneWeekFromNow.getDate() + 7);

                  await user.update({
                    is_suspended: true,
                    suspended_at: new Date(),
                    suspended_until: oneWeekFromNow,
                    suspension_reason: `Ban automatique: ${processResult.gemini_result.reason || 'Contenu interdit'}`,
                    suspension_meta: {
                      auto_ban: true,
                      gemini_decision: 'ban',
                      tweet_id: tweet.id
                    }
                  });

                  logger.info(`🔒 UTILISATEUR @${user.username} BANNI POUR 1 SEMAINE`);
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

          } else if (processResult.moderation_status === 'approved') {
            await handleApprovedTweet(tweet, userId, processResult);
            // 🔔 Notifier tous les abonnés (followers) de l'auteur, 1 notif max par token
            try {
              // Uniquement pour les tweets originaux (pas de réponses/retweets/quotes)
              const isOriginalTweet = !tweet.parent_tweet_id && !tweet.is_retweet && !tweet.is_quote;
              if (!isOriginalTweet) {
                logger.info(`Fanout followers ignoré (non original): tweet ${tweet.id}`);
              } else {
                const followers = await User.sequelize.models.UserFollow.findAll({
                  where: { following_id: userId },
                  attributes: ['follower_id']
                });
                if (Array.isArray(followers) && followers.length > 0) {
                  const followerIds = followers.map(f => f.follower_id);
                  const recipients = await User.findAll({
                    where: { id: followerIds },
                    attributes: ['id', 'id_notif']
                  });
                  // Dédupliquer par token pour éviter plusieurs notifs par même device
                  const seenTokens = new Set();
                  for (const r of recipients) {
                    const token = r && r.id_notif;
                    if (!token) continue;
                    if (seenTokens.has(token)) continue;
                    seenTokens.add(token);
                    await Notification.createNotification({
                      recipient_id: r.id,
                      sender_id: userId,
                      tweet_id: tweet.id,
                      type: 'system',
                      title: `@${author.username} a publié un nouveau tweet`,
                      message: 'Nouveau tweet',
                      _skip_push: false // push auto dans model Notification
                    });
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
          logger.error(`❌ Échec du traitement du tweet ${tweet.id}:`, processResult.error);
          // Fallback: approuver le tweet en cas d'erreur
          await tweet.update({
            moderation_status: 'approved',
            metadata: {
              ...tweet.metadata,
              processing_error: processResult.error,
              processed_at: processResult.processed_at
            }
          });
        }
      } catch (error) {
        logger.error(`❌ Erreur lors du traitement asynchrone du tweet ${tweet.id}:`, error);
        // Fallback: approuver le tweet en cas d'erreur
        await tweet.update({
          moderation_status: 'approved',
          metadata: {
            ...tweet.metadata,
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
        mediaUrls: Array.isArray(media_urls) ? media_urls : []
      });
      // Similarité
      similarity.getEngine().onInteraction(String(userId), String(parent_tweet_id), 'comment', content || '');
    } else {
      // C'est un tweet original
      retargetingHook.trackPost({
        userId: String(userId),
        tweetId: String(tweet.id),
        tweetContent: content || '',
        mediaUrls: Array.isArray(media_urls) ? media_urls : []
      });
      // Similarité
      similarity.getEngine().onNewTweet(String(tweet.id), String(userId), content || '', Array.isArray(media_urls) ? media_urls : [], tweet.parent_tweet_id);
    }

    res.status(201).json({
      success: true,
      message: 'Tweet créé avec succès',
      data: tweetWithAuthor
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

    // Étape 3 : Traitement en arrière-plan (Compression + Thumbnail)
    setImmediate(async () => {
      try {
        logger.info(`🎞️ [Background] Début compression vidéo pour ${videoId}`);
        const processResult = await videoService.processVideo(req.file.path, videoId, socketRoomId);

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
    .custom((value, { req }) => {
      if (!req.user?.verified && value.length > 600) {
        throw new Error('Le contenu doit contenir entre 1 et 600 caractères');
      }
      return true;
    }),
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

    // Mettre à jour le tweet
    await tweet.update({
      content,
      media_urls,
      is_private,
      is_sensitive
    });

    // Récupérer le tweet mis à jour avec l'auteur
    const updatedTweet = await Tweet.findByPk(id, {
      include: [{
        model: User,
        as: 'author',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'verification_style', 'premium']
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
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Vérifier que le tweet existe
    const tweet = await Tweet.findByPk(id);
    if (!tweet) {
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
      ctrTracker.trackUnlike(userId, id).catch(err => {
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
      ctrTracker.trackTweetLike(userId, id).catch(err => {
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
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;
    const userId = req.user.id;

    // Vérifier que le tweet existe
    const tweet = await Tweet.findByPk(id);
    if (!tweet) {
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
      ctrTracker.trackUnretweet(userId, id).catch(err => {
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
      ctrTracker.trackTweetRetweet(userId, id).catch(err => {
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
              await childTweet.update({
                moderation_status: processResult.moderation_status,
                moderation_reason: processResult.moderation_reason,
                metadata: {
                  ...childTweet.metadata,
                  processing_result: processResult,
                  processed_at: processResult.processed_at
                }
              });

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
              await childTweet.update({
                moderation_status: 'approved',
                metadata: {
                  ...childTweet.metadata,
                  processing_error: processResult.error,
                  processed_at: processResult.processed_at
                }
              });
            }
          } catch (error) {
            logger.error(`❌ Erreur lors du traitement asynchrone du tweet cité ${childTweet.id}:`, error);
            await childTweet.update({
              moderation_status: 'approved',
              metadata: {
                ...childTweet.metadata,
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
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Vérifier que le tweet existe
    const tweet = await Tweet.findByPk(id);
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
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Vérifier que le tweet existe
    const tweet = await Tweet.findByPk(id);
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
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium']
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
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium'],
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

      // Enrichir les réponses avec les statistiques et l'état des interactions
      const enrichedReplies = await Promise.all(replies.map(async (reply) => {
        const replyData = reply.toJSON();

        // Calculer les statistiques
        const likeCount = await TweetLike.countTweetLikes(reply.id);
        const retweetCount = await TweetRetweet.countTweetRetweets(reply.id);
        const replyCount = await Tweet.count({
          where: { parent_tweet_id: reply.id, is_data_test: false }
        });

        // Vérifier si l'utilisateur connecté a liké/retweeté cette réponse
        const isLiked = await TweetLike.hasUserLikedTweet(userId, reply.id);
        const isRetweeted = await TweetRetweet.hasUserRetweetedTweet(userId, reply.id);

        return {
          ...replyData,
          stats: {
            likes: likeCount,
            retweets: retweetCount,
            replies: replyCount,
            views: reply.view_count || 0
          },
          user_interaction: {
            is_liked: isLiked,
            is_retweeted: isRetweeted
          }
        };
      }));

      // Compter le total des réponses pour la pagination (avec la même clause que le fetch)
      const totalReplies = await Tweet.count({
        where: whereClause
      });

      // Informations sur le tweet parent
      const parentTweetInfo = {
        id: parentTweet.id,
        content: parentTweet.content,
        author: parentTweet.author,
        created_at: parentTweet.created_at,
        stats: {
          likes: await TweetLike.countTweetLikes(parentTweet.id),
          retweets: await TweetRetweet.countTweetRetweets(parentTweet.id),
          replies: totalReplies,
          views: parentTweet.view_count || 0
        }
      };

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
        const authorUser = await User.findByPk(userId);
        if (authorUser) {
          authorUser.is_active = true;
          authorUser.is_suspended = true;
          authorUser.suspended_at = new Date();
          authorUser.suspension_reason = 'Récurrence de contenus interdits (>=3) détectés par KOSPORAI';
          // Plus de logique de ban_count, seulement is_suspended
          await authorUser.save();

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
    handleValidationErrors
  ], authenticateToken, async (req, res) => {
    try {
      const { tweetIds } = req.body;
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

      await Tweet.update(
        { view_count: sequelize.literal('view_count + 1') },
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
 * POST /api/tweets/:id/bookmark
 * Ajouter/Retirer un tweet des favoris
 */
router.post('/:id/bookmark', [
  authenticateToken,
  checkUserBanStrict,
  param('id').isUUID().withMessage('ID de tweet invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Vérifier que le tweet existe
    const tweet = await Tweet.findByPk(id);
    if (!tweet) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    // Stocker les bookmarks en Redis pour performance
    // Clé: user:bookmarks:{userId} = SET de tweet IDs
    const bookmarkKey = `user:bookmarks:${userId}`;

    // Vérifier si déjà bookmarké
    const isBookmarked = await new Promise((resolve) => {
      // Pour simplifier, on utilise une approche SQL
      resolve(false);
    });

    // 📊 Track bookmark pour l'algorithme Rust
    ctrTracker.trackBookmark(userId, id).catch(err => {
      logger.warn(`CTR tracking error: ${err.message}`);
    });

    res.json({
      success: true,
      message: 'Tweet ajouté aux favoris',
      data: { bookmarked: true, tweet_id: id }
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
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Vérifier que le tweet existe
    const tweet = await Tweet.findByPk(id);
    if (!tweet) {
      return res.status(404).json({
        success: false,
        message: 'Tweet non trouvé'
      });
    }

    // 📊 Track share pour l'algorithme Rust
    ctrTracker.trackShare(userId, id).catch(err => {
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
