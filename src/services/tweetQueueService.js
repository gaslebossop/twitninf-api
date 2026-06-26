const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { sequelize } = require('../database');
const DynamicProgressionService = require('./dynamicProgressionService');
const SmartRecommendationEngine = require('./smartRecommendationEngine');

/**
 * 🎯 SERVICE DE QUEUE POUR TWEETS À TRAITER
 * 
 * Système propre et contrôlé pour traiter les nouveaux tweets :
 * 1. Les nouveaux tweets vont dans la queue
 * 2. Une fois approuvés, ils passent en statut 'testing' 
 * 3. Maximum 2 tweets à tester par page
 */
class TweetQueueService {
  constructor() {
    this.initialized = false;
    this.cutoffDate = new Date(); // Date de démarrage du nouveau système
    
    // Service de progression dynamique
    this.progressionService = new DynamicProgressionService();
    
    logger.info(`🎯 TweetQueueService initialisé - Date de coupure: ${this.cutoffDate.toISOString()}`);
  }

  /**
   * Ajouter un nouveau tweet à la queue (SEULEMENT les nouveaux tweets)
   * Les tweets de réponse (avec parent_tweet_id) ne sont PAS ajoutés à la queue
   * Les utilisateurs shadow bannés sont exclus de la queue
   */
  async addTweetToQueue(tweetId, userId) {
    try {
      logger.info(`📥 Ajout du tweet ${tweetId} à la queue de traitement`);

      // Vérifier que le tweet existe et récupérer ses informations
      const [tweet] = await sequelize.query(`
        SELECT id, created_at, parent_tweet_id FROM tweets WHERE id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (!tweet) {
        logger.error(`❌ Tweet ${tweetId} non trouvé pour ajout à la queue`);
        return false;
      }

      // Vérifier si c'est un tweet de réponse
      if (tweet.parent_tweet_id) {
        logger.info(`💬 Tweet ${tweetId} est une réponse (parent: ${tweet.parent_tweet_id}) - exclu de la queue`);
        return false;
      }

      // 🚫 VÉRIFICATION SHADOW BAN: Vérifier si l'utilisateur est shadow banni
      let isShadowBanned = false;
      let shadowBanReason = null;
      try {
        const smartEngine = new SmartRecommendationEngine();
        const shadowBanStatus = await smartEngine.checkShadowbanStatus(userId);
        
        if (shadowBanStatus.isShadowbanned) {
          isShadowBanned = true;
          shadowBanReason = shadowBanStatus.reason;
          logger.info(`🚫 Utilisateur ${userId} shadow banni (${shadowBanStatus.reason}) - tweet ${tweetId} ajouté avec priorité réduite`);
        }
      } catch (shadowBanError) {
        logger.error(`❌ Erreur lors de la vérification shadow ban pour ${userId}:`, shadowBanError);
        // Continue même en cas d'erreur de vérification shadow ban
      }

      // Vérifier que le tweet est créé après la date de coupure
      // Date de coupure supprimée - tous les nouveaux tweets sont acceptés
      // if (new Date(tweet.created_at) < this.cutoffDate) {
      //   logger.info(`⏭️ Tweet ${tweetId} créé avant la date de coupure - ignoré`);
      //   return false;
      // }

      // Déterminer la priorité basée sur le shadow ban
      const priority = isShadowBanned ? 'low' : 'normal';
      
      // Ajouter à la queue (PostgreSQL) avec priorité
      await sequelize.query(`
        INSERT INTO tweet_queue (id, tweet_id, user_id, queue_status, queued_at, processing_metadata)
        VALUES (:id, :tweetId, :userId, 'pending', NOW(), :metadata::jsonb)
        ON CONFLICT (tweet_id) DO UPDATE SET
        queue_status = 'pending', 
        queued_at = NOW(),
        processing_metadata = :metadata::jsonb
      `, {
        replacements: {
          id: uuidv4(),
          tweetId,
          userId,
          metadata: JSON.stringify({
            priority,
            shadow_banned: isShadowBanned,
            shadow_ban_reason: shadowBanReason,
            queued_at: new Date().toISOString()
          })
        }
      });

      // Marquer le tweet comme mis en queue (PostgreSQL)
      await sequelize.query(`
        UPDATE tweets 
        SET progressive_testing_status = 'queued',
            progressive_metadata = jsonb_build_object('queued_at', NOW())
        WHERE id = :tweetId
      `, {
        replacements: { tweetId }
      });

      logger.info(`✅ Tweet ${tweetId} ajouté à la queue avec succès`);
      return true;

    } catch (error) {
      logger.error(`❌ Erreur lors de l'ajout du tweet ${tweetId} à la queue:`, error);
      return false;
    }
  }

  /**
   * Approuver un tweet de la queue et le faire passer en mode testing
   */
  async approveTweetFromQueue(tweetId, moderationResult = {}) {
    try {
      logger.info(`✅ Approbation du tweet ${tweetId} pour l'algorithme progressif`);

      // Mettre à jour la queue
      await sequelize.query(`
        UPDATE tweet_queue 
        SET queue_status = 'approved',
            processed_at = NOW(),
            approved_at = NOW(),
            processing_metadata = :metadata
        WHERE tweet_id = :tweetId
      `, {
        replacements: {
          tweetId,
          metadata: JSON.stringify(moderationResult)
        }
      });

      // Faire passer le tweet en mode testing dans l'algorithme progressif (PostgreSQL)
      await sequelize.query(`
        UPDATE tweets 
        SET progressive_testing_status = 'testing',
            recommendation_group = 'initial',
            view_count = COALESCE(view_count, 0),
            progressive_added_at = NOW(),
            progressive_metadata = jsonb_build_object(
              'approved_at', NOW(),
              'status', 'testing',
              'group', 'initial',
              'moderation_result', :moderationResult::jsonb
            )
        WHERE id = :tweetId
      `, {
        replacements: {
          tweetId,
          moderationResult: JSON.stringify(moderationResult)
        }
      });

      logger.info(`🚀 Tweet ${tweetId} maintenant en mode testing dans l'algorithme progressif`);
      return true;

    } catch (error) {
      logger.error(`❌ Erreur lors de l'approbation du tweet ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * Rejeter un tweet de la queue
   */
  async rejectTweetFromQueue(tweetId, reason = 'Modération') {
    try {
      logger.info(`❌ Rejet du tweet ${tweetId} de la queue: ${reason}`);

      // Mettre à jour la queue
      await sequelize.query(`
        UPDATE tweet_queue 
        SET queue_status = 'rejected',
            processed_at = NOW(),
            rejection_reason = :reason
        WHERE tweet_id = :tweetId
      `, {
        replacements: { tweetId, reason }
      });

      // Marquer le tweet comme exclu (PostgreSQL)
      await sequelize.query(`
        UPDATE tweets 
        SET progressive_testing_status = 'excluded',
            progressive_metadata = jsonb_build_object(
              'rejected_at', NOW(),
              'reason', :reason
            )
        WHERE id = :tweetId
      `, {
        replacements: { tweetId, reason }
      });

      logger.info(`🚫 Tweet ${tweetId} rejeté et exclu de l'algorithme progressif`);
      return true;

    } catch (error) {
      logger.error(`❌ Erreur lors du rejet du tweet ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🎯 Récupère TOUS les tweets actifs de la queue (pas d'exclus)
   */
  async getAllActiveQueueTweets(limit = 2000) {
    try {
      const activeTweets = await sequelize.query(`
        SELECT 
          t.*, 
          u.id as author_id,
          u.username, 
          u.full_name, 
          u.avatar,
          u.verified,
          u.premium,
          tq.current_group,
          tq.total_views,
          tq.total_likes,
          tq.total_retweets,
          tq.total_replies,
          tq.group_views_initial,
          tq.group_views_expansion,
          tq.group_views_viral,
          tq.group_views_massive,
          tq.current_ratio
        FROM tweet_queue tq
        LEFT JOIN tweets t ON tq.tweet_id = t.id
        LEFT JOIN users u ON t.user_id = u.id
        WHERE tq.queue_status = 'approved'
        AND t.progressive_testing_status = 'testing'
        AND tq.current_group != 'exclude'
        AND t.deleted_at IS NULL
        ORDER BY 
          CASE tq.current_group
            WHEN 'initial' THEN 1
            WHEN 'expansion' THEN 2  
            WHEN 'viral' THEN 3
            WHEN 'massive' THEN 4
            ELSE 5
          END,
          tq.current_ratio DESC,
          t.created_at DESC
        LIMIT :limit
      `, {
        replacements: { limit },
        type: sequelize.QueryTypes.SELECT
      });

      // Marquer comme venant de la queue et formater les données utilisateur
      const validTweets = activeTweets.filter(tweet => {
        if (!tweet.id) {
          logger.error('❌ Tweet de la queue sans ID:', { keys: Object.keys(tweet) });
          return false;
        }
        
        // Utiliser current_group de la queue au lieu de recommendation_group
        tweet.recommendation_group = tweet.current_group;
        tweet._isFromQueue = true;
        
        // 🔧 FORMATER LES DONNÉES UTILISATEUR COMME LES AUTRES ALGORITHMES
        if (tweet.author_id) {
          tweet.author = {
            id: tweet.author_id,
            username: tweet.username,
            full_name: tweet.full_name,
            avatar: tweet.avatar,
            verified: tweet.verified,
            premium: tweet.premium
          };
          
          // Nettoyer les champs utilisateur dupliqués
          delete tweet.author_id;
          delete tweet.username;
          delete tweet.full_name;
          delete tweet.avatar;
          delete tweet.verified;
          delete tweet.premium;
        } else {
          logger.warn(`⚠️ Tweet ${tweet.id} sans données utilisateur dans la queue`);
        }
        
        return true;
      });

      logger.info(`📊 ${validTweets.length} tweets actifs récupérés de la queue (limit: ${limit})`);
      return validTweets;

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des tweets actifs de la queue:', error);
      return [];
    }
  }

  /**
   * Récupérer les tweets en testing (pour les recommandations)
   * LIMITE À 2 TWEETS PAR PAGE MAXIMUM
   */
  async getTestingTweets(limit = 10, offset = 0) {
    try {
      // Maximum 2 tweets à tester par page
      const maxTestingTweets = 2;
      
      const testingTweets = await sequelize.query(`
        SELECT t.*, u.username, u.full_name, u.avatar
        FROM tweets t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE t.progressive_testing_status = 'testing'
        AND t.deleted_at IS NULL
        ORDER BY t.progressive_added_at DESC
        LIMIT :limit OFFSET :offset
      `, {
        replacements: {
          limit: maxTestingTweets,
          offset: 0 // Toujours commencer à 0 pour les tweets à tester
        },
        type: sequelize.QueryTypes.SELECT
      });

      // Marquer les tweets comme venant de la queue et vérifier leur ID
      const validTweets = testingTweets.filter(tweet => {
        if (!tweet.id) {
          logger.error('❌ Tweet de la queue sans ID:', { keys: Object.keys(tweet) });
          return false;
        }
        // Marquer comme venant de la queue
        tweet._isFromQueue = true;
        return true;
      });

      logger.info(`📊 ${validTweets.length} tweets en testing récupérés (max ${maxTestingTweets} par page)`);
      return validTweets;

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des tweets en testing:', error);
      return [];
    }
  }

  /**
   * 👁️ Tracker une vue pour un tweet avec son groupe
   */
  async trackTweetView(tweetId, currentGroup, userId, shadowBanReduction = 1) {
    try {
      // 1. Mettre à jour les compteurs dans tweet_queue avec réduction pour shadow ban
      const groupColumn = `group_views_${currentGroup}`;
      
      await sequelize.query(`
        UPDATE tweet_queue 
        SET 
          ${groupColumn} = COALESCE(${groupColumn}, 0) + :shadowBanReduction,
          total_views = COALESCE(total_views, 0) + :shadowBanReduction,
          processing_metadata = COALESCE(processing_metadata, '{}'::jsonb) || 
            jsonb_build_object(
              'last_view', jsonb_build_object(
                'user_id', :userId,
                'group', :currentGroup,
                'timestamp', :timestamp,
                'shadow_ban_reduction', :shadowBanReduction
              )
            )
        WHERE tweet_id = :tweetId
      `, {
        replacements: {
          tweetId,
          currentGroup,
          userId,
          shadowBanReduction,
          timestamp: new Date().toISOString()
        }
      });

      // 2. Synchroniser view_count dans tweets
      await sequelize.query(`
        UPDATE tweets 
        SET view_count = (
          SELECT total_views FROM tweet_queue WHERE tweet_id = :tweetId
        )
        WHERE id = :tweetId
      `, {
        replacements: { tweetId }
      });

      // 3. Traiter la progression si nécessaire
      await this.progressionService.processTweetProgression(tweetId);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur tracking vue pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 💙 Tracker une interaction (like, retweet, reply)
   */
  async trackTweetInteraction(tweetId, interactionType) {
    try {
      const columnMap = {
        'like': 'total_likes',
        'retweet': 'total_retweets', 
        'reply': 'total_replies'
      };

      const column = columnMap[interactionType];
      if (!column) {
        logger.error(`❌ Type d'interaction invalide: ${interactionType}`);
        return false;
      }

      // Mettre à jour le compteur dans tweet_queue
      await sequelize.query(`
        UPDATE tweet_queue 
        SET ${column} = COALESCE(${column}, 0) + 1
        WHERE tweet_id = :tweetId
      `, {
        replacements: { tweetId }
      });

      logger.info(`📊 Interaction ${interactionType} trackée pour tweet ${tweetId}`);

      // Traiter la progression après interaction
      await this.progressionService.processTweetProgression(tweetId);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur tracking interaction ${interactionType} pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 💔 Dé-tracker une interaction (unlike, unretweet)
   */
  async untrackTweetInteraction(tweetId, interactionType) {
    try {
      const columnMap = {
        'like': 'total_likes',
        'retweet': 'total_retweets',
        'reply': 'total_replies'
      };

      const column = columnMap[interactionType];
      if (!column) return false;

      // Décrémenter le compteur (minimum 0)
      await sequelize.query(`
        UPDATE tweet_queue 
        SET ${column} = GREATEST(0, COALESCE(${column}, 0) - 1)
        WHERE tweet_id = :tweetId
      `, {
        replacements: { tweetId }
      });

      logger.info(`📊 Interaction ${interactionType} retirée pour tweet ${tweetId}`);

      // Recalculer la progression
      await this.progressionService.processTweetProgression(tweetId);

      return true;
    } catch (error) {
      logger.error(`❌ Erreur untracking interaction ${interactionType} pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 📊 Synchronise les interactions depuis la DB vers la queue
   */
  async syncInteractionsToQueue(tweetId) {
    try {
      const [interactions] = await sequelize.query(`
        SELECT 
          COUNT(DISTINCT tl.id) as likes,
          COUNT(DISTINCT tr.id) as retweets,
          COUNT(DISTINCT replies.id) as replies
        FROM tweets t
        LEFT JOIN tweet_likes tl ON t.id = tl.tweet_id
        LEFT JOIN tweet_retweets tr ON t.id = tr.tweet_id
        LEFT JOIN tweets replies ON t.id = replies.parent_tweet_id
        WHERE t.id = :tweetId
        GROUP BY t.id
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (interactions.length > 0) {
        const stats = interactions[0];
        
        await sequelize.query(`
          UPDATE tweet_queue 
          SET 
            total_likes = :likes,
            total_retweets = :retweets,
            total_replies = :replies
          WHERE tweet_id = :tweetId
        `, {
          replacements: {
            tweetId,
            likes: parseInt(stats.likes),
            retweets: parseInt(stats.retweets),
            replies: parseInt(stats.replies)
          }
        });

        logger.info(`🔄 Interactions synchronisées pour tweet ${tweetId}`);
      }

      return true;
    } catch (error) {
      logger.error(`❌ Erreur sync interactions pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 🔄 Traite toutes les progressions automatiques
   */
  async processAllProgressions() {
    try {
      return await this.progressionService.processAllActiveProgressions();
    } catch (error) {
      logger.error('❌ Erreur traitement progressions:', error);
      return { processed: 0, updated: 0 };
    }
  }

  /**
   * 📊 Obtient les stats de progression
   */
  async getProgressionStats() {
    try {
      return await this.progressionService.getProgressionStats();
    } catch (error) {
      logger.error('❌ Erreur récupération stats progression:', error);
      return [];
    }
  }

  /**
   * 📦 Importe tous les tweets existants (>25 vues) dans la queue
   */
  async importExistingTweets() {
    try {
      logger.info('📦 Import des tweets existants dans la queue...');

      // Récupérer tous les tweets avec plus de 25 vues qui ne sont pas dans la queue
      const [existingTweets] = await sequelize.query(`
        SELECT t.id, t.user_id, t.view_count, t.recommendation_group, t.created_at
        FROM tweets t
        LEFT JOIN tweet_queue tq ON t.id = tq.tweet_id
        WHERE t.view_count > 25
        AND t.deleted_at IS NULL
        AND t.moderation_status = 'approved'
        AND tq.tweet_id IS NULL
        ORDER BY t.view_count DESC
      `);

      let imported = 0;
      let failed = 0;

      for (const tweet of existingTweets) {
        try {
          // Ajouter à la queue avec statut approuvé
          const queueId = uuidv4();
          
          // Déterminer le groupe basé sur les vues
          let currentGroup = 'massive'; // Par défaut massive pour tweets > 25 vues
          if (tweet.view_count < 50) currentGroup = 'viral';
          if (tweet.view_count < 20) currentGroup = 'expansion';
          if (tweet.view_count < 10) currentGroup = 'initial';

          await sequelize.query(`
            INSERT INTO tweet_queue (
              id, tweet_id, user_id, queue_status, queued_at, approved_at,
              current_group, total_views, group_views_initial, group_views_expansion,
              group_views_viral, group_views_massive
            ) VALUES (
              :queueId, :tweetId, :userId, 'approved', :createdAt, :createdAt,
              :currentGroup, :totalViews, 
              CASE WHEN :currentGroup = 'initial' THEN :totalViews ELSE 0 END,
              CASE WHEN :currentGroup = 'expansion' THEN :totalViews ELSE 0 END,
              CASE WHEN :currentGroup = 'viral' THEN :totalViews ELSE 0 END,
              CASE WHEN :currentGroup = 'massive' THEN :totalViews ELSE 0 END
            )
          `, {
            replacements: {
              queueId,
              tweetId: tweet.id,
              userId: tweet.user_id,
              createdAt: tweet.created_at,
              currentGroup,
              totalViews: tweet.view_count
            }
          });

          // Synchroniser les interactions
          await this.syncInteractionsToQueue(tweet.id);

          // Mettre à jour le tweet
          await sequelize.query(`
            UPDATE tweets 
            SET 
              progressive_testing_status = 'testing',
              recommendation_group = :currentGroup
            WHERE id = :tweetId
          `, {
            replacements: {
              tweetId: tweet.id,
              currentGroup
            }
          });

          imported++;
          
          if (imported % 10 === 0) {
            logger.info(`📊 ${imported} tweets importés...`);
          }

        } catch (error) {
          logger.error(`❌ Erreur import tweet ${tweet.id}:`, error.message);
          failed++;
        }
      }

      logger.info(`✅ Import terminé: ${imported} tweets importés, ${failed} échecs`);
      return { imported, failed, total: existingTweets.length };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'import des tweets existants:', error);
      return { imported: 0, failed: 0, total: 0 };
    }
  }

  /**
   * Statistiques de la queue
   */
  async getQueueStats() {
    try {
      const [stats] = await sequelize.query(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN queue_status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN queue_status = 'approved' THEN 1 ELSE 0 END) as approved,
          SUM(CASE WHEN queue_status = 'rejected' THEN 1 ELSE 0 END) as rejected,
          SUM(CASE WHEN queue_status = 'processing' THEN 1 ELSE 0 END) as processing
        FROM tweet_queue
        WHERE queued_at >= :cutoffDate
      `, {
        replacements: { cutoffDate: this.cutoffDate.toISOString() },
        type: sequelize.QueryTypes.SELECT
      });

      const [testingStats] = await sequelize.query(`
        SELECT 
          COUNT(*) as total_testing,
          AVG(view_count) as avg_views,
          MAX(view_count) as max_views
        FROM tweets
        WHERE progressive_testing_status = 'testing'
        AND progressive_added_at >= :cutoffDate
      `, {
        replacements: { cutoffDate: this.cutoffDate.toISOString() },
        type: sequelize.QueryTypes.SELECT
      });

      return {
        queue: stats,
        testing: testingStats[0],
        cutoffDate: this.cutoffDate.toISOString()
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des statistiques:', error);
      return null;
    }
  }

  /**
   * Nettoyer la queue (tweets trop anciens)
   */
  async cleanupQueue() {
    try {
      const cutoffAge = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 jours

      const [result] = await sequelize.query(`
        DELETE FROM tweet_queue 
        WHERE (queue_status = 'rejected' OR queue_status = 'approved')
        AND processed_at < :cutoffAge
      `, {
        replacements: { cutoffAge: cutoffAge.toISOString() }
      });

      logger.info(`🧹 ${result.affectedRows || 0} entrées nettoyées de la queue`);
      return true;

    } catch (error) {
      logger.error('❌ Erreur lors du nettoyage de la queue:', error);
      return false;
    }
  }

  /**
   * 📋 Récupérer les tweets de la queue avec priorité
   * Priorise les tweets non-shadowbannés sur les shadowbannés
   */
  async getTweetsFromQueueWithPriority(limit = 10, maxShadowBannedRatio = 0.3) {
    try {
      logger.info(`📋 Récupération des tweets de la queue avec priorité (limit: ${limit}, maxShadowBanned: ${maxShadowBannedRatio * 100}%)`);

      // Calculer le nombre maximum de tweets shadow bannés autorisés
      const maxShadowBanned = Math.floor(limit * maxShadowBannedRatio);
      const maxNormal = limit - maxShadowBanned;

      // Récupérer d'abord les tweets non-shadowbannés
      const normalTweets = await sequelize.query(`
        SELECT 
          tq.*,
          t.*,
          u.id as author_id,
          u.username,
          u.full_name,
          u.avatar,
          u.verified,
          u.premium
        FROM tweet_queue tq
        JOIN tweets t ON tq.tweet_id = t.id
        JOIN users u ON tq.user_id = u.id
        WHERE tq.queue_status = 'pending'
        AND (tq.processing_metadata->>'shadow_banned')::boolean = false
        ORDER BY tq.queued_at ASC
        LIMIT :maxNormal
      `, {
        replacements: { maxNormal },
        type: sequelize.QueryTypes.SELECT
      });

      // Récupérer ensuite les tweets shadow bannés si nécessaire
      let shadowBannedTweets = [];
      if (normalTweets.length < limit && maxShadowBanned > 0) {
        shadowBannedTweets = await sequelize.query(`
          SELECT 
            tq.*,
            t.*,
            u.id as author_id,
            u.username,
            u.full_name,
            u.avatar,
            u.verified,
            u.premium
          FROM tweet_queue tq
          JOIN tweets t ON tq.tweet_id = t.id
          JOIN users u ON tq.user_id = u.id
          WHERE tq.queue_status = 'pending'
          AND (tq.processing_metadata->>'shadow_banned')::boolean = true
          ORDER BY tq.queued_at ASC
          LIMIT :maxShadowBanned
        `, {
          replacements: { maxShadowBanned },
          type: sequelize.QueryTypes.SELECT
        });
      }

      // Combiner et formater les résultats
      const allTweets = [...normalTweets, ...shadowBannedTweets].map(tweet => {
        // 🔧 FORMATER LES DONNÉES UTILISATEUR COMME LES AUTRES ALGORITHMES
        if (tweet.author_id) {
          tweet.author = {
            id: tweet.author_id,
            username: tweet.username,
            full_name: tweet.full_name,
            avatar: tweet.avatar,
            verified: tweet.verified,
            premium: tweet.premium
          };
          
          // Nettoyer les champs utilisateur dupliqués
          delete tweet.author_id;
          delete tweet.username;
          delete tweet.full_name;
          delete tweet.avatar;
          delete tweet.verified;
          delete tweet.premium;
        } else {
          logger.warn(`⚠️ Tweet ${tweet.id} sans données utilisateur dans la queue`);
        }
        
        return tweet;
      });

      logger.info(`📋 Tweets récupérés: ${normalTweets.length} normaux + ${shadowBannedTweets.length} shadow bannés = ${allTweets.length} total`);

      return allTweets;

    } catch (error) {
      logger.error('❌ Erreur récupération tweets avec priorité:', error);
      return [];
    }
  }

  /**
   * 📊 Obtenir les statistiques de la queue
   */
  async getQueueStats() {
    try {
      const [stats] = await sequelize.query(`
        SELECT 
          COUNT(*) as total_pending,
          COUNT(*) FILTER (WHERE (processing_metadata->>'shadow_banned')::boolean = false) as normal_pending,
          COUNT(*) FILTER (WHERE (processing_metadata->>'shadow_banned')::boolean = true) as shadow_banned_pending,
          COUNT(*) FILTER (WHERE queue_status = 'approved') as approved,
          COUNT(*) FILTER (WHERE queue_status = 'rejected') as rejected
        FROM tweet_queue
        WHERE queue_status IN ('pending', 'approved', 'rejected')
      `, {
        type: sequelize.QueryTypes.SELECT
      });

      return stats;
    } catch (error) {
      logger.error('❌ Erreur récupération stats queue:', error);
      return {
        total_pending: 0,
        normal_pending: 0,
        shadow_banned_pending: 0,
        approved: 0,
        rejected: 0
      };
    }
  }
}

module.exports = TweetQueueService;
