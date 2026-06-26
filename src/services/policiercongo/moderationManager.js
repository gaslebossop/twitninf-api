/**
 * 🛡️ Gestionnaire de Modération PolicierCongo
 * 
 * Gère les signalements (Reports) effectués par le bot
 */

const logger = require('../../utils/logger');
const { Report, Tweet, User } = require('../../models');
const { POLICE_ACCOUNT_ID } = require('./config');

class ModerationManager {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    this.initialized = true;
    logger.info('🛡️ Gestionnaire de modération PolicierCongo prêt');
  }

  /**
   * Crée un signalement sur un contenu ou un utilisateur
   */
  async createReport(targetId, targetType, reason, severity = 'medium') {
    try {
      if (!targetId || !targetType || !reason) {
        throw new Error('Données de signalement incomplètes (target_id, target_type, reason requis)');
      }

      // 1. Vérifier si un signalement identique n'existe pas déjà par PolicierCongo (PENDING)
      const existing = await Report.findOne({
        where: {
          reporter_id: POLICE_ACCOUNT_ID,
          target_id: targetId,
          target_type: targetType,
          status: 'pending'
        }
      });

      if (existing) {
        logger.info(`🛡️ Signalement déjà existant pour ${targetType} ${targetId} par PolicierCongo`);
        return { success: true, message: 'Signalement déjà en cours', reportId: existing.id };
      }

      // 2. Créer le signalement
      const report = await Report.create({
        reporter_id: POLICE_ACCOUNT_ID,
        target_id: targetId,
        target_type: targetType,
        type: targetType, // Double champ pour compatibilité
        reason: reason,
        severity: severity,
        status: 'pending',
        priority: severity === 'critical' ? 3 : (severity === 'high' ? 2 : 1),
        metadata: { source: 'policiercongo_automation' }
      });

      logger.info(`🛡️ Nouveau signalement créé par PolicierCongo sur ${targetType} ${targetId} (raison: ${reason})`);
      return { success: true, reportId: report.id };

    } catch (error) {
      logger.error('❌ Erreur createReport:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new ModerationManager();
