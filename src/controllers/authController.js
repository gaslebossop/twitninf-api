const authService = require('../services/authService');
const { validationResult } = require('express-validator');
const logger = require('../utils/logger');

class AuthController {
  // Inscription d'un utilisateur
  async register(req, res) {
    try {
      // Vérifier les erreurs de validation
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { username, fullName, password, platform } = req.body;

      const result = await authService.register({
        username,
        fullName,
        password,
        platform: platform || 'android'
      });

      res.status(201).json(result);
    } catch (error) {
      logger.error('Erreur dans register:', error);
      
      if (error.message.includes('existe déjà')) {
        return res.status(409).json({
          success: false,
          message: error.message
        });
      }

      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'inscription'
      });
    }
  }

  // Connexion d'un utilisateur
  async login(req, res) {
    try {
      // Vérifier les erreurs de validation
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { username, password } = req.body;

      const result = await authService.login({
        username,
        password
      });

      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans login:', error);
      
      if (error.message.includes('Identifiants invalides')) {
        return res.status(401).json({
          success: false,
          message: 'Nom d\'utilisateur ou mot de passe incorrect'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Erreur lors de la connexion'
      });
    }
  }

  // Rafraîchir un token
  async refreshToken(req, res) {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'Token de rafraîchissement requis'
        });
      }

      const result = await authService.refreshToken(refreshToken);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans refreshToken:', error);
      
      if (error.message.includes('invalide')) {
        return res.status(401).json({
          success: false,
          message: 'Token de rafraîchissement invalide'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Erreur lors du rafraîchissement du token'
      });
    }
  }

  // Déconnexion
  async logout(req, res) {
    try {
      const userId = req.user.id;
      const result = await authService.logout(userId);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans logout:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la déconnexion'
      });
    }
  }

  // Vérifier l'email
  async verifyEmail(req, res) {
    try {
      const { token } = req.params;

      if (!token) {
        return res.status(400).json({
          success: false,
          message: 'Token de vérification requis'
        });
      }

      const result = await authService.verifyEmail(token);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans verifyEmail:', error);
      
      if (error.message.includes('invalide')) {
        return res.status(400).json({
          success: false,
          message: 'Token de vérification invalide'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Erreur lors de la vérification de l\'email'
      });
    }
  }

  // Demander la réinitialisation du mot de passe
  async forgotPassword(req, res) {
    try {
      // Vérifier les erreurs de validation
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Email invalide',
          errors: errors.array()
        });
      }

      const { email } = req.body;

      const result = await authService.forgotPassword(email);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans forgotPassword:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la demande de réinitialisation'
      });
    }
  }

  // Réinitialiser le mot de passe
  async resetPassword(req, res) {
    try {
      // Vérifier les erreurs de validation
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { token } = req.params;
      const { password } = req.body;

      if (!token) {
        return res.status(400).json({
          success: false,
          message: 'Token de réinitialisation requis'
        });
      }

      const result = await authService.resetPassword(token, password);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans resetPassword:', error);
      
      if (error.message.includes('invalide') || error.message.includes('expiré')) {
        return res.status(400).json({
          success: false,
          message: error.message
        });
      }

      res.status(500).json({
        success: false,
        message: 'Erreur lors de la réinitialisation du mot de passe'
      });
    }
  }

  // Obtenir le profil utilisateur
  async getProfile(req, res) {
    try {
      const userId = req.user.id;
      const result = await authService.getProfile(userId);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans getProfile:', error);
      
      if (error.message.includes('non trouvé')) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération du profil'
      });
    }
  }

  // Mettre à jour le profil utilisateur
  async updateProfile(req, res) {
    try {
      // Vérifier les erreurs de validation
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const userId = req.user.id;
      const updateData = req.body;

      const result = await authService.updateProfile(userId, updateData);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans updateProfile:', error);
      
      if (error.message.includes('déjà pris')) {
        return res.status(409).json({
          success: false,
          message: error.message
        });
      }

      if (error.message.includes('non trouvé')) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Erreur lors de la mise à jour du profil'
      });
    }
  }

  // Changer le mot de passe
  async changePassword(req, res) {
    try {
      // Vérifier les erreurs de validation
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const userId = req.user.id;
      const { currentPassword, newPassword } = req.body;

      const result = await authService.changePassword(userId, currentPassword, newPassword);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans changePassword:', error);
      
      if (error.message.includes('incorrect')) {
        return res.status(400).json({
          success: false,
          message: 'Mot de passe actuel incorrect'
        });
      }

      if (error.message.includes('non trouvé')) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Erreur lors du changement de mot de passe'
      });
    }
  }

  // Vérifier l'authentification
  async verifyAuth(req, res) {
    try {
      const userId = req.user.id;
      const result = await authService.getProfile(userId);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans verifyAuth:', error);
      res.status(401).json({
        success: false,
        message: 'Token d\'authentification invalide'
      });
    }
  }
}

module.exports = new AuthController();
