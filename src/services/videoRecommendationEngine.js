/**
 * ============================================================
 *  TikTok-Like Recommendation Engine  v2
 *  Optimised for small apps (~25 users)
 *  Pure JavaScript — zero dependencies
 * ============================================================
 *
 *  PIPELINE (per feed request)
 *  ─────────────────────────────────────────────────────────
 *  1. Candidate generation  → ALL videos (no arbitrary caps)
 *
 *  2. Scoring  (weighted hybrid)
 *     • Collaborative filtering   – similarity × interactions
 *     • Content-based             – TF-IDF cosine + hashtag boost
 *     • Follow affinity           – creator bonus
 *     • Recency decay             – exponential 24 h half-life
 *     • Popularity                – global engagement rate
 *     • Velocity                  – momentum (interactions/hour)
 *     • Watch completion          – did users finish the video?
 *
 *  3. Post-processing
 *     • Soft re-watch decay       – seen videos keep 40% score
 *                                   EXCEPT liked/reposted → 85%
 *                                   (TikTok shows you what you loved)
 *     • Diversity                 – ≤ MAX_PER_CREATOR per creator
 *     • Deterministic pagination  – stable sort, exploration via
 *                                   page-seeded interleaving (not pure random)
 *
 *  INTERACTION WEIGHTS
 *  ─────────────────────────────────────────────────────────
 *  repost       → 5.0   (share = strongest intent)
 *  comment      → 3.0
 *  like         → 1.5
 *  watch_full   → 1.0   (watched to the end)
 *  watch_partial→ 0.4   (>30% watched)
 *  view         → 0.1   (implicit scroll-past)
 *
 *  PAGINATION
 *  ─────────────────────────────────────────────────────────
 *  recommend(userId, { limit, offset }) is deterministic for a
 *  given engine state. Page N always returns the same results
 *  as long as no new data is ingested.
 *  Pass forceRefresh=true to re-include already-seen videos
 *  with their natural score (useful for "replay" feeds).
 * ============================================================
 */

"use strict";

// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────

const INTERACTION_WEIGHTS = {
  repost: 5.0,
  comment: 3.0,
  like: 1.5,
  watch_full: 1.0,
  watch_partial: 0.4,
  view: 0.1,
};

// Interactions that signal strong positive preference
// → these videos get a HIGH re-watch score (85%) instead of the default (40%)
const HIGH_INTENT_TYPES = new Set(["repost", "like", "comment"]);

// Blend weights (must sum to 1.0)
const SCORE_WEIGHTS = {
  collaborative: 0.25, // reduced — CF is weaker with few users
  content: 0.30,       // boosted — topic matching is most reliable signal
  follow: 0.15,
  recency: 0.10,
  popularity: 0.10,
  velocity: 0.05,      // trending momentum
  completion: 0.05,    // watch-through rate
};

const RECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000; // 24 h
const VELOCITY_WINDOW_MS = 6 * 60 * 60 * 1000; //  6 h  (hot window)
const EXPLORATION_RATE = 0.15;                 // 15% of feed = exploration
const MAX_PER_CREATOR = 999; // effectively unlimited as requested

// Re-watch decay multipliers
const SEEN_DECAY_DEFAULT = 0.40; // generic seen video
const SEEN_DECAY_HIGH_INTENT = 0.85; // liked / reposted / commented

// Cold start settings — help new videos find an audience
const COLD_START_WINDOW_MS = 6 * 60 * 60 * 1000; // First 6 hours
const COLD_START_BOOST = 1.0; // Increased — effectively force-promotes new content
const COLD_START_MIN_VIEWS = 15; // Increased window for boost

const UNSEEN_BOOST = 1.5; // Increased factor for new content discovery

// ─────────────────────────────────────────────────────────────
//  UTILITY HELPERS
// ─────────────────────────────────────────────────────────────

/** Cosine similarity between two sparse vectors (plain objects). */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (const [k, v] of Object.entries(a)) {
    normA += v * v;
    if (b[k] !== undefined) dot += v * b[k];
  }
  for (const v of Object.values(b)) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Exponential recency decay → (0, 1]. */
function recencyScore(timestampMs, now, halfLifeMs = RECENCY_HALF_LIFE_MS) {
  const age = Math.max(0, now - timestampMs);
  return Math.exp((-age * Math.LN2) / halfLifeMs);
}

/** Clamp to [min, max]. */
const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));

/**
 * Safe max of an iterable — returns fallback if empty.
 * Fixes the crash: Math.max(...emptyIterator) → -Infinity
 */
function safeMax(iterable, fallback = 1) {
  let m = -Infinity;
  for (const v of iterable) if (v > m) m = v;
  return m === -Infinity ? fallback : m;
}

/**
 * Deterministic shuffle using a numeric seed (mulberry32 PRNG).
 * Same seed → same order. Critical for stable pagination.
 */
function seededShuffle(arr, seed) {
  const prng = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Simple non-cryptographic hash of a string → unsigned int. */
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

// ─────────────────────────────────────────────────────────────
//  TF-IDF CONTENT VECTORIZER
// ─────────────────────────────────────────────────────────────

class TFIDFVectorizer {
  constructor() {
    this._df = new Map(); // term → document frequency
    this._numDocs = 0;
    this._vectors = new Map(); // docId → tfidf vector
    this._built = false;
  }

  /**
   * Tokenise text into unigrams + bigrams.
   * Hashtags get a 3× weight boost via repetition.
   */
  _tokenize(text) {
    const raw = (text || "").toLowerCase();
    const words = raw
      .replace(/[^a-z0-9àâéèêëîïôùûüç#\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

    const tokens = [];
    for (const w of words) {
      const isHashtag = w.startsWith("#");
      const clean = isHashtag ? w.slice(1) : w;
      if (!clean) continue;
      tokens.push(clean);
      // Hashtag boost: triple occurrence weight by repeating token
      if (isHashtag) { tokens.push(clean); tokens.push(clean); }
    }
    // Bigrams for topic coherence
    for (let i = 0; i < words.length - 1; i++) {
      const a = words[i].replace(/^#/, "");
      const b = words[i + 1].replace(/^#/, "");
      if (a && b) tokens.push(`${a}_${b}`);
    }
    return tokens;
  }

  /** Add or update a document. */
  addDocument(id, text) {
    const tokens = this._tokenize(text);
    const tf = {};
    const seen = new Set();

    for (const t of tokens) {
      tf[t] = (tf[t] || 0) + 1;
      if (!seen.has(t)) {
        seen.add(t);
        this._df.set(t, (this._df.get(t) || 0) + 1);
      }
    }
    const len = tokens.length || 1;
    for (const t in tf) tf[t] /= len;

    this._vectors.set(id, tf);
    this._numDocs++;
    this._built = false;
  }

  /** Compute TF-IDF weights (call after all addDocument). */
  build() {
    const N = this._numDocs || 1;
    for (const [id, tf] of this._vectors) {
      const tfidf = {};
      for (const [t, freq] of Object.entries(tf)) {
        const df = this._df.get(t) || 1;
        const idf = Math.log((N + 1) / (df + 1)) + 1; // smoothed IDF
        tfidf[t] = freq * idf;
      }
      this._vectors.set(id, tfidf);
    }
    this._built = true;
  }

  getVector(id) { return this._vectors.get(id) || null; }

  /**
   * Build a user interest profile by averaging interaction-weighted vectors.
   * Recent interactions are weighted more heavily (exponential time decay).
   *
   * @param {Array<{id, weight, timestamp}>} weightedDocs
   * @param {number} now
   */
  buildProfileVector(weightedDocs, now = Date.now()) {
    const profile = {};
    let totalWeight = 0;

    for (const { id, weight, timestamp } of weightedDocs) {
      const vec = this.getVector(id);
      if (!vec) continue;

      // Recent interactions shape the profile more strongly
      const timeDecay = recencyScore(timestamp || 0, now, 7 * 24 * 3600e3); // 7-day half-life
      const finalWeight = weight * (0.5 + 0.5 * timeDecay); // never fully discard old prefs
      totalWeight += finalWeight;

      for (const [t, v] of Object.entries(vec)) {
        profile[t] = (profile[t] || 0) + v * finalWeight;
      }
    }
    if (totalWeight > 0) for (const t in profile) profile[t] /= totalWeight;
    return profile;
  }
}

// ─────────────────────────────────────────────────────────────
//  COLLABORATIVE FILTERING
// ─────────────────────────────────────────────────────────────

class CollaborativeFilter {
  constructor(userItemMatrix) {
    this._matrix = userItemMatrix;
    this._simCache = new Map();
  }

  userSimilarity(uA, uB) {
    const key = uA < uB ? `${uA}:${uB}` : `${uB}:${uA}`;
    if (this._simCache.has(key)) return this._simCache.get(key);

    const vecA = this._matrix.get(uA) || new Map();
    const vecB = this._matrix.get(uB) || new Map();

    let dot = 0, normA = 0, normB = 0;
    for (const [id, v] of vecA) {
      normA += v * v;
      if (vecB.has(id)) dot += v * vecB.get(id);
    }
    for (const v of vecB.values()) normB += v * v;

    const sim = normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
    this._simCache.set(key, sim);
    return sim;
  }

  /**
   * Predict scores for candidate videos using top-K nearest neighbours.
   * Returns a Map<videoId, score> normalised to [0, 1].
   */
  predictScores(userId, candidateVideoIds, allUserIds) {
    const scores = new Map();
    const userVec = this._matrix.get(userId) || new Map();

    // Sort neighbours by similarity (top 15 is plenty for 25 users)
    const neighbours = allUserIds
      .filter(u => u !== userId)
      .map(u => ({ id: u, sim: this.userSimilarity(userId, u) }))
      .filter(n => n.sim > 0)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 15);

    if (neighbours.length === 0) return scores;

    const simSum = neighbours.reduce((s, n) => s + n.sim, 0) || 1;

    for (const vid of candidateVideoIds) {
      let weightedSum = 0;
      for (const { id: nId, sim } of neighbours) {
        const nVec = this._matrix.get(nId);
        if (nVec && nVec.has(vid)) weightedSum += sim * nVec.get(vid);
      }
      if (weightedSum > 0) scores.set(vid, weightedSum / simSum);
    }

    // Normalise — safeMax prevents crash on empty map
    const max = safeMax(scores.values(), 1);
    for (const [k, v] of scores) scores.set(k, v / max);
    return scores;
  }
}

// ─────────────────────────────────────────────────────────────
//  MAIN ENGINE
// ─────────────────────────────────────────────────────────────

class RecommendationEngine {
  /**
   * @param {Object} opts
   * @param {Object} opts.scoreWeights     Override SCORE_WEIGHTS
   * @param {number} opts.explorationRate  Override EXPLORATION_RATE
   * @param {number} opts.recencyHalfLife  Override RECENCY_HALF_LIFE_MS
   */
  constructor(opts = {}) {
    this._weights = { ...SCORE_WEIGHTS, ...opts.scoreWeights };
    this._exploration = opts.explorationRate ?? EXPLORATION_RATE;
    this._halfLife = opts.recencyHalfLife ?? RECENCY_HALF_LIFE_MS;

    this._users = new Map(); // userId  → user record
    this._videos = new Map(); // videoId → video record
    this._userItemMatrix = new Map(); // userId  → Map<videoId, score>

    /**
     * Detailed interaction log — needed for:
     *   - velocity (recent interaction count)
     *   - watch completion scoring
     *   - per-type re-watch decay (liked vs just viewed)
     * @type {Array<{userId, videoId, type, timestamp}>}
     */
    this._interactions = [];

    this._vectorizer = new TFIDFVectorizer();
    this._cf = null;
    this._dirty = true;
  }

  // ── DATA INGESTION ────────────────────────────────────────

  addUser(id, followings = []) {
    this._users.set(id, {
      id,
      followings: new Set(followings),
      seenVideos: new Set(),
      // Track which high-intent interactions the user has done per video
      highIntent: new Set(), // videoIds where user liked/reposted/commented
      likedVideos: new Set(),
      repostedVideos: new Set(),
    });
    if (!this._userItemMatrix.has(id)) this._userItemMatrix.set(id, new Map());
    this._dirty = true;
  }

  /**
   * @param {string} id
   * @param {Object} meta
   * @param {string} meta.authorId
   * @param {string} meta.title
   * @param {string} [meta.tags]      Space-separated tags / hashtags
   * @param {number} [meta.duration]  Duration in seconds (for completion rate)
   * @param {number} [meta.createdAt] Unix ms
   */
  addVideo(id, { authorId, title, tags = "", duration = 30, createdAt = Date.now() }) {
    this._videos.set(id, {
      id, authorId, title, tags, duration, createdAt,
      globalScore: 0,
      watchSeconds: 0,
      watchCompletions: 0,
      watchViews: 0,
      like_count: 0,
      repost_count: 0,
      comment_count: 0,
    });
    this._vectorizer.addDocument(id, `${title} ${tags}`);
    this._dirty = true;
    console.log(`🎬 [Engine] Video added: ${id} (Author: ${authorId})`);
  }

  /**
   * Record an interaction.
   * @param {string} userId
   * @param {string} videoId
   * @param {'like'|'comment'|'repost'|'view'|'watch_full'|'watch_partial'|'watch_time'} type
   * @param {number} [timestamp]
   * @param {Object} [meta]
   */
  addInteraction(userId, videoId, type, timestamp = Date.now(), meta = {}) {
    if (!INTERACTION_WEIGHTS[type] && type !== 'watch_time') throw new Error(`Unknown interaction: ${type}`);
    if (!this._users.has(userId)) throw new Error(`User not found: ${userId}`);
    if (!this._videos.has(videoId)) throw new Error(`Video not found: ${videoId}`);

    const weight = INTERACTION_WEIGHTS[type] || 0;
    const uMap = this._userItemMatrix.get(userId);
    uMap.set(videoId, (uMap.get(videoId) || 0) + weight);

    const user = this._users.get(userId);
    user.seenVideos.add(videoId);
    if (HIGH_INTENT_TYPES.has(type)) user.highIntent.add(videoId);
    if (type === "like") user.likedVideos.add(videoId);
    if (type === "repost") user.repostedVideos.add(videoId);

    const vid = this._videos.get(videoId);
    vid.globalScore = (vid.globalScore || 0) + weight;
    if (type === "like") vid.like_count = (vid.like_count || 0) + 1;
    else if (type === "repost") vid.repost_count = (vid.repost_count || 0) + 1;
    else if (type === "comment") vid.comment_count = (vid.comment_count || 0) + 1;

    if (type === "watch_full") {
      vid.watchCompletions++;
      vid.watchViews++;
      vid.watchSeconds += (vid.duration || 30);
    } else if (type === "watch_partial") {
      vid.watchViews++;
    } else if (type === "watch_time" && meta.durationMs) {
      vid.watchSeconds += (meta.durationMs / 1000);
    } else if (type === "view") {
      vid.watchViews++;
    }

    this._interactions.push({ userId, videoId, type, timestamp });
    this._dirty = true;
  }

  /**
   * Remove a specific interaction.
   * Useful for un-liking / un-retweeting in real-time.
   *
   * @param {string} userId
   * @param {string} videoId
   * @param {'like'|'comment'|'repost'} type
   */
  removeInteraction(userId, videoId, type) {
    if (!this._users.has(userId) || !this._videos.has(videoId)) return;

    const weight = INTERACTION_WEIGHTS[type] || 0;
    const uMap = this._userItemMatrix.get(userId);
    if (uMap && uMap.has(videoId)) {
      const newScore = Math.max(0, uMap.get(videoId) - weight);
      if (newScore === 0) uMap.delete(videoId);
      else uMap.set(videoId, newScore);
    }

    const user = this._users.get(userId);
    if (type === "like") {
      user.likedVideos.delete(videoId);
      if (!user.repostedVideos.has(videoId)) user.highIntent.delete(videoId);
    } else if (type === "repost") {
      user.repostedVideos.delete(videoId);
      if (!user.likedVideos.has(videoId)) user.highIntent.delete(videoId);
    }

    const vid = this._videos.get(videoId);
    vid.globalScore = Math.max(0, (vid.globalScore || 0) - weight);
    if (type === "like") vid.like_count = Math.max(0, (vid.like_count || 0) - 1);
    else if (type === "repost") vid.repost_count = Math.max(0, (vid.repost_count || 0) - 1);
    else if (type === "comment") vid.comment_count = Math.max(0, (vid.comment_count || 0) - 1);

    // Filter out the interaction from history (removes newest matching entry)
    const idx = this._interactions.findLastIndex(i => i.userId === userId && i.videoId === videoId && i.type === type);
    if (idx !== -1) {
      this._interactions.splice(idx, 1);
    }

    this._dirty = true;
    console.log(`🗑️ [Engine] Interaction removed: ${type} from ${userId} on ${videoId}`);
  }

  setFollow(followerId, followeeId, follow = true) {
    const user = this._users.get(followerId);
    if (!user) throw new Error(`User not found: ${followerId}`);
    follow ? user.followings.add(followeeId) : user.followings.delete(followeeId);
    this._dirty = true;
  }

  // ── BUILD / REBUILD INDEX ─────────────────────────────────

  build() {
    this._vectorizer.build();
    this._cf = new CollaborativeFilter(this._userItemMatrix);

    const now = Date.now();

    // Precompute per-video derived stats
    const globalScores = [...this._videos.values()].map(v => v.globalScore);
    const maxGlobal = safeMax(globalScores, 1);

    for (const vid of this._videos.values()) {
      // Normalised global popularity
      vid.normalizedGlobal = vid.globalScore / maxGlobal;

      // Watch completion rate (0–1)
      vid.completionRate = vid.watchViews > 0
        ? vid.watchCompletions / vid.watchViews
        : 0;
      
      // Retention score (Average watch time / duration)
      const avgWatchTime = vid.watchViews > 0 ? vid.watchSeconds / vid.watchViews : 0;
      vid.retentionScore = clamp(avgWatchTime / (vid.duration || 30));

      // Velocity: weighted interactions in last VELOCITY_WINDOW_MS
      const cutoff = now - VELOCITY_WINDOW_MS;
      vid.velocityScore = this._interactions
        .filter(i => i.videoId === vid.id && i.timestamp >= cutoff)
        .reduce((s, i) => s + INTERACTION_WEIGHTS[i.type], 0);
    }

    // Normalise velocity scores
    const maxVelocity = safeMax(
      [...this._videos.values()].map(v => v.velocityScore),
      1
    );
    for (const vid of this._videos.values()) {
      vid.normalizedVelocity = vid.velocityScore / maxVelocity;
    }

    this._dirty = false;
  }

  // ── RECOMMENDATION ────────────────────────────────────────

  /**
   * Ranked video recommendations with deterministic pagination.
   *
   * @param {string} userId
   * @param {Object} [opts]
   * @param {number}  [opts.limit=20]
   * @param {number}  [opts.offset=0]      Stable across pages (same engine state)
   * @param {boolean} [opts.forceRefresh]  If true, no re-watch decay at all
   * @param {number}  [opts.now]           Override current time (testing)
   * @returns {RecoResult[]}
   */
  recommend(userId, { limit = 20, offset = 0, forceRefresh = false, now = Date.now() } = {}) {
    if (!this._users.has(userId)) return [];
    if (this._dirty) this.build();

    const user = this._users.get(userId);
    const allVideos = [...this._videos.values()];
    const allUserIds = [...this._users.keys()];
    const allVideoIds = allVideos.map(v => v.id);

    // Build user content profile from interaction history
    const userHistory = [...(this._userItemMatrix.get(userId) || new Map())]
      .map(([id, weight]) => {
        const ts = this._interactions
          .filter(i => i.userId === userId && i.videoId === id)
          .reduce((latest, i) => Math.max(latest, i.timestamp), 0);
        return { id, weight, timestamp: ts };
      });

    const profileVec = this._vectorizer.buildProfileVector(userHistory, now);
    const hasProfile = Object.keys(profileVec).length > 0;

    // CF scores for all videos
    const cfScores = this._cf.predictScores(userId, allVideoIds, allUserIds);

    // ── Score every video ───────────────────────────────────

    const scored = allVideos.map(vid => {
      const w = this._weights;

      // 1. Collaborative filtering
      const cfScore = clamp(cfScores.get(vid.id) || 0);

      // 2. Content-based (TF-IDF cosine)
      let contentScore = 0;
      if (hasProfile) {
        const vidVec = this._vectorizer.getVector(vid.id);
        if (vidVec) contentScore = clamp(cosineSimilarity(profileVec, vidVec));
      }

      // 3. Follow affinity
      const followScore = user.followings.has(vid.authorId) ? 1.0 : 0.0;

      // 4. Recency decay
      const recScore = clamp(recencyScore(vid.createdAt, now, this._halfLife));

      // 5. Global popularity
      const popScore = clamp(vid.normalizedGlobal || 0);

      // 6. Velocity (trending momentum in last 6 h)
      const velScore = clamp(vid.normalizedVelocity || 0);

      // 7. Watch completion rate
      const compScore = clamp(vid.completionRate || 0);

      // Blended score
      let finalScore =
        w.collaborative * cfScore +
        w.content * contentScore +
        w.follow * followScore +
        w.recency * recScore +
        w.popularity * popScore +
        w.velocity * velScore +
        w.completion * (vid.completionRate * 0.5 + vid.retentionScore * 0.5);

      // ── Re-watch decay ────────────────────────────────────
      // Seen videos get softly penalised so fresh > familiar.
      // BUT videos you liked/reposted/commented keep most of their score
      // → they'll still surface (TikTok shows you your liked content).
      if (!forceRefresh && user.seenVideos.has(vid.id)) {
        const decay = user.highIntent.has(vid.id)
          ? SEEN_DECAY_HIGH_INTENT  // 85% – you loved it → can resurface
          : SEEN_DECAY_DEFAULT;     // 40% – seen but no strong signal
        finalScore *= decay;
      } else if (!user.seenVideos.has(vid.id)) {
        // Privilege unseen content with a 30% boost
        finalScore *= UNSEEN_BOOST;
      }

      // Don't recommend a user their own video (unless it's the only content)
      // Relaxed penalty for brand new videos to allow the author to see their own post.
      if (vid.authorId === userId) {
        const isFresh = (now - vid.createdAt) < 30 * 60 * 1000; // first 30 mins
        finalScore *= isFresh ? 0.80 : 0.05;
      }

      // ── Cold Start Boost ──────────────────────────────────
      // Brand new content gets a boost to help find initial engagement.
      const age = now - vid.createdAt;
      const isColdStart = age < COLD_START_WINDOW_MS && (vid.watchViews || 0) < COLD_START_MIN_VIEWS;
      if (isColdStart) {
        // Boost decays linearly as it reaches the window or view limit
        const ageFactor = 1 - age / COLD_START_WINDOW_MS;
        const viewFactor = 1 - (vid.watchViews || 0) / COLD_START_MIN_VIEWS;
        finalScore += COLD_START_BOOST * Math.min(ageFactor, viewFactor);
      }

      // Primary driver label (for transparency / debugging)
      const contributions = {
        collaborative: w.collaborative * cfScore,
        content: w.content * contentScore,
        follow: w.follow * followScore,
        recency: w.recency * recScore,
        popularity: w.popularity * popScore,
        velocity: w.velocity * velScore,
        completion: w.completion * compScore,  // FIX: was `comp` (undefined)
      };

      const primarySignal = Object.entries(contributions)
        .sort((a, b) => b[1] - a[1])[0][0];

      return {
        videoId: vid.id,
        authorId: vid.authorId,
        title: vid.title,
        ai_score: finalScore,
        primary_signal: primarySignal,
        is_seen: user.seenVideos.has(vid.id),
        is_high_intent: user.highIntent.has(vid.id),
        is_liked: user.likedVideos.has(vid.id),
        is_reposted: user.repostedVideos.has(vid.id),
        like_count: vid.like_count || 0,
        repost_count: vid.repost_count || 0,
        comment_count: vid.comment_count || 0,
      };
    });

    // Sort by score descending (deterministic — ties broken by id)
    scored.sort((a, b) => b.ai_score - a.ai_score || a.videoId.localeCompare(b.videoId));

    // Diversity cap: ≤ MAX_PER_CREATOR per creator
    const creatorCount = new Map();
    const diverse = scored.filter(r => {
      const count = creatorCount.get(r.authorId) || 0;
      if (count >= MAX_PER_CREATOR) return false;
      creatorCount.set(r.authorId, count + 1);
      return true;
    });

    // Exploration: interleave a seeded-random minority into the ranked list
    const explorationCount = Math.floor(limit * this._exploration);
    const mainCount = limit - explorationCount;

    const mainPool = diverse.slice(offset, offset + mainCount);
    const explorePool = diverse.slice(offset + mainCount);
    const seed = hashStr(`${userId}:${offset}`);
    const shuffled = seededShuffle(explorePool, seed).slice(0, explorationCount);

    // Interleave: one exploration slot every ~7 positions
    const result = [];
    let ei = 0;
    const gap = explorationCount > 0 ? Math.floor(mainCount / explorationCount) : Infinity;
    for (let i = 0; i < mainPool.length; i++) {
      result.push(mainPool[i]);
      if (ei < shuffled.length && (i + 1) % gap === 0) result.push(shuffled[ei++]);
    }
    while (ei < shuffled.length) result.push(shuffled[ei++]);

    return result.slice(0, limit);
  }

  // ── TRENDING ──────────────────────────────────────────────

  /**
   * Global trending videos ranked by velocity + popularity + recency.
   *
   * @param {number} limit
   * @param {number} windowMs
   * @param {number} now
   * @returns {Array<{videoId, authorId, title, score}>}
   */
  trending(limit = 10, windowMs = VELOCITY_WINDOW_MS, now = Date.now()) {
    if (this._dirty) this.build();

    return [...this._videos.values()]
      .map(vid => ({
        videoId: vid.id,
        authorId: vid.authorId,
        title: vid.title,
        score:
          0.5 * (vid.normalizedVelocity || 0) +
          0.3 * (vid.normalizedGlobal || 0) +
          0.2 * clamp(recencyScore(vid.createdAt, now, this._halfLife)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ── USER RECOMMENDATIONS ──────────────────────────────────

  /**
   * Suggest users to follow based on similarity + follow-back signals.
   *
   * @param {string} userId
   * @param {number} limit
   * @returns {Array<{userId, score, reason}>}
   */
  recommendUsers(userId, limit = 5) {
    if (!this._users.has(userId)) return [];
    if (this._dirty) this.build();

    const user = this._users.get(userId);
    const results = [];

    for (const [uid, other] of this._users) {
      if (uid === userId) continue;

      const sim = this._cf.userSimilarity(userId, uid);
      const alreadyFollows = user.followings.has(uid);
      const followsBack = other.followings.has(userId);

      let score = sim;
      let reason = "similar interests";

      if (followsBack && !alreadyFollows) {
        score += 0.3;
        reason = "follows you";
      }
      // Already-followed users are lower priority (still surfaced for context)
      if (alreadyFollows) {
        score *= 0.3;
        reason = "already following";
      }

      results.push({ userId: uid, score, reason });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ── ANALYTICS HELPERS ─────────────────────────────────────

  getUserItemMatrix() { return this._userItemMatrix; }
  getVideoIds() { return [...this._videos.keys()]; }
  getUserIds() { return [...this._users.keys()]; }

  /** Serialise to JSON for persistence (DB, Redis, file). */
  toJSON() {
    return {
      users: [...this._users.entries()].map(([id, u]) => ({
        id,
        followings: [...u.followings],
        seenVideos: [...u.seenVideos],
        highIntent: [...u.highIntent],
        likedVideos: [...u.likedVideos],
        repostedVideos: [...u.repostedVideos],
      })),
      videos: [...this._videos.entries()].map(([, v]) => ({ ...v })),
      interactions: this._interactions,
      userItemMatrix: [...this._userItemMatrix.entries()].map(([uid, map]) => ({
        userId: uid,
        items: [...map.entries()],
      })),
    };
  }

  /** Restore from toJSON output. */
  static fromJSON(json, opts = {}) {
    const engine = new RecommendationEngine(opts);

    if (json.users) {
      for (const u of json.users) {
        engine.addUser(u.id, u.followings);
        const user = engine._users.get(u.id);
        user.seenVideos = new Set(u.seenVideos || []);
        user.highIntent = new Set(u.highIntent || []);
        user.likedVideos = new Set(u.likedVideos || []);
        user.repostedVideos = new Set(u.repostedVideos || []);
      }
    }
    if (json.videos) {
      for (const v of json.videos) {
        engine.addVideo(v.id, v);
        // Restore computed stats (bypass re-computation from scratch)
        Object.assign(engine._videos.get(v.id), v);
      }
    }
    // Restore raw interaction log
    engine._interactions = json.interactions || [];

    // Restore user-item matrix
    if (json.userItemMatrix || json.interactions_matrix) {
      const source = json.userItemMatrix || json.interactions_matrix;
      for (const { userId, items } of source) {
        const uMap = engine._userItemMatrix.get(userId);
        if (uMap) for (const [vid, score] of items) uMap.set(vid, score);
      }
    }

    engine._dirty = true;
    return engine;
  }
}

// ─────────────────────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = { RecommendationEngine, TFIDFVectorizer, CollaborativeFilter };

// ─────────────────────────────────────────────────────────────
//  DEMO / SMOKE TEST
// ─────────────────────────────────────────────────────────────

function runDemo() {
  const engine = new RecommendationEngine();

  // Users
  engine.addUser("alice", ["bob", "carol"]);
  engine.addUser("bob");
  engine.addUser("carol");
  engine.addUser("dave");
  engine.addUser("eve");

  // Videos
  const now = Date.now();
  engine.addVideo("v1", { authorId: "bob", title: "Morning dance routine", tags: "#dance #fitness", createdAt: now - 2 * 3600e3 });
  engine.addVideo("v2", { authorId: "carol", title: "Healthy breakfast ideas", tags: "#food #fitness #healthy", createdAt: now - 5 * 3600e3 });
  engine.addVideo("v3", { authorId: "dave", title: "Guitar tutorial for beginners", tags: "#music #guitar", createdAt: now - 10 * 3600e3 });
  engine.addVideo("v4", { authorId: "bob", title: "Street dance challenge", tags: "#dance #challenge", createdAt: now - 1 * 3600e3 });
  engine.addVideo("v5", { authorId: "carol", title: "5-minute workout", tags: "#fitness #workout", createdAt: now - 3 * 3600e3 });
  engine.addVideo("v6", { authorId: "dave", title: "Cooking pasta from scratch", tags: "#food #cooking", createdAt: now - 8 * 3600e3 });
  engine.addVideo("v7", { authorId: "alice", title: "My fitness journey", tags: "#fitness #motivation", createdAt: now - 12 * 3600e3 });

  // Interactions
  engine.addInteraction("alice", "v1", "like");
  engine.addInteraction("alice", "v1", "watch_full");
  engine.addInteraction("alice", "v2", "watch_partial");
  engine.addInteraction("alice", "v5", "repost");
  engine.addInteraction("bob", "v1", "like");
  engine.addInteraction("bob", "v4", "watch_full");
  engine.addInteraction("bob", "v5", "like");
  engine.addInteraction("carol", "v2", "repost");
  engine.addInteraction("carol", "v5", "watch_full");
  engine.addInteraction("carol", "v6", "like");
  engine.addInteraction("dave", "v3", "watch_full");
  engine.addInteraction("dave", "v6", "watch_full");
  engine.addInteraction("dave", "v4", "view");

  // ── Recommendations ──
  console.log("📽  Alice (follows bob, carol | likes dance+fitness)\n");
  engine.recommend("alice", { limit: 5 }).forEach((r, i) => {
    const seen = r.isSeen ? (r.isHighIntent ? " [HIGH-INTENT-SEEN]" : " [seen]") : "";
    console.log(`  ${i + 1}. [${r.videoId}] "${r.title}"${seen}`);
    console.log(`     score=${r.finalScore.toFixed(4)}  driver="${r.primarySignal}"`);
  });

  console.log("\n📽  Alice — Page 2 (offset=5)\n");
  engine.recommend("alice", { limit: 5, offset: 5 }).forEach((r, i) => {
    const seen = r.isSeen ? (r.isHighIntent ? " [HIGH-INTENT-SEEN]" : " [seen]") : "";
    console.log(`  ${i + 1}. [${r.videoId}] "${r.title}"${seen}`);
    console.log(`     score=${r.finalScore.toFixed(4)}  driver="${r.primarySignal}"`);
  });

  console.log("\n📽  Eve (cold start)\n");
  engine.recommend("eve", { limit: 5 }).forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.videoId}] "${r.title}"  score=${r.finalScore.toFixed(4)}  driver="${r.primarySignal}"`);
  });

  console.log("\n🔥  Global trending (last 6h)\n");
  engine.trending(5).forEach((r, i) => {
    console.log(`  ${i + 1}. [${r.videoId}] "${r.title}"  score=${r.score.toFixed(4)}`);
  });

  console.log("\n👥  User recs for Alice\n");
  engine.recommendUsers("alice", 3).forEach((u, i) => {
    console.log(`  ${i + 1}. ${u.userId}  score=${u.score.toFixed(4)}  reason="${u.reason}"`);
  });

  console.log("\n💾  Serialisation roundtrip");
  const engine2 = RecommendationEngine.fromJSON(engine.toJSON());
  const top = engine2.recommend("alice", { limit: 3 });
  console.log(`  Rebuilt OK — top: [${top[0]?.videoId}] "${top[0]?.title}"`);
  console.log("\n✅  Done.\n");
}
