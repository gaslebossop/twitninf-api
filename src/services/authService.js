const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const User = require('../models/User');
const config = require('../config/config');
const logger = require('../utils/logger');
const BanService = require('./banService');
const { maybeExpireSubscription } = require('../utils/subscriptionHelpers');

class AuthService {
  // Générer un token JWT
  generateToken(user) {
    const payload = {
      id: user.id,
      username: user.username,
      email: user.email,
      verified: user.verified,
      premium: user.premium,
      subscription_tier: user.subscription_tier || 'free',
      role: user.role || 'user',
      moderation_permissions: user.moderation_permissions || {},
      // Ajouter les informations de ban pour le middleware
      is_suspended: user.is_suspended || false,
      suspension_reason: user.suspension_reason || null,
      suspended_until: user.suspended_until || null
    };

    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn
    });
  }

  // Générer un token de rafraîchissement
  generateRefreshToken(user) {
    const payload = {
      id: user.id,
      type: 'refresh'
    };

    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.refreshExpiresIn
    });
  }

  // Vérifier un token JWT
  verifyToken(token) {
    try {
      return jwt.verify(token, config.jwt.secret);
    } catch (error) {
      logger.error('Erreur de vérification du token:', error);
      return null;
    }
  }

  // Inscription d'un utilisateur
  async register(userData) {
    try {
      logger.info('Début de l\'inscription:', { username: userData.username });
      
      // Vérifier si l'utilisateur existe déjà
      const existingUser = await User.findOne({
        where: {
          username: userData.username
        }
      });

      if (existingUser) {
        throw new Error('Un utilisateur avec ce nom d\'utilisateur existe déjà');
      }

      logger.info('Aucun utilisateur existant trouvé, création...');

      // Créer l'utilisateur
      const user = await User.create({
        username: userData.username,
        full_name: userData.fullName,
        password: userData.password,
        platform: userData.platform || 'android'
      });

      logger.info('Utilisateur créé avec succès:', user.id);

      // Générer les tokens
      const token = this.generateToken(user);
      const refreshToken = this.generateRefreshToken(user);

      // Mettre à jour la dernière activité
      await user.updateLastActivity();

      logger.info(`Nouvel utilisateur inscrit: ${user.username}`);

      return {
        success: true,
        message: 'Compte créé avec succès',
        data: {
          user: user.getPublicProfile(),
          token,
          refreshToken
        }
      };
    } catch (error) {
      logger.error('Erreur lors de l\'inscription:', error);
      throw error;
    }
  }

  // Connexion d'un utilisateur
  async login(credentials) {
    try {
      // Rechercher l'utilisateur par username
      const user = await User.findOne({
        where: {
          username: credentials.username,
          is_active: true
        }
      });

      if (!user) {
        throw new Error('Identifiants invalides');
      }

      // Vérifier le mot de passe
      const isValidPassword = await user.comparePassword(credentials.password);
      if (!isValidPassword) {
        throw new Error('Identifiants invalides');
      }

      // Mettre à jour la dernière activité
      await user.updateLastActivity();

      try {
        const NewEconomyService = require('./newEconomyService');
        await NewEconomyService.ensureWalletsForUser(user.id);
      } catch (e) {
        logger.warn(`[economy] Portefeuilles non assurés au login (${user.id}): ${e.message}`);
      }

      // Générer les tokens
      const token = this.generateToken(user);
      const refreshToken = this.generateRefreshToken(user);

      logger.info(`Utilisateur connecté: ${user.username}`);

      return {
        success: true,
        message: 'Connexion réussie',
        data: {
          user: {
            ...user.getPublicProfile(),
            // Ajouter explicitement is_suspended pour l'app
            is_suspended: user.is_suspended || false
          },
          token,
          refreshToken
        }
      };
    } catch (error) {
      logger.error('Erreur lors de la connexion:', error);
      throw error;
    }
  }

  // Rafraîchir un token
  async refreshToken(refreshToken) {
    try {
      const decoded = this.verifyToken(refreshToken);
      if (!decoded || decoded.type !== 'refresh') {
        throw new Error('Token de rafraîchissement invalide');
      }

      const user = await User.findByPk(decoded.id);
      if (!user || !user.is_active) {
        throw new Error('Utilisateur non trouvé ou inactif');
      }

      const newToken = this.generateToken(user);
      const newRefreshToken = this.generateRefreshToken(user);

      return {
        success: true,
        message: 'Token rafraîchi avec succès',
        data: {
          token: newToken,
          refreshToken: newRefreshToken
        }
      };
    } catch (error) {
      logger.error('Erreur lors du rafraîchissement du token:', error);
      throw error;
    }
  }

  // Déconnexion
  async logout(userId) {
    try {
      const user = await User.findByPk(userId);
      if (user) {
        await user.updateLastActivity();
        logger.info(`Utilisateur déconnecté: ${user.username}`);
      }

      return { 
        success: true,
        message: 'Déconnexion réussie'
      };
    } catch (error) {
      logger.error('Erreur lors de la déconnexion:', error);
      throw error;
    }
  }

  // Vérifier l'email
  async verifyEmail(token) {
    try {
      const decoded = this.verifyToken(token);
      if (!decoded) {
        throw new Error('Token de vérification invalide');
      }

      const user = await User.findByPk(decoded.id);
      if (!user) {
        throw new Error('Utilisateur non trouvé');
      }

      user.email_verified = true;
      await user.save();

      logger.info(`Email vérifié pour: ${user.username}`);

      return {
        success: true,
        message: 'Email vérifié avec succès'
      };
    } catch (error) {
      logger.error('Erreur lors de la vérification de l\'email:', error);
      throw error;
    }
  }

  // Demander la réinitialisation du mot de passe
  async forgotPassword(email) {
    try {
      const user = await User.findOne({
        where: { email, is_active: true }
      });

      if (!user) {
        // Ne pas révéler si l'email existe ou non
        return { success: true, message: 'Si l\'email existe, un lien de réinitialisation a été envoyé' };
      }

      // Générer un token de réinitialisation
      const resetToken = jwt.sign(
        { id: user.id, type: 'reset' },
        config.jwt.secret,
        { expiresIn: '1h' }
      );

      // Sauvegarder le token
      user.reset_password_token = resetToken;
      user.reset_password_expires = new Date(Date.now() + 60 * 60 * 1000); // 1 heure
      await user.save();

      // TODO: Envoyer l'email avec le lien de réinitialisation

      logger.info(`Demande de réinitialisation de mot de passe pour: ${user.email}`);

      return { success: true, message: 'Si l\'email existe, un lien de réinitialisation a été envoyé' };
    } catch (error) {
      logger.error('Erreur lors de la demande de réinitialisation:', error);
      throw error;
    }
  }

  // Réinitialiser le mot de passe
  async resetPassword(token, newPassword) {
    try {
      const decoded = this.verifyToken(token);
      if (!decoded || decoded.type !== 'reset') {
        throw new Error('Token de réinitialisation invalide');
      }

      const user = await User.findByPk(decoded.id);
      if (!user || !user.is_active) {
        throw new Error('Utilisateur non trouvé ou inactif');
      }

      if (!user.reset_password_token || user.reset_password_token !== token) {
        throw new Error('Token de réinitialisation invalide');
      }

      if (user.reset_password_expires < new Date()) {
        throw new Error('Token de réinitialisation expiré');
      }

      // Mettre à jour le mot de passe
      user.password = newPassword;
      user.reset_password_token = null;
      user.reset_password_expires = null;
      await user.save();

      logger.info(`Mot de passe réinitialisé pour: ${user.username}`);

      return {
        success: true,
        message: 'Mot de passe réinitialisé avec succès'
      };
    } catch (error) {
      logger.error('Erreur lors de la réinitialisation du mot de passe:', error);
      throw error;
    }
  }

  // Obtenir le profil utilisateur
  async getProfile(userId) {
    try {
      const user = await User.findByPk(userId, {
        attributes: [
          'id', 'username', 'full_name', 'avatar', 'banner', 'bio', 'verified', 'premium',
          'subscription_tier', 'subscription_expires_at',
          'role', 'moderation_permissions',
          'stats', 'created_at', 'last_activity', 'is_active',
          'is_suspended', 'ban_count', 'suspension_reason', 'suspended_until'
        ]
      });
      if (!user || !user.is_active) {
        throw new Error('Utilisateur non trouvé');
      }

      // Vérifier et mettre à jour les statuts de ban expirés via le service de ban
      try {
        await BanService.checkAndUpdateUserBanStatus(userId);
      } catch (banUpdateError) {
        logger.warn(`Erreur lors de la mise à jour du statut de ban pour ${userId}:`, banUpdateError);
        // Continuer même si la mise à jour du statut de ban échoue
      }

      // Recharger l'utilisateur pour avoir les données mises à jour
      const updatedUser = await User.findByPk(userId, {
        attributes: [
          'id', 'username', 'full_name', 'avatar', 'banner', 'bio', 'verified', 'premium',
          'subscription_tier', 'subscription_expires_at',
          'role', 'moderation_permissions',
          'stats', 'created_at', 'last_activity', 'is_active',
          'is_suspended', 'ban_count', 'suspension_reason', 'suspended_until'
        ]
      });

      await maybeExpireSubscription(updatedUser);
      await updatedUser.reload({
        attributes: [
          'id', 'username', 'full_name', 'avatar', 'banner', 'bio', 'verified', 'premium',
          'subscription_tier', 'subscription_expires_at',
          'role', 'moderation_permissions',
          'stats', 'created_at', 'last_activity', 'is_active',
          'is_suspended', 'ban_count', 'suspension_reason', 'suspended_until'
        ]
      });

      return {
        success: true,
        message: 'Profil récupéré avec succès',
        data: updatedUser.getPublicProfile()
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération du profil:', error);
      throw error;
    }
  }

  // Mettre à jour le profil utilisateur
  async updateProfile(userId, updateData) {
    try {
      const user = await User.findByPk(userId);
      if (!user || !user.is_active) {
        throw new Error('Utilisateur non trouvé');
      }

      // Vérifier si le nouveau nom d'utilisateur est déjà pris
      if (updateData.username && updateData.username !== user.username) {
        const existingUser = await User.findOne({
          where: { username: updateData.username }
        });
        if (existingUser) {
          throw new Error('Ce nom d\'utilisateur est déjà pris');
        }
      }

      // Mettre à jour les champs autorisés
      const allowedFields = ['username', 'full_name', 'avatar', 'banner', 'bio', 'preferences'];
      for (const field of allowedFields) {
        if (updateData[field] === undefined) continue;
        if (field === 'bio') {
          const v = updateData[field];
          user.bio = v == null || String(v).trim() === '' ? null : String(v).trim();
        } else if (field === 'banner') {
          const v = updateData[field];
          user.banner = v == null || String(v).trim() === '' ? null : String(v).trim();
        } else {
          user[field] = updateData[field];
        }
      }

      // Si l'utilisateur est vérifié et change son nom d'utilisateur, révoquer la vérification
      if (updateData.username && updateData.username !== user._previousDataValues.username && user.verified) {
        logger.info(`Révocation de la vérification pour ${user.username} suite à un changement de nom d'utilisateur → ${updateData.username}`);
        user.verified = false;
      }

      await user.save();
      await user.updateLastActivity();

      logger.info(`Profil mis à jour pour: ${user.username}`);

      return {
        success: true,
        message: 'Profil mis à jour avec succès',
        data: user.getPublicProfile()
      };
    } catch (error) {
      logger.error('Erreur lors de la mise à jour du profil:', error);
      throw error;
    }
  }

  // Changer le mot de passe
  async changePassword(userId, currentPassword, newPassword) {
    try {
      const user = await User.findByPk(userId);
      if (!user || !user.is_active) {
        throw new Error('Utilisateur non trouvé');
      }

      // Vérifier l'ancien mot de passe
      const isValidPassword = await user.comparePassword(currentPassword);
      if (!isValidPassword) {
        throw new Error('Mot de passe actuel incorrect');
      }

      // Mettre à jour le mot de passe
      user.password = newPassword;
      await user.save();

      logger.info(`Mot de passe changé pour: ${user.username}`);

      return {
        success: true,
        message: 'Mot de passe changé avec succès'
      };
    } catch (error) {
      logger.error('Erreur lors du changement de mot de passe:', error);
      throw error;
    }
  }
}

module.exports = new AuthService();
