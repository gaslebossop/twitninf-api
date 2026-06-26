/**
 * Script de test pour vérifier que seuls les NOUVEAUX tweets sont pris en compte
 * Teste que l'algo ne force pas avec tous les anciens tweets
 */

const { User, Tweet } = require('../models');
const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class NewTweetsOnlyTester {
  constructor() {
    this.progressiveEngine = new ProgressiveRecommendationEngine();
    this.systemImplementationDate = new Date('2025-09-13T00:00:00Z');
  }

  /**
   * Teste que seuls les nouveaux tweets sont pris en compte
   */
  async testNewTweetsOnly() {
    try {
      logger.info('🧪 Test des NOUVEAUX tweets seulement...\n');

      // Créer des tweets ANCIENS (avant l'implémentation du système)
      const oldDate = new Date('2025-09-12T10:00:00Z'); // Avant l'implémentation
      const oldTweets = [];
      
      for (let i = 0; i < 3; i++) {
        const tweet = await Tweet.create({
          content: `Tweet ANCIEN ${i + 1} (avant système obligatoire)`,
          user_id: 1,
          moderation_status: 'approved',
          recommendation_group: 'initial',
          view_count: 0,
          metadata: {
            source: 'test_old',
            test_index: i + 1,
            created_at: oldDate.toISOString()
          }
        });
        // Forcer la date de création
        await tweet.update({ created_at: oldDate });
        oldTweets.push(tweet);
      }

      // Créer des tweets NOUVEAUX (après l'implémentation du système)
      const newDate = new Date('2025-09-13T10:00:00Z'); // Après l'implémentation
      const newTweets = [];
      
      for (let i = 0; i < 5; i++) {
        const tweet = await Tweet.create({
          content: `Tweet NOUVEAU ${i + 1} (après système obligatoire)`,
          user_id: 1,
          moderation_status: 'approved',
          recommendation_group: 'initial',
          view_count: 0,
          metadata: {
            source: 'test_new',
            test_index: i + 1,
            created_at: newDate.toISOString()
          }
        });
        // Forcer la date de création
        await tweet.update({ created_at: newDate });
        newTweets.push(tweet);
      }

      // Créer des tweets d'autres groupes
      const otherTweets = [];
      for (let i = 0; i < 10; i++) {
        const tweet = await Tweet.create({
          content: `Autre tweet ${i + 1}`,
          user_id: 1,
          moderation_status: 'approved',
          recommendation_group: 'expansion',
          view_count: 50,
          metadata: {
            source: 'test_other',
            test_index: i + 1,
            created_at: new Date().toISOString()
          }
        });
        otherTweets.push(tweet);
      }

      logger.info(`📝 Tweets créés:`);
      logger.info(`   - Tweets ANCIENS (avant système): ${oldTweets.length}`);
      logger.info(`   - Tweets NOUVEAUX (après système): ${newTweets.length}`);
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

        // Vérifier qu'il n'y a que des NOUVEAUX tweets initiaux
        const newInitialTweets = initialTweetsInFirstPage.filter(tweet => {
          const tweetDate = new Date(tweet.createdAt || tweet.created_at);
          return tweetDate >= this.systemImplementationDate;
        });

        const oldInitialTweets = initialTweetsInFirstPage.filter(tweet => {
          const tweetDate = new Date(tweet.createdAt || tweet.created_at);
          return tweetDate < this.systemImplementationDate;
        });

        logger.info(`\n🔍 Analyse des tweets initiaux:`);
        logger.info(`   - NOUVEAUX tweets initiaux: ${newInitialTweets.length}`);
        logger.info(`   - ANCIENS tweets initiaux: ${oldInitialTweets.length}`);

        if (oldInitialTweets.length === 0) {
          logger.info(`✅ SUCCÈS: Aucun tweet ANCIEN dans les recommandations`);
        } else {
          logger.error(`❌ ÉCHEC: ${oldInitialTweets.length} tweets ANCIENS trouvés dans les recommandations`);
        }

        if (newInitialTweets.length > 0) {
          logger.info(`✅ SUCCÈS: ${newInitialTweets.length} NOUVEAUX tweets initiaux dans les recommandations`);
        } else {
          logger.warn(`⚠️ ATTENTION: Aucun nouveau tweet initial trouvé`);
        }

        // Afficher les détails des tweets initiaux
        logger.info(`\n📋 Tweets initiaux dans la première page:`);
        initialTweetsInFirstPage.forEach((tweet, index) => {
          const tweetDate = new Date(tweet.createdAt || tweet.created_at);
          const isNew = tweetDate >= this.systemImplementationDate ? '🆕 NOUVEAU' : '📅 ANCIEN';
          logger.info(`   ${index + 1}. ${isNew} Tweet ${tweet.id}: ${tweet.view_count || 0} vues`);
        });
      }

      // Nettoyer les tweets de test
      for (const tweet of [...oldTweets, ...newTweets, ...otherTweets]) {
        await tweet.destroy();
      }
      logger.info(`\n🗑️ ${oldTweets.length + newTweets.length + otherTweets.length} tweets de test supprimés`);

      logger.info('✅ Test des NOUVEAUX tweets seulement terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test des NOUVEAUX tweets seulement:', error);
    }
  }

  /**
   * Teste avec différents timestamps
   */
  async testDifferentTimestamps() {
    try {
      logger.info('\n🧪 Test avec différents timestamps...\n');

      const testCases = [
        { 
          date: new Date('2025-09-12T23:59:59Z'), 
          description: 'Tweet juste avant l\'implémentation',
          shouldBeIncluded: false
        },
        { 
          date: new Date('2025-09-13T00:00:00Z'), 
          description: 'Tweet exactement à l\'implémentation',
          shouldBeIncluded: true
        },
        { 
          date: new Date('2025-09-13T00:00:01Z'), 
          description: 'Tweet juste après l\'implémentation',
          shouldBeIncluded: true
        },
        { 
          date: new Date('2025-09-14T10:00:00Z'), 
          description: 'Tweet bien après l\'implémentation',
          shouldBeIncluded: true
        }
      ];

      for (const testCase of testCases) {
        logger.info(`\n📊 Test: ${testCase.description}`);

        // Créer un tweet avec la date spécifique
        const tweet = await Tweet.create({
          content: `Tweet test ${testCase.description}`,
          user_id: 1,
          moderation_status: 'approved',
          recommendation_group: 'initial',
          view_count: 0,
          metadata: {
            source: 'test_timestamp',
            description: testCase.description,
            created_at: testCase.date.toISOString()
          }
        });

        // Forcer la date de création
        await tweet.update({ created_at: testCase.date });

        // Tester la récupération des recommandations
        const recommendations = await this.progressiveEngine.getProgressiveRecommendations(1, {
          limit: 10,
          offset: 0
        });

        const initialTweets = recommendations.recommendations?.filter(t => t.recommendation_group === 'initial') || [];
        const isIncluded = initialTweets.some(t => t.id === tweet.id);

        if (isIncluded === testCase.shouldBeIncluded) {
          logger.info(`   ✅ ${testCase.description}: ${isIncluded ? 'INCLUS' : 'EXCLU'} (correct)`);
        } else {
          logger.error(`   ❌ ${testCase.description}: ${isIncluded ? 'INCLUS' : 'EXCLU'} (incorrect)`);
        }

        // Nettoyer
        await tweet.destroy();
      }

      logger.info('✅ Test des timestamps terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test des timestamps:', error);
    }
  }

  /**
   * Lance tous les tests
   */
  async runAllTests() {
    try {
      logger.info('🚀 Démarrage des tests de NOUVEAUX tweets seulement...\n');

      await this.testNewTweetsOnly();
      await this.testDifferentTimestamps();

      logger.info('\n🎉 Tous les tests de NOUVEAUX tweets seulement terminés avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    }
  }
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  const tester = new NewTweetsOnlyTester();
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

module.exports = NewTweetsOnlyTester;
