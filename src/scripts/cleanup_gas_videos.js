const { User, Tweet } = require('../models');
const logger = require('../utils/logger');

/**
 * Script to delete all video tweets for user '@gas' except the first 3 (oldest).
 */
async function cleanupGasVideos() {
  try {
    logger.info('🚀 Starting cleanup script for @gas video tweets...');

    // 1. Find user 'gas'
    const user = await User.findOne({
      where: { username: 'gas' }
    });

    if (!user) {
      logger.error('❌ User "gas" not found.');
      process.exit(1);
    }

    logger.info(`👤 User found: ${user.username} (${user.id})`);

    // 2. Find all video tweets ordered by creation date (ASC)
    const videos = await Tweet.findAll({
      where: {
        user_id: user.id,
        tweet_type: 'video'
      },
      order: [['created_at', 'ASC']]
    });

    logger.info(`📊 Total video tweets found: ${videos.length}`);

    if (videos.length <= 3) {
      logger.info('ℹ️ Already 3 or fewer video tweets. Nothing to delete.');
      process.exit(0);
    }

    // 3. Identify tweets to delete (all except the first 3)
    const toDelete = videos.slice(3);
    logger.info(`🗑️  Preparing to delete ${toDelete.length} video tweets...`);

    let deletedCount = 0;
    for (const tweet of toDelete) {
      await tweet.destroy();
      deletedCount++;
      logger.info(`✅ Deleted tweet ${tweet.id} (Content: "${tweet.content || 'N/A'}")`);
    }

    logger.info(`✨ Successfully cleaned up ${deletedCount} video tweets.`);
    logger.info(`ℹ️ Remaining video tweets: ${videos.length - deletedCount}`);

    process.exit(0);
  } catch (error) {
    logger.error('❌ Error during cleanup:', error);
    process.exit(1);
  }
}

cleanupGasVideos();
