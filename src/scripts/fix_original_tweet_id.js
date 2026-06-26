const { Tweet } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

/**
 * Script to fix missing original_tweet_id in existing nested replies.
 * This ensures that the new thread-fetching logic can find all descendants.
 */
async function fixOriginalTweetId() {
  try {
    logger.info('🚀 Starting data fix: original_tweet_id...');

    // Find all replies that don't have an original_tweet_id
    const replies = await Tweet.findAll({
      where: {
        parent_tweet_id: { [Op.ne]: null },
        original_tweet_id: null
      }
    });

    logger.info(`🔍 Found ${replies.length} replies needing original_tweet_id.`);

    let fixedCount = 0;
    
    for (const reply of replies) {
      let rootId = null;
      let currentParentId = reply.parent_tweet_id;
      let safetyBreak = 0;
      
      // Traverse up the chain to find the Root (Tweet or Video)
      while (currentParentId && safetyBreak < 20) {
        rootId = currentParentId;
        const parent = await Tweet.findByPk(currentParentId, { attributes: ['id', 'parent_tweet_id', 'original_tweet_id'] });
        
        if (!parent) {
          logger.warn(`⚠️  Parent not found for tweet ${rootId}, using as root.`);
          break;
        }

        // If parent already has an original_tweet_id, use it and stop
        if (parent.original_tweet_id) {
          rootId = parent.original_tweet_id;
          break;
        }
        
        if (!parent.parent_tweet_id) {
          // Found the root
          rootId = parent.id;
          break;
        }
        
        currentParentId = parent.parent_tweet_id;
        safetyBreak++;
      }

      if (rootId && rootId !== reply.id) {
        await reply.update({ original_tweet_id: rootId });
        fixedCount++;
        if (fixedCount % 10 === 0) {
          logger.info(`✅ Progress: ${fixedCount}/${replies.length} fixed.`);
        }
      }
    }

    logger.info(`✨ Successfully fixed original_tweet_id for ${fixedCount} replies.`);
    process.exit(0);
  } catch (error) {
    logger.error('❌ Error during fix:', error);
    process.exit(1);
  }
}

fixOriginalTweetId();
