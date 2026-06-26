/**
 * Service pour la gestion des événements thématiques
 * Logique métier pour les événements, activation automatique et gestion des thèmes
 */

const { Event, User } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

class EventService {
  constructor() {
    this.cache = new Map();
    this.activeEvent = null;
    this.lastCheck = null;
    this.checkInterval = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Obtenir l'événement actuellement actif avec cache
   */
  async getActiveEvent(forceRefresh = false) {
    try {
      const now = Date.now();
      
      // Utiliser le cache si disponible et récent
      if (!forceRefresh && this.activeEvent && this.lastCheck && (now - this.lastCheck < this.checkInterval)) {
        return this.activeEvent;
      }

      // Rechercher l'événement actif avec la plus haute priorité
      const activeEvent = await Event.findOne({
        where: {
          is_active: true,
        },
        order: [['priority', 'DESC'], ['created_at', 'DESC']],
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'username', 'full_name'],
          },
        ],
      });

      // Vérifier si l'événement est vraiment actif (dates automatiques)
      if (activeEvent && activeEvent.auto_activate) {
        const isCurrentlyActive = this.isEventCurrentlyActive(activeEvent);
        if (!isCurrentlyActive) {
          await activeEvent.update({ is_active: false });
          logger.info(`🎉 Événement ${activeEvent.name} désactivé automatiquement (hors période)`);
          this.activeEvent = null;
          this.lastCheck = now;
          return null;
        }
      }

      // Mettre à jour le cache
      this.activeEvent = activeEvent;
      this.lastCheck = now;

      if (activeEvent) {
        logger.debug(`🎉 Événement actif: ${activeEvent.name}`);
      }

      return activeEvent;
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'événement actif:', error);
      return null;
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

    return true;
  }

  /**
   * Activer un événement et désactiver les autres
   */
  async activateEvent(eventId, userId, deactivateOthers = true) {
    try {
      const event = await Event.findByPk(eventId);
      if (!event) {
        throw new Error('Événement non trouvé');
      }

      // Désactiver les autres événements si demandé
      if (deactivateOthers) {
        await Event.update(
          { is_active: false },
          { where: { id: { [Op.ne]: eventId } } }
        );
      }

      // Activer l'événement
      await event.update({
        is_active: true,
        updated_by: userId,
      });

      // Invalider le cache
      this.invalidateCache();

      logger.info(`🎉 Événement activé: ${event.name} par l'utilisateur ${userId}`);
      return event;
    } catch (error) {
      logger.error('Erreur lors de l\'activation de l\'événement:', error);
      throw error;
    }
  }

  /**
   * Désactiver un événement
   */
  async deactivateEvent(eventId, userId) {
    try {
      const event = await Event.findByPk(eventId);
      if (!event) {
        throw new Error('Événement non trouvé');
      }

      await event.update({
        is_active: false,
        updated_by: userId,
      });

      // Invalider le cache
      this.invalidateCache();

      logger.info(`🎉 Événement désactivé: ${event.name} par l'utilisateur ${userId}`);
      return event;
    } catch (error) {
      logger.error('Erreur lors de la désactivation de l\'événement:', error);
      throw error;
    }
  }

  /**
   * Vérifier les événements automatiques (à exécuter périodiquement)
   */
  async checkAutomaticEvents() {
    try {
      const now = new Date();
      
      // Événements qui devraient être activés automatiquement
      const eventsToActivate = await Event.findAll({
        where: {
          auto_activate: true,
          is_active: false,
          start_date: { [Op.lte]: now },
          [Op.or]: [
            { end_date: null },
            { end_date: { [Op.gte]: now } },
          ],
        },
      });

      // Événements qui devraient être désactivés automatiquement
      const eventsToDeactivate = await Event.findAll({
        where: {
          auto_activate: true,
          is_active: true,
          end_date: { [Op.lt]: now },
        },
      });

      // Activer les événements
      for (const event of eventsToActivate) {
        await event.update({ is_active: true });
        logger.info(`🎉 Événement activé automatiquement: ${event.name}`);
      }

      // Désactiver les événements expirés
      for (const event of eventsToDeactivate) {
        await event.update({ is_active: false });
        logger.info(`🎉 Événement désactivé automatiquement: ${event.name}`);
      }

      // Invalider le cache si des changements ont eu lieu
      if (eventsToActivate.length > 0 || eventsToDeactivate.length > 0) {
        this.invalidateCache();
      }

      return {
        activated: eventsToActivate.length,
        deactivated: eventsToDeactivate.length,
      };
    } catch (error) {
      logger.error('Erreur lors de la vérification des événements automatiques:', error);
      return { activated: 0, deactivated: 0 };
    }
  }

  /**
   * Obtenir la configuration de thème pour l'événement actif
   */
  async getActiveThemeConfig() {
    try {
      const activeEvent = await this.getActiveEvent();
      
      if (!activeEvent || !activeEvent.theme_config) {
        return null;
      }

      return {
        event: {
          id: activeEvent.id,
          name: activeEvent.name,
          slug: activeEvent.slug,
        },
        theme: activeEvent.theme_config,
        colors: activeEvent.colors || [],
        effects: activeEvent.effects || {},
        icon: activeEvent.icon,
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération de la configuration de thème:', error);
      return null;
    }
  }

  /**
   * Créer un événement avec validation
   */
  async createEvent(eventData, userId) {
    try {
      // Validation des données
      if (!eventData.name || !eventData.slug) {
        throw new Error('Le nom et le slug sont requis');
      }

      // Vérifier l'unicité du slug
      const existingEvent = await Event.findOne({ 
        where: { slug: eventData.slug },
      });
      
      if (existingEvent) {
        throw new Error('Un événement avec ce slug existe déjà');
      }

      // Validation des dates
      if (eventData.auto_activate && eventData.start_date && eventData.end_date) {
        const start = new Date(eventData.start_date);
        const end = new Date(eventData.end_date);
        
        if (start >= end) {
          throw new Error('La date de fin doit être postérieure à la date de début');
        }
      }

      const event = await Event.create({
        ...eventData,
        created_by: userId,
        updated_by: userId,
      });

      logger.info(`🎉 Événement créé: ${event.name} par l'utilisateur ${userId}`);
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
      const event = await Event.findByPk(eventId);
      if (!event) {
        throw new Error('Événement non trouvé');
      }

      // Vérifier l'unicité du slug si modifié
      if (updateData.slug && updateData.slug !== event.slug) {
        const existingEvent = await Event.findOne({ 
          where: { 
            slug: updateData.slug,
            id: { [Op.ne]: eventId },
          },
        });
        if (existingEvent) {
          throw new Error('Un événement avec ce slug existe déjà');
        }
      }

      // Validation des dates
      if (updateData.auto_activate && updateData.start_date && updateData.end_date) {
        const start = new Date(updateData.start_date);
        const end = new Date(updateData.end_date);
        
        if (start >= end) {
          throw new Error('La date de fin doit être postérieure à la date de début');
        }
      }

      await event.update({
        ...updateData,
        updated_by: userId,
      });

      // Invalider le cache si c'est l'événement actif
      if (event.is_active) {
        this.invalidateCache();
      }

      logger.info(`🎉 Événement mis à jour: ${event.name} par l'utilisateur ${userId}`);
      return event;
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de l\'événement:', error);
      throw error;
    }
  }

  /**
   * Supprimer un événement
   */
  async deleteEvent(eventId, userId) {
    try {
      const event = await Event.findByPk(eventId);
      if (!event) {
        throw new Error('Événement non trouvé');
      }

      const eventName = event.name;
      const wasActive = event.is_active;

      await event.destroy();

      // Invalider le cache si c'était l'événement actif
      if (wasActive) {
        this.invalidateCache();
      }

      logger.info(`🎉 Événement supprimé: ${eventName} par l'utilisateur ${userId}`);
      return true;
    } catch (error) {
      logger.error('Erreur lors de la suppression de l\'événement:', error);
      throw error;
    }
  }

  /**
   * Invalider le cache
   */
  invalidateCache() {
    this.activeEvent = null;
    this.lastCheck = null;
    this.cache.clear();
  }

  /**
   * Initialiser les événements par défaut
   */
  async initializeDefaultEvents() {
    try {
      await Event.createDefaultEvents();
      this.invalidateCache();
      logger.info('🎉 Événements par défaut initialisés');
      return true;
    } catch (error) {
      logger.error('Erreur lors de l\'initialisation des événements par défaut:', error);
      throw error;
    }
  }

  /**
   * Obtenir les statistiques des événements
   */
  async getEventStats() {
    try {
      const totalEvents = await Event.count();
      const activeEvents = await Event.count({ where: { is_active: true } });
      const autoEvents = await Event.count({ where: { auto_activate: true } });
      
      const recentEvents = await Event.findAll({
        order: [['created_at', 'DESC']],
        limit: 5,
        attributes: ['id', 'name', 'slug', 'is_active', 'created_at'],
      });

      return {
        total: totalEvents,
        active: activeEvents,
        automatic: autoEvents,
        recent: recentEvents,
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques d\'événements:', error);
      return null;
    }
  }
}

module.exports = new EventService();
