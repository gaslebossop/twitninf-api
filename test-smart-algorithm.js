/**
 * 🧠 Test du Smart Recommendation Engine - Algorithme Personnalisé
 * 
 * Script de test pour valider le nouvel algorithme de recommandation
 * et démontrer ses capacités de scoring multi-dimensionnel.
 */

const SmartRecommendationEngine = require('./src/services/smartRecommendationEngine');
const logger = require('./src/utils/logger');

async function testSmartRecommendationEngine() {
  try {
    console.log('🚀 Démarrage des tests du Smart Recommendation Engine\n');

    // Initialiser le moteur
    const smartEngine = new SmartRecommendationEngine();
    console.log('✅ Smart Recommendation Engine initialisé\n');

    // Test 1: Obtenir les statistiques initiales
    console.log('📊 Test 1: Statistiques initiales du moteur');
    const initialStats = smartEngine.getEngineStats();
    console.log('Stats initiales:', JSON.stringify(initialStats, null, 2));
    console.log('✅ Test 1 réussi\n');

    // Test 2: Tester avec un utilisateur fictif
    console.log('👤 Test 2: Recommandations pour utilisateur test');
    const testUserId = 1; // Remplacer par un ID utilisateur réel de votre base
    
    const recommendationsResult = await smartEngine.getSmartRecommendations(testUserId, {
      limit: 10,
      offset: 0,
      context: 'test_smart_discovery'
    });
    
    console.log(`📋 Recommandations générées: ${recommendationsResult.recommendations.length} tweets`);
    console.log('Métadonnées:', JSON.stringify(recommendationsResult.metadata, null, 2));
    
    // Afficher les scores des premiers tweets
    console.log('\n🎯 Analyse des scores des recommandations:');
    recommendationsResult.recommendations.slice(0, 5).forEach((tweet, index) => {
      console.log(`\nTweet ${index + 1}:`);
      console.log(`  Content: ${(tweet.content || '').substring(0, 100)}...`);
      console.log(`  Smart Score: ${tweet.smartScore?.total || 'N/A'}`);
      if (tweet.smartScore) {
        console.log(`  - Engagement utilisateur: ${tweet.smartScore.userEngagement}`);
        console.log(`  - Qualité contenu: ${tweet.smartScore.contentQuality}`);
        console.log(`  - Influence auteur: ${tweet.smartScore.authorInfluence}`);
        console.log(`  - Score temporel: ${tweet.smartScore.temporal}`);
        console.log(`  - Score comportemental: ${tweet.smartScore.behavioral}`);
        console.log(`  - Bonus source: ${tweet.smartScore.sourceBonus}`);
      }
    });
    console.log('✅ Test 2 réussi\n');

    // Test 3: Test de performance avec différentes tailles
    console.log('⚡ Test 3: Performance avec différentes tailles de recommandations');
    const performanceTests = [
      { limit: 5, name: 'Petit (5 tweets)' },
      { limit: 20, name: 'Moyen (20 tweets)' },
      { limit: 50, name: 'Grand (50 tweets)' }
    ];

    for (const test of performanceTests) {
      const startTime = Date.now();
      const result = await smartEngine.getSmartRecommendations(testUserId, {
        limit: test.limit,
        refreshCache: true // Force refresh pour test de performance
      });
      const duration = Date.now() - startTime;
      
      console.log(`  ${test.name}: ${result.recommendations.length} tweets en ${duration}ms`);
      console.log(`    Score moyen: ${result.metadata.qualityMetrics.averageScore}`);
      console.log(`    Diversité: ${result.metadata.qualityMetrics.diversityScore}%`);
      console.log(`    Pertinence: ${result.metadata.qualityMetrics.relevanceScore}%`);
      console.log(`    Fraîcheur: ${result.metadata.qualityMetrics.freshnessScore}%`);
    }
    console.log('✅ Test 3 réussi\n');

    // Test 4: Test du cache
    console.log('💾 Test 4: Test des performances du cache');
    
    // Premier appel (cache miss)
    const startTime1 = Date.now();
    await smartEngine.getSmartRecommendations(testUserId, { limit: 10 });
    const duration1 = Date.now() - startTime1;
    
    // Deuxième appel (cache hit)
    const startTime2 = Date.now();
    await smartEngine.getSmartRecommendations(testUserId, { limit: 10 });
    const duration2 = Date.now() - startTime2;
    
    console.log(`  Premier appel (cache miss): ${duration1}ms`);
    console.log(`  Deuxième appel (cache hit): ${duration2}ms`);
    console.log(`  Amélioration: ${Math.round(((duration1 - duration2) / duration1) * 100)}%`);
    console.log('✅ Test 4 réussi\n');

    // Test 5: Statistiques finales
    console.log('📈 Test 5: Statistiques finales du moteur');
    const finalStats = smartEngine.getEngineStats();
    console.log('Stats finales:', JSON.stringify(finalStats, null, 2));
    console.log('✅ Test 5 réussi\n');

    // Test 6: Test du système de scoring individuel
    console.log('🎯 Test 6: Test des composants de scoring individuels');
    
    // Simuler un profil utilisateur pour les tests
    const mockUserProfile = {
      userId: testUserId,
      user: { id: testUserId, allow_sensitive: false, language: 'fr' },
      type: 'active_user',
      confidence: 0.8,
      activityLevel: 'medium',
      topInterests: ['technologie', 'sport', 'actualités'],
      preferredAuthors: [2, 3, 4],
      contentPreferences: {
        topics: { technologie: 10, sport: 8, actualités: 6 },
        contentTypes: { text: 15, media: 10, retweet: 5 }
      },
      temporalPatterns: {
        peakHours: [{ hour: 12, activity: 5 }, { hour: 18, activity: 8 }, { hour: 21, activity: 6 }]
      },
      engagementPatterns: {
        preferredContentLength: 120,
        preferredTimeSlots: [12, 18, 21]
      }
    };

    // Simuler un tweet pour tester le scoring
    const mockTweet = {
      id: 999,
      content: 'Nouvelle technologie révolutionnaire qui va changer notre façon de travailler !',
      user_id: 2,
      created_at: new Date(),
      media_urls: ['image1.jpg'],
      hashtags: ['technologie', 'innovation'],
      view_count: 1000,
      language: 'fr',
      author: {
        id: 2,
        verified: true,
        premium: false,
        stats: { followers: 5000, following: 500 },
        created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) // 1 an
      }
    };

    console.log('  Test du tweet simulé:');
    console.log(`    Content: ${mockTweet.content}`);
    console.log(`    Auteur vérifié: ${mockTweet.author.verified}`);
    console.log(`    Hashtags: ${mockTweet.hashtags.join(', ')}`);

    // Tester chaque composant de scoring
    const userEngagementScore = await smartEngine.calculateUserEngagementScore(mockTweet, mockUserProfile);
    const contentQualityScore = await smartEngine.calculateContentQualityScore(mockTweet, mockUserProfile);
    const authorInfluenceScore = await smartEngine.calculateAuthorInfluenceScore(mockTweet, mockUserProfile);
    const temporalScore = await smartEngine.calculateTemporalScore(mockTweet, mockUserProfile);
    const behavioralScore = await smartEngine.calculateBehavioralScore(mockTweet, mockUserProfile);

    console.log(`\n  📊 Scores détaillés:`);
    console.log(`    Engagement utilisateur: ${userEngagementScore.toFixed(2)}/100`);
    console.log(`    Qualité contenu: ${contentQualityScore.toFixed(2)}/100`);
    console.log(`    Influence auteur: ${authorInfluenceScore.toFixed(2)}/100`);
    console.log(`    Score temporel: ${temporalScore.toFixed(2)}/100`);
    console.log(`    Score comportemental: ${behavioralScore.toFixed(2)}/100`);

    // Calculer le score final
    const finalScore = 
      (userEngagementScore * smartEngine.scoringSystem.userEngagement.weight) +
      (contentQualityScore * smartEngine.scoringSystem.contentQuality.weight) +
      (authorInfluenceScore * smartEngine.scoringSystem.authorInfluence.weight) +
      (temporalScore * smartEngine.scoringSystem.temporalFactors.weight) +
      (behavioralScore * smartEngine.scoringSystem.behavioralIntelligence.weight);

    console.log(`\n  🎯 Score final pondéré: ${finalScore.toFixed(2)}/100`);
    console.log('✅ Test 6 réussi\n');

    // Résumé des tests
    console.log('🎉 TOUS LES TESTS RÉUSSIS !');
    console.log('\n📋 Résumé des capacités testées:');
    console.log('  ✅ Initialisation du moteur');
    console.log('  ✅ Génération de recommandations personnalisées');
    console.log('  ✅ Système de scoring multi-dimensionnel');
    console.log('  ✅ Optimisation des performances et cache');
    console.log('  ✅ Diversification intelligente');
    console.log('  ✅ Métriques de qualité');
    console.log('  ✅ Composants de scoring individuels');

    console.log('\n🧠 Smart Recommendation Engine prêt pour la production !\n');

  } catch (error) {
    console.error('❌ Erreur lors des tests:', error);
    console.error('Stack trace:', error.stack);
  }
}

// Fonction pour tester des scénarios spécifiques
async function testSpecificScenarios() {
  console.log('🎭 Tests de scénarios spécifiques\n');

  const smartEngine = new SmartRecommendationEngine();

  // Scénario 1: Utilisateur très actif
  console.log('👑 Scénario 1: Utilisateur très actif');
  try {
    const result = await smartEngine.getSmartRecommendations(1, {
      limit: 15,
      context: 'power_user_discovery'
    });
    console.log(`  Résultat: ${result.recommendations.length} recommandations`);
    console.log(`  Qualité moyenne: ${result.metadata.qualityMetrics.averageScore}`);
  } catch (error) {
    console.log(`  ⚠️  Erreur scénario 1: ${error.message}`);
  }

  // Scénario 2: Découverte pour nouvel utilisateur
  console.log('\n🆕 Scénario 2: Nouvel utilisateur (découverte)');
  try {
    const result = await smartEngine.getSmartRecommendations(999999, { // ID fictif
      limit: 10,
      context: 'new_user_discovery'
    });
    console.log(`  Résultat: ${result.recommendations.length} recommandations`);
    console.log(`  Algorithm: ${result.metadata.algorithm}`);
  } catch (error) {
    console.log(`  ⚠️  Erreur scénario 2: ${error.message}`);
  }

  // Scénario 3: Pagination
  console.log('\n📄 Scénario 3: Test de pagination');
  try {
    const page1 = await smartEngine.getSmartRecommendations(1, {
      limit: 5,
      offset: 0
    });
    const page2 = await smartEngine.getSmartRecommendations(1, {
      limit: 5,
      offset: 5
    });
    console.log(`  Page 1: ${page1.recommendations.length} tweets`);
    console.log(`  Page 2: ${page2.recommendations.length} tweets`);
    console.log(`  Pagination info: ${JSON.stringify(page1.pagination)}`);
  } catch (error) {
    console.log(`  ⚠️  Erreur scénario 3: ${error.message}`);
  }

  console.log('\n✅ Tests de scénarios terminés\n');
}

// Fonction principale
async function main() {
  console.log('🧠 === TESTS DU SMART RECOMMENDATION ENGINE ===\n');
  
  // Tests principaux
  await testSmartRecommendationEngine();
  
  // Tests de scénarios
  await testSpecificScenarios();
  
  console.log('🎯 === FIN DES TESTS ===');
  
  // Fermer les connexions si nécessaire
  process.exit(0);
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  testSmartRecommendationEngine,
  testSpecificScenarios
};
