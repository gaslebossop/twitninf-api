const authService = require('../services/authService');
const logger = require('../utils/logger');
const User = require('../models/User');
const { isTrustedFirstPartyClient } = require('./fraudMiddleware');

// Middleware pour vérifier l'authentification
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token d\'accès requis'
      });
    }

    // Vérifier le token
    const decoded = authService.verifyToken(token);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: 'Token invalide'
      });
    }

    // Ajouter les informations utilisateur à la requête
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Erreur d\'authentification:', error);
    return res.status(401).json({
      success: false,
      message: 'Token invalide'
    });
  }
};

// Middleware pour vérifier l'authentification de manière optionnelle
const optionalAuthenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      // Pas de token = pas d'utilisateur connecté, mais on continue
      req.user = null;
      return next();
    }

    // Vérifier le token
    const decoded = authService.verifyToken(token);
    if (!decoded) {
      // Token invalide = pas d'utilisateur connecté, mais on continue
      req.user = null;
      return next();
    }

    // Ajouter les informations utilisateur à la requête
    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Erreur d\'authentification optionnelle:', error);
    // En cas d'erreur = pas d'utilisateur connecté, mais on continue
    req.user = null;
    next();
  }
};

// Middleware pour vérifier si l'utilisateur est vérifié
const requireVerified = async (req, res, next) => {
  try {
    if (!req.user.verified) {
      return res.status(403).json({
        success: false,
        message: 'Compte non vérifié. Veuillez vérifier votre email.'
      });
    }
    next();
  } catch (error) {
    logger.error('Erreur de vérification:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification'
    });
  }
};

// Middleware pour vérifier si l'utilisateur a un abonnement payant actif (Plus ou Pro)
const requirePremium = async (req, res, next) => {
  try {
    const { maybeExpireSubscription } = require('../utils/subscriptionHelpers');
    const { TIER } = require('../constants/subscriptionTiers');
    const u = await User.findByPk(req.user.id, {
      attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at']
    });
    if (!u) {
      return res.status(401).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }
    await maybeExpireSubscription(u);
    await u.reload({
      attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at']
    });
    if (u.subscription_tier === TIER.FREE || !u.premium) {
      return res.status(403).json({
        success: false,
        message: 'Abonnement Plus ou Pro requis pour accéder à cette fonctionnalité'
      });
    }
    next();
  } catch (error) {
    logger.error('Erreur de vérification premium:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification premium'
    });
  }
};

/** Réservé au palier Pro (après expiration éventuelle). */
const requirePro = async (req, res, next) => {
  try {
    const { maybeExpireSubscription } = require('../utils/subscriptionHelpers');
    const { TIER } = require('../constants/subscriptionTiers');
    const u = await User.findByPk(req.user.id, {
      attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at']
    });
    if (!u) {
      return res.status(401).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }
    await maybeExpireSubscription(u);
    await u.reload({
      attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at']
    });
    if (u.subscription_tier !== TIER.PRO || !u.premium) {
      return res.status(403).json({
        success: false,
        message: 'Abonnement Pro requis pour accéder à cette fonctionnalité'
      });
    }
    next();
  } catch (error) {
    logger.error('Erreur de vérification abonnement Pro:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification de l\'abonnement Pro'
    });
  }
};

// Middleware pour vérifier les permissions d'administrateur
const requireAdmin = async (req, res, next) => {
  try {
    // Vérifier si l'utilisateur a le rôle admin ou superadmin
    const isAdmin = req.user.isAdmin || 
                   req.user.role === 'admin' || 
                   req.user.role === 'superadmin' ||
                   req.user.role === 'super_admin';
    
    if (!isAdmin) {
      logger.warn(`Accès admin refusé pour user=${req.user?.id}`);
      return res.status(403).json({
        success: false,
        message: 'Accès administrateur requis'
      });
    }
    next();
  } catch (error) {
    logger.error('Erreur de vérification admin:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification des permissions'
    });
  }
};

// Middleware pour vérifier la propriété de la ressource
const requireOwnership = (resourceField = 'userId') => {
  return async (req, res, next) => {
    try {
      const resourceUserId = req.params[resourceField] || req.body[resourceField];
      
      if (!resourceUserId) {
        return res.status(400).json({
          success: false,
          message: 'ID de ressource manquant'
        });
      }

      if (req.user.id !== resourceUserId) {
        return res.status(403).json({
          success: false,
          message: 'Accès non autorisé à cette ressource'
        });
      }

      next();
    } catch (error) {
      logger.error('Erreur de vérification de propriété:', error);
      return res.status(500).json({
        success: false,
        message: 'Erreur lors de la vérification des permissions'
      });
    }
  };
};

// Middleware pour logger les requêtes authentifiées
const logAuthenticatedRequest = (req, res, next) => {
  logger.info('Requête authentifiée', {
    method: req.method,
    path: req.path,
    userId: req.user?.id,
    username: req.user?.username,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
};

// Middleware pour mettre à jour la dernière activité
const updateLastActivity = async (req, res, next) => {
  try {
    if (req.user && req.user.id) {
      // Mettre à jour la dernière activité en arrière-plan
      setImmediate(async () => {
        try {
          const UserModel = require('../models/User');
          const user = await UserModel.findByPk(req.user.id);
          if (user) {
            // Détecter l'application iOS native (hors Expo Go)
            const platform = req.headers['user-platform']?.toLowerCase();
            const ownership = req.headers['x-app-ownership']?.toLowerCase();
            
            if (platform === 'ios' && ownership === 'standalone' && !user.is_ios_native) {
              await user.update({ is_ios_native: true });
              logger.info(`🍎 Badge iOS native attribué à @${user.username}`);
            }

            await user.updateLastActivity();
          }
        } catch (error) {
          logger.error('Erreur lors de la mise à jour de la dernière activité:', error);
        }
      });
    }
    next();
  } catch (error) {
    logger.error('Erreur dans updateLastActivity:', error);
    next();
  }
};

// Middleware pour vérifier la limite de taux par utilisateur.
// Un client first-party authentifié (app mobile, desktop Windows) n'est pas
// compté ici : ce compteur en mémoire, générique par route, appliquait le
// même quota (200/15min) à `/api/auth/me`, appelé à chaque focus d'écran par
// l'app. C'est désormais le moteur anti-fraude — calibré sur la cadence réelle
// de l'app — qui surveille ce trafic. Les routes sensibles (login/register)
// ne passent pas par ce middleware et gardent leur propre limiteur strict.
const userRateLimit = (maxRequests = 100, windowMs = 15 * 60 * 1000) => {
  const userRequests = new Map();

  return (req, res, next) => {
    if (!req.user || !req.user.id) {
      return next();
    }

    if (isTrustedFirstPartyClient(req)) {
      return next();
    }

    const userId = req.user.id;
    const now = Date.now();
    const userData = userRequests.get(userId) || { count: 0, resetTime: now + windowMs };

    // Réinitialiser le compteur si la fenêtre de temps est écoulée
    if (now > userData.resetTime) {
      userData.count = 0;
      userData.resetTime = now + windowMs;
    }

    userData.count++;

    if (userData.count > maxRequests) {
      return res.status(429).json({
        success: false,
        message: 'Trop de requêtes. Veuillez réessayer plus tard.'
      });
    }

    userRequests.set(userId, userData);
    next();
  };
};

// Middleware pour vérifier la plateforme
const checkPlatform = (allowedPlatforms = ['ios', 'android', 'web']) => {
  return (req, res, next) => {
    const platform = req.headers['user-platform'] || req.body.platform || 'web';
    
    if (!allowedPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message: `Plateforme non supportée. Plateformes autorisées: ${allowedPlatforms.join(', ')}`
      });
    }

    req.userPlatform = platform;
    next();
  };
};

// Middleware: refuser l'accès aux utilisateurs suspendus
const denySuspended = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Non authentifié' });
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Utilisateur inconnu' });
    }
    if (user.is_suspended || user.is_active === false) {
      // Suspension temporaire expirée ?
      if (user.suspended_until && new Date(user.suspended_until) < new Date()) {
        user.is_suspended = false;
        user.is_active = true;
        user.suspended_until = null;
        await user.save();
        return next();
      }
      return res.status(403).json({ success: false, message: 'Compte suspendu' });
    }
    return next();
  } catch (e) {
    logger.warn('denySuspended error:', e?.message || e);
    return res.status(500).json({ success: false, message: 'Erreur vérification suspension' });
  }
};

// Middleware pour vérifier les rôles de modération
const normalizeRole = (role) => {
  if (role === 'moderator') return 'moderateur';
  if (role === 'super_admin' || role === 'supermoderateur') return 'superadmin';
  return role;
};

const getEffectiveModerationUser = async (req) => {
  const dbUser = req.user?.id
    ? await User.findByPk(req.user.id, {
      attributes: ['id', 'role', 'moderation_permissions']
    })
    : null;

  return {
    ...req.user,
    role: dbUser?.role || req.user?.role,
    moderation_permissions: dbUser?.moderation_permissions || req.user?.moderation_permissions || {}
  };
};

const requireModeratorRole = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentification requise'
      });
    }

    const effectiveUser = await getEffectiveModerationUser(req);
    req.user = effectiveUser;

    const allowedRoles = ['moderateur', 'admin', 'superadmin'];
    if (!allowedRoles.includes(normalizeRole(effectiveUser.role))) {
      return res.status(403).json({
        success: false,
        message: 'Accès refusé. Rôle de modérateur requis.'
      });
    }

    next();
  } catch (error) {
    logger.error('Erreur de vérification du rôle modérateur:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification des permissions'
    });
  }
};

const requireAdminRole = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentification requise'
      });
    }

    const effectiveUser = await getEffectiveModerationUser(req);
    req.user = effectiveUser;

    const allowedRoles = ['admin', 'superadmin'];
    if (!allowedRoles.includes(normalizeRole(effectiveUser.role))) {
      return res.status(403).json({
        success: false,
        message: 'Accès refusé. Rôle d\'administrateur requis.'
      });
    }

    next();
  } catch (error) {
    logger.error('Erreur de vérification du rôle admin:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification des permissions'
    });
  }
};

const requireSuperAdminRole = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentification requise'
      });
    }

    const effectiveUser = await getEffectiveModerationUser(req);
    req.user = effectiveUser;

    if (normalizeRole(effectiveUser.role) !== 'superadmin') {
      return res.status(403).json({
        success: false,
        message: 'Accès refusé. Rôle de super administrateur requis.'
      });
    }

    next();
  } catch (error) {
    logger.error('Erreur de vérification du rôle super admin:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification des permissions'
    });
  }
};

const requireClasseurRole = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentification requise'
      });
    }

    const effectiveUser = await getEffectiveModerationUser(req);
    req.user = effectiveUser;

    const allowedRoles = ['classeurdetweets', 'moderateur', 'admin', 'superadmin'];
    if (!allowedRoles.includes(normalizeRole(effectiveUser.role))) {
      return res.status(403).json({
        success: false,
        message: 'Accès refusé. Rôle de classeur de tweets requis.'
      });
    }

    next();
  } catch (error) {
    logger.error('Erreur de vérification du rôle classeur:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification des permissions'
    });
  }
};

const requireEconomyRole = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentification requise'
      });
    }

    const effectiveUser = await getEffectiveModerationUser(req);
    req.user = effectiveUser;

    const allowedRoles = ['moderateur', 'economiegardien', 'admin', 'superadmin'];
    if (!allowedRoles.includes(normalizeRole(effectiveUser.role))) {
      return res.status(403).json({
        success: false,
        message: 'Accès refusé. Rôle de Gardien de l\'Économie requis.'
      });
    }

    next();
  } catch (error) {
    logger.error('Erreur de vérification du rôle économie:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification des permissions'
    });
  }
};

// Middleware pour vérifier des permissions spécifiques
const requirePermission = (permission) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'Authentification requise'
        });
      }

      // Les superadmins ont toutes les permissions
      const effectiveUser = await getEffectiveModerationUser(req);
      req.user = effectiveUser;

      if (normalizeRole(effectiveUser.role) === 'superadmin') {
        return next();
      }

      // Vérifier la permission spécifique
      if (!effectiveUser.moderation_permissions || !effectiveUser.moderation_permissions[permission]) {
        return res.status(403).json({
          success: false,
          message: `Permission '${permission}' requise`
        });
      }

      next();
    } catch (error) {
      logger.error(`Erreur de vérification de la permission ${permission}:`, error);
      return res.status(500).json({
        success: false,
        message: 'Erreur lors de la vérification des permissions'
      });
    }
  };
};

module.exports = {
  authenticateToken,
  optionalAuthenticateToken,
  requireVerified,
  requirePremium,
  requirePro,
  requireAdmin,
  requireOwnership,
  logAuthenticatedRequest,
  updateLastActivity,
  userRateLimit,
  checkPlatform,
  denySuspended,
  requireModeratorRole,
  requireAdminRole,
  requireSuperAdminRole,
  requireClasseurRole,
  requireEconomyRole,
  requirePermission
};
