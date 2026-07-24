const { User } = require('../models');
const logger = require('../utils/logger');

// Invalide le cache de statut du gate global de ban (prise d'effet immédiate
// d'un ban/déban, sans attendre l'expiration du TTL). Lazy-require pour éviter
// toute dépendance circulaire.
function invalidateBanCache(userId) {
  try {
    require('../middleware/globalBanMiddleware').invalidateUser(String(userId));
  } catch (e) {
    logger.debug('[banService] invalidateBanCache indisponible:', e.message);
  }
}

class BanService {
  // Suspendre un utilisateur temporairement
  static async suspendUser(userId, reason, durationDays = 7, adminId = null) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('Utilisateur non trouvé');
      }

      const suspendedUntil = new Date();
      suspendedUntil.setDate(suspendedUntil.getDate() + durationDays);

      await user.update({
        is_suspended: true,
        suspended_at: new Date(),
        suspended_until: suspendedUntil,
        suspension_reason: reason,
        suspension_meta: {
          admin_id: adminId,
          duration_days: durationDays,
          previous_ban_count: user.ban_count
        }
      });

      invalidateBanCache(userId);
      logger.info(`Utilisateur ${user.username} suspendu pour ${durationDays} jours. Raison: ${reason}`);

      return {
        success: true,
        user: user.username,
        suspended_until: suspendedUntil,
        reason: reason
      };
    } catch (error) {
      logger.error('Erreur lors de la suspension:', error);
      throw error;
    }
  }

  // Lever une suspension
  static async unsuspendUser(userId, adminId = null) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('Utilisateur non trouvé');
      }

      await user.update({
        is_suspended: false,
        suspended_at: null,
        suspended_until: null,
        suspension_reason: null,
        suspension_meta: {
          ...user.suspension_meta,
          unsuspended_by: adminId,
          unsuspended_at: new Date()
        }
      });

      invalidateBanCache(userId);
      logger.info(`Suspension levée pour l'utilisateur ${user.username}`);

      return {
        success: true,
        user: user.username,
        message: 'Suspension levée avec succès'
      };
    } catch (error) {
      logger.error('Erreur lors de la levée de suspension:', error);
      throw error;
    }
  }

  // Ajouter un ban (incrémenter le compteur)
  static async addBan(userId, reason, adminId = null) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('Utilisateur non trouvé');
      }

      const newBanCount = user.ban_count + 1;
      
      await user.update({
        ban_count: newBanCount,
        suspension_meta: {
          ...user.suspension_meta,
          last_ban_reason: reason,
          last_ban_date: new Date(),
          last_ban_admin: adminId,
          total_bans: newBanCount
        }
      });

      // Si c'est le 5ème ban, bannir définitivement
      if (newBanCount >= 5) {
        await user.update({
          is_suspended: true,
          suspended_at: new Date(),
          suspended_until: null, // Permanent
          suspension_reason: 'Bannissement définitif - 5 violations',
          suspension_meta: {
            ...user.suspension_meta,
            permanent_ban: true,
            permanent_ban_date: new Date()
          }
        });
        
        logger.warn(`Utilisateur ${user.username} banni définitivement (5ème violation)`);
      }

      invalidateBanCache(userId);
      logger.info(`Ban ajouté pour ${user.username}. Total: ${newBanCount}. Raison: ${reason}`);

      return {
        success: true,
        user: user.username,
        ban_count: newBanCount,
        is_permanent: newBanCount >= 5,
        reason: reason
      };
    } catch (error) {
      logger.error('Erreur lors de l\'ajout du ban:', error);
      throw error;
    }
  }

  // Réduire le nombre de bans (grâce)
  static async reduceBan(userId, adminId = null) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('Utilisateur non trouvé');
      }

      if (user.ban_count <= 0) {
        throw new Error('L\'utilisateur n\'a pas de bans à réduire');
      }

      const newBanCount = Math.max(0, user.ban_count - 1);
      
      await user.update({
        ban_count: newBanCount,
        suspension_meta: {
          ...user.suspension_meta,
          ban_reduced_by: adminId,
          ban_reduced_at: new Date(),
          previous_ban_count: user.ban_count
        }
      });

      // Si on passe sous 5 bans, lever la suspension permanente
      if (user.ban_count >= 5 && newBanCount < 5) {
        await user.update({
          is_suspended: false,
          suspended_at: null,
          suspended_until: null,
          suspension_reason: null
        });
        
        logger.info(`Suspension permanente levée pour ${user.username} (ban count réduit à ${newBanCount})`);
      }

      invalidateBanCache(userId);
      logger.info(`Ban réduit pour ${user.username}. Nouveau total: ${newBanCount}`);

      return {
        success: true,
        user: user.username,
        ban_count: newBanCount,
        message: 'Ban réduit avec succès'
      };
    } catch (error) {
      logger.error('Erreur lors de la réduction du ban:', error);
      throw error;
    }
  }

  // Obtenir l'historique des bans d'un utilisateur
  static async getBanHistory(userId) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('Utilisateur non trouvé');
      }

      return {
        username: user.username,
        current_ban_count: user.ban_count,
        is_suspended: user.is_suspended,
        suspended_at: user.suspended_at,
        suspended_until: user.suspended_until,
        suspension_reason: user.suspension_reason,
        suspension_meta: user.suspension_meta,
        status: this.getUserBanStatus(user)
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'historique des bans:', error);
      throw error;
    }
  }

  // Obtenir le statut de ban d'un utilisateur
  static getUserBanStatus(user) {
    if (user.ban_count >= 5) {
      return 'PERMANENTLY_BANNED';
    } else if (user.is_suspended) {
      if (user.suspended_until && new Date() > new Date(user.suspended_until)) {
        return 'SUSPENSION_EXPIRED';
      } else {
        return 'SUSPENDED';
      }
    } else if (user.ban_count > 0) {
      return 'WARNED';
    } else {
      return 'CLEAN';
    }
  }

  // Nettoyer les suspensions expirées (tâche cron)
  static async cleanupExpiredSuspensions() {
    try {
      const expiredUsers = await User.findAll({
        where: {
          is_suspended: true,
          suspended_until: {
            [User.sequelize.Op.lt]: new Date()
          }
        }
      });

      let cleanedCount = 0;
      for (const user of expiredUsers) {
        await this.unsuspendUser(user.id);
        cleanedCount++;
      }

      if (cleanedCount > 0) {
        logger.info(`${cleanedCount} suspensions expirées nettoyées automatiquement`);
      }

      return cleanedCount;
    } catch (error) {
      logger.error('Erreur lors du nettoyage des suspensions expirées:', error);
      throw error;
    }
  }

  // Vérifier et mettre à jour le statut de ban d'un utilisateur en temps réel
  static async checkAndUpdateUserBanStatus(userId) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('Utilisateur non trouvé');
      }

      let needsUpdate = false;
      const updates = {};

      // Vérifier si une suspension temporaire est expirée
      if (user.is_suspended && user.suspended_until && new Date() > new Date(user.suspended_until)) {
        updates.is_suspended = false;
        updates.suspended_until = null;
        updates.suspension_reason = null;
        needsUpdate = true;
        logger.info(`Suspension expirée détectée pour ${user.username}, mise à jour automatique`);
      }

      // Plus de logique de ban_count, seulement is_suspended

      // Appliquer les mises à jour si nécessaire
      if (needsUpdate) {
        await user.update(updates);
        invalidateBanCache(userId);
        logger.info(`Statut de ban de ${user.username} mis à jour automatiquement`);
      }

      return {
        success: true,
        needsUpdate,
        updates,
        currentStatus: this.getUserBanStatus(user),
        isSuspended: user.is_suspended
      };
    } catch (error) {
      logger.error('Erreur lors de la vérification du statut de ban:', error);
      throw error;
    }
  }
}

module.exports = BanService;
