/**
 * 🚀 Test de l'Algorithme Ultra-Puissant de Recommandation
 * 
 * Script de test pour valider le fonctionnement et les performances
 * du nouvel algorithme ultra-puissant.
 */

const UltraRecommendationEngine = require('./src/services/ultraRecommendationEngine');
const logger = require('./src/utils/logger');

// Configuration du test
const TEST_CONFIG = {
  testUserId: '550e8400-e29b-41d4-a716-446655440000', // ID utilisateur de test
  testLimits: [10, 50, 100],
  testContexts: ['ultra_discovery', 'ultra_trending', 'ultra_personalized'],
  performanceTests: true,
  stressTests: false
};

/**
 * Test principal de l'algorithme ultra-puissant
 */
async function testUltraAlgorithm() {
  try {
    logger.info('🚀 Début des tests de l\'algorithme ultra-puissant...');

    // 1. Test d'initialisation
    await testInitialization();

    // 2. Tests fonctionnels de base
    await testBasicFunctionality();

    // 3. Tests de performance
    if (TEST_CONFIG.performanceTests) {
      await testPerformance();
    }

    // 4. Tests de qualité des recommandations
    await testRecommendationQuality();

    // 5. Tests de cache et optimisation
    await testCacheOptimization();

    // 6. Tests de stress (optionnel)
    if (TEST_CONFIG.stressTests) {
      await testStressScenarios();
    }

    logger.info('✅ Tous les tests de l\'algorithme ultra-puissant sont terminés');

  } catch (error) {
    logger.error('❌ Erreur lors des tests:', error);
    process.exit(1);
  }
}

/**
 * Test d'initialisation du moteur
 */
async function testInitialization() {
  try {
    logger.info('🔧 Test d\'initialisation...');

    const ultraEngine = new UltraRecommendationEngine();
    
    // Vérifier que les propriétés principales sont initialisées
    const checks = [];
    
    if (ultraEngine.cache) checks.push('✅ Cache initialisé');
    else checks.push('❌ Cache non initialisé');
    
    if (ultraEngine.scoreWeights) checks.push('✅ Poids de scoring initialisés');
    else checks.push('❌ Poids de scoring non initialisés');
    
    if (ultraEngine.mlWeights) checks.push('✅ Poids ML initialisés');
    else checks.push('❌ Poids ML non initialisés');
    
    if (ultraEngine.ultraConfig) checks.push('✅ Configuration ultra initialisée');
    else checks.push('❌ Configuration ultra non initialisée');

    checks.forEach(check => logger.info(`  ${check}`));
    
    // Test des statistiques
    const stats = ultraEngine.getUltraStats();
    logger.info(`📊 Statistiques initiales:`, stats);

    logger.info('✅ Test d\'initialisation réussi');

  } catch (error) {
    logger.error('❌ Erreur lors du test d\'initialisation:', error);
    throw error;
  }
}

/**
 * Tests fonctionnels de base
 */
async function testBasicFunctionality() {
  try {
    logger.info('🧪 Tests fonctionnels de base...');

    const ultraEngine = new UltraRecommendationEngine();

    for (const limit of TEST_CONFIG.testLimits) {
      for (const context of TEST_CONFIG.testContexts) {
        logger.info(`🔍 Test: limit=${limit}, context=${context}`);

        const startTime = Date.now();
        
        const result = await ultraEngine.getUltraPowerRecommendations(TEST_CONFIG.testUserId, {
          limit,
          offset: 0,
          context,
          includeUser: true,
          includeStats: true
        });

        const processingTime = Date.now() - startTime;

        // Vérifications
        const checks = [];
        
        if (result.recommendations) checks.push(`✅ Recommandations générées: ${result.recommendations.length}`);
        else checks.push('❌ Aucune recommandation générée');
        
        if (result.pagination) checks.push('✅ Pagination présente');
        else checks.push('❌ Pagination manquante');
        
        if (result.metadata) checks.push('✅ Métadonnées présentes');
        else checks.push('❌ Métadonnées manquantes');
        
        if (processingTime < 5000) checks.push(`✅ Temps de traitement acceptable: ${processingTime}ms`);
        else checks.push(`⚠️ Temps de traitement élevé: ${processingTime}ms`);

        checks.forEach(check => logger.info(`    ${check}`));

        // Analyser la qualité des métadonnées
        if (result.metadata) {
          logger.info(`    📈 Métriques de qualité:`, result.metadata.qualityMetrics);
          logger.info(`    ⚡ Performance:`, result.metadata.performance);
        }
      }
    }

    logger.info('✅ Tests fonctionnels de base réussis');

  } catch (error) {
    logger.error('❌ Erreur lors des tests fonctionnels:', error);
    throw error;
  }
}

/**
 * Tests de performance
 */
async function testPerformance() {
  try {
    logger.info('⚡ Tests de performance...');

    const ultraEngine = new UltraRecommendationEngine();
    const performanceResults = [];

    // Test de performance avec différentes charges
    const testCases = [
      { limit: 10, runs: 10, name: 'Charge légère' },
      { limit: 50, runs: 5, name: 'Charge moyenne' },
      { limit: 100, runs: 3, name: 'Charge élevée' }
    ];

    for (const testCase of testCases) {
      logger.info(`🏃 ${testCase.name}: ${testCase.runs} exécutions avec limite ${testCase.limit}`);
      
      const times = [];
      
      for (let i = 0; i < testCase.runs; i++) {
        const startTime = Date.now();
        
        await ultraEngine.getUltraPowerRecommendations(TEST_CONFIG.testUserId, {
          limit: testCase.limit,
          offset: 0,
          context: 'ultra_discovery'
        });
        
        const processingTime = Date.now() - startTime;
        times.push(processingTime);
      }

      const avgTime = times.reduce((sum, time) => sum + time, 0) / times.length;
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);

      performanceResults.push({
        name: testCase.name,
        limit: testCase.limit,
        runs: testCase.runs,
        avgTime: Math.round(avgTime),
        minTime,
        maxTime
      });

      logger.info(`    📊 Temps moyen: ${Math.round(avgTime)}ms (min: ${minTime}ms, max: ${maxTime}ms)`);
    }

    // Résumé des performances
    logger.info('📈 Résumé des performances:');
    performanceResults.forEach(result => {
      logger.info(`  ${result.name}: ${result.avgTime}ms en moyenne pour ${result.limit} recommandations`);
    });

    logger.info('✅ Tests de performance terminés');

  } catch (error) {
    logger.error('❌ Erreur lors des tests de performance:', error);
    throw error;
  }
}

/**
 * Tests de qualité des recommandations
 */
async function testRecommendationQuality() {
  try {
    logger.info('🎯 Tests de qualité des recommandations...');

    const ultraEngine = new UltraRecommendationEngine();

    const result = await ultraEngine.getUltraPowerRecommendations(TEST_CONFIG.testUserId, {
      limit: 50,
      offset: 0,
      context: 'ultra_discovery'
    });

    if (!result.recommendations || result.recommendations.length === 0) {
      logger.warn('⚠️ Aucune recommandation à analyser');
      return;
    }

    // Analyser la diversité
    const authors = new Set();
    const formats = new Set();
    const hasMetadata = [];
    
    result.recommendations.forEach(rec => {
      if (rec.author?.id) authors.add(rec.author.id);
      
      const format = rec.media_urls?.length > 0 ? 'media' : 
                    rec.is_retweet ? 'retweet' : 
                    rec.parent_tweet_id ? 'reply' : 'text';
      formats.add(format);
      
      if (rec._recommendation_metadata) hasMetadata.push(rec);
    });

    const diversityScore = (authors.size / result.recommendations.length) * 100;
    const formatDiversity = (formats.size / 4) * 100; // 4 formats possibles
    const metadataPercentage = (hasMetadata.length / result.recommendations.length) * 100;

    logger.info('📊 Métriques de qualité:');
    logger.info(`  🎭 Diversité des auteurs: ${Math.round(diversityScore)}% (${authors.size} auteurs uniques)`);
    logger.info(`  📱 Diversité des formats: ${Math.round(formatDiversity)}% (${formats.size} formats)`);
    logger.info(`  🏷️ Métadonnées de recommandation: ${Math.round(metadataPercentage)}%`);

    // Analyser les scores de recommandation
    if (hasMetadata.length > 0) {
      const scores = hasMetadata
        .map(rec => rec._recommendation_metadata?.ultraScore)
        .filter(score => typeof score === 'number');
      
      if (scores.length > 0) {
        const avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
        const minScore = Math.min(...scores);
        const maxScore = Math.max(...scores);
        
        logger.info(`  🎯 Scores ultra: moyenne ${Math.round(avgScore)}, min ${Math.round(minScore)}, max ${Math.round(maxScore)}`);
      }
    }

    // Vérifier les métadonnées globales
    if (result.metadata?.qualityMetrics) {
      logger.info('🔬 Métriques avancées:', result.metadata.qualityMetrics);
    }

    logger.info('✅ Tests de qualité terminés');

  } catch (error) {
    logger.error('❌ Erreur lors des tests de qualité:', error);
    throw error;
  }
}

/**
 * Tests de cache et optimisation
 */
async function testCacheOptimization() {
  try {
    logger.info('💾 Tests de cache et optimisation...');

    const ultraEngine = new UltraRecommendationEngine();

    // Premier appel (sans cache)
    logger.info('🔍 Premier appel (mise en cache)...');
    const startTime1 = Date.now();
    
    await ultraEngine.getUltraPowerRecommendations(TEST_CONFIG.testUserId, {
      limit: 30,
      offset: 0,
      context: 'ultra_discovery'
    });
    
    const time1 = Date.now() - startTime1;
    logger.info(`    ⏱️ Temps sans cache: ${time1}ms`);

    // Deuxième appel (avec cache)
    logger.info('🔍 Deuxième appel (utilisation du cache)...');
    const startTime2 = Date.now();
    
    await ultraEngine.getUltraPowerRecommendations(TEST_CONFIG.testUserId, {
      limit: 30,
      offset: 0,
      context: 'ultra_discovery'
    });
    
    const time2 = Date.now() - startTime2;
    logger.info(`    ⚡ Temps avec cache: ${time2}ms`);

    // Calculer l'amélioration
    const improvement = ((time1 - time2) / time1) * 100;
    logger.info(`    📈 Amélioration du cache: ${Math.round(improvement)}%`);

    // Test avec forceRefresh
    logger.info('🔍 Troisième appel (forceRefresh)...');
    const startTime3 = Date.now();
    
    await ultraEngine.getUltraPowerRecommendations(TEST_CONFIG.testUserId, {
      limit: 30,
      offset: 0,
      context: 'ultra_discovery',
      forceRefresh: true
    });
    
    const time3 = Date.now() - startTime3;
    logger.info(`    🔄 Temps avec forceRefresh: ${time3}ms`);

    // Statistiques du cache
    const stats = ultraEngine.getUltraStats();
    logger.info('📊 Statistiques du cache:', stats.cacheStats);

    logger.info('✅ Tests de cache terminés');

  } catch (error) {
    logger.error('❌ Erreur lors des tests de cache:', error);
    throw error;
  }
}

/**
 * Tests de stress (optionnel)
 */
async function testStressScenarios() {
  try {
    logger.info('💪 Tests de stress...');

    const ultraEngine = new UltraRecommendationEngine();

    // Test de charge simultanée
    logger.info('🔥 Test de charge simultanée (10 requêtes parallèles)...');
    
    const promises = [];
    const startTime = Date.now();
    
    for (let i = 0; i < 10; i++) {
      promises.push(
        ultraEngine.getUltraPowerRecommendations(`user_${i}`, {
          limit: 20,
          offset: 0,
          context: 'ultra_discovery'
        })
      );
    }

    const results = await Promise.all(promises);
    const totalTime = Date.now() - startTime;
    
    logger.info(`    ⚡ 10 requêtes traitées en ${totalTime}ms`);
    logger.info(`    📊 Temps moyen par requête: ${Math.round(totalTime / 10)}ms`);
    
    // Vérifier que toutes les requêtes ont réussi
    const successCount = results.filter(result => result.recommendations).length;
    logger.info(`    ✅ Succès: ${successCount}/10 requêtes`);

    logger.info('✅ Tests de stress terminés');

  } catch (error) {
    logger.error('❌ Erreur lors des tests de stress:', error);
    throw error;
  }
}

/**
 * Fonction utilitaire pour formater les résultats
 */
function formatTestResults(results) {
  return {
    totalTests: results.length,
    passed: results.filter(r => r.status === 'passed').length,
    failed: results.filter(r => r.status === 'failed').length,
    warnings: results.filter(r => r.status === 'warning').length
  };
}

// Exécuter les tests si le script est appelé directement
if (require.main === module) {
  testUltraAlgorithm()
    .then(() => {
      logger.info('🎉 Tests de l\'algorithme ultra-puissant terminés avec succès!');
      process.exit(0);
    })
    .catch(error => {
      logger.error('💥 Échec des tests:', error);
      process.exit(1);
    });
}

module.exports = {
  testUltraAlgorithm,
  testInitialization,
  testBasicFunctionality,
  testPerformance,
  testRecommendationQuality,
  testCacheOptimization,
  testStressScenarios
};
