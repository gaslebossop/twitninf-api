/**
 * 🚀 Moteur de Recommandation Progressive - TwitNin Legacy
 * 
 * Algorithme de recommandation basé sur la viralité progressive des tweets
 * avec expansion des groupes selon les interactions utilisateur.
 * 
 * Principe : Un tweet commence par être recommandé à un petit groupe,
 * puis s'étend progressivement selon les interactions (likes, commentaires, retweets, etc.)
 * 
 * @author TwitNin Team
 * @version 1.0.0 - Progressive Viral
 * @license MIT
 */

const { Op, fn, col, literal, Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const { User, Tweet, TweetLike, TweetRetweet, UserFollow, UserBehaviorData, Notification, sequelize } = require('../models');
const { engagementTargetId } = require('../utils/engagementTarget');

/**
 * Classe pour le tracking en temps réel des tweets
 */
class TweetTracker {
  constructor() {
    this.trackingData = new Map(); // tweetId -> tracking data
    this.groupStats = {
      initial: { total: 0, active: 0, completed: 0, excluded: 0 },
      expansion: { total: 0, active: 0, completed: 0, excluded: 0 },
      viral: { total: 0, active: 0, completed: 0, excluded: 0 },
      massive: { total: 0, active: 0, completed: 0, excluded: 0 }
    };
  }

  /**
   * Met à jour le tracking d'un tweet
   */
  updateTweetTracking(tweetId, tweetData) {
    const tracking = this.trackingData.get(tweetId) || {
      id: tweetId,
      group: tweetData.recommendation_group,
      views: tweetData.view_count || 0,
      likes: 0, // Simulé pour l'instant
      comments: 0, // Simulé pour l'instant
      retweets: 0, // Simulé pour l'instant
      shares: 0, // Simulé pour l'instant
      reports: 0, // Simulé pour l'instant
      createdAt: tweetData.createdAt || tweetData.created_at,
      lastUpdated: new Date(),
      groupSize: this.getGroupSize(tweetData.recommendation_group),
      interactions: 0,
      interactionRatio: 0
    };

    // Mettre à jour les données
    tracking.views = tweetData.view_count || 0;
    tracking.lastUpdated = new Date();
    tracking.group = tweetData.recommendation_group;
    tracking.groupSize = this.getGroupSize(tweetData.recommendation_group);

    // Simuler les interactions basées sur les vues (2% des vues)
    const estimatedInteractions = Math.floor(tracking.views * 0.02);
    tracking.likes = Math.floor(estimatedInteractions * 0.6);
    tracking.comments = Math.floor(estimatedInteractions * 0.25);
    tracking.retweets = Math.floor(estimatedInteractions * 0.1);
    tracking.shares = Math.floor(estimatedInteractions * 0.05);

    // Calculer les interactions totales
    tracking.interactions = tracking.likes + tracking.comments + tracking.retweets + tracking.shares;
    
    // Calculer le ratio d'interaction
    tracking.interactionRatio = tracking.views > 0 ? (tracking.interactions / tracking.views) * 100 : 0;

    this.trackingData.set(tweetId, tracking);
    return tracking;
  }

  /**
   * Obtient la taille du groupe
   */
  getGroupSize(group) {
    const sizes = {
      initial: 4,
      expansion: 10,
      viral: 26,
      massive: 40
    };
    return sizes[group] || 0;
  }

  /**
   * Affiche une progress bar pour un tweet
   */
  displayProgressBar(tracking) {
    const progress = Math.min((tracking.views / tracking.groupSize) * 100, 100);
    const filled = Math.floor(progress / 5);
    const empty = 20 - filled;
    
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const percentage = progress.toFixed(1);
    
    return `[${bar}] ${percentage}% (${tracking.views}/${tracking.groupSize})`;
  }

  /**
   * Log le statut d'un tweet avec progress bar
   */
  logTweetStatus(tweetId, action = 'update') {
    const tracking = this.trackingData.get(tweetId);
    if (!tracking) return;

    const progressBar = this.displayProgressBar(tracking);
    const age = Math.floor((new Date() - new Date(tracking.createdAt)) / (1000 * 60 * 60 * 24));
    
    logger.info(`📊 Tweet ${tweetId} [${action.toUpperCase()}]`);
    logger.info(`   🎯 Groupe: ${tracking.group.toUpperCase()} | Taille: ${tracking.groupSize}`);
    logger.info(`   📈 Progression: ${progressBar}`);
    logger.info(`   👀 Vues: ${tracking.views} | ❤️ Likes: ${tracking.likes} | 💬 Comments: ${tracking.comments}`);
    logger.info(`   🔄 Retweets: ${tracking.retweets} | 📤 Shares: ${tracking.shares} | ⚠️ Reports: ${tracking.reports}`);
    logger.info(`   📊 Interactions: ${tracking.interactions} | Ratio: ${tracking.interactionRatio.toFixed(2)}% | Âge: ${age}j`);
  }

  /**
   * Log une transition de groupe
   */
  logGroupTransition(tweetId, fromGroup, toGroup, reason) {
    const tracking = this.trackingData.get(tweetId);
    if (!tracking) return;

    const emoji = toGroup === 'excluded' ? '❌' : '⬆️';
    const action = toGroup === 'excluded' ? 'EXCLU' : 'PROMU';
    
    logger.info(`${emoji} Tweet ${tweetId} ${action} de ${fromGroup.toUpperCase()} vers ${toGroup.toUpperCase()}`);
    logger.info(`   📝 Raison: ${reason}`);
    logger.info(`   📊 Stats finales: ${tracking.views} vues, ${tracking.interactions} interactions (${tracking.interactionRatio.toFixed(2)}%)`);
    
    // Mettre à jour les statistiques de groupe
    this.updateGroupStats(fromGroup, toGroup);
  }

  /**
   * Met à jour les statistiques de groupe
   */
  updateGroupStats(fromGroup, toGroup) {
    if (this.groupStats[fromGroup]) {
      this.groupStats[fromGroup].active--;
      if (toGroup === 'excluded') {
        this.groupStats[fromGroup].excluded++;
      } else {
        this.groupStats[fromGroup].completed++;
      }
    }
    
    if (toGroup !== 'excluded' && this.groupStats[toGroup]) {
      this.groupStats[toGroup].active++;
    }
  }

  /**
   * Affiche un résumé des statistiques de groupe
   */
  displayGroupSummary() {
    logger.info('📊 RÉSUMÉ DES GROUPES:');
    Object.entries(this.groupStats).forEach(([group, stats]) => {
      if (stats.total > 0) {
        const activeRate = ((stats.active / stats.total) * 100).toFixed(1);
        const completionRate = ((stats.completed / stats.total) * 100).toFixed(1);
        const exclusionRate = ((stats.excluded / stats.total) * 100).toFixed(1);
        
        logger.info(`   ${group.toUpperCase()}: ${stats.active} actifs | ${stats.completed} complétés | ${stats.excluded} exclus`);
        logger.info(`   📈 Taux: ${activeRate}% actif | ${completionRate}% complété | ${exclusionRate}% exclu`);
      }
    });
  }

  /**
   * Affiche les tweets les plus performants
   */
  displayTopPerformers(limit = 5) {
    const tweets = Array.from(this.trackingData.values())
      .filter(t => t.views > 0)
      .sort((a, b) => b.interactionRatio - a.interactionRatio)
      .slice(0, limit);

    if (tweets.length > 0) {
      logger.info('🏆 TOP PERFORMERS (par ratio d\'interaction):');
      tweets.forEach((tweet, index) => {
        const progressBar = this.displayProgressBar(tweet);
        logger.info(`   ${index + 1}. Tweet ${tweet.id} [${tweet.group.toUpperCase()}]`);
        logger.info(`      ${progressBar} | Ratio: ${tweet.interactionRatio.toFixed(2)}%`);
      });
    }
  }
}

class ProgressiveRecommendationEngine {
  constructor() {
    this.cache = new Map();
    this.cacheExpiry = 2 * 60 * 1000; // 2 minutes pour la réactivité
    this.tracker = new TweetTracker(); // Système de tracking en temps réel
    this.isLoading = false;
    this.isLoaded = false;
    
    // Charger les données depuis la DB au démarrage (asynchrone)
    this.initializeCache();
    
    // Configuration des groupes de recommandation progressive (adaptée pour 40 utilisateurs)
    this.recommendationGroups = {
      // Groupe initial - très petit groupe de test (10% des utilisateurs)
      // TOUS les utilisateurs peuvent être candidats, peu importe leur nombre d'abonnés
      initial: {
        size: 4, // 10% de 40 utilisateurs
        criteria: 'all_users', // Tous les utilisateurs peuvent être candidats
        weight: 1.0,
        maxSize: 4
      },
      // Groupe d'expansion - utilisateurs actifs (25% des utilisateurs)
      expansion: {
        size: 10, // 25% de 40 utilisateurs
        criteria: 'all_users', // Tous les utilisateurs peuvent être candidats
        weight: 1.5,
        maxSize: 10
      },
      // Groupe viral - utilisateurs influents (65% des utilisateurs)
      viral: {
        size: 26, // 65% de 40 utilisateurs
        criteria: 'all_users', // Tous les utilisateurs peuvent être candidats
        weight: 2.0,
        maxSize: 26
      },
      // Groupe massif - pour les tweets très performants (illimité)
      massive: {
        size: 40, // Tous les utilisateurs disponibles
        criteria: 'all_users', // Tous les utilisateurs
        weight: 3.0,
        maxSize: 40,
        isUnlimited: true // Peut dépasser la taille normale
      }
    };
    
    // Scores d'interaction avec pondération
    this.interactionScores = {
      // Interactions positives (augmentent la viralité)
      like: 1.0,
      comment: 3.0,
      retweet: 5.0,
      share: 4.0,
      profile_view: 2.0,
      click: 0.5,
      bookmark: 2.5,
      
      // Interactions négatives (diminuent la viralité)
      unlike: -1.0,
      unretweet: -2.0,
      report: -10.0,
      block: -15.0,
      mute: -5.0,
      
      // Interactions temporelles
      view_duration: 0.1, // par seconde de visualisation
      scroll_pause: 0.3,
      fullscreen: 1.0
    };
    
    // Seuils de progression entre les groupes (basés sur le ratio d'engagement)
    this.progressionThresholds = {
      // Ratios d'engagement minimum pour passer au groupe suivant
      initial_to_expansion: 0.25,  // 25% d'engagement (1 interaction sur 4 vues)
      expansion_to_viral: 0.30,    // 30% d'engagement (3 interactions sur 10 vues)
      viral_to_massive: 0.40,      // 40% d'engagement (10 interactions sur 25 vues)
      
      // Ratios d'engagement minimum pour maintenir la recommandation
      maintain_initial: 0.20,      // 20% d'engagement minimum
      maintain_expansion: 0.25,    // 25% d'engagement minimum
      maintain_viral: 0.30,        // 30% d'engagement minimum
      maintain_massive: 0.25,      // 25% d'engagement minimum pour rester massif
      
      // Ratio d'interactions négatives maximum avant arrêt
      max_negative_ratio: 0.20,    // 20% d'interactions négatives maximum
      
      // Vérification du groupe massif toutes les X vues
      massive_check_interval: 10   // Vérifier toutes les 10 vues pour le groupe massif
    };
    
    // Facteurs de décroissance temporelle dynamiques
    this.timeDecay = {
      // Décroissance de base
      base: {
        initial: 0.95,      // 5% de perte par heure
        expansion: 0.90,    // 10% de perte par heure
        viral: 0.85,        // 15% de perte par heure
        massive: 0.80       // 20% de perte par heure
      },
      
      // Multiplicateurs de durée de vie basés sur la performance
      performanceMultipliers: {
        excellent: 2.0,     // 2x plus long si excellent
        good: 1.5,          // 1.5x plus long si bon
        average: 1.0,       // Durée normale
        poor: 0.7,          // 30% plus court si mauvais
        terrible: 0.5       // 50% plus court si terrible
      },
      
      // Facteurs de prolongation
      extensionFactors: {
        verified_author: 1.3,        // 30% plus long si auteur vérifié
        premium_author: 1.2,         // 20% plus long si auteur premium
        high_engagement: 1.5,        // 50% plus long si engagement élevé
        trending_topic: 1.4,         // 40% plus long si sujet tendance
        viral_content: 2.0,          // 2x plus long si contenu viral
        community_favorite: 1.6,     // 60% plus long si favori communautaire
        educational_content: 1.3,    // 30% plus long si contenu éducatif
        news_content: 1.4,           // 40% plus long si contenu d'actualité
        original_content: 1.2,       // 20% plus long si contenu original
        cross_platform_share: 1.3    // 30% plus long si partagé cross-platform
      },
      
      // Durée de vie maximale par groupe
      maxLifespan: {
        initial: 24,        // 24 heures maximum
        expansion: 48,      // 48 heures maximum
        viral: 72,          // 72 heures maximum
        massive: 168        // 1 semaine maximum
      }
    };
  }

  /**
   * Initialise le cache de manière asynchrone
   */
  async initializeCache() {
    if (this.isLoading || this.isLoaded) return;
    
    this.isLoading = true;
    try {
      await this.loadCachedData();
      this.isLoaded = true;
      logger.info('✅ Cache initialisé avec succès');
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation du cache:', error);
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Charge les données mises en cache depuis la base de données
   */
  async loadCachedData() {
    try {
      logger.info('🔄 Chargement des données mises en cache depuis la DB...');
      
      // Charger les tweets récents approuvés
      const recentTweets = await Tweet.findAll({
        where: {
          deleted_at: null,
          is_data_test: false,
          moderation_status: 'approved',
          parent_tweet_id: null,
          created_at: {
            [Op.gte]: new Date('2025-09-07T00:00:00.000Z')
          }
        },
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'stats', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: 500 // Charger les 500 derniers tweets
      });

      // Pré-calculer les scores pour chaque tweet et les taguer
      for (const tweet of recentTweets) {
        const tweetGroup = await this.determineTweetRecommendationGroup(tweet.id);
        
        // Tagger le tweet avec son groupe de recommandation
        await this.updateTweetRecommendationGroup(tweet.id, tweetGroup.group);
        
        if (tweetGroup.group !== 'excluded') {
          const cacheKey = `tweet_${tweet.id}`;
          this.cache.set(cacheKey, {
            data: {
              tweet: tweet.toJSON ? tweet.toJSON() : tweet,
              group: tweetGroup.group,
              maxCandidates: tweetGroup.maxCandidates,
              reason: tweetGroup.reason
            },
            timestamp: Date.now()
          });
        }
      }

      logger.info(`✅ ${recentTweets.length} tweets chargés depuis la DB dans le cache`);
      logger.info(`📊 Cache initialisé avec ${this.cache.size} éléments`);
    } catch (error) {
      logger.error('❌ Erreur lors du chargement des données mises en cache:', error);
    }
  }

  /**
   * Sauvegarde les données dans la base de données
   */
  async saveCachedData() {
    try {
      logger.info('💾 Sauvegarde des données mises en cache...');
      
      // Ici on pourrait sauvegarder dans une table dédiée
      // Pour l'instant, on garde juste en mémoire
      logger.info(`✅ ${this.cache.size} éléments mis en cache`);
    } catch (error) {
      logger.error('❌ Erreur lors de la sauvegarde des données:', error);
    }
  }

  /**
   * Ajoute un nouveau tweet approuvé au cache
   */
  async addNewTweet(tweetId) {
    try {
      logger.info(`➕ Ajout du nouveau tweet ${tweetId} au cache...`);
      
      const tweet = await Tweet.findByPk(tweetId, {
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'stats', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
          }
        ]
      });

      if (!tweet) {
        logger.warn(`⚠️ Tweet ${tweetId} non trouvé`);
        return;
      }

      // Déterminer le groupe de recommandation
      const tweetGroup = await this.determineTweetRecommendationGroup(tweet.id);
      
      // Mettre à jour le tweet avec le groupe de recommandation
      await this.updateTweetRecommendationGroup(tweetId, tweetGroup.group);
      
      if (tweetGroup.group !== 'excluded') {
        const cacheKey = `tweet_${tweet.id}`;
        this.cache.set(cacheKey, {
          data: {
            tweet: tweet.toJSON ? tweet.toJSON() : tweet,
            group: tweetGroup.group,
            maxCandidates: tweetGroup.maxCandidates,
            reason: tweetGroup.reason
          },
          timestamp: Date.now()
        });
        
        logger.info(`✅ Tweet ${tweetId} ajouté au cache (groupe: ${tweetGroup.group})`);
      } else {
        logger.info(`⏭️ Tweet ${tweetId} exclu: ${tweetGroup.reason}`);
      }
    } catch (error) {
      logger.error(`❌ Erreur lors de l'ajout du tweet ${tweetId}:`, error);
    }
  }

  /**
   * Met à jour le groupe de recommandation d'un tweet dans la base de données
   */
  async updateTweetRecommendationGroup(tweetId, group) {
    try {
      // Mettre à jour le champ recommendation_group dans la base de données
      await Tweet.update(
        { 
          recommendation_group: group,
          recommendation_updated_at: new Date()
        },
        { where: { id: tweetId } }
      );
      
      logger.info(`🏷️ Tweet ${tweetId} tagué avec le groupe: ${group}`);
    } catch (error) {
      logger.error(`❌ Erreur lors de la mise à jour du groupe du tweet ${tweetId}:`, error);
    }
  }

  /**
   * Met à jour un tweet existant dans le cache
   */
  async updateTweet(tweetId) {
    try {
      logger.info(`🔄 Mise à jour du tweet ${tweetId} dans le cache...`);
      
      const tweet = await Tweet.findByPk(tweetId, {
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'stats', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
          }
        ]
      });

      if (!tweet) {
        // Supprimer du cache si le tweet n'existe plus
        const cacheKey = `tweet_${tweetId}`;
        this.cache.delete(cacheKey);
        logger.info(`🗑️ Tweet ${tweetId} supprimé du cache`);
        return;
      }

      const tweetGroup = await this.determineTweetRecommendationGroup(tweet.id);
      
      // Mettre à jour le groupe de recommandation dans la DB
      await this.updateTweetRecommendationGroup(tweetId, tweetGroup.group);
      
      const cacheKey = `tweet_${tweetId}`;
      
      if (tweetGroup.group !== 'excluded') {
        this.cache.set(cacheKey, {
          data: {
            tweet: tweet.toJSON ? tweet.toJSON() : tweet,
            group: tweetGroup.group,
            maxCandidates: tweetGroup.maxCandidates,
            reason: tweetGroup.reason
          },
          timestamp: Date.now()
        });
        logger.info(`✅ Tweet ${tweetId} mis à jour dans le cache (groupe: ${tweetGroup.group})`);
      } else {
        this.cache.delete(cacheKey);
        logger.info(`🗑️ Tweet ${tweetId} supprimé du cache: ${tweetGroup.reason}`);
      }
    } catch (error) {
      logger.error(`❌ Erreur lors de la mise à jour du tweet ${tweetId}:`, error);
    }
  }

  /**
   * Récupère les tweets depuis le cache ou la DB avec les groupes tagués
   */
  async getCachedTweets(userId, options = {}) {
    const { limit = 100, offset = 0, group = 'all' } = options;
    
    try {
      // S'assurer que le cache est chargé - FORCER le chargement si nécessaire
      if (!this.isLoaded && !this.isLoading) {
        logger.info('🔄 Cache non chargé, initialisation forcée...');
        await this.initializeCache();
      }
      
      // Si le cache est en cours de chargement, attendre qu'il se termine
      if (this.isLoading) {
        logger.info('⏳ Cache en cours de chargement, attente...');
        let attempts = 0;
        while (this.isLoading && attempts < 20) { // Augmenter à 20 tentatives (2 secondes)
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
        }
      }
      
      // Si le cache est vide, utiliser la DB avec les groupes tagués
      if (this.cache.size === 0) {
        logger.warn('⚠️ Cache vide, utilisation de la DB avec groupes tagués');
        logger.info(`🔍 État du cache: isLoaded=${this.isLoaded}, isLoading=${this.isLoading}, size=${this.cache.size}`);
        return await this.getTweetsByGroup(userId, options);
      }
      
      logger.info(`📊 Cache utilisé: ${this.cache.size} éléments disponibles`);
      
      // Récupérer les tweets du cache selon le groupe
      let cachedTweets = Array.from(this.cache.values())
        .filter(cacheItem => {
          const age = Date.now() - cacheItem.timestamp;
          return age < this.cacheExpiry; // Vérifier que le cache n'est pas expiré
        })
        .map(cacheItem => {
          const tweet = cacheItem.data.tweet;
          // S'assurer que le tweet a les bonnes propriétés
          const processedTweet = {
            ...tweet,
            createdAt: tweet.createdAt || tweet.created_at,
            updatedAt: tweet.updatedAt || tweet.updated_at,
            recommendation_group: cacheItem.data.group
          };
          
          // Structure des tweets vérifiée
          
          return processedTweet;
        });
      
      // Filtrer par groupe si spécifié
      if (group !== 'all') {
        cachedTweets = cachedTweets.filter(tweet => tweet.recommendation_group === group);
      }
      
      // GARANTIE DE TEST : Tous les tweets après le 12 septembre 2025 doivent être testés
      const now = new Date();
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      
      // Timestamp de référence : tweets à tester (après le 12 septembre 2025)
      const testingStartDate = new Date('2025-09-12T00:00:00Z');
      
      const initialTestingTweets = cachedTweets.filter(tweet => {
        if (tweet.recommendation_group !== 'initial') return false;
        
        const tweetDate = new Date(tweet.createdAt || tweet.created_at);
        const isAfterTestingStart = tweetDate >= testingStartDate; // Tweet créé après le 12 sept 2025
        const isRecent = tweetDate >= oneWeekAgo; // Tweet de moins d'une semaine
        const hasViews = (tweet.view_count || 0) > 0; // Tweet avec des vues
        const isZeroViews = (tweet.view_count || 0) === 0; // Tweet à 0 vues
        const viewCount = tweet.view_count || 0;
        
        // GARANTIE DE TEST : Tous les tweets après le 12 sept 2025 doivent être testés
        if (isAfterTestingStart) {
          return true; // TOUS les tweets après cette date sont garantis d'être testés
        }
        
        // TWEETS EXISTANTS (avant 12 sept 2025) : seulement ceux avec 4+ vues
        return viewCount >= 4;
      });
      
      logger.info(`🧪 Tweets GARANTIS d'être testés trouvés: ${initialTestingTweets.length} (après ${testingStartDate.toISOString()})`);
      
      const otherTweets = cachedTweets.filter(tweet => 
        !(tweet.recommendation_group === 'initial' && 
          ((tweet.view_count || 0) === 0 || (tweet.view_count || 0) < 2) &&
          new Date(tweet.createdAt || tweet.created_at) >= oneWeekAgo)
      );
      
      // Trier les tweets à tester par date décroissante (plus récents en premier)
      initialTestingTweets.sort((a, b) => {
        const dateA = new Date(a.createdAt || a.created_at);
        const dateB = new Date(b.createdAt || b.created_at);
        return dateB - dateA; // Plus récents en premier
      });
      
      // GARANTIE DE TEST : Maximum 2 tweets à tester par page
      // Tous les tweets après le 12 sept 2025 sont garantis d'être testés
      logger.info(`🧪 ${initialTestingTweets.length} tweets GARANTIS d'être testés (max 2 par page)`);
      initialTestingTweets.forEach((tweet, index) => {
        const views = tweet.view_count || 0;
        const age = Math.floor((now - new Date(tweet.createdAt || tweet.created_at)) / (1000 * 60 * 60 * 24));
        const isNew = new Date(tweet.createdAt || tweet.created_at) >= testingStartDate ? '🆕' : '📅';
        logger.info(`   ${index + 1}. ${isNew} Tweet ${tweet.id}: ${views} vues, ${age} jours`);
      });
      
      // Trier les autres tweets par priorité : groupe initial en premier, puis par date décroissante
      otherTweets.sort((a, b) => {
        // Priorité aux tweets du groupe initial
        if (a.recommendation_group === 'initial' && b.recommendation_group !== 'initial') {
          return -1;
        }
        if (b.recommendation_group === 'initial' && a.recommendation_group !== 'initial') {
          return 1;
        }
        // Si même groupe ou aucun n'est initial, trier par date décroissante
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
      
      // Mélanger intelligemment les tweets : GARANTIE DE TEST - Maximum 2 tweets à tester par page de 10
      const mixedTweets = this.mixTweetsForPage(initialTestingTweets, otherTweets, limit);
      
      // Appliquer la pagination
      const startIndex = offset;
      const endIndex = Math.min(startIndex + limit, mixedTweets.length);
      const paginatedTweets = mixedTweets.slice(startIndex, endIndex);

      // TRACKING EN TEMPS RÉEL : Mettre à jour le tracking pour tous les tweets
      paginatedTweets.forEach(tweet => {
        this.tracker.updateTweetTracking(tweet.id, tweet);
        this.tracker.logTweetStatus(tweet.id, 'recommendation');
      });

      // Afficher le résumé des groupes
      this.tracker.displayGroupSummary();

      // Afficher les top performers
      this.tracker.displayTopPerformers(3);

      logger.info(`📊 ${paginatedTweets.length} tweets récupérés depuis le cache (${cachedTweets.length} total, groupe: ${group || 'all'})`);
      return paginatedTweets;
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des tweets depuis le cache:', error);
      // Fallback vers la méthode originale
      return await this.getCandidateTweets(userId, 'all', options);
    }
  }

  /**
   * Récupère les tweets depuis la DB en utilisant les groupes tagués
   */
  async getTweetsByGroup(userId, options = {}) {
    const { limit = 100, offset = 0, group = 'all' } = options;
    
    try {
      logger.info(`🔍 Récupération des tweets depuis la DB (groupe: ${group || 'all'})`);
      
      // Construire la condition WHERE
      const whereCondition = {
        deleted_at: null,
        is_data_test: false,
        moderation_status: 'approved',
        parent_tweet_id: null,
        created_at: {
          [Op.gte]: new Date('2025-09-07T00:00:00.000Z')
        }
      };
      
      // Ajouter le filtre par groupe si spécifié
      if (group && group !== 'all') {
        whereCondition.recommendation_group = group;
      }
      
      const tweets = await Tweet.findAll({
        where: whereCondition,
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'stats', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: limit,
        offset: offset
      });
      
      // Enrichir les tweets avec les informations de recommandation
      const enrichedTweets = tweets.map(tweet => ({
        ...(tweet.toJSON ? tweet.toJSON() : tweet),
        createdAt: tweet.createdAt || tweet.created_at,
        updatedAt: tweet.updatedAt || tweet.updated_at,
        recommendation_group: tweet.recommendation_group || 'initial'
      }));
      
      // Séparer les tweets du groupe initial avec moins de 2 vues
      const initialLowViewsTweets = enrichedTweets.filter(tweet => 
        tweet.recommendation_group === 'initial' && tweet.view_count < 2
      );
      const otherTweets = enrichedTweets.filter(tweet => 
        !(tweet.recommendation_group === 'initial' && tweet.view_count < 2)
      );
      
      // Trier les tweets du groupe initial avec moins de 2 vues par date décroissante (plus récents en premier)
      initialLowViewsTweets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      
      // Limiter à 3 tweets du groupe initial avec moins de 2 vues par page
      const limitedInitialLowViewsTweets = initialLowViewsTweets.slice(0, 3);
      
      // Trier les autres tweets par priorité : groupe initial en premier, puis par date décroissante
      otherTweets.sort((a, b) => {
        // Priorité aux tweets du groupe initial
        if (a.recommendation_group === 'initial' && b.recommendation_group !== 'initial') {
          return -1;
        }
        if (b.recommendation_group === 'initial' && a.recommendation_group !== 'initial') {
          return 1;
        }
        // Si même groupe ou aucun n'est initial, trier par date décroissante
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
      
      // Reconstituer la liste : tweets du groupe initial avec moins de 2 vues (max 3) en premier, puis les autres
      enrichedTweets = [...limitedInitialLowViewsTweets, ...otherTweets];
      
      logger.info(`📊 ${enrichedTweets.length} tweets récupérés depuis la DB (groupe: ${group || 'all'})`);
      return enrichedTweets;
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des tweets par groupe:', error);
      return [];
    }
  }

  /**
   * Obtient les recommandations progressives pour un utilisateur
   */
  async getProgressiveRecommendations(userId, options = {}) {
    const { limit = 10, offset = 0, includeUser = true, includeStats = true } = options;
    try {
      // S'assurer que le cache est chargé au premier appel
      if (!this.isLoaded && !this.isLoading) {
        logger.info('🚀 Premier appel - chargement du cache...');
        await this.initializeCache();
      }
      
      const cacheKey = `progressive_${userId}_${JSON.stringify(options)}`;
      
      // Vérifier le cache
      if (this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheExpiry) {
          logger.info(`📊 Cache hit pour les recommandations progressives de ${userId}`);
          return cached.data;
        }
      }

      logger.info(`🚀 Génération des recommandations progressives pour ${userId} (pagination: ${offset}-${offset + limit})`);

      // Récupérer le profil utilisateur
      const user = await User.findByPk(userId, {
        attributes: ['id', 'username', 'stats', 'created_at']
      });

      if (!user) {
        logger.error(`❌ Utilisateur ${userId} non trouvé`);
        throw new Error('Utilisateur non trouvé');
      }

      logger.info(`👤 Utilisateur trouvé: ${user.username} (ID: ${userId})`);

      // Pour l'algorithme progressif, on recommande des tweets existants
      // Le système détermine le groupe de recommandation pour chaque tweet
      logger.info(`🎯 Algorithme progressif: recherche de tweets à recommander pour ${user.username}`);
      
      // 🎯 SYSTÈME HYBRIDE: Queue + tweets établis avec limite
      // 1. Récupérer les tweets de la queue (nouveaux tweets à tester)
      const TweetQueueService = require('./tweetQueueService');
      const tweetQueueService = new TweetQueueService();
      // Ligne supprimée car on utilise maintenant getAllActiveQueueTweets
      
      // 2. PAGINATION MULTI-PAGE avec nouvelles limites
      // Récupérer TOUS les tweets de la queue pour la pagination
      const allQueueTweets = await tweetQueueService.getAllActiveQueueTweets(2000);

      // Séparer par groupes pour la pagination
      const allInitialTweets = allQueueTweets.filter(tweet => 
        tweet.recommendation_group === 'initial'
      );

      const allExpansionViralTweets = allQueueTweets.filter(tweet => 
        tweet.recommendation_group === 'expansion' || tweet.recommendation_group === 'viral'
      );

      // 3. CALCUL DE LA PAGINATION
      const tweetsPerPage = 10; // Par défaut
      const initialPerPage = 2;  // Max 2 initial par page
      const expansionViralPerPage = 8; // Max 8 expansion/viral par page
      
      // Calculer les indices pour cette page
      const currentPage = Math.floor(offset / tweetsPerPage) + 1;
      
      // Pour les initial: distribuer 2 par page
      const initialStartIndex = (currentPage - 1) * initialPerPage;
      const initialEndIndex = initialStartIndex + initialPerPage;
      const initialTweetsForPage = allInitialTweets.slice(initialStartIndex, initialEndIndex);
      
      // Pour expansion/viral: distribuer 8 par page
      const expansionViralStartIndex = (currentPage - 1) * expansionViralPerPage;
      const expansionViralEndIndex = expansionViralStartIndex + expansionViralPerPage;
      const expansionViralTweetsForPage = allExpansionViralTweets.slice(expansionViralStartIndex, expansionViralEndIndex);

      // 4. Combiner pour cette page
      const candidateTweets = [
        ...initialTweetsForPage.map(tweet => ({ ...tweet, _isFromQueue: true })),
        ...expansionViralTweetsForPage.map(tweet => ({ ...tweet, _isFromQueue: true }))
      ];
      
      logger.info(`📄 PAGE ${currentPage}: ${initialTweetsForPage.length}/2 initial + ${expansionViralTweetsForPage.length}/8 expansion/viral = ${candidateTweets.length} candidats`);
      logger.info(`📊 Total disponible: ${allInitialTweets.length} initial, ${allExpansionViralTweets.length} expansion/viral`);
      
      // Vérifier si on a assez de candidats pour la pagination
      if (candidateTweets.length === 0) {
        logger.warn(`⚠️ Aucun tweet candidat trouvé pour l'utilisateur ${userId}`);
        return {
          recommendations: [],
          pagination: {
            limit,
            offset,
            total: 0,
            hasMore: false,
            hasPrevious: false,
            currentPage: 1,
            totalPages: 0,
            nextOffset: null,
            previousOffset: null
          },
          metadata: {
            userGroup: 'initial',
            totalCandidates: 0,
            algorithm: 'progressive_viral',
            generatedAt: new Date().toISOString()
          }
        };
      }
      
      // Calculer les scores de recommandation progressifs
      logger.info(`🧮 Calcul des scores progressifs pour ${candidateTweets.length} tweets candidats...`);
      const scoredTweets = await this.calculateProgressiveScores(candidateTweets, 'progressive');
      
      // Filtrer les tweets null (exclus)
      const validTweets = scoredTweets.filter(tweet => tweet !== null);
      logger.info(`✅ Scores calculés pour ${validTweets.length} tweets valides (${scoredTweets.length - validTweets.length} exclus)`);
      
      // Appliquer les filtres de qualité standards
      logger.info(`🔍 Application des filtres de qualité...`);
      const filteredTweets = await this.applyStandardProgressiveFilters(validTweets, user);
      logger.info(`✅ ${filteredTweets.length} tweets passent les filtres de qualité`);
      
      // Trier par score décroissant
      logger.info(`📊 Tri des ${filteredTweets.length} tweets par score progressif...`);
      const sortedTweets = filteredTweets.sort((a, b) => b.progressiveScore - a.progressiveScore);
      
      // Log des 5 meilleurs tweets
      logger.info(`🏆 Top 5 des tweets recommandés:`);
      sortedTweets.slice(0, 5).forEach((tweet, index) => {
        logger.info(`  ${index + 1}. Tweet ${tweet.id} - Score: ${tweet.progressiveScore.toFixed(2)} - @${tweet.author?.username || 'unknown'}`);
      });
      
      // Calculer la pagination améliorée
      const totalTweets = sortedTweets.length;
      const startIndex = offset;
      const endIndex = Math.min(startIndex + limit, totalTweets);
      const limitedTweets = sortedTweets.slice(startIndex, endIndex);
      
      // Calculer les métadonnées de pagination MULTI-PAGE
      const currentPageNum = Math.floor(offset / limit) + 1;
      
      // Calculer combien de pages on peut faire avec nos tweets
      const maxInitialPages = Math.ceil(allInitialTweets.length / initialPerPage);
      const maxExpansionViralPages = Math.ceil(allExpansionViralTweets.length / expansionViralPerPage);
      const totalPossiblePages = Math.max(maxInitialPages, maxExpansionViralPages);
      
      // Vérifier s'il y a encore des tweets pour les pages suivantes
      const hasMoreInitial = initialEndIndex < allInitialTweets.length;
      const hasMoreExpansionViral = expansionViralEndIndex < allExpansionViralTweets.length;
      const hasMore = hasMoreInitial || hasMoreExpansionViral;
      const hasPrevious = offset > 0;
      
      // Enrichir avec les données utilisateur et statistiques
      const enrichedTweets = await this.enrichProgressiveTweets(limitedTweets, userId, includeUser, includeStats);
      
      const result = {
        recommendations: enrichedTweets,
        pagination: {
          limit,
          offset,
          total: totalTweets,
          hasMore,
          hasPrevious,
          currentPage: currentPageNum,
          totalPages: totalPossiblePages,
          nextOffset: hasMore ? offset + limit : null,
          previousOffset: hasPrevious ? Math.max(0, offset - limit) : null,
          tweetsInPage: enrichedTweets.length,
          availableInitial: allInitialTweets.length,
          availableExpansionViral: allExpansionViralTweets.length
        },
        metadata: {
          userGroup: 'progressive',
          totalCandidates: Math.min(limit, 20), // Nombre de candidats pour l'algorithme progressif (max 20)
          algorithm: 'progressive_viral',
          generatedAt: new Date().toISOString()
        }
      };

      // 🎯 INTÉGRATION DES PUBLICITÉS
      let finalTweets = enrichedTweets;
      try {
        const adService = require('./adService');
        finalTweets = await adService.injectAdsIntoFeed(userId, enrichedTweets, 0.1); // 10% de publicités
        
        if (finalTweets.length > enrichedTweets.length) {
          logger.info(`🎯 ${finalTweets.length - enrichedTweets.length} publicités injectées dans le feed de ${userId}`);
        }
      } catch (adError) {
        logger.error('❌ Erreur lors de l\'injection des publicités:', adError);
        // Continuer sans publicités en cas d'erreur
      }

      // Mettre à jour le résultat avec les tweets incluant les publicités
      result.recommendations = finalTweets;
      result.metadata.totalRecommendations = finalTweets.length;
      result.metadata.adsInjected = finalTweets.length - enrichedTweets.length;

      // Mettre en cache
      this.cache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });

      logger.info(`✅ ${finalTweets.length} recommandations progressives générées pour ${userId} (page ${currentPageNum}/${totalPossiblePages}, ${hasMore ? 'plus disponible' : 'fin'})`);
      return result;

    } catch (error) {
      logger.error('❌ Erreur dans getProgressiveRecommendations:', error);
      return { recommendations: [], metadata: { error: error.message } };
    }
  }

  /**
   * Track les comportements utilisateur pour l'algorithme progressif
   */
  async trackUserBehavior(userId, tweetId, action, context = {}) {
    try {
      logger.info(`📊 Tracking comportement: ${action} sur tweet ${tweetId} par utilisateur ${userId}`);
      
      // Enregistrer le comportement dans la base de données
      await UserBehaviorData.create({
        user_id: userId,
        target_id: tweetId,
        target_type: 'tweet',
        action_type: action,
        context_data: {
          algorithm: 'progressive_viral',
          timestamp: new Date().toISOString(),
          ...context
        }
      });

      // Évaluer les performances du tweet recommandé
      await this.evaluateTweetPerformance(tweetId, action);
      
      // Vérifier si l'utilisateur doit passer au groupe supérieur
      await this.checkForGroupPromotion(userId, tweetId, action);
      
      logger.info(`✅ Comportement ${action} tracké avec succès`);
    } catch (error) {
      logger.error(`❌ Erreur lors du tracking du comportement ${action}:`, error);
    }
  }

  /**
   * Évalue les performances d'un tweet recommandé
   */
  async evaluateTweetPerformance(tweetId, action) {
    try {
      // Récupérer les performances actuelles du tweet
      const tweet = await Tweet.findByPk(tweetId, {
        attributes: ['id', 'view_count', 'created_at']
      });

      if (!tweet) return;

      const views = parseInt(tweet.view_count) || 0;
      
      // Estimation plus réaliste des interactions basée sur les vues
      const totalInteractions = Math.floor(views * 0.02); // 2% des vues deviennent des interactions
      const engagementRate = views > 0 ? (totalInteractions / views) * 100 : 0;
      
      // Calculer l'âge du tweet en heures
      const tweetAge = (Date.now() - new Date(tweet.created_at)) / (1000 * 60 * 60);
      
      // Déterminer si le tweet performe bien selon le ratio d'engagement
      let performanceLevel = 'poor';
      let shouldPromote = false;
      
      // Seuils basés sur le ratio d'engagement (ajustés pour 2% de base)
      if (engagementRate >= 5) { // 5% d'engagement (très élevé)
        performanceLevel = 'excellent';
        shouldPromote = true;
      } else if (engagementRate >= 3) { // 3% d'engagement (élevé)
        performanceLevel = 'excellent';
        shouldPromote = true;
      } else if (engagementRate >= 2) { // 2% d'engagement (normal)
        performanceLevel = 'good';
        shouldPromote = true;
      } else if (engagementRate >= 1) { // 1% d'engagement (correct)
        performanceLevel = 'good';
        shouldPromote = true;
      }

      logger.info(`📈 Évaluation tweet ${tweetId}:`, {
        age: `${tweetAge.toFixed(1)}h`,
        interactions: totalInteractions,
        engagementRate: `${engagementRate.toFixed(2)}%`,
        performanceLevel,
        shouldPromote
      });

      // Si le tweet performe bien, enregistrer cette information
      if (shouldPromote) {
        await UserBehaviorData.create({
          user_id: null, // Pas d'utilisateur spécifique
          target_id: tweetId,
          target_type: 'tweet_performance',
          action_type: 'performance_evaluation',
          context_data: {
            algorithm: 'progressive_viral',
            performanceLevel,
            totalInteractions,
            engagementRate,
            tweetAge,
            timestamp: new Date().toISOString()
          }
        });
        
        logger.info(`🚀 Tweet ${tweetId} performe bien (${performanceLevel}) - L'utilisateur pourrait être promu`);
      }

    } catch (error) {
      logger.error('❌ Erreur lors de l\'évaluation des performances du tweet:', error);
    }
  }

  /**
   * Vérifie si l'utilisateur doit être promu au groupe supérieur
   */
  async checkForGroupPromotion(userId, tweetId, action) {
    try {
      // Récupérer l'utilisateur actuel
      const user = await User.findByPk(userId, {
        attributes: ['id', 'username', 'stats', 'created_at']
      });

      if (!user) return;

      const currentGroup = await this.determineUserGroup(user);
      
      // Récupérer les performances récentes de l'utilisateur
      const recentTweetStats = await this.getUserTweetPerformance(userId);
      const recentEngagementRatio = recentTweetStats.avgViews > 0 ? 
        (recentTweetStats.avgInteractions / recentTweetStats.avgViews) * 100 : 0;

      // Log des métriques de promotion
      logger.info(`📈 Métriques de promotion pour ${user.username}:`, {
        currentGroup,
        recentEngagementRatio: `${recentEngagementRatio.toFixed(2)}%`,
        avgInteractions: recentTweetStats.avgInteractions,
        avgViews: recentTweetStats.avgViews,
        totalTweets: recentTweetStats.totalTweets
      });

      // Critères de promotion basés sur les vues et l'engagement
      if (currentGroup === 'initial' && recentTweetStats.avgViews >= 20 && recentEngagementRatio >= 3) {
        logger.info(`🚀 Promotion possible: ${user.username} (${recentTweetStats.avgViews.toFixed(0)} vues, ratio: ${recentEngagementRatio.toFixed(2)}%) pourrait passer au groupe expansion`);
      } else if (currentGroup === 'expansion' && recentTweetStats.avgViews >= 100 && recentEngagementRatio >= 2) {
        logger.info(`🚀 Promotion possible: ${user.username} (${recentTweetStats.avgViews.toFixed(0)} vues, ratio: ${recentEngagementRatio.toFixed(2)}%) pourrait passer au groupe viral`);
      } else if (currentGroup === 'viral' && recentTweetStats.avgViews >= 1000 && recentEngagementRatio >= 1) {
        logger.info(`🚀 Promotion possible: ${user.username} (${recentTweetStats.avgViews.toFixed(0)} vues, ratio: ${recentEngagementRatio.toFixed(2)}%) pourrait passer au groupe massive`);
      } else if (currentGroup === 'viral' && recentTweetStats.avgViews < 100) {
        logger.info(`⚠️ Rétrogradation possible: ${user.username} (${recentTweetStats.avgViews.toFixed(0)} vues) pourrait redescendre au groupe expansion`);
      } else if (currentGroup === 'expansion' && recentTweetStats.avgViews < 20) {
        logger.info(`⚠️ Rétrogradation possible: ${user.username} (${recentTweetStats.avgViews.toFixed(0)} vues) pourrait redescendre au groupe initial`);
      }

    } catch (error) {
      logger.error('❌ Erreur lors de la vérification de promotion:', error);
    }
  }

  /**
   * Mélange intelligemment les tweets pour chaque page : GARANTIE DE TEST - Maximum 2 tweets à tester par page
   * avec diversité des créateurs
   */
  mixTweetsForPage(initialTestingTweets, otherTweets, pageSize = 10) {
    try {
      const mixedTweets = [];
      const maxTestingPerPage = 2; // GARANTIE DE TEST - Maximum 2 tweets à tester par page
      
      // Calculer le nombre de pages nécessaires
      const totalTweets = initialTestingTweets.length + otherTweets.length;
      const totalPages = Math.ceil(totalTweets / pageSize);
      
      logger.info(`🔄 Mélange avec GARANTIE DE TEST (position 3-4) et diversité des créateurs: ${initialTestingTweets.length} à tester, ${otherTweets.length} autres, ${totalPages} pages`);
      
      // Pour chaque page, mélanger les tweets avec diversité
      for (let page = 0; page < totalPages; page++) {
        const pageStart = page * pageSize;
        const pageEnd = Math.min(pageStart + pageSize, totalTweets);
        const pageSizeActual = pageEnd - pageStart;
        
        // GARANTIE DE TEST - Maximum 2 tweets à tester par page
        const testingTweetsForPage = Math.min(maxTestingPerPage, initialTestingTweets.length - (page * maxTestingPerPage));
        const otherTweetsForPage = Math.max(0, pageSizeActual - testingTweetsForPage);
        
        // Sélectionner les tweets à tester pour cette page (GARANTIE DE TEST)
        const pageTestingTweets = initialTestingTweets.slice(page * maxTestingPerPage, page * maxTestingPerPage + testingTweetsForPage);
        
        // Sélectionner les autres tweets pour cette page avec diversité des créateurs
        const pageOtherTweets = this.selectDiverseTweets(otherTweets, otherTweetsForPage, page * otherTweetsForPage);
        
        // NOUVELLE LOGIQUE : Placer les tweets à tester en position 3-4
        const pageTweets = [];
        
        if (pageOtherTweets.length >= 2) {
          // Placer les 2 premiers autres tweets
          pageTweets.push(...pageOtherTweets.slice(0, 2));
          
          // Placer les tweets à tester (max 2)
          pageTweets.push(...pageTestingTweets.slice(0, 2));
          
          // Placer le reste des autres tweets
          pageTweets.push(...pageOtherTweets.slice(2));
        } else {
          // Si moins de 2 autres tweets, placer les tweets à tester après
          pageTweets.push(...pageOtherTweets);
          pageTweets.push(...pageTestingTweets.slice(0, pageSizeActual - pageOtherTweets.length));
        }
        
        // Ajouter à la liste finale
        mixedTweets.push(...pageTweets);
        
        logger.info(`📄 Page ${page + 1}: ${pageTestingTweets.length} tweets à tester (pos 3-4) + ${pageOtherTweets.length} autres = ${pageTweets.length} tweets`);
        
        // Vérifier que les tweets à tester sont bien en position 3-4
        if (pageTestingTweets.length > 0) {
          const testingPositions = pageTweets.map((tweet, index) => 
            pageTestingTweets.some(testing => testing.id === tweet.id) ? index + 1 : null
          ).filter(pos => pos !== null);
          logger.info(`🎯 Tweets à tester en positions: ${testingPositions.join(', ')}`);
        }
      }
      
      logger.info(`✅ Mélange avec GARANTIE DE TEST (position 3-4) terminé: ${mixedTweets.length} tweets au total`);
      return mixedTweets;
      
    } catch (error) {
      logger.error('❌ Erreur lors du mélange des tweets:', error);
      // Fallback : retourner les tweets à tester en premier, puis les autres
      return [...initialTestingTweets, ...otherTweets];
    }
  }

  /**
   * Sélectionne des tweets avec diversité des créateurs
   * Évite d'avoir plusieurs tweets du même créateur dans une page
   */
  selectDiverseTweets(tweets, count, startIndex = 0) {
    try {
      if (count <= 0 || tweets.length === 0) return [];
      
      const selectedTweets = [];
      const usedCreators = new Set();
      const maxTweetsPerCreator = Math.min(3, Math.max(1, Math.floor(count / 3))); // Maximum 3 tweets par créateur, ou 1/3 si moins
      
      // Trier les tweets par priorité (date décroissante)
      const sortedTweets = [...tweets].sort((a, b) => {
        const dateA = new Date(a.createdAt || a.created_at);
        const dateB = new Date(b.createdAt || b.created_at);
        return dateB - dateA;
      });
      
      // Sélectionner les tweets avec diversité
      for (const tweet of sortedTweets) {
        if (selectedTweets.length >= count) break;
        
        const creatorId = tweet.user_id;
        const creatorCount = Array.from(selectedTweets).filter(t => t.user_id === creatorId).length;
        
        // Si on n'a pas encore atteint la limite pour ce créateur, l'ajouter
        if (creatorCount < maxTweetsPerCreator) {
          selectedTweets.push(tweet);
          usedCreators.add(creatorId);
        }
      }
      
      // Si on n'a pas assez de tweets, compléter avec les tweets restants (même créateur)
      if (selectedTweets.length < count) {
        for (const tweet of sortedTweets) {
          if (selectedTweets.length >= count) break;
          if (!selectedTweets.some(t => t.id === tweet.id)) {
            selectedTweets.push(tweet);
          }
        }
      }
      
      logger.info(`🎭 Diversité des créateurs: ${usedCreators.size} créateurs uniques, max 3 tweets par créateur sur ${selectedTweets.length} tweets`);
      
      return selectedTweets.slice(0, count);
      
    } catch (error) {
      logger.error('❌ Erreur lors de la sélection diversifiée:', error);
      // Fallback : retourner les tweets dans l'ordre
      return tweets.slice(startIndex, startIndex + count);
    }
  }

  /**
   * Ajoute automatiquement un nouveau tweet dans le système de test
   */
  async addNewTweet(tweetId) {
    try {
      logger.info(`🧪 Ajout automatique du tweet ${tweetId} dans le système de test`);
      
      // Récupérer le tweet
      const tweet = await Tweet.findByPk(tweetId, {
        attributes: ['id', 'content', 'user_id', 'created_at', 'view_count', 'recommendation_group']
      });
      
      if (!tweet) {
        logger.error(`❌ Tweet ${tweetId} non trouvé`);
        return { success: false, error: 'Tweet non trouvé' };
      }
      
      // S'assurer que le tweet est dans le groupe initial
      if (tweet.recommendation_group !== 'initial') {
        await tweet.update({
          recommendation_group: 'initial',
          view_count: 0
        });
        logger.info(`🔄 Tweet ${tweetId} mis à jour vers le groupe initial`);
      }
      
      // Ajouter le tweet au cache s'il est chargé
      if (this.isLoaded) {
        const tweetData = {
          id: tweet.id,
          content: tweet.content,
          user_id: tweet.user_id,
          createdAt: tweet.created_at,
          view_count: tweet.view_count || 0,
          recommendation_group: 'initial'
        };
        
        // Ajouter au cache
        this.cache.set(`tweet_${tweet.id}`, {
          data: tweetData,
          timestamp: Date.now()
        });
        
        // TRACKING : Logger l'ajout du nouveau tweet
        this.tracker.updateTweetTracking(tweetId, tweetData);
        this.tracker.logTweetStatus(tweetId, 'added');
        
        logger.info(`✅ Tweet ${tweetId} ajouté au cache du système de test`);
      }
      
      return { success: true, message: 'Tweet ajouté au système de test' };
      
    } catch (error) {
      logger.error(`❌ Erreur lors de l'ajout du tweet ${tweetId} au système de test:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Sélectionne les utilisateurs connectés par ordre de connexion pour un groupe donné
   */
  async getConnectedUsersForGroup(groupName, limit) {
    try {
      const groupConfig = this.recommendationGroups[groupName];
      if (!groupConfig) {
        logger.error(`❌ Groupe ${groupName} non trouvé`);
        return [];
      }

      const actualLimit = Math.min(limit, groupConfig.maxSize);
      
      // Sélectionner les utilisateurs connectés par ordre de connexion (last_activity DESC)
      const connectedUsers = await User.findAll({
        where: {
          is_active: true,
          last_activity: {
            [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) // Connectés dans les dernières 24h
          }
        },
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'last_activity'],
        order: [['last_activity', 'DESC']], // Les plus récemment connectés en premier
        limit: actualLimit
      });

      logger.info(`👥 ${connectedUsers.length} utilisateurs connectés sélectionnés pour le groupe ${groupName}`);
      return connectedUsers;

    } catch (error) {
      logger.error(`❌ Erreur lors de la sélection des utilisateurs connectés pour ${groupName}:`, error);
      return [];
    }
  }

  /**
   * Obtient les candidats (utilisateurs connectés) pour un tweet selon son groupe de recommandation
   */
  async getTweetCandidates(tweetId, groupName) {
    try {
      const groupConfig = this.recommendationGroups[groupName];
      if (!groupConfig) {
        logger.error(`❌ Groupe ${groupName} non trouvé`);
        return [];
      }

      // Obtenir les utilisateurs connectés pour ce groupe
      const candidates = await this.getConnectedUsersForGroup(groupName, groupConfig.maxSize);
      
      logger.info(`🎯 ${candidates.length} candidats sélectionnés pour le tweet ${tweetId} (groupe: ${groupName})`);
      
      return candidates.map(user => ({
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        avatar: user.avatar,
        verified: user.verified,
        premium: user.premium,
        last_activity: user.last_activity,
        group: groupName
      }));

    } catch (error) {
      logger.error(`❌ Erreur lors de la récupération des candidats pour le tweet ${tweetId}:`, error);
      return [];
    }
  }

  /**
   * Détermine le groupe de recommandation pour un tweet spécifique
   * Système progressif basé sur les performances réelles du tweet
   */
  async determineTweetRecommendationGroup(tweetId) {
    try {
      // Récupérer les données actuelles du tweet
      const tweet = await Tweet.findByPk(tweetId, {
        attributes: ['id', 'view_count', 'created_at', 'recommendation_group']
      });

      if (!tweet) {
        return { group: 'initial', reason: 'Tweet non trouvé' };
      }

      // Récupérer le groupe actuel pour détecter les transitions
      const currentGroup = tweet.recommendation_group || 'initial';

      // Helper pour logger les transitions
      const logTransition = (result) => {
        if (currentGroup !== result.group) {
          this.tracker.logGroupTransition(tweetId, currentGroup, result.group, result.reason);
        }
        return result;
      };

      const views = parseInt(tweet.view_count) || 0;
      
      // Vérifier l'âge du tweet pour l'exclusion automatique
      const tweetAge = (Date.now() - new Date(tweet.created_at)) / (1000 * 60 * 60 * 24); // âge en jours
      
      // VÉRIFICATION AUTOMATIQUE DE PROGRESSION : Si le tweet a dépassé la taille de son groupe actuel
      const currentGroupSize = this.tracker.getGroupSize(currentGroup);
      if (views > currentGroupSize && currentGroup !== 'massive') {
        // Le tweet a dépassé la taille de son groupe actuel, le promouvoir automatiquement
        let nextGroup = 'initial';
        if (currentGroup === 'initial' && views >= 10) {
          nextGroup = 'expansion';
        } else if (currentGroup === 'expansion' && views >= 26) {
          nextGroup = 'viral';
        } else if (currentGroup === 'viral' && views >= 40) {
          nextGroup = 'massive';
        }
        
        if (nextGroup !== currentGroup) {
          const candidates = await this.getTweetCandidates(tweetId, nextGroup);
          return logTransition({ 
            group: nextGroup, 
            reason: `PROMOTION AUTOMATIQUE: ${views} vues > ${currentGroupSize} (groupe ${currentGroup}) → ${nextGroup}`,
            maxCandidates: this.tracker.getGroupSize(nextGroup),
            candidates: candidates
          });
        }
      }

      // 🚀 STRATÉGIE TWITTER-LEVEL pour nouveaux tweets (0-3 vues)
      if (views < 4) {
        // Si le tweet est très ancien (24h seulement) et n'a toujours pas de vues, l'exclure
        if (tweetAge > 1 && views === 0) { // Réduit de 7 jours à 24h !
          return logTransition({ 
            group: 'excluded', 
            reason: `Tweet ancien sans vues: ${views} vues après ${Math.round(tweetAge * 24)}h - tweet retiré de l'algorithme`,
            maxCandidates: 0
          });
        }
        
        // 🔥 BOOST pour nouveaux tweets (moins de 2h)
        const isVeryNew = tweetAge < 0.08; // Moins de 2 heures
        const maxCandidates = isVeryNew ? 8 : 4; // Double la taille pour les très nouveaux tweets
        
        return logTransition({ 
          group: 'initial', 
          reason: `Nouveau tweet: ${views} vues (démarrage dans le groupe initial${isVeryNew ? ' - BOOST nouveau tweet' : ''})`,
          maxCandidates
        });
      }
      
      // Pour l'instant, on estime les interactions à 2% des vues
      // Dans un vrai système, on récupérerait les vraies interactions
      const estimatedInteractions = Math.floor(views * 0.02); // 2% des vues
      const engagementRatio = views > 0 ? (estimatedInteractions / views) : 0;

      logger.info(`🔍 Analyse du tweet ${tweetId}:`, {
        views,
        interactions: estimatedInteractions,
        engagementRatio: (engagementRatio * 100).toFixed(2) + '%'
      });

      // Système progressif basé sur les vues et l'engagement
      if (views >= 1000) {
        // Groupe massif : vérifier l'engagement toutes les 1000 vues
        if (engagementRatio >= 0.15) { // 15% d'engagement pour rester massif
          // Obtenir les candidats pour le groupe massif
          const candidates = await this.getTweetCandidates(tweetId, 'massive');
          
          return logTransition({ 
            group: 'massive', 
            reason: `Massif maintenu: ${views} vues, ${(engagementRatio * 100).toFixed(1)}% d'engagement (${estimatedInteractions} interactions)`,
            maxCandidates: 1000,
            candidates: candidates
          });
    } else {
          return { 
            group: 'excluded', 
            reason: `Cycle terminé: ${views} vues mais engagement insuffisant ${(engagementRatio * 100).toFixed(1)}% - tweet retiré de l'algorithme`,
            maxCandidates: 0
          };
        }
      } else if (views >= 100) {
        // Groupe viral : vérifier l'engagement toutes les 100 vues
        if (engagementRatio >= 0.20) { // 20% d'engagement
          // Obtenir les candidats pour le groupe viral
          const candidates = await this.getTweetCandidates(tweetId, 'viral');
          
          return logTransition({ 
            group: 'viral', 
            reason: `Viral maintenu: ${views} vues, ${(engagementRatio * 100).toFixed(1)}% d'engagement (${estimatedInteractions} interactions)`,
            maxCandidates: 100,
            candidates: candidates
          });
        } else {
          return logTransition({ 
            group: 'excluded', 
            reason: `Cycle terminé: ${views} vues mais engagement insuffisant ${(engagementRatio * 100).toFixed(1)}% - tweet retiré de l'algorithme`,
            maxCandidates: 0
          });
        }
      } else if (views >= 20) {
        // Groupe expansion : vérifier l'engagement à 20 vues
        if (engagementRatio >= 0.10) { // 10% d'engagement
          return logTransition({ 
            group: 'viral', 
            reason: `Promotion virale: ${views} vues, ${(engagementRatio * 100).toFixed(1)}% d'engagement (${estimatedInteractions} interactions)`,
            maxCandidates: 100
          });
        } else {
          // Si le tweet stagne dans le groupe expansion trop longtemps (21+ jours), l'exclure
          if (tweetAge > 21) {
            return logTransition({ 
              group: 'excluded', 
              reason: `Stagnation expansion: ${views} vues après ${Math.round(tweetAge)} jours sans progression - tweet retiré de l'algorithme`,
              maxCandidates: 0
            });
          }
          
          // Obtenir les candidats pour le groupe expansion
          const candidates = await this.getTweetCandidates(tweetId, 'expansion');
          
          return logTransition({ 
            group: 'expansion', 
            reason: `Expansion maintenue: ${views} vues, ${(engagementRatio * 100).toFixed(1)}% d'engagement (${estimatedInteractions} interactions)`,
            maxCandidates: 20,
            candidates: candidates
          });
        }
      } else if (views >= 10) {
        // Groupe expansion : vérifier l'engagement à 10 vues
        if (engagementRatio >= 0.10) { // 10% d'engagement
          // Obtenir les candidats pour le groupe expansion
          const candidates = await this.getTweetCandidates(tweetId, 'expansion');
          
          return logTransition({ 
            group: 'expansion', 
            reason: `Promotion expansion: ${views} vues, ${(engagementRatio * 100).toFixed(1)}% d'engagement (${estimatedInteractions} interactions)`,
            maxCandidates: 20,
            candidates: candidates
          });
        } else {
          // Obtenir les candidats pour le groupe initial
          const candidates = await this.getTweetCandidates(tweetId, 'initial');
          
          return logTransition({ 
            group: 'initial', 
            reason: `Initial maintenu: ${views} vues, engagement insuffisant ${(engagementRatio * 100).toFixed(1)}% (${estimatedInteractions} interactions)`,
            maxCandidates: 4,
            candidates: candidates
          });
        }
      } else if (views >= 4) {
        // 🚀 Groupe initial : seuils plus agressifs pour progression rapide
        if (engagementRatio >= 0.05) { // Réduit de 10% à 5% d'engagement !
          // Obtenir les candidats pour le groupe expansion
          const candidates = await this.getTweetCandidates(tweetId, 'expansion');
          
          return logTransition({ 
            group: 'expansion', 
            reason: `Promotion expansion RAPIDE: ${views} vues, ${(engagementRatio * 100).toFixed(1)}% d'engagement (${estimatedInteractions} interactions)`,
            maxCandidates: 20,
            candidates: candidates
          });
        } else {
          // Si le tweet stagne dans le groupe initial trop longtemps (6h seulement), l'exclure
          if (tweetAge > 0.25) { // Réduit de 14 jours à 6 heures !
            return logTransition({ 
              group: 'excluded', 
              reason: `Stagnation rapide: ${views} vues après ${Math.round(tweetAge * 24)}h sans progression - tweet retiré de l'algorithme`,
              maxCandidates: 0
            });
          }
          
          // Obtenir les candidats pour le groupe initial
          const candidates = await this.getTweetCandidates(tweetId, 'initial');
          
          return logTransition({ 
            group: 'initial', 
            reason: `Groupe initial: ${views} vues, ${(engagementRatio * 100).toFixed(1)}% d'engagement (${estimatedInteractions} interactions)`,
            maxCandidates: 4,
            candidates: candidates
          });
        }
      } else {
        // Nouveaux tweets avec 0-3 vues
        // Obtenir les candidats pour le groupe initial
        const candidates = await this.getTweetCandidates(tweetId, 'initial');
        
        return logTransition({ 
          group: 'initial', 
          reason: `Nouveau tweet: ${views} vues (démarrage dans le groupe initial)`,
          maxCandidates: 4,
          candidates: candidates
        });
      }

    } catch (error) {
      logger.error('❌ Erreur lors de la détermination du groupe de recommandation:', error);
      return { group: 'initial', reason: 'Erreur de calcul', maxCandidates: 4 };
    }
  }

  /**
   * Récupère les performances moyennes des tweets d'un utilisateur
   */
  async getUserTweetPerformance(userId) {
    try {
      const tweets = await Tweet.findAll({
        where: {
          user_id: userId,
          deleted_at: null,
          moderation_status: 'approved',
          created_at: {
            [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 derniers jours
          }
        },
        attributes: [
          'id',
          'view_count',
          'created_at'
        ],
        limit: 50 // Analyser les 50 derniers tweets
      });

      if (tweets.length === 0) {
        return {
          avgInteractions: 0,
          avgViews: 0,
          totalTweets: 0,
          avgEngagementRate: 0
        };
      }

      let totalViews = 0;
      let totalEngagement = 0;

      tweets.forEach(tweet => {
        const views = parseInt(tweet.view_count) || 0;
        
        // Estimation plus réaliste des interactions basée sur les vues
        // Ratio typique sur les réseaux sociaux : 1-3% d'engagement
        const estimatedInteractions = Math.floor(views * 0.02); // 2% des vues deviennent des interactions
        const engagementRate = views > 0 ? (estimatedInteractions / views) * 100 : 0;
        
        totalViews += views;
        totalEngagement += engagementRate;
      });

      const avgViews = totalViews / tweets.length;
      const avgInteractions = avgViews * 0.02; // Estimation plus réaliste : 2%
      const avgEngagementRate = totalEngagement / tweets.length;

      return {
        avgInteractions,
        avgViews,
        totalTweets: tweets.length,
        avgEngagementRate
      };

    } catch (error) {
      logger.error('❌ Erreur lors du calcul des performances utilisateur:', error);
      return {
        avgInteractions: 0,
        avgViews: 0,
        totalTweets: 0,
        avgEngagementRate: 0
      };
    }
  }

  /**
   * Récupère les tweets candidats selon le groupe de l'utilisateur
   */
  async getCandidateTweets(userId, algorithmType, context) {
    const limit = context.limit || 100;
    const offset = context.offset || 0;

    // 🎯 NOUVEAU SYSTÈME DE QUEUE - Tweets contrôlés et propres
    // SEULEMENT les tweets qui sont passés par la queue et approuvés
    let whereClause = {
      deleted_at: null,
      moderation_status: 'approved', // SEULEMENT les tweets approuvés
      // 🚫 Exclure les réponses (tweets de type "reply")
      parent_tweet_id: null,
      // 🎯 SEULEMENT les tweets en mode testing (passés par la queue)
      progressive_testing_status: 'testing',
      // 📅 Filtrer pour les tweets ajoutés via la queue (nouveaux tweets seulement)
      progressive_added_at: {
        [Op.ne]: null // Doit avoir une date d'ajout à l'algorithme
      }
    };

    // Système de recommandation progressif basé sur les performances
    let orderClause;
    let candidateLimit;

    // 🎯 SYSTÈME CONTRÔLÉ: 2 tweets à tester par page maximum
    // Ordre simple et propre par date d'ajout à l'algorithme
    orderClause = [
      ['progressive_added_at', 'DESC'], // Plus récemment ajoutés en premier
      ['created_at', 'DESC']            // Puis par date de création
    ];
    candidateLimit = Math.min(limit, 100); // Limite normale

    // Récupérer les tweets avec leurs métriques d'interaction
    const tweets = await Tweet.findAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'stats', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
        },
        {
          model: TweetLike,
          as: 'likes',
          attributes: ['id', 'user_id', 'created_at']
        },
        {
          model: TweetRetweet,
          as: 'retweets',
          attributes: ['id', 'user_id', 'created_at']
        }
      ],
      order: orderClause,
      limit: candidateLimit,
      offset
    });

    logger.info(`📊 ${tweets.length} tweets candidats trouvés (algorithme: ${algorithmType}, limite demandée: ${candidateLimit}, limit param: ${limit})`);
    return tweets;
  }

  /**
   * Calcule les scores de recommandation progressifs
   */
  async calculateProgressiveScores(tweets, algorithmType) {
    const now = Date.now();
    logger.info(`🧮 Début du calcul des scores pour ${tweets.length} tweets (algorithme: ${algorithmType})`);
    
    return Promise.all(tweets.map(async (tweet, index) => {
      // Log du début de traitement pour chaque tweet
      if (index < 5) { // Log pour les 5 premiers tweets
        logger.info(`📝 Traitement du tweet ${index + 1}/${tweets.length}: ${tweet.id} par @${tweet.author?.username || 'unknown'}`);
      }
      
      // Déterminer le groupe de recommandation pour ce tweet spécifique
      const tweetGroup = await this.determineTweetRecommendationGroup(tweet.id);
      
      // Si le tweet est exclu (sans vues), on le skip
      if (tweetGroup.group === 'excluded') {
        logger.info(`⏭️ Tweet ${tweet.id} exclu: ${tweetGroup.reason}`);
        return null; // Retourner null pour filtrer ce tweet
      }
      
      // Vérifier que le tweet a un ID valide
      if (!tweet.id) {
        logger.error(`❌ Tweet sans ID détecté:`, { tweet: Object.keys(tweet), index });
        return null; // Filtrer ce tweet invalide
      }
      
      // Récupérer les interactions récentes pour ce tweet
      const interactions = await this.getTweetInteractions(tweet.id);
      
      // Log des interactions pour les premiers tweets
      if (index < 3) {
        logger.info(`📊 Interactions pour tweet ${tweet.id}: ${interactions.likes} likes, ${interactions.comments} commentaires, ${interactions.retweets} retweets, ${interactions.views} vues`);
        logger.info(`🎯 Groupe de recommandation: ${tweetGroup.group} - ${tweetGroup.reason}`);
      }
      
      // Calculer le score de viralité actuel
      const viralScore = this.calculateViralScore(interactions, tweet);
      
      // 🎯 SYSTÈME HYBRIDE: Identification des tweets de la queue
      const isFromQueue = tweet._isFromQueue || false; // Tweet venant de la queue
      const tweetAge = (Date.now() - new Date(tweet.created_at)) / (1000 * 60 * 60); // âge en heures
      
      // Déterminer le niveau de recommandation actuel
      const totalInteractions = interactions.likes + interactions.comments + interactions.retweets;
      const totalViews = interactions.views || 1; // Éviter la division par zéro
      const recommendationLevel = this.determineRecommendationLevel(totalInteractions, totalViews);
      
      // Log du niveau de recommandation
      if (index < 3) {
        logger.info(`🎯 Niveau de recommandation pour tweet ${tweet.id}: ${recommendationLevel} (interactions: ${totalInteractions}, vues: ${totalViews})`);
      }
      
      // Calculer le score de décroissance temporelle
      const timeDecay = await this.calculateTimeDecay(tweet.createdAt, tweetGroup.group, tweet);
      
      // Calculer le score de similarité avec l'utilisateur
      const similarityScore = await this.calculateSimilarityScore(tweet, tweetGroup.group);
      
      // 🎯 Bonus simple pour les tweets de la queue (pas de boost massif)
      const queueBonus = isFromQueue ? 0.3 : 0; // Bonus léger de 0.3 pour les tweets de la queue
      
      // Bonus pour les tweets du groupe initial (priorité maximale)
      const isInitialGroup = tweetGroup.group === 'initial';
      const isInitialLowViews = isInitialGroup && totalViews < 2;
      const initialGroupBonus = isInitialGroup ? 1.0 : 0; // Bonus de 1.0 pour le groupe initial
      const initialLowViewsBonus = isInitialLowViews ? 2.0 : 0; // Bonus de 2.0 pour les tweets du groupe initial avec moins de 2 vues
      
      // 🎯 Score final propre et équilibré
      let progressiveScore = (
        viralScore * 0.4 +
        recommendationLevel * 0.3 +
        timeDecay * 0.2 +
        similarityScore * 0.1 +
        queueBonus + // Bonus léger pour les tweets de la queue
        initialGroupBonus + // Bonus pour le groupe initial
        initialLowViewsBonus // Bonus pour les tweets du groupe initial avec moins de 2 vues
      );
      
      // Protection contre les scores invalides
      if (isNaN(progressiveScore) || !isFinite(progressiveScore)) {
        logger.warn(`⚠️ Score progressif invalide pour tweet ${tweet.id}: ${progressiveScore}. Calcul avec valeurs par défaut.`);
        progressiveScore = (
          (viralScore || 1) * 0.4 +
          (recommendationLevel || 0) * 0.3 +
          (timeDecay || 0.5) * 0.2 +
          (similarityScore || 0.5) * 0.1 +
          (queueBonus || 0) +
          (initialGroupBonus || 0) +
          (initialLowViewsBonus || 0)
        );
      }

      // Log détaillé des scores pour les premiers tweets
      if (index < 3) {
        logger.info(`🔍 Scores détaillés pour tweet ${tweet.id}:`, {
          viralScore: viralScore.toFixed(2),
          recommendationLevel,
          timeDecay: timeDecay.toFixed(2),
          similarityScore: similarityScore.toFixed(2),
          progressiveScore: progressiveScore.toFixed(2),
          totalInteractions,
          totalViews,
          isFromQueue: isFromQueue,
          queueBonus
        });
      }
      
      // Log spécial pour les tweets de la queue
      if (isFromQueue) {
        logger.info(`📥 Tweet de la queue détecté: ${tweet.id} avec ${totalViews} vues - bonus appliqué: ${queueBonus}`);
      }
      
      if (isInitialGroup) {
        logger.info(`🎯 Tweet du groupe initial priorisé: ${tweet.id} - bonus appliqué: ${initialGroupBonus}`);
      }
      
      if (isInitialLowViews) {
        logger.info(`🚀 Tweet du groupe initial avec moins de 2 vues priorisé: ${tweet.id} - bonus total: ${initialGroupBonus + initialLowViewsBonus}`);
      }

      // Enrichir le tweet avec toutes les informations nécessaires
      const enrichedTweet = {
        ...(tweet.toJSON ? tweet.toJSON() : tweet),
        // Métadonnées de recommandation progressive
        progressiveScore,
        viralScore,
        recommendationLevel,
        timeDecay,
        similarityScore,
        // Statistiques d'engagement
        stats: {
          likes: interactions.likes,
          retweets: interactions.retweets,
          replies: interactions.comments,
          views: interactions.views
        },
        // Métadonnées de recommandation
        _recommendation_metadata: {
          group: tweetGroup.group,
          reason: tweetGroup.reason,
          maxCandidates: tweetGroup.maxCandidates
        },
        // Interactions utilisateur (seront ajoutées plus tard)
        user_interaction: {
          is_liked: false,
          is_retweeted: false,
          has_replied: false
        },
        // Métadonnées de recommandation
        _recommendation_metadata: {
          algorithm: 'progressive_viral',
        progressiveScore,
        viralScore,
        recommendationLevel,
        timeDecay,
        similarityScore,
        interactions: {
          likes: interactions.likes,
          comments: interactions.comments,
          retweets: interactions.retweets,
          views: interactions.views,
          shares: interactions.shares
          }
        }
      };

      return enrichedTweet;
    }));
  }

  /**
   * Enrichit les tweets progressifs avec les données utilisateur et statistiques
   */
  async enrichProgressiveTweets(tweets, userId, includeUser, includeStats) {
    try {
      return await Promise.all(tweets.map(async (tweet) => {
        const enrichedTweet = { ...tweet };

        // Un retweet pur n'a pas d'engagement propre : compteurs et état
        // d'interaction sont ceux du tweet d'origine.
        const statsId = tweet.id ? engagementTargetId(tweet) : null;

        // Enrichir les statistiques si demandé
        if (includeStats && statsId) {
          const [likeCount, retweetCount, replyCount] = await Promise.all([
            TweetLike.countTweetLikes(statsId).catch(() => 0),
            TweetRetweet.countTweetRetweets(statsId).catch(() => 0),
            Tweet.count({ where: { parent_tweet_id: statsId } }).catch(() => 0)
          ]);

          enrichedTweet.stats = {
            likes: likeCount,
            retweets: retweetCount,
            replies: replyCount,
            views: (statsId === String(tweet.id)
              ? tweet.view_count
              : (tweet.originalTweet || tweet.original_tweet)?.view_count) || 0
          };
        }

        // Enrichir les interactions utilisateur si demandé
        if (userId && statsId) {
          const [isLiked, isRetweeted] = await Promise.all([
            TweetLike.hasUserLikedTweet(userId, statsId).catch(() => false),
            TweetRetweet.hasUserRetweetedTweet(userId, statsId).catch(() => false)
          ]);

          enrichedTweet.user_interaction = {
            is_liked: isLiked,
            is_retweeted: isRetweeted,
            has_replied: false
          };
        }

        // Enrichir les données utilisateur si demandé
        if (includeUser && tweet.author) {
          enrichedTweet.author = {
            ...tweet.author,
            stats: tweet.author.stats || {},
            is_following: false // À implémenter si nécessaire
          };
        }

        return enrichedTweet;
      }));
    } catch (error) {
      logger.error('❌ Erreur lors de l\'enrichissement des tweets progressifs:', error);
      return tweets;
    }
  }

  /**
   * Récupère les interactions récentes pour un tweet
   */
  async getTweetInteractions(tweetId) {
    // Vérifier que tweetId est valide
    if (!tweetId) {
      logger.error('❌ getTweetInteractions appelé avec tweetId undefined');
      return { likes: 0, comments: 0, retweets: 0, views: 0, shares: 0 };
    }
    
    // Récupérer les interactions totales du tweet (pas seulement la dernière heure)
    const [likes, comments, retweets, views, shares] = await Promise.all([
      TweetLike.count({
        where: {
          tweet_id: tweetId
        }
      }),
      // Compter les commentaires (réponses)
      Tweet.count({
        where: {
          parent_tweet_id: tweetId
        }
      }),
      TweetRetweet.count({
        where: {
          tweet_id: tweetId
        }
      }),
      // Récupérer les vues depuis UserBehaviorData
      UserBehaviorData.count({
        where: {
          target_id: tweetId,
          target_type: 'tweet',
          action_type: 'tweet_view'
        }
      }),
      // Récupérer les partages depuis UserBehaviorData
      UserBehaviorData.count({
        where: {
          target_id: tweetId,
          target_type: 'tweet',
          action_type: 'tweet_share'
        }
      })
    ]);

    // Si toutes les interactions sont à 0, donner des valeurs par défaut basées sur l'âge du tweet
    const tweet = await Tweet.findByPk(tweetId);
    if (tweet && likes === 0 && comments === 0 && retweets === 0 && views === 0 && shares === 0) {
      const ageInDays = (Date.now() - new Date(tweet.createdAt)) / (1000 * 60 * 60 * 24);
      const baseEngagement = Math.max(1, Math.floor(ageInDays * 0.1)); // Engagement de base basé sur l'âge
      
      return { 
        likes: baseEngagement, 
        comments: Math.floor(baseEngagement * 0.1), 
        retweets: Math.floor(baseEngagement * 0.05), 
        views: Math.max(1, baseEngagement * 10), 
        shares: Math.floor(baseEngagement * 0.02) 
      };
    }

    // S'assurer que toutes les valeurs sont des nombres (pas null)
    return { 
      likes: likes || 0, 
      comments: comments || 0, 
      retweets: retweets || 0, 
      views: views || 0, 
      shares: shares || 0 
    };
  }

  /**
   * Calcule le score de viralité basé sur les interactions
   */
  calculateViralScore(interactions, tweet) {
    let score = 0;
    
    // Score basé sur les interactions récentes
    score += interactions.likes * this.interactionScores.like;
    score += interactions.comments * this.interactionScores.comment;
    score += interactions.retweets * this.interactionScores.retweet;
    score += (interactions.views || 0) * this.interactionScores.click; // Utiliser click au lieu de view
    score += (interactions.shares || 0) * this.interactionScores.share;
    
    // Bonus pour les tweets avec beaucoup d'engagement
    const totalEngagement = interactions.likes + interactions.comments + interactions.retweets;
    if (totalEngagement > 10) {
      score *= 1.2; // 20% de bonus
    }
    if (totalEngagement > 50) {
      score *= 1.5; // 50% de bonus
    }
    
    // Bonus pour les tweets avec médias
    if (tweet.media_urls && tweet.media_urls.length > 0) {
      score *= 1.1; // 10% de bonus
    }
    
    // Bonus pour les tweets avec hashtags
    if (tweet.hashtags && tweet.hashtags.length > 0) {
      score *= 1.05; // 5% de bonus
    }
    
    return Math.max(0, score); // Score minimum de 0
  }

  /**
   * Détermine le niveau de recommandation actuel basé sur le ratio d'engagement
   */
  determineRecommendationLevel(interactions, views) {
    // Si pas de vues, utiliser le nombre d'interactions comme base
    if (views === 0) {
      if (interactions >= 50) return 4; // Niveau massif
      if (interactions >= 20) return 3; // Niveau viral
      if (interactions >= 10) return 2; // Niveau expansion
      return 1; // Niveau initial
    }
    
    const engagementRatio = interactions / views;
    const negativeRatio = this.calculateNegativeRatio(interactions, views);
    
    // Vérifier si le tweet doit être arrêté (trop d'interactions négatives)
    if (negativeRatio > this.progressionThresholds.max_negative_ratio) {
      return 0; // Arrêt du tweet
    }
    
    // Déterminer le niveau basé sur le ratio d'engagement
    if (engagementRatio >= this.progressionThresholds.viral_to_massive) {
      return 4; // Niveau massif (tous les utilisateurs)
    } else if (engagementRatio >= this.progressionThresholds.expansion_to_viral) {
      return 3; // Niveau viral
    } else if (engagementRatio >= this.progressionThresholds.initial_to_expansion) {
      return 2; // Niveau expansion
    } else if (engagementRatio >= this.progressionThresholds.maintain_initial) {
      return 1; // Niveau initial
    } else {
      return 0; // Pas de recommandation
    }
  }

  /**
   * Calcule le ratio d'interactions négatives
   */
  calculateNegativeRatio(interactions, views) {
    // Cette méthode sera implémentée pour calculer le ratio d'interactions négatives
    // Pour l'instant, retourner 0 (pas d'interactions négatives)
    return 0;
  }

  /**
   * Calcule la décroissance temporelle dynamique
   */
  async calculateTimeDecay(createdAt, tweetGroup, tweet) {
    // Protection contre les dates invalides
    if (!createdAt) {
      logger.warn(`⚠️ Date de création manquante pour le tweet ${tweet.id || 'inconnu'}`);
      return 0.5; // Valeur par défaut
    }
    
    const createdDate = new Date(createdAt);
    if (isNaN(createdDate.getTime())) {
      logger.warn(`⚠️ Date de création invalide pour le tweet ${tweet.id || 'inconnu'}: ${createdAt}`);
      return 0.5; // Valeur par défaut
    }
    
    const ageInHours = (Date.now() - createdDate.getTime()) / (1000 * 60 * 60);
    
    // Protection contre les âges négatifs ou invalides
    if (ageInHours < 0 || isNaN(ageInHours)) {
      logger.warn(`⚠️ Âge invalide pour le tweet ${tweet.id || 'inconnu'}: ${ageInHours} heures`);
      return 1.0; // Tweet très récent
    }
    
    // Décroissance de base
    let decayRate = this.timeDecay.base[tweetGroup] || this.timeDecay.base['initial'];
    
    // Appliquer les multiplicateurs de performance
    const performanceMultiplier = await this.calculatePerformanceMultiplier(tweet);
    decayRate = Math.pow(decayRate, 1 / performanceMultiplier);
    
    // Appliquer les facteurs de prolongation
    const extensionMultiplier = await this.calculateExtensionMultiplier(tweet);
    decayRate = Math.pow(decayRate, 1 / extensionMultiplier);
    
    // Vérifier la durée de vie maximale
    const maxLifespan = this.timeDecay.maxLifespan[tweetGroup] || this.timeDecay.maxLifespan['initial'];
    if (ageInHours > maxLifespan) {
      return 0.1; // Tweet expiré mais pas complètement
    }
    
    const timeDecayValue = Math.pow(decayRate, ageInHours);
    return Math.max(0.1, timeDecayValue); // Valeur minimale de 0.1
  }

  /**
   * Calcule le multiplicateur de performance
   */
  async calculatePerformanceMultiplier(tweet) {
    try {
      // Récupérer les stats d'engagement du tweet
      const engagementStats = await this.getTweetEngagementStats(tweet.id);
      
      if (!engagementStats) return 1.0;
      
      const { engagementRate, viralScore } = engagementStats;
      
      // Déterminer la performance
      if (engagementRate >= 0.6 || viralScore >= 20) {
        return this.timeDecay.performanceMultipliers.excellent;
      } else if (engagementRate >= 0.4 || viralScore >= 15) {
        return this.timeDecay.performanceMultipliers.good;
      } else if (engagementRate >= 0.2 || viralScore >= 10) {
        return this.timeDecay.performanceMultipliers.average;
      } else if (engagementRate >= 0.1 || viralScore >= 5) {
        return this.timeDecay.performanceMultipliers.poor;
      } else {
        return this.timeDecay.performanceMultipliers.terrible;
      }
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du multiplicateur de performance:', error);
      return 1.0;
    }
  }

  /**
   * Calcule le multiplicateur d'extension
   */
  async calculateExtensionMultiplier(tweet) {
    let multiplier = 1.0;
    
    try {
      // Bonus auteur vérifié
      if (tweet.author && tweet.author.verified) {
        multiplier *= this.timeDecay.extensionFactors.verified_author;
      }
      
      // Bonus auteur premium
      if (tweet.author && tweet.author.premium) {
        multiplier *= this.timeDecay.extensionFactors.premium_author;
      }
      
      // Bonus engagement élevé
      const engagementStats = await this.getTweetEngagementStats(tweet.id);
      if (engagementStats && engagementStats.engagementRate >= 0.3) {
        multiplier *= this.timeDecay.extensionFactors.high_engagement;
      }
      
      // Bonus sujet tendance (désactivé temporairement pour éviter les erreurs)
      // if (tweet.hashtags && tweet.hashtags.length > 0) {
      //   const trendingHashtags = await this.getTrendingHashtags();
      //   const trendingCount = tweet.hashtags.filter(tag => 
      //     trendingHashtags.includes(tag.toLowerCase())
      //   ).length;
      //   
      //   if (trendingCount >= 2) {
      //     multiplier *= this.timeDecay.extensionFactors.trending_topic;
      //   }
      // }
      
      // Bonus contenu viral
      if (engagementStats && engagementStats.viralScore >= 15) {
        multiplier *= this.timeDecay.extensionFactors.viral_content;
      }
      
      // Bonus favori communautaire (désactivé temporairement pour éviter les erreurs)
      // if (await this.isCommunityFavorite(tweet.id)) {
      //   multiplier *= this.timeDecay.extensionFactors.community_favorite;
      // }
      
      // Bonus contenu éducatif
      if (tweet.content && this.isEducationalContent(tweet.content)) {
        multiplier *= this.timeDecay.extensionFactors.educational_content;
      }
      

      
      // Bonus contenu d'actualité
      if (tweet.content && this.isNewsContent(tweet.content)) {
        multiplier *= this.timeDecay.extensionFactors.news_content;
      }
      
      // Bonus contenu original
      if (tweet.content && !this.isRetweet(tweet.content)) {
        multiplier *= this.timeDecay.extensionFactors.original_content;
      }
      
      // Bonus partage cross-platform (désactivé temporairement pour éviter les erreurs)
      // if (await this.hasCrossPlatformShare(tweet.id)) {
      //   multiplier *= this.timeDecay.extensionFactors.cross_platform_share;
      // }
      
      return Math.min(5.0, multiplier); // Limiter à 5x
      
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du multiplicateur d\'extension:', error);
      return 1.0;
    }
  }

  /**
   * Vérifie si le tweet est un favori communautaire
   */
  async isCommunityFavorite(tweetId) {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      const interactions = await UserBehaviorData.count({
        where: {
          target_id: tweetId,
          target_type: 'tweet',
          action_type: { [Op.in]: ['tweet_like', 'tweet_comment', 'tweet_retweet'] },
          timestamp: { [Op.gte]: oneDayAgo }
        }
      });
      
      return interactions >= 15; // Au moins 15 interactions en 24h
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification du favori communautaire:', error);
      return false;
    }
  }

  /**
   * Vérifie si le contenu est éducatif
   */
  isEducationalContent(content) {
    const educationalKeywords = [
      'tutorial', 'guide', 'apprendre', 'formation', 'conseil',
      'comment', 'pourquoi', 'explication', 'définition', 'méthode'
    ];
    
    return educationalKeywords.some(keyword => 
      content.toLowerCase().includes(keyword)
    );
  }

  /**
   * Vérifie si le contenu est d'actualité
   */
  isNewsContent(content) {
    const newsKeywords = [
      'actualité', 'news', 'breaking', 'urgent', 'important',
      'événement', 'crise', 'développement', 'mise à jour'
    ];
    
    return newsKeywords.some(keyword => 
      content.toLowerCase().includes(keyword)
    );
  }

  /**
   * Vérifie si c'est un retweet
   */
  isRetweet(content) {
    return content.startsWith('RT @') || content.startsWith('QT @');
  }

  /**
   * Vérifie si le tweet a été partagé cross-platform
   */
  async hasCrossPlatformShare(tweetId) {
    try {
      // Utiliser une requête SQL brute pour éviter les problèmes de type JSON vs JSONB
      const result = await UserBehaviorData.sequelize.query(
        `SELECT COUNT(*) as count FROM user_behavior_data 
         WHERE target_id = :tweetId 
         AND target_type = 'tweet' 
         AND action_type = 'tweet_share' 
         AND context_data::text LIKE '%"crossPlatform":true%'`,
        {
          replacements: { tweetId },
          type: UserBehaviorData.sequelize.QueryTypes.SELECT
        }
      );
      
      return result[0].count > 0;
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification du partage cross-platform:', error);
      return false;
    }
  }

  /**
   * Obtient les hashtags tendance
   */
  async getTrendingHashtags() {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      
      const trendingHashtags = await UserBehaviorData.findAll({
        where: {
          action_type: 'hashtag_click',
          timestamp: { [Op.gte]: oneHourAgo }
        },
        attributes: ['context_data'],
        limit: 20
      });
      
      const hashtagCounts = {};
      trendingHashtags.forEach(interaction => {
        if (interaction.context_data && interaction.context_data.hashtag) {
          const hashtag = interaction.context_data.hashtag.toLowerCase();
          hashtagCounts[hashtag] = (hashtagCounts[hashtag] || 0) + 1;
        }
      });
      
      return Object.keys(hashtagCounts)
        .sort((a, b) => hashtagCounts[b] - hashtagCounts[a])
        .slice(0, 10);
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des hashtags tendance:', error);
      return [];
    }
  }

  /**
   * Obtient les statistiques d'engagement d'un tweet
   */
  async getTweetEngagementStats(tweetId) {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      
      const interactions = await UserBehaviorData.findAll({
        where: {
          target_id: tweetId,
          target_type: 'tweet',
          timestamp: { [Op.gte]: oneHourAgo }
        }
      });
      
      const views = interactions.filter(i => i.action_type === 'tweet_view').length;
      const positiveInteractions = interactions.filter(i => {
        const score = this.getBaseScore(i.action_type);
        return score > 0;
      }).length;
      
      return {
        views,
        positiveInteractions,
        engagementRate: views > 0 ? positiveInteractions / views : 0,
        viralScore: positiveInteractions
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des stats d\'engagement:', error);
      return { views: 0, positiveInteractions: 0, engagementRate: 0, viralScore: 0 };
    }
  }

  /**
   * Obtient le score de base d'une interaction
   */
  getBaseScore(interactionType) {
    const baseScores = {
      'tweet_like': 1.0,
      'tweet_comment': 3.0,
      'tweet_retweet': 5.0,
      'tweet_share': 4.0,
      'tweet_view': 0.5,
      'tweet_bookmark': 2.5,
      'tweet_unlike': -1.0,
      'tweet_report': -10.0
    };
    
    return baseScores[interactionType] || 0;
  }

  /**
   * Calcule le score de similarité avec l'utilisateur
   */
  async calculateSimilarityScore(tweet, tweetGroup) {
    // Score de base selon le groupe
    let score = 0.5;
    
    // Bonus pour les tweets d'auteurs vérifiés
    if (tweet.author && tweet.author.verified) {
      score += 0.2;
    }
    
    // Bonus pour les tweets d'auteurs avec beaucoup de followers
    if (tweet.author && tweet.author.stats?.followers > 10000) {
      score += 0.1;
    }
    
    // Bonus pour les tweets récents
    const ageInHours = (Date.now() - new Date(tweet.createdAt)) / (1000 * 60 * 60);
    if (ageInHours < 1) {
      score += 0.3; // Très récent
    } else if (ageInHours < 6) {
      score += 0.2; // Récent
    } else if (ageInHours < 24) {
      score += 0.1; // Assez récent
    }
    
    return Math.min(1.0, score); // Score maximum de 1
  }

  /**
   * 🎯 Applique les filtres + limite de 2 tweets "initial" à 0 vues
   */
  async applyProgressiveFiltersWithInitialLimit(tweets, user) {
    logger.info(`🔍 Application des filtres progressifs + limite tweets initial 0 vues sur ${tweets.length} tweets pour ${user.username}`);
    
    // 1. D'abord séparer les tweets par catégorie
    const initialZeroViewsTweets = [];
    const otherTweets = [];
    
    tweets.forEach(tweet => {
      const isInitialZeroViews = (
        tweet.recommendation_group === 'initial' && 
        (tweet.view_count === 0 || tweet.view_count === null)
      );
      
      if (isInitialZeroViews) {
        initialZeroViewsTweets.push(tweet);
      } else {
        otherTweets.push(tweet);
      }
    });
    
    // 2. Limiter à 2 tweets "initial" à 0 vues maximum
    const maxInitialZeroViews = 2;
    const selectedInitialTweets = initialZeroViewsTweets
      .slice(0, maxInitialZeroViews)
      .map(tweet => ({ ...tweet, _isInitialZeroViews: true }));
    
    logger.info(`🎯 ${selectedInitialTweets.length} tweets "initial" à 0 vues sélectionnés (max ${maxInitialZeroViews})`);
    logger.info(`📊 ${initialZeroViewsTweets.length - selectedInitialTweets.length} tweets "initial" à 0 vues exclus par la limite`);
    
    // 3. Combiner avec les autres tweets
    const combinedTweets = [
      ...selectedInitialTweets,
      ...otherTweets
    ];
    
    // 4. Appliquer les filtres standards
    return this.applyStandardProgressiveFilters(combinedTweets, user);
  }

  /**
   * Applique les filtres de recommandation progressive standards
   */
  async applyStandardProgressiveFilters(tweets, user) {
    logger.info(`🔍 Application des filtres progressifs standards sur ${tweets.length} tweets pour ${user.username}`);
    
    let filteredCount = 0;
    let rejectedCount = 0;
    const rejectionReasons = {
      lowScore: 0,
      ownTweet: 0,
      lowViralScore: 0
    };

    const filteredTweets = tweets.filter(tweet => {
      // Filtrer les tweets avec un score trop faible
      if (tweet.progressiveScore < 0.1) {
        rejectionReasons.lowScore++;
        if (rejectedCount < 3) {
          logger.info(`❌ Tweet ${tweet.id} rejeté: score trop faible (${tweet.progressiveScore.toFixed(2)})`);
        }
        return false;
      }
      
      // Filtrer les tweets de l'utilisateur lui-même
      if (tweet.author_id === user.id) {
        rejectionReasons.ownTweet++;
        if (rejectedCount < 3) {
          logger.info(`❌ Tweet ${tweet.id} rejeté: tweet de l'utilisateur lui-même`);
        }
        return false;
      }
      
      // Filtrer les tweets avec un score viral trop faible
      if (tweet.viralScore < 0) {
        rejectionReasons.lowViralScore++;
        if (rejectedCount < 3) {
          logger.info(`❌ Tweet ${tweet.id} rejeté: score viral trop faible (${tweet.viralScore})`);
        }
        return false;
      }
      
      filteredCount++;
      if (filteredCount <= 5) {
        logger.info(`✅ Tweet ${tweet.id} accepté: score ${tweet.progressiveScore.toFixed(2)}, viral ${tweet.viralScore.toFixed(2)} par @${tweet.author?.username || 'unknown'}`);
      }
      
      return true;
    });

    logger.info(`📊 Résultat du filtrage:`, {
      total: tweets.length,
      acceptés: filteredCount,
      rejetés: rejectedCount,
      raisons: rejectionReasons
    });

    return filteredTweets;
  }

  /**
   * Vérifie si un tweet doit continuer à être recommandé après le groupe massif
   */
  async shouldContinueRecommendation(tweetId, currentLevel) {
    try {
      // Si le tweet est au niveau massif, vérifier s'il doit continuer
      if (currentLevel === 'massive') {
        const viralityStats = await this.getTweetViralityStats(tweetId);
        
        // Continuer si le tweet maintient un bon engagement
        const shouldContinue = viralityStats.positiveInteractions >= this.progressionThresholds.maintain_massive;
        
        if (shouldContinue) {
          logger.info(`🔄 Tweet ${tweetId} continue d'être recommandé au niveau massif`);
          return true;
        } else {
          logger.info(`⏹️ Tweet ${tweetId} arrêté - engagement insuffisant`);
          return false;
        }
      }
      
      return true; // Pour les autres niveaux, continuer normalement
      
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification de continuation:', error);
      return false;
    }
  }

  /**
   * Obtient les statistiques de viralité d'un tweet (méthode helper)
   */
  async getTweetViralityStats(tweetId) {
    // Cette méthode sera implémentée pour récupérer les stats depuis le ViralityTracker
    // Pour l'instant, retourner des stats par défaut
    return {
      positiveInteractions: 0,
      negativeInteractions: 0,
      totalScore: 0
    };
  }

  /**
   * Met à jour le score de viralité d'un tweet en temps réel
   */
  async updateTweetViralScore(tweetId, interactionType) {
    try {
      const score = this.interactionScores[interactionType] || 0;
      
      // Mettre à jour le cache si le tweet y est
      for (const [key, value] of this.cache.entries()) {
        if (key.includes('progressive_') && value.data.recommendations) {
          const tweet = value.data.recommendations.find(t => t.id === tweetId);
          if (tweet) {
            tweet.viralScore += score;
            tweet.progressiveScore = this.calculateProgressiveScores([tweet], 'initial')[0].progressiveScore;
          }
        }
      }
      
      logger.info(`📈 Score viral mis à jour pour le tweet ${tweetId}: +${score}`);
    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour du score viral:', error);
    }
  }

  /**
   * Nettoie le cache expiré
   */
  /**
   * 🎯 RÉCUPÉRER LES TWEETS ÉTABLIS (déjà en circulation)
   * Pour compléter la page avec des tweets qui ne sont plus en testing
   */
  async getEstablishedTweets(userId, limit, offset = 0) {
    try {
      if (limit <= 0) return [];

      // Récupérer les tweets établis (qui ont déjà été testés)
      const tweets = await Tweet.findAll({
        where: {
          deleted_at: null,
          moderation_status: 'approved',
          parent_tweet_id: null,
          progressive_testing_status: {
            [Op.in]: ['graduated', 'none'] // Tweets qui ont fini leur période de test
          },
          // Tweets plus anciens ou qui ont suffisamment de vues
          [Op.or]: [
            { view_count: { [Op.gte]: 10 } }, // Au moins 10 vues
            { created_at: { [Op.lt]: new Date(Date.now() - 24 * 60 * 60 * 1000) } } // Plus de 24h
          ]
        },
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'stats', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization']
          },
          {
            model: TweetLike,
            as: 'likes',
            attributes: ['id', 'user_id', 'created_at']
          },
          {
            model: TweetRetweet,
            as: 'retweets',
            attributes: ['id', 'user_id', 'created_at']
          }
        ],
        order: [
          ['view_count', 'DESC'],  // Tweets les plus vus
          ['created_at', 'DESC']   // Puis récents
        ],
        limit,
        offset
      });

      // Normaliser les objets Sequelize en objets JSON simples
      const normalizedTweets = tweets.map(tweet => {
        const tweetData = tweet.toJSON ? tweet.toJSON() : tweet;
        
        // S'assurer que l'ID est bien présent
        if (!tweetData.id) {
          logger.error('❌ Tweet établi sans ID:', { keys: Object.keys(tweetData) });
        }
        
        return tweetData;
      });

      logger.info(`📊 ${normalizedTweets.length} tweets établis récupérés (limite: ${limit}, offset: ${offset})`);
      return normalizedTweets;

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des tweets établis:', error);
      return [];
    }
  }

  /**
   * 🚀 AJOUT AUTOMATIQUE D'UN NOUVEAU TWEET À L'ALGORITHME PROGRESSIF
   * Méthode pour intégrer immédiatement un nouveau tweet dans le système
   */
  async addTweetToRecommendations(tweetId) {
    try {
      logger.info(`🚀 Ajout automatique du tweet ${tweetId} à l'algorithme progressif`);
      
      // Récupérer le tweet
      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet) {
        logger.error(`❌ Tweet ${tweetId} non trouvé pour l'ajout à l'algorithme`);
        return false;
      }
      
      // Mettre à jour le tweet avec les paramètres pour l'algorithme progressif
      await Tweet.update({
        recommendation_group: 'initial', // Démarrer dans le groupe initial
        view_count: 0, // Commencer à 0 vues
        algorithm_status: 'active', // Marquer comme actif dans l'algorithme
        algorithm_added_at: new Date()
      }, {
        where: { id: tweetId }
      });
      
      // Ajouter au tracker pour monitoring en temps réel
      this.tracker.updateTweetTracking(tweetId, {
        recommendation_group: 'initial',
        view_count: 0,
        created_at: tweet.created_at
      });
      
      // Nettoyer le cache pour forcer le rechargement
      const cacheKeys = Array.from(this.cache.keys());
      const progressiveCacheKeys = cacheKeys.filter(key => key.includes('progressive_'));
      progressiveCacheKeys.forEach(key => this.cache.delete(key));
      
      logger.info(`✅ Tweet ${tweetId} ajouté avec succès à l'algorithme progressif (groupe initial)`);
      return true;
      
    } catch (error) {
      logger.error(`❌ Erreur lors de l'ajout du tweet ${tweetId} à l'algorithme:`, error);
      return false;
    }
  }

  cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.cacheExpiry) {
        this.cache.delete(key);
      }
    }
    logger.info('🧹 Cache des recommandations progressives nettoyé');
  }
}

module.exports = ProgressiveRecommendationEngine;
