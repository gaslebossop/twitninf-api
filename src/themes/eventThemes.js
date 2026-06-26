/**
 * Thèmes d'événements pour le backend
 * Version JavaScript des thèmes définis dans le frontend
 */

const eventThemes = {
  valentine: {
    id: 'valentine',
    name: 'Saint-Valentin',
    description: 'Thème romantique de la Saint-Valentin',
    icon: 'heart',
    colors: {
      primary: '#2d1b29',
      secondary: '#ff69b4',
      accent: '#ff1493',
      background: '#1a0f1a',
      surface: '#2d1b29',
      text: '#ffffff',
      textSecondary: '#ffb3d9',
      border: '#ff69b4',
      shadow: '#ff1493',
      error: '#ff4757',
      warning: '#ffa502',
      success: '#43e97b',
    },
    effects: {
      glow: true,
      shimmer: true,
      pulse: true,
      particles: true,
      sparkles: true,
    },
    animations: {
      floating: true,
      pulse: true,
      shimmer: true,
    },
    gradients: {
      primary: ['#2d1b29', '#ff69b4', '#ff1493'],
      secondary: ['#1a0f1a', '#2d1b29', '#ff69b4'],
      accent: ['#ff1493', '#ff69b4', '#ffb3d9'],
    },
  },
  halloween: {
    id: 'halloween',
    name: 'Halloween',
    description: 'Thème Halloween effrayant',
    icon: 'skull',
    colors: {
      primary: '#1a0a00',
      secondary: '#ff4500',
      accent: '#ff6b00',
      background: '#0d0500',
      surface: '#1a0a00',
      text: '#ffffff',
      textSecondary: '#ff8c00',
      border: '#ff4500',
      shadow: '#8b0000',
      error: '#ff4757',
      warning: '#ffa502',
      success: '#43e97b',
    },
    effects: {
      glow: true,
      shimmer: false,
      pulse: true,
      particles: true,
      sparkles: false,
    },
    animations: {
      floating: true,
      pulse: true,
      shimmer: false,
    },
    gradients: {
      primary: ['#1a0a00', '#ff4500', '#ff6b00'],
      secondary: ['#0d0500', '#1a0a00', '#ff4500'],
      accent: ['#ff6b00', '#ff4500', '#ff8c00'],
    },
  },
  christmas: {
    id: 'christmas',
    name: 'Noël',
    description: 'Thème de Noël festif',
    icon: 'gift',
    colors: {
      primary: '#0d4f3c',
      secondary: '#c41e3a',
      accent: '#ffd700',
      background: '#0a2f1f',
      surface: '#0d4f3c',
      text: '#ffffff',
      textSecondary: '#90ee90',
      border: '#c41e3a',
      shadow: '#228b22',
      error: '#ff4757',
      warning: '#ffa502',
      success: '#43e97b',
    },
    effects: {
      glow: true,
      shimmer: true,
      pulse: false,
      particles: true,
      sparkles: true,
    },
    animations: {
      floating: true,
      pulse: false,
      shimmer: true,
    },
    gradients: {
      primary: ['#0d4f3c', '#c41e3a', '#ffd700'],
      secondary: ['#0a2f1f', '#0d4f3c', '#c41e3a'],
      accent: ['#ffd700', '#c41e3a', '#90ee90'],
    },
  },
  newyear: {
    id: 'newyear',
    name: 'Nouvel An',
    description: 'Thème du Nouvel An éclatant',
    icon: 'star',
    colors: {
      primary: '#000015',
      secondary: '#ffd700',
      accent: '#ff6b6b',
      background: '#000008',
      surface: '#000015',
      text: '#ffffff',
      textSecondary: '#4ecdc4',
      border: '#ffd700',
      shadow: '#ff6b6b',
      error: '#ff4757',
      warning: '#ffa502',
      success: '#43e97b',
    },
    effects: {
      glow: true,
      shimmer: true,
      pulse: true,
      particles: true,
      sparkles: true,
    },
    animations: {
      floating: true,
      pulse: true,
      shimmer: true,
    },
    gradients: {
      primary: ['#000015', '#ffd700', '#ff6b6b'],
      secondary: ['#000008', '#000015', '#ffd700'],
      accent: ['#ff6b6b', '#ffd700', '#4ecdc4'],
    },
  },
  easter: {
    id: 'easter',
    name: 'Pâques',
    description: 'Thème de Pâques printanier',
    icon: 'egg',
    colors: {
      primary: '#4a148c',
      secondary: '#e91e63',
      accent: '#ffeb3b',
      background: '#2e1065',
      surface: '#4a148c',
      text: '#ffffff',
      textSecondary: '#f8bbd9',
      border: '#e91e63',
      shadow: '#ffeb3b',
      error: '#ff4757',
      warning: '#ffa502',
      success: '#43e97b',
    },
    effects: {
      glow: true,
      shimmer: true,
      pulse: false,
      particles: true,
      sparkles: true,
    },
    animations: {
      floating: true,
      pulse: false,
      shimmer: true,
    },
    gradients: {
      primary: ['#4a148c', '#e91e63', '#ffeb3b'],
      secondary: ['#2e1065', '#4a148c', '#e91e63'],
      accent: ['#ffeb3b', '#e91e63', '#f8bbd9'],
    },
  },
};

/**
 * Obtient un thème d'événement par son ID
 * @param {string} themeId - ID du thème
 * @returns {Object|null} - Thème ou null si non trouvé
 */
function getEventTheme(themeId) {
  return eventThemes[themeId] || null;
}

/**
 * Obtient tous les thèmes d'événements disponibles
 * @returns {Object} - Tous les thèmes
 */
function getAllEventThemes() {
  return eventThemes;
}

/**
 * Obtient la liste des IDs de thèmes disponibles
 * @returns {string[]} - Liste des IDs
 */
function getAvailableThemeIds() {
  return Object.keys(eventThemes);
}

module.exports = {
  eventThemes,
  getEventTheme,
  getAllEventThemes,
  getAvailableThemeIds,
};
