/**
 * Service pour gérer les styles de badges vérifiés
 */

const { User } = require('../models');
const logger = require('../utils/logger');

class VerifiedBadgeService {
  /**
   * Styles de badges par défaut
   */
  static getDefaultStyles() {
    return [
      {
        id: 'default',
        name: 'Badge Vérifié Standard',
        color: '#1DA1F2',
        gradient: ['#1DA1F2', '#0D8BD9'],
        glowColor: '#1DA1F2',
        animationType: 'pulse',
        rarity: 'DEFAULT',
        isActive: true
      },
      {
        id: 'rose',
        name: 'Badge Vérifié Rose Kospor',
        color: '#FF69B4',
        gradient: ['#FF69B4', '#FF1493'],
        glowColor: '#FF69B4',
        animationType: 'sparkle',
        rarity: 'ULTRA_RARE',
        isActive: false // Activé seulement si l'utilisateur a complété tous les défis
      },
      {
        id: 'gray',
        name: 'Badge Vérifié Gris Vigilance',
        color: '#808080',
        gradient: ['#808080', '#696969'],
        glowColor: '#808080',
        animationType: 'glow',
        rarity: 'ULTRA_RARE',
        isActive: false // Activé seulement si l'utilisateur possède l'item
      },
      {
        id: 'gold',
        name: 'Badge Vérifié Or G',
        color: '#FFD700',
        gradient: ['#FFD700', '#FFA500'],
        glowColor: '#FFD700',
        animationType: 'sparkle',
        rarity: 'LEGENDARY',
        isActive: false // Activé seulement si l'utilisateur possède l'item
      }
    ];
  }

  /**
   * Récupère le style de badge actuel d'un utilisateur
   */
  static async getUserBadgeStyle(userId) {
    try {
      const user = await User.findByPk(userId, {
        attributes: ['id', 'verified', 'verification_style']
      });

      if (!user || !user.verified) {
        return null;
      }

      const styles = this.getDefaultStyles();
      const currentStyleId = user.verification_style || 'default';
      const currentStyle = styles.find(style => style.id === currentStyleId);

      if (!currentStyle) {
        return styles[0]; // Style par défaut
      }

      // Vérifier si l'utilisateur peut utiliser ce style
      if (currentStyle.rarity === 'ULTRA_RARE' || currentStyle.rarity === 'LEGENDARY') {
        let canUse = false;
        if (currentStyle.id === 'rose') {
          canUse = await this.canUseUltraRareStyle(userId);
        } else if (currentStyle.id === 'gray') {
          canUse = await this.canUseGrayStyle(userId);
        } else if (currentStyle.id === 'gold') {
          canUse = await this.canUseGoldStyle(userId);
        }
        
        if (!canUse) {
          return styles[0]; // Retourner au style par défaut
        }
      }

      return {
        ...currentStyle,
        isActive: true
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération du style de badge:', error);
      return null;
    }
  }

  /**
   * Change le style de badge d'un utilisateur
   */
  static async changeUserBadgeStyle(userId, styleId) {
    try {
      const user = await User.findByPk(userId, {
        attributes: ['id', 'verified']
      });

      if (!user || !user.verified) {
        return false;
      }

      const styles = this.getDefaultStyles();
      const targetStyle = styles.find(style => style.id === styleId);

      if (!targetStyle) {
        return false;
      }

      // Vérifier si l'utilisateur peut utiliser ce style
      if (targetStyle.rarity === 'ULTRA_RARE' || targetStyle.rarity === 'LEGENDARY') {
        let canUse = false;
        if (targetStyle.id === 'rose') {
          canUse = await this.canUseUltraRareStyle(userId);
        } else if (targetStyle.id === 'gray') {
          canUse = await this.canUseGrayStyle(userId);
        } else if (targetStyle.id === 'gold') {
          canUse = await this.canUseGoldStyle(userId);
        }
        
        if (!canUse) {
          return false;
        }
      }

      // Mettre à jour le style de badge
      await user.update({ verification_style: styleId });

      logger.info(`Style de badge changé pour l'utilisateur ${userId}: ${styleId}`);
      return true;
    } catch (error) {
      logger.error('Erreur lors du changement de style de badge:', error);
      return false;
    }
  }

  /**
   * Récupère tous les styles de badges disponibles
   */
  static async getAvailableBadgeStyles() {
    try {
      return this.getDefaultStyles();
    } catch (error) {
      logger.error('Erreur lors de la récupération des styles de badges:', error);
      return [];
    }
  }

  /**
   * Vérifie si un utilisateur peut utiliser un style de badge
   */
  static async canUseBadgeStyle(userId, styleId) {
    try {
      const user = await User.findByPk(userId, {
        attributes: ['id', 'verified']
      });

      if (!user || !user.verified) {
        return false;
      }

      const styles = this.getDefaultStyles();
      const targetStyle = styles.find(style => style.id === styleId);

      if (!targetStyle) {
        return false;
      }

      // Le style par défaut est toujours disponible
      if (targetStyle.rarity === 'DEFAULT') {
        return true;
      }

      // Pour les styles ultra rares et légendaires, vérifier les conditions
      if (targetStyle.rarity === 'ULTRA_RARE' || targetStyle.rarity === 'LEGENDARY') {
        if (targetStyle.id === 'rose') {
          return await this.canUseUltraRareStyle(userId);
        } else if (targetStyle.id === 'gray') {
          return await this.canUseGrayStyle(userId);
        } else if (targetStyle.id === 'gold') {
          return await this.canUseGoldStyle(userId);
        }
      }

      return false;
    } catch (error) {
      logger.error('Erreur lors de la vérification de permission:', error);
      return false;
    }
  }

  /**
   * Vérifie si un utilisateur peut utiliser le style ultra rare
   */
  static async canUseUltraRareStyle(userId) {
    try {
      // Vérifier si l'utilisateur a complété tous les défis de l'événement Kospor Birthday
      const { UserChallenge } = require('../models');
      
      const challenges = await UserChallenge.findAll({
        where: {
          user_id: userId,
          event_slug: 'kosporbirthday'
        }
      });

      // Vérifier que tous les défis sont complétés
      const allCompleted = challenges.length > 0 && challenges.every(challenge => challenge.completed);

      if (allCompleted) {
        logger.info(`Utilisateur ${userId} peut utiliser le style ultra rare`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Erreur lors de la vérification du style ultra rare:', error);
      return false;
    }
  }

  /**
   * Vérifie si un utilisateur peut utiliser le style gris
   */
  static async canUseGrayStyle(userId) {
    try {
      // Vérifier si l'utilisateur possède l'item "Badge Verifie Gris"
      const InventoryService = require('./inventoryService');
      const hasGrayItem = await InventoryService.userHasItem(userId, 'Badge Verifie Gris');

      if (hasGrayItem) {
        logger.info(`Utilisateur ${userId} peut utiliser le style gris`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Erreur lors de la vérification du style gris:', error);
      return false;
    }
  }

  /**
   * Vérifie si un utilisateur peut utiliser le style or
   */
  static async canUseGoldStyle(userId) {
    try {
      // Vérifier si l'utilisateur possède l'item "Badge Verifie Or"
      const InventoryService = require('./inventoryService');
      const hasGoldItem = await InventoryService.userHasItem(userId, 'Badge Verifie Or');

      if (hasGoldItem) {
        logger.info(`Utilisateur ${userId} peut utiliser le style or`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Erreur lors de la vérification du style or:', error);
      return false;
    }
  }
}

module.exports = VerifiedBadgeService;
