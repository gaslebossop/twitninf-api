const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireSuperAdminRole } = require('../middleware/authMiddleware');
const similarity = require('../services/similarity');
const logger = require('../utils/logger');

const router = express.Router();

router.use(authenticateToken);
router.use(requireSuperAdminRole);

router.get('/algorithm', (req, res) => {
  try {
    const config = similarity.getAlgorithmConfig();
    const stats = similarity.getAlgorithmAdminStats();
    if (!config) {
      return res.status(503).json({
        success: false,
        message: 'Moteur similarity indisponible',
      });
    }
    return res.json({
      success: true,
      data: { config, stats },
    });
  } catch (e) {
    logger.error('similarityAdmin GET algorithm:', e);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

const putValidation = [
  body('weights').optional().isObject(),
  body('coldStartWeights').optional().isObject(),
  body('interactionWeights').optional().isObject(),
  body('similarUsersK').optional().isInt({ min: 5, max: 300 }),
  body('discoveryWindowH').optional().isInt({ min: 6, max: 168 }),
  body('discoveryMinRatio').optional().isFloat({ min: 0.02, max: 0.5 }),
  body('collabTweetLimit').optional().isInt({ min: 50, max: 2000 }),
  body('freshnessHalfLifeH').optional().isInt({ min: 1, max: 168 }),
  body('trendingCacheTtlMs').optional().isInt({ min: 30000, max: 3600000 }),
  body('velocityHighThreshold').optional().isFloat({ min: 0.01 }),
  body('velocityMidThreshold').optional().isFloat({ min: 0.01 }),
  body('maxSameAuthorWindow').optional().isInt({ min: 1, max: 10 }),
  body('authorDiversityWindow').optional().isInt({ min: 5, max: 50 }),
  body('adIntensityPct').optional().isInt({ min: 0, max: 500 }),
];

router.put('/algorithm', putValidation, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  try {
    const patch = { ...req.body };
    const result = similarity.applyAlgorithmConfig(patch);
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }
    return res.json({
      success: true,
      message: 'Configuration similarity mise à jour',
      data: result.data,
    });
  } catch (e) {
    logger.error('similarityAdmin PUT algorithm:', e);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

module.exports = router;
