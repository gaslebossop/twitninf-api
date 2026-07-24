const express = require('express');
const cors = require('cors');
const { body } = require('express-validator');
const { validationResult } = require('express-validator');

// Créer l'application Express
const app = express();

// Middleware de base
app.use(cors());
app.use(express.json());

// Validation
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
    .isEmail()
    .normalizeEmail()
    .withMessage('Email invalide'),
  
  body('phone')
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Numéro de téléphone invalide'),
  
  body('password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Le mot de passe doit contenir au moins 8 caractères, une majuscule, une minuscule, un chiffre et un caractère spécial'),
  
  body('platform')
    .optional()
    .isIn(['ios', 'android', 'web'])
    .withMessage('Plateforme invalide')
];

const loginValidation = [
  body('email')
    .notEmpty()
    .withMessage('Email requis'),
  
  body('password')
    .notEmpty()
    .withMessage('Mot de passe requis')
];

// Contrôleur d'inscription simplifié
async function registerController(req, res) {
  try {
    console.log('🔵 Début inscription');
    
    // Vérifier les erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ Erreurs de validation:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Données invalides',
        errors: errors.array()
      });
    }

    console.log('✅ Validation passée');

    const { username, fullName, email, phone, password, platform } = req.body;
    console.log('📝 Données reçues:', { username, email, platform });

    // Simuler un délai de traitement
    console.log('⏳ Traitement...');
    await new Promise(resolve => setTimeout(resolve, 500));

    // Simuler une réponse réussie
    console.log('✅ Envoi réponse');
    res.status(201).json({
      success: true,
      message: 'Compte créé avec succès',
      data: {
        user: {
          id: 'user-' + Date.now(),
          username,
          full_name: fullName,
          email,
          verified: false,
          premium: false
        },
        token: 'token-' + Date.now(),
        refreshToken: 'refresh-' + Date.now()
      }
    });
    
    console.log('🎉 Inscription terminée');
  } catch (error) {
    console.error('❌ Erreur inscription:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'inscription'
    });
  }
}

// Contrôleur de connexion simplifié
async function loginController(req, res) {
  try {
    console.log('🔵 Début connexion');
    
    // Vérifier les erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ Erreurs de validation:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Données invalides',
        errors: errors.array()
      });
    }

    console.log('✅ Validation passée');

    const { email, password } = req.body;
    console.log('📝 Tentative de connexion:', email);

    // Simuler un délai de traitement
    console.log('⏳ Traitement...');
    await new Promise(resolve => setTimeout(resolve, 500));

    // Simuler une réponse réussie
    console.log('✅ Envoi réponse');
    res.status(200).json({
      success: true,
      message: 'Connexion réussie',
      data: {
        user: {
          id: 'user-' + Date.now(),
          username: 'testuser',
          full_name: 'Test User',
          email,
          verified: false,
          premium: false
        },
        token: 'token-' + Date.now(),
        refreshToken: 'refresh-' + Date.now()
      }
    });
    
    console.log('🎉 Connexion terminée');
  } catch (error) {
    console.error('❌ Erreur connexion:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la connexion'
    });
  }
}

// Routes
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Serveur simple opérationnel',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/auth/register', registerValidation, registerController);
app.post('/api/auth/login', loginValidation, loginController);

// Route de test
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'Route de test fonctionnelle',
    routes: {
      health: '/api/health',
      register: '/api/auth/register',
      login: '/api/auth/login'
    }
  });
});

// Gestion des erreurs 404
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route non trouvée',
    path: req.originalUrl
  });
});

// Démarrer le serveur
const PORT = 3003;
app.listen(PORT, () => {
  console.log(`🚀 Serveur simple démarré sur http://localhost:${PORT}`);
  console.log('📋 Routes disponibles:');
  console.log('   - GET  /api/health');
  console.log('   - POST /api/auth/register');
  console.log('   - POST /api/auth/login');
  console.log('   - GET  /api/test');
});

module.exports = app;
