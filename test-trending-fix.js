const TrendingAnalysisService = require('./src/services/trendingAnalysisService');
const logger = require('./src/utils/logger');

async function testTrendingFix() {
  try {
    logger.info('🧪 Test de correction du service d\'analyse des tendances...');
    
    // Initialiser le service
    const trendingService = new TrendingAnalysisService();
    await trendingService.initialize();
    
    // Attendre un peu pour l'initialisation
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // Dernières 24h
    
    // Test 1: Analyse des hashtags tendance
    logger.info('🔍 Test 1: Analyse des hashtags tendance...');
    try {
      const hashtags = await trendingService.analyzeTrendingHashtags(cutoffTime, 10);
      logger.info(`✅ Hashtags tendance: ${hashtags.length} résultats`);
      
      if (hashtags.length > 0) {
        logger.info('🔍 Premier hashtag tendance:', {
          hashtag: hashtags[0].hashtags?.[0],
          tweetCount: hashtags[0].tweetCount,
          totalEngagement: hashtags[0].totalEngagement
        });
      }
    } catch (error) {
      logger.error('❌ Erreur dans l\'analyse des hashtags:', error);
    }
    
    // Test 2: Analyse des catégories tendance
    logger.info('🔍 Test 2: Analyse des catégories tendance...');
    try {
      const categories = await trendingService.analyzeTrendingCategories(cutoffTime, 10);
      logger.info(`✅ Catégories tendance: ${categories.length} résultats`);
      
      if (categories.length > 0) {
        logger.info('🔍 Première catégorie tendance:', {
          name: categories[0].name,
          tweetCount: categories[0].tweetCount,
          trendScore: categories[0].trendScore
        });
      }
    } catch (error) {
      logger.error('❌ Erreur dans l\'analyse des catégories:', error);
    }
    
    // Test 3: Analyse complète des tendances
    logger.info('🔍 Test 3: Analyse complète des tendances...');
    try {
      const trends = await trendingService.analyzeTrends({
        timeWindow: 24,
        includeViral: true,
        includeTopics: true,
        includeMomentum: true
      });
      
      logger.info(`✅ Analyse complète: ${Object.keys(trends).length} sections`);
      logger.info('📊 Résumé des tendances:', {
        totalTrends: trends.summary?.totalTrends || 0,
        viralCount: trends.summary?.viralCount || 0,
        topTrendingTopic: trends.summary?.topTrendingTopic || 'Aucun'
      });
      
    } catch (error) {
      logger.error('❌ Erreur dans l\'analyse complète:', error);
    }
    
    logger.info('🎉 Tests terminés avec succès !');
    
  } catch (error) {
    logger.error('❌ Erreur lors du test:', error);
  }
}

// Exécuter le test
testTrendingFix().then(() => {
  logger.info('🏁 Test terminé');
  process.exit(0);
}).catch((error) => {
  logger.error('💥 Erreur fatale:', error);
  process.exit(1);
});
