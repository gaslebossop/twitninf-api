/**
 * Service pour gérer la progression des défis d'utilisateur
 * Met à jour automatiquement la progression des défis basés sur les interactions
 */

const { UserChallenge } = require('../models');
const logger = require('../utils/logger');

class ChallengeProgressService {
  /**
   * Met à jour la progression d'un défi spécifique
   */
  static async updateChallengeProgress(userId, challengeId, eventSlug, newProgress) {
    try {
      const challenge = await UserChallenge.getUserChallenge(userId, challengeId, eventSlug);
      
      if (!challenge) {
        logger.warn(`Défi non trouvé: ${challengeId} pour l'utilisateur ${userId} dans l'événement ${eventSlug}`);
        return null;
      }

      // Mettre à jour la progression
      await challenge.updateProgress(newProgress);
      
      logger.info(`Progression mise à jour pour le défi ${challengeId}: ${challenge.progress}/${challenge.max_progress}`);
      
      return challenge;
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de la progression du défi:', error);
      throw error;
    }
  }

  /**
   * Met à jour la progression du défi "obtenir des likes"
   */
  static async updateLikesProgress(userId, eventSlug = 'kosporbirthday') {
    try {
      // Compter le nombre total de likes reçus par l'utilisateur
      const { sequelize } = require('../database/index');
      
      const likesCount = await sequelize.query(`
        SELECT COUNT(*) as total_likes
        FROM tweet_likes tl
        INNER JOIN tweets t ON tl.tweet_id = t.id
        WHERE t.user_id = :userId
      `, {
        replacements: { userId },
        type: sequelize.QueryTypes.SELECT
      });

      const totalLikes = likesCount[0]?.total_likes || 0;
      
      // Mettre à jour la progression du défi
      const challenge = await this.updateChallengeProgress(
        userId, 
        'get_likes', 
        eventSlug, 
        totalLikes
      );

      if (challenge) {
        logger.info(`Progression des likes mise à jour: ${totalLikes} likes reçus pour l'utilisateur ${userId}`);
      }

      return challenge;
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de la progression des likes:', error);
      throw error;
    }
  }

  /**
   * Met à jour la progression du défi "poster des tweets"
   */
  static async updateTweetsProgress(userId, eventSlug = 'kosporbirthday') {
    try {
      // Compter le nombre total de tweets postés par l'utilisateur
      const { sequelize } = require('../database/index');
      
      const tweetsCount = await sequelize.query(`
        SELECT COUNT(*) as total_tweets
        FROM tweets
        WHERE user_id = :userId
      `, {
        replacements: { userId },
        type: sequelize.QueryTypes.SELECT
      });

      const totalTweets = tweetsCount[0]?.total_tweets || 0;
      
      // Mettre à jour la progression du défi
      const challenge = await this.updateChallengeProgress(
        userId, 
        'post_tweets', 
        eventSlug, 
        totalTweets
      );

      if (challenge) {
        logger.info(`Progression des tweets mise à jour: ${totalTweets} tweets postés pour l'utilisateur ${userId}`);
      }

      return challenge;
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de la progression des tweets:', error);
      throw error;
    }
  }

  /**
   * Met à jour la progression du défi "souhaiter bon anniversaire"
   */
  static async updateBirthdayWishProgress(userId, eventSlug = 'kosporbirthday') {
    try {
      // Vérifier si l'utilisateur a souhaité bon anniversaire à Kospor
      const { sequelize } = require('../database/index');
      
      const birthdayWishCount = await sequelize.query(`
        SELECT COUNT(*) as total_wishes
        FROM tweets t
        WHERE t.user_id = :userId
        AND (
          LOWER(t.content) LIKE '%bon anniversaire%' 
          OR LOWER(t.content) LIKE '%happy birthday%'
          OR LOWER(t.content) LIKE '%joyeux anniversaire%'
          OR LOWER(t.content) LIKE '%anniversaire%'
        )
      `, {
        replacements: { userId },
        type: sequelize.QueryTypes.SELECT
      });

      const totalWishes = birthdayWishCount[0]?.total_wishes || 0;
      const hasWished = totalWishes > 0 ? 1 : 0;
      
      // Mettre à jour la progression du défi
      const challenge = await this.updateChallengeProgress(
        userId, 
        'wish_birthday', 
        eventSlug, 
        hasWished
      );

      if (challenge) {
        logger.info(`Progression du souhait d'anniversaire mise à jour: ${hasWished} souhait pour l'utilisateur ${userId}`);
      }

      return challenge;
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de la progression du souhait d\'anniversaire:', error);
      throw error;
    }
  }

  /**
   * Met à jour tous les défis d'un utilisateur
   */
  static async updateAllChallengesProgress(userId, eventSlug = 'kosporbirthday') {
    try {
      const results = await Promise.allSettled([
        this.updateLikesProgress(userId, eventSlug),
        this.updateTweetsProgress(userId, eventSlug),
        this.updateBirthdayWishProgress(userId, eventSlug),
      ]);

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      // Vérifier si tous les défis sont complétés et débloquer le style rose
      await this.checkAndUnlockRoseStyle(userId, eventSlug);

      logger.info(`Mise à jour des défis terminée: ${successful} réussies, ${failed} échouées pour l'utilisateur ${userId}`);

      return {
        successful,
        failed,
        results: results.map(r => r.status === 'fulfilled' ? r.value : r.reason)
      };
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de tous les défis:', error);
      throw error;
    }
  }

  /**
   * Vérifie si tous les défis sont complétés et débloque le style rose
   */
  static async checkAndUnlockRoseStyle(userId, eventSlug = 'kosporbirthday') {
    try {
      const challenges = await UserChallenge.findAll({
        where: {
          user_id: userId,
          event_slug: eventSlug
        }
      });

      // Vérifier que tous les défis sont complétés
      const allCompleted = challenges.length > 0 && challenges.every(challenge => challenge.completed);

      if (allCompleted) {
        // Débloquer le style rose
        const VerificationStyleService = require('./verificationStyleService');
        await VerificationStyleService.unlockRoseStyle(userId);
        
        logger.info(`Style rose débloqué pour l'utilisateur ${userId} - Tous les défis complétés`);
      }
    } catch (error) {
      logger.error('Erreur lors de la vérification du déblocage du style rose:', error);
    }
  }

  /**
   * Met à jour la progression des défis quand un tweet est liké
   */
  static async onTweetLiked(tweetId, likerId) {
    try {
      // Récupérer l'auteur du tweet
      const { sequelize } = require('../database/index');
      
      const tweet = await sequelize.query(`
        SELECT user_id FROM tweets WHERE id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (tweet.length === 0) {
        logger.warn(`Tweet non trouvé: ${tweetId}`);
        return;
      }

      const tweetAuthorId = tweet[0].user_id;
      
      // Mettre à jour la progression des likes pour l'auteur du tweet
      await this.updateLikesProgress(tweetAuthorId);
      
      logger.info(`Progression des likes mise à jour pour l'auteur du tweet ${tweetId}`);
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de la progression après un like:', error);
    }
  }

  /**
   * Met à jour la progression des défis quand un tweet est unliké
   */
  static async onTweetUnliked(tweetId, unlikerId) {
    try {
      // Récupérer l'auteur du tweet
      const { sequelize } = require('../database/index');
      
      const tweet = await sequelize.query(`
        SELECT user_id FROM tweets WHERE id = :tweetId
      `, {
        replacements: { tweetId },
        type: sequelize.QueryTypes.SELECT
      });

      if (tweet.length === 0) {
        logger.warn(`Tweet non trouvé: ${tweetId}`);
        return;
      }

      const tweetAuthorId = tweet[0].user_id;
      
      // Mettre à jour la progression des likes pour l'auteur du tweet
      await this.updateLikesProgress(tweetAuthorId);
      
      logger.info(`Progression des likes mise à jour après un unlike pour l'auteur du tweet ${tweetId}`);
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de la progression après un unlike:', error);
    }
  }

  /**
   * Met à jour la progression des défis quand un tweet est créé
   */
  static async onTweetCreated(userId) {
    try {
      // Mettre à jour la progression des tweets
      await this.updateTweetsProgress(userId);
      
      // Mettre à jour la progression du souhait d'anniversaire
      await this.updateBirthdayWishProgress(userId);
      
      logger.info(`Progression mise à jour après création de tweet pour l'utilisateur ${userId}`);
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de la progression après création de tweet:', error);
    }
  }

  /**
   * Marque le défi "souhaiter bon anniversaire" comme complété
   */
  static async completeBirthdayWishChallenge(userId, eventSlug = 'kosporbirthday') {
    try {
      // Vérifier si le défi existe, sinon le créer
      let challenge = await UserChallenge.getUserChallenge(userId, 'wish_birthday', eventSlug);
      
      if (!challenge) {
        // Créer le défi s'il n'existe pas
        challenge = await UserChallenge.create({
          user_id: userId,
          challenge_id: 'wish_birthday',
          event_slug: eventSlug,
          progress: 0,
          max_progress: 1,
          completed: false,
          claimed: false
        });
        logger.info(`Défi "wish_birthday" créé pour l'utilisateur ${userId}`);
      }

      // Mettre à jour la progression du défi pour le marquer comme complété
      challenge = await this.updateChallengeProgress(
        userId, 
        'wish_birthday', 
        eventSlug, 
        1 // Marquer comme complété (1 = complété, 0 = non complété)
      );

      if (challenge) {
        logger.info(`Défi "souhaiter bon anniversaire" marqué comme complété pour l'utilisateur ${userId}`);
        logger.info(`État du défi: progress=${challenge.progress}, max_progress=${challenge.max_progress}, completed=${challenge.completed}, claimed=${challenge.claimed}`);
      }

      return challenge;
    } catch (error) {
      logger.error('Erreur lors de la complétion du défi "souhaiter bon anniversaire":', error);
      throw error;
    }
  }
}

module.exports = ChallengeProgressService;
