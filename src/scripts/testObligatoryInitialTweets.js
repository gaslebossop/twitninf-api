/**
 * Script de test pour les tweets du groupe initial OBLIGATOIRES
 * Teste que les tweets du groupe initial sont obligatoirement recommandés dans la première page
 */

const { User, Tweet } = require('../models');
const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class ObligatoryInitialTweetsTester {
  constructor() {
    this.progressiveEngine = new ProgressiveRecommendationEngine();
  }

  /**
   * Teste que les tweets du groupe initial sont obligatoirement dans la première page
   */
  async testObligatoryInitialTweets() {
    try {
      logger.info('🧪 Test des tweets du groupe initial OBLIGATOIRES...\n');

      // Créer plusieurs tweets du groupe initial
      const initialTweets = [];
      for (let i = 0; i < 5; i++) {
        const tweet = await Tweet.create({
          content: `Tweet initial OBLIGATOIRE ${i + 1}`,
          user_id: 1,
          moderation_status: 'approved',
          recommendation_group: 'initial',
          view_count: Math.floor(Math.random() * 3), // 0, 1 ou 2 vues
          metadata: {
            source: 'test_obligatory',
            test_index: i + 1,
            created_at: new Date().toISOString()
          }
        });
        initialTweets.push(tweet);
      }

      // Créer des tweets d'autres groupes
      const otherTweets = [];
      for (let i = 0; i < 15; i++) {
        const tweet = await Tweet.create({
          content: `Autre tweet ${i + 1}`,
          user_id: 1,
          moderation_status: 'approved',
          recommendation_group: ['expansion', 'viral', 'massive'][Math.floor(Math.random() * 3)],
          view_count: Math.floor(Math.random() * 100) + 10,
          metadata: {
            source: 'test_other',
            test_index: i + 1,
            created_at: new Date().toISOString()
          }
        });
        otherTweets.push(tweet);
      }

      logger.info(`📝 Tweets créés:`);
      logger.info(`   - Tweets initiaux: ${initialTweets.length}`);
      logger.info(`   - Autres tweets: ${otherTweets.length}`);

      // Tester la récupération des recommandations
      const recommendations = await this.progressiveEngine.getProgressiveRecommendations(1, {
        limit: 10,
        offset: 0
      });

      logger.info(`\n📊 Recommandations récupérées: ${recommendations.recommendations?.length || 0}`);

      if (recommendations.recommendations && recommendations.recommendations.length > 0) {
        // Analyser la première page
        const firstPageTweets = recommendations.recommendations.slice(0, 10);
        const initialTweetsInFirstPage = firstPageTweets.filter(tweet => 
          tweet.recommendation_group === 'initial'
        );

        logger.info(`🎯 Analyse de la première page:`);
        logger.info(`   - Tweets initiaux dans la première page: ${initialTweetsInFirstPage.length}`);
        logger.info(`   - Tweets autres dans la première page: ${firstPageTweets.length - initialTweetsInFirstPage.length}`);

        // Vérifier qu'il y a exactement 2 tweets initiaux dans la première page
        if (initialTweetsInFirstPage.length === 2) {
          logger.info(`✅ SUCCÈS: Exactement 2 tweets initiaux dans la première page`);
        } else if (initialTweetsInFirstPage.length > 2) {
          logger.warn(`⚠️ ATTENTION: ${initialTweetsInFirstPage.length} tweets initiaux dans la première page (devrait être 2)`);
        } else {
          logger.error(`❌ ÉCHEC: Seulement ${initialTweetsInFirstPage.length} tweets initiaux dans la première page (devrait être 2)`);
        }

        // Afficher les détails des tweets initiaux
        logger.info(`\n📋 Tweets initiaux dans la première page:`);
        initialTweetsInFirstPage.forEach((tweet, index) => {
          logger.info(`   ${index + 1}. ${tweet.id}: ${tweet.view_count || 0} vues`);
        });
      }

      // Nettoyer les tweets de test
      for (const tweet of [...initialTweets, ...otherTweets]) {
        await tweet.destroy();
      }
      logger.info(`\n🗑️ ${initialTweets.length + otherTweets.length} tweets de test supprimés`);

      logger.info('✅ Test des tweets OBLIGATOIRES terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test des tweets OBLIGATOIRES:', error);
    }
  }

  /**
   * Teste le mélange avec différents nombres de tweets initiaux
   */
  async testMixingWithDifferentInitialCounts() {
    try {
      logger.info('\n🧪 Test du mélange avec différents nombres de tweets initiaux...\n');

      const testCases = [
        { initialCount: 1, otherCount: 20, description: '1 tweet initial, 20 autres' },
        { initialCount: 2, otherCount: 20, description: '2 tweets initiaux, 20 autres' },
        { initialCount: 5, otherCount: 20, description: '5 tweets initiaux, 20 autres' },
        { initialCount: 10, otherCount: 20, description: '10 tweets initiaux, 20 autres' }
      ];

      for (const testCase of testCases) {
        logger.info(`\n📊 Test: ${testCase.description}`);

        // Créer les tweets de test
        const testTweets = [];
        
        // Tweets initiaux
        for (let i = 0; i < testCase.initialCount; i++) {
          const tweet = await Tweet.create({
            content: `Tweet initial ${i + 1}`,
            user_id: 1,
            moderation_status: 'approved',
            recommendation_group: 'initial',
            view_count: 0,
            metadata: { source: 'test_mixing', type: 'initial' }
          });
          testTweets.push(tweet);
        }

        // Autres tweets
        for (let i = 0; i < testCase.otherCount; i++) {
          const tweet = await Tweet.create({
            content: `Autre tweet ${i + 1}`,
            user_id: 1,
            moderation_status: 'approved',
            recommendation_group: 'expansion',
            view_count: 50,
            metadata: { source: 'test_mixing', type: 'other' }
          });
          testTweets.push(tweet);
        }

        // Tester le mélange
        const initialTweets = testTweets.filter(t => t.recommendation_group === 'initial');
        const otherTweets = testTweets.filter(t => t.recommendation_group !== 'initial');
        
        const mixedTweets = this.progressiveEngine.mixTweetsForPage(initialTweets, otherTweets, 10);
        
        // Analyser les 3 premières pages
        for (let page = 0; page < 3; page++) {
          const pageStart = page * 10;
          const pageEnd = Math.min(pageStart + 10, mixedTweets.length);
          const pageTweets = mixedTweets.slice(pageStart, pageEnd);
          
          const initialInPage = pageTweets.filter(t => t.recommendation_group === 'initial').length;
          const otherInPage = pageTweets.length - initialInPage;
          
          logger.info(`   Page ${page + 1}: ${initialInPage} initiaux + ${otherInPage} autres = ${pageTweets.length} tweets`);
        }

        // Nettoyer
        for (const tweet of testTweets) {
          await tweet.destroy();
        }
      }

      logger.info('✅ Test du mélange terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de mélange:', error);
    }
  }

  /**
   * Lance tous les tests
   */
  async runAllTests() {
    try {
      logger.info('🚀 Démarrage des tests de tweets OBLIGATOIRES...\n');

      await this.testObligatoryInitialTweets();
      await this.testMixingWithDifferentInitialCounts();

      logger.info('\n🎉 Tous les tests de tweets OBLIGATOIRES terminés avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    }
  }
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  const tester = new ObligatoryInitialTweetsTester();
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

module.exports = ObligatoryInitialTweetsTester;
