/**
 * 🧪 Test de Pagination des Recommandations - TwitNin Legacy
 * 
 * Teste que la pagination des recommandations fonctionne correctement
 * avec le nouveau système de pagination automatique
 * 
 * @author TwitNin Team
 * @version 1.0.0
 */

const express = require('express');
const { Op } = require('sequelize');
const { User, Tweet } = require('./src/models');
const logger = require('./src/utils/logger');

// Configuration de test
const TEST_CONFIG = {
  port: 3001,
  testUserId: 'test-user-123',
  limit: 10,
  offset: 0
};

// Créer une app Express pour tester les routes
const app = express();
app.use(express.json());

// Middleware pour simuler l'authentification
app.use((req, res, next) => {
  req.user = { id: TEST_CONFIG.testUserId };
  next();
});

/**
 * Test de la pagination des recommandations
 */
async function testRecommendationPagination() {
  try {
    logger.info('🧪 Test de la pagination des recommandations...');

    // 1. Compter le total de tweets dans la base
    const totalTweetsInDB = await Tweet.count({
      where: {
        is_private: false,
        deleted_at: null,
        moderation_status: 'approved'
      }
    });

    logger.info(`📊 Total de tweets dans la base: ${totalTweetsInDB}`);

    // 2. Tester la route des recommandations avec pagination
    logger.info('📱 Test de la route des recommandations...');
    
    const recResponse = await fetch(`http://localhost:${TEST_CONFIG.port}/api/recommendations?limit=${TEST_CONFIG.limit}&offset=${TEST_CONFIG.offset}&algorithm=ultra_hybrid`);
    
    if (!recResponse.ok) {
      throw new Error(`HTTP ${recResponse.status}: ${recResponse.statusText}`);
    }

    const recData = await recResponse.json();
    
    if (!recData.success) {
      throw new Error(`API error: ${recData.message}`);
    }

    const { recommendations, pagination } = recData.data;
    
    logger.info(`📋 Recommandations récupérées: ${recommendations.length}`);
    logger.info(`📊 Pagination recommandations:`, pagination);

    // 3. Tester la route des tweets recommandés avec pagination
    logger.info('📱 Test de la route des tweets recommandés...');
    
    const tweetsResponse = await fetch(`http://localhost:${TEST_CONFIG.port}/api/recommendations/tweets?limit=${TEST_CONFIG.limit}&offset=${TEST_CONFIG.offset}&algorithm=ultra_hybrid&type=all&sort=recommended`);
    
    if (!tweetsResponse.ok) {
      throw new Error(`HTTP ${tweetsResponse.status}: ${tweetsResponse.statusText}`);
    }

    const tweetsData = await tweetsResponse.json();
    
    if (!tweetsData.success) {
      throw new Error(`API error: ${tweetsData.message}`);
    }

    const { tweets, pagination: tweetsPagination } = tweetsData.data;
    
    logger.info(`📋 Tweets recommandés récupérés: ${tweets.length}`);
    logger.info(`📊 Pagination tweets recommandés:`, tweetsPagination);

    // 4. Vérifications
    const checks = [];

    // Vérifier que les recommandations ont une pagination cohérente
    if (pagination.total > 0) {
      checks.push('✅ Total des recommandations cohérent');
    } else {
      checks.push(`❌ Total des recommandations à 0`);
    }

    // Vérifier que les tweets recommandés ont une pagination cohérente
    if (tweetsPagination.total > 0) {
      checks.push('✅ Total des tweets recommandés cohérent');
    } else {
      checks.push(`❌ Total des tweets recommandés à 0`);
    }

    // Vérifier que hasMore est correct
    if (pagination.hasMore === (pagination.offset + recommendations.length < pagination.total)) {
      checks.push('✅ hasMore des recommandations correct');
    } else {
      checks.push(`❌ hasMore des recommandations incorrect`);
    }

    if (tweetsPagination.hasMore === (tweetsPagination.offset + tweets.length < tweetsPagination.total)) {
      checks.push('✅ hasMore des tweets recommandés correct');
    } else {
      checks.push(`❌ hasMore des tweets recommandés incorrect`);
    }

    // 5. Test avec différents offsets
    logger.info('🧪 Test avec différents offsets...');
    
    for (let offset = 0; offset < Math.min(50, Math.max(pagination.total, tweetsPagination.total)); offset += TEST_CONFIG.limit) {
      logger.info(`📱 Test offset ${offset}...`);
      
      // Test recommandations
      const offsetRecResponse = await fetch(`http://localhost:${TEST_CONFIG.port}/api/recommendations?limit=${TEST_CONFIG.limit}&offset=${offset}&algorithm=ultra_hybrid`);
      if (offsetRecResponse.ok) {
        const offsetRecData = await offsetRecResponse.json();
        if (offsetRecData.success) {
          const offsetRecs = offsetRecData.data.recommendations;
          const offsetRecPagination = offsetRecData.data.pagination;
          
          logger.info(`📋 Offset ${offset} recommandations: ${offsetRecs.length} résultats, hasMore: ${offsetRecPagination.hasMore}`);
        }
      }
      
      // Test tweets recommandés
      const offsetTweetsResponse = await fetch(`http://localhost:${TEST_CONFIG.port}/api/recommendations/tweets?limit=${TEST_CONFIG.limit}&offset=${offset}&algorithm=ultra_hybrid`);
      if (offsetTweetsResponse.ok) {
        const offsetTweetsData = await offsetTweetsResponse.json();
        if (offsetTweetsData.success) {
          const offsetTweets = offsetTweetsData.data.tweets;
          const offsetTweetsPagination = offsetTweetsData.data.pagination;
          
          logger.info(`📋 Offset ${offset} tweets: ${offsetTweets.length} résultats, hasMore: ${offsetTweetsPagination.hasMore}`);
        }
      }
      
      // Simuler un délai
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // 6. Résumé des vérifications
    logger.info('📋 Résumé des vérifications:');
    checks.forEach(check => logger.info(check));

    const successCount = checks.filter(check => check.includes('✅')).length;
    const totalChecks = checks.length;

    logger.info(`🎯 Résultat: ${successCount}/${totalChecks} vérifications réussies`);

    if (successCount === totalChecks) {
      logger.info('🎉 Test de pagination des recommandations réussi !');
    } else {
      logger.error('❌ Test de pagination des recommandations échoué !');
    }

    return successCount === totalChecks;

  } catch (error) {
    logger.error('❌ Erreur lors du test de pagination des recommandations:', error);
    return false;
  }
}

/**
 * Point d'entrée principal
 */
async function main() {
  try {
    logger.info('🚀 Démarrage du test de pagination des recommandations...');

    // Attendre que l'API soit prête
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test
    const success = await testRecommendationPagination();

    if (success) {
      logger.info('🎉 Test de pagination des recommandations réussi !');
      process.exit(0);
    } else {
      logger.error('❌ Test de pagination des recommandations échoué !');
      process.exit(1);
    }

  } catch (error) {
    logger.error('❌ Erreur fatale lors du test:', error);
    process.exit(1);
  }
}

// Démarrer le test
if (require.main === module) {
  main();
}

module.exports = {
  testRecommendationPagination
};
