const MonetizationMetrics = require('../models/MonetizationMetrics');
const Tweet = require('../models/Tweet');
const User = require('../models/User');
const logger = require('../utils/logger');

class MonetizationController {
  // Obtenir les tweets éligibles à la monétisation
  static async getEligibleTweets(req, res) {
    try {
      const userId = req.user.id;
      const { limit = 20, offset = 0, minViews = 1000, minEngagement = 0.01 } = req.query;

      const eligibleTweets = await MonetizationMetrics.getEligibleTweets(userId, {
        limit: parseInt(limit),
        offset: parseInt(offset),
        minViews: parseInt(minViews),
        minEngagement: parseFloat(minEngagement)
      });

      // Formater les données pour l'affichage
      const formattedTweets = eligibleTweets.map(tweet => ({
        id: tweet.id,
        content: tweet.content,
        created_at: tweet.created_at,
        author: {
          id: tweet.author.id,
          username: tweet.author.username,
          full_name: tweet.author.full_name,
          avatar: tweet.author.avatar,
          verified: tweet.author.verified,
          premium: tweet.author.premium
        },
        stats: {
          likes: tweet.stats?.likes || 0,
          retweets: tweet.stats?.retweets || 0,
          replies: tweet.stats?.replies || 0,
          views: tweet.stats?.views || 0
        },
        monetization: {
          rpm: tweet.monetizationMetrics?.rpm || 0,
          eligibleClicks: tweet.monetizationMetrics?.eligible_clicks || 0,
          revenue: tweet.monetizationMetrics?.revenue || 0,
          isEligible: tweet.monetizationMetrics?.is_eligible || false
        }
      }));

      res.json({
        success: true,
        data: {
          tweets: formattedTweets,
          total: formattedTweets.length,
          pagination: {
            limit: parseInt(limit),
            offset: parseInt(offset)
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

  // Obtenir les revenus totaux d'un utilisateur
  static async getUserRevenue(req, res) {
    try {
      const userId = req.user.id;
      const { period = 'month' } = req.query;

      const revenue = await MonetizationMetrics.getUserTotalRevenue(userId, period);

      res.json({
        success: true,
        data: {
          totalRevenue: parseFloat(revenue.totalRevenue),
          totalViews: revenue.totalViews,
          totalClicks: revenue.totalClicks,
          averageRPM: parseFloat(revenue.averageRPM),
          period: revenue.period,
          metricsCount: revenue.metricsCount
        }
      });

    } catch (error) {
      logger.error('Erreur lors du calcul des revenus:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors du calcul des revenus',
        error: error.message
      });
    }
  }

  // Mettre à jour les métriques de monétisation d'un tweet
  static async updateTweetMetrics(req, res) {
    try {
      const { tweetId } = req.params;
      const { views, clicks, revenue } = req.body;

      // Vérifier que l'utilisateur est propriétaire du tweet
      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet || tweet.user_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Accès non autorisé à ce tweet'
        });
      }

      // Trouver ou créer les métriques de monétisation
      let metrics = await MonetizationMetrics.findOne({
        where: { tweet_id: tweetId }
      });

      if (!metrics) {
        metrics = await MonetizationMetrics.create({
          tweet_id: tweetId,
          views: 0,
          eligible_clicks: 0,
          revenue: 0,
          rpm: 0,
          is_eligible: false
        });
      }

      // Mettre à jour les métriques
      await metrics.updateMetrics({ views, clicks, revenue });

      res.json({
        success: true,
        data: {
          tweetId,
          metrics: {
            rpm: parseFloat(metrics.rpm),
            eligibleClicks: metrics.eligible_clicks,
            revenue: parseFloat(metrics.revenue),
            isEligible: metrics.is_eligible
          }
        }
      });

    } catch (error) {
      logger.error('Erreur lors de la mise à jour des métriques:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la mise à jour des métriques',
        error: error.message
      });
    }
  }

  // Simuler l'engagement pour les tests
  static async simulateEngagement(req, res) {
    try {
      const { tweetId } = req.params;

      // Vérifier que l'utilisateur est propriétaire du tweet
      const tweet = await Tweet.findByPk(tweetId);
      if (!tweet || tweet.user_id !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Accès non autorisé à ce tweet'
        });
      }

      const updatedMetrics = await MonetizationMetrics.simulateEngagement(tweetId);

      if (!updatedMetrics) {
        return res.status(404).json({
          success: false,
          message: 'Métriques de monétisation non trouvées pour ce tweet'
        });
      }

      res.json({
        success: true,
        data: {
          tweetId,
          metrics: {
            rpm: parseFloat(updatedMetrics.rpm),
            eligibleClicks: updatedMetrics.eligible_clicks,
            revenue: parseFloat(updatedMetrics.revenue),
            isEligible: updatedMetrics.is_eligible
          }
        }
      });

    } catch (error) {
      logger.error('Erreur lors de la simulation d\'engagement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la simulation d\'engagement',
        error: error.message
      });
    }
  }

  // Obtenir les statistiques de monétisation globales
  static async getMonetizationStats(req, res) {
    try {
      const userId = req.user.id;

      // Récupérer les statistiques globales
      const [monthlyRevenue, totalTweets, eligibleTweets] = await Promise.all([
        MonetizationMetrics.getUserTotalRevenue(userId, 'month'),
        Tweet.count({ where: { user_id: userId } }),
        MonetizationMetrics.count({ 
          where: { is_eligible: true },
          include: [{
            model: Tweet,
            as: 'tweet',
            where: { user_id: userId },
            attributes: []
          }]
        })
      ]);

      res.json({
        success: true,
        data: {
          monthlyRevenue: parseFloat(monthlyRevenue.totalRevenue),
          totalTweets,
          eligibleTweets,
          averageRPM: parseFloat(monthlyRevenue.averageRPM),
          totalViews: monthlyRevenue.totalViews,
          totalClicks: monthlyRevenue.totalClicks
        }
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
}

module.exports = MonetizationController;
