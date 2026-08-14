const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Op } = require('sequelize');
const User = require('../models/User');
const config = require('../config/config');
const logger = require('../utils/logger');
const BanService = require('./banService');
const consentConfig = require('../config/consent');
const { maybeExpireSubscription } = require('../utils/subscriptionHelpers');

// Durée de vie d'une session inactive. Chaque rotation la fait glisser :
// une session utilisée régulièrement ne se coupe donc jamais.
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 jours

const { MIN_ONBOARDING_FOLLOWS } = require('../config/onboarding');

// Chargé paresseusement : models/index initialise l'ensemble des modèles et
// dépend indirectement d'autres services.
function getSessionModel() {
  return require('../models').Session;
}

function getUserLocationEventModel() {
  return require('../models').UserLocationEvent;
}

function getUserConsentRecordModel() {
  return require('../models').UserConsentRecord;
}

/**
 * Empreinte de l'adresse IP pour le journal de consentement.
 *
 * Une HMAC avec le secret du serveur, et non un simple SHA-256 : l'espace des
 * adresses IPv4 est assez petit pour etre entierement pre-calcule, donc un
 * hachage sans cle se re-identifie trivialement et ne serait pas une mesure de
 * protection.
 */
function hashIpForConsent(ip) {
  const key = process.env.FRAUD_DATA_HASH_KEY
    || process.env.JWT_SECRET
    || process.env.SESSION_SECRET
    || 'local-development-consent-key';
  return crypto.createHmac('sha256', key).update(`consent-ip:${String(ip).trim()}`).digest('hex');
}

/** Champs strictement reserves au proprietaire du compte. */
function getOwnerPrivateProfile(user) {
  return {
    declared_age: user.declared_age ?? null,
    birth_day: user.birth_day ?? null,
    birth_month: user.birth_month ?? null,
    demographics_validated_at: user.demographics_validated_at || null,
    location_consent_status: user.location_consent_status || 'undetermined',
    location_consent_updated_at: user.location_consent_updated_at || null,
    consent_version: user.consent_version || null,
    consent_accepted_at: user.consent_accepted_at || null,
    consent_preferences: user.consent_preferences || {},
    // Calcule par le serveur : le client n'a pas a comparer des versions
    // lui-meme, sinon une vieille application afficherait un etat faux.
    consent_required_version: consentConfig.CONSENT_VERSION,
    needs_consent: consentConfig.needsConsent(user),
    follow_onboarding_completed_at: user.follow_onboarding_completed_at || null,
    needs_follow_onboarding: !user.follow_onboarding_completed_at,
    follow_onboarding_minimum: MIN_ONBOARDING_FOLLOWS,
  };
}

class AuthService {
  // ─── Sessions (jetons de rafraîchissement opaques, hachés, à rotation) ──────

  /** Hachage stocké en base — le jeton en clair ne quitte jamais le client. */
  hashRefreshToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  /**
   * Crée une session et renvoie le jeton de rafraîchissement en clair.
   * `familyId` permet de chaîner les rotations successives d'une connexion.
   */
  async createSession(userId, context = {}, familyId = null) {
    const Session = getSessionModel();
    const token = crypto.randomBytes(48).toString('base64url');

    const session = await Session.create({
      user_id: userId,
      refresh_token_hash: this.hashRefreshToken(token),
      family_id: familyId || crypto.randomUUID(),
      device_id: context.deviceId ? String(context.deviceId).slice(0, 128) : null,
      platform: context.platform ? String(context.platform).slice(0, 32) : null,
      app_version: context.appVersion ? String(context.appVersion).slice(0, 32) : null,
      user_agent: context.userAgent ? String(context.userAgent).slice(0, 255) : null,
      ip: context.ip ? String(context.ip).slice(0, 64) : null,
      last_used_at: new Date(),
      expires_at: new Date(Date.now() + SESSION_TTL_MS),
    });

    return { token, session };
  }

  /** Révoque toutes les sessions d'une famille (rejeu détecté, déconnexion). */
  async revokeSessionFamily(familyId, reason) {
    const Session = getSessionModel();
    await Session.update(
      { revoked_at: new Date(), revoked_reason: reason },
      { where: { family_id: familyId, revoked_at: null } }
    );
  }

  /**
   * Révoque toutes les sessions d'un utilisateur.
   * À appeler sur changement de mot de passe et sur bannissement — jusqu'ici
   * aucun de ces événements n'invalidait les jetons déjà émis.
   */
  async revokeAllSessions(userId, reason = 'revoked') {
    const Session = getSessionModel();
    await Session.update(
      { revoked_at: new Date(), revoked_reason: reason },
      { where: { user_id: userId, revoked_at: null } }
    );
  }

  /** Sessions actives d'un utilisateur (liste des appareils connectés). */
  async listSessions(userId) {
    const Session = getSessionModel();
    return Session.findAll({
      where: { user_id: userId, revoked_at: null, expires_at: { [Op.gt]: new Date() } },
      attributes: [
        'id', 'device_id', 'platform', 'app_version',
        'user_agent', 'ip', 'last_used_at', 'created_at', 'expires_at',
      ],
      order: [['last_used_at', 'DESC']],
    });
  }

  async revokeSessionById(userId, sessionId) {
    const Session = getSessionModel();
    const [count] = await Session.update(
      { revoked_at: new Date(), revoked_reason: 'user_revoked' },
      { where: { id: sessionId, user_id: userId, revoked_at: null } }
    );
    return count > 0;
  }

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

  /**
   * @deprecated Les jetons de rafraîchissement sont désormais opaques et
   * adossés à une ligne `sessions` — voir `createSession`. Un JWT signé avec
   * le même secret que l'access token ne pouvait être ni révoqué ni distingué
   * de celui-ci.
   */
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
  async register(userData, sessionContext = {}) {
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
      const { token: refreshToken } = await this.createSession(user.id, sessionContext);

      // Mettre à jour la dernière activité
      await user.updateLastActivity();

      logger.info(`Nouvel utilisateur inscrit: ${user.username}`);

      return {
        success: true,
        message: 'Compte créé avec succès',
        data: {
          user: {
            ...user.getPublicProfile(),
            ...getOwnerPrivateProfile(user),
          },
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
  async login(credentials, sessionContext = {}) {
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
      const { token: refreshToken } = await this.createSession(user.id, sessionContext);

      logger.info(`Utilisateur connecté: ${user.username}`);

      return {
        success: true,
        message: 'Connexion réussie',
        data: {
          user: {
            ...user.getPublicProfile(),
            // Ajouter explicitement is_suspended pour l'app
            is_suspended: user.is_suspended || false,
            // `null` = langue de lecture jamais choisie : c'est ce que l'app
            // attend juste après la connexion pour poser la question une fois.
            preferred_language: user.preferred_language || null,
            ...getOwnerPrivateProfile(user)
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

  /**
   * Rafraîchit le couple de jetons, avec rotation.
   *
   * La session présentée est révoquée et remplacée par une nouvelle de la même
   * famille. Présenter un jeton déjà tourné est un rejeu : toute la famille est
   * alors révoquée, ce qui coupe la session légitime comme celle de l'attaquant.
   */
  async refreshToken(refreshToken, sessionContext = {}) {
    const Session = getSessionModel();

    if (!refreshToken || typeof refreshToken !== 'string') {
      throw new Error('Token de rafraîchissement invalide');
    }

    const hash = this.hashRefreshToken(refreshToken);
    const session = await Session.findOne({ where: { refresh_token_hash: hash } });

    if (!session) {
      throw new Error('Token de rafraîchissement invalide');
    }

    if (session.revoked_at) {
      logger.warn(`[auth] Rejeu d'un refresh token révoqué (famille ${session.family_id})`);
      await this.revokeSessionFamily(session.family_id, 'reuse_detected');
      throw new Error('Token de rafraîchissement invalide');
    }

    if (session.expires_at && session.expires_at.getTime() < Date.now()) {
      await session.update({ revoked_at: new Date(), revoked_reason: 'expired' });
      throw new Error('Session expirée');
    }

    const user = await User.findByPk(session.user_id);
    if (!user || !user.is_active) {
      await this.revokeSessionFamily(session.family_id, 'user_inactive');
      throw new Error('Utilisateur non trouvé ou inactif');
    }

    // Rotation : l'ancienne ligne est close, une nouvelle prend le relais.
    await session.update({ revoked_at: new Date(), revoked_reason: 'rotated' });

    const { token: newRefreshToken } = await this.createSession(
      user.id,
      {
        deviceId: sessionContext.deviceId || session.device_id,
        platform: sessionContext.platform || session.platform,
        appVersion: sessionContext.appVersion || session.app_version,
        userAgent: sessionContext.userAgent || session.user_agent,
        ip: sessionContext.ip || session.ip,
      },
      session.family_id
    );

    return {
      success: true,
      message: 'Token rafraîchi avec succès',
      data: {
        token: this.generateToken(user),
        refreshToken: newRefreshToken,
      }
    };
  }

  /**
   * Déconnexion. Avec un jeton de rafraîchissement, seule CETTE session est
   * révoquée — indispensable au multi-compte, où se déconnecter d'un compte ne
   * doit pas couper les autres.
   */
  async logout(userId, refreshToken = null) {
    try {
      if (refreshToken) {
        const Session = getSessionModel();
        const hash = this.hashRefreshToken(refreshToken);
        const session = await Session.findOne({ where: { refresh_token_hash: hash } });

        // On ne révoque que si la session appartient bien à l'appelant.
        if (session && String(session.user_id) === String(userId)) {
          await this.revokeSessionFamily(session.family_id, 'logout');
        }
      }

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
          'role', 'moderation_permissions', 'is_private_account',
          'stats', 'created_at', 'last_activity', 'is_active',
          'is_suspended', 'ban_count', 'suspension_reason', 'suspended_until',
          'preferred_language', 'declared_age', 'birth_day', 'birth_month',
          'demographics_validated_at', 'location_consent_status', 'location_consent_updated_at',
          'consent_version', 'consent_accepted_at', 'consent_preferences',
          'follow_onboarding_completed_at', 'g_auth_sub'
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
          'role', 'moderation_permissions', 'is_private_account',
          'stats', 'created_at', 'last_activity', 'is_active',
          'is_suspended', 'ban_count', 'suspension_reason', 'suspended_until',
          'preferred_language', 'declared_age', 'birth_day', 'birth_month',
          'demographics_validated_at', 'location_consent_status', 'location_consent_updated_at',
          'consent_version', 'consent_accepted_at', 'consent_preferences',
          'follow_onboarding_completed_at', 'g_auth_sub'
        ]
      });

      await maybeExpireSubscription(updatedUser);
      await updatedUser.reload({
        attributes: [
          'id', 'username', 'full_name', 'avatar', 'banner', 'bio', 'verified', 'premium',
          'subscription_tier', 'subscription_expires_at',
          'role', 'moderation_permissions', 'is_private_account',
          'stats', 'created_at', 'last_activity', 'is_active',
          'is_suspended', 'ban_count', 'suspension_reason', 'suspended_until',
          'preferred_language', 'declared_age', 'birth_day', 'birth_month',
          'demographics_validated_at', 'location_consent_status', 'location_consent_updated_at',
          'consent_version', 'consent_accepted_at', 'consent_preferences',
          'follow_onboarding_completed_at', 'g_auth_sub'
        ]
      });

      return {
        success: true,
        message: 'Profil récupéré avec succès',
        data: {
          ...updatedUser.getPublicProfile(),
          // Volontairement hors de `getPublicProfile()` : la langue de lecture
          // ne regarde que son propriétaire, elle n'a pas à voyager avec
          // l'auteur d'un tweet dans le fil de tout le monde.
          preferred_language: updatedUser.preferred_language || null,
          ...getOwnerPrivateProfile(updatedUser)
        }
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
      const allowedFields = ['username', 'full_name', 'avatar', 'banner', 'bio', 'preferences', 'is_private_account'];
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

  async updateDemographics(userId, { declaredAge, birthDay, birthMonth }) {
    const age = Number(declaredAge);
    const day = Number(birthDay);
    const month = Number(birthMonth);
    const maxDay = new Date(2024, month, 0).getDate(); // 2024 accepte le 29/02.

    if (!Number.isInteger(age) || age < 13 || age > 120 ||
        !Number.isInteger(month) || month < 1 || month > 12 ||
        !Number.isInteger(day) || day < 1 || day > maxDay) {
      throw new Error('Informations de naissance invalides');
    }

    const user = await User.findByPk(userId);
    if (!user || !user.is_active) throw new Error('Utilisateur non trouve');

    await user.update({
      declared_age: age,
      birth_day: day,
      birth_month: month,
      demographics_validated_at: new Date(),
    });

    return {
      success: true,
      message: 'Informations personnelles enregistrees',
      data: getOwnerPrivateProfile(user),
    };
  }

  async recordSessionLocation(userId, payload, context = {}) {
    const UserLocationEvent = getUserLocationEventModel();
    const permissionStatus = String(payload.permissionStatus || 'undetermined');
    const granted = permissionStatus === 'granted';
    const latitude = payload.latitude == null ? null : Number(payload.latitude);
    const longitude = payload.longitude == null ? null : Number(payload.longitude);
    const accuracy = payload.accuracy == null ? null : Number(payload.accuracy);

    if (granted && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
      throw new Error('Localisation invalide');
    }

    const user = await User.findByPk(userId);
    if (!user || !user.is_active) throw new Error('Utilisateur non trouve');

    const trim = (value, max) => value == null ? null : String(value).trim().slice(0, max) || null;
    const eventData = {
      user_id: userId,
      capture_key: String(payload.captureKey).slice(0, 180),
      permission_status: permissionStatus,
      // Une precision d'environ 100 m suffit aux statistiques geographiques
      // et evite de conserver une trace GPS inutilement exacte.
      latitude: granted ? Math.round(latitude * 1000) / 1000 : null,
      longitude: granted ? Math.round(longitude * 1000) / 1000 : null,
      accuracy_m: granted && Number.isFinite(accuracy) ? Math.max(0, Math.min(100000, accuracy)) : null,
      country_code: granted ? trim(payload.countryCode, 2)?.toUpperCase() : null,
      country: granted ? trim(payload.country, 100) : null,
      region: granted ? trim(payload.region, 120) : null,
      city: granted ? trim(payload.city, 120) : null,
      timezone: granted ? trim(payload.timezone, 64) : null,
      platform: trim(context.platform, 32),
      client_captured_at: payload.capturedAt ? new Date(payload.capturedAt) : null,
      captured_at: new Date(),
    };

    const [event, created] = await UserLocationEvent.findOrCreate({
      where: { capture_key: eventData.capture_key, user_id: userId },
      defaults: eventData,
    });

    await user.update({
      location_consent_status: permissionStatus,
      location_consent_updated_at: new Date(),
    });

    // ─── Report vers la Carte NF ────────────────────────────────────────────
    //
    // La position n'arrivait sur la carte que si l'on OUVRAIT la carte : c'est
    // l'ecran lui-meme qui poussait `POST /api/nf-map/position`. Quelqu'un qui
    // avait active le partage mais n'ouvrait jamais l'onglet restait donc
    // invisible, ou fige sur une position vieille de plusieurs jours — la
    // presence expire au bout de 8 h.
    //
    // On profite de la localisation deja transmise ici : elle est capturee au
    // demarrage, avec le consentement de l'utilisateur, et c'est exactement le
    // moment ou l'on sait ou il est.
    //
    // ⚠️ Le consentement de la CARTE est distinct de celui-ci. On ne le
    // contourne surtout pas : `updatePosition` relit `sharing_mode` en base et
    // refuse en mode « fantome » — qui est le defaut. Autrement dit, ce report
    // ne rend visible que ceux qui ont deja choisi de l'etre, et applique la
    // precision de LEUR mode (ville ou exacte), pas celle qu'on lui passe.
    //
    // Un seul appel suffit pour les deux choses demandees : `updatePosition`
    // ecrit la position ET repousse `expires_at`, qui est ce que la carte
    // utilise comme statut « en ligne ».
    if (granted) {
      try {
        const nfMap = require('./nfMapService');
        const { sequelize } = require('../models');
        // Les coordonnees ARRONDIES, pas les brutes : on ne transmet jamais a
        // la carte plus de precision que l'antifraude n'en a conserve.
        await nfMap.updatePosition(sequelize, userId, {
          latitude: eventData.latitude,
          longitude: eventData.longitude,
          place_label: eventData.city || null,
        });
      } catch (error) {
        // La carte est un agrement, l'enregistrement de localisation une
        // obligation : un echec ici ne doit jamais faire echouer celui-la.
        logger.warn(`[nfMap] report depuis la localisation de session impossible: ${error.message}`);
      }
    }

    return {
      success: true,
      message: granted ? 'Localisation de connexion enregistree' : 'Choix de localisation enregistre',
      data: {
        recorded: created,
        captured_at: event.captured_at,
        permission_status: permissionStatus,
      },
    };
  }

  /**
   * Socle en vigueur + etat du compte. Le client construit son ecran a partir
   * de cette reponse uniquement : aucun libelle de finalite n'est code en dur
   * dans les applications, sinon un texte corrige ici resterait faux chez les
   * personnes qui n'ont pas mis a jour.
   */
  async getConsentState(userId) {
    const user = await User.findByPk(userId, {
      attributes: ['id', 'is_active', 'consent_version', 'consent_accepted_at', 'consent_preferences'],
    });
    if (!user || !user.is_active) throw new Error('Utilisateur non trouve');

    return {
      success: true,
      data: {
        ...consentConfig.consentManifest(),
        accepted_version: user.consent_version || null,
        accepted_at: user.consent_accepted_at || null,
        preferences: {
          ...consentConfig.defaultOptionalPreferences(),
          ...(user.consent_preferences || {}),
        },
        needs_consent: consentConfig.needsConsent(user),
      },
    };
  }

  /**
   * Enregistre un accord, ou une modification des choix optionnels.
   *
   * Trois garde-fous qui portent la conformite :
   *
   * 1. La version est imposee par le serveur. Un client qui renvoie une
   *    version differente de celle en vigueur est refuse : accepter un socle
   *    perime laisserait croire le compte a jour alors qu'il ne l'est pas.
   * 2. Les finalites requises doivent TOUTES etre accordees. Elles reposent sur
   *    l'execution du contrat, pas sur un consentement : sans elles il n'y a
   *    pas de service a fournir.
   * 3. Chaque finalite, accordee ou refusee, produit une ligne de journal. Un
   *    refus est une information aussi importante qu'un accord — c'est lui qui
   *    prouve qu'on n'a pas traite les donnees sans droit.
   */
  async recordConsent(userId, payload, context = {}) {
    const UserConsentRecord = getUserConsentRecordModel();
    const version = String(payload?.version || '');
    const source = consentConfig.CONSENT_SOURCES.includes(payload?.source)
      ? payload.source
      : 'startup_gate';
    const answers = payload?.accepted && typeof payload.accepted === 'object' ? payload.accepted : null;

    if (version !== consentConfig.CONSENT_VERSION) {
      throw new Error('Version de consentement invalide');
    }
    if (!answers) {
      throw new Error('Reponses de consentement invalides');
    }

    const user = await User.findByPk(userId);
    if (!user || !user.is_active) throw new Error('Utilisateur non trouve');

    // `settings` ne sert qu'a revenir sur les choix optionnels : le socle
    // contractuel y est deja acquis et n'a pas a etre renvoye.
    const revisingOptionalOnly = source === 'settings' && !!user.consent_accepted_at;
    if (!revisingOptionalOnly) {
      const missing = consentConfig.REQUIRED_KEYS.filter((key) => answers[key] !== true);
      if (missing.length > 0) {
        const error = new Error('Le socle obligatoire doit etre accepte');
        error.missingRequired = missing;
        throw error;
      }
    }

    const preferences = consentConfig.OPTIONAL_KEYS.reduce((acc, key) => ({
      ...acc,
      // Une cle absente vaut refus, jamais accord tacite.
      [key]: answers[key] === true,
    }), {});

    const trim = (value, max) => (value == null ? null : String(value).trim().slice(0, max) || null);
    const recordedAt = new Date();
    const journal = [
      ...(revisingOptionalOnly ? [] : consentConfig.REQUIRED_KEYS.map((key) => ({
        purpose: key,
        granted: true,
        required: true,
      }))),
      ...consentConfig.OPTIONAL_KEYS.map((key) => ({
        purpose: key,
        granted: preferences[key],
        required: false,
      })),
    ].map((entry) => ({
      ...entry,
      user_id: userId,
      consent_version: consentConfig.CONSENT_VERSION,
      source,
      platform: trim(context.platform, 32),
      app_version: trim(context.appVersion, 32),
      ip_fingerprint: context.ip ? hashIpForConsent(context.ip) : null,
      user_agent: trim(context.userAgent, 255),
      recorded_at: recordedAt,
    }));

    await UserConsentRecord.bulkCreate(journal);

    await user.update({
      consent_version: consentConfig.CONSENT_VERSION,
      // Conserve la date du PREMIER accord au socle courant : revenir sur une
      // option ne doit pas donner l'impression d'un nouveau consentement.
      consent_accepted_at: revisingOptionalOnly && user.consent_accepted_at
        ? user.consent_accepted_at
        : recordedAt,
      consent_preferences: preferences,
    });

    return {
      success: true,
      message: revisingOptionalOnly ? 'Choix enregistres' : 'Consentement enregistre',
      data: {
        version: consentConfig.CONSENT_VERSION,
        accepted_at: user.consent_accepted_at,
        preferences,
        needs_consent: false,
      },
    };
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
