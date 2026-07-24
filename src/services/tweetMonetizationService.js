/**
 * Service de monétisation des tweets éligibles
 * Système de récompense dual : Standard pour les Tweets, Boosté pour les Vidéos
 */

const { sequelize } = require('../database/index');
const { Op } = require('sequelize');
const { UserWallet, VirtualCurrency, Tweet, User } = require('../models');
const NewEconomyService = require('./newEconomyService');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const logger = require('../utils/logger');

class TweetMonetizationService {
  /**
   * Taux de récompenses STANDARDS (Tweets classiques)
   */
  static STANDARD_RATES = {
    VIEWS: 0.01,             // 0.01 TWC par vue
    LIKES: 0.05,             // 0.05 TWC par like
    COMMENTS: 0.08,          // 0.08 TWC par commentaire
    RETWEETS: 0.10,          // 0.10 TWC par retweet
    WATCHTIME_PER_SEC: 0    // Pas de watchtime pour les tweets
  };

  /**
   * Taux de récompenses BOOSTÉS (Vidéos uniquement)
   */
  static VIDEO_BOOSTED_RATES = {
    VIEWS: 0.05 / 10,            // 0.05 TWC par vue (Boost x5)
    LIKES: 0.15 / 10,            // 0.15 TWC par like (Boost x3)
    COMMENTS: 0.25 / 10,         // 0.25 TWC par commentaire (Boost x3)
    RETWEETS: 0.50 / 10,         // 0.50 TWC par retweet (Boost x5)
    WATCHTIME_PER_SEC: 0.016 / 17 // ~1.00 TWC par minute de vidéo vue
  };

  /**
   * Sélectionner les taux appropriés en fonction du type de tweet
   */
  static getRatesForTweet(tweetType) {
    if (tweetType === 'video') {
      return this.VIDEO_BOOSTED_RATES;
    }
    return this.STANDARD_RATES;
  }

  /**
   * Fonction utilitaire pour arrondir les montants TWC à 2 décimales
   */
  static roundTWC(amount) {
    return Math.round(amount * 100) / 100;
  }

  /**
   * Calculer l'éligibilité d'un tweet et sa récompense potentielle
   */
  static async calculateTweetEligibility(tweetId) {
    try {
      const tweet = await Tweet.findByPk(tweetId, {
        include: [{
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'verified', 'stats']
        }]
      });

      if (!tweet) {
        throw new Error('Tweet non trouvé');
      }

      // Données d'engagement
      const views = tweet.viewCount || 0;
      const likes = tweet.likesCount || 0;
      const comments = tweet.repliesCount || 0;
      const retweets = tweet.retweetsCount || 0;
      const totalInteractions = likes + comments + retweets;

      // Watchtime (depuis les métadonnées)
      const watchTimeSeconds = parseFloat(tweet.metadata?.total_watch_time) || 0;

      // Déterminer les taux applicables
      const currentRates = this.getRatesForTweet(tweet.tweet_type);

      // Vérifier l'âge du tweet
      const tweetAge = Date.now() - new Date(tweet.createdAt).getTime();
      const ageInHours = tweetAge / (1000 * 60 * 60);

      // Tous les tweets sont éligibles
      const isEligible = true;

      // Calculer le score d'engagement (0-100)
      const engagementRate = totalInteractions > 0 ? (totalInteractions / Math.max(views, 1)) * 100 : 0;
      const score = Math.min(100, Math.round(engagementRate * 10));

      const rewards = {
        views: this.roundTWC(views * currentRates.VIEWS),
        likes: this.roundTWC(likes * currentRates.LIKES),
        comments: this.roundTWC(comments * currentRates.COMMENTS),
        retweets: this.roundTWC(retweets * currentRates.RETWEETS),
        watchtime: this.roundTWC(watchTimeSeconds * currentRates.WATCHTIME_PER_SEC)
      };

      const totalReward = this.roundTWC(Object.values(rewards).reduce((sum, reward) => sum + reward, 0));

      // Créer les raisons d'éligibilité
      const reasons = [];
      const label = tweet.tweet_type === 'video' ? '🎬 Vidéo' : '📝 Tweet';
      reasons.push(`✅ ${label} éligible pour monétisation`);
      reasons.push(`💰 Récompense totale: ${totalReward.toFixed(2)} TWC`);
      reasons.push(`👁️ Vues: ${views} × ${currentRates.VIEWS} = ${rewards.views.toFixed(2)} TWC`);

      if (watchTimeSeconds > 0 && currentRates.WATCHTIME_PER_SEC > 0) {
        reasons.push(`⏱️ Watchtime: ${Math.round(watchTimeSeconds)}s × ${currentRates.WATCHTIME_PER_SEC} = ${rewards.watchtime.toFixed(2)} TWC`);
      }

      reasons.push(`❤️ Likes: ${likes} × ${currentRates.LIKES} = ${rewards.likes.toFixed(2)} TWC`);
      reasons.push(`💬 Commentaires: ${comments} × ${currentRates.COMMENTS} = ${rewards.comments.toFixed(2)} TWC`);
      reasons.push(`🔄 Retweets: ${retweets} × ${currentRates.RETWEETS} = ${rewards.retweets.toFixed(2)} TWC`);

      const eligibility = {
        isEligible,
        score: score / 100,
        tweetType: tweet.tweet_type,
        factors: {
          views: { count: views, rate: currentRates.VIEWS, reward: rewards.views },
          likes: { count: likes, rate: currentRates.LIKES, reward: rewards.likes },
          comments: { count: comments, rate: currentRates.COMMENTS, reward: rewards.comments },
          retweets: { count: retweets, rate: currentRates.RETWEETS, reward: rewards.retweets },
          watchtime: { seconds: watchTimeSeconds, rate: currentRates.WATCHTIME_PER_SEC, reward: rewards.watchtime },
          engagement: { rate: engagementRate, totalInteractions },
          age: { hours: ageInHours }
        },
        rewards,
        totalReward: totalReward,
        reasons
      };

      if (tweet.author?.verified) {
        eligibility.reasons.push('🌟 Utilisateur vérifié - bonus de crédibilité');
      }

      return eligibility;

    } catch (error) {
      logger.error('Erreur lors du calcul de l\'éligibilité:', error);
      throw error;
    }
  }

  /**
   * Calculer la récompense pour un tweet
   */
  static async calculateTweetReward(tweetId) {
    try {
      const eligibility = await this.calculateTweetEligibility(tweetId);
      return {
        reward: eligibility.totalReward,
        baseReward: eligibility.totalReward,
        totalReward: eligibility.totalReward,
        breakdown: eligibility.rewards,
        factors: eligibility.factors,
        reasons: eligibility.reasons,
        rewardRates: this.getRatesForTweet(eligibility.tweetType)
      };
    } catch (error) {
      logger.error('Erreur lors du calcul de la récompense:', error);
      throw error;
    }
  }

  /**
   * Distribuer la récompense à l'utilisateur
   */
  static async distributeReward(tweetId, userId, rewardAmount = null) {
    try {
      let reward = 0;
      if (rewardAmount !== null) {
        reward = parseFloat(rewardAmount) || 0;
      } else {
        const rewardDetails = await this.calculateTweetReward(tweetId);
        reward = parseFloat(rewardDetails.reward) || 0;
      }

      if (reward <= 0 || isNaN(reward)) {
        return { success: false, reason: 'Aucune récompense valide' };
      }

      const currency = await getPlatformCurrency();
      if (!currency) throw new Error('Cryptomonnaie non trouvée');

      const result = await NewEconomyService.rewardUser(
        userId,
        currency.id,
        reward,
        `Récompense pour tweet ${tweetId || '(multi)'}`
      );

      if (result.success && result.transaction) {
        logger.info(`💰 Récompense distribuée: ${reward} ${currency.symbol} à l'utilisateur ${userId}`);
        return { success: true, reward, newBalance: result.transaction.amount };
      }

      return { success: false, reason: result.reason || 'Échec de la distribution économique' };
    } catch (error) {
      logger.error('Erreur lors de la distribution de la récompense:', error);
      throw error;
    }
  }

  /**
   * Traiter tous les tweets éligibles d'un utilisateur (Automatisé)
   */
  static async processEligibleTweets(userId = null) {
    try {
      logger.info('🔄 Traitement des tweets éligibles...');
      const whereCondition = {
        parent_tweet_id: null,
        monetized: { [Op.ne]: true }
      };
      if (userId) whereCondition.user_id = userId;

      const tweets = await Tweet.findAll({
        where: whereCondition,
        order: [['createdAt', 'DESC']]
      });

      logger.info(`📊 ${tweets.length} tweets à analyser`);
      let totalRewards = 0;
      const processedIds = [];

      for (const tweet of tweets) {
        try {
          const views = tweet.view_count || 0;

          // Interactions réelles depuis la DB
          const [likesCount, retweetsCount, repliesCount] = await Promise.all([
            sequelize.query(`SELECT COUNT(*) as count FROM tweet_likes WHERE tweet_id = :id`, { replacements: { id: tweet.id }, type: sequelize.QueryTypes.SELECT }),
            sequelize.query(`SELECT COUNT(*) as count FROM tweet_retweets WHERE tweet_id = :id`, { replacements: { id: tweet.id }, type: sequelize.QueryTypes.SELECT }),
            sequelize.query(`SELECT COUNT(*) as count FROM tweets WHERE parent_tweet_id = :id`, { replacements: { id: tweet.id }, type: sequelize.QueryTypes.SELECT })
          ]);

          const likes = likesCount[0]?.count || 0;
          const retweets = retweetsCount[0]?.count || 0;
          const comments = repliesCount[0]?.count || 0;
          const watchTimeSeconds = parseFloat(tweet.metadata?.total_watch_time) || 0;

          const currentRates = this.getRatesForTweet(tweet.tweet_type);

          const tweetReward = this.roundTWC(
            (views * currentRates.VIEWS) +
            (watchTimeSeconds * currentRates.WATCHTIME_PER_SEC) +
            (likes * currentRates.LIKES) +
            (comments * currentRates.COMMENTS) +
            (retweets * currentRates.RETWEETS)
          );

          if (tweetReward > 0) {
            totalRewards += tweetReward;
            processedIds.push(tweet.id);
            logger.info(`📊 Tweet ${tweet.id}: ${tweetReward} TWC (Type: ${tweet.tweet_type})`);
          }
        } catch (error) {
          logger.error(`❌ Erreur sur tweet ${tweet.id}:`, error.message);
        }
      }

      if (totalRewards > 0 && userId) {
        const result = await this.distributeReward(null, userId, totalRewards);
        if (result.success) {
          await this.resetTweetCounters(processedIds);
        }
      }

      return { totalRewards, processedCount: processedIds.length };
    } catch (error) {
      logger.error('Erreur processEligibleTweets:', error);
      throw error;
    }
  }

  /**
   * Prévisualiser les gains
   */
  static async previewEarnings(userId) {
    try {
      const tweets = await Tweet.findAll({
        where: { user_id: userId, parent_tweet_id: null, monetized: { [Op.ne]: true } },
        order: [['createdAt', 'DESC']]
      });

      let totalRewards = 0;
      const details = [];

      for (const tweet of tweets) {
        const views = tweet.view_count || 0;
        const [likesC, retweetsC, repliesC] = await Promise.all([
          sequelize.query(`SELECT COUNT(*) as count FROM tweet_likes WHERE tweet_id = :id`, { replacements: { id: tweet.id }, type: sequelize.QueryTypes.SELECT }),
          sequelize.query(`SELECT COUNT(*) as count FROM tweet_retweets WHERE tweet_id = :id`, { replacements: { id: tweet.id }, type: sequelize.QueryTypes.SELECT }),
          sequelize.query(`SELECT COUNT(*) as count FROM tweets WHERE parent_tweet_id = :id`, { replacements: { id: tweet.id }, type: sequelize.QueryTypes.SELECT })
        ]);

        const likes = likesC[0]?.count || 0;
        const retweets = retweetsC[0]?.count || 0;
        const comments = repliesC[0]?.count || 0;
        const watchTimeSeconds = parseFloat(tweet.metadata?.total_watch_time) || 0;

        const currentRates = this.getRatesForTweet(tweet.tweet_type);
        const reward = this.roundTWC(
          (views * currentRates.VIEWS) +
          (watchTimeSeconds * currentRates.WATCHTIME_PER_SEC) +
          (likes * currentRates.LIKES) +
          (comments * currentRates.COMMENTS) +
          (retweets * currentRates.RETWEETS)
        );

        if (reward > 0) {
          totalRewards += reward;
          details.push({
            tweetId: tweet.id,
            reward,
            type: tweet.tweet_type,
            stats: { views, likes, comments, retweets, watchTimeSeconds },
            content: tweet.content.substring(0, 50) + '...'
          });
        }
      }

      const currency = await getPlatformCurrency();
      const wallet = await UserWallet.findOne({ where: { userId, currencyId: currency?.id } });
      const currentBalance = wallet ? parseFloat(wallet.balance) : 0;

      return {
        totalRewards,
        eligibleTweets: details.length,
        currentBalance,
        newBalance: currentBalance + totalRewards,
        tweetDetails: details
      };
    } catch (error) {
      logger.error('Erreur previewEarnings:', error);
      throw error;
    }
  }

  /**
   * Marquer comme monétisé (évite les doublons)
   */
  static async resetTweetCounters(tweetIds) {
    try {
      if (!tweetIds || tweetIds.length === 0) return;
      await Tweet.update(
        { view_count: 0, monetized: true },
        { where: { id: tweetIds } }
      );
      logger.info(`🔄 ${tweetIds.length} tweets monétisés`);
    } catch (error) {
      logger.error('Erreur resetTweetCounters:', error);
    }
  }

  /**
   * Obtenir les statistiques de monétisation pour le dashboard
   */
  static async getMonetizationStats() {
    try {
      const currency = await getPlatformCurrency();

      if (!currency) {
        throw new Error('Cryptomonnaie non trouvée');
      }

      // Statistiques des portefeuilles
      const wallets = await UserWallet.findAll({
        where: { currencyId: currency.id },
        attributes: [
          'totalEarned',
          'totalPurchased',
          'totalSpent',
          'loyaltyPoints'
        ]
      });

      const totalEarned = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.totalEarned || 0), 0);
      const totalPurchased = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.totalPurchased || 0), 0);
      const totalSpent = wallets.reduce((sum, wallet) => sum + parseFloat(wallet.totalSpent || 0), 0);
      const totalLoyaltyPoints = wallets.reduce((sum, wallet) => sum + (wallet.loyaltyPoints || 0), 0);

      // Statistiques des transactions de récompense
      const rewardTransactions = await sequelize.query(`
        SELECT 
          COUNT(*) as total_rewards,
          SUM(amount) as total_amount,
          AVG(amount) as avg_amount
        FROM transactions 
        WHERE type = 'REWARD' AND status = 'COMPLETED'
      `, { type: sequelize.QueryTypes.SELECT });

      return {
        currency: {
          symbol: currency.symbol,
          name: currency.name,
          circulatingSupply: parseFloat(currency.circulatingSupply),
          currentPrice: parseFloat(currency.currentPrice)
        },
        wallets: {
          totalUsers: wallets.length,
          totalEarned,
          totalPurchased,
          totalSpent,
          totalLoyaltyPoints
        },
        rewards: {
          totalRewards: parseInt(rewardTransactions[0].total_rewards || 0),
          totalAmount: parseFloat(rewardTransactions[0].total_amount || 0),
          averageAmount: parseFloat(rewardTransactions[0].avg_amount || 0)
        }
      };

    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques:', error);
      throw error;
    }
  }
}

module.exports = TweetMonetizationService;
