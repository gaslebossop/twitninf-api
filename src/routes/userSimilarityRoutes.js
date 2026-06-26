const express = require('express');
const userSimilarityService = require('../services/userSimilarityService');
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * @route GET /api/user-similarity/similar/:userId
 * @desc Get similar users based on interactions
 * @access Public/Private (depending on requirements, keeping it public-ish for now if userId provided)
 */
router.get('/similar/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 10;
    
    const similarUsers = await userSimilarityService.findSimilarUsers(userId, limit);
    
    return res.json({
      success: true,
      data: similarUsers
    });
  } catch (error) {
    logger.error(`❌ Error fetching similar users for ${req.params.userId}:`, error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch similar users'
    });
  }
});

/**
 * @route POST /api/user-similarity/sync
 * @desc Manually trigger a sync of similarity data (Admin only)
 * @access Private (Admin)
 */
const { requireAdminRole } = require('../middleware/authMiddleware');
router.post('/sync', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const count = await userSimilarityService.syncAllUsers();
    return res.json({
      success: true,
      message: `Sync complete. Processed ${count} users.`
    });
  } catch (error) {
    logger.error('❌ Error during manual similarity sync:', error);
    return res.status(500).json({
      success: false,
      message: 'Sync failed'
    });
  }
});

/**
 * @route POST /api/user-similarity/reload
 * @desc Force reload vectors from disk into memory
 */
router.post('/reload', async (req, res) => {
  try {
    await userSimilarityService.initialize(true);
    return res.json({
      success: true,
      message: 'Index rechargé en mémoire.'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Reload failed' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = userSimilarityService.getStats();
    return res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

module.exports = router;
