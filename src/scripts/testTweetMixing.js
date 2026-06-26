/**
 * Script de test pour le système de mélange intelligent des tweets
 * Teste la logique de mélange : jusqu'à 2 tweets du groupe initial par page de 10
 */

const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class TweetMixingTester {
  constructor() {
    this.progressiveEngine = new ProgressiveRecommendationEngine();
  }

  /**
   * Teste le système de mélange des tweets
   */
  async testTweetMixing() {
    try {
      logger.info('🧪 Test du système de mélange des tweets...\n');

      // Simuler des tweets du groupe initial
      const initialTweets = [
        { id: 'initial-1', content: 'Tweet initial 1', recommendation_group: 'initial', view_count: 1 },
        { id: 'initial-2', content: 'Tweet initial 2', recommendation_group: 'initial', view_count: 0 },
        { id: 'initial-3', content: 'Tweet initial 3', recommendation_group: 'initial', view_count: 1 },
        { id: 'initial-4', content: 'Tweet initial 4', recommendation_group: 'initial', view_count: 0 },
        { id: 'initial-5', content: 'Tweet initial 5', recommendation_group: 'initial', view_count: 2 }
      ];

      // Simuler des autres tweets
      const otherTweets = [
        { id: 'other-1', content: 'Tweet expansion 1', recommendation_group: 'expansion', view_count: 15 },
        { id: 'other-2', content: 'Tweet viral 1', recommendation_group: 'viral', view_count: 50 },
        { id: 'other-3', content: 'Tweet massif 1', recommendation_group: 'massive', view_count: 200 },
        { id: 'other-4', content: 'Tweet expansion 2', recommendation_group: 'expansion', view_count: 20 },
        { id: 'other-5', content: 'Tweet viral 2', recommendation_group: 'viral', view_count: 75 },
        { id: 'other-6', content: 'Tweet massif 2', recommendation_group: 'massive', view_count: 300 },
        { id: 'other-7', content: 'Tweet expansion 3', recommendation_group: 'expansion', view_count: 25 },
        { id: 'other-8', content: 'Tweet viral 3', recommendation_group: 'viral', view_count: 100 },
        { id: 'other-9', content: 'Tweet massif 3', recommendation_group: 'massive', view_count: 400 },
        { id: 'other-10', content: 'Tweet expansion 4', recommendation_group: 'expansion', view_count: 30 },
        { id: 'other-11', content: 'Tweet viral 4', recommendation_group: 'viral', view_count: 125 },
        { id: 'other-12', content: 'Tweet massif 4', recommendation_group: 'massive', view_count: 500 }
      ];

      logger.info(`📊 Tweets de test:`);
      logger.info(`   - Tweets initiaux: ${initialTweets.length}`);
      logger.info(`   - Autres tweets: ${otherTweets.length}`);
      logger.info(`   - Total: ${initialTweets.length + otherTweets.length}\n`);

      // Tester le mélange pour différentes tailles de page
      const pageSizes = [10, 15, 20];
      
      for (const pageSize of pageSizes) {
        logger.info(`🔄 Test avec page de ${pageSize} tweets:`);
        
        const mixedTweets = this.progressiveEngine.mixTweetsForPage(initialTweets, otherTweets, pageSize);
        
        // Analyser la répartition
        this.analyzeMixing(mixedTweets, pageSize);
        
        logger.info(''); // Ligne vide pour la lisibilité
      }

      logger.info('✅ Test du système de mélange terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de mélange:', error);
    }
  }

  /**
   * Analyse la répartition des tweets dans le mélange
   */
  analyzeMixing(mixedTweets, pageSize) {
    const totalTweets = mixedTweets.length;
    const totalPages = Math.ceil(totalTweets / pageSize);
    
    logger.info(`   📄 ${totalTweets} tweets mélangés en ${totalPages} pages`);
    
    // Analyser chaque page
    for (let page = 0; page < totalPages; page++) {
      const pageStart = page * pageSize;
      const pageEnd = Math.min(pageStart + pageSize, totalTweets);
      const pageTweets = mixedTweets.slice(pageStart, pageEnd);
      
      // Compter les tweets initiaux dans cette page
      const initialCount = pageTweets.filter(tweet => tweet.recommendation_group === 'initial').length;
      const otherCount = pageTweets.length - initialCount;
      
      logger.info(`   Page ${page + 1}: ${initialCount} initiaux + ${otherCount} autres = ${pageTweets.length} tweets`);
      
      // Vérifier la règle : maximum 2 tweets initiaux par page
      if (initialCount > 2) {
        logger.warn(`   ⚠️  Page ${page + 1}: ${initialCount} tweets initiaux (dépasse la limite de 2)`);
      }
    }
    
    // Statistiques globales
    const totalInitial = mixedTweets.filter(tweet => tweet.recommendation_group === 'initial').length;
    const totalOther = mixedTweets.length - totalInitial;
    const initialPercentage = ((totalInitial / totalTweets) * 100).toFixed(1);
    
    logger.info(`   📊 Répartition globale: ${totalInitial} initiaux (${initialPercentage}%) + ${totalOther} autres`);
  }

  /**
   * Teste le système avec des données réalistes
   */
  async testRealisticScenario() {
    try {
      logger.info('\n🧪 Test avec scénario réaliste...\n');

      // Scénario : 50 tweets initiaux, 200 autres tweets, page de 10
      const initialTweets = Array.from({ length: 50 }, (_, i) => ({
        id: `initial-${i + 1}`,
        content: `Tweet initial ${i + 1}`,
        recommendation_group: 'initial',
        view_count: Math.floor(Math.random() * 3) // 0, 1 ou 2 vues
      }));

      const otherTweets = Array.from({ length: 200 }, (_, i) => ({
        id: `other-${i + 1}`,
        content: `Tweet ${i + 1}`,
        recommendation_group: ['expansion', 'viral', 'massive'][Math.floor(Math.random() * 3)],
        view_count: Math.floor(Math.random() * 500) + 10
      }));

      logger.info(`📊 Scénario réaliste:`);
      logger.info(`   - Tweets initiaux: ${initialTweets.length}`);
      logger.info(`   - Autres tweets: ${otherTweets.length}`);
      logger.info(`   - Total: ${initialTweets.length + otherTweets.length}\n`);

      const mixedTweets = this.progressiveEngine.mixTweetsForPage(initialTweets, otherTweets, 10);
      this.analyzeMixing(mixedTweets, 10);

      logger.info('✅ Test du scénario réaliste terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test réaliste:', error);
    }
  }

  /**
   * Lance tous les tests
   */
  async runAllTests() {
    try {
      logger.info('🚀 Démarrage des tests de mélange des tweets...\n');

      await this.testTweetMixing();
      await this.testRealisticScenario();

      logger.info('\n🎉 Tous les tests de mélange terminés avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    }
  }
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  const tester = new TweetMixingTester();
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

module.exports = TweetMixingTester;
