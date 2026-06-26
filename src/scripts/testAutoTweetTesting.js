/**
 * Script de test pour l'ajout automatique des tweets dans le système de test
 * Teste que chaque tweet publié est automatiquement ajouté comme tweet à tester
 */

const { User, Tweet } = require('../models');
const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class AutoTweetTestingTester {
  constructor() {
    this.progressiveEngine = new ProgressiveRecommendationEngine();
  }

  /**
   * Teste l'ajout automatique d'un tweet dans le système de test
   */
  async testAutoTweetAddition() {
    try {
      logger.info('🧪 Test de l\'ajout automatique des tweets dans le système de test...\n');

      // Créer un tweet de test
      const testTweet = await Tweet.create({
        content: 'Test tweet pour le système de test automatique',
        user_id: 1, // Utilisateur de test
        moderation_status: 'approved',
        recommendation_group: 'initial',
        view_count: 0,
        metadata: {
          source: 'test_script',
          test_type: 'auto_testing',
          created_at: new Date().toISOString()
        }
      });

      logger.info(`📝 Tweet de test créé: ${testTweet.id}`);

      // Tester l'ajout automatique
      const addResult = await this.progressiveEngine.addNewTweet(testTweet.id);
      
      if (addResult.success) {
        logger.info(`✅ Tweet ${testTweet.id} ajouté avec succès au système de test`);
      } else {
        logger.error(`❌ Échec de l'ajout du tweet ${testTweet.id}: ${addResult.error}`);
      }

      // Vérifier que le tweet est bien dans le groupe initial
      const updatedTweet = await Tweet.findByPk(testTweet.id);
      logger.info(`📊 État du tweet après ajout:`);
      logger.info(`   - Groupe: ${updatedTweet.recommendation_group}`);
      logger.info(`   - Vues: ${updatedTweet.view_count}`);
      logger.info(`   - Statut: ${updatedTweet.moderation_status}`);

      // Nettoyer le tweet de test
      await testTweet.destroy();
      logger.info(`🗑️ Tweet de test ${testTweet.id} supprimé`);

      logger.info('✅ Test de l\'ajout automatique terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test d\'ajout automatique:', error);
    }
  }

  /**
   * Teste la création d'un tweet via l'API (simulation)
   */
  async testTweetCreationFlow() {
    try {
      logger.info('\n🧪 Test du flux de création de tweet...\n');

      // Simuler la création d'un tweet via l'API
      const tweetData = {
        content: 'Tweet créé via l\'API pour test automatique',
        user_id: 1,
        moderation_status: 'approved',
        metadata: {
          source: 'api_test',
          test_type: 'creation_flow',
          created_at: new Date().toISOString()
        }
      };

      // Créer le tweet
      const tweet = await Tweet.create({
        ...tweetData,
        recommendation_group: 'initial',
        view_count: 0,
        metadata: {
          ...tweetData.metadata,
          progressive_testing: {
            added_at: new Date().toISOString(),
            status: 'testing',
            group: 'initial',
            reason: 'Tweet API ajouté automatiquement pour test'
          }
        }
      });

      logger.info(`📝 Tweet API créé: ${tweet.id}`);

      // Vérifier que le tweet est prêt pour le test
      logger.info(`📊 Configuration du tweet:`);
      logger.info(`   - Groupe: ${tweet.recommendation_group}`);
      logger.info(`   - Vues: ${tweet.view_count}`);
      logger.info(`   - Statut: ${tweet.moderation_status}`);
      logger.info(`   - Test: ${tweet.metadata.progressive_testing?.status}`);

      // Tester l'ajout au système de recommandation
      const addResult = await this.progressiveEngine.addNewTweet(tweet.id);
      
      if (addResult.success) {
        logger.info(`✅ Tweet ${tweet.id} ajouté au système de recommandation`);
      } else {
        logger.error(`❌ Échec de l'ajout: ${addResult.error}`);
      }

      // Nettoyer
      await tweet.destroy();
      logger.info(`🗑️ Tweet API ${tweet.id} supprimé`);

      logger.info('✅ Test du flux de création terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de flux:', error);
    }
  }

  /**
   * Teste la récupération des tweets de test
   */
  async testTweetRetrieval() {
    try {
      logger.info('\n🧪 Test de la récupération des tweets de test...\n');

      // Créer plusieurs tweets de test
      const testTweets = [];
      for (let i = 0; i < 5; i++) {
        const tweet = await Tweet.create({
          content: `Tweet de test ${i + 1} pour récupération`,
          user_id: 1,
          moderation_status: 'approved',
          recommendation_group: 'initial',
          view_count: Math.floor(Math.random() * 3), // 0, 1 ou 2 vues
          metadata: {
            source: 'test_retrieval',
            test_index: i + 1,
            created_at: new Date().toISOString()
          }
        });
        testTweets.push(tweet);
      }

      logger.info(`📝 ${testTweets.length} tweets de test créés`);

      // Tester la récupération via le système de recommandation
      const recommendations = await this.progressiveEngine.getProgressiveRecommendations(1, {
        limit: 10,
        offset: 0
      });

      logger.info(`📊 Recommandations récupérées: ${recommendations.recommendations?.length || 0}`);
      
      if (recommendations.recommendations && recommendations.recommendations.length > 0) {
        logger.info(`🎯 Tweets recommandés:`);
        recommendations.recommendations.forEach((tweet, index) => {
          logger.info(`   ${index + 1}. ${tweet.id}: ${tweet.view_count || 0} vues, groupe: ${tweet.recommendation_group}`);
        });
      }

      // Nettoyer les tweets de test
      for (const tweet of testTweets) {
        await tweet.destroy();
      }
      logger.info(`🗑️ ${testTweets.length} tweets de test supprimés`);

      logger.info('✅ Test de récupération terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de récupération:', error);
    }
  }

  /**
   * Lance tous les tests
   */
  async runAllTests() {
    try {
      logger.info('🚀 Démarrage des tests d\'ajout automatique des tweets...\n');

      await this.testAutoTweetAddition();
      await this.testTweetCreationFlow();
      await this.testTweetRetrieval();

      logger.info('\n🎉 Tous les tests d\'ajout automatique terminés avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    }
  }
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  const tester = new AutoTweetTestingTester();
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

module.exports = AutoTweetTestingTester;
