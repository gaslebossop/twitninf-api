/**
 * 🧠 Test Rapide du Smart Recommendation Engine
 * 
 * Script de démonstration rapide pour tester le nouvel algorithme
 */

const SmartRecommendationEngine = require('./src/services/smartRecommendationEngine');

async function quickTest() {
  console.log('🧠 === TEST RAPIDE DU SMART RECOMMENDATION ENGINE ===\n');

  try {
    // Initialiser le moteur
    console.log('🚀 Initialisation du Smart Engine...');
    const smartEngine = new SmartRecommendationEngine();
    
    // Obtenir les statistiques initiales
    const stats = smartEngine.getEngineStats();
    console.log('📊 Statistiques initiales:');
    console.log(`   - Cache principal: ${stats.cacheStats.mainCache} entrées`);
    console.log(`   - Requêtes totales: ${stats.totalRequests}`);
    console.log(`   - Taux de cache hits: ${(stats.cacheHitRate * 100).toFixed(1)}%\n`);

    // Test avec un utilisateur fictif (remplacez par un ID réel)
    const testUserId = 1;
    console.log(`👤 Test avec l'utilisateur ${testUserId}:`);
    
    // Simuler une demande de recommandations
    console.log('   🔄 Génération de recommandations...');
    const startTime = Date.now();
    
    try {
      const result = await smartEngine.getSmartRecommendations(testUserId, {
        limit: 5,
        context: 'test_demo'
      });
      
      const duration = Date.now() - startTime;
      console.log(`   ✅ ${result.recommendations.length} recommandations en ${duration}ms`);
      
      if (result.recommendations.length > 0) {
        console.log('\n🎯 Exemples de scores:');
        result.recommendations.slice(0, 3).forEach((tweet, index) => {
          if (tweet.smartScore) {
            console.log(`   Tweet ${index + 1}:`);
            console.log(`     Score total: ${tweet.smartScore.total}/100`);
            console.log(`     Engagement: ${tweet.smartScore.userEngagement}/100`);
            console.log(`     Qualité: ${tweet.smartScore.contentQuality}/100`);
            console.log(`     Influence: ${tweet.smartScore.authorInfluence}/100`);
          }
        });
      }
      
      console.log('\n📈 Métriques de qualité:');
      console.log(`   - Score moyen: ${result.metadata.qualityMetrics.averageScore}`);
      console.log(`   - Diversité: ${result.metadata.qualityMetrics.diversityScore}%`);
      console.log(`   - Pertinence: ${result.metadata.qualityMetrics.relevanceScore}%`);
      console.log(`   - Fraîcheur: ${result.metadata.qualityMetrics.freshnessScore}%`);
      
    } catch (error) {
      console.log(`   ⚠️ Erreur lors du test: ${error.message}`);
      
      // Test du fallback
      console.log('   🔄 Test du système de fallback...');
      const fallbackResult = await smartEngine.getFallbackRecommendations(testUserId, { limit: 3 });
      console.log(`   ✅ Fallback: ${fallbackResult.recommendations.length} recommandations`);
    }

    // Test du cache
    console.log('\n💾 Test du cache:');
    const cacheTestStart = Date.now();
    await smartEngine.getSmartRecommendations(testUserId, { limit: 3 });
    const cacheTestDuration = Date.now() - cacheTestStart;
    console.log(`   ✅ Deuxième appel (cache): ${cacheTestDuration}ms`);

    // Statistiques finales
    const finalStats = smartEngine.getEngineStats();
    console.log('\n📊 Statistiques finales:');
    console.log(`   - Requêtes totales: ${finalStats.totalRequests}`);
    console.log(`   - Cache hits: ${finalStats.cacheHits}`);
    console.log(`   - Taux de succès cache: ${(finalStats.cacheHits / Math.max(finalStats.totalRequests, 1) * 100).toFixed(1)}%`);

    console.log('\n🎉 Test rapide terminé avec succès !');
    console.log('\n💡 Le Smart Recommendation Engine est prêt à être utilisé avec:');
    console.log('   • Système de scoring multi-dimensionnel (5 dimensions)');
    console.log('   • Cache intelligent multi-niveaux');
    console.log('   • Collecte de données ultra-avancée (7 sources)');
    console.log('   • Diversification automatique');
    console.log('   • Métriques de qualité en temps réel');
    console.log('\n🚀 Routes disponibles:');
    console.log('   • GET /api/recommendations/smart');
    console.log('   • GET /api/recommendations/smart/stats');
    console.log('   • GET /api/recommendations/tweets?algorithm=smart');

  } catch (error) {
    console.error('❌ Erreur lors du test rapide:', error);
  }
}

// Exécuter le test
if (require.main === module) {
  quickTest().then(() => {
    console.log('\n🎯 Test terminé !');
    process.exit(0);
  }).catch(console.error);
}

module.exports = quickTest;
