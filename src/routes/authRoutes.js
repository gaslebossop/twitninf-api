const express = require('express');
const { body, validationResult } = require('express-validator');
const authController = require('../controllers/authController');
const { 
  authenticateToken, 
  requireVerified, 
  requirePremium,
  logAuthenticatedRequest,
  updateLastActivity,
  userRateLimit,
  checkPlatform
} = require('../middleware/authMiddleware');
const { checkUserBanStrict, checkUserBanReadOnly } = require('../middleware/banMiddleware');
const { checkLogin, reportLoginOutcome } = require('../middleware/fraudMiddleware');

const router = express.Router();

// Validation schemas
const registerValidation = [
  body('username')
    .isLength({ min: 3, max: 30 })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Le nom d\'utilisateur doit contenir entre 3 et 30 caractères et ne peut contenir que des lettres, chiffres et underscores'),
  
  body('fullName')
    .isLength({ min: 2, max: 100 })
    .trim()
    .withMessage('Le nom complet doit contenir entre 2 et 100 caractères'),
  
  body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Email invalide'),
  
  body('phone')
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Numéro de téléphone invalide'),
  
  body('password')
    .isLength({ min: 7 })
    .withMessage('Le mot de passe doit contenir au moins 7 caractères'),
  
  body('platform')
    .optional()
    .isIn(['ios', 'android', 'web'])
    .withMessage('Plateforme invalide')
];

const loginValidation = [
  body('username')
    .notEmpty()
    .withMessage('Nom d\'utilisateur requis'),
  
  body('password')
    .notEmpty()
    .withMessage('Mot de passe requis')
];

const forgotPasswordValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Email invalide')
];

const resetPasswordValidation = [
  body('password')
    .isLength({ min: 7 })
    .withMessage('Le mot de passe doit contenir au moins 7 caractères')
];

const refreshTokenValidation = [
  body('refreshToken')
    .notEmpty()
    .withMessage('Token de rafraîchissement requis')
];

const updateProfileValidation = [
  body('username')
    .optional()
    .isLength({ min: 3, max: 30 })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Le nom d\'utilisateur doit contenir entre 3 et 30 caractères et ne peut contenir que des lettres, chiffres et underscores'),
  
  body('full_name')
    .optional()
    .isLength({ min: 2, max: 100 })
    .trim()
    .withMessage('Le nom complet doit contenir entre 2 et 100 caractères'),

  body('bio')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('La bio ne peut pas dépasser 500 caractères'),
  
  body('avatar')
    .optional()
    .isURL()
    .withMessage('URL d\'avatar invalide'),
  
  body('preferences')
    .optional()
    .isObject()
    .withMessage('Préférences invalides'),

  body('is_private_account')
    .optional()
    .isBoolean()
    .withMessage('is_private_account doit être un booléen')
];

const demographicsValidation = [
  body('declaredAge')
    .isInt({ min: 13, max: 120 })
    .withMessage('L\'age doit etre compris entre 13 et 120 ans'),
  body('birthDay')
    .isInt({ min: 1, max: 31 })
    .withMessage('Jour de naissance invalide'),
  body('birthMonth')
    .isInt({ min: 1, max: 12 })
    .withMessage('Mois de naissance invalide'),
];

const sessionLocationValidation = [
  body('captureKey')
    .isString()
    .trim()
    .isLength({ min: 12, max: 180 })
    .withMessage('Identifiant de capture invalide'),
  body('permissionStatus')
    .isIn(['granted', 'denied', 'restricted', 'unavailable'])
    .withMessage('Statut de permission invalide'),
  body('latitude').optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
  body('longitude').optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
  body('accuracy').optional({ nullable: true }).isFloat({ min: 0, max: 100000 }),
  body('countryCode').optional({ nullable: true }).isString().isLength({ min: 2, max: 2 }),
  body('country').optional({ nullable: true }).isString().isLength({ max: 100 }),
  body('region').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('city').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('timezone').optional({ nullable: true }).isString().isLength({ max: 64 }),
  body('capturedAt').optional({ nullable: true }).isISO8601(),
  body().custom((value) => {
    if (value.permissionStatus === 'granted' &&
        (value.latitude == null || value.longitude == null)) {
      throw new Error('Les coordonnees sont requises quand la permission est accordee');
    }
    return true;
  }),
];

const changePasswordValidation = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Mot de passe actuel requis'),
  
  body('newPassword')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Le nouveau mot de passe doit contenir au moins 8 caractères, une majuscule, une minuscule, un chiffre et un caractère spécial')
];

// Routes publiques - Version simplifiée pour test
router.post('/register', registerValidation, (req, res, next) => {
  // Vérifier les erreurs de validation
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Données d\'inscription invalides',
      errors: errors.array()
    });
  }

  console.log('🔵 Middleware checkPlatform pour register');
  req.userPlatform = req.headers['user-platform'] || req.body.platform || 'web';
  next();
}, authController.register);

router.post('/login', loginValidation, checkLogin(), async (req, res, next) => {
  try {
    // Vérifier les erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Identifiants requis',
        errors: errors.array()
      });
    }

    console.log('🔵 Middleware checkPlatform pour login');
    req.userPlatform = req.headers['user-platform'] || req.body.platform || 'web';
    
    // Vérifier manuellement si l'utilisateur est banni/suspendu
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Nom d\'utilisateur et mot de passe requis'
      });
    }
    
    // Importer le modèle User
    const User = require('../models/User');
    
    // Rechercher l'utilisateur
    const user = await User.findOne({
      where: { username, is_active: true }
    });
    
    if (user) {
      // Vérifier le mot de passe
      const isValidPassword = await user.comparePassword(password);
      
      if (isValidPassword) {
        // Vérifier le statut de ban (mais permettre le login pour voir is_suspended=true)
        if (user.is_suspended) {
          console.log(`⚠️ Utilisateur banni tentant de se connecter: ${user.username}`);
          // On permet le login mais on indique is_suspended=true dans la réponse
          // Le middleware global bloquera ensuite les autres routes
        }

        // Reporter le succès au service fraude (fire-and-forget)
        reportLoginOutcome(true)(req, res, () => {});

        // Si l'utilisateur n'est pas suspendu, continuer avec le contrôleur normal
        next();
      } else {
        // Mot de passe incorrect — reporter l'échec au service fraude
        reportLoginOutcome(false)(req, res, () => {});
        return res.status(401).json({
          success: false,
          message: 'Nom d\'utilisateur ou mot de passe incorrect'
        });
      }
    } else {
      // Utilisateur non trouvé — également un échec
      reportLoginOutcome(false)(req, res, () => {});
      return res.status(401).json({
        success: false,
        message: 'Nom d\'utilisateur ou mot de passe incorrect'
      });
    }
  } catch (error) {
    console.error('❌ Erreur lors de la vérification du ban:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification du compte'
    });
  }
}, authController.login);
router.post('/refresh', refreshTokenValidation, authController.refreshToken); // Route corrigée
router.post('/forgot-password', forgotPasswordValidation, authController.forgotPassword);
router.post('/reset-password/:token', resetPasswordValidation, authController.resetPassword);
router.get('/verify-email/:token', authController.verifyEmail);

// Routes protégées
router.use(authenticateToken, logAuthenticatedRequest, updateLastActivity, userRateLimit(200));

// Vérifier les bans pour toutes les routes protégées
router.use(checkUserBanReadOnly);

router.post('/logout', authController.logout);
router.get('/me', authController.getProfile); // Route /me pour l'utilisateur actuel
router.get('/profile', authController.getProfile); // Route alternative
router.put('/profile', updateProfileValidation, authController.updateProfile);
router.put('/demographics', demographicsValidation, authController.updateDemographics);
router.post('/session-location', sessionLocationValidation, authController.recordSessionLocation);
router.put('/change-password', changePasswordValidation, authController.changePassword);
router.get('/verify-auth', authController.verifyAuth);

// Appareils connectés — liste et révocation à distance
router.get('/sessions', authController.listSessions);
router.delete('/sessions/:id', authController.revokeSession);

// Routes premium (nécessitent un compte premium)
router.get('/premium-features', requirePremium, (req, res) => {
  res.json({
    success: true,
    message: 'Fonctionnalités premium accessibles',
    features: [
      'Analytics avancées',
      'Support prioritaire',
      'Fonctionnalités exclusives'
    ]
  });
});

// Routes vérifiées (nécessitent un compte vérifié)
router.get('/verified-features', requireVerified, (req, res) => {
  res.json({
    success: true,
    message: 'Fonctionnalités vérifiées accessibles',
    features: [
      'Publication de contenu',
      'Commentaires',
      'Messages privés'
    ]
  });
});

// Route de test pour les performances
router.get('/performance-test', (req, res) => {
  const startTime = process.hrtime.bigint();
  
  // Simulation d'une opération
  setTimeout(() => {
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1000000; // en millisecondes
    
    res.json({
      success: true,
      message: 'Test de performance réussi',
      duration: `${duration.toFixed(2)}ms`,
      timestamp: new Date().toISOString(),
      user: req.user ? {
        id: req.user.id,
        username: req.user.username
      } : null
    });
  }, 10);
});

// Route pour les statistiques utilisateur
router.get('/stats', (req, res) => {
  res.json({
    success: true,
    stats: {
      accountAge: req.user ? req.user.accountAge : null,
      activityStatus: req.user ? req.user.activityStatus : null,
      lastActivity: req.user ? req.user.last_activity : null
    }
  });
});

// Route pour rechercher des utilisateurs
router.get('/search', (req, res) => {
  const { query, limit = 10 } = req.query;
  
  if (!query) {
    return res.status(400).json({
      success: false,
      message: 'Paramètre de recherche requis'
    });
  }

  // Cette route sera implémentée avec la logique de recherche
  res.json({
    success: true,
    message: 'Recherche d\'utilisateur',
    query,
    limit: parseInt(limit)
  });
});

// Route pour les utilisateurs populaires
router.get('/popular', (req, res) => {
  const { limit = 10 } = req.query;
  
  // Cette route sera implémentée avec la logique des utilisateurs populaires
  res.json({
    success: true,
    message: 'Utilisateurs populaires',
    limit: parseInt(limit)
  });
});

// Gestion des erreurs 404 pour les routes d'authentification
router.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route d\'authentification non trouvée',
    path: req.originalUrl
  });
});

module.exports = router;
