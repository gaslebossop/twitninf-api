/**
 * 📊 Tracker de Viralité en Temps Réel - TwitNin Legacy
 * 
 * Service de suivi de la viralité des tweets avec expansion progressive
 * des groupes de recommandation selon les interactions utilisateur.
 * 
 * @author TwitNin Team
 * @version 1.0.0 - Real-time Viral Tracking
 * @license MIT
 */

const { Op, fn, col, literal, Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const { User, Tweet, TweetLike, TweetRetweet, UserBehaviorData, UserFollow } = require('../models');

class ViralityTracker {
  constructor() {
    this.trackingCache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
    
    // Configuration des seuils de viralité (basés sur les ratios d'engagement)
    this.viralityThresholds = {
      // Seuils pour passer au niveau suivant (basés sur les ratios)
      initial_to_expansion: {
        minEngagementRate: 0.25,  // 25% d'engagement (1 interaction sur 4 vues)
        minViews: 4,              // Minimum 4 vues pour évaluer
        timeWindow: 30 * 60 * 1000 // 30 minutes
      },
      expansion_to_viral: {
        minEngagementRate: 0.30,  // 30% d'engagement (3 interactions sur 10 vues)
        minViews: 10,             // Minimum 10 vues pour évaluer
        timeWindow: 60 * 60 * 1000 // 1 heure
      },
      viral_to_massive: {
        minEngagementRate: 0.40,  // 40% d'engagement (10 interactions sur 25 vues)
        minViews: 25,             // Minimum 25 vues pour évaluer
        timeWindow: 90 * 60 * 1000 // 1h30
      }
    };
    
    // Seuils pour maintenir la recommandation (basés sur les ratios)
    this.maintenanceThresholds = {
      initial: { 
        minEngagementRate: 0.20,  // 20% d'engagement minimum
        minViews: 2,              // Minimum 2 vues pour évaluer
        timeWindow: 15 * 60 * 1000 
      },
      expansion: { 
        minEngagementRate: 0.25,  // 25% d'engagement minimum
        minViews: 4,              // Minimum 4 vues pour évaluer
        timeWindow: 30 * 60 * 1000 
      },
      viral: { 
        minEngagementRate: 0.30,  // 30% d'engagement minimum
        minViews: 10,             // Minimum 10 vues pour évaluer
        timeWindow: 60 * 60 * 1000 
      },
      massive: { 
        minEngagementRate: 0.25,  // 25% d'engagement minimum
        minViews: 10,             // Vérifier toutes les 10 vues
        timeWindow: 90 * 60 * 1000,
        checkInterval: 10         // Vérifier toutes les 10 vues
      }
    };
    
    // Seuils d'arrêt (interactions négatives) - plus stricts pour petit groupe
    this.stopThresholds = {
      maxNegativeInteractions: 2,  // 2 interactions négatives (au lieu de 5)
      maxNegativeRate: 0.20,       // 20% (au lieu de 10%) - plus tolérant
      timeWindow: 30 * 60 * 1000   // 30 minutes (au lieu de 1 heure)
    };
  }

  /**
   * Enregistre une interaction et met à jour la viralité
   */
  async trackInteraction(tweetId, userId, interactionType, metadata = {}) {
    try {
      logger.info(`📊 Tracking interaction: ${interactionType} sur tweet ${tweetId} par ${userId}`);
      
      // Récupérer le tweet
      const tweet = await Tweet.findByPk(tweetId, {
        include: [
          { model: User, as: 'author', attributes: ['id', 'username', 'followers_count'] }
        ]
      });
      
      if (!tweet) {
        throw new Error('Tweet non trouvé');
      }
      
      // Calculer le score de l'interaction
      const interactionScore = this.calculateInteractionScore(interactionType, metadata);
      
      // Mettre à jour le cache de tracking
      await this.updateViralityCache(tweetId, interactionScore, interactionType);
      
    // Vérifier si le tweet peut passer au niveau suivant
    const newLevel = await this.checkLevelProgression(tweetId);
    
    // Vérifier si le tweet doit être arrêté
    const shouldStop = await this.checkStopConditions(tweetId);
    
    // Vérifier si le tweet au niveau massif doit continuer (toutes les 10 vues)
    const shouldContinueMassive = await this.checkMassiveLevelContinuation(tweetId);
    
    // Mettre à jour les recommandations en temps réel
    if (newLevel || shouldStop || !shouldContinueMassive) {
      await this.updateRecommendationLevel(tweetId, newLevel, shouldStop || !shouldContinueMassive);
    }
      
      // Enregistrer l'interaction dans UserBehaviorData
      await this.recordInteraction(tweetId, userId, interactionType, metadata, interactionScore);
      
      logger.info(`✅ Interaction trackée: ${interactionType} sur tweet ${tweetId} (score: ${interactionScore})`);
      
      return {
        success: true,
        tweetId,
        interactionType,
        score: interactionScore,
        newLevel,
        shouldStop
      };
      
    } catch (error) {
      logger.error('❌ Erreur lors du tracking de l\'interaction:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calcule le score d'une interaction
   */
  calculateInteractionScore(interactionType, metadata = {}) {
    const baseScores = {
      // Interactions positives
      'tweet_like': 1.0,
      'tweet_comment': 3.0,
      'tweet_retweet': 5.0,
      'tweet_share': 4.0,
      'profile_view': 2.0,
      'tweet_view': 0.5,
      'tweet_bookmark': 2.5,
      'link_click': 1.0,
      'media_view': 1.5,
      'hashtag_click': 1.0,
      
      // Interactions négatives
      'tweet_unlike': -1.0,
      'tweet_unretweet': -2.0,
      'tweet_report': -10.0,
      'user_block': -15.0,
      'user_mute': -5.0,
      'content_skip': -0.5
    };
    
    let score = baseScores[interactionType] || 0;
    
    // Modificateurs basés sur les métadonnées
    if (metadata.duration) {
      // Bonus pour le temps de visualisation
      score += Math.min(metadata.duration / 1000 * 0.1, 2.0); // Max 2 points
    }
    
    if (metadata.scrollPause) {
      // Bonus pour les pauses de scroll (engagement)
      score += 0.3;
    }
    
    if (metadata.fullscreen) {
      // Bonus pour le mode plein écran
      score += 1.0;
    }
    
    if (metadata.deviceType === 'mobile') {
      // Bonus pour les interactions mobiles (plus engageantes)
      score *= 1.1;
    }
    
    return score;
  }

  /**
   * Met à jour le cache de viralité
   */
  async updateViralityCache(tweetId, score, interactionType) {
    const now = Date.now();
    const cacheKey = `virality_${tweetId}`;
    
    if (!this.trackingCache.has(cacheKey)) {
      this.trackingCache.set(cacheKey, {
        tweetId,
        totalScore: 0,
        positiveInteractions: 0,
        negativeInteractions: 0,
        interactions: [],
        currentLevel: 'initial',
        lastUpdated: now,
        createdAt: now
      });
    }
    
    const viralityData = this.trackingCache.get(cacheKey);
    
    // Mettre à jour les scores
    viralityData.totalScore += score;
    viralityData.lastUpdated = now;
    
    if (score > 0) {
      viralityData.positiveInteractions++;
    } else if (score < 0) {
      viralityData.negativeInteractions++;
    }
    
    // Ajouter l'interaction à l'historique
    viralityData.interactions.push({
      type: interactionType,
      score,
      timestamp: now
    });
    
    // Garder seulement les 100 dernières interactions
    if (viralityData.interactions.length > 100) {
      viralityData.interactions = viralityData.interactions.slice(-100);
    }
    
    this.trackingCache.set(cacheKey, viralityData);
  }

  /**
   * Vérifie si le tweet peut passer au niveau suivant (basé sur les ratios)
   */
  async checkLevelProgression(tweetId) {
    const viralityData = this.trackingCache.get(`virality_${tweetId}`);
    if (!viralityData) return null;
    
    const currentLevel = viralityData.currentLevel;
    const nextLevel = this.getNextLevel(currentLevel);
    const threshold = this.viralityThresholds[`${currentLevel}_to_${nextLevel}`];
    
    if (!threshold) return null;
    
    // Récupérer les interactions récentes
    const recentInteractions = viralityData.interactions.filter(
      i => Date.now() - i.timestamp < threshold.timeWindow
    );
    
    // Compter les vues et interactions
    const views = recentInteractions.filter(i => i.type === 'tweet_view').length;
    const positiveInteractions = recentInteractions.filter(i => i.score > 0).length;
    
    // Vérifier si on a assez de vues pour évaluer
    if (views < threshold.minViews) return null;
    
    // Calculer le ratio d'engagement
    const engagementRate = positiveInteractions / views;
    
    // Vérifier les conditions de progression
    if (engagementRate >= threshold.minEngagementRate) {
      const newLevel = nextLevel;
      viralityData.currentLevel = newLevel;
      this.trackingCache.set(`virality_${tweetId}`, viralityData);
      
      logger.info(`🚀 Tweet ${tweetId} passe au niveau ${newLevel} (ratio: ${(engagementRate * 100).toFixed(1)}%)`);
      return newLevel;
    }
    
    return null;
  }

  /**
   * Vérifie si le tweet doit être arrêté (basé sur les ratios)
   */
  async checkStopConditions(tweetId) {
    const viralityData = this.trackingCache.get(`virality_${tweetId}`);
    if (!viralityData) return false;
    
    const recentInteractions = viralityData.interactions.filter(
      i => Date.now() - i.timestamp < this.stopThresholds.timeWindow
    );
    
    const views = recentInteractions.filter(i => i.type === 'tweet_view').length;
    const negativeInteractions = recentInteractions.filter(i => i.score < 0).length;
    
    // Vérifier les conditions d'arrêt basées sur les ratios
    if (views > 0) {
      const negativeRatio = negativeInteractions / views;
      
      if (negativeRatio >= this.stopThresholds.maxNegativeRate) {
        logger.info(`🛑 Tweet ${tweetId} arrêté (ratio négatif: ${(negativeRatio * 100).toFixed(1)}%)`);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Vérifie si le tweet au niveau massif doit continuer (toutes les 10 vues)
   */
  async checkMassiveLevelContinuation(tweetId) {
    const viralityData = this.trackingCache.get(`virality_${tweetId}`);
    if (!viralityData || viralityData.currentLevel !== 'massive') return true;
    
    // Vérifier si on a atteint l'intervalle de vérification (toutes les 10 vues)
    const totalViews = viralityData.interactions.filter(i => i.type === 'tweet_view').length;
    const lastCheckViews = viralityData.lastCheckViews || 0;
    
    if (totalViews - lastCheckViews < this.maintenanceThresholds.massive.checkInterval) {
      return true; // Pas encore le moment de vérifier
    }
    
    // Mettre à jour le compteur de vérification
    viralityData.lastCheckViews = totalViews;
    this.trackingCache.set(`virality_${tweetId}`, viralityData);
    
    // Récupérer les interactions récentes pour la vérification
    const recentInteractions = viralityData.interactions.filter(
      i => Date.now() - i.timestamp < this.maintenanceThresholds.massive.timeWindow
    );
    
    const recentViews = recentInteractions.filter(i => i.type === 'tweet_view').length;
    const recentPositiveInteractions = recentInteractions.filter(i => i.score > 0).length;
    
    // Vérifier si on a assez de vues pour évaluer
    if (recentViews < this.maintenanceThresholds.massive.minViews) {
      return true; // Pas assez de vues récentes
    }
    
    // Calculer le ratio d'engagement récent
    const engagementRate = recentPositiveInteractions / recentViews;
    
    // Vérifier si le tweet doit continuer
    if (engagementRate >= this.maintenanceThresholds.massive.minEngagementRate) {
      logger.info(`✅ Tweet ${tweetId} continue au niveau massif (ratio: ${(engagementRate * 100).toFixed(1)}%)`);
      return true;
    } else {
      logger.info(`⏹️ Tweet ${tweetId} arrêté du niveau massif (ratio: ${(engagementRate * 100).toFixed(1)}%)`);
      return false;
    }
  }

  /**
   * Met à jour le niveau de recommandation
   */
  async updateRecommendationLevel(tweetId, newLevel, shouldStop) {
    try {
      // Mettre à jour la base de données
      const updateData = {};
      
      if (shouldStop) {
        updateData.recommendation_status = 'stopped';
        updateData.stopped_at = new Date();
      } else if (newLevel) {
        updateData.recommendation_level = newLevel;
        updateData.level_updated_at = new Date();
      }
      
      if (Object.keys(updateData).length > 0) {
        await Tweet.update(updateData, { where: { id: tweetId } });
      }
      
      // Nettoyer le cache des recommandations
      this.clearRecommendationCache();
      
    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour du niveau de recommandation:', error);
    }
  }

  /**
   * Enregistre l'interaction dans UserBehaviorData
   */
  async recordInteraction(tweetId, userId, interactionType, metadata, score) {
    try {
      await UserBehaviorData.create({
        user_id: userId,
        action_type: interactionType,
        target_id: tweetId,
        target_type: 'tweet',
        context_data: {
          ...metadata,
          virality_score: score,
          timestamp: new Date().toISOString()
        },
        interaction_quality: Math.max(0, Math.min(1, (score + 10) / 20)), // Normaliser entre 0 et 1
        processed: false
      });
    } catch (error) {
      logger.error('❌ Erreur lors de l\'enregistrement de l\'interaction:', error);
    }
  }

  /**
   * Obtient le niveau suivant
   */
  getNextLevel(currentLevel) {
    const levels = ['initial', 'expansion', 'viral', 'massive'];
    const currentIndex = levels.indexOf(currentLevel);
    return currentIndex < levels.length - 1 ? levels[currentIndex + 1] : 'massive';
  }

  /**
   * Obtient les statistiques de viralité d'un tweet
   */
  async getTweetViralityStats(tweetId) {
    const viralityData = this.trackingCache.get(`virality_${tweetId}`);
    
    if (!viralityData) {
      // Récupérer depuis la base de données si pas en cache
      const tweet = await Tweet.findByPk(tweetId, {
        attributes: ['id', 'recommendation_level', 'recommendation_status', 'stopped_at', 'level_updated_at']
      });
      
      return {
        tweetId,
        currentLevel: tweet?.recommendation_level || 'initial',
        status: tweet?.recommendation_status || 'active',
        totalScore: 0,
        positiveInteractions: 0,
        negativeInteractions: 0,
        lastUpdated: null
      };
    }
    
    return {
      tweetId,
      currentLevel: viralityData.currentLevel,
      status: 'active',
      totalScore: viralityData.totalScore,
      positiveInteractions: viralityData.positiveInteractions,
      negativeInteractions: viralityData.negativeInteractions,
      lastUpdated: new Date(viralityData.lastUpdated)
    };
  }

  /**
   * Obtient les tweets viraux en temps réel
   */
  async getViralTweets(limit = 20) {
    const viralTweets = [];
    
    for (const [key, data] of this.trackingCache.entries()) {
      if (data.currentLevel === 'viral' && data.totalScore > 50) {
        viralTweets.push({
          tweetId: data.tweetId,
          score: data.totalScore,
          level: data.currentLevel,
          positiveInteractions: data.positiveInteractions,
          negativeInteractions: data.negativeInteractions,
          lastUpdated: new Date(data.lastUpdated)
        });
      }
    }
    
    return viralTweets
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Nettoie le cache expiré
   */
  cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.trackingCache.entries()) {
      if (now - value.lastUpdated > this.cacheExpiry) {
        this.trackingCache.delete(key);
      }
    }
    logger.info('🧹 Cache de viralité nettoyé');
  }

  /**
   * Nettoie le cache des recommandations
   */
  clearRecommendationCache() {
    // Cette méthode sera appelée par le moteur de recommandation
    logger.info('🔄 Cache des recommandations nettoyé');
  }
}

module.exports = ViralityTracker;
