/**
 * Script de test pour le système de tracking en temps réel
 * Teste les progress bars, les ratios d'interaction et les transitions de groupe
 */

const { User, Tweet } = require('../models');
const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class RealtimeTrackingTester {
  constructor() {
    this.progressiveEngine = new ProgressiveRecommendationEngine();
  }

  /**
   * Teste le système de tracking en temps réel
   */
  async testRealtimeTracking() {
    try {
      logger.info('🚀 Test du système de tracking en temps réel...\n');

      // Créer un utilisateur de test
      const user = await User.create({
        username: 'testuser_tracking',
        email: 'testuser_tracking@example.com',
        password: 'password123',
        full_name: 'Test User Tracking',
        platform: 'web',
        last_activity: new Date()
      });

      // Créer plusieurs tweets avec différents niveaux d'engagement
      const tweets = [];
      
      // Tweet 1 : Nouveau tweet (0 vues)
      const tweet1 = await Tweet.create({
        content: 'Nouveau tweet pour test de tracking',
        user_id: user.id,
        moderation_status: 'approved',
        recommendation_group: 'initial',
        view_count: 0,
        like_count: 0,
        comment_count: 0,
        retweet_count: 0,
        share_count: 0,
        report_count: 0,
        metadata: {
          source: 'test_tracking',
          test_type: 'new_tweet'
        }
      });
      tweets.push(tweet1);

      // Tweet 2 : Tweet avec quelques vues (groupe initial)
      const tweet2 = await Tweet.create({
        content: 'Tweet avec quelques vues pour test',
        user_id: user.id,
        moderation_status: 'approved',
        recommendation_group: 'initial',
        view_count: 2,
        like_count: 1,
        comment_count: 0,
        retweet_count: 0,
        share_count: 0,
        report_count: 0,
        metadata: {
          source: 'test_tracking',
          test_type: 'initial_group'
        }
      });
      tweets.push(tweet2);

      // Tweet 3 : Tweet avec plus de vues (groupe expansion)
      const tweet3 = await Tweet.create({
        content: 'Tweet avec plus de vues pour test',
        user_id: user.id,
        moderation_status: 'approved',
        recommendation_group: 'expansion',
        view_count: 15,
        like_count: 3,
        comment_count: 1,
        retweet_count: 1,
        share_count: 0,
        report_count: 0,
        metadata: {
          source: 'test_tracking',
          test_type: 'expansion_group'
        }
      });
      tweets.push(tweet3);

      // Tweet 4 : Tweet viral
      const tweet4 = await Tweet.create({
        content: 'Tweet viral pour test',
        user_id: user.id,
        moderation_status: 'approved',
        recommendation_group: 'viral',
        view_count: 150,
        like_count: 30,
        comment_count: 10,
        retweet_count: 5,
        share_count: 2,
        report_count: 0,
        metadata: {
          source: 'test_tracking',
          test_type: 'viral_group'
        }
      });
      tweets.push(tweet4);

      logger.info(`📝 ${tweets.length} tweets créés pour le test de tracking`);

      // Tester les recommandations pour déclencher le tracking
      logger.info('\n🔍 Test des recommandations avec tracking...');
      const recommendations = await this.progressiveEngine.getProgressiveRecommendations(user.id, {
        limit: 10,
        offset: 0
      });

      logger.info(`📊 ${recommendations.recommendations?.length || 0} recommandations générées`);

      // Simuler des interactions pour tester les progress bars
      logger.info('\n📈 Simulation d\'interactions...');
      
      // Mettre à jour les vues et interactions
      await tweet1.update({
        view_count: 3,
        like_count: 1
      });

      await tweet2.update({
        view_count: 8,
        like_count: 2,
        comment_count: 1
      });

      await tweet3.update({
        view_count: 25,
        like_count: 5,
        comment_count: 2,
        retweet_count: 1
      });

      await tweet4.update({
        view_count: 200,
        like_count: 40,
        comment_count: 15,
        retweet_count: 8,
        share_count: 3
      });

      // Tester à nouveau les recommandations pour voir les mises à jour
      logger.info('\n🔄 Test des recommandations après mise à jour...');
      const updatedRecommendations = await this.progressiveEngine.getProgressiveRecommendations(user.id, {
        limit: 10,
        offset: 0
      });

      logger.info(`📊 ${updatedRecommendations.recommendations?.length || 0} recommandations mises à jour`);

      // Tester les transitions de groupe
      logger.info('\n🔄 Test des transitions de groupe...');
      
      // Forcer une transition pour tweet2 (initial -> expansion)
      await tweet2.update({
        view_count: 15,
        like_count: 3,
        comment_count: 1
      });

      // Déclencher la re-évaluation
      const tweetGroup = await this.progressiveEngine.determineTweetRecommendationGroup(tweet2.id);
      logger.info(`🎯 Tweet ${tweet2.id} évalué: ${tweetGroup.group} - ${tweetGroup.reason}`);

      // Nettoyer les tweets de test
      for (const tweet of tweets) {
        await tweet.destroy();
      }
      
      // Nettoyer l'utilisateur de test
      await user.destroy();
      
      logger.info(`\n🗑️ ${tweets.length} tweets et 1 utilisateur de test supprimés`);

      logger.info('✅ Test du système de tracking en temps réel terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de tracking en temps réel:', error);
    }
  }

  /**
   * Teste les progress bars avec différents niveaux de progression
   */
  async testProgressBars() {
    try {
      logger.info('\n📊 Test des progress bars...\n');

      // Créer un utilisateur de test
      const user = await User.create({
        username: 'testuser_progress',
        email: 'testuser_progress@example.com',
        password: 'password123',
        full_name: 'Test User Progress',
        platform: 'web',
        last_activity: new Date()
      });

      // Créer des tweets avec différents niveaux de progression
      const progressLevels = [
        { views: 0, group: 'initial', description: '0% progression' },
        { views: 1, group: 'initial', description: '25% progression' },
        { views: 2, group: 'initial', description: '50% progression' },
        { views: 3, group: 'initial', description: '75% progression' },
        { views: 4, group: 'initial', description: '100% progression' },
        { views: 10, group: 'expansion', description: '100% progression expansion' },
        { views: 20, group: 'expansion', description: '100% progression expansion' },
        { views: 50, group: 'viral', description: '100% progression viral' },
        { views: 100, group: 'viral', description: '100% progression viral' }
      ];

      const tweets = [];

      for (let i = 0; i < progressLevels.length; i++) {
        const level = progressLevels[i];
        const tweet = await Tweet.create({
          content: `Tweet test progress ${i + 1}: ${level.description}`,
          user_id: user.id,
          moderation_status: 'approved',
          recommendation_group: level.group,
          view_count: level.views,
          like_count: Math.floor(level.views * 0.1),
          comment_count: Math.floor(level.views * 0.05),
          retweet_count: Math.floor(level.views * 0.02),
          share_count: Math.floor(level.views * 0.01),
          report_count: 0,
          metadata: {
            source: 'test_progress',
            level: i + 1
          }
        });
        tweets.push(tweet);
      }

      logger.info(`📝 ${tweets.length} tweets créés pour le test des progress bars`);

      // Tester les recommandations pour voir les progress bars
      logger.info('\n🔍 Test des recommandations avec progress bars...');
      const recommendations = await this.progressiveEngine.getProgressiveRecommendations(user.id, {
        limit: 20,
        offset: 0
      });

      logger.info(`📊 ${recommendations.recommendations?.length || 0} recommandations générées`);

      // Nettoyer
      for (const tweet of tweets) {
        await tweet.destroy();
      }
      await user.destroy();
      
      logger.info(`\n🗑️ ${tweets.length} tweets et 1 utilisateur de test supprimés`);

      logger.info('✅ Test des progress bars terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test des progress bars:', error);
    }
  }

  /**
   * Teste les ratios d'interaction
   */
  async testInteractionRatios() {
    try {
      logger.info('\n📈 Test des ratios d\'interaction...\n');

      // Créer un utilisateur de test
      const user = await User.create({
        username: 'testuser_ratios',
        email: 'testuser_ratios@example.com',
        password: 'password123',
        full_name: 'Test User Ratios',
        platform: 'web',
        last_activity: new Date()
      });

      // Créer des tweets avec différents ratios d'interaction
      const ratioTests = [
        { views: 100, likes: 5, comments: 2, retweets: 1, shares: 0, expectedRatio: 8.0, description: 'Ratio faible (8%)' },
        { views: 100, likes: 15, comments: 8, retweets: 3, shares: 1, expectedRatio: 27.0, description: 'Ratio moyen (27%)' },
        { views: 100, likes: 25, comments: 15, retweets: 8, shares: 2, expectedRatio: 50.0, description: 'Ratio élevé (50%)' },
        { views: 100, likes: 40, comments: 25, retweets: 15, shares: 5, expectedRatio: 85.0, description: 'Ratio très élevé (85%)' }
      ];

      const tweets = [];

      for (let i = 0; i < ratioTests.length; i++) {
        const test = ratioTests[i];
        const tweet = await Tweet.create({
          content: `Tweet test ratio ${i + 1}: ${test.description}`,
          user_id: user.id,
          moderation_status: 'approved',
          recommendation_group: 'expansion',
          view_count: test.views,
          like_count: test.likes,
          comment_count: test.comments,
          retweet_count: test.retweets,
          share_count: test.shares,
          report_count: 0,
          metadata: {
            source: 'test_ratios',
            expectedRatio: test.expectedRatio
          }
        });
        tweets.push(tweet);
      }

      logger.info(`📝 ${tweets.length} tweets créés pour le test des ratios`);

      // Tester les recommandations pour voir les ratios
      logger.info('\n🔍 Test des recommandations avec ratios d\'interaction...');
      const recommendations = await this.progressiveEngine.getProgressiveRecommendations(user.id, {
        limit: 20,
        offset: 0
      });

      logger.info(`📊 ${recommendations.recommendations?.length || 0} recommandations générées`);

      // Nettoyer
      for (const tweet of tweets) {
        await tweet.destroy();
      }
      await user.destroy();
      
      logger.info(`\n🗑️ ${tweets.length} tweets et 1 utilisateur de test supprimés`);

      logger.info('✅ Test des ratios d\'interaction terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test des ratios d\'interaction:', error);
    }
  }

  /**
   * Lance tous les tests
   */
  async runAllTests() {
    try {
      logger.info('🚀 Démarrage des tests de tracking en temps réel...\n');

      await this.testRealtimeTracking();
      await this.testProgressBars();
      await this.testInteractionRatios();

      logger.info('\n🎉 Tous les tests de tracking en temps réel terminés avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    }
  }
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  const tester = new RealtimeTrackingTester();
  tester.runAllTests()
    .then(() => {
      logger.info('✅ Tests terminés');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Erreur lors des tests:', error);
      process.exit(1);
    });
}

module.exports = RealtimeTrackingTester;
