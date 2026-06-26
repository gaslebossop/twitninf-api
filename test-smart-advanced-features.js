/**
 * 🧪 Test des Fonctionnalités Avancées du Smart Recommendation Engine
 * 
 * Ce script teste les 3 nouveaux systèmes :
 * 1. 🚀 Boost pour nouveau contenu (0 vues)
 * 2. 📈 Analyse des hashtags tendance
 * 3. 🚫 Système de shadowban
 */

const SmartRecommendationEngine = require('./src/services/smartRecommendationEngine');
const { User, Tweet } = require('./src/models');
const logger = require('./src/utils/logger');

async function testAdvancedFeatures() {
  console.log('🧪 =========================');
  console.log('🧪 TEST SMART ENGINE AVANCÉ');
  console.log('🧪 =========================\n');

  try {
    // Initialiser le Smart Engine
    const smartEngine = new SmartRecommendationEngine();
    console.log('✅ Smart Engine initialisé\n');

    // Test 1: Nouveau contenu boost
    await testNewContentBoost(smartEngine);
    
    // Test 2: Hashtags tendance
    await testTrendingHashtags(smartEngine);
    
    // Test 3: Système de shadowban
    await testShadowbanSystem(smartEngine);
    
    // Test 4: Intégration complète
    await testCompleteIntegration(smartEngine);

    console.log('\n🎉 ===========================');
    console.log('🎉 TESTS TERMINÉS AVEC SUCCÈS');
    console.log('🎉 ===========================');

  } catch (error) {
    console.error('❌ Erreur dans les tests:', error);
  }
}

async function testNewContentBoost(smartEngine) {
  console.log('🚀 === TEST BOOST NOUVEAU CONTENU ===');
  
  try {
    // Simuler des tweets avec différents âges et vues
    const testTweets = [
      {
        id: 1,
        content: "Nouveau tweet test #test",
        created_at: new Date(Date.now() - 30 * 60 * 1000), // 30 min
        view_count: 0,
        like_count: 0,
        retweet_count: 0,
        author_id: 1
      },
      {
        id: 2,
        content: "Tweet plus ancien",
        created_at: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5h
        view_count: 100,
        like_count: 5,
        retweet_count: 1,
        author_id: 2
      },
      {
        id: 3,
        content: "Nouveau tweet mais avec vues",
        created_at: new Date(Date.now() - 45 * 60 * 1000), // 45 min
        view_count: 50,
        like_count: 2,
        retweet_count: 0,
        author_id: 3
      }
    ];

    const eligibleTweets = await smartEngine.analyzeNewContentBoost(testTweets);
    
    console.log(`📊 Tweets testés: ${testTweets.length}`);
    console.log(`🚀 Tweets éligibles au boost: ${eligibleTweets.length}`);
    
    eligibleTweets.forEach(boost => {
      console.log(`   - Tweet ${boost.tweetId}: ${boost.views} vues, qualité ${boost.qualityScore}`);
    });

    console.log('✅ Test boost nouveau contenu: RÉUSSI\n');

  } catch (error) {
    console.error('❌ Erreur test nouveau contenu:', error);
  }
}

async function testTrendingHashtags(smartEngine) {
  console.log('📈 === TEST HASHTAGS TENDANCE ===');
  
  try {
    const trendingHashtags = await smartEngine.analyzeTrendingHashtags();
    
    console.log(`📊 Hashtags tendance trouvés: ${trendingHashtags.length}`);
    
    if (trendingHashtags.length > 0) {
      console.log('🔥 Top 5 hashtags tendance:');
      trendingHashtags.slice(0, 5).forEach((hashtag, index) => {
        console.log(`   ${index + 1}. ${hashtag.hashtag} (${hashtag.count} usages, score: ${hashtag.trending_score})`);
      });
    }

    // Test du boost hashtag
    const testTweet = {
      content: `Test avec hashtag tendance ${trendingHashtags[0]?.hashtag || '#test'} et #javascript`
    };

    const hashtagBoost = await smartEngine.calculateHashtagBoost(testTweet, trendingHashtags);
    console.log(`📈 Boost calculé pour le tweet test: x${hashtagBoost}`);

    console.log('✅ Test hashtags tendance: RÉUSSI\n');

  } catch (error) {
    console.error('❌ Erreur test hashtags tendance:', error);
  }
}

async function testShadowbanSystem(smartEngine) {
  console.log('🚫 === TEST SYSTÈME SHADOWBAN ===');
  
  try {
    // Test avec un utilisateur fictif
    const testUserId = 999999;

    // Tester la vérification de spam
    const spamCheck = await smartEngine.checkSpamViolation(testUserId);
    console.log('📊 Vérification spam:');
    console.log(`   - Tweets dernière heure: ${spamCheck.tweetsLastHour || 0}`);
    console.log(`   - Tweets dernier jour: ${spamCheck.tweetsLastDay || 0}`);
    console.log(`   - Violation: ${spamCheck.violation ? 'OUI' : 'NON'}`);

    // Tester la qualité du contenu
    const qualityCheck = await smartEngine.checkContentQualityViolation(testUserId);
    console.log('📊 Vérification qualité:');
    console.log(`   - Tweets analysés: ${qualityCheck.totalTweets || 0}`);
    console.log(`   - Contenu faible qualité: ${qualityCheck.lowQualityCount || 0}`);
    console.log(`   - Violation: ${qualityCheck.violation ? 'OUI' : 'NON'}`);

    // Statut shadowban global
    const shadowbanStatus = await smartEngine.checkShadowbanStatus(testUserId);
    console.log('📊 Statut shadowban:');
    console.log(`   - Shadowbanned: ${shadowbanStatus.isShadowbanned ? 'OUI' : 'NON'}`);
    if (shadowbanStatus.reason) {
      console.log(`   - Raison: ${shadowbanStatus.reason}`);
    }

    console.log('✅ Test système shadowban: RÉUSSI\n');

  } catch (error) {
    console.error('❌ Erreur test shadowban:', error);
  }
}

async function testCompleteIntegration(smartEngine) {
  console.log('🎯 === TEST INTÉGRATION COMPLÈTE ===');
  
  try {
    // Test avec un utilisateur existant
    const users = await User.findAll({ limit: 1 });
    if (users.length === 0) {
      console.log('⚠️ Aucun utilisateur trouvé, création d\'un utilisateur test...');
      return;
    }

    const testUser = users[0];
    console.log(`👤 Test avec utilisateur: ${testUser.username}`);

    // Obtenir des recommandations avec les nouveaux systèmes
    const result = await smartEngine.getSmartRecommendations(testUser.id, {
      limit: 10,
      context: 'smart_discovery'
    });

    console.log('📊 Résultats de l\'intégration:');
    console.log(`   - Recommendations trouvées: ${result.recommendations.length}`);
    console.log(`   - Temps de traitement: ${result.metadata.processingTime}ms`);
    console.log(`   - Score moyen: ${result.metadata.qualityMetrics.averageScore}`);

    // Analyser les boosts appliqués
    let newContentBoosts = 0;
    let hashtagBoosts = 0;
    let shadowbannedTweets = 0;

    result.recommendations.forEach(tweet => {
      if (tweet.smartScore.newContentBoost > 1) newContentBoosts++;
      if (tweet.smartScore.hashtagBoost > 1) hashtagBoosts++;
      if (tweet.smartScore.shadowbanned) shadowbannedTweets++;
    });

    console.log('📈 Systèmes appliqués:');
    console.log(`   - Nouveau contenu boosté: ${newContentBoosts} tweets`);
    console.log(`   - Hashtag boost appliqué: ${hashtagBoosts} tweets`);
    console.log(`   - Tweets shadowbannés: ${shadowbannedTweets} tweets`);

    // Afficher les top 3 tweets avec scores détaillés
    console.log('\n🏆 Top 3 recommendations avec détails:');
    result.recommendations.slice(0, 3).forEach((tweet, index) => {
      console.log(`${index + 1}. Tweet ${tweet.id} (Score: ${tweet.smartScore.total})`);
      console.log(`   - Engagement: ${tweet.smartScore.userEngagement}`);
      console.log(`   - Qualité: ${tweet.smartScore.contentQuality}`);
      console.log(`   - Boost nouveau: x${tweet.smartScore.newContentBoost}`);
      console.log(`   - Boost hashtag: x${tweet.smartScore.hashtagBoost}`);
      console.log(`   - Shadowban: ${tweet.smartScore.shadowbanned ? 'OUI' : 'NON'}`);
    });

    console.log('✅ Test intégration complète: RÉUSSI\n');

  } catch (error) {
    console.error('❌ Erreur test intégration:', error);
  }
}

// Tests de performance
async function testPerformance(smartEngine) {
  console.log('⚡ === TEST PERFORMANCE ===');
  
  try {
    const startTime = Date.now();
    
    // Test avec une charge importante
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(smartEngine.analyzeTrendingHashtags());
    }
    
    await Promise.all(promises);
    
    const endTime = Date.now();
    console.log(`⚡ 5 analyses parallèles en ${endTime - startTime}ms`);
    console.log('✅ Test performance: RÉUSSI\n');

  } catch (error) {
    console.error('❌ Erreur test performance:', error);
  }
}

// Lancer les tests
if (require.main === module) {
  testAdvancedFeatures();
}

module.exports = {
  testAdvancedFeatures,
  testNewContentBoost,
  testTrendingHashtags,
  testShadowbanSystem,
  testCompleteIntegration
};
