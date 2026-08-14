/**
 * Routes du programme de monétisation
 */

const express = require('express');
const router = express.Router();
const MonetizationProgramController = require('../controllers/monetizationProgramController');
const { authenticateToken, requireAdmin } = require('../middleware/authMiddleware');

router.get('/status', authenticateToken, MonetizationProgramController.getStatus);
router.post('/apply', authenticateToken, MonetizationProgramController.apply);

router.get('/admin/applications', authenticateToken, requireAdmin, MonetizationProgramController.listApplications);
router.post('/admin/applications/:userId/review', authenticateToken, requireAdmin, MonetizationProgramController.reviewApplication);

module.exports = router;
