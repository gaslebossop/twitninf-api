/**
 * 🤖 BotDetectionService v4.0 (100% AI Driven)
 *
 * Migration finale : Suppression des systèmes heuristiques au profit 
 * du moteur de décision XGBoost Python (BotBrain).
 */

'use strict';

const { User, UserBehaviorData, BotReputation, TweetLike, TweetRetweet, UserFollow, sequelize } = require('../models');
const logger = require('../utils/logger');
logger.info('🚀 [BotDetectionService] Initialisation du moteur IA Brain-Engine...');
const BrainDetector = require('../../../brain-engine/BrainDetector');
const FeatureExtractor = require('../../../brain-engine/FeatureExtractor');

// ─── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
  AUTO_SANCTION: process.env.BOT_DETECTION_AUTO_SANCTION === 'true',
  ENABLED: false, // 🚨 Désactivé temporairement car il bannit tout le monde

  CACHE_TTL_CLEAN_MS: 5_000,
  CACHE_TTL_BOT_MS: 60_000,
  CACHE_MAX_SIZE: 10_000,

  ACTIONS_FETCH_LIMIT: 50,
  MIN_ACTIONS_REQUIRED: 5,
  
  // Seuil de bannissement basé sur la probabilité IA (0-100)
  AI_BAN_THRESHOLD: 70,
  AI_REVIEW_THRESHOLD: 60,

  CB_ERROR_THRESHOLD: 5,
  CB_RESET_MS: 30_000,

  BURST_THRESHOLD: 3, // Nombre de requêtes max par seconde avant d'invalider le cache

  BANS: [
    { maxBanCount: 0, days: 7, label: '7j (1ʳᵉ infraction)' },
    { maxBanCount: 1, days: 30, label: '30j (2ᵉ infraction)' },
    { maxBanCount: 2, days: 180, label: '180j (3ᵉ infraction)' },
    { maxBanCount: Infinity, days: 36500, label: 'Ban définitif' },
  ],
};

// ─── Cache & Circuit Breaker ──────────────────────────────────────────────────

class DualTTLLRUCache {
  constructor(maxSize) { this.map = new Map(); this.maxSize = maxSize; }
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.map.delete(key); return null; }
    
    // --- BYPASS DE CACHE SI RAFALE ---
    entry.count = (entry.count || 0) + 1;
    const timeSinceFirst = Date.now() - (entry.firstRequest || Date.now());
    if (entry.count > CONFIG.BURST_THRESHOLD && timeSinceFirst < 1000) {
        return null;
    }
    if (entry.count === 1) entry.firstRequest = Date.now();

    this.map.delete(key); this.map.set(key, entry);
    return entry.data;
  }
  set(key, data, ttlMs) {
    if (this.map.size >= this.maxSize) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { data, expiresAt: Date.now() + ttlMs, count: 0, firstRequest: Date.now() });
  }
  invalidate(key) { this.map.delete(key); }
}

class CircuitBreaker {
  constructor(threshold, resetMs) { this.threshold = threshold; this.resetMs = resetMs; this.errors = 0; this.openedAt = null; }
  get isOpen() {
    if (this.openedAt && Date.now() - this.openedAt > this.resetMs) { this.errors = 0; this.openedAt = null; }
    return this.openedAt !== null;
  }
  recordSuccess() { this.errors = 0; }
  recordError() {
    this.errors++;
    if (this.errors >= this.threshold) { this.openedAt = Date.now(); logger.error('[BotDetection-AI] Circuit-breaker OUVERT'); }
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

class BotDetectionService {
  constructor() {
    this.cache = new DualTTLLRUCache(CONFIG.CACHE_MAX_SIZE);
    this.breaker = new CircuitBreaker(CONFIG.CB_ERROR_THRESHOLD, CONFIG.CB_RESET_MS);
  }

  /**
   * Analyse et sanctionne un utilisateur via le verdict exclusif de l'IA
   */
  async analyzeAndSanction(userId, context = {}) {
    if (!CONFIG.ENABLED) return { isBot: false, skipped: 'Bot detection is disabled' };
    if (this.breaker.isOpen) return { isBot: false, skipped: 'Circuit-breaker open' };

    const cached = this.cache.get(userId);
    if (cached) return { ...cached, cached: true };

    try {
      const [user, actions, reputation] = await Promise.all([
        User.findByPk(userId, { attributes: ['id', 'ban_count', 'created_at', 'verified'], raw: true }),
        UserBehaviorData.findAll({
          where: { user_id: userId },
          order: [['timestamp', 'DESC']],
          limit: CONFIG.ACTIONS_FETCH_LIMIT,
          attributes: ['action_type', 'timestamp', 'client_timestamp', 'target_id', 'device_info', 'context_data', 'duration_ms'],
          raw: true,
        }),
        BotReputation?.findOne({ where: { user_id: userId }, raw: true }).catch(() => null),
      ]);

      if (!user || actions.length < CONFIG.MIN_ACTIONS_REQUIRED) {
        return { isBot: false, reason: 'insufficient_data' };
      }

      // 1. Extraction des caractéristiques synchronisées avec Python (11 features)
      const features = FeatureExtractor.extract(actions);
      if (!features) return { isBot: false, error: 'feature_extraction_failed' };

      // 1.5. FAST HEURISTIC LAYER (Immediate Mitigation for extreme bursts)
      const fastResult = this._fastHeuristicCheck(features);
      if (fastResult.isBot) {
          logger.warn(`🚀 [BotDetection-Fast] user=${userId} détecté via HEURISTIQUE (${fastResult.reason})`);
          if (!CONFIG.AUTO_SANCTION) {
            await this._updateReputation(userId, 99);
            return { isBot: true, score: 99, reasons: [fastResult.reason], meta: { features, fast: true, monitor_only: true } };
          }
          await this._applyProgressiveSanction(userId, 99, [fastResult.reason], { features, fast: true });
          await this._rollbackFraudulentInteractions(userId, actions);
          return { isBot: true, score: 99, reasons: [fastResult.reason], meta: { fast: true } };
      }

      // 2. Verdict de l'IA XGBoost (Asynchrone via HTTP)
      const aiVerdict = await BrainDetector.predict(features);
      this.breaker.recordSuccess();

      const score = aiVerdict.score || 0;
      const reasons = aiVerdict.reasons || [`ai_verdict_prob_${score}%`];
      const meta = { ai: aiVerdict, stats: features };

      logger.info(`🔍 [BotDetection-AI] user=${userId} score=${score}% isBot=${aiVerdict.isBot}`);

      // 3. Sanction progressive si le seuil IA est dépassé
      if (score >= CONFIG.AI_BAN_THRESHOLD) {
        if (!CONFIG.AUTO_SANCTION) {
          await this._updateReputation(userId, score);
          const result = { isBot: true, score, reasons, meta: { ...meta, monitor_only: true } };
          this.cache.set(userId, result, CONFIG.CACHE_TTL_BOT_MS);
          return result;
        }
        await this._applyProgressiveSanction(userId, score, reasons, meta);
        await this._updateReputation(userId, score);
        
        // 🧹 ROLLBACK : Supprimer les interactions frauduleuses de la session détectée
        await this._rollbackFraudulentInteractions(userId, actions);

        const result = { isBot: true, score, reasons, meta };
        this.cache.set(userId, result, CONFIG.CACHE_TTL_BOT_MS);
        return result;
      }

      // 4. Mise en cache propre (Humain)
      const result = { isBot: false, score, reasons };
      this.cache.set(userId, result, CONFIG.CACHE_TTL_CLEAN_MS);
      return result;

    } catch (err) {
      this.breaker.recordError();
      logger.error(`❌ [BotDetection-AI] Erreur fatale user=${userId}:`, err);
      return { isBot: false, error: err.message };
    }
  }

  async _updateReputation(userId, score) {
    try { await BotReputation.upsert({ user_id: userId, last_score: score, updated_at: new Date() }); } catch (e) {}
  }

  /**
   * 🧹 Rollback ciblé : supprime uniquement les likes et retweets
   * de la fenêtre d'actions qui a déclenché la détection.
   */
  async _rollbackFraudulentInteractions(userId, detectedActions) {
    try {
      // Extraire les target_id des likes et retweets dans la fenêtre de fraude
      const fraudLikeTargets = detectedActions
        .filter(a => a.action_type === 'tweet_like')
        .map(a => a.target_id)
        .filter(Boolean);

      const fraudRetweetTargets = detectedActions
        .filter(a => a.action_type === 'tweet_retweet')
        .map(a => a.target_id)
        .filter(Boolean);

      const fraudFollowTargets = detectedActions
        .filter(a => a.action_type === 'user_follow')
        .map(a => a.target_id)
        .filter(Boolean);

      let deletedLikes = 0;
      let deletedRetweets = 0;
      let deletedFollows = 0;

      // Supprimer les likes frauduleux
      if (fraudLikeTargets.length > 0) {
        deletedLikes = await TweetLike.destroy({
          where: {
            user_id: userId,
            tweet_id: fraudLikeTargets
          },
          individualHooks: true
        });
      }

      // Supprimer les retweets frauduleux
      if (fraudRetweetTargets.length > 0) {
        deletedRetweets = await TweetRetweet.destroy({
          where: {
            user_id: userId,
            tweet_id: fraudRetweetTargets
          },
          individualHooks: true
        });
      }

      // Supprimer les follows frauduleux
      if (fraudFollowTargets.length > 0) {
        deletedFollows = await UserFollow.destroy({
          where: {
            follower_id: userId,
            following_id: fraudFollowTargets
          },
          individualHooks: true
        });
      }

      if (deletedLikes > 0 || deletedRetweets > 0 || deletedFollows > 0) {
        logger.warn(`🧹 [ROLLBACK] user=${userId} : ${deletedLikes} likes, ${deletedRetweets} RTs et ${deletedFollows} follows frauduleux supprimés`);
      }

    } catch (err) {
      logger.error(`❌ [ROLLBACK] Erreur pour user=${userId}: ${err.message || err.toString()}`);
      if (err.stack) logger.error(err.stack);
    }
  }

  async _applyProgressiveSanction(userId, score, reasons, meta) {
    await sequelize.transaction(async t => {
      const user = await User.findByPk(userId, { attributes: ['id', 'ban_count'], lock: true, transaction: t });
      if (!user) return;
      
      const policy = CONFIG.BANS.find(b => user.ban_count <= b.maxBanCount) || CONFIG.BANS.at(-1);
      const until = new Date(); 
      until.setDate(until.getDate() + policy.days);

      logger.warn(`🚫 [BotDetection-AI] BAN user=${userId} pour ${policy.days} jours. Raison: AI_PROB_${score}% | Motifs: ${reasons.join(', ')}`);

      await User.update({
        is_suspended: true,
        suspended_at: new Date(),
        suspended_until: until,
        suspension_reason: 'bot_ai',
        ban_count: user.ban_count + 1,
        suspension_meta: { score, reasons, meta, model: 'xgboost_v22' }
      }, { where: { id: userId }, transaction: t });
    });
  }

  /**
   * ⚡ Couche Heuristique Rapide (Fast mitigation)
   * Détecte les anomalies extrêmes sans attendre l'IA.
   */
  _fastHeuristicCheck(features) {
    // 1. Burst Extrême attendu (plus de 8 actions par seconde)
    if (features.intensity > 8.0) {
      return { isBot: true, reason: 'extreme_burst_intensity' };
    }

    // 2. Régularité parfaite (Signe de métronome robotique)
    if (features.regularity < 0.05 && features.avg_delay < 0.3) {
      return { isBot: true, reason: 'perfect_robotic_regularity' };
    }

    // 3. Absence totale de signaux humains V5 sur une longue période
    if (features.human_signal_ratio === 0 && features.unique_actions_ratio < 0.2) {
      return { isBot: true, reason: 'zero_human_signal_v5' };
    }

    return { isBot: false };
  }
}

module.exports = new BotDetectionService();
