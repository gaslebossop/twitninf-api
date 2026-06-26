/**
 * 🧪 Tests du Système de Recommandation Ultra-Avancé
 * 
 * Script de test complet pour valider toutes les fonctionnalités
 * du nouveau moteur de recommandation professionnel.
 * 
 * @author TwitNin Team
 * @version 1.0.0
 * @license MIT
 */

const RecommendationEngine = require('./src/services/recommendationEngine');
const BehavioralAnalysisService = require('./src/services/behavioralAnalysisService');
const TrendingAnalysisService = require('./src/services/trendingAnalysisService');
const config = require('./src/services/recommendationConfig');

// Configuration de test
const TEST_CONFIG = {
  userId: 'test-user-123',
  testDuration: 30000, // 30 secondes
  maxRecommendations: 50,
  algorithms: ['ultra_hybrid', 'behavioral_ai', 'trending_boost', 'social_graph', 'content_intelligence']
};

class RecommendationTestSuite {
  constructor() {
    this.recommendationEngine = new RecommendationEngine();
    this.behavioralService = new BehavioralAnalysisService();
    this.trendingService = new TrendingAnalysisService();
    this.testResults = {
      total: 0,
      passed: 0,
      failed: 0,
      performance: [],
      errors: []
    };
  }

  /**
   * Exécute tous les tests
   */
  async runAllTests() {
    console.log('🚀 Démarrage des tests du système de recommandation ultra-avancé...\n');
    
    const startTime = Date.now();
    
    try {
      // Tests du moteur principal
      await this.testRecommendationEngine();
      
      // Tests de l'analyse comportementale
      await this.testBehavioralAnalysis();
      
      // Tests de l'analyse des tendances
      await this.testTrendingAnalysis();
      
      // Tests de performance
      await this.testPerformance();
      
      // Tests d'intégration
      await this.testIntegration();
      
      // Tests de configuration
      await this.testConfiguration();
      
    } catch (error) {
      console.error('❌ Erreur critique lors des tests:', error);
      this.testResults.errors.push(error.message);
    }
    
    const totalTime = Date.now() - startTime;
    this.generateTestReport(totalTime);
  }

  /**
   * Tests du moteur de recommandation principal
   */
  async testRecommendationEngine() {
    console.log('📋 Tests du moteur de recommandation principal...');
    
    // Test 1: Initialisation
    await this.runTest('Initialisation du moteur', async () => {
      const stats = this.recommendationEngine.getStats();
      return stats && typeof stats === 'object';
    });
    
    // Test 2: Recommandations de base
    await this.runTest('Recommandations de base', async () => {
      const recommendations = await this.recommendationEngine.getRecommendations(TEST_CONFIG.userId, {
        limit: 10,
        algorithm: 'ultra_hybrid'
      });
      return Array.isArray(recommendations) && recommendations.length <= 10;
    });
    
    // Test 3: Tous les algorithmes
    for (const algorithm of TEST_CONFIG.algorithms) {
      await this.runTest(`Algorithme ${algorithm}`, async () => {
        const recommendations = await this.recommendationEngine.getRecommendations(TEST_CONFIG.userId, {
          limit: 5,
          algorithm: algorithm
        });
        return Array.isArray(recommendations);
      });
    }
    
    // Test 4: Cache et performance
    await this.runTest('Système de cache', async () => {
      const startTime = Date.now();
      
      // Premier appel (cache miss)
      await this.recommendationEngine.getRecommendations(TEST_CONFIG.userId, { limit: 5 });
      const firstCallTime = Date.now() - startTime;
      
      // Deuxième appel (cache hit)
      const secondStartTime = Date.now();
      await this.recommendationEngine.getRecommendations(TEST_CONFIG.userId, { limit: 5 });
      const secondCallTime = Date.now() - secondStartTime;
      
      // Le deuxième appel doit être plus rapide
      return secondCallTime < firstCallTime;
    });
    
    // Test 5: Filtres avancés
    await this.runTest('Filtres avancés', async () => {
      const recommendations = await this.recommendationEngine.getRecommendations(TEST_CONFIG.userId, {
        limit: 20,
        algorithm: 'ultra_hybrid',
        includeUser: true,
        includeStats: true
      });
      
      // Vérifier que les données sont enrichies
      return recommendations.length > 0 && 
             recommendations[0].author && 
             recommendations[0].stats;
    });
  }

  /**
   * Tests de l'analyse comportementale
   */
  async testBehavioralAnalysis() {
    console.log('🧠 Tests de l\'analyse comportementale...');
    
    // Test 1: Initialisation du service
    await this.runTest('Initialisation du service comportemental', async () => {
      const stats = this.behavioralService.getStats();
      return stats && typeof stats === 'object';
    });
    
    // Test 2: Analyse complète du comportement
    await this.runTest('Analyse comportementale complète', async () => {
      const analysis = await this.behavioralService.analyzeUserBehavior(TEST_CONFIG.userId, {
        includePatterns: true,
        includePredictions: true,
        includeRecommendations: true
      });
      
      return analysis && 
             analysis.engagement && 
             analysis.content && 
             analysis.temporal && 
             analysis.social && 
             analysis.preferences;
    });
    
    // Test 3: Analyse d'engagement
    await this.runTest('Analyse d\'engagement', async () => {
      const engagement = await this.behavioralService.analyzeEngagementBehavior(TEST_CONFIG.userId);
      return engagement && 
             typeof engagement.total === 'object' && 
             typeof engagement.engagementRate === 'number';
    });
    
    // Test 4: Analyse de contenu
    await this.runTest('Analyse de contenu', async () => {
      const content = await this.behavioralService.analyzeContentBehavior(TEST_CONFIG.userId);
      return content && 
             typeof content.creation === 'object' && 
             typeof content.contentDiversity === 'number';
    });
    
    // Test 5: Analyse temporelle
    await this.runTest('Analyse temporelle', async () => {
      const temporal = await this.behavioralService.analyzeTemporalBehavior(TEST_CONFIG.userId);
      return temporal && 
             typeof temporal.frequency === 'string' && 
             typeof temporal.activityScore === 'number';
    });
  }

  /**
   * Tests de l'analyse des tendances
   */
  async testTrendingAnalysis() {
    console.log('📈 Tests de l\'analyse des tendances...');
    
    // Test 1: Initialisation du service
    await this.runTest('Initialisation du service des tendances', async () => {
      const stats = this.trendingService.getStats();
      return stats && typeof stats === 'object';
    });
    
    // Test 2: Analyse des tendances
    await this.runTest('Analyse des tendances', async () => {
      const trends = await this.trendingService.analyzeTrends({
        timeWindow: 24,
        includeViral: true,
        includeTopics: true,
        includeMomentum: true
      });
      
      return trends && 
             trends.viral && 
             trends.topics && 
             trends.momentum && 
             trends.summary;
    });
    
    // Test 3: Contenus viraux
    await this.runTest('Analyse des contenus viraux', async () => {
      const viral = await this.trendingService.analyzeViralContent(24, 10);
      return Array.isArray(viral);
    });
    
    // Test 4: Sujets tendance
    await this.runTest('Analyse des sujets tendance', async () => {
      const topics = await this.trendingService.analyzeTrendingTopics(24, 10);
      return topics && 
             topics.hashtags && 
             topics.mentions && 
             topics.keywords;
    });
    
    // Test 5: Tendances actives
    await this.runTest('Tendances actives', async () => {
      const activeTrends = this.trendingService.getActiveTrends();
      return activeTrends !== null;
    });
  }

  /**
   * Tests de performance
   */
  async testPerformance() {
    console.log('⚡ Tests de performance...');
    
    // Test 1: Temps de réponse
    await this.runTest('Temps de réponse < 2s', async () => {
      const startTime = Date.now();
      await this.recommendationEngine.getRecommendations(TEST_CONFIG.userId, {
        limit: 20,
        algorithm: 'ultra_hybrid'
      });
      const responseTime = Date.now() - startTime;
      
      this.testResults.performance.push(responseTime);
      return responseTime < 2000; // 2 secondes
    });
    
    // Test 2: Charge multiple
    await this.runTest('Charge multiple (10 utilisateurs)', async () => {
      const startTime = Date.now();
      const promises = [];
      
      for (let i = 0; i < 10; i++) {
        promises.push(
          this.recommendationEngine.getRecommendations(`user-${i}`, {
            limit: 10,
            algorithm: 'ultra_hybrid'
          })
        );
      }
      
      await Promise.all(promises);
      const totalTime = Date.now() - startTime;
      
      this.testResults.performance.push(totalTime);
      return totalTime < 5000; // 5 secondes pour 10 utilisateurs
    });
    
    // Test 3: Cache hit rate
    await this.runTest('Taux de cache hit > 70%', async () => {
      // Premier appel
      await this.recommendationEngine.getRecommendations(TEST_CONFIG.userId, { limit: 5 });
      
      // Deuxième appel (doit utiliser le cache)
      await this.recommendationEngine.getRecommendations(TEST_CONFIG.userId, { limit: 5 });
      
      const stats = this.recommendationEngine.getStats();
      const hitRate = parseFloat(stats.cacheHitRate.replace('%', ''));
      
      return hitRate > 70;
    });
  }

  /**
   * Tests d'intégration
   */
  async testIntegration() {
    console.log('🔗 Tests d\'intégration...');
    
    // Test 1: Intégration complète
    await this.runTest('Intégration complète des services', async () => {
      // Analyser le comportement
      const behavior = await this.behavioralService.analyzeUserBehavior(TEST_CONFIG.userId);
      
      // Analyser les tendances
      const trends = await this.trendingService.analyzeTrends();
      
      // Générer des recommandations avec contexte
      const recommendations = await this.recommendationEngine.getRecommendations(TEST_CONFIG.userId, {
        limit: 15,
        algorithm: 'ultra_hybrid',
        context: 'discovery'
      });
      
      return behavior && trends && recommendations && recommendations.length > 0;
    });
    
    // Test 2: Flux de données
    await this.runTest('Flux de données entre services', async () => {
      // Vérifier que les services partagent des données cohérentes
      const behaviorStats = this.behavioralService.getStats();
      const trendingStats = this.trendingService.getStats();
      const recommendationStats = this.recommendationEngine.getStats();
      
      return behaviorStats && trendingStats && recommendationStats;
    });
  }

  /**
   * Tests de configuration
   */
  async testConfiguration() {
    console.log('⚙️ Tests de configuration...');
    
    // Test 1: Configuration des algorithmes
    await this.runTest('Configuration des algorithmes', async () => {
      return config.algorithms && 
             config.algorithms.ultra_hybrid && 
             config.algorithms.behavioral_ai;
    });
    
    // Test 2: Configuration du scoring
    await this.runTest('Configuration du scoring', async () => {
      return config.scoring && 
             config.scoring.engagement && 
             config.scoring.contentQuality;
    });
    
    // Test 3: Configuration des seuils
    await this.runTest('Configuration des seuils', async () => {
      return config.thresholds && 
             typeof config.thresholds.minScore === 'number' && 
             typeof config.thresholds.viralThreshold === 'number';
    });
    
    // Test 4: Configuration du cache
    await this.runTest('Configuration du cache', async () => {
      return config.cache && 
             config.cache.main && 
             config.cache.layers;
    });
  }

  /**
   * Exécute un test individuel
   */
  async runTest(testName, testFunction) {
    this.testResults.total++;
    
    try {
      const startTime = Date.now();
      const result = await testFunction();
      const duration = Date.now() - startTime;
      
      if (result) {
        this.testResults.passed++;
        console.log(`✅ ${testName} - ${duration}ms`);
      } else {
        this.testResults.failed++;
        console.log(`❌ ${testName} - ÉCHEC`);
      }
      
      return result;
    } catch (error) {
      this.testResults.failed++;
      this.testResults.errors.push(`${testName}: ${error.message}`);
      console.log(`❌ ${testName} - ERREUR: ${error.message}`);
      return false;
    }
  }

  /**
   * Génère le rapport de test
   */
  generateTestReport(totalTime) {
    console.log('\n📊 RAPPORT DE TEST COMPLET');
    console.log('=' .repeat(50));
    
    // Résumé général
    console.log(`📋 Résumé des tests:`);
    console.log(`   Total: ${this.testResults.total}`);
    console.log(`   Réussis: ${this.testResults.passed} ✅`);
    console.log(`   Échoués: ${this.testResults.failed} ❌`);
    console.log(`   Taux de succès: ${((this.testResults.passed / this.testResults.total) * 100).toFixed(1)}%`);
    
    // Performance
    if (this.testResults.performance.length > 0) {
      const avgPerformance = this.testResults.performance.reduce((a, b) => a + b, 0) / this.testResults.performance.length;
      console.log(`\n⚡ Performance:`);
      console.log(`   Temps moyen: ${avgPerformance.toFixed(0)}ms`);
      console.log(`   Temps total: ${totalTime}ms`);
    }
    
    // Erreurs
    if (this.testResults.errors.length > 0) {
      console.log(`\n❌ Erreurs détectées:`);
      this.testResults.errors.forEach((error, index) => {
        console.log(`   ${index + 1}. ${error}`);
      });
    }
    
    // Recommandations
    console.log(`\n💡 Recommandations:`);
    if (this.testResults.failed === 0) {
      console.log(`   🎉 Tous les tests sont passés avec succès!`);
      console.log(`   🚀 Le système de recommandation est prêt pour la production.`);
    } else {
      console.log(`   🔧 ${this.testResults.failed} test(s) ont échoué.`);
      console.log(`   📝 Vérifiez les erreurs ci-dessus et corrigez-les.`);
    }
    
    // Statistiques des services
    console.log(`\n📈 Statistiques des services:`);
    
    try {
      const recStats = this.recommendationEngine.getStats();
      console.log(`   Moteur de recommandation:`);
      console.log(`     Cache hit rate: ${recStats.cacheHitRate}`);
      console.log(`     Temps de réponse moyen: ${recStats.avgResponseTime.toFixed(0)}ms`);
      console.log(`     Taille du cache: ${recStats.cacheSize}`);
    } catch (error) {
      console.log(`   Moteur de recommandation: Erreur lors de la récupération des stats`);
    }
    
    try {
      const behaviorStats = this.behavioralService.getStats();
      console.log(`   Analyse comportementale:`);
      console.log(`     Utilisateurs analysés: ${behaviorStats.analyzedUsers}`);
      console.log(`     Patterns identifiés: ${behaviorStats.patternsIdentified}`);
      console.log(`     Taille du cache: ${behaviorStats.cacheSize}`);
    } catch (error) {
      console.log(`   Analyse comportementale: Erreur lors de la récupération des stats`);
    }
    
    try {
      const trendingStats = this.trendingService.getStats();
      console.log(`   Analyse des tendances:`);
      console.log(`     Tendances actives: ${trendingStats.totalTrends}`);
      console.log(`     Contenus viraux: ${trendingStats.viralContent}`);
      console.log(`     Dernière mise à jour: ${trendingStats.lastUpdate ? trendingStats.lastUpdate.toLocaleString() : 'Jamais'}`);
    } catch (error) {
      console.log(`   Analyse des tendances: Erreur lors de la récupération des stats`);
    }
    
    console.log('\n' + '=' .repeat(50));
    console.log('🧪 Tests terminés!');
  }
}

// Fonction principale
async function main() {
  try {
    console.log('🚀 TwitNin Legacy - Tests du Système de Recommandation Ultra-Avancé');
    console.log('=' .repeat(70));
    
    const testSuite = new RecommendationTestSuite();
    await testSuite.runAllTests();
    
  } catch (error) {
    console.error('❌ Erreur critique lors de l\'exécution des tests:', error);
    process.exit(1);
  }
}

// Exécution si appelé directement
if (require.main === module) {
  main();
}

module.exports = RecommendationTestSuite;
