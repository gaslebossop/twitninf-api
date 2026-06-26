const models = require('../src/models');
const videoRecommendationService = require('../src/services/videoRecommendationService');
const logger = require('../src/utils/logger');

async function test() {
  try {
    logger.info('🧪 Starting Video Recommendation Service Test...');
    await videoRecommendationService.initialize(models);
    
    const users = await models.User.findAll({ limit: 5, attributes: ['id'] });
    if (users.length > 0) {
      const userId = users[0].id;
      logger.info(`🔍 Getting recommendations for user: ${userId}`);
      const recs = videoRecommendationService.recommend(userId, { limit: 5 });
      logger.info('✅ Recommendations:', JSON.stringify(recs, null, 2));
    } else {
      logger.warn('⚠️ No users found in DB to test recommendations.');
    }
    
    process.exit(0);
  } catch (error) {
    logger.error('❌ Test failed:', error);
    process.exit(1);
  }
}

test();
