/**
 * Service pour la gestion des événements fonctionnels
 * Gère l'activation, la désactivation et l'application des fonctionnalités
 */

const { FunctionalEvent, User } = require('../models');
const logger = require('../utils/logger');

class FunctionalEventService {
  constructor() {
    this.cache = new Map();
    this.activeEvents = new Map();
    this.lastCheck = null;
    this.checkInterval = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Obtenir tous les événements actifs avec cache
   */
  async getActiveEvents(forceRefresh = false) {
    try {
      const now = Date.now();
      
      // Utiliser le cache si disponible et récent
      if (!forceRefresh && this.lastCheck && (now - this.lastCheck < this.checkInterval)) {
        return Array.from(this.activeEvents.values());
      }

      // Rechercher les événements actifs
      const events = await FunctionalEvent.getActiveEvents();
      
      // Vérifier les événements avec activation automatique
      for (const event of events) {
        if (event.auto_activate && !this.isEventCurrentlyActive(event)) {
          await event.update({ is_active: false });
          logger.info(`🎉 Événement fonctionnel ${event.name} désactivé automatiquement (hors période)`);
        }
      }

      // Mettre à jour le cache
      this.activeEvents.clear();
      events.forEach(event => {
        if (event.isCurrentlyActive()) {
          this.activeEvents.set(event.id, event);
        }
      });

      this.lastCheck = now;
      return Array.from(this.activeEvents.values());
    } catch (error) {
      logger.error('Erreur lors de la récupération des événements actifs:', error);
      return [];
    }
  }

  /**
   * Obtenir les événements actifs pour une page spécifique
   */
  async getActiveEventsForPage(pageName, forceRefresh = false) {
    try {
      const events = await this.getActiveEvents(forceRefresh);
      return events.filter(event => event.isActiveForPage(pageName));
    } catch (error) {
      logger.error(`Erreur lors de la récupération des événements pour la page ${pageName}:`, error);
      return [];
    }
  }

  /**
   * Vérifier si un événement est actuellement dans sa période d'activation
   */
  isEventCurrentlyActive(event) {
    if (!event.auto_activate) {
      return event.is_active;
    }

    const now = new Date();
    const start = event.start_date ? new Date(event.start_date) : null;
    const end = event.end_date ? new Date(event.end_date) : null;

    if (start && now < start) return false;
    if (end && now > end) return false;

    return event.is_active;
  }

  /**
   * Obtenir les fonctionnalités actives pour une page
   */
  async getActiveFeaturesForPage(pageName) {
    try {
      const events = await this.getActiveEventsForPage(pageName);
      const features = {};

      events.forEach(event => {
        if (event.features) {
          Object.assign(features, event.features);
        }
      });

      return features;
    } catch (error) {
      logger.error(`Erreur lors de la récupération des fonctionnalités pour ${pageName}:`, error);
      return {};
    }
  }

  /**
   * Vérifier si une fonctionnalité est active pour une page
   */
  async isFeatureActive(featureName, pageName) {
    try {
      const features = await this.getActiveFeaturesForPage(pageName);
      return features[featureName] === true;
    } catch (error) {
      logger.error(`Erreur lors de la vérification de la fonctionnalité ${featureName}:`, error);
      return false;
    }
  }

  /**
   * Obtenir la valeur d'une fonctionnalité pour une page
   */
  async getFeatureValue(featureName, pageName, defaultValue = null) {
    try {
      const features = await this.getActiveFeaturesForPage(pageName);
      return features[featureName] !== undefined ? features[featureName] : defaultValue;
    } catch (error) {
      logger.error(`Erreur lors de la récupération de la valeur ${featureName}:`, error);
      return defaultValue;
    }
  }

  /**
   * Créer un nouvel événement fonctionnel
   */
  async createEvent(eventData, userId) {
    try {
      const event = await FunctionalEvent.create({
        ...eventData,
        created_by: userId,
        updated_by: userId,
      });

      logger.info(`🎉 Nouvel événement fonctionnel créé: ${event.name}`);
      return event;
    } catch (error) {
      logger.error('Erreur lors de la création de l\'événement:', error);
      throw error;
    }
  }

  /**
   * Mettre à jour un événement
   */
  async updateEvent(eventId, updateData, userId) {
    try {
      const event = await FunctionalEvent.findByPk(eventId);
      if (!event) {
        throw new Error('Événement non trouvé');
      }

      await event.update({
        ...updateData,
        updated_by: userId,
      });

      // Invalider le cache
      this.activeEvents.delete(eventId);
      this.lastCheck = null;

      logger.info(`🎉 Événement fonctionnel mis à jour: ${event.name}`);
      return event;
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de l\'événement:', error);
      throw error;
    }
  }

  /**
   * Activer un événement
   */
  async activateEvent(eventId, deactivateOthers = true) {
    try {
      const event = await FunctionalEvent.activateEvent(eventId, deactivateOthers);
      
      // Invalider le cache
      this.activeEvents.clear();
      this.lastCheck = null;

      logger.info(`🎉 Événement fonctionnel activé: ${event.name}`);
      return event;
    } catch (error) {
      logger.error('Erreur lors de l\'activation de l\'événement:', error);
      throw error;
    }
  }

  /**
   * Désactiver un événement
   */
  async deactivateEvent(eventId) {
    try {
      const event = await FunctionalEvent.deactivateEvent(eventId);
      
      // Invalider le cache
      this.activeEvents.delete(eventId);
      this.lastCheck = null;

      logger.info(`🎉 Événement fonctionnel désactivé: ${event.name}`);
      return event;
    } catch (error) {
      logger.error('Erreur lors de la désactivation de l\'événement:', error);
      throw error;
    }
  }

  /**
   * Supprimer un événement
   */
  async deleteEvent(eventId) {
    try {
      const event = await FunctionalEvent.findByPk(eventId);
      if (!event) {
        throw new Error('Événement non trouvé');
      }

      await event.destroy();
      
      // Invalider le cache
      this.activeEvents.delete(eventId);
      this.lastCheck = null;

      logger.info(`🎉 Événement fonctionnel supprimé: ${event.name}`);
      return true;
    } catch (error) {
      logger.error('Erreur lors de la suppression de l\'événement:', error);
      throw error;
    }
  }

  /**
   * Obtenir tous les événements (actifs et inactifs)
   */
  async getAllEvents() {
    try {
      return await FunctionalEvent.findAll({
        order: [['priority', 'DESC'], ['created_at', 'DESC']],
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'username', 'full_name'],
          },
        ],
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de tous les événements:', error);
      return [];
    }
  }

  /**
   * Obtenir un événement par ID
   */
  async getEventById(eventId) {
    try {
      return await FunctionalEvent.findByPk(eventId, {
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'username', 'full_name'],
          },
        ],
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'événement:', error);
      return null;
    }
  }

  /**
   * Initialiser les événements par défaut
   */
  async initializeDefaultEvents(userId) {
    try {
      const defaultEvents = [
        {
          name: 'Kospor Birthday',
          slug: 'kosporbirthday',
          description: 'Célébrez l\'anniversaire de Kospor avec des fonctionnalités spéciales !',
          target_pages: ['kosporbirthday'],
          features: {
            kosporbirthday: true,
            special_page: true,
            nav_tab: true,
          },
          icon: 'gift',
          banner_message: '🎉 Joyeux Anniversaire Kospor ! 🎉',
          auto_activate: false,
          priority: 10,
        },
      ];

      const createdEvents = [];
      for (const eventData of defaultEvents) {
        const event = await this.createEvent(eventData, userId);
        createdEvents.push(event);
      }

      logger.info(`🎉 ${createdEvents.length} événements par défaut initialisés`);
      return createdEvents;
    } catch (error) {
      logger.error('Erreur lors de l\'initialisation des événements par défaut:', error);
      throw error;
    }
  }
}

module.exports = new FunctionalEventService();
