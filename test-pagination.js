/**
 * 🧪 Test de Pagination des Tweets - TwitNin Legacy
 * 
 * Teste que la pagination retourne le bon nombre de tweets
 * et le bon total dans la base de données
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
 * Test de la pagination des tweets
 */
async function testPagination() {
  try {
    logger.info('🧪 Début du test de pagination...');

    // 1. Compter le total de tweets dans la base
    const totalTweetsInDB = await Tweet.count({
      where: {
        is_private: false,
        deleted_at: null,
        moderation_status: 'approved'
      }
    });

    logger.info(`📊 Total de tweets dans la base: ${totalTweetsInDB}`);

    // 2. Tester la route de récupération des tweets
    const response = await fetch(`http://localhost:${TEST_CONFIG.port}/api/tweets?limit=${TEST_CONFIG.limit}&offset=${TEST_CONFIG.offset}&sort=latest`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(`API error: ${data.message}`);
    }

    const { tweets, pagination } = data.data;

    logger.info(`📋 Tweets récupérés: ${tweets.length}`);
    logger.info(`📊 Pagination:`, pagination);

    // 3. Vérifications
    const checks = [];

    // Vérifier que le total correspond à la base de données
    if (pagination.total === totalTweetsInDB) {
      checks.push('✅ Total correct dans la pagination');
    } else {
      checks.push(`❌ Total incorrect: ${pagination.total} vs ${totalTweetsInDB} dans la DB`);
    }

    // Vérifier que la limite est respectée
    if (tweets.length <= TEST_CONFIG.limit) {
      checks.push('✅ Limite respectée');
    } else {
      checks.push(`❌ Limite dépassée: ${tweets.length} > ${TEST_CONFIG.limit}`);
    }

    // Vérifier que hasMore est correct
    const expectedHasMore = TEST_CONFIG.offset + tweets.length < pagination.total;
    if (pagination.hasMore === expectedHasMore) {
      checks.push('✅ hasMore correct');
    } else {
      checks.push(`❌ hasMore incorrect: ${pagination.hasMore} vs ${expectedHasMore}`);
    }

    // 4. Test avec différents offsets
    logger.info('🧪 Test avec différents offsets...');
    
    for (let offset = 0; offset < Math.min(50, pagination.total); offset += TEST_CONFIG.limit) {
      const offsetResponse = await fetch(`http://localhost:${TEST_CONFIG.port}/api/tweets?limit=${TEST_CONFIG.limit}&offset=${offset}&sort=latest`);
      
      if (offsetResponse.ok) {
        const offsetData = await offsetResponse.json();
        if (offsetData.success) {
          const offsetTweets = offsetData.data.tweets;
          const offsetPagination = offsetData.data.pagination;
          
          logger.info(`📋 Offset ${offset}: ${offsetTweets.length} tweets, hasMore: ${offsetPagination.hasMore}`);
          
          // Vérifier que hasMore est correct pour cet offset
          const expectedOffsetHasMore = offset + offsetTweets.length < offsetPagination.total;
          if (offsetPagination.hasMore !== expectedOffsetHasMore) {
            logger.warn(`⚠️ hasMore incorrect pour offset ${offset}: ${offsetPagination.hasMore} vs ${expectedOffsetHasMore}`);
          }
        }
      }
    }

    // 5. Résumé des vérifications
    logger.info('📋 Résumé des vérifications:');
    checks.forEach(check => logger.info(check));

    const successCount = checks.filter(check => check.includes('✅')).length;
    const totalChecks = checks.length;

    logger.info(`🎯 Résultat: ${successCount}/${totalChecks} vérifications réussies`);

    if (successCount === totalChecks) {
      logger.info('🎉 Test de pagination réussi !');
    } else {
      logger.error('❌ Test de pagination échoué !');
    }

    return successCount === totalChecks;

  } catch (error) {
    logger.error('❌ Erreur lors du test de pagination:', error);
    return false;
  }
}

/**
 * Test de la pagination avec recommandations
 */
async function testRecommendationPagination() {
  try {
    logger.info('🧪 Test de pagination avec recommandations...');

    const response = await fetch(`http://localhost:${TEST_CONFIG.port}/api/tweets?limit=${TEST_CONFIG.limit}&offset=${TEST_CONFIG.offset}&sort=recommended`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(`API error: ${data.message}`);
    }

    const { tweets, pagination } = data.data;

    logger.info(`📋 Tweets recommandés récupérés: ${tweets.length}`);
    logger.info(`📊 Pagination recommandations:`, pagination);

    // Vérifier que le total est cohérent
    if (pagination.total > 0) {
      logger.info('✅ Total des recommandations cohérent');
    } else {
      logger.warn('⚠️ Total des recommandations à 0');
    }

    return true;

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
    logger.info('🚀 Démarrage du test de pagination...');

    // Attendre que l'API soit prête
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Tests
    const paginationSuccess = await testPagination();
    const recommendationSuccess = await testRecommendationPagination();

    if (paginationSuccess && recommendationSuccess) {
      logger.info('🎉 Tous les tests de pagination sont réussis !');
      process.exit(0);
    } else {
      logger.error('❌ Certains tests de pagination ont échoué !');
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
  testPagination,
  testRecommendationPagination
};

