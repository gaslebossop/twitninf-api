const models = require('../src/models');
const videoRecommendationService = require('../src/services/videoRecommendationService');
const logger = require('../src/utils/logger');

async function testPagination() {
  try {
    logger.info('🧪 Testing Video Recommendation Pagination & Force Reload...');
    await videoRecommendationService.initialize(models);
    
    const users = await models.User.findAll({ limit: 1, attributes: ['id'] });
    if (users.length === 0) {
      logger.warn('⚠️ No users found.');
      process.exit(0);
    }
    
    const userId = users[0].id;
    
    // Page 1
    logger.info(`📄 Fetching Page 1 (offset=0, limit=2) for ${userId}`);
    const page1 = videoRecommendationService.recommend(userId, { limit: 2, offset: 0 });
    logger.info('Page 1 IDs:', page1.map(r => r.videoId).join(', '));
    
    // Page 2
    logger.info(`📄 Fetching Page 2 (offset=2, limit=2) for ${userId}`);
    const page2 = videoRecommendationService.recommend(userId, { limit: 2, offset: 2 });
    logger.info('Page 2 IDs:', page2.map(r => r.videoId).join(', '));
    
    // Force Refresh
    logger.info(`🔄 Testing Force Refresh (forceRefresh=true, limit=2)`);
    const refresh = videoRecommendationService.recommend(userId, { limit: 2, offset: 0, forceRefresh: true });
    logger.info('Refresh IDs:', refresh.map(r => r.videoId).join(', '));
    
    // Check for duplicates
    const p1Ids = new Set(page1.map(r => r.videoId));
    const p2Ids = new Set(page2.map(r => r.videoId));
    const intersection = [...p1Ids].filter(id => p2Ids.has(id));
    
    if (intersection.length === 0) {
      logger.info('✅ Pagination works (no overlap between P1 and P2)');
    } else {
      logger.warn('⚠️ Intersection found between P1 and P2:', intersection);
    }
    
    process.exit(0);
  } catch (error) {
    logger.error('❌ Test failed:', error);
    process.exit(1);
  }
}

testPagination();
