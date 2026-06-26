const logger = require('../utils/logger');

// Middleware global pour bloquer tous les utilisateurs bannis
// sauf sur les routes de login et notifications
const globalBanCheck = async (req, res, next) => {
  try {
    // Routes autorisées pour les utilisateurs bannis
    const allowedPaths = [
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/refresh',
      '/api/auth/logout',
      '/api/notifications', // Notifications autorisées
      '/api/health',
      '/api/status'
    ];

    // Vérifier si la route est autorisée
    const isAllowedPath = allowedPaths.some(path => req.path.startsWith(path));
    
    if (isAllowedPath) {
      return next(); // Autoriser l'accès aux routes autorisées
    }

    // Vérifier si l'utilisateur est authentifié
    if (!req.user || !req.user.id) {
      return next(); // Laisser passer si pas authentifié (sera géré par authenticateToken)
    }

    const user = req.user;

    // Vérifier si l'utilisateur est suspendu/banni
    if (user.is_suspended) {
      logger.info(`🚫 Accès bloqué pour utilisateur banni: ${user.username} sur ${req.path}`);
      
      // Calculer les jours restants si suspension temporaire
      const remainingTime = user.suspended_until 
        ? Math.ceil((new Date(user.suspended_until) - new Date()) / (1000 * 60 * 60 * 24))
        : null;

      return res.status(403).json({
        success: false,
        message: 'Accès refusé - Compte banni',
        ban_info: {
          reason: user.suspension_reason || 'Violation des conditions d\'utilisation',
          suspended_at: user.suspended_at,
          suspended_until: user.suspended_until,
          remaining_days: remainingTime,
          is_suspended: true
        }
      });
    }

    // Utilisateur non banni, continuer
    next();
  } catch (error) {
    logger.error('Erreur dans le middleware global de ban:', error);
    next(error);
  }
};

module.exports = {
  globalBanCheck
};
