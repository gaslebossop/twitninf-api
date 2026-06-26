/**
 * Script de test pour la priorité des tweets initiaux
 * Teste la logique : tweets récents ou 0 vues, mais pas plus d'une semaine avec 0 vues
 */

const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class InitialPriorityTweetsTester {
  constructor() {
    this.progressiveEngine = new ProgressiveRecommendationEngine();
  }

  /**
   * Teste la logique de priorité des tweets initiaux
   */
  async testInitialPriorityLogic() {
    try {
      logger.info('🧪 Test de la logique de priorité des tweets initiaux...\n');

      const now = new Date();
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      // Créer des tweets de test avec différents scénarios
      const testTweets = [
        // Tweets récents avec vues (devraient être prioritaires)
        {
          id: 'recent-with-views-1',
          content: 'Tweet récent avec vues 1',
          recommendation_group: 'initial',
          view_count: 5,
          createdAt: threeDaysAgo.toISOString()
        },
        {
          id: 'recent-with-views-2',
          content: 'Tweet récent avec vues 2',
          recommendation_group: 'initial',
          view_count: 2,
          createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
        },
        
        // Tweets récents à 0 vues (devraient être prioritaires)
        {
          id: 'recent-zero-views-1',
          content: 'Tweet récent 0 vues 1',
          recommendation_group: 'initial',
          view_count: 0,
          createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString()
        },
        {
          id: 'recent-zero-views-2',
          content: 'Tweet récent 0 vues 2',
          recommendation_group: 'initial',
          view_count: 0,
          createdAt: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString() // 6h
        },
        
        // Tweets anciens à 0 vues (ne devraient PAS être prioritaires)
        {
          id: 'old-zero-views-1',
          content: 'Tweet ancien 0 vues 1',
          recommendation_group: 'initial',
          view_count: 0,
          createdAt: twoWeeksAgo.toISOString()
        },
        {
          id: 'old-zero-views-2',
          content: 'Tweet ancien 0 vues 2',
          recommendation_group: 'initial',
          view_count: 0,
          createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString() // 10 jours
        },
        
        // Tweets anciens avec vues (ne devraient PAS être prioritaires)
        {
          id: 'old-with-views-1',
          content: 'Tweet ancien avec vues 1',
          recommendation_group: 'initial',
          view_count: 1,
          createdAt: twoWeeksAgo.toISOString()
        },
        
        // Tweets d'autres groupes (ne devraient PAS être prioritaires)
        {
          id: 'expansion-tweet',
          content: 'Tweet expansion',
          recommendation_group: 'expansion',
          view_count: 0,
          createdAt: threeDaysAgo.toISOString()
        },
        {
          id: 'viral-tweet',
          content: 'Tweet viral',
          recommendation_group: 'viral',
          view_count: 0,
          createdAt: threeDaysAgo.toISOString()
        }
      ];

      logger.info(`📊 Tweets de test créés: ${testTweets.length}`);
      testTweets.forEach((tweet, index) => {
        const age = Math.floor((now - new Date(tweet.createdAt)) / (1000 * 60 * 60 * 24));
        logger.info(`   ${index + 1}. ${tweet.id}: ${tweet.view_count} vues, ${age} jours, groupe: ${tweet.recommendation_group}`);
      });

      // Appliquer la logique de filtrage
      const initialPriorityTweets = testTweets.filter(tweet => {
        if (tweet.recommendation_group !== 'initial') return false;
        
        const tweetDate = new Date(tweet.createdAt);
        const isRecent = tweetDate >= oneWeekAgo; // Tweet de moins d'une semaine
        const hasViews = (tweet.view_count || 0) > 0; // Tweet avec des vues
        const isZeroViews = (tweet.view_count || 0) === 0; // Tweet à 0 vues
        
        // Priorité : tweets récents OU tweets à 0 vues (mais pas anciens à 0 vues)
        return isRecent || (isZeroViews && isRecent);
      });

      logger.info(`\n✅ Tweets prioritaires sélectionnés: ${initialPriorityTweets.length}`);
      initialPriorityTweets.forEach((tweet, index) => {
        const age = Math.floor((now - new Date(tweet.createdAt)) / (1000 * 60 * 60 * 24));
        logger.info(`   ${index + 1}. ${tweet.id}: ${tweet.view_count} vues, ${age} jours`);
      });

      // Vérifier les résultats attendus
      const expectedPriorityIds = [
        'recent-with-views-1',
        'recent-with-views-2', 
        'recent-zero-views-1',
        'recent-zero-views-2'
      ];

      const actualPriorityIds = initialPriorityTweets.map(tweet => tweet.id);
      
      logger.info(`\n🔍 Vérification des résultats:`);
      logger.info(`   Tweets attendus: ${expectedPriorityIds.join(', ')}`);
      logger.info(`   Tweets obtenus: ${actualPriorityIds.join(', ')}`);

      const allExpectedFound = expectedPriorityIds.every(id => actualPriorityIds.includes(id));
      const noUnexpectedFound = actualPriorityIds.every(id => expectedPriorityIds.includes(id));

      if (allExpectedFound && noUnexpectedFound) {
        logger.info(`✅ Test réussi : tous les tweets prioritaires correctement sélectionnés`);
      } else {
        logger.error(`❌ Test échoué : sélection incorrecte des tweets prioritaires`);
      }

      logger.info('\n✅ Test de la logique de priorité terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de priorité:', error);
    }
  }

  /**
   * Teste le mélange avec des tweets prioritaires
   */
  async testPriorityMixing() {
    try {
      logger.info('\n🧪 Test du mélange avec tweets prioritaires...\n');

      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      // Tweets prioritaires du groupe initial
      const initialPriorityTweets = [
        {
          id: 'priority-1',
          content: 'Tweet prioritaire 1',
          recommendation_group: 'initial',
          view_count: 0,
          createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString() // 2h
        },
        {
          id: 'priority-2',
          content: 'Tweet prioritaire 2',
          recommendation_group: 'initial',
          view_count: 1,
          createdAt: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString() // 6h
        },
        {
          id: 'priority-3',
          content: 'Tweet prioritaire 3',
          recommendation_group: 'initial',
          view_count: 0,
          createdAt: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString() // 12h
        }
      ];

      // Autres tweets
      const otherTweets = Array.from({ length: 20 }, (_, i) => ({
        id: `other-${i + 1}`,
        content: `Autre tweet ${i + 1}`,
        recommendation_group: ['expansion', 'viral', 'massive'][Math.floor(Math.random() * 3)],
        view_count: Math.floor(Math.random() * 100) + 10,
        createdAt: threeDaysAgo.toISOString()
      }));

      logger.info(`📊 Tweets pour le test de mélange:`);
      logger.info(`   - Tweets prioritaires: ${initialPriorityTweets.length}`);
      logger.info(`   - Autres tweets: ${otherTweets.length}`);

      // Tester le mélange
      const mixedTweets = this.progressiveEngine.mixTweetsForPage(initialPriorityTweets, otherTweets, 10);
      
      // Analyser la répartition
      this.analyzePriorityMixing(mixedTweets, 10);

      logger.info('✅ Test du mélange avec tweets prioritaires terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de mélange:', error);
    }
  }

  /**
   * Analyse la répartition des tweets prioritaires dans le mélange
   */
  analyzePriorityMixing(mixedTweets, pageSize) {
    const totalTweets = mixedTweets.length;
    const totalPages = Math.ceil(totalTweets / pageSize);
    
    logger.info(`📄 ${totalTweets} tweets mélangés en ${totalPages} pages`);
    
    // Analyser chaque page
    for (let page = 0; page < totalPages; page++) {
      const pageStart = page * pageSize;
      const pageEnd = Math.min(pageStart + pageSize, totalTweets);
      const pageTweets = mixedTweets.slice(pageStart, pageEnd);
      
      // Compter les tweets prioritaires dans cette page
      const priorityCount = pageTweets.filter(tweet => 
        tweet.recommendation_group === 'initial' && 
        (tweet.view_count === 0 || tweet.view_count < 2)
      ).length;
      
      const otherCount = pageTweets.length - priorityCount;
      
      logger.info(`   Page ${page + 1}: ${priorityCount} prioritaires + ${otherCount} autres = ${pageTweets.length} tweets`);
      
      // Vérifier la règle : maximum 2 tweets prioritaires par page
      if (priorityCount > 2) {
        logger.warn(`   ⚠️  Page ${page + 1}: ${priorityCount} tweets prioritaires (dépasse la limite de 2)`);
      }
    }
  }

  /**
   * Lance tous les tests
   */
  async runAllTests() {
    try {
      logger.info('🚀 Démarrage des tests de priorité des tweets initiaux...\n');

      await this.testInitialPriorityLogic();
      await this.testPriorityMixing();

      logger.info('\n🎉 Tous les tests de priorité terminés avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    }
  }
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  const tester = new InitialPriorityTweetsTester();
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

module.exports = InitialPriorityTweetsTester;
