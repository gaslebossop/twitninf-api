/**
 * Service pour gérer l'inventaire des utilisateurs
 */

const { sequelize } = require('../database');
const logger = require('../utils/logger');

class InventoryService {
  /**
   * Ajoute un item à l'inventaire d'un utilisateur
   */
  static async addItemToUser(userId, itemName, quantity = 1) {
    try {
      // Récupérer l'ID de l'item
      const itemResult = await sequelize.query(`
        SELECT id FROM items WHERE name = :itemName
      `, {
        replacements: { itemName },
        type: sequelize.QueryTypes.SELECT
      });

      if (itemResult.length === 0) {
        throw new Error(`Item "${itemName}" non trouvé`);
      }

      const itemId = itemResult[0].id;

      // Ajouter l'item à l'inventaire
      await sequelize.query(`
        INSERT INTO user_inventory (user_id, item_id, quantity)
        VALUES (:userId, :itemId, :quantity)
        ON CONFLICT (user_id, item_id) 
        DO UPDATE SET quantity = user_inventory.quantity + :quantity
      `, {
        replacements: { userId, itemId, quantity }
      });

      logger.info(`Item "${itemName}" ajouté à l'inventaire de l'utilisateur ${userId}`);
      return true;
    } catch (error) {
      logger.error('Erreur lors de l\'ajout de l\'item à l\'inventaire:', error);
      return false;
    }
  }

  /**
   * Récupère l'inventaire d'un utilisateur
   */
  static async getUserInventory(userId) {
    try {
      const inventory = await sequelize.query(`
        SELECT 
          ui.id,
          ui.quantity,
          ui.obtained_at,
          i.name,
          i.description,
          i.type,
          i.rarity
        FROM user_inventory ui
        INNER JOIN items i ON ui.item_id = i.id
        WHERE ui.user_id = :userId
        ORDER BY ui.obtained_at DESC
      `, {
        replacements: { userId },
        type: sequelize.QueryTypes.SELECT
      });

      return inventory;
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'inventaire:', error);
      return [];
    }
  }

  /**
   * Vérifie si un utilisateur possède un item
   */
  static async userHasItem(userId, itemName) {
    try {
      const result = await sequelize.query(`
        SELECT ui.quantity
        FROM user_inventory ui
        INNER JOIN items i ON ui.item_id = i.id
        WHERE ui.user_id = :userId AND i.name = :itemName
      `, {
        replacements: { userId, itemName },
        type: sequelize.QueryTypes.SELECT
      });

      return result.length > 0 && result[0].quantity > 0;
    } catch (error) {
      logger.error('Erreur lors de la vérification de l\'item:', error);
      return false;
    }
  }

  /**
   * Utilise un item (diminue la quantité)
   */
  static async useItem(userId, itemName, quantity = 1) {
    try {
      const result = await sequelize.query(`
        UPDATE user_inventory 
        SET quantity = quantity - :quantity
        FROM items i
        WHERE user_inventory.item_id = i.id 
        AND user_inventory.user_id = :userId 
        AND i.name = :itemName
        AND user_inventory.quantity >= :quantity
        RETURNING user_inventory.quantity
      `, {
        replacements: { userId, itemName, quantity },
        type: sequelize.QueryTypes.SELECT
      });

      if (result.length === 0) {
        return false; // Pas assez d'items
      }

      // Supprimer l'entrée si la quantité est 0
      if (result[0].quantity <= 0) {
        await sequelize.query(`
          DELETE FROM user_inventory 
          WHERE user_id = :userId 
          AND item_id = (SELECT id FROM items WHERE name = :itemName)
        `, {
          replacements: { userId, itemName }
        });
      }

      logger.info(`Item "${itemName}" utilisé par l'utilisateur ${userId}`);
      return true;
    } catch (error) {
      logger.error('Erreur lors de l\'utilisation de l\'item:', error);
      return false;
    }
  }
}

module.exports = InventoryService;
