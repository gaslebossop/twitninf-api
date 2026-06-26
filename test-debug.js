const express = require('express');
const { body } = require('express-validator');
const { validationResult } = require('express-validator');

// Créer une application Express simple pour tester
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

// Route de test simple
app.post('/test-register', registerValidation, (req, res) => {
  console.log('1. Validation passée');
  
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

  console.log('3. Données reçues:', req.body);
  
  // Simuler une réponse réussie
  res.status(201).json({
    success: true,
    message: 'Test réussi',
    data: {
      user: {
        id: 'test-id',
        username: req.body.username,
        email: req.body.email
      },
      token: 'test-token',
      refreshToken: 'test-refresh-token'
    }
  });
});

// Route de santé
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Test server opérationnel'
  });
});

// Démarrer le serveur de test
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🧪 Serveur de test démarré sur http://localhost:${PORT}`);
  console.log('Testez avec: POST http://localhost:3001/test-register');
});

module.exports = app;
