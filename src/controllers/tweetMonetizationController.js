/**
 * Ancienne surface de monétisation, réduite à ce qui a survécu au passage au
 * pot hebdomadaire (`/api/creator-pool`).
 *
 * Elle reste montée parce que des clients déjà installés l'appellent. Deux
 * règles ont guidé ce qui reste :
 *
 *   - **Ce qui mentait a été retiré, pas adapté.** `rpm-rates`,
 *     `eligibility/:tweetId` et `reward/:tweetId` annonçaient un prix par
 *     tweet qui n'existe plus : un tweet ne vaut rien tout seul, sa part
 *     dépend du vivier de la semaine. Les servir avec des chiffres inventés
 *     serait pire que de renvoyer une erreur explicite.
 *   - **Ce qui reste vrai continue de répondre** : l'aperçu des gains et
 *     l'encaissement, désormais adossés aux parts figées.
 */

const TweetMonetizationService = require('../services/tweetMonetizationService');
const logger = require('../utils/logger');

/** Réponse unique pour les routes dont le concept n'existe plus. */
function gone(res, replacement) {
  return res.status(410).json({
    success: false,
    message: 'Cette route a été retirée : la monétisation ne se calcule plus tweet par tweet.',
    replacement,
  });
}

class TweetMonetizationController {
  static async getRPMRates(req, res) {
    return gone(res, 'GET /api/creator-pool/dashboard');
  }

  static async checkEligibility(req, res) {
    return gone(res, 'GET /api/creator-pool/dashboard');
  }

  static async calculateReward(req, res) {
    return gone(res, 'GET /api/creator-pool/dashboard');
  }

  static async getUserEligibleTweets(req, res) {
    return gone(res, 'GET /api/creator-pool/dashboard');
  }

  static async distributeReward(req, res) {
    return gone(res, 'POST /api/creator-pool/claim');
  }

  /** Gains figés en attente + projection de la semaine en cours. */
  static async previewEarnings(req, res) {
    try {
      const data = await TweetMonetizationService.previewEarnings(req.user.id);
      res.json({ success: true, data });
    } catch (error) {
      logger.error('Erreur aperçu des gains:', error);
      res.status(500).json({ success: false, message: 'Impossible de charger tes gains' });
    }
  }

  /** Encaisse toutes les parts qui attendent. */
  static async processEligibleTweets(req, res) {
    try {
      const result = await TweetMonetizationService.collectEarnings(req.user.id);
      if (result.locked) {
        return res.status(403).json({ success: false, message: result.reason });
      }
      res.json({
        success: true,
        message: result.periodsCollected > 0
          ? `${result.totalCollected.toFixed(2)} encaissés`
          : 'Aucune part à encaisser pour le moment',
        data: result,
      });
    } catch (error) {
      logger.error('Erreur encaissement:', error);
      res.status(500).json({ success: false, message: 'Encaissement impossible' });
    }
  }

  static async getStats(req, res) {
    try {
      const stats = await TweetMonetizationService.getMonetizationStats();
      res.json({ success: true, data: stats });
    } catch (error) {
      logger.error('Erreur statistiques de monétisation:', error);
      res.status(500).json({ success: false, message: 'Statistiques indisponibles' });
    }
  }
}

module.exports = TweetMonetizationController;
