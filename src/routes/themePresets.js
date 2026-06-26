/**
 * Routes pour les presets de thèmes d'événements
 */

const express = require('express');
const router = express.Router();
const ThemePresetService = require('../services/themePresetService');
const { authenticateToken, requireAdmin } = require('../middleware/authMiddleware');

/**
 * GET /api/theme-presets
 * Obtient la liste de tous les presets de thèmes disponibles
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const presets = ThemePresetService.getAvailablePresets();
    
    res.json({
      success: true,
      data: presets,
      message: 'Presets de thèmes récupérés avec succès'
    });
  } catch (error) {
    console.error('❌ Erreur lors de la récupération des presets:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des presets de thèmes'
    });
  }
});

/**
 * GET /api/theme-presets/:themeId
 * Obtient un preset de thème spécifique
 */
router.get('/:themeId', authenticateToken, async (req, res) => {
  try {
    const { themeId } = req.params;
    
    if (!ThemePresetService.isValidPreset(themeId)) {
      return res.status(404).json({
        success: false,
        message: 'Preset de thème non trouvé'
      });
    }
    
    const preset = ThemePresetService.getPresetById(themeId);
    
    res.json({
      success: true,
      data: preset,
      message: 'Preset de thème récupéré avec succès'
    });
  } catch (error) {
    console.error('❌ Erreur lors de la récupération du preset:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du preset de thème'
    });
  }
});

/**
 * GET /api/theme-presets/:themeId/preview
 * Obtient les informations de preview d'un thème
 */
router.get('/:themeId/preview', authenticateToken, async (req, res) => {
  try {
    const { themeId } = req.params;
    
    if (!ThemePresetService.isValidPreset(themeId)) {
      return res.status(404).json({
        success: false,
        message: 'Preset de thème non trouvé'
      });
    }
    
    const preview = ThemePresetService.getThemePreview(themeId);
    
    res.json({
      success: true,
      data: preview,
      message: 'Preview du thème récupéré avec succès'
    });
  } catch (error) {
    console.error('❌ Erreur lors de la récupération du preview:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du preview du thème'
    });
  }
});

module.exports = router;
