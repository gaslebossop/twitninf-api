/**
 * Service pour gérer les presets de thèmes d'événements
 */

const { getEventTheme } = require('../themes/eventThemes');

class ThemePresetService {
  /**
   * Obtient la liste de tous les presets de thèmes disponibles
   */
  static getAvailablePresets() {
    const themeIds = ['valentine', 'halloween', 'christmas', 'newyear', 'easter'];
    
    return themeIds.map(themeId => {
      const theme = getEventTheme(themeId);
      if (!theme) return null;
      
      return {
        id: themeId,
        name: theme.name,
        description: theme.description,
        icon: theme.icon,
        colors: theme.colors,
        effects: theme.effects,
        preview: {
          primaryColor: theme.colors.primary,
          secondaryColor: theme.colors.secondary,
          accentColor: theme.colors.accent,
          backgroundColor: theme.colors.background,
        }
      };
    }).filter(Boolean);
  }

  /**
   * Obtient un preset de thème par son ID
   */
  static getPresetById(themeId) {
    const theme = getEventTheme(themeId);
    if (!theme) return null;
    
    return {
      id: themeId,
      name: theme.name,
      description: theme.description,
      icon: theme.icon,
      colors: theme.colors,
      effects: theme.effects,
      animations: theme.animations,
      gradients: theme.gradients,
      preview: {
        primaryColor: theme.colors.primary,
        secondaryColor: theme.colors.secondary,
        accentColor: theme.colors.accent,
        backgroundColor: theme.colors.background,
      }
    };
  }

  /**
   * Valide qu'un preset de thème existe
   */
  static isValidPreset(themeId) {
    const theme = getEventTheme(themeId);
    return theme !== null;
  }

  /**
   * Obtient les informations de preview d'un thème
   */
  static getThemePreview(themeId) {
    const theme = getEventTheme(themeId);
    if (!theme) return null;
    
    return {
      id: themeId,
      name: theme.name,
      description: theme.description,
      icon: theme.icon,
      primaryColor: theme.colors.primary,
      secondaryColor: theme.colors.secondary,
      accentColor: theme.colors.accent,
      backgroundColor: theme.colors.background,
      hasGlow: theme.effects.glow,
      hasShimmer: theme.effects.shimmer,
      hasPulse: theme.effects.pulse,
      hasParticles: theme.effects.particles,
      hasSparkles: theme.effects.sparkles,
    };
  }
}

module.exports = ThemePresetService;
