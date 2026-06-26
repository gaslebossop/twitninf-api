/**
 * Service pour gérer les styles de vérification
 */

const { User } = require('../models');
const logger = require('../utils/logger');

class VerificationStyleService {
  /**
   * Récupère le style de vérification d'un utilisateur
   */
  static async getUserVerificationStyle(userId) {
    try {
      const user = await User.findByPk(userId, {
        attributes: ['id', 'verified', 'verification_style']
      });

      if (!user || !user.verified) {
        return 'default';
      }

      // Si l'utilisateur peut utiliser le style rose, l'activer automatiquement
      const canUseRose = await this.canUseRoseStyle(userId);
      if (canUseRose && user.verification_style === 'default') {
        // Mettre à jour automatiquement le style
        user.verification_style = 'rose';
        await user.save();
        logger.info(`Style rose automatiquement activé pour l'utilisateur ${userId}`);
        return 'rose';
      }

      return user.verification_style || 'default';
    } catch (error) {
      logger.error('Erreur lors de la récupération du style de vérification:', error);
      return 'default';
    }
  }

  /**
   * Change le style de vérification d'un utilisateur
   */
  static async changeUserVerificationStyle(userId, style) {
    try {
      const user = await User.findByPk(userId, {
        attributes: ['id', 'verified']
      });

      if (!user || !user.verified) {
        return false;
      }

      // Vérifier que l'utilisateur peut utiliser ce style
      if (style === 'rose') {
        const canUseRose = await this.canUseRoseStyle(userId);
        if (!canUseRose) {
          return false;
        }
      } else if (style === 'gray') {
        const canUseGray = await this.canUseGrayStyle(userId);
        if (!canUseGray) {
          return false;
        }
      } else if (style === 'gold') {
        const canUseGold = await this.canUseGoldStyle(userId);
        if (!canUseGold) {
          return false;
        }
      }

      // Mettre à jour le style
      await user.update({ verification_style: style });

      logger.info(`Style de vérification changé pour l'utilisateur ${userId}: ${style}`);
      return true;
    } catch (error) {
      logger.error('Erreur lors du changement de style de vérification:', error);
      return false;
    }
  }

  /**
   * Vérifie si un utilisateur peut utiliser le style rose
   */
  static async canUseRoseStyle(userId) {
    try {
      // Vérifier si l'utilisateur a l'item "Badge Verifie Rose" dans son inventaire
      const InventoryService = require('./inventoryService');
      const hasRoseItem = await InventoryService.userHasItem(userId, 'Badge Verifie Rose');
      
      if (hasRoseItem) {
        logger.info(`Utilisateur ${userId} peut utiliser le style rose (possède l'item)`);
        return true;
      }

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
        // NE PAS ajouter l'item ici - il sera ajouté uniquement lors du claim de la récompense finale
        logger.info(`Utilisateur ${userId} peut utiliser le style rose (défis complétés)`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Erreur lors de la vérification du style rose:', error);
      return false;
    }
  }

  /**
   * Débloque le style rose pour un utilisateur (appelé quand tous les défis sont complétés)
   */
  static async unlockRoseStyle(userId) {
    try {
      const user = await User.findByPk(userId, {
        attributes: ['id', 'verified']
      });

      if (!user || !user.verified) {
        return false;
      }

      // Vérifier que l'utilisateur peut utiliser le style rose
      const canUseRose = await this.canUseRoseStyle(userId);
      if (!canUseRose) {
        return false;
      }

      // Ajouter l'item "rose" à l'inventaire de l'utilisateur
      await this.addRoseItemToInventory(userId);

      logger.info(`Style rose débloqué pour l'utilisateur ${userId}`);
      return true;
    } catch (error) {
      logger.error('Erreur lors du déblocage du style rose:', error);
      return false;
    }
  }

  /**
   * Ajoute l'item "rose" à l'inventaire de l'utilisateur
   */
  static async addRoseItemToInventory(userId) {
    try {
      const InventoryService = require('./inventoryService');
      const success = await InventoryService.addItemToUser(userId, 'Badge Verifie Rose', 1);
      
      if (success) {
        logger.info(`Item "Badge Verifie Rose" ajouté à l'inventaire de l'utilisateur ${userId}`);
      }
      
      return success;
    } catch (error) {
      logger.error('Erreur lors de l\'ajout de l\'item rose:', error);
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
        logger.info(`Utilisateur ${userId} peut utiliser le style gris (possède l'item)`);
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
        logger.info(`Utilisateur ${userId} peut utiliser le style or (possède l'item)`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Erreur lors de la vérification du style or:', error);
      return false;
    }
  }

  /**
   * Vérifie le stock disponible pour l'item "Badge Verifie Rose"
   */
  static async checkRoseItemStock() {
    try {
      const { sequelize } = require('../database');
      
      // Nombre maximum d'items "Badge Verifie Rose" disponibles (limite globale)
      const MAX_STOCK = 100; // Tu peux ajuster ce nombre selon tes besoins
      
      // Compter combien d'utilisateurs ont déjà l'item
      const result = await sequelize.query(`
        SELECT COUNT(DISTINCT ui.user_id) as claimed_count
        FROM user_inventory ui
        JOIN items i ON ui.item_id = i.id
        WHERE i.name = 'Badge Verifie Rose'
      `, {
        type: sequelize.QueryTypes.SELECT
      });
      
      const claimedCount = result[0]?.claimed_count || 0;
      const available = Math.max(0, MAX_STOCK - claimedCount);
      
      return {
        maxStock: MAX_STOCK,
        claimed: claimedCount,
        available: available,
        isAvailable: available > 0
      };
      
    } catch (error) {
      logger.error('Erreur lors de la vérification du stock rose:', error);
      return {
        maxStock: 0,
        claimed: 0,
        available: 0,
        isAvailable: false
      };
    }
  }
}

module.exports = VerificationStyleService;
