/**
 * 📊 Service de Collecte de Données Comportementales
 * 
 * Collecte, traite et analyse les données comportementales utilisateur
 * pour améliorer l'algorithme de recommandation
 */

const logger = require('../utils/logger');
const { UserBehaviorData, UserPreferences, User, Tweet, TweetLike, TweetRetweet } = require('../models');
const { Op } = require('sequelize');
const videoRecommendationService = require('./videoRecommendationService');

/**
 * Valeurs acceptees par la colonne `action_type`, LUES SUR LE MODELE.
 *
 * Volontairement derive de la definition Sequelize plutot que recopie ici :
 * deux listes finissent toujours par diverger, et la divergence se paierait en
 * donnees perdues (voir `toKnownActionType`).
 *
 * Ensemble vide = on ne sait pas ce qui est valide : dans ce cas on ne
 * reecrit rien et on laisse passer, pour ne jamais degrader une valeur
 * legitime a cause d'une introspection ratee.
 */
const KNOWN_ACTION_TYPES = new Set(
  UserBehaviorData?.rawAttributes?.action_type?.values || []
);

class BehaviorDataCollector {
  constructor() {
    this.batchSize = 100;
    this.processingQueue = [];
    this.isProcessing = false;
    
    // Configuration de la collecte
    this.config = {
      enableRealTimeProcessing: true,
      batchProcessingInterval: 30000, // 30 secondes
      dataRetentionDays: 365,
      maxEventsPerUser: 10000,
      qualityThreshold: 0.1
    };
    
    // Démarrer le traitement en batch
    this.startBatchProcessing();
  }

  /**
   * Ramene un type d'action inconnu vers `custom_action`, sans perdre le nom
   * d'origine.
   *
   * `trackCustomAction()` cote mobile passe une chaine LIBRE en `action_type`.
   * Toute valeur absente de l'enum PostgreSQL fait echouer l'INSERT entier :
   * l'action n'est pas degradee, elle est PERDUE, et l'erreur ne remonte qu'en
   * log serveur — l'app, elle, ne voit rien. C'est ainsi que 145 ouvertures de
   * tweet depuis la grille Explorer et 20 reponses au controle d'algorithme
   * ont disparu avant qu'on ne s'en apercoive.
   *
   * Une application deja installee ne peut pas etre corrigee a distance : ce
   * garde-fou est donc cote serveur, et il vaut aussi pour toutes les valeurs
   * qu'un client futur inventera. Le nom d'origine part dans le contexte, donc
   * rien n'est perdu pour l'analyse, et il suffira de l'ajouter a l'enum plus
   * tard pour retrouver une colonne propre.
   *
   * @param {string} actionType Ce que le client a envoye.
   * @param {object} context Contexte enrichi, modifie sur place si repli.
   * @returns {string} Une valeur que l'enum accepte.
   */
  toKnownActionType(actionType, context) {
    if (KNOWN_ACTION_TYPES.size === 0) return actionType;
    if (KNOWN_ACTION_TYPES.has(actionType)) return actionType;

    logger.warn(
      `Type d'action inconnu « ${actionType} » ramene a custom_action ` +
      '— a ajouter dans UserBehaviorData.action_type si legitime'
    );
    context.original_action_type = actionType;
    return 'custom_action';
  }

  /**
   * 📝 Enregistrer une action utilisateur
   */
  async recordUserAction(userId, actionType, targetId = null, targetType = null, contextData = {}, deviceInfo = {}, ipAddress = null) {
    try {
      // Validation des données
      if (!userId || !actionType) {
        throw new Error('userId et actionType sont requis');
      }

      // Calculer la qualité de l'interaction
      const interactionQuality = this.calculateInteractionQuality(actionType, contextData);

      // Extraction du timestamp client si présent
      const client_timestamp = contextData.client_timestamp ? new Date(contextData.client_timestamp) : null;
      
      // Enrichir le contexte avec les composants temporels demandés par l'utilisateur
      const timeComponents = this.extractTimeComponents(client_timestamp || new Date());
      const enrichedContext = {
        ...contextData,
        ...timeComponents
      };

      // Créer l'enregistrement
      const behaviorData = await UserBehaviorData.create({
        user_id: userId,
        action_type: this.toKnownActionType(actionType, enrichedContext),
        target_id: targetId ? targetId.toString() : null,
        target_type: targetType,
        context_data: enrichedContext,
        duration_ms: contextData.duration || contextData.duration_ms || null,
        device_info: deviceInfo,
        ip_address: ipAddress,
        interaction_quality: interactionQuality,
        timestamp: new Date(),
        client_timestamp: client_timestamp
      });

      logger.info(`📊 Action enregistrée [V5]: ${actionType} par ${userId} (client_ts: ${client_timestamp ? 'OUI' : 'NON'})`);

      // Traitement en temps réel si activé
      if (this.config.enableRealTimeProcessing) {
        this.addToProcessingQueue(behaviorData);
      }

      return behaviorData;

    } catch (error) {
      logger.error('❌ Erreur enregistrement action:', error);
      throw error;
    }
  }

  /**
   * 📊 Enregistrer une session utilisateur (V6)
   */
  async recordUserSession(userId, sessionData, ipAddress = null) {
    try {
      const sessionActions = [
        {
          actionType: 'session_start',
          contextData: {
            app_version: sessionData.appVersion,
            device_type: sessionData.deviceType,
            network_type: sessionData.networkType,
            screen_size: sessionData.screenSize
          }
        }
      ];

      // Enregistrer chaque action de la session
      for (const action of sessionActions) {
        await this.recordUserAction(
          userId,
          action.actionType,
          null,
          'app',
          action.contextData,
          sessionData.deviceInfo,
          ipAddress
        );
      }

      logger.info(`📱 Session enregistrée pour utilisateur ${userId}`);

    } catch (error) {
      logger.error('❌ Erreur enregistrement session:', error);
      throw error;
    }
  }

  /**
   * 🎯 Enregistrer une interaction avec un tweet
   */
  async recordTweetInteraction(userId, tweetId, interactionType, contextData = {}, ipAddress = null) {
    try {
      // Enrichir les données contextuelles avec des infos sur le tweet
      const enrichedContext = await this.enrichTweetContext(tweetId, contextData);

      await this.recordUserAction(
        userId,
        interactionType,
        tweetId,
        'tweet',
        enrichedContext,
        {},
        ipAddress
      );

      // Mise à jour des préférences utilisateur si c'est une interaction significative
      if (['tweet_like', 'tweet_retweet', 'tweet_reply', 'tweet_bookmark'].includes(interactionType)) {
        await this.updateUserPreferences(userId, tweetId, interactionType);
      }
      
      // Update video reco engine if applicable
      if (interactionType === 'tweet_view' || interactionType === 'media_view' || interactionType === 'tweet_like' || interactionType === 'tweet_retweet' || interactionType === 'tweet_reply') {
        videoRecommendationService.onInteraction(userId, tweetId, interactionType);
      }

      logger.info(`🐦 Interaction tweet: ${interactionType} sur tweet ${tweetId} par ${userId}`);

    } catch (error) {
      logger.error('❌ Erreur enregistrement interaction tweet:', error);
      throw error;
    }
  }

  /**
   * 🔍 Enregistrer une recherche utilisateur
   */
  async recordSearchQuery(userId, searchQuery, resultsCount, contextData = {}, ipAddress = null) {
    try {
      await this.recordUserAction(
        userId,
        'search_query',
        searchQuery,
        'search',
        {
          ...contextData,
          query: searchQuery,
          results_count: resultsCount,
          search_timestamp: new Date()
        },
        {},
        ipAddress
      );

      logger.info(`🔍 Recherche enregistrée: "${searchQuery}" par ${userId}`);

    } catch (error) {
      logger.error('❌ Erreur enregistrement recherche:', error);
      throw error;
    }
  }

  /**
   * ⏱️ Enregistrer le temps passé sur du contenu
   */
  async recordContentEngagement(userId, contentId, contentType, timeSpent, engagementData = {}, ipAddress = null) {
    try {
      await this.recordUserAction(
        userId,
        'time_spent',
        contentId,
        contentType,
        {
          ...engagementData,
          time_spent_ms: timeSpent,
          engagement_rate: this.calculateEngagementRate(timeSpent, engagementData),
          scroll_depth: engagementData.scrollDepth || 0,
          interactions_count: engagementData.interactionsCount || 0
        },
        {},
        ipAddress
      );

      // Update video reco engine with precise watch time
      if (contentType === 'tweet' || contentType === 'video') {
         videoRecommendationService.onWatchTime(userId, contentId, timeSpent);
      }

      logger.info(`⏱️ Engagement contenu: ${timeSpent}ms sur ${contentType} ${contentId} par ${userId}`);

    } catch (error) {
      logger.error('❌ Erreur enregistrement engagement:', error);
      throw error;
    }
  }

  /**
   * 🔄 Traitement en batch des données
   */
  startBatchProcessing() {
    setInterval(async () => {
      if (this.processingQueue.length > 0 && !this.isProcessing) {
        await this.processBatch();
      }
    }, this.config.batchProcessingInterval);
  }

  async processBatch() {
    if (this.isProcessing) return;

    this.isProcessing = true;
    try {
      const batch = this.processingQueue.splice(0, this.batchSize);
      logger.info(`🔄 Traitement batch: ${batch.length} éléments`);

      for (const behaviorData of batch) {
        await this.processUserBehavior(behaviorData);
      }

      logger.info(`✅ Batch traité: ${batch.length} éléments`);

    } catch (error) {
      logger.error('❌ Erreur traitement batch:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  addToProcessingQueue(behaviorData) {
    this.processingQueue.push(behaviorData);
    
    // Traitement immédiat si la queue devient trop grande
    if (this.processingQueue.length >= this.batchSize) {
      setImmediate(() => this.processBatch());
    }
  }

  /**
   * 🧠 Traiter le comportement utilisateur pour l'algorithme
   */
  async processUserBehavior(behaviorData) {
    try {
      // Marquer comme traité
      await behaviorData.update({
        processed: true,
        processing_date: new Date()
      });

      // Analyser les patterns comportementaux
      await this.analyzeUserPatterns(behaviorData.user_id);

      // Mettre à jour le profil utilisateur
      await this.updateUserProfile(behaviorData.user_id, behaviorData);

      logger.debug(`🧠 Comportement traité pour utilisateur ${behaviorData.user_id}`);

    } catch (error) {
      logger.error('❌ Erreur traitement comportement:', error);
    }
  }

  /**
   * 📈 Analyser les patterns comportementaux
   */
  async analyzeUserPatterns(userId) {
    try {
      const recentBehavior = await UserBehaviorData.findAll({
        where: {
          user_id: userId,
          timestamp: {
            [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 jours
          }
        },
        order: [['timestamp', 'DESC']],
        limit: 1000
      });

      // Analyser les patterns
      const patterns = {
        activity_hours: this.analyzeActivityHours(recentBehavior),
        content_preferences: this.analyzeContentPreferences(recentBehavior),
        engagement_patterns: this.analyzeEngagementPatterns(recentBehavior),
        social_behavior: this.analyzeSocialBehavior(recentBehavior)
      };

      // Mettre à jour les préférences avec les patterns détectés
      await this.updateUserPatternsInPreferences(userId, patterns);

      logger.info(`📈 Patterns analysés pour utilisateur ${userId}`);
      return patterns;

    } catch (error) {
      logger.error('❌ Erreur analyse patterns:', error);
      return {};
    }
  }

  /**
   * 🎯 Calculer la qualité de l'interaction
   */
  calculateInteractionQuality(actionType, contextData) {
    let baseScore = 0.5;

    // Scores par type d'action
    const actionScores = {
      'tweet_like': 0.6,
      'tweet_retweet': 0.8,
      'tweet_reply': 0.9,
      'tweet_bookmark': 0.7,
      'tweet_share': 0.8,
      'profile_view': 0.4,
      'search_query': 0.5,
      'time_spent': 0.6,
      'user_follow': 0.7
    };

    baseScore = actionScores[actionType] || baseScore;

    // Ajustements basés sur le contexte
    if (contextData.duration && contextData.duration > 5000) {
      baseScore += 0.1; // Bonus pour interaction longue
    }

    if (contextData.scroll_depth && contextData.scroll_depth > 0.8) {
      baseScore += 0.1; // Bonus pour scroll profond
    }

    return Math.min(1.0, Math.max(0.0, baseScore));
  }

  /**
   * 🔍 Enrichir le contexte d'un tweet
   */
  async enrichTweetContext(tweetId, contextData) {
    try {
      const tweet = await Tweet.findByPk(tweetId, {
        include: [{ model: User, as: 'author' }]
      });

      if (!tweet) return contextData;

      return {
        ...contextData,
        tweet_age_hours: (Date.now() - new Date(tweet.created_at)) / (60 * 60 * 1000),
        author_id: tweet.author_id,
        author_followers: tweet.author?.followers_count || 0,
        tweet_engagement: {
          likes: tweet.like_count || 0,
          retweets: tweet.retweet_count || 0,
          replies: tweet.reply_count || 0
        },
        content_length: tweet.content ? tweet.content.length : 0,
        has_media: !!(tweet.image_url || tweet.video_url),
        hashtags: this.extractHashtags(tweet.content || '')
      };

    } catch (error) {
      logger.error('❌ Erreur enrichissement contexte tweet:', error);
      return contextData;
    }
  }

  /**
   * 📊 Obtenir les statistiques comportementales d'un utilisateur
   */
  async getUserBehaviorStats(userId, days = 30) {
    try {
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const behaviors = await UserBehaviorData.findAll({
        where: {
          user_id: userId,
          timestamp: { [Op.gte]: startDate }
        }
      });

      const stats = {
        total_actions: behaviors.length,
        actions_by_type: {},
        avg_interaction_quality: 0,
        most_active_hour: null,
        engagement_score: 0,
        content_preferences: {},
        last_activity: null
      };

      // Calculer les statistiques
      let totalQuality = 0;
      const hourCounts = Array(24).fill(0);

      behaviors.forEach(behavior => {
        // Compter par type
        stats.actions_by_type[behavior.action_type] = 
          (stats.actions_by_type[behavior.action_type] || 0) + 1;

        // Qualité moyenne
        if (behavior.interaction_quality) {
          totalQuality += behavior.interaction_quality;
        }

        // Heure la plus active
        const hour = new Date(behavior.timestamp).getHours();
        hourCounts[hour]++;

        // Dernière activité
        if (!stats.last_activity || behavior.timestamp > stats.last_activity) {
          stats.last_activity = behavior.timestamp;
        }
      });

      stats.avg_interaction_quality = behaviors.length > 0 ? totalQuality / behaviors.length : 0;
      stats.most_active_hour = hourCounts.indexOf(Math.max(...hourCounts));
      stats.engagement_score = this.calculateEngagementScore(behaviors);

      return stats;

    } catch (error) {
      logger.error('❌ Erreur récupération stats comportementales:', error);
      return null;
    }
  }

  // Méthodes utilitaires
  extractTimeComponents(date) {
    const d = new Date(date);
    return {
      h: d.getHours(),
      m: d.getMinutes(),
      s: d.getSeconds(),
      ms: d.getMilliseconds()
    };
  }

  extractHashtags(content) {
    const hashtags = content.match(/#[a-zA-Z0-9_\u00C0-\u017F]+/g);
    return hashtags ? hashtags.map(tag => tag.toLowerCase()) : [];
  }

  calculateEngagementRate(timeSpent, engagementData) {
    // Algorithme simple pour calculer le taux d'engagement
    const baseRate = Math.min(timeSpent / 30000, 1); // 30 secondes = 100%
    const interactionBonus = (engagementData.interactionsCount || 0) * 0.1;
    return Math.min(1, baseRate + interactionBonus);
  }

  calculateEngagementScore(behaviors) {
    // Score d'engagement basé sur la diversité et la qualité des actions
    const engagementActions = ['tweet_like', 'tweet_retweet', 'tweet_reply', 'tweet_bookmark'];
    const engagementBehaviors = behaviors.filter(b => engagementActions.includes(b.action_type));
    
    if (engagementBehaviors.length === 0) return 0;
    
    const avgQuality = engagementBehaviors.reduce((sum, b) => sum + (b.interaction_quality || 0), 0) / engagementBehaviors.length;
    const diversity = new Set(engagementBehaviors.map(b => b.action_type)).size / engagementActions.length;
    
    return (avgQuality * 0.7) + (diversity * 0.3);
  }

  // Méthodes d'analyse des patterns (simplifiées pour l'exemple)
  analyzeActivityHours(behaviors) {
    const hourCounts = Array(24).fill(0);
    behaviors.forEach(b => {
      const hour = new Date(b.timestamp).getHours();
      hourCounts[hour]++;
    });
    return hourCounts;
  }

  analyzeContentPreferences(behaviors) {
    // Analyser les préférences de contenu basées sur les interactions
    return {};
  }

  analyzeEngagementPatterns(behaviors) {
    // Analyser les patterns d'engagement
    return {};
  }

  analyzeSocialBehavior(behaviors) {
    // Analyser le comportement social
    return {};
  }

  async updateUserPreferences(userId, tweetId, interactionType) {
    // Mettre à jour les préférences basées sur l'interaction
    // Implémentation simplifiée
  }

  async updateUserProfile(userId, behaviorData) {
    // Mettre à jour le profil utilisateur
    // Implémentation simplifiée
  }

  async updateUserPatternsInPreferences(userId, patterns) {
    // Mettre à jour les patterns dans les préférences
    // Implémentation simplifiée
  }
}

module.exports = BehaviorDataCollector;
