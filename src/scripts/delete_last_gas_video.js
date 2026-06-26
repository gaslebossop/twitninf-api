const { User, Tweet } = require('../models');
const logger = require('../utils/logger');

/**
 * Script to delete the last tweet of type 'video' for user '@gas'.
 */
async function deleteLastGasVideo() {
  try {
    logger.info('🚀 Starting deletion script for @gas last video tweet...');

    // 1. Find user 'gas'
    const user = await User.findOne({
      where: { username: 'gas' }
    });

    if (!user) {
      logger.error('❌ User "gas" not found.');
      process.exit(1);
    }

    logger.info(`👤 User found: ${user.username} (${user.id})`);

    // 2. Find the most recent tweet of type 'video'
    const lastVideo = await Tweet.findOne({
      where: {
        user_id: user.id,
        tweet_type: 'video'
      },
      order: [['created_at', 'DESC']]
    });

    if (!lastVideo) {
      logger.info('ℹ️ No video tweet found for user "gas".');
      process.exit(0);
    }

    logger.info(`🔍 Found video tweet: ${lastVideo.id}`);
    logger.info(`📝 Content: "${lastVideo.content}"`);

    // 3. Delete the tweet (soft delete by default as Tweet model is paranoid)
    await lastVideo.destroy();

    logger.info(`✅ Successfully deleted tweet ${lastVideo.id}.`);
    
    // Log if it was a soft delete
    const checkDeleted = await Tweet.findByPk(lastVideo.id, { paranoid: false });
    if (checkDeleted && checkDeleted.deleted_at) {
      logger.info(`ℹ️ The deletion was a soft delete (deleted_at: ${checkDeleted.deleted_at})`);
    }

    process.exit(0);
  } catch (error) {
    logger.error('❌ Error during deletion:', error);
    process.exit(1);
  }
}

deleteLastGasVideo();
