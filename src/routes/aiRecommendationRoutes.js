/**
 * 🧠 AI Recommendation Routes — Routes utilisant le Deep Learning
 * 
 * Remplace les anciennes recommandations heuristiques par le pipeline IA :
 * TweetEncoder (BERT) → NCF → DeepRanker → FAISS
 * 
 * Endpoints :
 * GET  /api/ai-recommendations/         → Recommandations IA pour l'utilisateur connecté
 * GET  /api/ai-recommendations/similar/:tweetId → Tweets similaires
 * POST /api/ai-recommendations/feedback  → Enregistre le feedback utilisateur
 * GET  /api/ai-recommendations/stats     → Stats du moteur IA
 * POST /api/ai-recommendations/sync      → Sync interactions PostgreSQL → VectorStore
 * GET  /api/ai-recommendations/encode    → Encode un texte en vecteur
 */

const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const { getAIBridge } = require('../services/aiRecommendationBridge');
const { getVectorStore } = require('../services/vectorStoreService');
const { engagementTargetId } = require('../utils/engagementTarget');
const paidContentService = require('../services/paidContentService');

// ═══════════════════════════════════════════════════════════════════
// GET /api/ai-recommendations/
// Recommandations IA pour l'utilisateur authentifié
// ═══════════════════════════════════════════════════════════════════
router.get('/', authMiddleware.authenticateToken, async (req, res) => {
    try {
        const bridge = getAIBridge();
        if (!bridge.ready) {
            return res.status(503).json({
                success: false,
                error: 'Moteur IA temporairement indisponible (chargement en cours)',
                fallback: 'Utiliser /api/recommendations pour les recommandations heuristiques',
            });
        }

        const userId = req.user.id;
        const { limit = 20, topK } = req.query;
        const k = parseInt(topK || limit);

        logger.info(`🧠 [AI Reco] Demande IA pour user ${userId} (top_k=${k})`);
        const startTime = Date.now();

        // Appel au moteur IA Python
        const result = await bridge.recommend(String(userId), k);

        const responseTime = Date.now() - startTime;

        if (result.status === 'ok' && result.data) {
            const rawRecommendations = result.data.recommendations || result.data;
            const recommendationsArray = Array.isArray(rawRecommendations) ? rawRecommendations : [];
            const tweetIds = recommendationsArray.map(r => r.tweet_id || r.id).filter(Boolean);

            // Fetcher les tweets complets depuis PostgreSQL
            const { Tweet, User, TweetLike, TweetRetweet } = require('../models');
            const { Op } = require('sequelize');

            const dbTweets = await Tweet.findAll({
                where: { id: { [Op.in]: tweetIds }, deleted_at: null },
                include: [
                    {
                        model: User,
                        as: 'author',
                        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium'],
                        where: { is_active: true }
                    }
                ]
            });

            // Indexer les tweets par ID pour garder l'ordre de l'IA
            const dbMap = {};
            for (const t of dbTweets) dbMap[t.id] = t;

            const enrichedRecommendations = [];
            for (const rec of recommendationsArray) {
                const tId = rec.tweet_id || rec.id;
                const dbTweet = dbMap[tId];
                if (dbTweet) {
                    const tweetData = dbTweet.toJSON();

                    // Calculer les stats fraîches — sur un retweet pur, elles
                    // appartiennent au tweet d'origine, pas à la ligne retweet.
                    const sId = engagementTargetId(tweetData);

                    const [lCount, rtCount, repCount] = await Promise.all([
                        TweetLike.countTweetLikes(sId).catch(() => 0),
                        TweetRetweet.countTweetRetweets(sId).catch(() => 0),
                        Tweet.count({ where: { parent_tweet_id: sId } }).catch(() => 0)
                    ]);

                    const [isLiked, isRetweeted] = await Promise.all([
                        TweetLike.hasUserLikedTweet(userId, sId).catch(() => false),
                        TweetRetweet.hasUserRetweetedTweet(userId, sId).catch(() => false)
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

                    // Flat fields for compatibility
                    tweetData.like_count = lCount;
                    tweetData.retweet_count = rtCount;
                    tweetData.reply_count = repCount;
                    tweetData.is_liked = isLiked;
                    tweetData.is_retweeted = isRetweeted;
                    tweetData.ai_score = rec.score || rec.final_score;

                    enrichedRecommendations.push(tweetData);

                    // Feedback asynchrone pour le VectorStore
                    const vectorStore = getVectorStore();
                    vectorStore.recordInteraction(userId, tId, 'view', {
                        source: 'ai_recommendation',
                        score: rec.score || rec.final_score,
                    }).catch(() => {});
                }
            }

            // Contenus payants : le pipeline IA classe des vecteurs, pas des
            // droits d'accès. Masquage juste avant l'envoi, comme partout.
            if (!(await paidContentService.maskTweetsOrFail(enrichedRecommendations, userId, res))) return;

            res.json({
                success: true,
                data: {
                    recommendations: enrichedRecommendations,
                    algorithm: 'deep_learning',
                    pipeline: 'BERT → NCF → DeepRanker → FAISS',
                    responseTime,
                    total: enrichedRecommendations.length,
                    metadata: result.data.debug || result.data.metadata || {},
                    timestamp: new Date().toISOString(),
                },
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.message || 'Erreur du moteur IA',
            });
        }
    } catch (error) {
        logger.error(`❌ [AI Reco] Erreur: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/ai-recommendations/similar/:tweetId
// Tweets similaires via FAISS
// ═══════════════════════════════════════════════════════════════════
router.get('/similar/:tweetId', authMiddleware.authenticateToken, async (req, res) => {
    try {
        const bridge = getAIBridge();
        if (!bridge.ready) {
            return res.status(503).json({
                success: false,
                error: 'Moteur IA indisponible',
            });
        }

        const { tweetId } = req.params;
        const { topK = 10 } = req.query;

        logger.info(`🔗 [AI Reco] Tweets similaires à ${tweetId} (top_k=${topK})`);

        const result = await bridge.findSimilarTweets(String(tweetId), parseInt(topK));

        if (result.status === 'ok') {
            // L'index FAISS renvoie le texte des tweets sous sa propre forme
            // (`{ tweet_id, text }`), sans rien savoir des verrous : un contenu
            // vendu y serait lisible en clair. On applique donc la même règle
            // d'accès, sur les champs de cette forme-là.
            const similar = Array.isArray(result.data?.similar_tweets)
                ? result.data.similar_tweets
                : (Array.isArray(result.data?.results) ? result.data.results : []);

            try {
                const accessMap = await paidContentService.accessMapFor({
                    viewerId: req.user.id,
                    contentType: 'tweet',
                    contentIds: similar.map(item => item.tweet_id || item.id),
                });
                for (const item of similar) {
                    const entry = accessMap.get(String(item.tweet_id || item.id));
                    if (!entry || entry.hasAccess) continue;
                    item.text = entry.lock.preview_text || '';
                    item.is_locked = true;
                }
            } catch (maskError) {
                logger.error(`❌ [AI Reco] Masquage des contenus payants en échec: ${maskError.message}`);
                return res.status(500).json({ success: false, error: 'Erreur interne du serveur' });
            }

            res.json({
                success: true,
                data: {
                    source_tweet: tweetId,
                    similar_tweets: similar,
                    algorithm: 'FAISS_InnerProduct',
                    timestamp: new Date().toISOString(),
                },
            });
        } else {
            res.status(404).json({
                success: false,
                error: result.message || 'Tweet non trouvé dans l\'index FAISS',
            });
        }
    } catch (error) {
        logger.error(`❌ [AI Reco] Erreur similar: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/ai-recommendations/feedback
// Enregistre le feedback utilisateur dans le VectorStore
// ═══════════════════════════════════════════════════════════════════
router.post('/feedback', authMiddleware.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { tweetId, action, sessionId } = req.body;

        if (!tweetId || !action) {
            return res.status(400).json({
                success: false,
                error: 'tweetId et action sont requis',
            });
        }

        const validActions = ['like', 'dislike', 'retweet', 'share', 'bookmark', 'skip', 'view', 'click'];
        if (!validActions.includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'Action invalide',
                validActions,
            });
        }

        const vectorStore = getVectorStore();
        const interaction = await vectorStore.recordInteraction(userId, tweetId, action, {
            sessionId,
            source: 'user_feedback',
        });

        logger.info(`📝 [AI Reco] Feedback: user ${userId} → ${action} sur tweet ${tweetId}`);

        res.json({
            success: true,
            message: 'Feedback enregistré dans le VectorStore',
            data: interaction,
        });
    } catch (error) {
        logger.error(`❌ [AI Reco] Erreur feedback: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/ai-recommendations/encode
// Encode un texte en vecteur BERT
// ═══════════════════════════════════════════════════════════════════
router.get('/encode', authMiddleware.authenticateToken, async (req, res) => {
    try {
        const bridge = getAIBridge();
        if (!bridge.ready) {
            return res.status(503).json({
                success: false,
                error: 'Moteur IA indisponible',
            });
        }

        const { text } = req.query;
        if (!text) {
            return res.status(400).json({
                success: false,
                error: 'Paramètre "text" requis',
            });
        }

        const result = await bridge.encodeTweet(text);

        if (result.status === 'ok') {
            res.json({
                success: true,
                data: {
                    text: text.substring(0, 200),
                    embedding: result.data,
                    model: 'BERT Multilingual',
                    timestamp: new Date().toISOString(),
                },
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.message || 'Erreur encodage',
            });
        }
    } catch (error) {
        logger.error(`❌ [AI Reco] Erreur encode: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/ai-recommendations/stats
// Statistiques du moteur IA + VectorStore
// ═══════════════════════════════════════════════════════════════════
router.get('/stats', async (req, res) => {
    try {
        const bridge = getAIBridge();
        const vectorStore = getVectorStore();

        let aiStats = null;
        if (bridge.ready) {
            try {
                const result = await bridge.getStats();
                aiStats = result.status === 'ok' ? result.data : null;
            } catch (e) {
                aiStats = { error: e.message };
            }
        }

        res.json({
            success: true,
            data: {
                ai_bridge: {
                    ready: bridge.ready,
                    ...bridge.getBridgeStats(),
                },
                vector_store: vectorStore.getStats(),
                ai_engine: aiStats,
                timestamp: new Date().toISOString(),
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/ai-recommendations/sync
// Synchronise les interactions PostgreSQL → VectorStore
// ═══════════════════════════════════════════════════════════════════
router.post('/sync', authMiddleware.requireAdminRole, async (req, res) => {
    try {
        const vectorStore = getVectorStore();
        const models = require('../models');

        logger.info('🔄 [AI Reco] Début synchronisation interactions PostgreSQL → VectorStore');

        const result = await vectorStore.syncInteractionsFromDB(models);

        res.json({
            success: true,
            message: 'Synchronisation terminée',
            data: result,
        });
    } catch (error) {
        logger.error(`❌ [AI Reco] Erreur sync: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/ai-recommendations/user-profile/:userId
// Profil vectoriel d'un utilisateur
// ═══════════════════════════════════════════════════════════════════
router.get('/user-profile/:userId', authMiddleware.authenticateToken, async (req, res) => {
    try {
        const { userId } = req.params;
        const vectorStore = getVectorStore();

        const profile = await vectorStore.getUserVectorProfile(userId);

        if (!profile) {
            return res.status(404).json({
                success: false,
                error: 'Aucune interaction trouvée pour cet utilisateur',
            });
        }

        res.json({
            success: true,
            data: profile,
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
