const express = require('express');
const { body } = require('express-validator');
const { validationResult } = require('express-validator');

// Créer une application Express simple
const app = express();
app.use(express.json());

// Validation simple
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

// Contrôleur d'inscription simplifié
async function registerController(req, res) {
  try {
    console.log('1. Début du contrôleur register');
    
    // Vérifier les erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('2. Erreurs de validation:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Données invalides',
        errors: errors.array()
      });
    }

    console.log('3. Validation passée');

    const { username, fullName, email, phone, password, platform } = req.body;
    console.log('4. Données extraites:', { username, email, platform });

    // Simuler un délai pour tester
    console.log('5. Simulation d\'un délai...');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Simuler une réponse réussie
    console.log('6. Envoi de la réponse');
    res.status(201).json({
      success: true,
      message: 'Compte créé avec succès (simulation)',
      data: {
        user: {
          id: 'test-id-' + Date.now(),
          username,
          full_name: fullName,
          email,
          verified: false,
          premium: false
        },
        token: 'test-token-' + Date.now(),
        refreshToken: 'test-refresh-token-' + Date.now()
      }
    });
    
    console.log('7. Réponse envoyée avec succès');
  } catch (error) {
    console.error('❌ Erreur dans registerController:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'inscription'
    });
  }
}

// Route de test
app.post('/api/auth/register', registerValidation, registerController);

// Route de santé
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Test controller opérationnel'
  });
});

// Démarrer le serveur
const PORT = 3002;
app.listen(PORT, () => {
  console.log(`🧪 Serveur de test contrôleur démarré sur http://localhost:${PORT}`);
  console.log('Testez avec: POST http://localhost:3002/api/auth/register');
});

module.exports = app;
