const logger = require('../utils/logger');

// Middleware pour vérifier si un utilisateur est banni
const checkUserBan = async (req, res, next) => {
  try {
    // Vérifier si l'utilisateur est authentifié
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        message: 'Utilisateur non authentifié'
      });
    }

    const user = req.user;

    // Vérifier si l'utilisateur est suspendu
    if (user.is_suspended) {
      // Vérifier si la suspension est temporaire et expirée
      if (user.suspended_until && new Date() > new Date(user.suspended_until)) {
        // La suspension est expirée, la réactiver
        try {
          await user.update({
            is_suspended: false,
            suspended_until: null,
            suspension_reason: null
          });
          logger.info(`Suspension expirée pour l'utilisateur ${user.username}`);
        } catch (updateError) {
          logger.error('Erreur lors de la réactivation automatique:', updateError);
        }
      } else {
        // L'utilisateur est toujours suspendu
        const remainingTime = user.suspended_until 
          ? Math.ceil((new Date(user.suspended_until) - new Date()) / (1000 * 60 * 60 * 24))
          : null;

        return res.status(403).json({
          success: false,
          message: 'Votre compte est temporairement suspendu',
          ban_info: {
            reason: user.suspension_reason || 'Violation des conditions d\'utilisation',
            suspended_at: user.suspended_at,
            suspended_until: user.suspended_until,
            remaining_days: remainingTime
          }
        });
      }
    }

    // Vérifier le nombre de bans (si trop de bans, bannir définitivement)
    if (user.ban_count >= 5) {
      return res.status(403).json({
        success: false,
        message: 'Votre compte a été banni définitivement pour violations répétées',
        ban_info: {
          reason: 'Nombre maximum de violations atteint',
          ban_count: user.ban_count,
          permanent: true
        }
      });
    }

    next();
  } catch (error) {
    logger.error('Erreur dans le middleware de vérification des bans:', error);
    next(error);
  }
};

// Middleware pour les routes sensibles (création, modification, suppression)
const checkUserBanStrict = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        message: 'Utilisateur non authentifié'
      });
    }

    const user = req.user;

    // DEBUG: Log des informations de l'utilisateur
    console.log('🔍 DEBUG Middleware Ban - Utilisateur:', {
      id: user.id,
      username: user.username,
      is_suspended: user.is_suspended,
      suspension_reason: user.suspension_reason
    });

    // Blocage total pour les utilisateurs suspendus/bannis
    if (user.is_suspended) {
      console.log('🚫 Utilisateur BANNI détecté - Blocage de l\'action');
      
      const message = 'Action non autorisée - Compte banni';
      const reason = user.suspension_reason || 'Violation des conditions d\'utilisation';

      console.log('📝 Message de blocage:', message);
      console.log('📝 Raison:', reason);

      return res.status(403).json({
        success: false,
        message: message,
        ban_info: {
          suspended: user.is_suspended,
          reason: reason,
          suspended_until: user.suspended_until,
          remaining_days: user.suspended_until ? Math.ceil((new Date(user.suspended_until) - new Date()) / (1000 * 60 * 60 * 24)) : null
        }
      });
    }

    console.log('✅ Utilisateur AUTORISÉ - Passage au middleware suivant');
    next();
  } catch (error) {
    console.error('❌ Erreur dans le middleware strict de vérification des bans:', error);
    logger.error('Erreur dans le middleware strict de vérification des bans:', error);
    next(error);
  }
};

// Middleware pour les routes de lecture seule (peut permettre l'accès aux utilisateurs suspendus)
const checkUserBanReadOnly = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        message: 'Utilisateur non authentifié'
      });
    }

    const user = req.user;

    // Seuls les bannis permanents sont bloqués en lecture
    if (user.ban_count >= 5) {
      return res.status(403).json({
        success: false,
        message: 'Accès refusé - Compte banni définitivement'
      });
    }

    next();
  } catch (error) {
    logger.error('Erreur dans le middleware de lecture des bans:', error);
    next(error);
  }
};

module.exports = {
  checkUserBan,        // Vérification générale
  checkUserBanStrict,  // Blocage total pour les actions sensibles
  checkUserBanReadOnly // Blocage partiel pour la lecture
};
