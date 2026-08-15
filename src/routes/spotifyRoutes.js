const express = require('express');
const { query, validationResult } = require('express-validator');
const router = express.Router();

const { authenticateToken } = require('../middleware/authMiddleware');
const spotifyService = require('../services/spotifyService');
const logger = require('../utils/logger');

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Données invalides',
      errors: errors.array(),
    });
  }
  next();
};

/**
 * GET /api/spotify/search
 * Recherche de morceaux, pour le sélecteur de musique du composeur de tweet.
 */
router.get(
  '/search',
  [
    authenticateToken,
    query('q').trim().notEmpty().withMessage('Le terme de recherche est requis'),
    query('limit').optional().isInt({ min: 1, max: 10 }).withMessage('limit doit être entre 1 et 10'),
    handleValidationErrors,
  ],
  async (req, res) => {
    if (!spotifyService.isConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'La recherche Spotify n\'est pas configurée sur ce serveur',
      });
    }

    try {
      const tracks = await spotifyService.searchTracks(req.query.q, {
        limit: req.query.limit ? parseInt(req.query.limit, 10) : 8,
      });
      return res.json({ success: true, data: { tracks } });
    } catch (error) {
      logger.error('Erreur recherche Spotify:', error.message);
      return res.status(502).json({
        success: false,
        message: 'Impossible de contacter Spotify pour le moment',
      });
    }
  }
);

module.exports = router;
