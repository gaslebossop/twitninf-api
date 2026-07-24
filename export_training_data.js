/**
 * 📊 Script d'export des données pour entraînement IA de classification
 * 
 * Ce script exporte toutes les données de votre base de données TwitNin
 * dans un format adapté pour l'entraînement d'un modèle Python
 */

const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { 
  sequelize, 
  User, 
  Tweet, 
  TweetLike, 
  TweetRetweet, 
  UserFollow, 
  Report, 
  ModerationAction,
  UserBehaviorData,
  UserPreferences
} = require('./src/models');
const logger = require('./src/utils/logger');

class DataExporter {
  constructor() {
    this.exportDir = './data_export';
    this.batchSize = 1000; // Traiter par lots pour éviter les problèmes de mémoire
  }

  /**
   * Parse JSON de manière sécurisée
   */
  safeJsonParse(data, defaultValue = null) {
    if (!data) return defaultValue;
    if (typeof data === 'object') return data;
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch (error) {
        logger.warn(`Erreur parsing JSON: ${data}`);
        return defaultValue;
      }
    }
    return defaultValue;
  }

  /**
   * Initialise le répertoire d'export
   */
  async initExportDirectory() {
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
      logger.info(`📁 Répertoire d'export créé: ${this.exportDir}`);
    }
  }

  /**
   * Exporte les tweets avec leurs données de modération
   */
  async exportTweetData() {
    try {
      logger.info('📤 Export des données de tweets...');
      
      const tweets = await Tweet.findAll({
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'verified', 'premium', 'role', 'stats']
          }
        ],
        order: [['created_at', 'DESC']]
      });

      // Préparer les données pour l'entraînement
      const trainingData = tweets.map(tweet => ({
        // Identifiants
        tweet_id: tweet.id,
        user_id: tweet.user_id,
        created_at: tweet.created_at,
        
        // Contenu
        content: tweet.content,
        content_length: tweet.content.length,
        hashtags: tweet.hashtags || [],
        mentions: tweet.mentions || [],
        urls: tweet.urls || [],
        media_urls: tweet.media_urls || [],
        
        // Métadonnées
        tweet_type: tweet.tweet_type,
        is_retweet: tweet.is_retweet,
        is_quote: tweet.is_quote,
        is_reply: !!tweet.parent_tweet_id,
        language: tweet.language,
        is_sensitive: tweet.is_sensitive,
        
        // Données auteur
        author_verified: tweet.author?.verified || false,
        author_premium: tweet.author?.premium || false,
        author_role: tweet.author?.role || 'user',
        author_followers: tweet.author?.stats?.followers || 0,
        author_tweets: tweet.author?.stats?.tweets || 0,
        
        // Engagement
        view_count: tweet.view_count || 0,
        click_count: tweet.click_count || 0,
        
        // LABELS DE CLASSIFICATION
        moderation_status: tweet.moderation_status,
        moderation_reason: tweet.moderation_reason,
        is_deleted: !!tweet.deleted_at,
        
        // Classification binaire pour l'IA
        is_eligible: tweet.moderation_status === 'approved',
        is_flagged: tweet.moderation_status === 'flagged',
        is_rejected: tweet.moderation_status === 'rejected',
        is_not_eligible: tweet.moderation_status === 'not_eligible'
      }));

      // Sauvegarder en JSON
      fs.writeFileSync(
        path.join(this.exportDir, 'tweets_training_data.json'),
        JSON.stringify(trainingData, null, 2)
      );

      // Sauvegarder en CSV pour faciliter l'analyse
      const csvData = this.convertToCSV(trainingData);
      fs.writeFileSync(
        path.join(this.exportDir, 'tweets_training_data.csv'),
        csvData
      );

      logger.info(`✅ ${trainingData.length} tweets exportés`);
      return trainingData;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'export des tweets:', error);
      throw error;
    }
  }

  /**
   * Exporte les données de modération (reports et actions)
   */
  async exportModerationData() {
    try {
      logger.info('📤 Export des données de modération...');

      // Reports
      const reports = await Report.findAll({
        include: [
          {
            model: User,
            as: 'reporter',
            attributes: ['id', 'username', 'role']
          },
          {
            model: User,
            as: 'resolver',
            attributes: ['id', 'username', 'role']
          }
        ]
      });

      const reportsData = reports.map(report => ({
        report_id: report.id,
        target_id: report.target_id,
        target_type: report.target_type,
        reason: report.reason,
        severity: report.severity,
        status: report.status,
        priority: report.priority,
        created_at: report.created_at,
        resolved_at: report.resolved_at,
        resolution_action: report.resolution_action,
        reporter_role: report.reporter?.role || 'user'
      }));

      // Actions de modération
      const moderationActions = await ModerationAction.findAll({
        include: [
          {
            model: User,
            as: 'moderator',
            attributes: ['id', 'username', 'role']
          }
        ]
      });

      const actionsData = moderationActions.map(action => ({
        action_id: action.id,
        type: action.type,
        target_type: action.target_type,
        target_id: action.target_id,
        reason: action.reason,
        duration: action.duration,
        status: action.status,
        created_at: action.created_at,
        moderator_role: action.moderator?.role || 'moderator'
      }));

      // Sauvegarder
      fs.writeFileSync(
        path.join(this.exportDir, 'reports_data.json'),
        JSON.stringify(reportsData, null, 2)
      );

      fs.writeFileSync(
        path.join(this.exportDir, 'moderation_actions_data.json'),
        JSON.stringify(actionsData, null, 2)
      );

      logger.info(`✅ ${reportsData.length} reports et ${actionsData.length} actions exportés`);
      return { reports: reportsData, actions: actionsData };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'export de modération:', error);
      throw error;
    }
  }

  /**
   * Exporte les données comportementales
   */
  async exportBehaviorData() {
    try {
      logger.info('📤 Export des données comportementales...');

      const behaviorData = await UserBehaviorData.findAll({
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'role', 'verified', 'premium']
          }
        ],
        order: [['timestamp', 'DESC']],
        limit: 50000 // Limiter pour éviter trop de données
      });

      const behaviorTrainingData = behaviorData.map(behavior => ({
        user_id: behavior.user_id,
        action_type: behavior.action_type,
        target_id: behavior.target_id,
        target_type: behavior.target_type,
        context_data: behavior.context_data,
        duration_ms: behavior.duration_ms,
        timestamp: behavior.timestamp,
        interaction_quality: behavior.interaction_quality,
        user_verified: behavior.user?.verified || false,
        user_premium: behavior.user?.premium || false,
        user_role: behavior.user?.role || 'user'
      }));

      fs.writeFileSync(
        path.join(this.exportDir, 'behavior_data.json'),
        JSON.stringify(behaviorTrainingData, null, 2)
      );

      logger.info(`✅ ${behaviorTrainingData.length} actions comportementales exportées`);
      return behaviorTrainingData;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'export comportemental:', error);
      throw error;
    }
  }

  /**
   * Exporte les statistiques d'engagement des tweets
   */
  async exportEngagementData() {
    try {
      logger.info('📤 Export des données d\'engagement...');

      // Statistiques de likes par tweet
      const likesStats = await TweetLike.findAll({
        attributes: [
          'tweet_id',
          [sequelize.fn('COUNT', sequelize.col('id')), 'like_count']
        ],
        group: ['tweet_id']
      });

      // Statistiques de retweets par tweet
      const retweetStats = await TweetRetweet.findAll({
        attributes: [
          'tweet_id',
          [sequelize.fn('COUNT', sequelize.col('id')), 'retweet_count']
        ],
        group: ['tweet_id']
      });

      // Statistiques de réponses par tweet
      const replyStats = await Tweet.findAll({
        attributes: [
          'parent_tweet_id',
          [sequelize.fn('COUNT', sequelize.col('id')), 'reply_count']
        ],
        where: {
          parent_tweet_id: { [Op.ne]: null }
        },
        group: ['parent_tweet_id']
      });

      const engagementData = {
        likes: likesStats.map(stat => stat.toJSON()),
        retweets: retweetStats.map(stat => stat.toJSON()),
        replies: replyStats.map(stat => ({
          tweet_id: stat.parent_tweet_id,
          reply_count: stat.dataValues.reply_count
        }))
      };

      fs.writeFileSync(
        path.join(this.exportDir, 'engagement_data.json'),
        JSON.stringify(engagementData, null, 2)
      );

      logger.info(`✅ Données d'engagement exportées`);
      return engagementData;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'export d\'engagement:', error);
      throw error;
    }
  }

  /**
   * Crée un dataset labellisé pour l'entraînement
   */
  async createLabeledDataset() {
    try {
      logger.info('🏷️ Création du dataset labellisé...');

      // Récupérer SEULEMENT les tweets originaux (pas les réponses) avec leurs statistiques d'engagement
      const tweetsWithEngagement = await sequelize.query(`
        SELECT 
          t.*,
          u.username, u.verified, u.premium, u.role, u.stats,
          COALESCE(likes.like_count, 0) as like_count,
          COALESCE(retweets.retweet_count, 0) as retweet_count,
          COALESCE(replies.reply_count, 0) as reply_count,
          COALESCE(reports.report_count, 0) as report_count
        FROM tweets t
        LEFT JOIN users u ON t.user_id = u.id
        LEFT JOIN (
          SELECT tweet_id, COUNT(*) as like_count 
          FROM tweet_likes 
          GROUP BY tweet_id
        ) likes ON t.id = likes.tweet_id
        LEFT JOIN (
          SELECT tweet_id, COUNT(*) as retweet_count 
          FROM tweet_retweets 
          GROUP BY tweet_id
        ) retweets ON t.id = retweets.tweet_id
        LEFT JOIN (
          SELECT parent_tweet_id, COUNT(*) as reply_count 
          FROM tweets 
          WHERE parent_tweet_id IS NOT NULL 
          GROUP BY parent_tweet_id
        ) replies ON t.id = replies.parent_tweet_id
        LEFT JOIN (
          SELECT target_id, COUNT(*) as report_count 
          FROM reports 
          WHERE target_type = 'tweet' 
          GROUP BY target_id
        ) reports ON t.id = reports.target_id
        WHERE t.parent_tweet_id IS NULL 
          AND t.is_retweet = false
        ORDER BY t.created_at DESC
      `, {
        type: sequelize.QueryTypes.SELECT
      });

      // Préparer le dataset final avec features calculées
      const labeledDataset = tweetsWithEngagement.map(tweet => {
        // Gérer les données qui peuvent être déjà des objets ou des strings JSON
        const authorStats = this.safeJsonParse(tweet.stats, {});
        const hashtags = this.safeJsonParse(tweet.hashtags, []);
        const mentions = this.safeJsonParse(tweet.mentions, []);
        const urls = this.safeJsonParse(tweet.urls, []);
        
        // Extraire le score Gemini de moderation_reason
        let geminiScore = null;
        let geminiDecision = null;
        
        if (tweet.moderation_reason) {
          // Format attendu: "gemini_eligible:raison" ou "gemini_not_eligible:raison" ou "gemini_ban:raison"
          const geminiMatch = tweet.moderation_reason.match(/gemini_(\w+):(.+)/);
          if (geminiMatch) {
            geminiDecision = geminiMatch[1]; // eligible, not_eligible, ban
            const reason = geminiMatch[2];
            
            // Essayer d'extraire un score numérique si présent
            const scoreMatch = reason.match(/score[:\s]+([0-9\.]+)/i);
            if (scoreMatch) {
              geminiScore = parseFloat(scoreMatch[1]);
            }
          }
        }
        
        return {
          // Features textuelles
          content: tweet.content,
          content_length: tweet.content.length,
          word_count: tweet.content.split(' ').length,
          hashtag_count: hashtags.length,
          mention_count: mentions.length,
          url_count: urls.length,
          has_media: this.safeJsonParse(tweet.media_urls, []).length > 0,
          
          // Features temporelles
          hour_of_day: new Date(tweet.created_at).getHours(),
          day_of_week: new Date(tweet.created_at).getDay(),
          is_weekend: [0, 6].includes(new Date(tweet.created_at).getDay()),
          
          // Features auteur
          author_verified: tweet.verified || false,
          author_premium: tweet.premium || false,
          author_is_moderator: ['moderator', 'admin', 'superadmin'].includes(tweet.role),
          author_followers: authorStats.followers || 0,
          author_following: authorStats.following || 0,
          author_tweets: authorStats.tweets || 0,
          author_follower_ratio: authorStats.followers > 0 && authorStats.following > 0 
            ? authorStats.followers / authorStats.following : 0,
          
          // Features engagement
          like_count: parseInt(tweet.like_count) || 0,
          retweet_count: parseInt(tweet.retweet_count) || 0,
          reply_count: parseInt(tweet.reply_count) || 0,
          total_engagement: (parseInt(tweet.like_count) || 0) + 
                           (parseInt(tweet.retweet_count) || 0) + 
                           (parseInt(tweet.reply_count) || 0),
          
          // Features de modération
          report_count: parseInt(tweet.report_count) || 0,
          has_reports: parseInt(tweet.report_count) > 0,
          
          // Features Gemini
          gemini_score: geminiScore,
          gemini_decision: geminiDecision,
          has_gemini_score: geminiScore !== null,
          
          // Features type de contenu
          is_reply: !!tweet.parent_tweet_id,
          is_retweet: tweet.is_retweet || false,
          is_quote: tweet.is_quote || false,
          is_sensitive: tweet.is_sensitive || false,
          
          // LABELS pour classification
          moderation_status: tweet.moderation_status,
          is_approved: tweet.moderation_status === 'approved',
          is_rejected: tweet.moderation_status === 'rejected',
          is_flagged: tweet.moderation_status === 'flagged',
          is_not_eligible: tweet.moderation_status === 'not_eligible',
          is_deleted: !!tweet.deleted_at,
          
          // Labels binaires basés sur Gemini ET modération
          is_good_content: (
            geminiDecision === 'eligible' || 
            (tweet.moderation_status === 'approved' && !tweet.deleted_at && geminiDecision !== 'ban' && geminiDecision !== 'not_eligible')
          ),
          is_bad_content: (
            geminiDecision === 'ban' || 
            geminiDecision === 'not_eligible' ||
            ['rejected', 'flagged'].includes(tweet.moderation_status) || 
            !!tweet.deleted_at
          ),
          is_eligible_for_recommendations: (
            geminiDecision === 'eligible' || 
            (tweet.moderation_status === 'approved' && !tweet.deleted_at && geminiDecision !== 'ban' && geminiDecision !== 'not_eligible')
          ),
          
          // Label qualité basé sur score Gemini si disponible
          quality_score: geminiScore !== null ? geminiScore : 
                        (tweet.moderation_status === 'approved' && !tweet.deleted_at ? 0.7 : 0.3)
        };
      });

      // Sauvegarder le dataset complet
      fs.writeFileSync(
        path.join(this.exportDir, 'labeled_dataset.json'),
        JSON.stringify(labeledDataset, null, 2)
      );

      // Sauvegarder en CSV
      const csvData = this.convertToCSV(labeledDataset);
      fs.writeFileSync(
        path.join(this.exportDir, 'labeled_dataset.csv'),
        csvData
      );

      // Créer un dataset réduit avec seulement les features importantes
      const compactDataset = labeledDataset.map(item => ({
        content: item.content,
        content_length: item.content_length,
        word_count: item.word_count,
        hashtag_count: item.hashtag_count,
        mention_count: item.mention_count,
        url_count: item.url_count,
        has_media: item.has_media,
        author_verified: item.author_verified,
        author_followers: item.author_followers,
        total_engagement: item.total_engagement,
        report_count: item.report_count,
        is_good_content: item.is_good_content,
        is_eligible_for_recommendations: item.is_eligible_for_recommendations
      }));

      fs.writeFileSync(
        path.join(this.exportDir, 'compact_dataset.json'),
        JSON.stringify(compactDataset, null, 2)
      );

      logger.info(`✅ Dataset labellisé créé avec ${labeledDataset.length} échantillons`);
      
      // Statistiques du dataset
      const stats = {
        total_samples: labeledDataset.length,
        tweets_with_gemini_score: labeledDataset.filter(t => t.has_gemini_score).length,
        
        // Statistiques par statut de modération
        approved: labeledDataset.filter(t => t.is_approved).length,
        rejected: labeledDataset.filter(t => t.is_rejected).length,
        flagged: labeledDataset.filter(t => t.is_flagged).length,
        not_eligible: labeledDataset.filter(t => t.is_not_eligible).length,
        
        // Statistiques par décision Gemini
        gemini_eligible: labeledDataset.filter(t => t.gemini_decision === 'eligible').length,
        gemini_not_eligible: labeledDataset.filter(t => t.gemini_decision === 'not_eligible').length,
        gemini_ban: labeledDataset.filter(t => t.gemini_decision === 'ban').length,
        
        // Statistiques finales pour l'entraînement
        good_content: labeledDataset.filter(t => t.is_good_content).length,
        bad_content: labeledDataset.filter(t => t.is_bad_content).length,
        
        // Scores Gemini moyens
        avg_gemini_score: labeledDataset.filter(t => t.gemini_score !== null).length > 0 ?
          labeledDataset.filter(t => t.gemini_score !== null)
            .reduce((sum, t) => sum + t.gemini_score, 0) / 
          labeledDataset.filter(t => t.gemini_score !== null).length : null,
        
        avg_quality_score: labeledDataset.reduce((sum, t) => sum + t.quality_score, 0) / labeledDataset.length
      };

      fs.writeFileSync(
        path.join(this.exportDir, 'dataset_stats.json'),
        JSON.stringify(stats, null, 2)
      );

      logger.info('📊 Statistiques du dataset:', stats);
      return labeledDataset;

    } catch (error) {
      logger.error('❌ Erreur lors de la création du dataset labellisé:', error);
      throw error;
    }
  }

  /**
   * Convertit un array d'objets en CSV
   */
  convertToCSV(data) {
    if (data.length === 0) return '';
    
    const headers = Object.keys(data[0]);
    const csvContent = [
      headers.join(','),
      ...data.map(row => 
        headers.map(header => {
          let value = row[header];
          if (value === null || value === undefined) value = '';
          if (typeof value === 'string' && value.includes(',')) {
            value = `"${value.replace(/"/g, '""')}"`;
          }
          return value;
        }).join(',')
      )
    ].join('\n');
    
    return csvContent;
  }

  /**
   * Export complet de toutes les données
   */
  async exportAll() {
    try {
      logger.info('🚀 Début de l\'export complet des données...');
      
      await this.initExportDirectory();
      
      // Export des différents types de données
      await this.exportTweetData();
      await this.exportModerationData();
      await this.exportBehaviorData();
      await this.exportEngagementData();
      await this.createLabeledDataset();
      
      // Créer un fichier README avec les informations sur les exports
      const readmeContent = `# Export des données TwitNin pour entraînement IA

## Fichiers générés

### 1. tweets_training_data.json/csv
Données complètes des tweets avec métadonnées

### 2. reports_data.json & moderation_actions_data.json
Données de modération et signalements

### 3. behavior_data.json
Données comportementales des utilisateurs

### 4. engagement_data.json
Statistiques d'engagement (likes, retweets, replies)

### 5. labeled_dataset.json/csv
Dataset principal pour l'entraînement avec features calculées

### 6. compact_dataset.json
Version allégée du dataset avec features essentielles

### 7. dataset_stats.json
Statistiques du dataset

## Utilisation pour l'IA

Le fichier \`labeled_dataset.csv\` contient toutes les features nécessaires
pour entraîner un modèle de classification de tweets.

Labels principaux:
- is_good_content: Tweet de qualité (booléen)
- is_eligible_for_recommendations: Éligible aux recommandations (booléen)
- moderation_status: Statut détaillé (approved/rejected/flagged/not_eligible)

Date d'export: ${new Date().toISOString()}
`;

      fs.writeFileSync(
        path.join(this.exportDir, 'README.md'),
        readmeContent
      );
      
      logger.info(`✅ Export complet terminé dans le répertoire: ${this.exportDir}`);
      logger.info('📋 Fichiers disponibles pour l\'entraînement Python:');
      logger.info('   - labeled_dataset.csv (dataset principal)');
      logger.info('   - compact_dataset.json (version allégée)');
      logger.info('   - dataset_stats.json (statistiques)');
      
    } catch (error) {
      logger.error('❌ Erreur lors de l\'export complet:', error);
      throw error;
    }
  }
}

// Fonction principale
async function main() {
  try {
    // Tester la connexion à la base de données
    await sequelize.authenticate();
    logger.info('✅ Connexion à la base de données établie');
    
    const exporter = new DataExporter();
    await exporter.exportAll();
    
    logger.info('🎉 Export terminé avec succès !');
    process.exit(0);
    
  } catch (error) {
    logger.error('❌ Erreur fatale:', error);
    process.exit(1);
  }
}

// Exécuter si appelé directement
if (require.main === module) {
  main();
}

module.exports = DataExporter;
