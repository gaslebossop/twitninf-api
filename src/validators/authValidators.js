const { body, validationResult } = require('express-validator');
const { isValidEmail, isValidPhone, isValidUsername, isValidPassword } = require('../utils/helpers');

/**
 * Middleware pour gérer les erreurs de validation
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Erreurs de validation',
      errors: errors.array().map(error => ({
        field: error.path,
        message: error.msg,
        value: error.value
      }))
    });
  }
  next();
};

/**
 * Validation pour l'inscription
 */
const registerValidation = [
  body('fullName')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Le nom complet doit contenir entre 2 et 100 caractères')
    .matches(/^[a-zA-ZÀ-ÿ\s'-]+$/)
    .withMessage('Le nom complet ne peut contenir que des lettres, espaces, tirets et apostrophes'),

  body('username')
    .trim()
    .isLength({ min: 3, max: 30 })
    .withMessage('Le nom d\'utilisateur doit contenir entre 3 et 30 caractères')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Le nom d\'utilisateur ne peut contenir que des lettres, chiffres et underscores')
    .custom(value => {
      if (!isValidUsername(value)) {
        throw new Error('Format de nom d\'utilisateur invalide');
      }
      return true;
    }),



  body('password')
    .isLength({ min: 7 })
    .withMessage('Le mot de passe doit contenir au moins 7 caractères'),

  body('confirmPassword')
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error('Les mots de passe ne correspondent pas');
      }
      return true;
    })
];

/**
 * Validation pour la connexion
 */
const loginValidation = [
  body('username')
    .trim()
    .notEmpty()
    .withMessage('Le nom d\'utilisateur est requis')
    .isLength({ min: 3 })
    .withMessage('Le nom d\'utilisateur doit contenir au moins 3 caractères'),

  body('password')
    .notEmpty()
    .withMessage('Le mot de passe est requis')
    .isLength({ min: 1 })
    .withMessage('Le mot de passe est requis')
];

/**
 * Validation pour le changement de mot de passe
 */
const changePasswordValidation = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Le mot de passe actuel est requis'),

  body('newPassword')
    .isLength({ min: 7 })
    .withMessage('Le nouveau mot de passe doit contenir au moins 7 caractères'),

  body('confirmNewPassword')
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error('Les nouveaux mots de passe ne correspondent pas');
      }
      return true;
    })
];

/**
 * Validation pour la réinitialisation du mot de passe
 */
const resetPasswordValidation = [
  body('email')
    .trim()
    .toLowerCase()
    .isEmail()
    .withMessage('Format d\'email invalide')
    .normalizeEmail()
];

/**
 * Validation pour la confirmation de réinitialisation
 */
const confirmResetPasswordValidation = [
  body('token')
    .notEmpty()
    .withMessage('Le token de réinitialisation est requis'),

  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Le nouveau mot de passe doit contenir au moins 8 caractères')
    .custom(value => {
      if (!isValidPassword(value)) {
        throw new Error('Le nouveau mot de passe doit contenir au moins 8 caractères, 1 majuscule, 1 minuscule et 1 chiffre');
      }
      return true;
    }),

  body('confirmNewPassword')
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error('Les nouveaux mots de passe ne correspondent pas');
      }
      return true;
    })
];

/**
 * Validation pour la mise à jour du profil
 */
const updateProfileValidation = [
  body('fullName')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Le nom complet doit contenir entre 2 et 100 caractères')
    .matches(/^[a-zA-ZÀ-ÿ\s'-]+$/)
    .withMessage('Le nom complet ne peut contenir que des lettres, espaces, tirets et apostrophes'),

  body('avatar')
    .optional()
    .isURL()
    .withMessage('L\'avatar doit être une URL valide'),

  body('preferences.language')
    .optional()
    .isIn(['fr', 'en', 'es', 'de'])
    .withMessage('La langue doit être fr, en, es ou de'),

  body('preferences.theme')
    .optional()
    .isIn(['light', 'dark', 'auto'])
    .withMessage('Le thème doit être light, dark ou auto'),

  body('preferences.notifications.push')
    .optional()
    .isBoolean()
    .withMessage('La préférence de notification push doit être un booléen'),

  body('preferences.notifications.email')
    .optional()
    .isBoolean()
    .withMessage('La préférence de notification email doit être un booléen'),

  body('preferences.notifications.sms')
    .optional()
    .isBoolean()
    .withMessage('La préférence de notification SMS doit être un booléen')
];

/**
 * Validation pour le refresh token
 */
const refreshTokenValidation = [
  body('refreshToken')
    .notEmpty()
    .withMessage('Le refresh token est requis')
];

module.exports = {
  registerValidation,
  loginValidation,
  changePasswordValidation,
  resetPasswordValidation,
  confirmResetPasswordValidation,
  updateProfileValidation,
  refreshTokenValidation,
  handleValidationErrors
};
