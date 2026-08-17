const authService = require('../services/authService');
const { validationResult } = require('express-validator');
const logger = require('../utils/logger');
const rustClient = require('../services/rustRecommenderClient');

/**
 * Contexte d'appareil attaché à une session, pour que l'utilisateur puisse
 * identifier ses appareils connectés et en révoquer un à distance.
 */
function sessionContextFrom(req) {
  return {
    deviceId: req.headers['x-device-id'] || req.headers['x-fingerprint'] || null,
    platform: req.headers['user-platform'] || req.userPlatform || null,
    appVersion: req.headers['x-app-version'] || null,
    userAgent: req.headers['user-agent'] || null,
    ip: req.ip || null,
  };
}

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
      }, sessionContextFrom(req));

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
      }, sessionContextFrom(req));

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

      const result = await authService.refreshToken(refreshToken, sessionContextFrom(req));
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
      // Le refresh token identifie la session à révoquer : sans lui, les
      // autres appareils/comptes resteraient inutilement connectés ou, à
      // l'inverse, seraient coupés à tort.
      const result = await authService.logout(userId, req.body?.refreshToken || null);
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

      // Frein de vélocité (1h, ×0.5) — un changement d'avatar ou de bio isolé
      // est légitime la plupart du temps, mais c'est aussi le geste d'un
      // compte qui change d'identité après coup. Uniquement ces deux champs :
      // pas de frein pour un changement de ville ou de préférences. Un seul
      // frein posé même si les deux changent dans la même requête.
      if (result?.success && (updateData.avatar !== undefined || updateData.bio !== undefined)) {
        rustClient.triggerVelocityThrottle(String(userId), updateData.avatar !== undefined ? 'avatar_change' : 'bio_change');
      }

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

  async updateDemographics(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Informations personnelles invalides',
          errors: errors.array(),
        });
      }

      const result = await authService.updateDemographics(req.user.id, req.body);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans updateDemographics:', error);
      const invalid = error.message.includes('invalides');
      res.status(invalid ? 400 : 500).json({
        success: false,
        message: invalid ? error.message : 'Erreur lors de l\'enregistrement des informations personnelles',
      });
    }
  }

  async getConsentState(req, res) {
    try {
      const result = await authService.getConsentState(req.user.id);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans getConsentState:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la lecture du consentement',
      });
    }
  }

  async recordConsent(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Consentement invalide',
          errors: errors.array(),
        });
      }

      const result = await authService.recordConsent(
        req.user.id,
        req.body,
        sessionContextFrom(req),
      );
      res.status(200).json(result);
    } catch (error) {
      // Le socle refuse n'est pas une erreur serveur : le client doit pouvoir
      // afficher precisement ce qui manque.
      if (error.missingRequired) {
        return res.status(422).json({
          success: false,
          message: error.message,
          missingRequired: error.missingRequired,
        });
      }

      logger.error('Erreur dans recordConsent:', error);
      const invalid = error.message.includes('invalide');
      res.status(invalid ? 400 : 500).json({
        success: false,
        message: invalid ? error.message : 'Erreur lors de l\'enregistrement du consentement',
      });
    }
  }

  async recordSessionLocation(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Donnees de localisation invalides',
          errors: errors.array(),
        });
      }

      const result = await authService.recordSessionLocation(
        req.user.id,
        req.body,
        sessionContextFrom(req),
      );
      res.status(200).json(result);
    } catch (error) {
      logger.error('Erreur dans recordSessionLocation:', error);
      const invalid = error.message.includes('invalide');
      res.status(invalid ? 400 : 500).json({
        success: false,
        message: invalid ? error.message : 'Erreur lors de l\'enregistrement de la localisation',
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

      // Un changement de mot de passe doit couper les sessions ouvertes
      // ailleurs — ce n'était pas le cas jusqu'ici. On réémet immédiatement
      // un couple de jetons pour l'appareil courant afin de ne pas le
      // déconnecter lui aussi.
      await authService.revokeAllSessions(userId, 'password_changed');
      const { token: refreshToken } = await authService.createSession(
        userId,
        sessionContextFrom(req)
      );

      res.status(200).json({ ...result, data: { ...(result.data || {}), refreshToken } });
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

  // Appareils actuellement connectés
  async listSessions(req, res) {
    try {
      const sessions = await authService.listSessions(req.user.id);
      res.status(200).json({ success: true, data: { sessions } });
    } catch (error) {
      logger.error('Erreur dans listSessions:', error);
      res.status(500).json({ success: false, message: 'Erreur lors de la récupération des sessions' });
    }
  }

  // Révocation à distance d'un appareil
  async revokeSession(req, res) {
    try {
      const revoked = await authService.revokeSessionById(req.user.id, req.params.id);
      if (!revoked) {
        return res.status(404).json({ success: false, message: 'Session introuvable' });
      }
      res.status(200).json({ success: true, message: 'Session révoquée' });
    } catch (error) {
      logger.error('Erreur dans revokeSession:', error);
      res.status(500).json({ success: false, message: 'Erreur lors de la révocation' });
    }
  }
}

module.exports = new AuthController();
