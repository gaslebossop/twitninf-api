/**
 * 📊 Service de Chargement des Données Comportementales
 * 
 * Charge et prépare les données comportementales pour l'algorithme Smart
 */

const { UserBehaviorData, UserPreferences, User, Tweet } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

class BehaviorDataLoader {
  constructor() {
    this.cache = {
      userProfiles: new Map(),
      behaviorPatterns: new Map(),
      globalStats: null,
      lastUpdate: null
    };
    
    this.cacheConfig = {
      userProfileTTL: 10 * 60 * 1000,    // 10 minutes
      behaviorPatternsTTL: 30 * 60 * 1000, // 30 minutes
      globalStatsTTL: 60 * 60 * 1000,    // 1 heure
      maxCacheSize: 1000
    };
  }

  /**
   * 🚀 Initialisation au démarrage
   */
  async initializeOnStartup() {
    try {
      logger.info('📊 Chargement des données comportementales au démarrage...');

      // 1. Charger les statistiques globales
      await this.loadGlobalBehaviorStats();

      // 2. Pré-charger les patterns des utilisateurs actifs
      await this.preloadActiveUserPatterns();

      // 3. Analyser les tendances récentes
      await this.analyzeTrendingBehaviors();

      // 4. Calculer les scores de personnalisation
      await this.calculatePersonalizationScores();

      logger.info('✅ Chargement des données comportementales terminé');

      // Démarrer le rafraîchissement périodique
      this.startPeriodicRefresh();

    } catch (error) {
      logger.error('❌ Erreur chargement données comportementales:', error);
      throw error;
    }
  }

  /**
   * 📈 Charger les statistiques globales
   */
  async loadGlobalBehaviorStats() {
    try {
      logger.info('📈 Chargement des statistiques globales...');

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const globalStats = {
        totalActions: await UserBehaviorData.count({
          where: this.realBehaviorWhere()
        }),
        weeklyActions: await UserBehaviorData.count({
          where: this.realBehaviorWhere({ timestamp: { [Op.gte]: sevenDaysAgo } })
        }),
        dailyActions: await UserBehaviorData.count({
          where: this.realBehaviorWhere({ timestamp: { [Op.gte]: oneDayAgo } })
        }),
        activeUsers: await this.getActiveUsersCount(),
        topActions: await this.getTopActionTypes(),
        engagementRate: await this.calculateGlobalEngagementRate(),
        qualityScore: await this.calculateGlobalQualityScore(),
        timestamp: new Date()
      };

      this.cache.globalStats = globalStats;
      logger.info(`📊 Stats globales: ${globalStats.totalActions} actions, ${globalStats.activeUsers} utilisateurs actifs`);

      return globalStats;

    } catch (error) {
      logger.error('❌ Erreur chargement stats globales:', error);
      return null;
    }
  }

  /**
   * 👥 Pré-charger les patterns des utilisateurs actifs
   */
  async preloadActiveUserPatterns() {
    try {
      logger.info('👥 Pré-chargement des patterns utilisateurs actifs...');

      // Récupérer les utilisateurs les plus actifs des 7 derniers jours
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const activeUsers = await UserBehaviorData.findAll({
        attributes: [
          'user_id',
          [UserBehaviorData.sequelize.fn('COUNT', UserBehaviorData.sequelize.col('id')), 'action_count']
        ],
        where: this.realBehaviorWhere({ timestamp: { [Op.gte]: sevenDaysAgo } }),
        group: ['user_id'],
        having: UserBehaviorData.sequelize.literal('COUNT(id) >= 10'), // Au moins 10 actions
        order: [[UserBehaviorData.sequelize.literal('action_count'), 'DESC']],
        limit: 100 // Top 100 utilisateurs les plus actifs
      });

      logger.info(`📊 ${activeUsers.length} utilisateurs actifs trouvés`);

      // Charger les patterns pour chaque utilisateur actif
      const loadPromises = activeUsers.map(user => 
        this.loadUserBehaviorProfile(user.user_id, false) // false = ne pas utiliser le cache
      );

      await Promise.all(loadPromises);

      logger.info(`✅ Patterns pré-chargés pour ${activeUsers.length} utilisateurs`);

    } catch (error) {
      logger.error('❌ Erreur pré-chargement patterns:', error);
    }
  }

  /**
   * 🔥 Analyser les tendances comportementales
   */
  async analyzeTrendingBehaviors() {
    try {
      logger.info('🔥 Analyse des tendances comportementales...');

      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

      // Analyser les actions en tendance
      const trendingActions = await UserBehaviorData.findAll({
        attributes: [
          'action_type',
          [UserBehaviorData.sequelize.fn('COUNT', UserBehaviorData.sequelize.col('id')), 'count_today'],
          [UserBehaviorData.sequelize.literal(`COUNT(CASE WHEN timestamp >= '${twoDaysAgo.toISOString()}' AND timestamp < '${oneDayAgo.toISOString()}' THEN 1 END)`), 'count_yesterday']
        ],
        where: this.realBehaviorWhere({ timestamp: { [Op.gte]: twoDaysAgo } }),
        group: ['action_type'],
        order: [[UserBehaviorData.sequelize.literal('count_today'), 'DESC']]
      });

      // Calculer les tendances (croissance par rapport à hier)
      const trends = trendingActions.map(action => {
        const today = parseInt(action.dataValues.count_today);
        const yesterday = parseInt(action.dataValues.count_yesterday);
        const growth = yesterday > 0 ? ((today - yesterday) / yesterday * 100) : 0;

        return {
          action_type: action.action_type,
          count: today,
          growth_rate: Math.round(growth * 100) / 100,
          trend: growth > 10 ? 'rising' : growth < -10 ? 'falling' : 'stable'
        };
      });

      this.cache.behaviorPatterns.set('trending_actions', {
        data: trends,
        timestamp: new Date()
      });

      logger.info(`📈 ${trends.length} tendances comportementales analysées`);
      return trends;

    } catch (error) {
      logger.error('❌ Erreur analyse tendances:', error);
      return [];
    }
  }

  /**
   * 🎯 Charger le profil comportemental d'un utilisateur
   */
  async loadUserBehaviorProfile(userId, useCache = true) {
    try {
      // Vérifier le cache
      if (useCache) {
        const cached = this.cache.userProfiles.get(userId);
        if (cached && Date.now() - cached.timestamp < this.cacheConfig.userProfileTTL) {
          return cached.data;
        }
      }

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // Récupérer les données comportementales récentes
      const behaviorData = await UserBehaviorData.findAll({
        where: {
          user_id: userId,
          ...this.realBehaviorWhere({ timestamp: { [Op.gte]: thirtyDaysAgo } })
        },
        order: [['timestamp', 'DESC']],
        limit: 1000
      });

      // Récupérer les préférences utilisateur
      const preferences = await UserPreferences.findOne({
        where: { user_id: userId }
      });

      // Analyser les patterns comportementaux
      const profile = this.analyzeBehaviorPatterns(behaviorData, preferences);

      // Mettre en cache
      this.cache.userProfiles.set(userId, {
        data: profile,
        timestamp: Date.now()
      });

      // Nettoyer le cache si trop grand
      if (this.cache.userProfiles.size > this.cacheConfig.maxCacheSize) {
        this.cleanupCache('userProfiles');
      }

      return profile;

    } catch (error) {
      logger.error(`❌ Erreur chargement profil utilisateur ${userId}:`, error);
      return null;
    }
  }

  /**
   * 🧠 Analyser les patterns comportementaux
   */
  analyzeBehaviorPatterns(behaviorData, preferences) {
    try {
      const profile = {
        user_id: behaviorData[0]?.user_id,
        total_actions: behaviorData.length,
        preferences: preferences || null,
        activity_patterns: this.analyzeActivityPatterns(behaviorData),
        engagement_patterns: this.analyzeEngagementPatterns(behaviorData),
        content_preferences: this.analyzeContentPreferences(behaviorData),
        temporal_patterns: this.analyzeTemporalPatterns(behaviorData),
        quality_score: this.calculateUserQualityScore(behaviorData),
        personalization_level: this.calculatePersonalizationLevel(behaviorData, preferences),
        last_activity: behaviorData[0]?.timestamp || null,
        behavior_confidence: this.calculateBehaviorConfidence(behaviorData)
      };

      return profile;

    } catch (error) {
      logger.error('❌ Erreur analyse patterns:', error);
      return null;
    }
  }

  /**
   * 📊 Analyser les patterns d'activité
   */
  analyzeActivityPatterns(behaviorData) {
    const patterns = {
      most_active_hours: [],
      most_active_days: [],
      session_duration_avg: 0,
      actions_per_session: 0,
      activity_frequency: 'low'
    };

    if (behaviorData.length === 0) return patterns;

    // Analyser les heures d'activité
    const hourCounts = Array(24).fill(0);
    const dayCounts = Array(7).fill(0);

    behaviorData.forEach(action => {
      const date = new Date(action.timestamp);
      hourCounts[date.getHours()]++;
      dayCounts[date.getDay()]++;
    });

    // Trouver les heures les plus actives
    patterns.most_active_hours = hourCounts
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map(item => item.hour);

    // Trouver les jours les plus actifs
    patterns.most_active_days = dayCounts
      .map((count, day) => ({ day, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map(item => item.day);

    // Calculer la fréquence d'activité
    const uniqueDays = new Set(behaviorData.map(action => 
      new Date(action.timestamp).toDateString()
    )).size;

    if (uniqueDays >= 20) patterns.activity_frequency = 'high';
    else if (uniqueDays >= 10) patterns.activity_frequency = 'medium';
    else patterns.activity_frequency = 'low';

    return patterns;
  }

  /**
   * 💝 Analyser les patterns d'engagement
   */
  analyzeEngagementPatterns(behaviorData) {
    const patterns = {
      preferred_interactions: [],
      engagement_quality: 0,
      social_activity: 0,
      content_consumption: 0
    };

    if (behaviorData.length === 0) return patterns;

    // Compter les types d'interaction
    const interactionCounts = {};
    let totalQuality = 0;

    behaviorData.forEach(action => {
      interactionCounts[action.action_type] = (interactionCounts[action.action_type] || 0) + 1;
      totalQuality += action.interaction_quality || 0;
    });

    // Interactions préférées
    patterns.preferred_interactions = Object.entries(interactionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));

    // Qualité d'engagement moyenne
    patterns.engagement_quality = totalQuality / behaviorData.length;

    // Activité sociale (likes, retweets, follows)
    const socialActions = ['tweet_like', 'tweet_retweet', 'user_follow', 'tweet_reply'];
    const socialCount = behaviorData.filter(action => 
      socialActions.includes(action.action_type)
    ).length;
    patterns.social_activity = socialCount / behaviorData.length;

    // Consommation de contenu (vues, temps passé)
    const consumptionActions = ['tweet_view', 'profile_view', 'time_spent'];
    const consumptionCount = behaviorData.filter(action => 
      consumptionActions.includes(action.action_type)
    ).length;
    patterns.content_consumption = consumptionCount / behaviorData.length;

    return patterns;
  }

  /**
   * 📝 Analyser les préférences de contenu
   */
  analyzeContentPreferences(behaviorData) {
    const preferences = {
      topics: [],
      authors: [],
      content_types: [],
      hashtags: []
    };

    // Analyser les interactions avec le contenu
    const topicMap = new Map();
    const authorMap = new Map();
    const hashtagMap = new Map();

    behaviorData.forEach(action => {
      if (action.context_data) {
        // Extraire les hashtags si présents
        if (action.context_data.hashtags) {
          action.context_data.hashtags.forEach(hashtag => {
            hashtagMap.set(hashtag, (hashtagMap.get(hashtag) || 0) + 1);
          });
        }

        // Compter les auteurs
        if (action.context_data.author_id) {
          authorMap.set(action.context_data.author_id, (authorMap.get(action.context_data.author_id) || 0) + 1);
        }
      }
    });

    // Top hashtags
    preferences.hashtags = Array.from(hashtagMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([hashtag, count]) => ({ hashtag, count }));

    // Top auteurs
    preferences.authors = Array.from(authorMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([author_id, count]) => ({ author_id, count }));

    return preferences;
  }

  /**
   * ⏰ Analyser les patterns temporels
   */
  analyzeTemporalPatterns(behaviorData) {
    const patterns = {
      peak_hours: [],
      session_patterns: [],
      weekly_activity: [],
      response_time: 0
    };

    if (behaviorData.length === 0) return patterns;

    // Analyser la distribution temporelle
    const hourlyActivity = Array(24).fill(0);
    const weeklyActivity = Array(7).fill(0);

    behaviorData.forEach(action => {
      const date = new Date(action.timestamp);
      hourlyActivity[date.getHours()]++;
      weeklyActivity[date.getDay()]++;
    });

    // Heures de pic
    patterns.peak_hours = hourlyActivity
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    // Activité hebdomadaire
    patterns.weekly_activity = weeklyActivity;

    return patterns;
  }

  /**
   * 🏆 Calculer le score de qualité utilisateur
   */
  calculateUserQualityScore(behaviorData) {
    if (behaviorData.length === 0) return 0;

    let totalQuality = 0;
    let actionDiversity = new Set();

    behaviorData.forEach(action => {
      totalQuality += action.interaction_quality || 0;
      actionDiversity.add(action.action_type);
    });

    const avgQuality = totalQuality / behaviorData.length;
    const diversityScore = actionDiversity.size / 10; // Normaliser sur 10 types d'actions

    return Math.min(1, (avgQuality * 0.7) + (diversityScore * 0.3));
  }

  /**
   * 🎯 Calculer le niveau de personnalisation
   */
  calculatePersonalizationLevel(behaviorData, preferences) {
    let score = 0.5; // Score de base

    // Bonus pour les données comportementales
    if (behaviorData.length > 100) score += 0.2;
    else if (behaviorData.length > 50) score += 0.1;

    // Bonus pour les préférences configurées
    if (preferences) {
      if (preferences.algorithm_preferences?.customization_level === 'manual') score += 0.2;
      if (preferences.content_preferences?.preferred_topics?.length > 0) score += 0.1;
    }

    return Math.min(1, score);
  }

  /**
   * 📊 Calculer la confiance comportementale
   */
  calculateBehaviorConfidence(behaviorData) {
    if (behaviorData.length === 0) return 0;

    // Plus de données = plus de confiance
    const dataConfidence = Math.min(1, behaviorData.length / 200);
    
    // Récence des données
    const recentData = behaviorData.filter(action => 
      Date.now() - new Date(action.timestamp).getTime() < 7 * 24 * 60 * 60 * 1000
    );
    const recencyConfidence = recentData.length / behaviorData.length;

    return (dataConfidence * 0.6) + (recencyConfidence * 0.4);
  }

  /**
   * 🔄 Rafraîchissement périodique
   */
  startPeriodicRefresh() {
    // Rafraîchir les stats globales toutes les heures
    setInterval(async () => {
      try {
        await this.loadGlobalBehaviorStats();
        logger.info('🔄 Stats globales rafraîchies');
      } catch (error) {
        logger.error('❌ Erreur rafraîchissement stats:', error);
      }
    }, this.cacheConfig.globalStatsTTL);

    // Analyser les tendances toutes les 30 minutes
    setInterval(async () => {
      try {
        await this.analyzeTrendingBehaviors();
        logger.info('🔄 Tendances comportementales rafraîchies');
      } catch (error) {
        logger.error('❌ Erreur rafraîchissement tendances:', error);
      }
    }, this.cacheConfig.behaviorPatternsTTL);
  }

  /**
   * 🧹 Nettoyage du cache
   */
  cleanupCache(cacheType) {
    const cache = this.cache[cacheType];
    if (!cache instanceof Map) return;

    const now = Date.now();
    const entries = Array.from(cache.entries());
    
    // Supprimer les entrées expirées
    entries.forEach(([key, value]) => {
      if (now - value.timestamp > this.cacheConfig[`${cacheType}TTL`]) {
        cache.delete(key);
      }
    });

    // Si toujours trop grand, supprimer les plus anciennes
    if (cache.size > this.cacheConfig.maxCacheSize) {
      const sortedEntries = entries
        .sort((a, b) => a[1].timestamp - b[1].timestamp)
        .slice(0, cache.size - this.cacheConfig.maxCacheSize);

      sortedEntries.forEach(([key]) => cache.delete(key));
    }
  }

  /**
   * 📊 Méthodes utilitaires pour les stats globales
   */
  async getActiveUsersCount() {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const result = await UserBehaviorData.findOne({
      attributes: [
        [UserBehaviorData.sequelize.fn('COUNT', UserBehaviorData.sequelize.fn('DISTINCT', UserBehaviorData.sequelize.col('user_id'))), 'count']
      ],
      where: this.realBehaviorWhere({ timestamp: { [Op.gte]: oneDayAgo } })
    });

    return parseInt(result?.dataValues?.count || 0);
  }

  async getTopActionTypes() {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const results = await UserBehaviorData.findAll({
      attributes: [
        'action_type',
        [UserBehaviorData.sequelize.fn('COUNT', UserBehaviorData.sequelize.col('id')), 'count']
      ],
      where: this.realBehaviorWhere({ timestamp: { [Op.gte]: oneDayAgo } }),
      group: ['action_type'],
      order: [[UserBehaviorData.sequelize.literal('count'), 'DESC']],
      limit: 10
    });

    return results.map(result => ({
      action_type: result.action_type,
      count: parseInt(result.dataValues.count)
    }));
  }

  async calculateGlobalEngagementRate() {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const result = await UserBehaviorData.findOne({
      attributes: [
        [UserBehaviorData.sequelize.fn('AVG', UserBehaviorData.sequelize.col('interaction_quality')), 'avg_quality']
      ],
      where: this.realBehaviorWhere({
        timestamp: { [Op.gte]: oneDayAgo },
        interaction_quality: { [Op.not]: null }
      })
    });

    return parseFloat(result?.dataValues?.avg_quality || 0);
  }

  async calculateGlobalQualityScore() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    const result = await UserBehaviorData.findOne({
      attributes: [
        [UserBehaviorData.sequelize.fn('AVG', UserBehaviorData.sequelize.col('interaction_quality')), 'avg_quality']
      ],
      where: this.realBehaviorWhere({
        timestamp: { [Op.gte]: sevenDaysAgo },
        interaction_quality: { [Op.gte]: 0.5 }
      })
    });

    return parseFloat(result?.dataValues?.avg_quality || 0.5);
  }

  async calculatePersonalizationScores() {
    try {
      logger.info('🎯 Calcul des scores de personnalisation...');

      // Mettre à jour les scores de personnalisation pour tous les utilisateurs
      const users = await User.findAll({
        include: [{
          model: UserPreferences,
          as: 'userPreferences'
        }],
        where: {
          [Op.or]: [
            { is_data_test: false },
            { is_data_test: null }
          ]
        },
        limit: 5000
      });

      let updated = 0;
      for (const user of users) {
        try {
          const behaviorData = await UserBehaviorData.findAll({
            where: {
              user_id: user.id,
              ...this.realBehaviorWhere({
                timestamp: { [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
              })
            },
            limit: 500
          });

          const score = this.calculatePersonalizationLevel(behaviorData, user.userPreferences);

          if (user.userPreferences) {
            await user.userPreferences.update({ personalization_score: score });
            updated++;
          }
        } catch (error) {
          logger.error(`❌ Erreur calcul score personnalisation utilisateur ${user.id}:`, error);
        }
      }

      logger.info(`Scores de personnalisation calcules pour ${updated}/${users.length} utilisateurs`);

    } catch (error) {
      logger.error('❌ Erreur calcul scores personnalisation:', error);
    }
  }

  /**
   * 📊 Méthodes publiques
   */
  getGlobalStats() {
    return this.cache.globalStats;
  }

  getUserProfile(userId) {
    const cached = this.cache.userProfiles.get(userId);
    return cached ? cached.data : null;
  }

  getTrendingBehaviors() {
    const cached = this.cache.behaviorPatterns.get('trending_actions');
    return cached ? cached.data : [];
  }

  getCacheStats() {
    return {
      userProfiles: this.cache.userProfiles.size,
      behaviorPatterns: this.cache.behaviorPatterns.size,
      globalStats: !!this.cache.globalStats,
      lastUpdate: this.cache.lastUpdate
    };
  }

  realBehaviorWhere(extra = {}) {
    return {
      ...extra,
      [Op.or]: [
        { is_data_test: false },
        { is_data_test: null }
      ]
    };
  }
}

// Instance singleton
const behaviorDataLoader = new BehaviorDataLoader();

module.exports = behaviorDataLoader;
