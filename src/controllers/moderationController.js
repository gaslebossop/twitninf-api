const { validationResult } = require('express-validator');
const { Op, Sequelize } = require('sequelize');
const { User, Tweet, Report, ModerationAction, VerificationRequest, UnbanTicket } = require('../models');
const logger = require('../utils/logger');
const ctrTracker = require('../services/ctrTracker');

class ModerationController {
  // ===== GESTION DES SIGNALEMENTS =====

  // Créer un nouveau signalement
  async createReport(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { target_id, target_type, reason, severity = 'medium' } = req.body;
      const reporter_id = req.user.id;

      // Vérifier que la cible existe
      let targetExists = false;
      if (target_type === 'tweet') {
        const tweet = await Tweet.findByPk(target_id);
        targetExists = !!tweet;
      } else if (target_type === 'user') {
        const user = await User.findByPk(target_id);
        targetExists = !!user;
      }

      if (!targetExists) {
        return res.status(404).json({
          success: false,
          message: 'Cible du signalement non trouvée'
        });
      }

      // Vérifier si l'utilisateur a déjà signalé cette cible
      const existingReport = await Report.findOne({
        where: {
          reporter_id,
          target_id,
          target_type,
          status: { [Op.in]: ['pending', 'investigating'] }
        }
      });

      if (existingReport) {
        return res.status(400).json({
          success: false,
          message: 'Vous avez déjà signalé cette cible'
        });
      }

                          // Créer le signalement
        const reportData = {
          reporter_id,
          target_id,
          target_type,
          type: target_type, // Le type doit être 'user' ou 'tweet'
          reason,
          severity,
          status: 'pending',
          priority: 1
        };
       
       console.log('📝 Données du signalement à créer:', reportData);
       
       const report = await Report.create(reportData);

      // 📊 Track report pour l'algorithme Rust (si c'est un tweet)
      if (target_type === 'tweet') {
        ctrTracker.trackReport(reporter_id, target_id).catch(err => {
          logger.warn(`CTR tracking error: ${err.message}`);
        });
      }

      logger.info(`Nouveau signalement créé: ${report.id} par ${req.user.username} sur ${target_type} ${target_id}`);

      res.status(201).json({
        success: true,
        message: 'Signalement créé avec succès',
        data: {
          report: {
            id: report.id,
            target_id: report.target_id,
            target_type: report.target_type,
            reason: report.reason,
            severity: report.severity,
            status: report.status,
            created_at: report.created_at
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la création du signalement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la création du signalement'
      });
    }
  }

  // Obtenir la liste des signalements
  async getReports(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, status, severity, type } = req.query;
      const offset = (page - 1) * limit;

      // Construire les conditions de recherche
      const where = {};
      
      if (status && status !== 'all') {
        where.status = status;
      }

      if (severity && severity !== 'all') {
        where.severity = severity;
      }

      if (type && type !== 'all') {
        where.target_type = type;
      }

      const { count, rows: reports } = await Report.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'reporter',
            attributes: ['id', 'username', 'full_name', 'avatar']
          },
          {
            model: User,
            as: 'resolver',
            attributes: ['id', 'username', 'full_name']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      // Enrichir les signalements avec les données de la cible
      const enrichedReports = await Promise.all(reports.map(async (report) => {
        const reportData = report.toJSON();
        
        // Récupérer les données de la cible
        let targetData = null;
        if (report.target_type === 'tweet') {
          const tweet = await Tweet.findByPk(report.target_id, {
            include: [{
              model: User,
              as: 'author',
              attributes: ['id', 'username', 'full_name', 'avatar', 'verified']
            }]
          });
          if (tweet) {
            targetData = {
              id: tweet.id,
              content: tweet.content,
              author: tweet.author,
              created_at: tweet.created_at
            };
          }
        } else if (report.target_type === 'user') {
          const user = await User.findByPk(report.target_id, {
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'role', 'is_suspended']
          });
          if (user) {
            targetData = user.toJSON();
          }
        }

        return {
          ...reportData,
          target: targetData
        };
      }));

      res.json({
        success: true,
        data: {
          reports: enrichedReports,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des signalements:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des signalements'
      });
    }
  }

  // Mettre à jour le statut d'un signalement
  async updateReportStatus(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { reportId } = req.params;
      const { status, moderator_notes, resolution_action, resolution_reason } = req.body;
      const moderator_id = req.user.id;

      const report = await Report.findByPk(reportId);
      if (!report) {
        return res.status(404).json({
          success: false,
          message: 'Signalement non trouvé'
        });
      }

      const updateData = {
        status,
        moderator_notes,
        resolved_by: moderator_id,
        resolved_at: new Date()
      };

      if (resolution_action) {
        updateData.resolution_action = resolution_action;
        updateData.resolution_reason = resolution_reason;
      }

      await report.update(updateData);

      logger.info(`Signalement ${reportId} mis à jour par ${req.user.username}: ${status}`);

      res.json({
        success: true,
        message: 'Statut du signalement mis à jour',
        data: {
          report: {
            id: report.id,
            status: report.status,
            moderator_notes: report.moderator_notes,
            resolution_action: report.resolution_action,
            resolved_at: report.resolved_at
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la mise à jour du signalement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la mise à jour du signalement'
      });
    }
  }

  // ===== GESTION DES UTILISATEURS =====

  // Obtenir la liste des utilisateurs
  async getUsers(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, status, role, search } = req.query;
      const offset = (page - 1) * limit;

      // Construire les conditions de recherche
      const where = {};
      
      if (status && status !== 'all') {
        if (status === 'suspended' || status === 'banned') {
          where.is_suspended = true; // Suspendu = banni
        } else if (status === 'active') {
          where.is_suspended = false;
        }
      }

      if (role && role !== 'all') {
        where.role = role;
      }

      if (search) {
        where[Op.or] = [
          { username: { [Op.iLike]: `%${search}%` } },
          { full_name: { [Op.iLike]: `%${search}%` } }
        ];
      }

      const { count, rows: users } = await User.findAndCountAll({
        where,
        attributes: [
          'id', 'username', 'full_name', 'avatar', 'verified', 'premium',
          'role', 'is_suspended', 'suspended_until', 
          'suspension_reason', 'created_at', 'last_activity'
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      // Traiter les utilisateurs pour ajouter le statut formaté
      const processedUsers = users.map(user => {
        const userData = user.toJSON();
        
        // Déterminer le statut basé sur is_suspended seulement
        let status = 'active';
        if (userData.is_suspended) {
          status = 'banned';
        }
        
        return {
          ...userData,
          status: status,
          // Ajouter des champs par défaut pour la compatibilité
          followers: 0,
          following: 0,
          tweets: 0,
          reports: 0,
          joinDate: userData.created_at,
          lastSeen: userData.last_activity,
          email: userData.email || ''
        };
      });

      res.json({
        success: true,
        data: {
          users: processedUsers,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des utilisateurs:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des utilisateurs'
      });
    }
  }

  // Obtenir les détails d'un utilisateur
  async getUserDetails(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;

      const user = await User.findByPk(userId, {
        attributes: [
          'id', 'username', 'full_name', 'avatar', 'verified', 'premium',
          'role', 'is_suspended', 'suspended_until', 'suspension_reason',
          'created_at', 'last_activity', 'stats', 'moderation_history'
        ]
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      res.json({
        success: true,
        data: { user }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des détails utilisateur:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des détails utilisateur'
      });
    }
  }

  // Suspendre un utilisateur
  async suspendUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason, duration = 7, moderator_note } = req.body;
      const moderatorId = req.user.id;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      // Calculer la date de fin de suspension (duration en heures)
      const suspendedUntil = new Date();
      suspendedUntil.setHours(suspendedUntil.getHours() + duration);

      // Mettre à jour l'utilisateur
      await user.update({
        is_suspended: true,
        suspended_at: new Date(),
        suspended_until: suspendedUntil,
        suspension_reason: reason
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'suspend',
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        duration: duration, // en heures
        status: 'active',
        expires_at: suspendedUntil,
        metadata: {
          moderator_note,
          original_suspension_reason: user.suspension_reason
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'suspend',
        moderator_id: moderatorId,
        reason,
        duration,
        moderator_note,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Utilisateur suspendu: ${user.username} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Utilisateur suspendu avec succès',
        data: {
          user: user.getPublicProfile(),
          suspension_details: {
            reason,
            duration,
            suspended_until: suspendedUntil
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la suspension:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la suspension'
      });
    }
  }

  // Lever la suspension d'un utilisateur
  async unsuspendUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      if (!user.is_suspended) {
        return res.status(400).json({
          success: false,
          message: 'Cet utilisateur n\'est pas suspendu'
        });
      }

      // Mettre à jour l'utilisateur
      await user.update({
        is_suspended: false,
        suspended_at: null,
        suspended_until: null,
        suspension_reason: null
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'approve', // Utiliser 'approve' pour lever une suspension
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        status: 'reversed',
        reversed_at: new Date(),
        reversed_by: moderatorId,
        reversal_reason: reason,
        metadata: {
          action_type: 'unsuspend',
          original_suspension_reason: user.suspension_reason
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'unsuspend',
        moderator_id: moderatorId,
        reason,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Suspension levée: ${user.username} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Suspension levée avec succès',
        data: {
          user: user.getPublicProfile()
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la levée de suspension:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la levée de suspension'
      });
    }
  }

  // Bannir un utilisateur
  async banUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason, duration = 8760, permanent = false, moderator_note } = req.body; // 8760 heures = 1 an par défaut
      const moderatorId = req.user.id;

      logger.info(`Données reçues - userId: ${userId}, reason: ${reason}, duration: ${duration}, permanent: ${permanent}`);
      logger.info(`Body complet:`, req.body);

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      // Bannissement direct via is_suspended
      const banUntil = permanent ? null : new Date(Date.now() + duration * 60 * 60 * 1000); // duration en heures
      
      logger.info(`Tentative de bannissement - is_suspended: true, reason: ${reason}, banUntil: ${banUntil}`);
      
      const updateData = {
        is_suspended: true, // Bannissement direct
        suspended_at: new Date(),
        suspended_until: banUntil,
        suspension_reason: reason
      };
      
      logger.info(`Données de mise à jour:`, updateData);
      
      await user.update(updateData);
      
      // Recharger l'utilisateur pour avoir les données mises à jour
      await user.reload();
      
      logger.info(`Utilisateur banni avec succès - is_suspended: ${user.is_suspended}`);
      logger.info(`suspended_at: ${user.suspended_at}, suspended_until: ${user.suspended_until}, reason: ${user.suspension_reason}`);

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'ban',
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        duration: permanent ? null : duration, // null pour permanent
        status: 'active',
        expires_at: banUntil,
        metadata: {
          permanent,
          moderator_note,
          action_type: 'ban'
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'ban',
        moderator_id: moderatorId,
        reason,
        permanent,
        moderator_note,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Utilisateur banni: ${user.username} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Utilisateur banni avec succès',
        data: {
          user: user.getPublicProfile(),
          ban_details: {
            reason,
            permanent,
            is_suspended: true
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors du bannissement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du bannissement'
      });
    }
  }

  // Débannir un utilisateur
  async unbanUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      // Mettre à jour l'utilisateur - DÉBANNISSEMENT
      await user.update({
        is_suspended: false,
        suspended_at: null,
        suspended_until: null,
        suspension_reason: null
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'approve', // Utiliser 'approve' pour débannir
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        status: 'reversed',
        reversed_at: new Date(),
        reversed_by: moderatorId,
        reversal_reason: reason,
        metadata: {
          action_type: 'unban'
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'unban',
        moderator_id: moderatorId,
        reason,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Utilisateur débanni: ${user.username} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Utilisateur débanni avec succès',
        data: {
          user: user.getPublicProfile()
        }
      });
    } catch (error) {
      logger.error('Erreur lors du débannissement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du débannissement'
      });
    }
  }

  // Vérifier un utilisateur
  async verifyUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      if (user.verified) {
        return res.status(400).json({
          success: false,
          message: 'Cet utilisateur est déjà vérifié'
        });
      }

      // Mettre à jour l'utilisateur
      await user.update({
        verified: true
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'approve',
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          action_type: 'verify',
          original_verified_status: user.verified
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'verify',
        moderator_id: moderatorId,
        reason,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Utilisateur vérifié: ${user.username} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Utilisateur vérifié avec succès',
        data: {
          user: user.getPublicProfile()
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la vérification:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la vérification'
      });
    }
  }

  // Révoquer la vérification d'un utilisateur
  async unverifyUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { userId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      if (!user.verified) {
        return res.status(400).json({
          success: false,
          message: 'Cet utilisateur n\'est pas vérifié'
        });
      }

      // Mettre à jour l'utilisateur
      await user.update({
        verified: false
      });

      // Supprimer toutes les demandes de vérification de cet utilisateur
      await VerificationRequest.destroy({
        where: { user_id: userId }
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'reject',
        target_type: 'user',
        target_id: userId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          action_type: 'unverify',
          original_verified_status: user.verified
        }
      });

      // Ajouter à l'historique de modération local
      const historyEntry = {
        action: 'unverify',
        moderator_id: moderatorId,
        reason,
        timestamp: new Date()
      };

      const currentHistory = user.moderation_history || [];
      currentHistory.push(historyEntry);
      await user.update({ moderation_history: currentHistory });

      logger.info(`Vérification révoquée: ${user.username} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Vérification révoquée avec succès',
        data: {
          user: user.getPublicProfile()
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la révocation de vérification:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la révocation de vérification'
      });
    }
  }

  // ===== MODÉRATION DE CONTENU =====

  // Obtenir la liste des tweets à modérer
  async getTweetsForModeration(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, status, search } = req.query;
      const offset = (page - 1) * limit;

      // Construire les conditions de recherche
      const where = {};
      
      if (status && status !== 'all') {
        where.moderation_status = status;
      }

      if (search) {
        where.content = { [Op.iLike]: `%${search}%` };
      }

      // Ajouter le filtre pour exclure les réponses (parent_tweet_id doit être null)
      where.parent_tweet_id = null;

      const { count, rows: tweets } = await Tweet.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      res.json({
        success: true,
        data: {
          tweets,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des tweets:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des tweets'
      });
    }
  }

  // Obtenir les détails d'un tweet
  async getTweetDetails(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweetId } = req.params;

      const tweet = await Tweet.findByPk(tweetId, {
        include: [
          {
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'role']
          }
        ]
      });

      if (!tweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet non trouvé'
        });
      }

      res.json({
        success: true,
        data: { tweet }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des détails tweet:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des détails tweet'
      });
    }
  }

  // Approuver un tweet
  async approveTweet(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweetId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet non trouvé'
        });
      }

      // Mettre à jour le tweet
      await tweet.update({
        moderation_status: 'approved',
        moderation_reason: reason
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'approve',
        target_type: 'tweet',
        target_id: tweetId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          original_moderation_status: tweet.moderation_status
        }
      });

      // Ajouter le tweet au système de recommandation progressive
      try {
        const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
        const recommendationEngine = new ProgressiveRecommendationEngine();
        await recommendationEngine.addNewTweet(tweetId);
        logger.info(`🎯 Tweet ${tweetId} ajouté au système de recommandation progressive (approbation manuelle)`);
      } catch (recError) {
        logger.error(`❌ Erreur lors de l'ajout du tweet ${tweetId} au système de recommandation:`, recError);
      }

      logger.info(`Tweet approuvé: ${tweetId} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Tweet approuvé avec succès',
        data: { tweet }
      });
    } catch (error) {
      logger.error('Erreur lors de l\'approbation du tweet:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'approbation du tweet'
      });
    }
  }

  // Rejeter un tweet
  async rejectTweet(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweetId } = req.params;
      const { reason, severity = 'medium' } = req.body;
      const moderatorId = req.user.id;

      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet non trouvé'
        });
      }

      // Mettre à jour le tweet
      await tweet.update({
        moderation_status: 'rejected',
        moderation_reason: reason
      });

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'reject',
        target_type: 'tweet',
        target_id: tweetId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          severity,
          original_moderation_status: tweet.moderation_status
        }
      });

      logger.info(`Tweet rejeté: ${tweetId} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Tweet rejeté avec succès',
        data: { tweet }
      });
    } catch (error) {
      logger.error('Erreur lors du rejet du tweet:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du rejet du tweet'
      });
    }
  }

  // Supprimer un tweet
  async deleteTweet(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweetId } = req.params;
      const { reason, notify_user = true } = req.body;
      const moderatorId = req.user.id;

      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet non trouvé'
        });
      }

      // Créer une entrée dans la table moderation_actions avant la suppression
      await ModerationAction.create({
        type: 'delete',
        target_type: 'tweet',
        target_id: tweetId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          notify_user,
          original_tweet_content: (tweet.content || '').substring(0, 100) // Garder un aperçu du contenu
        }
      });

      // Supprimer le tweet
      await tweet.destroy();

      logger.info(`Tweet supprimé: ${tweetId} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Tweet supprimé avec succès',
        data: {
          tweet_id: tweetId,
          reason,
          notified_user: notify_user
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la suppression du tweet:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la suppression du tweet'
      });
    }
  }

  // Marquer un tweet comme non éligible aux recommandations
  async markTweetNotEligible(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { tweetId } = req.params;
      const { reason } = req.body;
      const moderatorId = req.user.id;

      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet) {
        return res.status(404).json({
          success: false,
          message: 'Tweet non trouvé'
        });
      }

      // Créer une entrée dans la table moderation_actions
      await ModerationAction.create({
        type: 'mark_not_eligible',
        target_type: 'tweet',
        target_id: tweetId,
        moderator_id: moderatorId,
        reason,
        status: 'active',
        metadata: {
          original_status: tweet.moderation_status,
          original_tweet_content: (tweet.content || '').substring(0, 100)
        }
      });

      // Marquer le tweet comme non éligible
      await tweet.update({
        moderation_status: 'not_eligible',
        moderation_reason: reason
      });

      logger.info(`Tweet marqué comme non éligible: ${tweetId} par ${req.user.username}`);

      res.json({
        success: true,
        message: 'Tweet marqué comme non éligible aux recommandations',
        data: {
          tweet_id: tweetId,
          reason,
          new_status: 'not_eligible'
        }
      });
    } catch (error) {
      logger.error('Erreur lors du marquage du tweet comme non éligible:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du marquage du tweet comme non éligible'
      });
    }
  }

  // ===== DASHBOARD ET ANALYTICS =====

  // Obtenir le dashboard de modération
  async getModerationDashboard(req, res) {
    try {
      // Statistiques générales
      const totalUsers = await User.count();
      const suspendedUsers = await User.count({ where: { is_suspended: true } });
      const bannedUsers = await User.count({ where: { is_suspended: true } });
      const pendingTweets = await Tweet.count({ where: { moderation_status: 'pending' } });

      // Actions récentes
      const recentActions = await User.findAll({
        where: {
          moderation_history: {
            [Op.not]: null
          }
        },
        attributes: ['id', 'username', 'moderation_history'],
        order: [['updated_at', 'DESC']],
        limit: 10
      });

      res.json({
        success: true,
        data: {
          stats: {
            total_users: totalUsers,
            suspended_users: suspendedUsers,
            banned_users: bannedUsers,
            pending_tweets: pendingTweets
          },
          recent_actions: recentActions
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération du dashboard:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération du dashboard'
      });
    }
  }

  // Obtenir les alertes de modération
  async getModerationAlerts(req, res) {
    try {
      const { priority, limit = 10 } = req.query;

      // Simuler des alertes (à implémenter avec un vrai système d'alertes)
      const alerts = [
        {
          id: 1,
          type: 'high_reports',
          priority: 'high',
          message: 'Utilisateur @spam_user a reçu 15 signalements en 24h',
          timestamp: new Date(),
          action_required: true
        },
        {
          id: 2,
          type: 'suspicious_activity',
          priority: 'medium',
          message: 'Activité suspecte détectée sur le compte @bot_account',
          timestamp: new Date(Date.now() - 3600000),
          action_required: false
        }
      ];

      const filteredAlerts = priority 
        ? alerts.filter(alert => alert.priority === priority)
        : alerts;

      res.json({
        success: true,
        data: {
          alerts: filteredAlerts.slice(0, parseInt(limit))
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des alertes:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des alertes'
      });
    }
  }

  // ===== MÉTHODES STUB POUR LES AUTRES ROUTES =====

  async getReports(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, status, type, priority } = req.query;
      const offset = (page - 1) * limit;

      // Construire les conditions de recherche
      const where = {};
      
      if (status && status !== 'all') {
        where.status = status;
      }
      
      if (type && type !== 'all') {
        where.type = type;
      }
      
      if (priority) {
        where.priority = parseInt(priority);
      }

      // Récupérer les signalements avec pagination
      const { count, rows: reports } = await Report.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'reporter',
            attributes: ['id', 'username', 'full_name', 'avatar']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      // Formater les données pour la compatibilité avec le frontend
      const formattedReports = reports.map(report => {
        const reportData = report.toJSON();
        return {
          id: reportData.id,
          type: reportData.type,
          reporterId: reportData.reporter_id,
          reporterName: reportData.reporter?.full_name || reportData.reporter?.username || 'Utilisateur inconnu',
          targetId: reportData.target_id,
          targetName: `Cible ${reportData.target_type}`,
          reason: reportData.reason,
          severity: reportData.severity,
          status: reportData.status,
          createdAt: reportData.created_at,
          priority: reportData.priority,
          moderatorNotes: reportData.moderator_notes,
          resolvedAt: reportData.resolved_at,
          resolutionAction: reportData.resolution_action,
          resolutionReason: reportData.resolution_reason
        };
      });

      res.json({
        success: true,
        data: {
          reports: formattedReports,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des signalements:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des signalements'
      });
    }
  }

  async getReportDetails(req, res) {
    res.json({
      success: true,
      message: 'Détails du signalement (à implémenter)',
      data: { report: {} }
    });
  }

  async updateReportStatus(req, res) {
    res.json({
      success: true,
      message: 'Statut du signalement mis à jour (à implémenter)'
    });
  }

  async getModerationStats(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      // Compter les utilisateurs par statut
      const totalUsers = await User.count();
      const activeUsers = await User.count({ where: { is_suspended: false } });
      const suspendedUsers = await User.count({ where: { is_suspended: true } });
      const bannedUsers = await User.count({ where: { is_suspended: true } });
      const verifiedUsers = await User.count({ where: { verified: true } });
      const premiumUsers = await User.count({ where: { premium: true } });

      // Compter les tweets par statut de modération
      const totalTweets = await Tweet.count();
      const pendingTweets = await Tweet.count({ where: { moderation_status: 'pending' } });
      const approvedTweets = await Tweet.count({ where: { moderation_status: 'approved' } });
      const rejectedTweets = await Tweet.count({ where: { moderation_status: 'rejected' } });
      const notEligibleTweets = await Tweet.count({ where: { moderation_status: 'not_eligible' } });

      // Compter les signalements par statut
      const totalReports = await Report.count();
      const pendingReports = await Report.count({
        where: {
          status: 'pending'
        }
      });
      const investigatingReports = await Report.count({
        where: {
          status: 'investigating'
        }
      });
      const resolvedReports = await Report.count({
        where: {
          status: 'resolved'
        }
      });
      const dismissedReports = await Report.count({
        where: {
          status: 'dismissed'
        }
      });

      // Compter les signalements par type
      const tweetReports = await Report.count({
        where: {
          type: 'tweet'
        }
      });
      const userReports = await Report.count({
        where: {
          type: 'user'
        }
      });

      // Compter les actions de modération
      const moderationActions = await ModerationAction.count();
      const activeActions = await ModerationAction.count({
        where: {
          status: 'active'
        }
      });
      const expiredActions = await ModerationAction.count({
        where: {
          status: 'expired'
        }
      });
      const reversedActions = await ModerationAction.count({
        where: {
          status: 'reversed'
        }
      });

      // Statistiques par type d'action
      const banActions = await ModerationAction.count({
        where: {
          type: 'ban'
        }
      });
      const suspendActions = await ModerationAction.count({
        where: {
          type: 'suspend'
        }
      });
      const deleteActions = await ModerationAction.count({
        where: {
          type: 'delete'
        }
      });
      const approveActions = await ModerationAction.count({
        where: {
          type: 'approve'
        }
      });
      const rejectActions = await ModerationAction.count({
        where: {
          type: 'reject'
        }
      });

      // Statistiques des modérateurs
      const totalModerators = await User.count({
        where: {
          role: {
            [Op.in]: ['moderateur', 'admin', 'superadmin', 'classeurdetweets']
          }
        }
      });

      // Statistiques de performance
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const actionsToday = await ModerationAction.count({
        where: {
          created_at: {
            [Op.gte]: today
          }
        }
      });

      const reportsToday = await Report.count({
        where: {
          created_at: {
            [Op.gte]: today
          }
        }
      });

      // Statistiques des tickets d'unban
      const pendingUnbanTickets = await UnbanTicket.count({
        where: { status: 'pending' }
      });
      const totalUnbanTickets = await UnbanTicket.count();

      const stats = {
        // Statistiques utilisateurs
        users: {
          total: totalUsers,
          active: activeUsers,
          suspended: suspendedUsers,
          banned: bannedUsers,
          verified: verifiedUsers,
          premium: premiumUsers
        },
        // Statistiques tweets
        tweets: {
          total: totalTweets,
          pending: pendingTweets,
          approved: approvedTweets,
          rejected: rejectedTweets,
          not_eligible: notEligibleTweets
        },
        // Statistiques signalements
        reports: {
          total: totalReports,
          pending: pendingReports,
          investigating: investigatingReports,
          resolved: resolvedReports,
          dismissed: dismissedReports,
          byType: {
            tweets: tweetReports,
            users: userReports
          }
        },
        actions: {
          total: moderationActions,
          active: activeActions,
          expired: expiredActions,
          reversed: reversedActions,
          byType: {
            bans: banActions,
            suspensions: suspendActions,
            deletions: deleteActions,
            approvals: approveActions,
            rejections: rejectActions
          }
        },
        // Statistiques modérateurs
        moderators: {
          total: totalModerators
        },
        // Statistiques des tickets d'unban
        unbanTickets: {
          total: totalUnbanTickets,
          pending: pendingUnbanTickets
        },
        // Statistiques de performance
        performance: {
          actionsToday: actionsToday,
          reportsToday: reportsToday
        }
      };

      res.json({
        success: true,
        data: { stats }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des statistiques'
      });
    }
  }

  async getModerationTrends(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { period = '7d' } = req.query;
      
      // Calculer la date de début basée sur la période
      let startDate;
      const now = new Date();
      
      switch (period) {
        case '7d':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '90d':
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }

      // Récupérer les tendances des signalements
      const reportTrends = await Report.findAll({
        where: {
          created_at: {
            [Op.gte]: startDate
          }
        },
        attributes: [
          [sequelize.fn('DATE', sequelize.col('created_at')), 'date'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          'status'
        ],
        group: ['DATE(created_at)', 'status'],
        order: [['date', 'ASC']]
      });

      // Récupérer les tendances des actions de modération
      const actionTrends = await ModerationAction.findAll({
        where: {
          created_at: {
            [Op.gte]: startDate
          }
        },
        attributes: [
          [sequelize.fn('DATE', sequelize.col('created_at')), 'date'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          'type'
        ],
        group: ['DATE(created_at)', 'type'],
        order: [['date', 'ASC']]
      });

      // Récupérer les tendances des utilisateurs
      const userTrends = await User.findAll({
        where: {
          created_at: {
            [Op.gte]: startDate
          }
        },
        attributes: [
          [sequelize.fn('DATE', sequelize.col('created_at')), 'date'],
          [sequelize.fn('COUNT', sequelize.col('id')), 'count']
        ],
        group: ['DATE(created_at)'],
        order: [['date', 'ASC']]
      });

      // Formater les données pour les graphiques
      const trends = {
        reports: reportTrends.map(trend => ({
          date: trend.getDataValue('date'),
          count: parseInt(trend.getDataValue('count')),
          status: trend.status
        })),
        actions: actionTrends.map(trend => ({
          date: trend.getDataValue('date'),
          count: parseInt(trend.getDataValue('count')),
          type: trend.type
        })),
        users: userTrends.map(trend => ({
          date: trend.getDataValue('date'),
          count: parseInt(trend.getDataValue('count'))
        }))
      };

      res.json({
        success: true,
        data: { trends }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des tendances:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des tendances'
      });
    }
  }

  async getModeratorMetrics(req, res) {
    res.json({
      success: true,
      message: 'Métriques des modérateurs (à implémenter)',
      data: { metrics: [] }
    });
  }

  async getModerationHistory(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, action_type, type, target_type, targetType, status, moderator_id, start_date, end_date } = req.query;
      const offset = (page - 1) * limit;

      // Construire les conditions de recherche
      const where = {};
      
      const finalType = action_type || type;
      if (finalType && finalType !== 'all') {
        where.type = finalType;
      }
      
      const finalTargetType = target_type || targetType;
      if (finalTargetType && finalTargetType !== 'all') {
        where.target_type = finalTargetType;
      }

      if (moderator_id && moderator_id !== 'all') {
        where.moderator_id = moderator_id;
      }

      if (status && status !== 'all') {
        where.status = status;
      }

      if (start_date || end_date) {
        const { Op } = require('sequelize');
        where.created_at = {};
        if (start_date) where.created_at[Op.gte] = new Date(start_date);
        if (end_date) where.created_at[Op.lte] = new Date(end_date);
      }
      
      if (status && status !== 'all') {
        where.status = status;
      }

      // Récupérer l'historique des actions de modération
      const { count, rows: actions } = await ModerationAction.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'moderator',
            attributes: ['id', 'username', 'full_name', 'avatar']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      // Formater les données pour la compatibilité avec le frontend
      const formattedHistory = actions.map(action => {
        const actionData = action.toJSON();
        return {
          id: actionData.id,
          type: actionData.type,
          targetType: actionData.target_type,
          targetId: actionData.target_id,
          targetName: `Cible ${actionData.target_type}`,
          moderatorId: actionData.moderator_id,
          moderatorName: actionData.moderator?.full_name || actionData.moderator?.username || 'Modérateur inconnu',
          reason: actionData.reason,
          duration: actionData.duration,
          createdAt: actionData.created_at,
          status: actionData.status,
          expiresAt: actionData.expires_at,
          reversedAt: actionData.reversed_at,
          reversalReason: actionData.reversal_reason,
          metadata: actionData.metadata
        };
      });

      res.json({
        success: true,
        data: {
          history: formattedHistory,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'historique:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération de l\'historique'
      });
    }
  }


  async getUserModerationHistory(req, res) {
    try {
      const { userId } = req.params;
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const { count, rows: actions } = await ModerationAction.findAndCountAll({
        where: {
          target_id: userId,
          target_type: 'user'
        },
        include: [
          {
            model: User,
            as: 'moderator',
            attributes: ['id', 'username', 'full_name', 'avatar']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      const formattedHistory = actions.map(action => {
        const actionData = action.toJSON();
        return {
          id: actionData.id,
          type: actionData.type,
          targetType: actionData.target_type,
          targetId: actionData.target_id,
          moderatorId: actionData.moderator_id,
          moderatorName: actionData.moderator?.full_name || actionData.moderator?.username || 'Modérateur inconnu',
          reason: actionData.reason,
          duration: actionData.duration,
          createdAt: actionData.created_at,
          status: actionData.status,
          metadata: actionData.metadata
        };
      });

      res.json({
        success: true,
        data: {
          history: formattedHistory,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count,
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'historique utilisateur:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération de l\'historique utilisateur'
      });
    }
  }

  async getModerators(req, res) {
    res.json({
      success: true,
      message: 'Liste des modérateurs (à implémenter)',
      data: { moderators: [] }
    });
  }

  async promoteModerator(req, res) {
    res.json({
      success: true,
      message: 'Modérateur promu (à implémenter)'
    });
  }

  async demoteModerator(req, res) {
    res.json({
      success: true,
      message: 'Modérateur rétrogradé (à implémenter)'
    });
  }

  async updateModeratorPermissions(req, res) {
    res.json({
      success: true,
      message: 'Permissions mises à jour (à implémenter)'
    });
  }

  normalizeModerationRole(role) {
    if (role === 'moderator') return 'moderateur';
    if (role === 'super_admin' || role === 'supermoderateur') return 'superadmin';
    return role || 'moderateur';
  }

  async enrichReport(report) {
    const reportData = report.toJSON ? report.toJSON() : report;
    let targetData = null;

    if (reportData.target_type === 'tweet') {
      const tweet = await Tweet.findByPk(reportData.target_id, {
        include: [{
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified']
        }]
      });
      if (tweet) {
        targetData = {
          id: tweet.id,
          content: tweet.content,
          author: tweet.author,
          created_at: tweet.created_at
        };
      }
    } else if (reportData.target_type === 'user') {
      const user = await User.findByPk(reportData.target_id, {
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'role', 'is_suspended']
      });
      if (user) targetData = user.toJSON();
    }

    return {
      ...reportData,
      target: targetData,
      reporterId: reportData.reporter_id,
      reporterName: reportData.reporter?.full_name || reportData.reporter?.username || 'Utilisateur inconnu',
      targetId: reportData.target_id,
      targetType: reportData.target_type,
      targetName: targetData?.username || targetData?.author?.username || `Cible ${reportData.target_type}`,
      createdAt: reportData.created_at,
      moderatorNotes: reportData.moderator_notes,
      resolvedAt: reportData.resolved_at,
      resolutionAction: reportData.resolution_action,
      resolutionReason: reportData.resolution_reason
    };
  }

  async getReports(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Donnees invalides',
          errors: errors.array()
        });
      }

      const { page = 1, limit = 20, status, severity, type, priority } = req.query;
      const offset = (page - 1) * limit;
      const where = {};

      if (status && status !== 'all') where.status = status;
      if (severity && severity !== 'all') where.severity = severity;
      if (type && type !== 'all') where.target_type = type;
      if (priority && priority !== 'all') where.priority = parseInt(priority, 10);

      const { count, rows: reports } = await Report.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'reporter',
            attributes: ['id', 'username', 'full_name', 'avatar']
          },
          {
            model: User,
            as: 'resolver',
            attributes: ['id', 'username', 'full_name']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10)
      });

      const enrichedReports = await Promise.all(
        reports.map(report => ModerationController.prototype.enrichReport(report))
      );
      const pagination = {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total: count,
        pages: Math.ceil(count / limit)
      };

      res.json({
        success: true,
        data: { reports: enrichedReports, pagination },
        reports: enrichedReports,
        pagination
      });
    } catch (error) {
      logger.error('Erreur lors de la recuperation des signalements:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la recuperation des signalements'
      });
    }
  }

  async getReportDetails(req, res) {
    try {
      const { reportId } = req.params;
      const report = await Report.findByPk(reportId, {
        include: [
          {
            model: User,
            as: 'reporter',
            attributes: ['id', 'username', 'full_name', 'avatar']
          },
          {
            model: User,
            as: 'resolver',
            attributes: ['id', 'username', 'full_name']
          }
        ]
      });

      if (!report) {
        return res.status(404).json({
          success: false,
          message: 'Signalement non trouve'
        });
      }

      res.json({
        success: true,
        data: { report: await ModerationController.prototype.enrichReport(report) }
      });
    } catch (error) {
      logger.error('Erreur lors de la recuperation du signalement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la recuperation du signalement'
      });
    }
  }

  async updateReportStatus(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Donnees invalides',
          errors: errors.array()
        });
      }

      const { reportId } = req.params;
      const legacyAction = req.body.action;
      const statusFromAction = legacyAction === 'resolve'
        ? 'resolved'
        : legacyAction === 'dismiss'
          ? 'dismissed'
          : legacyAction === 'escalate'
            ? 'investigating'
            : undefined;
      const status = req.body.status || statusFromAction;
      const moderator_notes = req.body.moderator_notes || req.body.moderator_note || req.body.reason || null;
      const resolution_reason = req.body.resolution_reason || req.body.action_taken || req.body.reason || null;
      const resolution_action = req.body.resolution_action || (status === 'dismissed' ? 'none' : undefined);

      if (!['pending', 'investigating', 'resolved', 'dismissed'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Status invalide'
        });
      }

      const report = await Report.findByPk(reportId);
      if (!report) {
        return res.status(404).json({
          success: false,
          message: 'Signalement non trouve'
        });
      }

      const updateData = { status };
      if (moderator_notes !== null) updateData.moderator_notes = moderator_notes;
      if (resolution_reason !== null) updateData.resolution_reason = resolution_reason;
      if (resolution_action) updateData.resolution_action = resolution_action;

      if (status === 'resolved' || status === 'dismissed') {
        updateData.resolved_by = req.user.id;
        updateData.resolved_at = new Date();
      } else {
        updateData.resolved_by = null;
        updateData.resolved_at = null;
      }

      await report.update(updateData);
      logger.info(`Signalement ${reportId} traite par ${req.user.username}: ${status}`);

      res.json({
        success: true,
        message: 'Signalement traite avec succes',
        data: { report: await ModerationController.prototype.enrichReport(report) }
      });
    } catch (error) {
      logger.error('Erreur lors de la mise a jour du signalement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la mise a jour du signalement'
      });
    }
  }

  async promoteModerator(req, res) {
    try {
      const { userId } = req.params;
      const role = ModerationController.prototype.normalizeModerationRole(req.body.role);
      const permissions = req.body.permissions || {};
      const reason = req.body.reason || 'Promotion moderation';

      if (!['moderateur', 'admin', 'superadmin', 'classeurdetweets', 'economiegardien'].includes(role)) {
        return res.status(400).json({
          success: false,
          message: 'Role invalide'
        });
      }

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouve'
        });
      }

      const mergedPermissions = {
        ...(user.moderation_permissions || {}),
        ...permissions
      };

      if (role === 'superadmin') {
        Object.assign(mergedPermissions, {
          can_ban_users: true,
          can_suspend_users: true,
          can_delete_tweets: true,
          can_verify_users: true,
          can_view_reports: true,
          can_view_analytics: true,
          can_manage_moderators: true,
          can_manage_economy: true,
          can_moderate_content: true
        });
      }

      await user.update({
        role,
        moderation_permissions: mergedPermissions
      });

      await ModerationAction.create({
        type: 'approve',
        target_type: 'user',
        target_id: user.id,
        moderator_id: req.user.id,
        reason,
        status: 'active',
        metadata: {
          action_type: 'promote_moderator',
          role,
          permissions: mergedPermissions
        }
      });

      res.json({
        success: true,
        message: 'Moderateur promu avec succes',
        data: {
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            moderation_permissions: user.moderation_permissions
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la promotion moderation:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la promotion moderation'
      });
    }
  }

  async getModerationConfig(req, res) {
    res.json({
      success: true,
      message: 'Configuration de modération (à implémenter)',
      data: { config: {} }
    });
  }



  async updateModerationConfig(req, res) {
    res.json({
      success: true,
      message: 'Configuration mise à jour (à implémenter)'
    });
  }
  // ===== GESTION DES TICKETS D'UNBAN =====
  
  // Créer un ticket d'unban
  async createUnbanTicket(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Données invalides',
          errors: errors.array()
        });
      }

      const { reason } = req.body;
      const user_id = req.user.id;
      const user = await User.findByPk(user_id);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'Utilisateur non trouvé'
        });
      }

      // Seuls les utilisateurs suspendus peuvent faire un ticket (sauf exception policiercongo mentionnée par l'utilisateur)
      if (!user.is_suspended && user.username !== 'policiercongo') {
        return res.status(400).json({
          success: false,
          message: 'Votre compte n\'est pas suspendu'
        });
      }

      // Vérifier s'il y a déjà un ticket en attente
      const existingTicket = await UnbanTicket.findOne({
        where: {
          user_id,
          status: 'pending'
        }
      });

      if (existingTicket) {
        return res.status(400).json({
          success: false,
          message: 'Vous avez déjà un ticket d\'unban en attente de traitement'
        });
      }

      // Création du ticket
      // Pas de limite de char pour policiercongo comme demandé
      const ticket = await UnbanTicket.create({
        user_id,
        reason,
        status: 'pending'
      });

      logger.info(`Nouveau ticket d'unban créé: ${ticket.id} par ${user.username}`);

      res.status(201).json({
        success: true,
        message: 'Votre demande d\'unban a été envoyée avec succès',
        data: { ticket }
      });
    } catch (error) {
      logger.error('Erreur lors de la création du ticket d\'unban:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'envoi de la demande d\'unban'
      });
    }
  }

  // Obtenir tous les tickets d'unban (Admins)
  async getUnbanTickets(req, res) {
    try {
      const { status = 'pending', page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const where = {};
      if (status !== 'all') {
        where.status = status;
      }

      const { count, rows: tickets } = await UnbanTicket.findAndCountAll({
        where,
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'full_name', 'avatar', 'is_suspended', 'suspension_reason']
          },
          {
            model: User,
            as: 'processor',
            attributes: ['id', 'username']
          }
        ],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      res.json({
        success: true,
        data: {
          tickets,
          pagination: {
            total: count,
            page: parseInt(page),
            pages: Math.ceil(count / limit)
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des tickets d\'unban:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des tickets d\'unban'
      });
    }
  }

  // Traiter un ticket d'unban
  async processUnbanTicket(req, res) {
    try {
      const { ticketId } = req.params;
      const { status, admin_notes } = req.body; // 'approved' ou 'rejected'
      const admin_id = req.user.id;

      const ticket = await UnbanTicket.findByPk(ticketId, {
        include: [{ model: User, as: 'user' }]
      });

      if (!ticket) {
        return res.status(404).json({
          success: false,
          message: 'Ticket non trouvé'
        });
      }

      if (ticket.status !== 'pending') {
        return res.status(400).json({
          success: false,
          message: 'Ce ticket a déjà été traité'
        });
      }

      // Mise à jour du ticket
      await ticket.update({
        status,
        admin_notes,
        processed_by: admin_id,
        processed_at: new Date()
      });

      // Si approuvé, on débannit l'utilisateur
      if (status === 'approved') {
        const user = ticket.user;
        if (user) {
          await user.update({
            is_suspended: false,
            suspended_at: null,
            suspended_until: null,
            suspension_reason: null
          });
          
          // Log de l'action de modération
          await ModerationAction.create({
            type: 'approve',
            target_type: 'user',
            target_id: user.id,
            moderator_id: admin_id,
            reason: 'Unban ticket approved: ' + admin_notes,
            status: 'reversed'
          });

          logger.info(`Utilisateur ${user.username} débanni via ticket d'unban`);
        }
      }

      res.json({
        success: true,
        message: `Ticket ${status === 'approved' ? 'approuvé' : 'rejeté'} avec succès`,
        data: { ticket }
      });
    } catch (error) {
      logger.error('Erreur lors du traitement du ticket d\'unban:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du traitement du ticket d\'unban'
      });
    }
  }
}

module.exports = new ModerationController();
