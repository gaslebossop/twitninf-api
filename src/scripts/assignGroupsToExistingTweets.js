/**
 * Script pour attribuer les groupes de recommandation aux tweets existants
 * selon leur nombre de vues
 */

const { Tweet } = require('../models');
const logger = require('../utils/logger');

class ExistingTweetsGroupAssigner {
  constructor() {
    this.systemImplementationDate = new Date('2025-09-13T00:00:00Z');
  }

  /**
   * Attribue les groupes aux tweets existants selon leur nombre de vues
   */
  async assignGroupsToExistingTweets() {
    try {
      logger.info('🚀 Attribution des groupes aux tweets existants...\n');

      // Récupérer tous les tweets existants (créés avant le 13 septembre 2025)
      const existingTweets = await Tweet.findAll({
        where: {
          created_at: {
            [require('sequelize').Op.lt]: this.systemImplementationDate
          }
        },
        attributes: ['id', 'view_count', 'recommendation_group', 'created_at']
      });

      logger.info(`📊 Tweets existants trouvés: ${existingTweets.length}`);

      // Statistiques par groupe
      const stats = {
        initial: 0,
        expansion: 0,
        viral: 0,
        massive: 0,
        excluded: 0
      };

      // Traiter chaque tweet
      for (const tweet of existingTweets) {
        const viewCount = tweet.view_count || 0;
        let newGroup = 'excluded'; // Par défaut, exclu

        // Logique d'attribution des groupes selon le nombre de vues
        if (viewCount >= 4 && viewCount < 10) {
          newGroup = 'initial';
        } else if (viewCount >= 10 && viewCount < 50) {
          newGroup = 'expansion';
        } else if (viewCount >= 50 && viewCount < 200) {
          newGroup = 'viral';
        } else if (viewCount >= 200) {
          newGroup = 'massive';
        } else {
          newGroup = 'excluded'; // Moins de 4 vues
        }

        // Mettre à jour le tweet
        await tweet.update({ recommendation_group: newGroup });
        stats[newGroup]++;

        logger.info(`📝 Tweet ${tweet.id}: ${viewCount} vues → ${newGroup}`);
      }

      // Afficher les statistiques
      logger.info('\n📊 Statistiques d\'attribution des groupes:');
      logger.info(`   - Initial (4-9 vues): ${stats.initial}`);
      logger.info(`   - Expansion (10-49 vues): ${stats.expansion}`);
      logger.info(`   - Viral (50-199 vues): ${stats.viral}`);
      logger.info(`   - Massive (200+ vues): ${stats.massive}`);
      logger.info(`   - Exclu (<4 vues): ${stats.excluded}`);

      // Vérifier les résultats
      const finalStats = await Tweet.findAll({
        attributes: [
          'recommendation_group',
          [require('sequelize').fn('COUNT', '*'), 'count']
        ],
        group: ['recommendation_group'],
        raw: true
      });

      logger.info('\n✅ Vérification finale des groupes:');
      finalStats.forEach(stat => {
        logger.info(`   - ${stat.recommendation_group}: ${stat.count} tweets`);
      });

      logger.info('✅ Attribution des groupes terminée avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'attribution des groupes:', error);
      throw error;
    }
  }

  /**
   * Affiche les statistiques des tweets par groupe
   */
  async showTweetStats() {
    try {
      logger.info('📊 Statistiques des tweets par groupe...\n');

      const stats = await Tweet.findAll({
        attributes: [
          'recommendation_group',
          [require('sequelize').fn('COUNT', '*'), 'count'],
          [require('sequelize').fn('AVG', require('sequelize').col('view_count')), 'avg_views'],
          [require('sequelize').fn('MIN', require('sequelize').col('view_count')), 'min_views'],
          [require('sequelize').fn('MAX', require('sequelize').col('view_count')), 'max_views']
        ],
        group: ['recommendation_group'],
        order: [['recommendation_group', 'ASC']],
        raw: true
      });

      logger.info('📈 Statistiques détaillées:');
      stats.forEach(stat => {
        logger.info(`\n   ${stat.recommendation_group.toUpperCase()}:`);
        logger.info(`     - Nombre: ${stat.count}`);
        logger.info(`     - Vues moyennes: ${Math.round(stat.avg_views || 0)}`);
        logger.info(`     - Vues min: ${stat.min_views || 0}`);
        logger.info(`     - Vues max: ${stat.max_views || 0}`);
      });

    } catch (error) {
      logger.error('❌ Erreur lors de l\'affichage des statistiques:', error);
    }
  }

  /**
   * Lance tous les traitements
   */
  async runAll() {
    try {
      await this.assignGroupsToExistingTweets();
      await this.showTweetStats();
    } catch (error) {
      logger.error('❌ Erreur lors du traitement:', error);
      throw error;
    }
  }
}

// Exécuter le script si lancé directement
if (require.main === module) {
  const assigner = new ExistingTweetsGroupAssigner();
  assigner.runAll()
    .then(() => {
      logger.info('✅ Traitement terminé');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Erreur lors du traitement:', error);
      process.exit(1);
    });
}

module.exports = ExistingTweetsGroupAssigner;
