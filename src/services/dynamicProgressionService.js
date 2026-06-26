#!/usr/bin/env node

/**
 * 🎯 SERVICE DE PROGRESSION DYNAMIQUE DANS LA TWEET QUEUE
 * 
 * Gère la progression automatique des tweets entre les groupes
 * basée sur les performances réelles d'engagement
 */

const { sequelize } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

class DynamicProgressionService {
  constructor() {
    // Configuration des groupes et leurs tailles (sur 40 utilisateurs total)
    this.groupConfig = {
      initial: { size: 4, minRatio: 0.25 }, // 25% minimum (1 engagement sur 4 vues) pour passer à expansion
      expansion: { size: 10, minRatio: 0.20 }, // 20% minimum (2 engagement sur 10 vues) pour passer à viral
      viral: { size: 26, minRatio: 0.15 }, // 15% minimum (4 engagement sur 26 vues) pour passer à massive
      massive: { size: 40, minRatio: 0.10 }, // 10% minimum (4 engagement sur 40 vues) pour rester
      exclude: { size: 0, minRatio: 0 } // Groupe d'exclusion (pas recommandé)
    };
    
    // Seuils de rétrogradation (plus stricts)
    this.downgradeThresholds = {
      expansion: 0.15, // < 15% → retour initial
      viral: 0.10, // < 10% → retour expansion
      massive: 0.08 // < 8% → retour viral
    };
    
    // Nombre minimum de vues avant évaluation (plus conservateur)
    this.minViewsForEvaluation = {
      initial: 4, // Toutes les vues du groupe initial (4 users)
      expansion: 8, // Au moins 8 vues du groupe expansion (80% du groupe)
      viral: 20, // Au moins 20 vues du groupe viral (77% du groupe)
      massive: 32 // Au moins 32 vues du groupe massive (80% du groupe)
    };
    
    // Cooldown entre évaluations (en heures)
    this.evaluationCooldown = {
      initial: 2, // 2 heures minimum dans initial
      expansion: 4, // 4 heures minimum dans expansion
      viral: 6, // 6 heures minimum dans viral
      massive: 12 // 12 heures minimum dans massive
    };
  }

  /**
   * 🔄 Traite la progression d'un tweet spécifique
   */
  async processTweetProgression(tweetId) {
    try {
      logger.info(`🔄 Analyse de progression pour tweet ${tweetId}`);

      // 1. Récupérer les données actuelles du tweet et de la queue
      const [queueData] = await sequelize.query(`
        SELECT 
          tq.*,
          t.recommendation_group,
          t.view_count,
          t.created_at
        FROM tweet_queue tq
        LEFT JOIN tweets t ON tq.tweet_id = t.id
        WHERE tq.tweet_id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (!queueData) {
        logger.error(`❌ Tweet ${tweetId} non trouvé dans la queue`);
        return false;
      }

      const currentGroup = queueData.current_group || queueData.recommendation_group || 'initial';
      const queueInfo = queueData;

      // 2. Calculer les performances actuelles depuis la queue
      const performance = await this.calculateTweetPerformanceFromQueue(tweetId, currentGroup, queueInfo);
      
      // 3. Déterminer s'il faut changer de groupe
      const progression = this.determineProgression(currentGroup, performance, queueInfo);

      if (progression.action !== 'stay') {
        await this.updateTweetGroup(tweetId, progression.newGroup, performance, progression.reason);
        logger.info(`🎯 Tweet ${tweetId}: ${currentGroup} → ${progression.newGroup} (${progression.reason})`);
      }

      return true;

    } catch (error) {
      logger.error(`❌ Erreur lors du traitement de progression pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 📊 Calcule les performances d'un tweet depuis la queue
   */
  async calculateTweetPerformanceFromQueue(tweetId, currentGroup, queueInfo) {
    try {
      // Utiliser les données stockées dans la queue
      const totalInteractions = (queueInfo.total_likes || 0) + (queueInfo.total_retweets || 0) + (queueInfo.total_replies || 0);
      const totalViews = queueInfo.total_views || 0;
      const engagementRatio = totalViews > 0 ? totalInteractions / totalViews : 0;

      // Récupérer les vues pour le groupe actuel
      const groupViewsColumn = `group_views_${currentGroup}`;
      const currentGroupViews = queueInfo[groupViewsColumn] || 0;

      // Calculer le ratio spécifique au groupe actuel
      const groupSpecificRatio = currentGroupViews > 0 ? totalInteractions / currentGroupViews : 0;

      return {
        totalInteractions,
        totalViews,
        engagementRatio,
        groupViews: currentGroupViews,
        groupSpecificRatio,
        likes: queueInfo.total_likes || 0,
        retweets: queueInfo.total_retweets || 0,
        replies: queueInfo.total_replies || 0,
        hasMinViews: currentGroupViews >= this.minViewsForEvaluation[currentGroup]
      };

    } catch (error) {
      logger.error(`❌ Erreur calcul performance depuis queue pour ${tweetId}:`, error);
      return {
        totalInteractions: 0,
        totalViews: 0,
        engagementRatio: 0,
        groupViews: 0,
        groupSpecificRatio: 0,
        likes: 0,
        retweets: 0,
        replies: 0,
        hasMinViews: false
      };
    }
  }

  /**
   * 📊 Calcule les performances d'un tweet (ancienne méthode)
   */
  async calculateTweetPerformance(tweetId, currentGroup, metadata) {
    try {
      // Récupérer les interactions
      const [interactions] = await sequelize.query(`
        SELECT 
          COUNT(DISTINCT tl.id) as likes,
          COUNT(DISTINCT tr.id) as retweets,
          COUNT(DISTINCT replies.id) as replies,
          t.view_count
        FROM tweets t
        LEFT JOIN tweet_likes tl ON t.id = tl.tweet_id
        LEFT JOIN tweet_retweets tr ON t.id = tr.tweet_id
        LEFT JOIN tweets replies ON t.id = replies.parent_tweet_id
        WHERE t.id = :tweetId
        GROUP BY t.id, t.view_count
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      const stats = interactions[0] || { likes: 0, retweets: 0, replies: 0, view_count: 0 };
      
      // Calculer les métriques
      const totalInteractions = parseInt(stats.likes) + parseInt(stats.retweets) + parseInt(stats.replies);
      const views = parseInt(stats.view_count) || 0;
      const engagementRatio = views > 0 ? totalInteractions / views : 0;

      // Récupérer les vues par groupe depuis les métadonnées
      const groupViews = metadata.group_views || {};
      const currentGroupViews = groupViews[currentGroup] || 0;

      // Calculer le ratio spécifique au groupe actuel
      const groupSpecificRatio = currentGroupViews > 0 ? totalInteractions / currentGroupViews : 0;

      return {
        totalInteractions,
        totalViews: views,
        engagementRatio,
        groupViews: currentGroupViews,
        groupSpecificRatio,
        likes: parseInt(stats.likes),
        retweets: parseInt(stats.retweets),
        replies: parseInt(stats.replies),
        hasMinViews: currentGroupViews >= this.minViewsForEvaluation[currentGroup]
      };

    } catch (error) {
      logger.error(`❌ Erreur calcul performance pour ${tweetId}:`, error);
      return {
        totalInteractions: 0,
        totalViews: 0,
        engagementRatio: 0,
        groupViews: 0,
        groupSpecificRatio: 0,
        likes: 0,
        retweets: 0,
        replies: 0,
        hasMinViews: false
      };
    }
  }

  /**
   * 🎯 Détermine la progression du tweet
   */
  determineProgression(currentGroup, performance, metadata = {}) {
    // Si pas assez de vues pour évaluer, on reste
    if (!performance.hasMinViews) {
      return {
        action: 'stay',
        newGroup: currentGroup,
        reason: `Pas assez de vues (${performance.groupViews}/${this.minViewsForEvaluation[currentGroup]})`
      };
    }

    // Vérifier le cooldown (pas d'évaluation trop fréquente)
    const lastProgression = metadata.last_progression;
    if (lastProgression) {
      const lastProgressionTime = new Date(lastProgression.timestamp);
      const cooldownHours = this.evaluationCooldown[currentGroup];
      const hoursSinceLastProgression = (Date.now() - lastProgressionTime.getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceLastProgression < cooldownHours) {
        return {
          action: 'stay',
          newGroup: currentGroup,
          reason: `Cooldown: ${hoursSinceLastProgression.toFixed(1)}h < ${cooldownHours}h`
        };
      }
    }

    const ratio = performance.groupSpecificRatio;
    
    // Vérifier promotion
    if (currentGroup !== 'massive') {
      const minRatio = this.groupConfig[currentGroup].minRatio;
      if (ratio >= minRatio) {
        const nextGroup = this.getNextGroup(currentGroup);
        return {
          action: 'promote',
          newGroup: nextGroup,
          reason: `Bon ratio: ${(ratio * 100).toFixed(2)}% ≥ ${(minRatio * 100).toFixed(2)}%`
        };
      }
    }

    // Vérifier exclusion (plus de rétrogradation)
    if (currentGroup !== 'initial') {
      const downgradeThreshold = this.downgradeThresholds[currentGroup];
      if (ratio < downgradeThreshold) {
        return {
          action: 'exclude',
          newGroup: 'exclude',
          reason: `Mauvais ratio: ${(ratio * 100).toFixed(2)}% < ${(downgradeThreshold * 100).toFixed(2)}% → exclusion`
        };
      }
    }

    return {
      action: 'stay',
      newGroup: currentGroup,
      reason: `Ratio stable: ${(ratio * 100).toFixed(2)}%`
    };
  }

  /**
   * 📈 Obtient le groupe suivant
   */
  getNextGroup(currentGroup) {
    const progression = {
      'initial': 'expansion',
      'expansion': 'viral',
      'viral': 'massive',
      'massive': 'massive'
    };
    return progression[currentGroup] || currentGroup;
  }

  /**
   * 📉 Obtient le groupe précédent
   */
  getPreviousGroup(currentGroup) {
    const regression = {
      'massive': 'viral',
      'viral': 'expansion',
      'expansion': 'initial',
      'initial': 'initial'
    };
    return regression[currentGroup] || currentGroup;
  }

  /**
   * 🔄 Met à jour le groupe d'un tweet dans la queue
   */
  async updateTweetGroup(tweetId, newGroup, performance, reason) {
    try {
      const now = new Date();
      
      // Mettre à jour les métadonnées avec l'historique
      const progressionHistory = {
        timestamp: now.toISOString(),
        from_group: await this.getCurrentGroupFromQueue(tweetId),
        to_group: newGroup,
        reason: reason,
        performance: {
          ratio: performance.groupSpecificRatio,
          interactions: performance.totalInteractions,
          views: performance.groupViews
        }
      };

      // Mettre à jour la queue avec toutes les infos
      await sequelize.query(`
        UPDATE tweet_queue 
        SET 
          current_group = :newGroup,
          last_group_change_at = NOW(),
          current_ratio = :ratio,
          last_evaluation_at = NOW(),
          evaluation_count = evaluation_count + 1,
          progression_history = COALESCE(progression_history, '[]'::jsonb) || :progressionHistoryJsonb,
          processing_metadata = COALESCE(processing_metadata, '{}'::jsonb) || 
            jsonb_build_object('last_progression', :progressionData::jsonb)
        WHERE tweet_id = :tweetId
      `, {
        replacements: {
          tweetId,
          newGroup,
          ratio: performance.groupSpecificRatio,
          progressionData: JSON.stringify(progressionHistory),
          progressionHistoryJsonb: JSON.stringify([progressionHistory])
        }
      });

      // Synchroniser avec la table tweets
      await sequelize.query(`
        UPDATE tweets 
        SET recommendation_group = :newGroup
        WHERE id = :tweetId
      `, {
        replacements: { tweetId, newGroup }
      });

      logger.info(`✅ Tweet ${tweetId} mis à jour: groupe ${newGroup}, raison: ${reason}`);
      return true;

    } catch (error) {
      logger.error(`❌ Erreur mise à jour groupe pour ${tweetId}:`, error);
      return false;
    }
  }

  /**
   * 📊 Obtient le groupe actuel d'un tweet depuis la queue
   */
  async getCurrentGroupFromQueue(tweetId) {
    try {
      const [result] = await sequelize.query(`
        SELECT current_group FROM tweet_queue WHERE tweet_id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });
      return result ? result.current_group : 'initial';
    } catch (error) {
      logger.error(`❌ Erreur récupération groupe depuis queue pour ${tweetId}:`, error);
      return 'initial';
    }
  }

  /**
   * 📊 Obtient le groupe actuel d'un tweet
   */
  async getCurrentGroup(tweetId) {
    try {
      const [result] = await sequelize.query(`
        SELECT recommendation_group FROM tweets WHERE id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });
      return result ? result.recommendation_group : 'initial';
    } catch (error) {
      logger.error(`❌ Erreur récupération groupe pour ${tweetId}:`, error);
      return 'initial';
    }
  }

  /**
   * 🔄 Traite tous les tweets en progression
   */
  async processAllActiveProgressions() {
    try {
      logger.info('🔄 Traitement de toutes les progressions actives...');

      // Récupérer seulement les tweets qui peuvent être évalués (avec cooldown)
      const [activeTweets] = await sequelize.query(`
        SELECT DISTINCT t.id, t.progressive_metadata, t.recommendation_group
        FROM tweets t
        JOIN tweet_queue tq ON t.id = tq.tweet_id
        WHERE t.progressive_testing_status = 'testing'
        AND tq.queue_status = 'approved'
        AND t.deleted_at IS NULL
        AND (
          -- Nouveau tweet sans progression précédente
          t.progressive_metadata->>'last_progression' IS NULL
          OR
          -- Tweet avec progression mais cooldown expiré
          (
            t.progressive_metadata->>'last_progression' IS NOT NULL
            AND EXTRACT(EPOCH FROM (NOW() - (t.progressive_metadata->'last_progression'->>'timestamp')::timestamp)) / 3600 >= 
            CASE t.recommendation_group
              WHEN 'initial' THEN 2
              WHEN 'expansion' THEN 4
              WHEN 'viral' THEN 6
              WHEN 'massive' THEN 12
              ELSE 2
            END
          )
        )
        ORDER BY t.progressive_added_at DESC
        LIMIT 20
      `);

      let processed = 0;
      let updated = 0;

      for (const tweet of activeTweets) {
        const success = await this.processTweetProgression(tweet.id);
        processed++;
        if (success) updated++;
      }

      logger.info(`✅ Progression terminée: ${processed} tweets traités, ${updated} mis à jour`);
      return { processed, updated };

    } catch (error) {
      logger.error('❌ Erreur traitement progressions:', error);
      return { processed: 0, updated: 0 };
    }
  }

  /**
   * 📊 Obtient les statistiques de progression
   */
  async getProgressionStats() {
    try {
      const [stats] = await sequelize.query(`
        SELECT 
          t.recommendation_group,
          COUNT(*) as count,
          AVG(t.view_count) as avg_views,
          AVG(
            CASE 
              WHEN t.view_count > 0 THEN 
                (
                  (SELECT COUNT(*) FROM tweet_likes WHERE tweet_id = t.id) +
                  (SELECT COUNT(*) FROM tweet_retweets WHERE tweet_id = t.id) +
                  (SELECT COUNT(*) FROM tweets replies WHERE replies.parent_tweet_id = t.id)
                )::float / t.view_count 
              ELSE 0 
            END
          ) as avg_engagement_ratio
        FROM tweets t
        JOIN tweet_queue tq ON t.id = tq.tweet_id
        WHERE t.progressive_testing_status = 'testing'
        AND tq.queue_status = 'approved'
        AND t.deleted_at IS NULL
        GROUP BY t.recommendation_group
        ORDER BY 
          CASE t.recommendation_group
            WHEN 'initial' THEN 1
            WHEN 'expansion' THEN 2
            WHEN 'viral' THEN 3
            WHEN 'massive' THEN 4
            ELSE 5
          END
      `);

      return stats;

    } catch (error) {
      logger.error('❌ Erreur récupération stats progression:', error);
      return [];
    }
  }
}

module.exports = DynamicProgressionService;
