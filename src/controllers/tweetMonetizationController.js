/**
 * Contrôleur pour la monétisation des tweets
 */

const TweetMonetizationService = require('../services/tweetMonetizationService');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

class TweetMonetizationController {
  /**
   * Obtenir les taux RPM actuels
   */
  static async getRPMRates(req, res) {
    try {
      res.json({
        success: true,
        data: {
          rates: TweetMonetizationService.REWARD_RATES,
          eligibilityCriteria: TweetMonetizationService.ELIGIBILITY_CRITERIA,
          description: {
            views: `${TweetMonetizationService.REWARD_RATES.VIEWS} TWC par vue`,
            likes: `${TweetMonetizationService.REWARD_RATES.LIKES} TWC par like`,
            comments: `${TweetMonetizationService.REWARD_RATES.COMMENTS} TWC par commentaire`,
            retweets: `${TweetMonetizationService.REWARD_RATES.RETWEETS} TWC par retweet`
          }
        }
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des taux RPM:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des taux RPM',
        error: error.message
      });
    }
  }

  /**
   * Vérifier l'éligibilité d'un tweet avec le nouveau système RPM
   */
  static async checkEligibility(req, res) {
    try {
      const { tweetId } = req.params;

      if (!tweetId) {
        return res.status(400).json({
          success: false,
          message: 'ID du tweet requis'
        });
      }

      const eligibility = await TweetMonetizationService.calculateTweetEligibility(tweetId);

      res.json({
        success: true,
        data: {
          ...eligibility,
          rpmRates: TweetMonetizationService.RPM_RATES,
          eligibilityCriteria: TweetMonetizationService.ELIGIBILITY_CRITERIA
        }
      });

    } catch (error) {
      logger.error('Erreur lors de la vérification de l\'éligibilité:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la vérification de l\'éligibilité',
        error: error.message
      });
    }
  }

  /**
   * Calculer la récompense d'un tweet
   */
  static async calculateReward(req, res) {
    try {
      const { tweetId } = req.params;

      if (!tweetId) {
        return res.status(400).json({
          success: false,
          message: 'ID du tweet requis'
        });
      }

      const rewardData = await TweetMonetizationService.calculateTweetReward(tweetId);

      res.json({
        success: true,
        data: rewardData
      });

    } catch (error) {
      logger.error('Erreur lors du calcul de la récompense:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du calcul de la récompense',
        error: error.message
      });
    }
  }

  /**
   * Distribuer une récompense
   */
  static async distributeReward(req, res) {
    try {
      const { tweetId } = req.params;
      const { userId } = req.body;

      if (!tweetId || !userId) {
        return res.status(400).json({
          success: false,
          message: 'ID du tweet et ID utilisateur requis'
        });
      }

      const result = await TweetMonetizationService.distributeReward(tweetId, userId);

      res.json({
        success: result.success,
        data: result
      });

    } catch (error) {
      logger.error('Erreur lors de la distribution de la récompense:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la distribution de la récompense',
        error: error.message
      });
    }
  }

  /**
   * Prévisualiser les gains sans les distribuer
   */
  static async previewEarnings(req, res) {
    try {
      const userId = req.user.id;
      const result = await TweetMonetizationService.previewEarnings(userId);

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.error('Erreur lors de la prévisualisation des gains:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la prévisualisation des gains',
        error: error.message
      });
    }
  }

  /**
   * Traiter tous les tweets éligibles
   */
  static async processEligibleTweets(req, res) {
    try {
      const userId = req.user.id; // Récupérer l'ID de l'utilisateur authentifié
      const result = await TweetMonetizationService.processEligibleTweets(userId);

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.error('Erreur lors du traitement des tweets éligibles:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du traitement des tweets éligibles',
        error: error.message
      });
    }
  }

  /**
   * Obtenir les statistiques de monétisation
   */
  static async getStats(req, res) {
    try {
      const stats = await TweetMonetizationService.getMonetizationStats();

      res.json({
        success: true,
        data: stats
      });

    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des statistiques',
        error: error.message
      });
    }
  }

  /**
   * Obtenir les tweets éligibles d'un utilisateur
   */
  static async getUserEligibleTweets(req, res) {
    try {
      const { userId } = req.params;
      const { page = 1, limit = 20 } = req.query;

      if (!userId) {
        return res.status(400).json({
          success: false,
          message: 'ID utilisateur requis'
        });
      }

      // Récupérer les tweets de l'utilisateur des 7 derniers jours
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      
      const { Tweet } = require('../models');

      const tweets = await Tweet.findAll({
        where: {
          user_id: userId,
          createdAt: {
            [Op.gte]: sevenDaysAgo
          }
        },
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        offset: (parseInt(page) - 1) * parseInt(limit)
      });

      // Analyser chaque tweet
      const analyzedTweets = [];
      for (const tweet of tweets) {
        try {
          const eligibility = await TweetMonetizationService.calculateTweetEligibility(tweet.id);
          const rewardData = await TweetMonetizationService.calculateTweetReward(tweet.id);

          analyzedTweets.push({
            id: tweet.id,
            content: tweet.content,
            createdAt: tweet.createdAt,
            likesCount: tweet.likesCount || 0,
            retweetsCount: tweet.retweetsCount || 0,
            repliesCount: tweet.repliesCount || 0,
            eligibility: eligibility,
            reward: rewardData.reward,
            multipliers: rewardData.multipliers,
            factors: rewardData.factors
          });
        } catch (error) {
          logger.error(`Erreur lors de l'analyse du tweet ${tweet.id}:`, error);
        }
      }

      res.json({
        success: true,
        data: {
          tweets: analyzedTweets,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: analyzedTweets.length
          }
        }
      });

    } catch (error) {
      logger.error('Erreur lors de la récupération des tweets éligibles:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des tweets éligibles',
        error: error.message
      });
    }
  }
}

module.exports = TweetMonetizationController;
