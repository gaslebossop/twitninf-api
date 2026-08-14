/**
 * Contrôleur du programme de monétisation (candidature + revue admin)
 */

const MonetizationProgramService = require('../services/monetizationProgramService');
const logger = require('../utils/logger');

class MonetizationProgramController {
  static async getStatus(req, res) {
    try {
      const eligibility = await MonetizationProgramService.getEligibility(req.user.id);
      res.json({ success: true, data: eligibility });
    } catch (error) {
      logger.error('Erreur getStatus programme monétisation:', error);
      res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
  }

  static async apply(req, res) {
    try {
      const result = await MonetizationProgramService.applyToProgram(req.user.id);
      if (!result.success) {
        return res.status(400).json({ success: false, message: result.reason });
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('Erreur apply programme monétisation:', error);
      res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
  }

  static async listApplications(req, res) {
    try {
      const applications = await MonetizationProgramService.listPendingApplications();
      res.json({ success: true, data: applications });
    } catch (error) {
      logger.error('Erreur listApplications programme monétisation:', error);
      res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
  }

  static async reviewApplication(req, res) {
    try {
      const { userId } = req.params;
      const { decision, reason } = req.body;
      const result = await MonetizationProgramService.reviewApplication(userId, req.user.id, decision, reason);
      if (!result.success) {
        return res.status(400).json({ success: false, message: result.reason });
      }
      res.json({ success: true, data: { status: result.status } });
    } catch (error) {
      logger.error('Erreur reviewApplication programme monétisation:', error);
      res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
  }
}

module.exports = MonetizationProgramController;
