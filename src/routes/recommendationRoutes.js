const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const similarity = require('../services/similarity');
const { Tweet, User, UserFollow, TweetLike, TweetRetweet } = require('../models');
const { Op, fn, col, literal } = require('sequelize');
const { ultraSafeClean } = require('../utils/circularRefCleaner');
const { filterVisibleTweets } = require('../utils/privateAccountVisibility');
const { targetingService } = require('../../../targeting');

// ═══════════════════════════════════════════════════════════════════
// ALGORITHME DE SIMILARITÉ V2 — MULTI-SIGNAL + PAGINATION RÉELLE
// ═══════════════════════════════════════════════════════════════════

/**
 * Helper : formater la réponse avec PAGINATION RÉELLE.
 * Le pool est la taille réelle du cache de recommandations pour ce user.
 */
function formatResponse(tweets, limit, offset, algorithm, poolSize) {
  const parsedLimit = parseInt(limit) || 10;
  const parsedOffset = parseInt(offset) || 0;

  // Pagination réelle basée sur le pool effectif
  const total = poolSize || tweets.length;
  const hasMore = (parsedOffset + parsedLimit) < total;

  return {
    recommendations: tweets,
    pagination: {
      limit: parsedLimit,
      offset: parsedOffset,
      total,
      hasMore,
      totalPages: Math.ceil(total / parsedLimit),
      currentPage: Math.floor(parsedOffset / parsedLimit) + 1,
    },
    algorithm: algorithm || 'similarity_v2_multisignal',
    metadata: {
      pipeline: 'Content + Collab + FollowGraph + Trending + Freshness + Discovery + Language',
      version: '2.0.0',
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Enrichissement batch ultra-rapide.
 * Élimine les N+1 queries : 2-3 queries batch au lieu de 5*N queries individuelles.
 */
async function batchEnrichTweets(userId, dbTweets, engineRecos) {
  if (dbTweets.length === 0) return [];

  const tweetIds = dbTweets.map(t => t.id);
  const dbTweetsMap = {};
  for (const t of dbTweets) dbTweetsMap[t.id] = t;

  // ── BATCH 1 : Likes du user + counts par tweet ──
  const [userLikes, likeCounts] = await Promise.all([
    TweetLike.findAll({
      where: { user_id: userId, tweet_id: { [Op.in]: tweetIds } },
      attributes: ['tweet_id'],
      raw: true,
    }),
    TweetLike.findAll({
      attributes: ['tweet_id', [fn('COUNT', col('id')), 'cnt']],
      where: { tweet_id: { [Op.in]: tweetIds } },
      group: ['tweet_id'],
      raw: true,
    }),
  ]);

  const userLikedSet = new Set(userLikes.map(l => l.tweet_id));
  const likeCountMap = {};
  for (const row of likeCounts) likeCountMap[row.tweet_id] = parseInt(row.cnt) || 0;

  // ── BATCH 2 : Retweets du user + counts par tweet ──
  const [userRetweets, rtCounts] = await Promise.all([
    TweetRetweet.findAll({
      where: { user_id: userId, tweet_id: { [Op.in]: tweetIds } },
      attributes: ['tweet_id'],
      raw: true,
    }),
    TweetRetweet.findAll({
      attributes: ['tweet_id', [fn('COUNT', col('id')), 'cnt']],
      where: { tweet_id: { [Op.in]: tweetIds } },
      group: ['tweet_id'],
      raw: true,
    }),
  ]);

  const userRetweetedSet = new Set(userRetweets.map(r => r.tweet_id));
  const rtCountMap = {};
  for (const row of rtCounts) rtCountMap[row.tweet_id] = parseInt(row.cnt) || 0;

  // ── BATCH 3 : Reply counts ──
  const replyCounts = await Tweet.findAll({
    attributes: ['parent_tweet_id', [fn('COUNT', col('id')), 'cnt']],
    where: { parent_tweet_id: { [Op.in]: tweetIds } },
    group: ['parent_tweet_id'],
    raw: true,
  });

  const replyCountMap = {};
  for (const row of replyCounts) replyCountMap[row.parent_tweet_id] = parseInt(row.cnt) || 0;

  // ── Build score map from engine results ──
  const scoreMap = {};
  for (const r of engineRecos) scoreMap[r.tweetId] = r.score;

  // ── Assembler les tweets enrichis dans l'ordre de dbTweets ──
  const enrichedTweets = [];

  for (const dbTweet of dbTweets) {
    const tweetData = dbTweet.toJSON();
    tweetData.content = tweetData.content || '';

    const likes = likeCountMap[tweetData.id] || 0;
    const retweets = rtCountMap[tweetData.id] || 0;
    const replies = replyCountMap[tweetData.id] || 0;
    const isLiked = userLikedSet.has(tweetData.id);
    const isRetweeted = userRetweetedSet.has(tweetData.id);

    tweetData.user_interaction = { is_liked: isLiked, is_retweeted: isRetweeted };
    tweetData.stats = { likes, retweets, replies, views: tweetData.view_count || 0 };

    // Champs plats pour compatibilité mobile
    tweetData.like_count = likes;
    tweetData.retweet_count = retweets;
    tweetData.reply_count = replies;
    tweetData.is_liked = isLiked;
    tweetData.is_retweeted = isRetweeted;

    // Score IA: si pas dans engineRecos, on met une valeur par défaut (ex: 0.75)
    const aiScore = scoreMap[tweetData.id] || 0.75;
    tweetData.ai_score = aiScore;
    tweetData.score = aiScore;

    enrichedTweets.push(tweetData);
  }

  return enrichedTweets;
}

/**
 * Fonction centrale : obtenir les recommandations du moteur + enrichir par batch.
 */
/**
 * Enveloppe de `buildSimilarityRecommendations` qui retire les tweets des
 * comptes privés que ce lecteur ne suit pas.
 *
 * Posée ICI et pas dans chaque route : les quatre routes de fil (`/`,
 * `/following`, `/algorithm/:algorithm`, `/smart`) passent toutes par cette
 * fonction, et la fonction interne a une demi-douzaine de points de sortie
 * (court-circuit cache vide, retour anticipé sans pub, retour final…). Filtrer
 * au seul endroit par lequel tout le monde repasse est la seule façon de ne pas
 * en oublier un.
 */
async function getSimilarityRecommendations(userId, limit, offset, routeName, engineOptions = {}) {
  const result = await buildSimilarityRecommendations(userId, limit, offset, routeName, engineOptions);
  return {
    ...result,
    tweets: await filterVisibleTweets(result.tweets, userId, { User, UserFollow, Op }),
  };
}

async function buildSimilarityRecommendations(userId, limit, offset, routeName, engineOptions = {}) {
  try {
    const engine = similarity.getEngine();

    // Si moteur pas prêt
    if (!engine._initialized) {
      logger.info(`📋 [Similarity V2] Moteur en cours d'init, retour vide`);
      return { tweets: [], poolSize: 0 };
    }

    logger.info(`✨ [SIMILARITY V2] Recos pour ${userId} (${routeName}) — offset=${offset} limit=${limit}`);

    // 1. Obtenir les recommandations du moteur en mémoire (< 15ms)
    const mergedOptions = { offset: parseInt(offset), ...engineOptions };
    const engineRecos = engine.getRecommendations(userId, parseInt(limit), mergedOptions);

    if (!engineRecos || engineRecos.length === 0) {
      return { tweets: [], poolSize: engine.getCachedPoolSize(userId, engineOptions) };
    }

    const tweetIds = engineRecos.map(r => r.tweetId);

    // 2. Fetcher les tweets complets depuis PostgreSQL (1 seule query)
    let dbTweets = await Tweet.findAll({
      where: { id: { [Op.in]: tweetIds }, deleted_at: null },
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'profile_customization'],
          where: { is_active: true },
        },
        {
          model: Tweet,
          as: 'originalTweet',
          include: [{ model: User, as: 'author', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'profile_customization'] }],
        },
      ],
    });

    // --- 3. LIMITATION DES RÉPONSES ET INJECTION DES PARENTS ---
    const dbTweetsMap = new Map();
    dbTweets.forEach(t => dbTweetsMap.set(t.id, t));

    const processedTweets = [];
    let repliesCount = 0;
    const missingParentIds = new Set();
    const recommendedParentIds = new Set();

    // 3.a. Filtrer les réponses (max 3 max par page) et conserver l'ordre de l'IA (engineRecos)
    for (const reco of engineRecos) {
      const tweet = dbTweetsMap.get(reco.tweetId);
      if (!tweet) continue;

      if (tweet.parent_tweet_id) { // C'est une réponse
        if (repliesCount >= 3) {
          continue; // On ignore les autres réponses (limite max atteinte)
        }
        repliesCount++;
        // Noter si on doit fetcher le parent en base de données
        if (!dbTweetsMap.has(tweet.parent_tweet_id)) {
          missingParentIds.add(tweet.parent_tweet_id);
        }
      } else {
        recommendedParentIds.add(tweet.id);
      }
      processedTweets.push(tweet);
    }

    // 3.b. Récupérer les parents manquants
    let parentTweetsMap = new Map();
    if (missingParentIds.size > 0) {
      const dbParents = await Tweet.findAll({
        where: { id: { [Op.in]: Array.from(missingParentIds) }, deleted_at: null },
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'profile_customization'],
            where: { is_active: true },
          },
          {
            model: Tweet,
            as: 'originalTweet',
            include: [{ model: User, as: 'author', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'profile_customization'] }],
          },
        ],
      });
      dbParents.forEach(p => parentTweetsMap.set(p.id, p));
    }

    // 3.c. Si aucune réponse n'a été trouvée par l'algo, et qu'au moins 2 tweets recommandés
    // ont des réponses, on ajoute une réponse (limité à 3 max par le reste du code)
    let extraRepliesMap = new Map();
    if (repliesCount === 0 && recommendedParentIds.size > 0) {
      const potentialReplies = await Tweet.findAll({
        where: { parent_tweet_id: { [Op.in]: Array.from(recommendedParentIds) }, deleted_at: null },
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'profile_customization'],
            where: { is_active: true },
          },
          {
            model: Tweet,
            as: 'originalTweet',
            include: [{ model: User, as: 'author', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'profile_customization'] }],
          },
        ],
        order: [['created_at', 'ASC']],
      });

      for (const reply of potentialReplies) {
        if (!extraRepliesMap.has(reply.parent_tweet_id)) {
           extraRepliesMap.set(reply.parent_tweet_id, reply);
        }
      }

      // Si moins de 2 tweets recommandés ont reçu des réponses, on n'ajoute rien
      if (extraRepliesMap.size < 2) {
        extraRepliesMap.clear();
      }
    }

    // 3.d. Placer explicitement le tweet parent au-dessus de la réponse
    const finalOrderedDbTweets = [];
    const addedIds = new Set();

    for (const tweet of processedTweets) {
      if (addedIds.has(tweet.id)) continue; // Eviter les doublons

      // Si c'est une réponse, on intègre son parent juste au-dessus !
      if (tweet.parent_tweet_id) {
        const parent = dbTweetsMap.get(tweet.parent_tweet_id) || parentTweetsMap.get(tweet.parent_tweet_id);
        if (parent && !addedIds.has(parent.id)) {
          // On rajoute manuellement l'id du parent au dessus pour la barre blanche.
          // Le front réagira automatiquement au fil de discussion.
          finalOrderedDbTweets.push(parent);
          addedIds.add(parent.id);
        }
      }

      finalOrderedDbTweets.push(tweet);
      addedIds.add(tweet.id);

      // Si ce tweet est un parent et qu'une réponse extra a été récupérée
      if (!tweet.parent_tweet_id && extraRepliesMap.has(tweet.id) && repliesCount < 3) {
        const extraReply = extraRepliesMap.get(tweet.id);
        if (!addedIds.has(extraReply.id)) {
          finalOrderedDbTweets.push(extraReply);
          addedIds.add(extraReply.id);
          repliesCount++;
        }
      }
    }
    
    dbTweets = finalOrderedDbTweets; // Redéfinir la variable

    // 4. Enrichissement batch sur les tweets réordonnés
    const enrichedTweets = await batchEnrichTweets(userId, dbTweets, engineRecos);

    // 4. INJECTION DE PUBLICITÉ CIBLÉE IA (intensité configurable via adIntensityPct)
    try {
      if (targetingService && enrichedTweets.length >= 3) {
        const algoConfig = similarity.getAlgorithmConfig?.() || {};
        const adIntensityPctRaw = Number(algoConfig.adIntensityPct);
        const adIntensityPct = Number.isFinite(adIntensityPctRaw)
          ? Math.max(0, Math.min(500, adIntensityPctRaw))
          : 100;
        const organicCount = enrichedTweets.length;

        // Échelle explicite attendue côté produit:
        // 100% = 1 pub / 10 tweets ; 500% = 1 pub / 1 tweet (après chaque tweet).
        const desiredInterval = Math.max(
          1,
          Math.round(
            10 - ((adIntensityPct - 100) / 400) * 9
          )
        );
        const neededAds = Math.max(0, Math.floor(organicCount / desiredInterval));

        if (neededAds <= 0) {
          const poolSize = engine.getCachedPoolSize(userId, engineOptions);
          return { tweets: enrichedTweets, poolSize };
        }
        
        let ads = [];
        if (typeof targetingService.getRelevantAdsForUser === 'function') {
           ads = targetingService.getRelevantAdsForUser(userId, neededAds);
        } else if (targetingService.getRelevantAdForUser) {
           const singleAd = targetingService.getRelevantAdForUser(userId);
           if (singleAd) ads.push(singleAd);
        }
        
        if (ads && ads.length > 0) {
          // Extraire et charger les informations des utilisateurs auteurs des pubs
          const userIds = [...new Set(ads.map(ad => ad.user_id))];
          let userMap = {};
          try {
            const { User } = require('../models');
            const adUsers = await User.findAll({ 
              where: { id: userIds },
              attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'profile_customization']
            });
            adUsers.forEach(u => { userMap[u.id] = u.toJSON(); });
          } catch(e) {
            logger.error('Erreur chargement utilisateurs des pubs:', e.message);
          }

          const targetAds = neededAds;
          let adIndex = 0;

          // Répartition régulière selon l'intervalle visé.
          // Si peu de pubs éligibles, on recycle la liste (modulo) pour tenir la densité demandée.
          for (let slot = 1; slot <= targetAds; slot++) {
             const basePos = slot * desiredInterval - 1;
             const insertPos = Math.max(0, Math.min(enrichedTweets.length, basePos + adIndex));
             const ad = ads[adIndex % ads.length];
             const mediaArray = ad.image_url ? [ad.image_url] : [];
             
             const fallbackAuthor = {
                 id: ad.user_id,
                 username: 'Sponsorise',
                 full_name: 'Publicité Ciblée',
                 avatar: null,
                 verified: true,
                 verification_style: 'gold',
                 premium: true
             };

             const adTweet = {
               id: `ad-${ad.id}`,
               is_ad: true,
               content: ad.text_content || '',
               media_urls: JSON.stringify(mediaArray),
               created_at: ad.created_at || new Date().toISOString(),
               author: userMap[ad.user_id] || fallbackAuthor,
               like_count: 0,
               retweet_count: 0,
               reply_count: 0,
               is_liked: false,
               is_retweeted: false,
               stats: { likes: 0, retweets: 0, replies: 0, views: ad.current_views },
               ad_data: { 
                 id: ad.id,
                 max_views: ad.max_views,
                 current_views: ad.current_views,
                 redirect_url: ad.redirect_url || null
               }
             };

             enrichedTweets.splice(insertPos, 0, adTweet);
             
             // On enregistre la vue immédiatement
             targetingService.recordAdMetric(ad.id, 'view');
             adIndex++;
          }
        }
      }
    } catch (adError) {
      logger.error('❌ Erreur injection publicité:', adError.message);
    }

    const poolSize = engine.getCachedPoolSize(userId, engineOptions);

    return { tweets: enrichedTweets, poolSize };
  } catch (err) {
    logger.error(`❌ Erreur dans getSimilarityRecommendations: ${err.message}`);
    return { tweets: [], poolSize: 0 };
  }
}

/**
 * Fallback d'urgence : tweets récents avec enrichissement batch.
 */
async function getFallbackTweets(userId, limit, offset = 0) {
  try {
    const tweets = await Tweet.findAll({
      where: {
        deleted_at: null,
        parent_tweet_id: null,
      },
      include: [{
        model: User,
        as: 'author',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'profile_customization'],
        where: { is_active: true },
      }],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset) || 0,
    });

    if (tweets.length === 0) return [];

    // Le fallback d'urgence sert des tweets récents SANS passer par le moteur :
    // il doit donc refaire lui-même le tri des comptes privés, sinon une panne
    // du moteur de similarité devient une fuite de confidentialité.
    const visible = await filterVisibleTweets(
      tweets.map(t => t.toJSON()),
      userId,
      { User, UserFollow, Op },
    );
    if (visible.length === 0) return [];

    // Enrichissement batch même pour le fallback
    const tweetIds = visible.map(t => t.id);

    const [userLikes, likeCounts, userRetweets, rtCounts, replyCounts] = await Promise.all([
      userId ? TweetLike.findAll({ where: { user_id: userId, tweet_id: { [Op.in]: tweetIds } }, attributes: ['tweet_id'], raw: true }) : [],
      TweetLike.findAll({ attributes: ['tweet_id', [fn('COUNT', col('id')), 'cnt']], where: { tweet_id: { [Op.in]: tweetIds } }, group: ['tweet_id'], raw: true }),
      userId ? TweetRetweet.findAll({ where: { user_id: userId, tweet_id: { [Op.in]: tweetIds } }, attributes: ['tweet_id'], raw: true }) : [],
      TweetRetweet.findAll({ attributes: ['tweet_id', [fn('COUNT', col('id')), 'cnt']], where: { tweet_id: { [Op.in]: tweetIds } }, group: ['tweet_id'], raw: true }),
      Tweet.findAll({ attributes: ['parent_tweet_id', [fn('COUNT', col('id')), 'cnt']], where: { parent_tweet_id: { [Op.in]: tweetIds } }, group: ['parent_tweet_id'], raw: true }),
    ]);

    const userLikedSet = new Set((userLikes || []).map(l => l.tweet_id));
    const userRetweetedSet = new Set((userRetweets || []).map(r => r.tweet_id));
    const likeMap = {}; for (const r of likeCounts) likeMap[r.tweet_id] = parseInt(r.cnt) || 0;
    const rtMap = {}; for (const r of rtCounts) rtMap[r.tweet_id] = parseInt(r.cnt) || 0;
    const replyMap = {}; for (const r of replyCounts) replyMap[r.parent_tweet_id] = parseInt(r.cnt) || 0;

    return visible.map(td => {
      const likes = likeMap[td.id] || 0;
      const retweets = rtMap[td.id] || 0;
      const replies = replyMap[td.id] || 0;
      const isLiked = userLikedSet.has(td.id);
      const isRetweeted = userRetweetedSet.has(td.id);

      return {
        ...td,
        user_interaction: { is_liked: isLiked, is_retweeted: isRetweeted },
        stats: { likes, retweets, replies, views: td.view_count || 0 },
        like_count: likes,
        retweet_count: retweets,
        reply_count: replies,
        is_liked: isLiked,
        is_retweeted: isRetweeted,
        score: 0.5,
        ai_score: 0.5,
      };
    });
  } catch (err) {
    logger.error('❌ Fallback DB error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────

// Route GET /api/recommendations
router.get('/', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 10, offset = 0 } = req.query;

    const parsedLimit = Math.min(parseInt(limit) || 10, 10);
    const parsedOffset = parseInt(offset) || 0;

    const { tweets, poolSize } = await getSimilarityRecommendations(userId, parsedLimit, parsedOffset, '/api/recommendations');

    return res.json({
      success: true,
      data: formatResponse(tweets, parsedLimit, parsedOffset, 'similarity_v2_base', poolSize),
    });
  } catch (error) {
    logger.error('❌ Erreur Route Recommandations:', error);
    try {
      const fallbackTweets = await getFallbackTweets(req.user.id, 20);
      return res.json({ success: true, data: formatResponse(fallbackTweets, 20, 0, 'emergency_fallback', fallbackTweets.length) });
    } catch (e2) {
      return res.status(500).json({ success: false, error: 'Erreur serveur', details: error.message });
    }
  }
});

// Route GET /api/recommendations/following
router.get('/following', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 10, offset = 0 } = req.query;

    const parsedLimit = Math.min(parseInt(limit) || 10, 10);
    const parsedOffset = parseInt(offset) || 0;

    const { tweets, poolSize } = await getSimilarityRecommendations(
      userId, 
      parsedLimit, 
      parsedOffset, 
      '/api/recommendations/following', 
      { onlyFollowing: true }
    );

    return res.json({
      success: true,
      data: formatResponse(tweets, parsedLimit, parsedOffset, 'similarity_v2_following', poolSize),
    });
  } catch (error) {
    logger.error('❌ Erreur Route Following:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route GET /api/recommendations/algorithm/:algorithm
router.get('/algorithm/:algorithm', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { algorithm } = req.params;
    const { limit = 10, offset = 0 } = req.query;

    const parsedLimit = Math.min(parseInt(limit) || 10, 10);
    const parsedOffset = parseInt(offset) || 0;

    const { tweets, poolSize } = await getSimilarityRecommendations(userId, parsedLimit, parsedOffset, `/api/recommendations/algorithm/${algorithm}`);

    return res.json({
      success: true,
      data: formatResponse(tweets, parsedLimit, parsedOffset, 'similarity_v2_' + algorithm, poolSize),
    });
  } catch (error) {
    logger.error('❌ Erreur Route Recommandations IA (algorithm):', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route GET /api/recommendations/smart
router.get('/smart', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 10, offset = 0 } = req.query;

    const parsedLimit = Math.min(parseInt(limit) || 10, 10);
    const parsedOffset = parseInt(offset) || 0;

    const { tweets, poolSize } = await getSimilarityRecommendations(userId, parsedLimit, parsedOffset, '/api/recommendations/smart');

    const formattedData = formatResponse(tweets, parsedLimit, parsedOffset, 'similarity_v2_discovery', poolSize);
    formattedData.context = 'smart_discovery';

    return res.json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    logger.error('❌ Erreur Route Smart:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Route GET /api/recommendations/user-suggestions
 * Retourne des suggestions de comptes à suivre basées sur l'IA et le graphe social.
 */
router.get('/user-suggestions', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 15 } = req.query;
    const parsedLimit = Math.min(parseInt(limit) || 15, 50);

    const engine = similarity.getEngine();
    if (!engine._initialized) {
      return res.json({ success: true, data: [] });
    }

    const suggestions = await engine.getUserSuggestions(userId, parsedLimit);

    if (!suggestions || suggestions.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Enrichir avec les données DB (username, avatar, bio, etc.)
    // Les comptes privés sont écartés ICI et pas en aval : le moteur de
    // similarité ne connaît que des vecteurs et des arêtes, il ignore tout du
    // réglage de confidentialité. Un compte privé a demandé à n'être visible
    // que de ses abonnés — le suggérer à des inconnus est exactement ce qu'il
    // a refusé. Ces suggestions ne portant que sur des comptes non suivis, il
    // n'y a pas de cas « privé mais déjà abonné » à préserver.
    const suggestedUserIds = suggestions.map(s => s.userId);
    const dbUsers = await User.findAll({
      where: { id: { [Op.in]: suggestedUserIds }, is_private_account: false },
      attributes: ['id', 'username', 'full_name', 'avatar', 'bio', 'verified', 'verification_style', 'premium', 'stats', 'profile_customization'],
      raw: true
    });

    // Remapper et conserver l'ordre + ajouter les raisons
    const enrichedSuggestions = suggestions.map(s => {
      const dbUser = dbUsers.find(u => u.id === s.userId);
      if (!dbUser) return null;

      return {
        ...dbUser,
        suggestion_score: s.score,
        suggestion_reasons: s.reasons,
        mutual_follows_count: s.mutualFollowsCount,
        followers_count: dbUser.stats?.followers || 0
      };
    }).filter(Boolean);

    return res.json({
      success: true,
      data: enrichedSuggestions,
      metadata: {
        count: enrichedSuggestions.length,
        algorithm: 'semantic_social_fusion_v1',
        engine: 'E5-Base + Graph'
      }
    });
  } catch (error) {
    logger.error('❌ Erreur Route User Suggestions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;