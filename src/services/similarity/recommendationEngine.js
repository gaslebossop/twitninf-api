/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SIMILARITY RECOMMENDATION ENGINE V2 — Moteur de recommandation multi-signal
 *
 *  Architecture combinée (7 signaux) :
 *    ① Content-Based Filtering  → cosine(userVec, tweetVec)
 *    ② Collaborative Filtering  → tweets aimés par des users similaires
 *    ③ Follow Graph Boost       → tweets d'auteurs suivis / amis d'amis
 *    ④ Trending / Engagement    → tweets avec forte vélocité d'engagement
 *    ⑤ Freshness               → décroissance temporelle exponentielle
 *    ⑥ Discovery Pool          → nouveaux tweets à faible exposition
 *    ⑦ Language Match           → bonus si langue tweet = langue user
 *
 *  Score final (user existant) :
 *    score = α·content + β·collab + γ·follow + δ·trending
 *          + ε·freshness + ζ·discovery + η·language
 *
 *  Cold Start (nouveau user sans historique) :
 *    score = trending × 0.35 + authorPopularity × 0.25 + freshness × 0.20
 *          + diversity × 0.10 + language × 0.10
 *
 *  Post-processing :
 *    - Author diversity (max 3 tweets consécutifs du même auteur)
 *    - Hashtag diversity injection
 *    - Quality bonus (medias, longueur contenu)
 *
 *  Perf cible : < 15ms pour 50K tweets sur un VPS 2-core
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const path = require('path');
const {
  DIMS, createVec, vectorize, cosineSim, vecEWMA,
  vecAddWeighted, vecNormalize, topK, VectorStore
} = require('./vectorEngine');
const botDetectionService = require('../BotDetectionService');
const semanticSimilarityService = require('../semanticSimilarityService');

// ─────────────────────────────────────────────────────────────────────────────
//  Configuration algorithmique (runtime : applyAlgorithmConfig côté superadmin)
// ─────────────────────────────────────────────────────────────────────────────
function createDefaultAlgoConfig() {
  return {
    weights: {
      CONTENT: 0.25,
      COLLAB: 0.20,
      FOLLOW: 0.15,
      TRENDING: 0.12,
      FRESHNESS: 0.13,
      DISCOVERY: 0.10,
      LANGUAGE: 0.05,
    },
    coldStartWeights: {
      LIKES: 0.40,
      TRENDING: 0.15,
      POPULARITY: 0.15,
      FRESHNESS: 0.10,
      DIVERSITY: 0.10,
      LANGUAGE: 0.10,
    },
    interactionWeights: {
      post: 3.0,
      comment: 2.5,
      quote: 2.0,
      retweet: 1.5,
      like: 1.0,
    },
    similarUsersK: 50,
    discoveryWindowH: 72,
    discoveryMinRatio: 0.12,
    collabTweetLimit: 300,
    freshnessHalfLifeH: 18,
    trendingCacheTtlMs: 3 * 60 * 1000,
    velocityHighThreshold: 2.0,
    velocityMidThreshold: 0.5,
    maxSameAuthorWindow: 3,
    authorDiversityWindow: 15,
    adIntensityPct: 100,
  };
}

const SAVE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_CACHE_AGE_MS = 20 * 60 * 1000;
const CACHED_POOL_SIZE = 1500;
// Helper pour filtrer les tweets de test ou spam
function isSpamOrTest(content) {
  if (!content) return false;
  const words = content.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length < 4) {
    const lowerContent = content.toLowerCase();
    if (/\b(tg|test)\b/.test(lowerContent)) {
      return true;
    }
  }
  return false;
}

// Helper : extraire les hashtags d'un contenu
function extractHashtags(content) {
  if (!content) return [];
  const matches = content.match(/#[\w\u0590-\u05ff]+/g);
  return matches ? matches.map(h => h.toLowerCase()) : [];
}

// ═════════════════════════════════════════════════════════════════════════════

class SimilarityRecommendationEngine {

  constructor(dataDir = null) {
    this.dataDir = dataDir || path.join(__dirname, '..', '..', '..', 'data', 'similarity');

    this.algoConfig = JSON.parse(JSON.stringify(createDefaultAlgoConfig()));

    // Stores vectoriels
    this.tweetStore = new VectorStore('tweets', this.dataDir);
    this.userStore = new VectorStore('users', this.dataDir);

    // ── Méta-données tweets enrichies ──
    /** @type {Map<string, {authorId:string, createdAt:Date, viewCount:number, language:string, hashtags:string[], hasMedia:boolean, contentLen:number, engagement:{likes:number, retweets:number, replies:number, velocity:number}}>} */
    this.tweetMeta = new Map();

    // ── Données auteurs ──
    /** @type {Map<string, {followersCount:number, verified:boolean, premium:boolean, language:string}>} */
    this.authorMeta = new Map();

    // ── Graphe social ──
    /** @type {Map<string, Set<string>>} userId → Set<authorId> que l'user suit */
    this.followGraph = new Map();
    /** @type {Map<string, number>} authorId → nombre de followers */
    this.followerCounts = new Map();
    /** @type {Map<string, Set<string>>} authorId → Set<tweetId> tweets récents */
    this.authorTweets = new Map();

    // ── Hashtag Affinity ──
    /** @type {Map<string, Map<string, number>>} userId → Map<hashtag, affinityScore> */
    this.userHashtagAffinity = new Map();

    // ── Interactions utilisateur ──
    /** @type {Map<string, Set<string>>} userId → Set<tweetId> interagi */
    this.userInteractions = new Map();

    // ── Discovery Pool (tweets récents avec peu de vues) ──
    /** @type {Map<string, {tweetId:string, vec:Float32Array, createdAt:Date}>} */
    this.discoveryPool = new Map();

    // ── Trending Cache ──
    /** @type {{ts:number, list:Array<{tweetId:string, velocity:number}>}} */
    this._trendingCache = { ts: 0, list: [] };

    // ── Cache des recommandations ──
    /** @type {Map<string, {ts:number, results:any[], poolSize:number}>} */
    this.recoCache = new Map();

    // ── User language cache ──
    /** @type {Map<string, string>} userId → language */
    this.userLanguage = new Map();

    // ── Stats ──
    this.stats = {
      totalRecommendations: 0,
      avgRecoMs: 0,
      cacheHits: 0,
      coldStartServed: 0,
      indexBuilds: 0,
      interactionsRecorded: 0,
      lastBuildMs: 0,
    };

    /** @type {Map<string, number>} userId → 0–1 (1 = normal, 0 = hors fil algo) */
    this.authorVisibility = new Map();
    /** @type {Map<string, number>} hashtag → multiplicateur score */
    this.hashtagRules = new Map();
    this._sequelizeModels = null;

    // Timer de sauvegarde périodique
    this._saveTimer = null;
    this._syncTimer = null;
    this._initialized = false;
    this.lastSyncTs = new Date();
  }

  _normalizeTagForRule(h) {
    return String(h || '')
      .replace(/^#+/u, '')
      .toLowerCase()
      .trim();
  }

  async reloadShadowbanMaps() {
    const models = this._sequelizeModels;
    if (!models || !models.User) return;
    try {
      this.authorVisibility.clear();
      const users = await models.User.findAll({
        attributes: ['id', 'algorithmic_visibility_multiplier'],
        raw: true,
      });
      for (const r of users) {
        const v = Number(r.algorithmic_visibility_multiplier);
        if (Number.isFinite(v) && v !== 1) {
          this.authorVisibility.set(String(r.id), Math.max(0, Math.min(5, v)));
        }
      }
      this.hashtagRules.clear();
      if (models.FeedHashtagRule) {
        const rules = await models.FeedHashtagRule.findAll({ raw: true });
        for (const row of rules) {
          const tag = this._normalizeTagForRule(row.tag_normalized);
          const m = Number(row.multiplier);
          if (tag && Number.isFinite(m) && m > 0) {
            this.hashtagRules.set(tag, m);
          }
        }
      }
      console.log(
        `   🌓 Visibilité algo: ${this.authorVisibility.size} comptes, ${this.hashtagRules.size} règles hashtag`
      );
    } catch (err) {
      console.error('   ⚠️ reloadShadowbanMaps:', err.message);
    }
  }

  _applyShadowVisibilityToScore(tweetId, score) {
    const meta = this.tweetMeta.get(tweetId);
    if (!meta) return score;
    let authorM = this.authorVisibility.get(meta.authorId);
    if (authorM === undefined || authorM === null) authorM = 1;
    authorM = Math.max(0, Math.min(5, authorM));
    let tagM = 1;
    const seen = new Set();
    for (const h of meta.hashtags || []) {
      const key = this._normalizeTagForRule(h);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const hm = this.hashtagRules.get(key);
      if (hm != null && hm > 0) tagM *= hm;
    }
    // Plafond produit hashtags (ex. 5×5 si deux règles à +500 %)
    tagM = Math.min(tagM, 25);
    return score * authorM * tagM;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INITIALISATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initialise le moteur :
   * 1. Charge les index depuis le disque (binaire)
   * 2. Rebuild depuis PostgreSQL si les index sont vides
   * 3. Lance le timer de sauvegarde
   */
  async initialize(models = null) {
    try {
      this._sequelizeModels = models;
      const t0 = Date.now();

      // 0. Initialiser l'index sémantique global (indispensable pour Signal 1)
      await semanticSimilarityService.initialize();

      // 1. Charger les stores existants (Vector DB)
      const tSize = this.tweetStore.load();
      const uSize = this.userStore.load();

      // Toujours reconstruire les méta-données et le graphe (non persistés en binaire pour l'instant)
      // car ils sont rapides à charger (< 500ms pour 50K)
      await this._loadEnrichedMeta(models);

      if (tSize === 0 || uSize === 0 || process.env.REBUILD_SIMILARITY === 'true') {
        console.log('   🛠️  Index vide ou REBUILD_SIMILARITY=true, reconstruction...');
        await this.rebuildFromDB(models);
      } else {
        // Mode incrémental au démarrage : charger ce qui a été ajouté depuis le dernier arrêt
        await this.syncWithDB(models);
      }

      // Timer de sauvegarde (5 min)
      this._saveTimer = setInterval(() => this._periodicSave(), SAVE_INTERVAL_MS);

      // Timer de synchronisation incrémentale (1 heure)
      this._syncTimer = setInterval(() => this.syncWithDB(models), 60 * 60 * 1000);

      this._initialized = true;
      this.lastSyncTs = new Date();
      const elapsed = Date.now() - t0;
      console.log(`🚀 [Similarity V2] Moteur prêt en ${elapsed}ms (${this.tweetStore.size} tweets, ${this.userStore.size} users)`);
    } catch (err) {
      console.error('❌ [Similarity V2] Échec initialisation:', err);
    }
  }

  /**
   * Synchronisation incrémentale avec PostgreSQL.
   * Ajoute les nouveautés et gère les suppressions (recalcul des vecteurs).
   */
  async syncWithDB(models) {
    if (!models) models = this._sequelizeModels;
    if (!models) return;

    const t0 = Date.now();
    const { Tweet, TweetLike, TweetRetweet } = models;
    const { Op } = require('sequelize');
    const startTs = this.lastSyncTs || new Date(Date.now() - 3600000); // 1h par défaut si nul

    try {
      // 1. Nouveaux tweets
      const newTweets = await Tweet.findAll({
        where: { created_at: { [Op.gt]: startTs }, deleted_at: null },
        attributes: ['id', 'content', 'user_id', 'created_at', 'media_urls', 'parent_tweet_id', 'tweet_type'],
        raw: true
      });

      for (const t of newTweets) {
        await this.onNewTweet(t.id, t.user_id, t.content, t.media_urls, t.parent_tweet_id, null, t.tweet_type);
      }

      // 2. Nouvelles interactions (Likes, RT)
      const newLikes = await TweetLike.findAll({
        where: { created_at: { [Op.gt]: startTs } },
        raw: true
      });
      for (const l of newLikes) {
        this._recordInteractionInternal(String(l.user_id), String(l.tweet_id), 'like');
      }

      const newRTs = await TweetRetweet.findAll({
        where: { created_at: { [Op.gt]: startTs } },
        raw: true
      });
      for (const rt of newRTs) {
        this._recordInteractionInternal(String(rt.user_id), String(rt.tweet_id), rt.retweet_type || 'retweet');
      }

      // 3. Détection des suppressions (Sync simple)
      // On vérifie les utilisateurs actifs dans la dernière heure
      const activeUserIds = new Set([
        ...newLikes.map(l => String(l.user_id)),
        ...newRTs.map(rt => String(rt.user_id))
      ]);

      for (const uid of activeUserIds) {
        const dbLikeCount = await TweetLike.count({ where: { user_id: uid } });
        const memInteractions = this.userInteractions.get(uid);
        const memLikeCount = memInteractions ? memInteractions.size : 0;

        // Si moins de likes en DB qu'en mémoire, c'est qu'il y a eu un UNLIKE
        if (dbLikeCount < memLikeCount - 1) {
          await this.recalculateUserVector(uid, models);
        }
      }

      this.lastSyncTs = new Date();
      if (newTweets.length > 0 || newLikes.length > 0 || newRTs.length > 0) {
        console.log(`🔄 [Sync] Terminé en ${Date.now() - t0}ms (${newTweets.length} tweets, ${newLikes.length + newRTs.length} interactions)`);
      }
    } catch (err) {
      console.error('⚠️ [Sync] Erreur:', err.message);
    }
    return true;
  }

  /**
   * Recalcule le vecteur d'un utilisateur de zéro à partir de la DB.
   * Utile après des unlikes/suppressions massives.
   */
  async recalculateUserVector(userId, models) {
    if (!models) models = this._sequelizeModels;
    const { TweetLike, TweetRetweet, Tweet } = models;
    const { Op } = require('sequelize');

    try {
      userId = String(userId);
      this.userInteractions.delete(userId);
      this.userStore.delete(userId);

      // Re-charger les likes
      const likes = await TweetLike.findAll({ where: { user_id: userId }, attributes: ['tweet_id'], raw: true });
      for (const l of likes) this._recordInteractionInternal(userId, String(l.tweet_id), 'like');

      // Re-charger les RT
      const rts = await TweetRetweet.findAll({ where: { user_id: userId }, attributes: ['tweet_id', 'retweet_type'], raw: true });
      for (const rt of rts) this._recordInteractionInternal(userId, String(rt.tweet_id), rt.retweet_type || 'retweet');

      // Re-charger les comments
      const comments = await Tweet.findAll({ where: { user_id: userId, parent_tweet_id: { [Op.ne]: null }, deleted_at: null }, attributes: ['parent_tweet_id'], raw: true });
      for (const c of comments) this._recordInteractionInternal(userId, String(c.parent_tweet_id), 'comment');

      // Re-charger les posts
      const posts = await Tweet.findAll({ where: { user_id: userId, parent_tweet_id: null, deleted_at: null }, attributes: ['id'], raw: true });
      for (const p of posts) this._recordInteractionInternal(userId, String(p.id), 'post');

      console.log(`✨ [Recalculate] Vecteur rafraîchi pour @${userId}`);
      return true;
    } catch (err) {
      console.error(`⚠️ [Recalculate] Erreur pour ${userId}:`, err.message);
      return false;
    }
  }

  /**
   * Charge les métadonnées enrichies sans re-vectoriser (fast path).
   * Utilisé quand les index vectoriels existent déjà sur disque.
   */
  async _loadEnrichedMeta(models) {
    try {
      const { Tweet, TweetLike, TweetRetweet, User, UserFollow } = models;
      const { Op, fn, col, literal } = require('sequelize');

      // ── Tweets meta (sans re-vectoriser) ──
      const tweets = await Tweet.findAll({
        where: { deleted_at: null, content: { [Op.ne]: null } },
        attributes: ['id', 'content', 'user_id', 'created_at', 'view_count', 'media_urls', 'language', 'hashtags', 'parent_tweet_id', 'original_tweet_id', 'tweet_type'],
        raw: true,
        limit: 100000, // Augmenté pour éviter les coupures
      });

      for (const tweet of tweets) {
        if (isSpamOrTest(tweet.content)) continue;
        const hashtags = Array.isArray(tweet.hashtags)
          ? tweet.hashtags.map(h => h.toLowerCase())
          : extractHashtags(tweet.content);

        this.tweetMeta.set(tweet.id, {
          authorId: tweet.user_id,
          createdAt: new Date(tweet.created_at),
          viewCount: tweet.view_count || 0,
          language: tweet.language || 'fr',
          hashtags,
          hasMedia: Array.isArray(tweet.media_urls) && tweet.media_urls.length > 0,
          contentLen: (tweet.content || '').length,
          parentTweetId: tweet.parent_tweet_id,
          originalTweetId: tweet.original_tweet_id,
          type: tweet.tweet_type || 'tweet',
          engagement: { likes: 0, retweets: 0, replies: 0, velocity: 0 },
        });

        // Author tweets index
        if (!this.authorTweets.has(tweet.user_id)) this.authorTweets.set(tweet.user_id, new Set());
        this.authorTweets.get(tweet.user_id).add(tweet.id);

        // Discovery pool
        const age = Date.now() - new Date(tweet.created_at).getTime();
        if (age < this.algoConfig.discoveryWindowH * 3600000 && (tweet.view_count || 0) < 30) {
          const vec = this.tweetStore.get(tweet.id);
          if (vec) {
            this.discoveryPool.set(tweet.id, { tweetId: tweet.id, vec, createdAt: new Date(tweet.created_at) });
          }
        }
      }

      // ── Engagement counts (batch) ──
      await this._loadEngagementCounts(models);

      // ── Interactions (pour Signal 2 : Collaborative) ──
      console.log('   👤 Chargement des interactions historiques...');
      const allLikes = await TweetLike.findAll({ attributes: ['user_id', 'tweet_id'], raw: true });
      for (const l of allLikes) {
        const uid = String(l.user_id);
        if (!this.userInteractions.has(uid)) this.userInteractions.set(uid, new Set());
        this.userInteractions.get(uid).add(String(l.tweet_id));
      }

      const allRTs = await TweetRetweet.findAll({ attributes: ['user_id', 'tweet_id'], raw: true });
      for (const rt of allRTs) {
        const uid = String(rt.user_id);
        if (!this.userInteractions.has(uid)) this.userInteractions.set(uid, new Set());
        this.userInteractions.get(uid).add(String(rt.tweet_id));
      }

      // ── Author metadata ──
      await this._loadAuthorMeta(models);

      // ── Follow graph ──
      await this._loadFollowGraph(models);

      // ── User language ──
      await this._loadUserLanguages(models);

      // ── Hashtag affinities ──
      this._buildHashtagAffinities(tweets);

      console.log(`   📊 Meta enrichies chargées: ${this.tweetMeta.size} tweets, ${this.followGraph.size} follow graphs`);
    } catch (err) {
      console.error('   ⚠️ Erreur chargement meta enrichies:', err.message);
    }
  }

  /**
   * Charge les compteurs d'engagement par batch (élimine les N+1 queries).
   */
  async _loadEngagementCounts(models) {
    try {
      const { TweetLike, TweetRetweet, Tweet } = models;
      const { fn, col } = require('sequelize');

      // Likes par tweet (batch)
      const likeCounts = await TweetLike.findAll({
        attributes: ['tweet_id', [fn('COUNT', col('id')), 'cnt']],
        group: ['tweet_id'],
        raw: true,
      });
      for (const row of likeCounts) {
        const meta = this.tweetMeta.get(row.tweet_id);
        if (meta) meta.engagement.likes = parseInt(row.cnt) || 0;
      }

      // Retweets par tweet (batch)
      const rtCounts = await TweetRetweet.findAll({
        attributes: ['tweet_id', [fn('COUNT', col('id')), 'cnt']],
        group: ['tweet_id'],
        raw: true,
      });
      for (const row of rtCounts) {
        const meta = this.tweetMeta.get(row.tweet_id);
        if (meta) meta.engagement.retweets = parseInt(row.cnt) || 0;
      }

      // Replies par tweet parent (batch)
      const replyCounts = await Tweet.findAll({
        attributes: ['parent_tweet_id', [fn('COUNT', col('id')), 'cnt']],
        where: { parent_tweet_id: { [require('sequelize').Op.ne]: null } },
        group: ['parent_tweet_id'],
        raw: true,
      });
      for (const row of replyCounts) {
        const meta = this.tweetMeta.get(row.parent_tweet_id);
        if (meta) meta.engagement.replies = parseInt(row.cnt) || 0;
      }

      // Calculer la vélocité d'engagement pour chaque tweet
      const now = Date.now();
      for (const [tweetId, meta] of this.tweetMeta) {
        const totalEngagement = meta.engagement.likes + meta.engagement.retweets * 1.5 + meta.engagement.replies * 2;
        const ageHours = Math.max(1, (now - meta.createdAt.getTime()) / 3600000);
        meta.engagement.velocity = totalEngagement / ageHours;
      }

      console.log(`   📈 Engagement chargé: ${likeCounts.length} like groups, ${rtCounts.length} RT groups, ${replyCounts.length} reply groups`);
    } catch (err) {
      console.error('   ⚠️ Erreur chargement engagement:', err.message);
    }
  }

  /**
   * Charge les métadonnées des auteurs (followers, verified, etc).
   */
  async _loadAuthorMeta(models) {
    try {
      const { User } = models;
      const users = await User.findAll({
        where: { is_active: true },
        attributes: ['id', 'stats', 'verified', 'premium', 'is_suspended', 'suspended_until'],
        raw: true,
      });

      for (const user of users) {
        const stats = user.stats || {};
        this.authorMeta.set(user.id, {
          followersCount: parseInt(stats.followers) || 0,
          verified: !!user.verified,
          premium: !!user.premium,
          language: 'fr', // Default, User model n'a pas de champ language
          isSuspended: !!user.is_suspended,
          suspendedUntil: user.suspended_until ? new Date(user.suspended_until) : null
        });
        this.followerCounts.set(user.id, parseInt(stats.followers) || 0);
      }
      console.log(`   👤 ${users.length} profils auteurs chargés`);
    } catch (err) {
      console.error('   ⚠️ Erreur chargement author meta:', err.message);
    }
  }

  /**
   * Charge le graphe social (follows).
   */
  async _loadFollowGraph(models) {
    try {
      const { UserFollow } = models;
      if (!UserFollow) {
        console.log('   ⚠️ UserFollow model non disponible, skip follow graph');
        return;
      }

      const follows = await UserFollow.findAll({
        where: { status: 'active' },
        attributes: ['follower_id', 'following_id'],
        raw: true,
      });

      for (const f of follows) {
        if (!this.followGraph.has(f.follower_id)) {
          this.followGraph.set(f.follower_id, new Set());
        }
        this.followGraph.get(f.follower_id).add(f.following_id);
      }
      console.log(`   🔗 ${follows.length} relations de follow chargées`);
    } catch (err) {
      console.error('   ⚠️ Erreur chargement follow graph:', err.message);
    }
  }

  /**
   * Charge les langues préférées des utilisateurs.
   */
  async _loadUserLanguages(models) {
    try {
      // Le modèle User n'a pas de champ 'language' — on utilise la langue par défaut
      // et on peut la détecter via les tweets de l'utilisateur
      const { Tweet } = models;
      const { fn, col, Op } = require('sequelize');

      // Détecter la langue la plus fréquente des tweets de chaque user
      const langData = await Tweet.findAll({
        attributes: ['user_id', 'language', [fn('COUNT', col('id')), 'cnt']],
        where: { deleted_at: null, language: { [Op.ne]: null } },
        group: ['user_id', 'language'],
        order: [[fn('COUNT', col('id')), 'DESC']],
        raw: true,
      });

      // Garder la langue dominante par user
      const seen = new Set();
      for (const row of langData) {
        if (!seen.has(row.user_id)) {
          this.userLanguage.set(row.user_id, row.language || 'fr');
          seen.add(row.user_id);
        }
      }
      console.log(`   🌐 ${seen.size} langues utilisateur détectées`);
    } catch (err) {
      // Non-critique, tout le monde default à 'fr'
      console.log('   ⚠️ Langues non chargées (default fr)');
    }
  }

  /**
   * Construit les affinités hashtag des utilisateurs.
   */
  _buildHashtagAffinities(tweets) {
    // D'abord, construire un index tweet → hashtags
    const tweetHashtags = new Map();
    for (const tweet of tweets) {
      const hashtags = Array.isArray(tweet.hashtags)
        ? tweet.hashtags.map(h => h.toLowerCase())
        : extractHashtags(tweet.content);
      if (hashtags.length > 0) {
        tweetHashtags.set(tweet.id, hashtags);
      }
    }

    // Puis, pour chaque interaction utilisateur, accumuler les affinités
    for (const [userId, interactedTweets] of this.userInteractions) {
      const affinity = new Map();
      for (const tweetId of interactedTweets) {
        const hashtags = tweetHashtags.get(tweetId);
        if (!hashtags) continue;
        for (const h of hashtags) {
          affinity.set(h, (affinity.get(h) || 0) + 1);
        }
      }
      // Normaliser les affinités (0-1)
      if (affinity.size > 0) {
        const maxVal = Math.max(...affinity.values());
        for (const [h, v] of affinity) {
          affinity.set(h, v / maxVal);
        }
        this.userHashtagAffinity.set(userId, affinity);
      }
    }
  }

  /**
   * Reconstruit l'index complet depuis PostgreSQL.
   */
  async rebuildFromDB(models) {
    const t0 = Date.now();
    this.stats.indexBuilds++;

    try {
      const { Tweet, TweetLike, TweetRetweet, User, UserFollow } = models;
      const { Op, fn, col } = require('sequelize');

      // ── Tweets : vectoriser tous les tweets approuvés ──
      console.log('   📝 Chargement des tweets...');
      const tweets = await Tweet.findAll({
        where: {
          deleted_at: null,
          moderation_status: { [Op.in]: ['approved', 'pending'] },
          content: { [Op.ne]: null },
        },
        attributes: ['id', 'content', 'user_id', 'created_at', 'view_count', 'media_urls', 'language', 'hashtags', 'parent_tweet_id', 'tweet_type'],
        raw: true,
        order: [['created_at', 'DESC']],
        limit: 50000,
      });

      console.log(`   📝 ${tweets.length} tweets à vectoriser...`);
      let vectorized = 0;

      for (const tweet of tweets) {
        if (isSpamOrTest(tweet.content)) continue;

        let vec = vectorize(tweet.content);
        const hasMedia = Array.isArray(tweet.media_urls) && tweet.media_urls.length > 0;

        // Si la vectorisation échoue (ex: vidéo sans texte), on utilise un vecteur nul 
        // pour qu'elle puisse tout de même être recommandée par l'engagement (trending/collab/freshness)
        if (!vec) {
          if (hasMedia || tweet.tweet_type === 'video') {
            vec = new Float32Array(256); // ZERO vector (DIMS = 256)
          } else {
            continue;
          }
        }

        if (vec) {
          this.tweetStore.upsert(tweet.id, vec);

          const hashtags = Array.isArray(tweet.hashtags)
            ? tweet.hashtags.map(h => h.toLowerCase())
            : extractHashtags(tweet.content);

          this.tweetMeta.set(tweet.id, {
            authorId: tweet.user_id,
            createdAt: new Date(tweet.created_at),
            viewCount: tweet.view_count || 0,
            language: tweet.language || 'fr',
            hashtags,
            hasMedia: Array.isArray(tweet.media_urls) && tweet.media_urls.length > 0,
            contentLen: (tweet.content || '').length,
            parentTweetId: tweet.parent_tweet_id,
            type: tweet.tweet_type || 'tweet',
            engagement: { likes: 0, retweets: 0, replies: 0, velocity: 0 },
          });
          vectorized++;

          // Author tweets index
          if (!this.authorTweets.has(tweet.user_id)) this.authorTweets.set(tweet.user_id, new Set());
          this.authorTweets.get(tweet.user_id).add(tweet.id);

          // Discovery pool
          const age = Date.now() - new Date(tweet.created_at).getTime();
          if (age < this.algoConfig.discoveryWindowH * 3600000 && (tweet.view_count || 0) < 30) {
            this.discoveryPool.set(tweet.id, {
              tweetId: tweet.id,
              vec,
              createdAt: new Date(tweet.created_at),
            });
          }
        }
      }
      console.log(`   ✅ ${vectorized} tweets vectorisés (${tweets.length - vectorized} skipped)`);

      // ── Likes : construire les interactions + user vectors ──
      console.log('   ❤️ Chargement des likes...');
      const likes = await TweetLike.findAll({
        attributes: ['user_id', 'tweet_id'],
        raw: true,
        limit: 200000,  // ↑ de 100K
      });

      for (const like of likes) {
        this._recordInteractionInternal(like.user_id, like.tweet_id, 'like');
      }
      console.log(`   ❤️ ${likes.length} likes intégrés`);

      // ── Retweets ──
      console.log('   🔄 Chargement des retweets...');
      const retweets = await TweetRetweet.findAll({
        attributes: ['user_id', 'tweet_id', 'retweet_type'],
        raw: true,
        limit: 200000,  // ↑ de 100K
      });

      for (const rt of retweets) {
        const type = rt.retweet_type === 'quote' ? 'quote' : 'retweet';
        this._recordInteractionInternal(rt.user_id, rt.tweet_id, type);
      }
      console.log(`   🔄 ${retweets.length} retweets intégrés`);

      // ── Réponses (comments) ──
      console.log('   💬 Chargement des réponses...');
      const replies = await Tweet.findAll({
        where: { parent_tweet_id: { [Op.ne]: null }, deleted_at: null },
        attributes: ['user_id', 'parent_tweet_id'],
        raw: true,
        limit: 200000,
      });
      for (const reply of replies) {
        this._recordInteractionInternal(reply.user_id, reply.parent_tweet_id, 'comment');
      }
      console.log(`   💬 ${replies.length} réponses intégrées`);

      // ── Posts : associer les tweets aux auteurs ──
      for (const tweet of tweets) {
        if (tweet.content) {
          this._recordInteractionInternal(tweet.user_id, tweet.id, 'post');
        }
      }

      // ── Engagement counts (batch) ──
      await this._loadEngagementCounts(models);

      // ── Author metadata ──
      await this._loadAuthorMeta(models);

      // ── Follow graph ──
      await this._loadFollowGraph(models);

      // ── User languages ──
      await this._loadUserLanguages(models);

      // ── Hashtag affinities ──
      this._buildHashtagAffinities(tweets);

      // Sauvegarder
      this.tweetStore.save();
      this.userStore.save();

      const elapsed = Date.now() - t0;
      console.log(`   🏁 Rebuild V2 terminé en ${elapsed}ms`);

    } catch (err) {
      console.error('   ❌ Erreur rebuild:', err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INTERACTIONS EN TEMPS RÉEL
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Enregistre une interaction et met à jour le user vector en temps réel.
   */
  onInteraction(userId, tweetId, type, content = '') {
    // Vectoriser le tweet s'il n'est pas encore dans l'index
    if (!this.tweetStore.has(tweetId) && content) {
      const vec = vectorize(content);
      if (vec) {
        this.tweetStore.upsert(tweetId, vec);
      }
    }

    this._recordInteractionInternal(userId, tweetId, type);

    // Mettre à jour l'engagement en temps réel
    const meta = this.tweetMeta.get(tweetId);
    if (meta) {
      if (type === 'like') meta.engagement.likes++;
      else if (type === 'retweet' || type === 'quote') meta.engagement.retweets++;
      else if (type === 'comment') meta.engagement.replies++;
      // Recalculer la vélocité
      const ageHours = Math.max(1, (Date.now() - meta.createdAt.getTime()) / 3600000);
      const total = meta.engagement.likes + meta.engagement.retweets * 1.5 + meta.engagement.replies * 2;
      meta.engagement.velocity = total / ageHours;
    }

    // Mettre à jour l'affinité hashtag de l'user en temps réel
    if (meta && meta.hashtags && meta.hashtags.length > 0) {
      if (!this.userHashtagAffinity.has(userId)) {
        this.userHashtagAffinity.set(userId, new Map());
      }
      const affinity = this.userHashtagAffinity.get(userId);
      for (const h of meta.hashtags) {
        affinity.set(h, (affinity.get(h) || 0) + 0.1);
      }
    }

    this.stats.interactionsRecorded++;
  }

  /**
   * Enregistre un nouveau tweet et l'ajoute au discovery pool.
   */
  async onNewTweet(tweetId, userId, content, mediaUrls = [], parentTweetId = null, originalTweetId = null, tweetType = 'tweet') {
    if (isSpamOrTest(content)) return;

    // ⚠️ indexTweet() renvoie un Array JS ordinaire (Array.from(output.data) côté
    // embedder E5), alors que VectorStore travaille en Float32Array : sans cette
    // conversion, vec.buffer est undefined et c'est save() qui casse, pas l'insert.
    const rawVec = await semanticSimilarityService.indexTweet({ id: tweetId, content, parent_tweet_id: parentTweetId });
    const hasMedia = Array.isArray(mediaUrls) && mediaUrls.length > 0;

    let vec = null;
    if (rawVec && rawVec.length === DIMS) {
      vec = rawVec instanceof Float32Array ? rawVec : Float32Array.from(rawVec);
    } else if (rawVec && rawVec.length) {
      console.warn(`⚠️ [Similarity V2] Embedding de dimension ${rawVec.length} pour ${tweetId} (attendu ${DIMS}), ignoré`);
    }

    if (!vec) {
      if (hasMedia || tweetType === 'video') {
        vec = createVec(); // vecteur nul de dimension DIMS
      } else {
        return;
      }
    }

    // Ajouter à l'index vectoriel
    this.tweetStore.upsert(tweetId, vec);

    const hashtags = extractHashtags(content);

    // Meta enrichie
    this.tweetMeta.set(tweetId, {
      authorId: userId,
      createdAt: new Date(),
      viewCount: 0,
      language: this.userLanguage.get(userId) || 'fr',
      hashtags,
      hasMedia: Array.isArray(mediaUrls) && mediaUrls.length > 0,
      contentLen: (content || '').length,
      parentTweetId: parentTweetId,
      originalTweetId: originalTweetId,
      type: tweetType,
      engagement: { likes: 0, retweets: 0, replies: 0, velocity: 0 },
    });

    // Author tweets index
    if (!this.authorTweets.has(userId)) this.authorTweets.set(userId, new Set());
    this.authorTweets.get(userId).add(tweetId);

    // Discovery pool pour exposition
    this.discoveryPool.set(tweetId, { tweetId, vec, createdAt: new Date() });

    // Interaction "post"
    this._recordInteractionInternal(userId, tweetId, 'post');

    // 🚨 INVALIDER TOUS LES CACHES DE RECOMMANDATIONS
    // Pour que le prochain appel de chaque user regénère un feed incluant ce nouveau tweet
    this.recoCache.clear();
    console.log(`🧠 [onNewTweet] Tweet ${tweetId} ajouté au moteur + caches de recommandation invalidés`);
  }

  /**
   * Met à jour le graphe social en temps réel.
   */
  onFollow(followerId, followingId) {
    if (!this.followGraph.has(followerId)) {
      this.followGraph.set(followerId, new Set());
    }
    this.followGraph.get(followerId).add(followingId);
    // Incrémenter le follower count
    this.followerCounts.set(followingId, (this.followerCounts.get(followingId) || 0) + 1);
  }

  onUnfollow(followerId, followingId) {
    const following = this.followGraph.get(followerId);
    if (following) following.delete(followingId);
    const count = this.followerCounts.get(followingId) || 0;
    if (count > 0) this.followerCounts.set(followingId, count - 1);
  }

  /**
   * Interne : met à jour le user vector via EWMA.
   */
  _recordInteractionInternal(userId, tweetId, type) {
    // Enregistrer l'interaction
    if (!this.userInteractions.has(userId)) {
      this.userInteractions.set(userId, new Set());
    }
    // On n'ajoute pas les posts au set d'interactions collaboratives pour éviter le bruit
    if (type !== 'post') {
      this.userInteractions.get(userId).add(tweetId);
    }

    // Mettre à jour le user vector via le modèle sémantique (vecteur EWMA)
    const tweetVec = this.tweetStore.get(tweetId);
    if (!tweetVec) return;

    const weight = this.algoConfig.interactionWeights[type] || 1.0;
    let userVec = this.userStore.get(userId);

    if (!userVec) {
      // Première interaction : copier le tweet vec pondéré
      userVec = new Float32Array(DIMS);
      for (let i = 0; i < DIMS; i++) userVec[i] = tweetVec[i];
      vecNormalize(userVec);
      this.userStore.upsert(userId, userVec);
    } else {
      // EWMA update
      vecEWMA(userVec, tweetVec, weight);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRENDING ENGINE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Retourne les tweets trending, avec un cache de 3 minutes.
   * @returns {Array<{tweetId:string, velocity:number}>}
   */
  _getTrendingTweets(topN = 500) {
    const now = Date.now();
    if (now - this._trendingCache.ts < this.algoConfig.trendingCacheTtlMs && this._trendingCache.list.length > 0) {
      return this._trendingCache.list;
    }

    const candidates = [];
    for (const [tweetId, meta] of this.tweetMeta) {
      // Seulement les tweets des dernières 72h
      const ageMs = now - meta.createdAt.getTime();
      if (ageMs > this.algoConfig.discoveryWindowH * 3600000) continue;

      if (meta.engagement.velocity > 0.1) {
        candidates.push({ tweetId, velocity: meta.engagement.velocity });
      }
    }

    // Trier par vélocité desc
    candidates.sort((a, b) => b.velocity - a.velocity);
    const result = candidates.slice(0, topN);

    this._trendingCache = { ts: now, list: result };
    return result;
  }

  /**
   * Helper récursif pour trouver si le root d'un thread est une vidéo.
   */
  _isRootVideo(tweetId, depth = 0) {
    if (depth > 12) return false; // Protection récursion infinie
    const meta = this.tweetMeta.get(tweetId);
    if (!meta) return false;

    if (meta.type === 'video') return true;
    if (meta.parentTweetId) {
      return this._isRootVideo(meta.parentTweetId, depth + 1);
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECOMMANDATIONS — COEUR DE L'ALGORITHME V2
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Point d'entrée principal : retourne les recommandations pour un utilisateur.
   * Gère le cache, le cold start, et la pagination.
   *
   * @param {string} userId
   * @param {number} limit
   * @param {object} options - { offset, tweetType, onlyFollowing, forceRefresh }
   * @returns {Array<{tweetId, score, components}>}
   */
  getRecommendations(userId, limit = 50, options = {}) {
    const { offset = 0, tweetType, onlyFollowing = false, forceRefresh = false } = options;
    const cacheKey = `${userId}_${onlyFollowing ? 'following' : 'all'}_${tweetType || 'default'}`;

    // ── Vérifier le cache ──
    if (!forceRefresh) {
      const cached = this.recoCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts < 60000)) {
        // Cache valide (< 1 minute)
        return cached.feed.slice(offset, offset + limit);
      }
    }

    // ── Préparer les exclusions ──
    const seenTweets = new Set();
    const exclude = new Set();

    // ── Déterminer le type de feed ──
    const userVec = this.userStore.get(userId);
    const userInteractions = this.userInteractions.get(userId);
    const hasHistory = userVec || (userInteractions && userInteractions.size > 0);

    let feed;
    if (hasHistory) {
      feed = this._generateNormalFeed(userId, userVec, seenTweets, exclude, {
        tweetType,
        onlyFollowing,
      });
    } else {
      feed = this._generateColdStartFeed(userId, seenTweets, exclude, {
        tweetType,
        onlyFollowing,
      });
    }

    // ── Post-processing : diversité d'auteurs ──
    feed = this._applyAuthorDiversity(feed);

    // ── Mettre en cache ──
    this.recoCache.set(cacheKey, { ts: Date.now(), feed, poolSize: feed.length });

    return feed.slice(offset, offset + limit);
  }

  /**
   * Feed pour un utilisateur existant avec historique.
   */
  _generateNormalFeed(userId, userVec, seenTweets, exclude, options = {}) {
    const now = Date.now();
    const userLang = this.userLanguage.get(userId) || 'fr';
    const followedAuthors = this.followGraph.get(userId) || new Set();
    const hashtagAffinity = this.userHashtagAffinity.get(userId) || new Map();

    // ── Phase 1 : Candidats (multi-source) ──
    const scored = new Map();

    // 1a. Content-based candidates (top similaires au user vector via modèle sémantique)
    if (userVec) {
      for (const [tweetId, info] of semanticSimilarityService.index) {
        const tweetVec = info.vector;
        if (seenTweets.has(tweetId) || exclude.has(tweetId)) continue;
        const meta = this.tweetMeta.get(tweetId);
        if (!meta) continue;
        // Pour les vidéos, on garde ses propres contenus (TikTok-like)
        if (meta.authorId === userId && options.tweetType !== 'video') continue;

        // Filtrage strict par type (tweet classique vs vidéo)
        if (options.tweetType) {
          if (meta.type !== options.tweetType) continue;
        } else {
          if (meta.type === 'video') continue;
          // 🚓 NOUVEAU : Exclure TOUTES les réponses du fil de recommandation principal
          // (Comme dans le fil classique, on ne veut que des tweets originaux, retweets ou quotes)
          if (meta.type === 'reply' || meta.parentTweetId) continue;
        }

        // 🚓 FILTRAGE BANS : Exclure les auteurs suspendus
        const authorInfo = this.authorMeta.get(meta.authorId);
        if (authorInfo && authorInfo.isSuspended) continue;

        // Exclure les réponses ou retweets/quotes liés à des auteurs suspendus
        const referenceId = meta.parentTweetId || meta.originalTweetId;
        if (referenceId) {
          const refMeta = this.tweetMeta.get(referenceId);
          if (refMeta) {
            const refAuthorInfo = this.authorMeta.get(refMeta.authorId);
            if (refAuthorInfo && refAuthorInfo.isSuspended) continue;
          }
        }

        if (options.onlyFollowing && !followedAuthors.has(meta.authorId)) continue;

        const contentScore = cosineSim(userVec, tweetVec);
        scored.set(tweetId, {
          content: Math.max(0, contentScore),
          collab: 0, follow: 0, trending: 0,
          freshness: 0, discovery: 0, language: 0,
          quality: 0,
        });
      }
    } else {
      // User a un historique mais pas de vector → tous les tweets indexés sont candidats
      for (const [tweetId] of semanticSimilarityService.index) {
        if (seenTweets.has(tweetId) || exclude.has(tweetId)) continue;
        const meta = this.tweetMeta.get(tweetId);
        if (!meta) continue;
        if (meta.authorId === userId && options.tweetType !== 'video') continue;

        if (options.tweetType) {
          if (meta.type !== options.tweetType) continue;
        } else {
          if (meta.type === 'video') continue;
          // 🚓 NOUVEAU : Exclure les commentaires de vidéos
          if (meta.type === 'reply' || meta.parentTweetId) {
            if (this._isRootVideo(tweetId)) continue;
          }
        }

        if (options.onlyFollowing && !followedAuthors.has(meta.authorId)) continue;
        scored.set(tweetId, {
          content: 0, collab: 0, follow: 0, trending: 0,
          freshness: 0, discovery: 0, language: 0, quality: 0,
        });
      }
    }

    // ── Phase 2 : Collaborative Filtering ──
    if (userVec) {
      const similarUsers = this.userStore.search(userVec, this.algoConfig.similarUsersK, new Set([userId]));

      for (const { id: simUserId, score: simScore } of similarUsers) {
        if (simScore < 0.08) continue;

        const simInteractions = this.userInteractions.get(simUserId);
        if (!simInteractions) continue;

        let count = 0;
        for (const tweetId of simInteractions) {
          if (count >= this.algoConfig.collabTweetLimit) break;
          if (seenTweets.has(tweetId) || exclude.has(tweetId)) continue;

          const meta = this.tweetMeta.get(tweetId);
          if (options.onlyFollowing && (!meta || !followedAuthors.has(meta.authorId))) continue;

          const entry = scored.get(tweetId);
          if (entry) {
            entry.collab += simScore * 0.12;
            entry.collab = Math.min(entry.collab, 1.0);
          }
          count++;
        }
      }
    }

    // ── Phase 3 : Follow Graph Boost ──
    for (const followedAuthorId of followedAuthors) {
      const authorTweetIds = this.authorTweets.get(followedAuthorId);
      if (!authorTweetIds) continue;

      for (const tweetId of authorTweetIds) {
        if (seenTweets.has(tweetId) || exclude.has(tweetId)) continue;
        const entry = scored.get(tweetId);
        if (entry) {
          entry.follow = 0.85; // Fort bonus pour les auteurs suivis
        }
      }
    }

    // ── Phase 4 : Freshness + Discovery + Trending + Language + Quality ──
    for (const [tweetId, components] of scored) {
      const meta = this.tweetMeta.get(tweetId);
      if (!meta) continue;

      // Freshness : décroissance exponentielle (demi-vie = 18h)
      const ageMs = now - meta.createdAt.getTime();
      const ageHours = ageMs / 3600000;
      components.freshness = Math.exp(-ageHours / this.algoConfig.freshnessHalfLifeH);

      // Discovery boost : tweets avec très peu de vues
      if (meta.viewCount < 30 && ageHours < this.algoConfig.discoveryWindowH) {
        components.discovery = 1.0 - (meta.viewCount / 30);
      }

      // Trending : engagement velocity normalisé
      if (meta.engagement.velocity > 0) {
        if (meta.engagement.velocity >= this.algoConfig.velocityHighThreshold) {
          components.trending = 1.0;
        } else if (meta.engagement.velocity >= this.algoConfig.velocityMidThreshold) {
          components.trending = 0.5 + 0.5 * (meta.engagement.velocity - this.algoConfig.velocityMidThreshold) / (this.algoConfig.velocityHighThreshold - this.algoConfig.velocityMidThreshold);
        } else {
          components.trending = meta.engagement.velocity / this.algoConfig.velocityMidThreshold * 0.5;
        }
      }

      // Language match
      if (meta.language && meta.language === userLang) {
        components.language = 1.0;
      } else {
        components.language = 0.2; // Pénalité légère, pas exclusion
      }

      // Hashtag affinity bonus (ajouté au content score)
      if (meta.hashtags && hashtagAffinity.size > 0) {
        let hashScore = 0;
        for (const h of meta.hashtags) {
          const aff = hashtagAffinity.get(h);
          if (aff) hashScore += aff;
        }
        // Ajouter comme bonus au content score (capped at 0.3)
        components.content = Math.min(1.0, components.content + Math.min(0.3, hashScore * 0.15));
      }

      // Quality bonus (contenu riche = plus intéressant)
      if (meta.hasMedia) components.quality += 0.08;
      if (meta.contentLen > 80) components.quality += 0.04;
      if (meta.contentLen > 150) components.quality += 0.04;
      // Author popularity micro-boost
      const authorInfo = this.authorMeta.get(meta.authorId);
      if (authorInfo) {
        if (authorInfo.verified) components.quality += 0.12;  // ↑ boost vérifiés (0.06 → 0.12)
        if (authorInfo.followersCount > 100) components.quality += 0.03;
      }

      // 🚓 BOOST DISCOVERY pour les tweets récents avec peu de vues (pousse les nouveaux contenus)
      if (meta.viewCount < 10 && ageHours < 6) {
        components.discovery = Math.max(components.discovery, 0.8);
      }
    }

    // ── Phase 5 : Score final combiné ──
    const results = [];
    for (const [tweetId, c] of scored) {
      let score =
        this.algoConfig.weights.CONTENT * c.content +
        this.algoConfig.weights.COLLAB * c.collab +
        this.algoConfig.weights.FOLLOW * c.follow +
        this.algoConfig.weights.TRENDING * c.trending +
        this.algoConfig.weights.FRESHNESS * c.freshness +
        this.algoConfig.weights.DISCOVERY * c.discovery +
        this.algoConfig.weights.LANGUAGE * c.language +
        c.quality; // Quality est un bonus additif

      // 🚓 Réduction de visibilité (90% en moins) pour les tweets PolicierCongo de plus de 30 jours (720h)
      const meta = this.tweetMeta.get(tweetId);
      if (meta && meta.authorId === 'a13a7745-448f-4faa-892a-f6ea140f2f5b') {
        const ageHours = (now - meta.createdAt.getTime()) / 3600000;
        if (ageHours > 720) score *= 0.05;
      }

      score = this._applyShadowVisibilityToScore(tweetId, score);

      results.push({ tweetId, score, components: c });
    }

    // ── Phase 6 : Top-K avec garantie discovery ──
    const sorted = topK(results, CACHED_POOL_SIZE * 2);

    // Garantir un minimum de discovery tweets
    const discoveryTweets = sorted.filter(r => r.components.discovery > 0.3);
    const normalTweets = sorted.filter(r => r.components.discovery <= 0.3);

    const discoveryCount = Math.max(
      Math.ceil(CACHED_POOL_SIZE * this.algoConfig.discoveryMinRatio),
      Math.min(discoveryTweets.length, Math.ceil(CACHED_POOL_SIZE * 0.25))
    );
    const normalCount = CACHED_POOL_SIZE - Math.min(discoveryCount, discoveryTweets.length);

    // Assembler le feed final
    const feed = [
      ...normalTweets.slice(0, normalCount),
      ...discoveryTweets.slice(0, discoveryCount),
    ].sort((a, b) => b.score - a.score).slice(0, CACHED_POOL_SIZE);

    return feed;
  }

  /**
   * Feed pour un nouveau user sans historique (COLD START).
   * Utilise les signaux globaux (trending, popularité auteur, fraîcheur).
   */
  _generateColdStartFeed(userId, seenTweets, exclude, options = {}) {
    const now = Date.now();
    const userLang = this.userLanguage.get(userId) || 'fr';
    const followedAuthors = this.followGraph.get(userId) || new Set();

    const results = [];
    const seenHashtagGroups = new Map(); // Pour diversité

    for (const [tweetId] of this.tweetStore.index) {
      if (seenTweets.has(tweetId) || exclude.has(tweetId)) continue;

      const meta = this.tweetMeta.get(tweetId);
      if (!meta) continue;
      if (meta.authorId === userId && options.tweetType !== 'video') continue;

      if (options.tweetType) {
        if (meta.type !== options.tweetType) continue;
      } else {
        if (meta.type === 'video') continue;
        // 🚓 NOUVEAU : Exclure les commentaires de vidéos
        if (meta.type === 'reply' || meta.parentTweetId) {
          if (this._isRootVideo(tweetId)) continue;
        }
      }

      // 🚓 FILTRAGE BANS : Exclure les auteurs suspendus
      const authorInfo = this.authorMeta.get(meta.authorId);
      if (authorInfo && authorInfo.isSuspended) continue;

      // Exclure les réponses ou retweets/quotes liés à des auteurs suspendus
      const referenceId = meta.parentTweetId || meta.originalTweetId;
      if (referenceId) {
        const refMeta = this.tweetMeta.get(referenceId);
        if (refMeta) {
          const refAuthorInfo = this.authorMeta.get(refMeta.authorId);
          if (refAuthorInfo && refAuthorInfo.isSuspended) continue;
        }
      }

      if (options.onlyFollowing && !followedAuthors.has(meta.authorId)) continue;

      const ageMs = now - meta.createdAt.getTime();
      const ageHours = ageMs / 3600000;

      // ── Trending Score (vélocité d'engagement) ──
      let trendingScore = 0;
      if (meta.engagement.velocity >= this.algoConfig.velocityHighThreshold) {
        trendingScore = 1.0;
      } else if (meta.engagement.velocity >= this.algoConfig.velocityMidThreshold) {
        trendingScore = 0.5 + 0.5 * (meta.engagement.velocity - this.algoConfig.velocityMidThreshold) / (this.algoConfig.velocityHighThreshold - this.algoConfig.velocityMidThreshold);
      } else if (meta.engagement.velocity > 0) {
        trendingScore = meta.engagement.velocity / this.algoConfig.velocityMidThreshold * 0.5;
      }

      // ── Likes Score (NOUVEAU) ──
      let likesScore = 0;
      if (meta.engagement.likes > 0) {
        // Échelle logarithmique : 10 likes = 0.4, 100 likes = 0.8, 300+ likes ≈ 1.0
        likesScore = Math.min(1.0, Math.log10(meta.engagement.likes + 1) / 2.5);
      }

      // ── Author Popularity Score ──
      let popularityScore = 0;
      if (authorInfo) {
        if (authorInfo.verified) popularityScore += 0.4;
        if (authorInfo.premium) popularityScore += 0.1;
        // Log scale pour followers (0 = 0, 1000 = 0.5, 10000 = 0.67, 100000 = 0.83...)
        if (authorInfo.followersCount > 0) {
          popularityScore += Math.min(0.5, Math.log10(authorInfo.followersCount) / 10);
        }
        popularityScore = Math.min(1.0, popularityScore);
      }

      // Bonus si l'user suit cet auteur
      if (followedAuthors.has(meta.authorId)) {
        popularityScore = Math.min(1.0, popularityScore + 0.3);
      }

      // ── Freshness Score ──
      const freshnessScore = Math.exp(-ageHours / this.algoConfig.freshnessHalfLifeH);

      // ── Language Score ──
      const languageScore = (meta.language === userLang) ? 1.0 : 0.15;

      // ── Diversity Score (pénaliser les hashtags déjà trop vus) ──
      let diversityScore = 0.5;
      if (meta.hashtags && meta.hashtags.length > 0) {
        const mainHash = meta.hashtags[0];
        const count = seenHashtagGroups.get(mainHash) || 0;
        diversityScore = Math.max(0.1, 1.0 - count * 0.15);
        seenHashtagGroups.set(mainHash, count + 1);
      }

      // ── Quality bonus ──
      let quality = 0;
      if (meta.hasMedia) quality += 0.05;
      if (meta.contentLen > 80) quality += 0.03;
      if (meta.engagement.likes > 5) quality += 0.03;
      if (meta.engagement.replies > 2) quality += 0.02;

      // ── Score final cold start ──
      let score =
        this.algoConfig.coldStartWeights.LIKES * likesScore +
        this.algoConfig.coldStartWeights.TRENDING * trendingScore +
        this.algoConfig.coldStartWeights.POPULARITY * popularityScore +
        this.algoConfig.coldStartWeights.FRESHNESS * freshnessScore +
        this.algoConfig.coldStartWeights.DIVERSITY * diversityScore +
        this.algoConfig.coldStartWeights.LANGUAGE * languageScore +
        quality;

      // 🚓 Réduction de visibilité (90% en moins) pour les tweets PolicierCongo de plus de 30 jours (720h)
      if (meta.authorId === 'a13a7745-448f-4faa-892a-f6ea140f2f5b' && ageHours > 720) {
        score *= 0.10;
      }

      score = this._applyShadowVisibilityToScore(tweetId, score);

      results.push({
        tweetId,
        score,
        components: {
          content: 0,
          collab: 0,
          follow: followedAuthors.has(meta.authorId) ? 0.85 : 0,
          likes: likesScore,
          trending: trendingScore,
          freshness: freshnessScore,
          discovery: (meta.viewCount < 30) ? (1.0 - meta.viewCount / 30) : 0,
          language: languageScore,
          quality,
          popularity: popularityScore,
          diversity: diversityScore,
        },
      });
    }

    // Top-K
    const sorted = topK(results, CACHED_POOL_SIZE);
    return sorted;
  }

  /**
   * Post-processing : limiter les tweets consécutifs d'un même auteur.
   */
  _applyAuthorDiversity(feed) {
    if (feed.length <= this.algoConfig.authorDiversityWindow) return feed;

    const result = [];
    const recentAuthors = []; // Fenêtre glissante des derniers auteurs

    for (const item of feed) {
      const meta = this.tweetMeta.get(item.tweetId);
      if (!meta) {
        result.push(item);
        continue;
      }

      const authorId = meta.authorId;

      // Compter combien de fois cet auteur apparaît dans la fenêtre récente
      const authorCountInWindow = recentAuthors.filter(a => a === authorId).length;

      if (authorCountInWindow >= this.algoConfig.maxSameAuthorWindow) {
        // Pousser vers le bas avec un score réduit mais ne pas supprimer
        result.push({ ...item, score: item.score * 0.5 });
      } else {
        result.push(item);
      }

      // Maintenir la fenêtre glissante
      recentAuthors.push(authorId);
      if (recentAuthors.length > this.algoConfig.authorDiversityWindow) {
        recentAuthors.shift();
      }
    }

    // Re-trier après ajustement de diversité
    result.sort((a, b) => b.score - a.score);
    return result;
  }

  /**
   * Retourne la taille réelle du pool de recommandations pour un user.
   * Utilisé par la pagination réelle.
   */
  getCachedPoolSize(userId, options = {}) {
    const cacheKey = `${userId}_${options.onlyFollowing ? 'following' : 'all'}_${options.tweetType || 'default'}`;
    const cached = this.recoCache.get(cacheKey);
    if (cached) return cached.poolSize;
    return 0;
  }

  /**
   * Retourne les utilisateurs les plus similaires à un user donné.
   */
  getSimilarUsers(userId, k = 10) {
    const userVec = this.userStore.get(userId);
    if (!userVec) return [];
    return this.userStore.search(userVec, k, new Set([userId]));
  }

  /**
   * Génère des suggestions d'utilisateurs basées sur la similarité sémantique (E5-Base).
   * Identifie les profils ayant des interactions (likes, vues, etc.) similaires.
   */
  /**
   * Génère des suggestions d'utilisateurs basées sur la similarité sémantique (E5-Base)
   * et le chevauchement des interactions (Collaborative Filtering).
   */
  async getUserSuggestions(userId, limit = 15) {
    const t0 = Date.now();
    const suggestions = new Map();
    const userVec = this.userStore.get(userId);
    const followedByMe = this.followGraph.get(userId) || new Set();
    const myInteractions = this.userInteractions.get(userId) || new Set();

    if (!userVec && myInteractions.size === 0) {
      // Cold start complet
      return this._getColdStartUserSuggestions(userId, limit);
    }

    // ─── SIGNAL 1 : Similarité Vectorielle (E5-Base) ───
    if (userVec) {
      const candidates = this.userStore.search(userVec, limit * 3, new Set([userId]));
      for (const { id: otherId, score: simScore } of candidates) {
        if (followedByMe.has(otherId)) continue;

        suggestions.set(otherId, {
          userId: otherId,
          score: simScore,
          reasons: new Set(),
          sharedCount: 0,
          mutualFollowsCount: 0
        });

        const entry = suggestions.get(otherId);
        if (simScore > 0.88) entry.reasons.add("Profil aux intérêts identiques");
        else if (simScore > 0.78) entry.reasons.add("Partage vos centres d'intérêt");
        else entry.reasons.add("Goûts similaires");
      }
    }

    // ─── SIGNAL 2 : Chevauchement des Interactions (Collaborative) ───
    for (const [otherId, otherInteractions] of this.userInteractions) {
      if (otherId === userId || followedByMe.has(otherId)) continue;

      let shared = 0;
      for (const tweetId of myInteractions) {
        if (otherInteractions.has(tweetId)) shared++;
      }

      if (shared > 0) {
        if (!suggestions.has(otherId)) {
          suggestions.set(otherId, { userId: otherId, score: 0, reasons: new Set(), sharedCount: 0, mutualFollowsCount: 0 });
        }
        const entry = suggestions.get(otherId);
        entry.sharedCount = shared;
        entry.score += shared * 0.25; // Boost interactions communes

        if (shared >= 2) entry.reasons.add(`${shared} interactions en commun`);
        else entry.reasons.add("Interactions communes");
      }
    }

    // ─── SIGNAL 3 : Social Proof (Mutuals / Follows) ───
    for (const [otherId, entry] of suggestions) {
      const otherFollowing = this.followGraph.get(otherId);
      if (!otherFollowing) continue;

      // Reverse Follow
      if (otherFollowing.has(userId)) {
        entry.score += 0.3;
        entry.reasons.add("Vous suit déjà");
      }

      // Mutuals
      let mutuals = 0;
      for (const followedId of followedByMe) {
        if (otherFollowing.has(followedId)) mutuals++;
      }
      if (mutuals > 0) {
        entry.mutualFollowsCount = mutuals;
        entry.score += Math.min(0.4, mutuals * 0.1);
        entry.reasons.add(`${mutuals} ami(s) en commun`);
      }
    }

    // --- Finalisation et Tri ---
    let results = Array.from(suggestions.values())
      .map(s => ({
        ...s,
        reasons: Array.from(s.reasons).reverse().slice(0, 2) // Priorité aux raisons les plus récentes ajoutées (Social/Shared)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Fallback si pas assez de suggestions
    if (results.length < limit / 2) {
      const coldStart = await this._getColdStartUserSuggestions(userId, limit - results.length);
      results = [...results, ...coldStart];
    }

    const elapsed = Date.now() - t0;
    console.log(`👤 [Suggestions] Générées en ${elapsed}ms pour ${userId} (${results.length} résultats)`);

    return results;
  }

  /**
   * Suggestions pour utilisateur sans signaux (ou peu de résultats).
   * Propose des comptes populaires et actifs.
   */
  _getColdStartUserSuggestions(userId, limit = 10) {
    const candidates = [];
    const followedByMe = this.followGraph.get(userId) || new Set();
    const now = Date.now();

    // 1. Identifier les auteurs "trending" (ceux qui ont des tweets avec du succès récent)
    const trendingAuthors = new Map(); // authorId -> maxVelocity
    for (const [tweetId, meta] of this.tweetMeta) {
      const age = now - meta.createdAt.getTime();
      if (age < 48 * 3600000 && meta.engagement.velocity > 0.1) {
        const current = trendingAuthors.get(meta.authorId) || 0;
        trendingAuthors.set(meta.authorId, Math.max(current, meta.engagement.velocity));
      }
    }

    for (const [authorId, meta] of this.authorMeta) {
      if (authorId === userId || followedByMe.has(authorId) || meta.isSuspended) continue;

      let score = 0;
      const reasons = new Set();

      // Social Proof
      if (meta.verified) {
        score += 5;
        reasons.add("Compte certifié");
      }
      if (meta.premium) {
        score += 2;
        reasons.add("Membre Premium");
      }

      // Popularité (logarithmic)
      const popularity = Math.log10(meta.followersCount + 1);
      score += popularity;
      if (popularity > 3) reasons.add("Compte influent");

      // Activité récente (Trending)
      const trendingScore = trendingAuthors.get(authorId);
      if (trendingScore) {
        score += Math.min(10, trendingScore * 5);
        reasons.add("Actif récemment");
      }

      // Bonus diversité (aléatoire léger pour éviter que ce soit toujours les mêmes)
      score += Math.random() * 0.5;

      if (reasons.size === 0) reasons.add("Suggéré pour vous");

      candidates.push({
        userId: authorId,
        score,
        reasons: Array.from(reasons).slice(0, 1),
        mutualFollowsCount: 0
      });
    }

    return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Retourne les tweets les plus similaires à un tweet donné.
   */
  async getSimilarTweets(tweetId, k = 10) {
    try {
      const { Tweet } = require('../../models');
      const sourceTweet = await Tweet.findByPk(tweetId);
      if (!sourceTweet) return [];

      return await semanticSimilarityService.getSimilarTweets(sourceTweet, null, k);
    } catch (error) {
      logger.error('❌ [Engine] Erreur getSimilarTweets (Semantic):', error);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MAINTENANCE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Invalide le cache d'un user */
  _invalidateCache(userId) {
    this.recoCache.delete(userId);
  }

  /** Purge les tweets du discovery pool expirés */
  _purgeDiscoveryPool() {
    const cutoff = Date.now() - this.algoConfig.discoveryWindowH * 3600000;
    for (const [id, entry] of this.discoveryPool) {
      if (entry.createdAt.getTime() < cutoff) {
        this.discoveryPool.delete(id);
      }
    }
  }

  /** Sauvegarde périodique des index */
  _periodicSave() {
    try {
      this._purgeDiscoveryPool();
      const t = this.tweetStore.save();
      const u = this.userStore.save();
      if (t || u) {
        console.log(`💾 [Similarity V2] Index sauvegardés: ${t || 0} tweets, ${u || 0} users`);
      }
    } catch (err) {
      console.error('❌ [Similarity V2] Erreur sauvegarde périodique:', err.message);
    }
  }

  /** Met à jour les métadonnées de vue d'un tweet */
  incrementViewCount(tweetId) {
    const meta = this.tweetMeta.get(tweetId);
    if (meta) {
      meta.viewCount++;
      if (meta.viewCount >= 30) {
        this.discoveryPool.delete(tweetId);
      }
    }
  }

  /** Statistiques complètes */
  getStats() {
    return {
      engine: 'SimilarityRecommendationEngine',
      version: '2.0.0',
      initialized: this._initialized,
      tweetVectors: this.tweetStore.getStats(),
      userVectors: this.userStore.getStats(),
      discoveryPoolSize: this.discoveryPool.size,
      cacheSize: this.recoCache.size,
      followGraphSize: this.followGraph.size,
      authorProfilesCount: this.authorMeta.size,
      hashtagAffinityUsers: this.userHashtagAffinity.size,
      totalInteractionsTracked: this.userInteractions.size,
      trendingCacheAge: Date.now() - this._trendingCache.ts,
      ...this.stats,
    };
  }

  /** Config algorithmique (superadmin) */
  getAlgorithmConfig() {
    return JSON.parse(JSON.stringify(this.algoConfig));
  }

  getAlgorithmStats() {
    return {
      initialized: this._initialized,
      stats: { ...this.stats },
      sizes: {
        tweetVectors: this.tweetStore.size,
        userVectors: this.userStore.size,
        tweetMeta: this.tweetMeta.size,
      },
    };
  }

  /**
   * Fusionne une config partielle. Invalide caches trending / reco.
   * @param {object} patch
   */
  applyAlgorithmConfig(patch) {
    if (!patch || typeof patch !== 'object') {
      return { success: false, message: 'Payload invalide' };
    }
    const cfg = this.algoConfig;
    const checkNum = (v, min, max, label) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return `${label} : nombre invalide`;
      if (n < min || n > max) return `${label} : hors plage [${min}, ${max}]`;
      return null;
    };

    if (patch.weights) {
      for (const key of Object.keys(cfg.weights)) {
        if (patch.weights[key] === undefined) continue;
        const err = checkNum(patch.weights[key], 0, 1.5, `weights.${key}`);
        if (err) return { success: false, message: err };
        cfg.weights[key] = Number(patch.weights[key]);
      }
    }
    if (patch.coldStartWeights) {
      for (const key of Object.keys(cfg.coldStartWeights)) {
        if (patch.coldStartWeights[key] === undefined) continue;
        const err = checkNum(patch.coldStartWeights[key], 0, 1.5, `coldStartWeights.${key}`);
        if (err) return { success: false, message: err };
        cfg.coldStartWeights[key] = Number(patch.coldStartWeights[key]);
      }
    }
    if (patch.interactionWeights) {
      for (const key of Object.keys(cfg.interactionWeights)) {
        if (patch.interactionWeights[key] === undefined) continue;
        const err = checkNum(patch.interactionWeights[key], 0.1, 10, `interactionWeights.${key}`);
        if (err) return { success: false, message: err };
        cfg.interactionWeights[key] = Number(patch.interactionWeights[key]);
      }
    }

    const intBounds = [
      ['similarUsersK', 5, 300],
      ['discoveryWindowH', 6, 168],
      ['collabTweetLimit', 50, 2000],
      ['freshnessHalfLifeH', 1, 168],
      ['trendingCacheTtlMs', 30000, 3600000],
      ['maxSameAuthorWindow', 1, 10],
      ['authorDiversityWindow', 5, 50],
      ['adIntensityPct', 0, 500],
    ];
    for (const [k, lo, hi] of intBounds) {
      if (patch[k] === undefined) continue;
      const err = checkNum(patch[k], lo, hi, k);
      if (err) return { success: false, message: err };
      cfg[k] = Math.round(Number(patch[k]));
    }

    if (patch.discoveryMinRatio !== undefined) {
      const err = checkNum(patch.discoveryMinRatio, 0.02, 0.5, 'discoveryMinRatio');
      if (err) return { success: false, message: err };
      cfg.discoveryMinRatio = Number(patch.discoveryMinRatio);
    }

    if (patch.velocityHighThreshold !== undefined || patch.velocityMidThreshold !== undefined) {
      const hi = patch.velocityHighThreshold !== undefined ? Number(patch.velocityHighThreshold) : cfg.velocityHighThreshold;
      const mid = patch.velocityMidThreshold !== undefined ? Number(patch.velocityMidThreshold) : cfg.velocityMidThreshold;
      if (!Number.isFinite(hi) || !Number.isFinite(mid) || mid <= 0 || hi <= mid) {
        return { success: false, message: 'Seuils vélocité invalides (velocityMid < velocityHigh)' };
      }
      cfg.velocityHighThreshold = hi;
      cfg.velocityMidThreshold = mid;
    }

    this._trendingCache.ts = 0;
    this.recoCache.clear();
    return { success: true, data: this.getAlgorithmConfig() };
  }

  /** Arrêt propre */
  shutdown() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    this._periodicSave();
    console.log('🛑 [Similarity V2] Moteur arrêté proprement');
  }
}

module.exports = { SimilarityRecommendationEngine };
