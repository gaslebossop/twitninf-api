/**
 * Modèle UserChallenge pour le suivi des défis d'utilisateur
 * Permet de suivre la progression des défis d'événements fonctionnels
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserChallenge = sequelize.define('UserChallenge', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
      onDelete: 'CASCADE',
      comment: 'ID de l\'utilisateur',
    },
    challenge_id: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Identifiant du défi (ex: post_tweets, get_likes, wish_birthday)',
    },
    event_slug: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Slug de l\'événement fonctionnel (ex: kosporbirthday)',
    },
    progress: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Progression actuelle du défi',
    },
    max_progress: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Progression maximale requise pour compléter le défi',
    },
    completed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Indique si le défi est complété',
    },
    claimed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Indique si la récompense a été réclamée',
    },
    claimed_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Date de réclamation de la récompense',
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Métadonnées supplémentaires du défi',
      defaultValue: {},
    },
  }, {
    tableName: 'user_challenges',
    timestamps: true,
    indexes: [
      {
        fields: ['user_id', 'challenge_id', 'event_slug'],
        unique: true,
        name: 'unique_user_challenge',
      },
      {
        fields: ['user_id', 'event_slug'],
      },
      {
        fields: ['challenge_id', 'event_slug'],
      },
      {
        fields: ['completed', 'claimed'],
      },
    ],
  });

  // Méthodes d'instance
  UserChallenge.prototype.updateProgress = function(newProgress) {
    this.progress = Math.min(newProgress, this.max_progress);
    this.completed = this.progress >= this.max_progress;
    return this.save();
  };

  UserChallenge.prototype.claimReward = function() {
    if (this.completed && !this.claimed) {
      this.claimed = true;
      this.claimed_at = new Date();
      return this.save();
    }
    throw new Error('Le défi doit être complété et non réclamé pour pouvoir réclamer la récompense');
  };

  // Méthodes statiques
  UserChallenge.getUserChallenges = async function(userId, eventSlug = null) {
    const whereClause = { user_id: userId };
    if (eventSlug) {
      whereClause.event_slug = eventSlug;
    }
    
    return await this.findAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
    });
  };

  UserChallenge.getUserChallenge = async function(userId, challengeId, eventSlug) {
    return await this.findOne({
      where: {
        user_id: userId,
        challenge_id: challengeId,
        event_slug: eventSlug,
      },
    });
  };

  UserChallenge.createOrUpdateChallenge = async function(userId, challengeId, eventSlug, maxProgress, metadata = {}) {
    const [challenge, created] = await this.findOrCreate({
      where: {
        user_id: userId,
        challenge_id: challengeId,
        event_slug: eventSlug,
      },
      defaults: {
        user_id: userId,
        challenge_id: challengeId,
        event_slug: eventSlug,
        max_progress: maxProgress,
        metadata: metadata,
      },
    });

    if (!created && challenge.max_progress !== maxProgress) {
      challenge.max_progress = maxProgress;
      await challenge.save();
    }

    return challenge;
  };

  UserChallenge.updateChallengeProgress = async function(userId, challengeId, eventSlug, progress) {
    const challenge = await this.getUserChallenge(userId, challengeId, eventSlug);
    if (!challenge) {
      throw new Error('Défi non trouvé');
    }
    
    return await challenge.updateProgress(progress);
  };

  UserChallenge.claimChallengeReward = async function(userId, challengeId, eventSlug) {
    const challenge = await this.getUserChallenge(userId, challengeId, eventSlug);
    if (!challenge) {
      throw new Error('Défi non trouvé');
    }
    
    const result = await challenge.claimReward();
    return result;
  };

  /**
   * Claim la récompense spéciale "Badge Verifie Rose" pour l'événement Kospor Birthday
   * Vérifie que tous les défis sont complétés et réclamés, puis ajoute l'item avec vérification de stock
   */
  UserChallenge.claimSpecialReward = async function(userId, eventSlug) {
    try {
      const logger = require('../utils/logger');
      
      // Récupérer tous les défis de l'utilisateur pour cet événement
      const challenges = await this.findAll({
        where: {
          user_id: userId,
          event_slug: eventSlug
        }
      });

      // Vérifier que tous les défis sont complétés ET réclamés
      const allCompletedAndClaimed = challenges.length > 0 && 
        challenges.every(challenge => challenge.completed && challenge.claimed);

      if (!allCompletedAndClaimed) {
        throw new Error('Tous les défis doivent être complétés et réclamés pour obtenir la récompense spéciale');
      }

      // Vérifier si l'utilisateur n'a pas déjà l'item
      const InventoryService = require('../services/inventoryService');
      const hasRoseItem = await InventoryService.userHasItem(userId, 'Badge Verifie Rose');
      
      if (hasRoseItem) {
        throw new Error('Vous possédez déjà cette récompense spéciale');
      }

      // Vérifier le stock disponible (nombre d'utilisateurs qui peuvent encore récupérer l'item)
      const VerificationStyleService = require('../services/verificationStyleService');
      const stockInfo = await VerificationStyleService.checkRoseItemStock();
      
      if (stockInfo.available <= 0) {
        throw new Error('Récompense spéciale épuisée - Plus d\'exemplaires disponibles');
      }

      // Ajouter l'item "Badge Verifie Rose" à l'inventaire
      await VerificationStyleService.addRoseItemToInventory(userId);
      
      logger.info(`Item "Badge Verifie Rose" ajouté à l'inventaire de l'utilisateur ${userId} - Stock restant: ${stockInfo.available - 1}`);
      
      return {
        success: true,
        message: 'Récompense spéciale récupérée avec succès !',
        stockRemaining: stockInfo.available - 1
      };

    } catch (error) {
      const logger = require('../utils/logger');
      logger.error('Erreur lors du claim de la récompense spéciale:', error);
      throw error;
    }
  };

  return UserChallenge;
};
