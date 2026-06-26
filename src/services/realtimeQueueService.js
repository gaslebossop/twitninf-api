const { sequelize, Notification, Tweet } = require('../models');
const logger = require('../utils/logger');
const TweetQueueService = require('./tweetQueueService');
const DynamicProgressionService = require('./dynamicProgressionService');
const SmartRecommendationEngine = require('./smartRecommendationEngine');

/**
 * 🚀 Service de mise à jour en temps réel de la tweet_queue
 * Met à jour les compteurs et évaluations à chaque interaction
 */
class RealtimeQueueService {
  constructor() {
    this.tweetQueueService = new TweetQueueService();
    this.progressionService = new DynamicProgressionService();
  }

  /**
   * 👁️ Mettre à jour les vues en temps réel (ajoute une vue)
   */
  async updateViewsRealtime(tweetId, userId, currentGroup = 'initial') {
    try {
      logger.info(`👁️ Mise à jour vues en temps réel pour tweet ${tweetId}`);

      // 🚫 VÉRIFICATION SHADOW BAN: Vérifier si le tweet est shadow banni
      const isShadowBanned = await this.checkTweetShadowBanStatus(tweetId);
      let shadowBanReduction = 1; // Valeur normale
      
      if (isShadowBanned) {
        shadowBanReduction = 0.3; // Réduction à 30% pour les tweets shadow bannés
        logger.info(`🚫 Tweet ${tweetId} shadow banni - mise à jour des vues avec réduction ${shadowBanReduction}`);
      }

      // 1. Mettre à jour tweet_queue (ajoute une vue avec réduction si shadow banni)
      await this.tweetQueueService.trackTweetView(tweetId, currentGroup, userId, shadowBanReduction);

      // 2. Recalculer les ratios et évaluations
      await this.recalculateRatiosAndEvaluations(tweetId);

      // 3. Vérifier si le tweet a atteint sa portée maximale
      await this.checkGroupCompletion(tweetId);

      // 4. Vérifier si le tweet doit changer de groupe
      await this.checkAndUpdateGroup(tweetId);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur mise à jour vues temps réel pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🔄 Synchroniser les vues existantes sans en ajouter (pour les tests et vérifications)
   */
  async syncViewsOnly(tweetId) {
    try {
      logger.info(`🔄 Synchronisation vues pour tweet ${tweetId}`);

      // 1. Recalculer les ratios et évaluations
      await this.recalculateRatiosAndEvaluations(tweetId);

      // 2. Vérifier si le tweet a atteint sa portée maximale
      await this.checkGroupCompletion(tweetId);

      // 3. Vérifier si le tweet doit changer de groupe
      await this.checkAndUpdateGroup(tweetId);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur synchronisation vues pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 💙 Mettre à jour les likes en temps réel
   */
  async updateLikesRealtime(tweetId, userId) {
    try {
      logger.info(`💙 Mise à jour likes en temps réel pour tweet ${tweetId}`);

      // 1. Mettre à jour tweet_queue
      await this.tweetQueueService.trackTweetInteraction(tweetId, 'like');

      // 2. Recalculer les ratios et évaluations
      await this.recalculateRatiosAndEvaluations(tweetId);

      // 3. Vérifier si le tweet doit changer de groupe
      await this.checkAndUpdateGroup(tweetId);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur mise à jour likes temps réel pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🔄 Mettre à jour les retweets en temps réel
   */
  async updateRetweetsRealtime(tweetId, userId) {
    try {
      logger.info(`🔄 Mise à jour retweets en temps réel pour tweet ${tweetId}`);

      // 1. Mettre à jour tweet_queue
      await this.tweetQueueService.trackTweetInteraction(tweetId, 'retweet');

      // 2. Recalculer les ratios et évaluations
      await this.recalculateRatiosAndEvaluations(tweetId);

      // 3. Vérifier si le tweet doit changer de groupe
      await this.checkAndUpdateGroup(tweetId);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur mise à jour retweets temps réel pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 💔 Retirer un retweet en temps réel
   */
  async decrementRetweetsRealtime(tweetId, userId) {
    try {
      logger.info(`🔄 Retrait retweet en temps réel pour tweet ${tweetId}`);

      // 1. Décrémenter dans tweet_queue
      await this.tweetQueueService.untrackTweetInteraction(tweetId, 'retweet');

      // 2. Recalculer les ratios et évaluations
      await this.recalculateRatiosAndEvaluations(tweetId);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur retrait retweet temps réel pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 💔 Retirer un like en temps réel
   */
  async decrementLikesRealtime(tweetId, userId) {
    try {
      logger.info(`💔 Retrait like en temps réel pour tweet ${tweetId}`);

      // 1. Décrémenter dans tweet_queue
      await this.tweetQueueService.untrackTweetInteraction(tweetId, 'like');

      // 2. Recalculer les ratios et évaluations
      await this.recalculateRatiosAndEvaluations(tweetId);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur retrait like temps réel pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 💬 Mettre à jour les replies en temps réel
   */
  async updateRepliesRealtime(tweetId, userId) {
    try {
      logger.info(`💬 Mise à jour replies en temps réel pour tweet ${tweetId}`);

      // 1. Mettre à jour tweet_queue
      await this.tweetQueueService.trackTweetInteraction(tweetId, 'reply');

      // 2. Recalculer les ratios et évaluations
      await this.recalculateRatiosAndEvaluations(tweetId);

      // 3. Vérifier si le tweet doit changer de groupe
      await this.checkAndUpdateGroup(tweetId);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur mise à jour replies temps réel pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 📊 Recalculer les ratios et évaluations d'un tweet
   */
  async recalculateRatiosAndEvaluations(tweetId) {
    try {
      // Récupérer les données actuelles de la queue
      const [queueData] = await sequelize.query(`
        SELECT 
          tq.*,
          t.created_at as tweet_created_at,
          t.recommendation_group
        FROM tweet_queue tq
        JOIN tweets t ON tq.tweet_id = t.id
        WHERE tq.tweet_id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (!queueData) {
        logger.warn(`⚠️ Tweet ${tweetId} non trouvé dans la queue`);
        return false;
      }

      // Calculer le ratio d'engagement
      const totalViews = queueData.total_views || 0;
      const totalLikes = queueData.total_likes || 0;
      const totalRetweets = queueData.total_retweets || 0;
      const totalReplies = queueData.total_replies || 0;

      const totalEngagement = totalLikes + totalRetweets + totalReplies;
      const engagementRatio = totalViews > 0 ? (totalEngagement / totalViews) : 0;

      // Calculer le score de performance
      const performanceScore = this.calculatePerformanceScore({
        views: totalViews,
        likes: totalLikes,
        retweets: totalRetweets,
        replies: totalReplies,
        engagementRatio,
        age: Date.now() - new Date(queueData.tweet_created_at).getTime()
      });

      // Mettre à jour la queue avec les nouveaux ratios
      await sequelize.query(`
        UPDATE tweet_queue 
        SET 
          current_ratio = :engagementRatio,
          last_evaluation_at = :timestamp,
          evaluation_count = evaluation_count + 1,
          processing_metadata = COALESCE(processing_metadata, '{}'::jsonb) || 
            jsonb_build_object(
              'last_evaluation', jsonb_build_object(
                'performance_score', :performanceScore,
                'engagement_ratio', :engagementRatio,
                'total_engagement', :totalEngagement,
                'timestamp', :timestamp
              )
            )
        WHERE tweet_id = :tweetId
      `, {
        replacements: {
          tweetId,
          engagementRatio: parseFloat(engagementRatio.toFixed(4)),
          performanceScore: parseFloat(performanceScore.toFixed(2)),
          totalEngagement,
          timestamp: new Date().toISOString()
        }
      });

      logger.info(`📊 Ratios recalculés pour tweet ${tweetId}: ratio=${engagementRatio.toFixed(4)}, score=${performanceScore.toFixed(2)}`);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur recalcul ratios pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🎯 Vérifier et mettre à jour le groupe d'un tweet
   */
  async checkAndUpdateGroup(tweetId) {
    try {
      // Récupérer les données actuelles
      const [queueData] = await sequelize.query(`
        SELECT 
          tq.*,
          t.created_at as tweet_created_at,
          t.recommendation_group
        FROM tweet_queue tq
        JOIN tweets t ON tq.tweet_id = t.id
        WHERE tq.tweet_id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (!queueData) return false;

      const currentGroup = queueData.current_group || 'initial';
      const totalViews = queueData.total_views || 0;
      const engagementRatio = queueData.current_ratio || 0;

      // Seuils de progression automatique par groupe
      const progressionThresholds = {
        'initial': { views: 5, ratio: 0.3 },      // 5 vues + 30% engagement → expansion
        'expansion': { views: 20, ratio: 0.4 },   // 20 vues + 40% engagement → viral
        'viral': { views: 100, ratio: 0.5 },      // 100 vues + 50% engagement → massive
        'massive': { views: 1000, ratio: 0.6 }    // 1000 vues + 60% engagement (max)
      };

      let newGroup = currentGroup;
      let shouldUpdate = false;

      // Progression automatique basée sur le groupe actuel
      if (currentGroup === 'initial' && totalViews >= progressionThresholds.initial.views && engagementRatio >= progressionThresholds.initial.ratio) {
        newGroup = 'expansion';
        shouldUpdate = true;
      } else if (currentGroup === 'expansion' && totalViews >= progressionThresholds.expansion.views && engagementRatio >= progressionThresholds.expansion.ratio) {
        newGroup = 'viral';
        shouldUpdate = true;
      } else if (currentGroup === 'viral' && totalViews >= progressionThresholds.viral.views && engagementRatio >= progressionThresholds.viral.ratio) {
        newGroup = 'massive';
        shouldUpdate = true;
      }

      // Mettre à jour si nécessaire
      if (shouldUpdate) {
        await sequelize.query(`
          UPDATE tweet_queue 
          SET 
            current_group = :newGroup,
            last_group_change_at = :timestamp,
            progression_history = COALESCE(progression_history, '[]'::jsonb) || 
              jsonb_build_array(
                jsonb_build_object(
                  'from_group', :currentGroup,
                  'to_group', :newGroup,
                  'views', :totalViews,
                  'ratio', :engagementRatio,
                  'timestamp', :timestamp
                )
              )
          WHERE tweet_id = :tweetId
        `, {
          replacements: {
            tweetId,
            newGroup,
            currentGroup,
            totalViews,
            engagementRatio,
            timestamp: new Date().toISOString()
          }
        });

        // Mettre à jour aussi la table tweets
        await sequelize.query(`
          UPDATE tweets 
          SET recommendation_group = :newGroup
          WHERE id = :tweetId
        `, {
          replacements: { tweetId, newGroup }
        });

        logger.info(`🎯 Tweet ${tweetId} promu de ${currentGroup} vers ${newGroup} (${totalViews} vues, ratio: ${parseFloat(engagementRatio).toFixed(4)})`);
        
        // Mettre à jour la portée selon le nouveau groupe
        await this.updateTweetReach(tweetId, newGroup);
        
        // Envoyer une notification à l'auteur du tweet
        await this.sendGroupChangeNotification(tweetId, currentGroup, newGroup, totalViews);
      }

      return shouldUpdate;
    } catch (error) {
      logger.error(`❌ Erreur vérification groupe pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🏆 Calculer le score de performance d'un tweet
   */
  calculatePerformanceScore({ views, likes, retweets, replies, engagementRatio, age }) {
    // Score de base basé sur l'engagement
    let score = (likes * 1) + (retweets * 3) + (replies * 2);
    
    // Bonus pour le ratio d'engagement
    if (engagementRatio > 0.1) score *= 1.5;
    else if (engagementRatio > 0.05) score *= 1.2;
    
    // Bonus pour la vitesse (plus le tweet est récent, plus c'est bon)
    const ageInHours = age / (1000 * 60 * 60);
    if (ageInHours < 1) score *= 2;
    else if (ageInHours < 6) score *= 1.5;
    else if (ageInHours < 24) score *= 1.2;
    
    // Normaliser le score
    return Math.min(score, 1000);
  }

  /**
   * 📊 Synchroniser toutes les interactions d'un tweet
   */
  async syncTweetInteractions(tweetId) {
    try {
      logger.info(`🔄 Synchronisation interactions pour tweet ${tweetId}`);

      // Récupérer les vraies interactions depuis la DB
      const [interactions] = await sequelize.query(`
        SELECT 
          (SELECT COUNT(*) FROM tweet_likes WHERE tweet_id = :tweetId) as likes,
          (SELECT COUNT(*) FROM tweet_retweets WHERE tweet_id = :tweetId) as retweets,
          (SELECT COUNT(*) FROM tweets WHERE parent_tweet_id = :tweetId) as replies,
          (SELECT view_count FROM tweets WHERE id = :tweetId) as views
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (!interactions) return false;

      // Mettre à jour la queue avec les vraies données
      await sequelize.query(`
        UPDATE tweet_queue 
        SET 
          total_likes = :likes,
          total_retweets = :retweets,
          total_replies = :replies,
          total_views = :views,
          last_evaluation_at = :timestamp
        WHERE tweet_id = :tweetId
      `, {
        replacements: {
          tweetId,
          likes: interactions.likes,
          retweets: interactions.retweets,
          replies: interactions.replies,
          views: interactions.views,
          timestamp: new Date().toISOString()
        }
      });

      // Recalculer les ratios
      await this.recalculateRatiosAndEvaluations(tweetId);

      logger.info(`✅ Interactions synchronisées pour tweet ${tweetId}: ${interactions.likes}L ${interactions.retweets}RT ${interactions.replies}R ${interactions.views}V`);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur synchronisation interactions pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 📈 Mettre à jour la portée d'un tweet selon son groupe
   */
  async updateTweetReach(tweetId, group) {
    try {
      // Définir la portée par groupe
      const reachByGroup = {
        'initial': 4,      // 10 personnes voient le tweet
        'expansion': 20,    // 50 personnes voient le tweet  
        'viral': 50,       // 200 personnes voient le tweet
        'massive': 500     // 1000 personnes voient le tweet
      };

      const targetReach = reachByGroup[group] || 10;

      // Mettre à jour la portée dans la queue
      await sequelize.query(`
        UPDATE tweet_queue 
        SET 
          processing_metadata = COALESCE(processing_metadata, '{}'::jsonb) || 
            jsonb_build_object(
              'target_reach', :targetReach,
              'reach_updated_at', :timestamp
            )
        WHERE tweet_id = :tweetId
      `, {
        replacements: {
          tweetId,
          targetReach,
          timestamp: new Date().toISOString()
        }
      });

      logger.info(`📈 Portée mise à jour pour tweet ${tweetId}: ${targetReach} personnes (groupe: ${group})`);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur mise à jour portée pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🎯 Vérifier si un tweet a atteint sa portée maximale pour son groupe
   */
  async checkGroupCompletion(tweetId) {
    try {
      // Récupérer les données actuelles du tweet
      const [queueData] = await sequelize.query(`
        SELECT 
          tq.current_group,
          tq.total_views,
          tq.current_ratio,
          tq.processing_metadata
        FROM tweet_queue tq
        WHERE tq.tweet_id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (!queueData) return false;

      const currentGroup = queueData.current_group || 'initial';
      const totalViews = queueData.total_views || 0;
      const engagementRatio = queueData.current_ratio || 0;

      // Portée maximale par groupe (limite stricte)
      const maxReachByGroup = {
        'initial': 4,      // 4 personnes max (limite stricte)
        'expansion': 20,   // 20 personnes max
        'viral': 50,       // 50 personnes max
        'massive': 500     // 500 personnes max
      };

      const maxReach = maxReachByGroup[currentGroup];
      
      // Vérifier si le tweet a atteint sa portée maximale
      if (totalViews >= maxReach) {
        logger.info(`🎯 Tweet ${tweetId} a atteint sa portée maximale: ${totalViews}/${maxReach} (groupe: ${currentGroup})`);
        
        // Pour le groupe initial, évaluation immédiate à 4 vues
        if (currentGroup === 'initial') {
          logger.info(`🔍 Évaluation immédiate pour groupe initial (4 vues atteintes)`);
          const shouldExtend = await this.evaluateTweetForExtension(tweetId, currentGroup, totalViews, engagementRatio);
          
          if (shouldExtend) {
            logger.info(`✅ Tweet ${tweetId} éligible pour extension vers expansion`);
            // La progression sera gérée par checkAndUpdateGroup
          } else {
            logger.info(`❌ Tweet ${tweetId} exclu de la promotion (ratio insuffisant: ${parseFloat(engagementRatio).toFixed(4)})`);
            await this.excludeTweetFromPromotion(tweetId, currentGroup, totalViews, engagementRatio);
          }
        } else {
          // Pour les autres groupes, évaluation normale
          const shouldExtend = await this.evaluateTweetForExtension(tweetId, currentGroup, totalViews, engagementRatio);
          
          if (shouldExtend) {
            logger.info(`✅ Tweet ${tweetId} éligible pour extension vers le groupe suivant`);
            // La progression sera gérée par checkAndUpdateGroup
          } else {
            logger.info(`❌ Tweet ${tweetId} exclu de la promotion (ratio insuffisant: ${parseFloat(engagementRatio).toFixed(4)})`);
            await this.excludeTweetFromPromotion(tweetId, currentGroup, totalViews, engagementRatio);
          }
        }
      }

      return true;
    } catch (error) {
      logger.error(`❌ Erreur vérification fin de groupe pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 📊 Évaluer si un tweet doit être étendu vers le groupe suivant
   */
  async evaluateTweetForExtension(tweetId, currentGroup, totalViews, engagementRatio) {
    try {
      // Seuils minimum pour l'extension
      const extensionThresholds = {
        'initial': { ratio: 0.3 },    // 30% d'engagement minimum pour expansion
        'expansion': { ratio: 0.4 },  // 40% d'engagement minimum pour viral
        'viral': { ratio: 0.5 },      // 50% d'engagement minimum pour massive
        'massive': { ratio: 0.6 }     // 60% d'engagement minimum (max atteint)
      };

      const threshold = extensionThresholds[currentGroup];
      
      if (!threshold) {
        logger.warn(`⚠️ Groupe ${currentGroup} non reconnu pour l'évaluation`);
        return false;
      }

      const shouldExtend = engagementRatio >= threshold.ratio;
      
      logger.info(`📊 Évaluation tweet ${tweetId}: ratio=${parseFloat(engagementRatio).toFixed(4)}, seuil=${threshold.ratio}, extension=${shouldExtend ? 'OUI' : 'NON'}`);
      
      return shouldExtend;
    } catch (error) {
      logger.error(`❌ Erreur évaluation extension pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🚫 Exclure un tweet de la promotion
   */
  async excludeTweetFromPromotion(tweetId, currentGroup, totalViews, engagementRatio) {
    try {
      // Marquer le tweet comme exclu
      await sequelize.query(`
        UPDATE tweet_queue 
        SET 
          current_group = 'excluded',
          processing_metadata = COALESCE(processing_metadata, '{}'::jsonb) || 
            jsonb_build_object(
              'exclusion_reason', 'insufficient_engagement',
              'exclusion_data', jsonb_build_object(
                'final_group', :currentGroup,
                'final_views', :totalViews,
                'final_ratio', :engagementRatio,
                'excluded_at', :timestamp
              )
            )
        WHERE tweet_id = :tweetId
      `, {
        replacements: {
          tweetId,
          currentGroup,
          totalViews,
          engagementRatio,
          timestamp: new Date().toISOString()
        }
      });

      // Mettre à jour le groupe dans la table tweets
      await sequelize.query(`
        UPDATE tweets 
        SET recommendation_group = 'excluded'
        WHERE id = :tweetId
      `, {
        replacements: { tweetId }
      });

      logger.info(`🚫 Tweet ${tweetId} exclu de la promotion (groupe final: ${currentGroup}, vues: ${totalViews}, ratio: ${parseFloat(engagementRatio).toFixed(4)})`);

      // Envoyer une notification à l'auteur du tweet
      await this.sendTweetExclusionNotification(tweetId, currentGroup, totalViews);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur exclusion tweet ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🔔 Envoyer une notification de changement de groupe
   */
  async sendGroupChangeNotification(tweetId, fromGroup, toGroup, totalViews) {
    try {
      // Récupérer l'auteur du tweet
      const tweet = await Tweet.findByPk(tweetId, {
        attributes: ['user_id', 'content'],
        include: [{
          model: sequelize.models.User,
          as: 'author',
          attributes: ['id', 'username']
        }]
      });

      if (!tweet || !tweet.author) {
        logger.warn(`⚠️ Auteur non trouvé pour le tweet ${tweetId}`);
        return false;
      }

      // Noms des groupes en français
      const groupNames = {
        'initial': 'initial',
        'expansion': 'expansion', 
        'viral': 'viral',
        'massive': 'massive'
      };

      const fromGroupName = groupNames[fromGroup] || fromGroup;
      const toGroupName = groupNames[toGroup] || toGroup;

      // Créer la notification
      await Notification.createNotification({
        recipient_id: tweet.user_id,
        sender_id: null, // Notification système
        tweet_id: tweetId,
        type: 'system',
        title: '🎯 Votre tweet progresse !',
        message: `Votre tweet est passé du groupe "${fromGroupName}" au groupe "${toGroupName}" (${totalViews} vues). Continue de créer du contenu sur TwitNin !`,
        _skip_push: false
      });

      logger.info(`🔔 Notification de progression envoyée à l'utilisateur ${tweet.user_id} pour le tweet ${tweetId}`);
      return true;

    } catch (error) {
      logger.error(`❌ Erreur envoi notification progression pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🔔 Envoyer une notification d'exclusion de tweet
   */
  async sendTweetExclusionNotification(tweetId, finalGroup, totalViews) {
    try {
      // Récupérer l'auteur du tweet
      const tweet = await Tweet.findByPk(tweetId, {
        attributes: ['user_id', 'content'],
        include: [{
          model: sequelize.models.User,
          as: 'author',
          attributes: ['id', 'username']
        }]
      });

      if (!tweet || !tweet.author) {
        logger.warn(`⚠️ Auteur non trouvé pour le tweet ${tweetId}`);
        return false;
      }

      // Noms des groupes en français
      const groupNames = {
        'initial': 'initial',
        'expansion': 'expansion',
        'viral': 'viral', 
        'massive': 'massive'
      };

      const finalGroupName = groupNames[finalGroup] || finalGroup;

      // Créer la notification
      await Notification.createNotification({
        recipient_id: tweet.user_id,
        sender_id: null, // Notification système
        tweet_id: tweetId,
        type: 'system',
        title: '📊 Votre tweet a terminé son cycle',
        message: `Votre tweet a terminé de faire des vues (${totalViews} vues, groupe "${finalGroupName}"). Il sera retiré des recommandations d'ici peu. Continue de créer sur TwitNin !`,
        _skip_push: false
      });

      logger.info(`🔔 Notification d'exclusion envoyée à l'utilisateur ${tweet.user_id} pour le tweet ${tweetId}`);
      return true;

    } catch (error) {
      logger.error(`❌ Erreur envoi notification exclusion pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🚫 Vérifier si un tweet est shadow banni
   */
  async checkTweetShadowBanStatus(tweetId) {
    try {
      // Récupérer l'auteur du tweet
      const [tweetData] = await sequelize.query(`
        SELECT user_id, progressive_testing_status 
        FROM tweets 
        WHERE id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (!tweetData) return false;

      // Vérifier si le tweet est déjà marqué comme exclu pour shadow ban
      if (tweetData.progressive_testing_status === 'excluded_shadowban') {
        return true;
      }

      // Vérifier le statut shadow ban de l'auteur
      const smartEngine = new SmartRecommendationEngine();
      const shadowBanStatus = await smartEngine.checkShadowbanStatus(tweetData.user_id);
      
      return shadowBanStatus.isShadowbanned;
    } catch (error) {
      logger.error(`❌ Erreur vérification shadow ban pour tweet ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🚫 Détecter et marquer le shadow ban en temps réel (sans exclusion)
   */
  async detectAndMarkShadowBan(tweetId, userId) {
    try {
      const smartEngine = new SmartRecommendationEngine();
      const shadowBanStatus = await smartEngine.checkShadowbanStatus(userId);
      
      if (shadowBanStatus.isShadowbanned) {
        logger.warn(`🚫 Shadow ban détecté pour utilisateur ${userId} (${shadowBanStatus.reason}) - priorité réduite`);
        
        // Marquer le tweet avec priorité réduite (pas d'exclusion)
        await sequelize.query(`
          UPDATE tweets 
          SET progressive_metadata = COALESCE(progressive_metadata, '{}'::jsonb) || 
                jsonb_build_object(
                  'shadow_ban_detected_at', :timestamp,
                  'shadow_ban_reason', :reason,
                  'shadow_ban_details', :details::jsonb,
                  'priority_reduced', true
                )
          WHERE id = :tweetId
        `, {
          replacements: {
            tweetId,
            timestamp: new Date().toISOString(),
            reason: shadowBanStatus.reason,
            details: JSON.stringify(shadowBanStatus)
          }
        });

        // Marquer dans la queue avec priorité réduite
        await sequelize.query(`
          UPDATE tweet_queue 
          SET processing_metadata = COALESCE(processing_metadata, '{}'::jsonb) || 
                jsonb_build_object(
                  'shadow_ban_detected_at', :timestamp,
                  'shadow_ban_reason', :reason,
                  'shadow_banned', true,
                  'priority', 'low'
                )
          WHERE tweet_id = :tweetId
        `, {
          replacements: {
            tweetId,
            timestamp: new Date().toISOString(),
            reason: shadowBanStatus.reason
          }
        });

        // Envoyer une notification à l'utilisateur
        await this.sendShadowBanNotification(userId, shadowBanStatus.reason);
        
        return true;
      }
      
      return false;
    } catch (error) {
      logger.error(`❌ Erreur détection shadow ban pour ${userId}:`, error);
      return false;
    }
  }

  /**
   * 🔔 Envoyer une notification de shadow ban
   */
  async sendShadowBanNotification(userId, reason) {
    try {
      let title, message;
      
      if (reason === 'spam_detection') {
        title = '⚠️ Fréquence de publication élevée';
        message = 'Vous publiez beaucoup de tweets récemment. Vos tweets auront une priorité réduite dans les recommandations. Réduisez votre fréquence pour retrouver une priorité normale.';
      } else if (reason === 'low_quality_content') {
        title = '📉 Qualité de contenu à améliorer';
        message = 'Vos tweets récents ont une qualité d\'engagement faible. Ils auront une priorité réduite. Améliorez la qualité de votre contenu pour retrouver une visibilité normale.';
      } else {
        title = '⚠️ Priorité réduite temporairement';
        message = 'Vos tweets auront une priorité réduite dans les recommandations. Continuez de créer du contenu de qualité pour retrouver une visibilité normale.';
      }

      await Notification.createNotification({
        recipient_id: userId,
        sender_id: null, // Notification système
        tweet_id: null,
        type: 'system',
        title,
        message,
        _skip_push: false
      });

      logger.info(`🔔 Notification shadow ban envoyée à l'utilisateur ${userId}`);
      return true;

    } catch (error) {
      logger.error(`❌ Erreur envoi notification shadow ban pour ${userId}:`, error);
      return false;
    }
  }

  /**
   * 🔄 Vérifier et récupérer automatiquement les utilisateurs shadow bannés
   */
  async checkAndRecoverShadowBannedUsers() {
    try {
      logger.info('🔄 Vérification de la récupération des utilisateurs shadow bannés...');

      // Récupérer tous les tweets marqués comme shadow bannés
      const shadowBannedTweets = await sequelize.query(`
        SELECT 
          t.id as tweet_id,
          t.user_id,
          t.progressive_metadata,
          tq.queue_status
        FROM tweets t
        LEFT JOIN tweet_queue tq ON t.id = tq.tweet_id
        WHERE t.progressive_testing_status = 'excluded_shadowban'
        AND t.created_at > NOW() - INTERVAL '7 days'
      `, {
        type: sequelize.QueryTypes.SELECT
      });

      if (shadowBannedTweets.length === 0) {
        logger.info('ℹ️ Aucun tweet shadow banni trouvé pour récupération');
        return { recovered: 0, total: 0 };
      }

      let recoveredCount = 0;
      const smartEngine = new SmartRecommendationEngine();

      for (const tweet of shadowBannedTweets) {
        try {
          // Vérifier si l'utilisateur est toujours shadow banni
          const shadowBanStatus = await smartEngine.checkShadowbanStatus(tweet.user_id);
          
          if (!shadowBanStatus.isShadowbanned) {
            // L'utilisateur n'est plus shadow banni, récupérer le tweet
            await this.recoverTweetFromShadowBan(tweet.tweet_id, tweet.user_id);
            recoveredCount++;
            logger.info(`✅ Tweet ${tweet.tweet_id} récupéré du shadow ban`);
          }
        } catch (error) {
          logger.error(`❌ Erreur récupération tweet ${tweet.tweet_id}:`, error);
        }
      }

      logger.info(`🔄 Récupération terminée: ${recoveredCount}/${shadowBannedTweets.length} tweets récupérés`);
      return { recovered: recoveredCount, total: shadowBannedTweets.length };

    } catch (error) {
      logger.error('❌ Erreur vérification récupération shadow ban:', error);
      return { recovered: 0, total: 0 };
    }
  }

  /**
   * 🔄 Récupérer un tweet du shadow ban
   */
  async recoverTweetFromShadowBan(tweetId, userId) {
    try {
      // Remettre le tweet en statut normal
      await sequelize.query(`
        UPDATE tweets 
        SET progressive_testing_status = 'testing',
            recommendation_group = 'initial',
            progressive_metadata = COALESCE(progressive_metadata, '{}'::jsonb) || 
              jsonb_build_object(
                'recovered_from_shadow_ban_at', :timestamp,
                'recovery_reason', 'shadow_ban_expired'
              )
        WHERE id = :tweetId
      `, {
        replacements: {
          tweetId,
          timestamp: new Date().toISOString()
        }
      });

      // Remettre le tweet dans la queue s'il n'y est pas
      await sequelize.query(`
        UPDATE tweet_queue 
        SET queue_status = 'approved',
            processing_metadata = COALESCE(processing_metadata, '{}'::jsonb) || 
              jsonb_build_object(
                'recovered_from_shadow_ban_at', :timestamp,
                'recovery_reason', 'shadow_ban_expired'
              )
        WHERE tweet_id = :tweetId
      `, {
        replacements: {
          tweetId,
          timestamp: new Date().toISOString()
        }
      });

      // Si le tweet n'est pas dans la queue, l'y ajouter
      const [existingQueue] = await sequelize.query(`
        SELECT id FROM tweet_queue WHERE tweet_id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (!existingQueue) {
        const tweetQueueService = new TweetQueueService();
        await tweetQueueService.addTweetToQueue(tweetId, userId);
        await tweetQueueService.approveTweetFromQueue(tweetId, {
          recovery_from_shadow_ban: true,
          recovered_at: new Date().toISOString()
        });
      }

      // Envoyer une notification de récupération
      await this.sendShadowBanRecoveryNotification(userId);

      logger.info(`✅ Tweet ${tweetId} récupéré du shadow ban avec succès`);
      return true;

    } catch (error) {
      logger.error(`❌ Erreur récupération tweet ${tweetId} du shadow ban:`, error);
      return false;
    }
  }

  /**
   * 🔔 Envoyer une notification de récupération du shadow ban
   */
  async sendShadowBanRecoveryNotification(userId) {
    try {
      await Notification.createNotification({
        recipient_id: userId,
        sender_id: null, // Notification système
        tweet_id: null,
        type: 'system',
        title: '✅ Priorité restaurée !',
        message: 'Vos tweets ont retrouvé une priorité normale dans les recommandations. Continuez de créer du contenu de qualité !',
        _skip_push: false
      });

      logger.info(`🔔 Notification de récupération envoyée à l'utilisateur ${userId}`);
      return true;

    } catch (error) {
      logger.error(`❌ Erreur envoi notification récupération pour ${userId}:`, error);
      return false;
    }
  }
}

module.exports = RealtimeQueueService;
