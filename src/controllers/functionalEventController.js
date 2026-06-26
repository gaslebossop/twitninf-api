/**
 * Contrôleur pour la gestion des événements fonctionnels
 * Gère les routes API pour les événements fonctionnels
 */

const functionalEventService = require('../services/functionalEventService');
const logger = require('../utils/logger');

class FunctionalEventController {
  /**
   * Obtenir tous les événements
   */
  async getEvents(req, res) {
    try {
      const events = await functionalEventService.getAllEvents();
      
      res.json({
        success: true,
        data: events,
        count: events.length,
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des événements:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des événements',
        error: error.message,
      });
    }
  }

  /**
   * Obtenir les événements actifs
   */
  async getActiveEvents(req, res) {
    try {
      const events = await functionalEventService.getActiveEvents();
      
      res.json({
        success: true,
        data: events,
        count: events.length,
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération des événements actifs:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des événements actifs',
        error: error.message,
      });
    }
  }

  /**
   * Obtenir les événements actifs pour une page
   */
  async getActiveEventsForPage(req, res) {
    try {
      const { pageName } = req.params;
      const events = await functionalEventService.getActiveEventsForPage(pageName);
      
      res.json({
        success: true,
        data: events,
        count: events.length,
      });
    } catch (error) {
      logger.error(`Erreur lors de la récupération des événements pour ${req.params.pageName}:`, error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des événements pour la page',
        error: error.message,
      });
    }
  }

  /**
   * Obtenir les fonctionnalités actives pour une page
   */
  async getActiveFeaturesForPage(req, res) {
    try {
      const { pageName } = req.params;
      const features = await functionalEventService.getActiveFeaturesForPage(pageName);
      
      res.json({
        success: true,
        data: features,
      });
    } catch (error) {
      logger.error(`Erreur lors de la récupération des fonctionnalités pour ${req.params.pageName}:`, error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des fonctionnalités',
        error: error.message,
      });
    }
  }

  /**
   * Vérifier si une fonctionnalité est active
   */
  async isFeatureActive(req, res) {
    try {
      const { pageName, featureName } = req.params;
      const isActive = await functionalEventService.isFeatureActive(featureName, pageName);
      
      res.json({
        success: true,
        data: { isActive },
      });
    } catch (error) {
      logger.error(`Erreur lors de la vérification de la fonctionnalité ${req.params.featureName}:`, error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la vérification de la fonctionnalité',
        error: error.message,
      });
    }
  }

  /**
   * Obtenir la valeur d'une fonctionnalité
   */
  async getFeatureValue(req, res) {
    try {
      const { pageName, featureName } = req.params;
      const { defaultValue } = req.query;
      const value = await functionalEventService.getFeatureValue(featureName, pageName, defaultValue);
      
      res.json({
        success: true,
        data: { value },
      });
    } catch (error) {
      logger.error(`Erreur lors de la récupération de la valeur ${req.params.featureName}:`, error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération de la valeur',
        error: error.message,
      });
    }
  }

  /**
   * Obtenir un événement par ID
   */
  async getEventById(req, res) {
    try {
      const { id } = req.params;
      const event = await functionalEventService.getEventById(id);
      
      if (!event) {
        return res.status(404).json({
          success: false,
          message: 'Événement non trouvé',
        });
      }
      
      res.json({
        success: true,
        data: event,
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération de l\'événement',
        error: error.message,
      });
    }
  }

  /**
   * Créer un nouvel événement
   */
  async createEvent(req, res) {
    try {
      const eventData = req.body;
      const userId = req.user.id;
      
      const event = await functionalEventService.createEvent(eventData, userId);
      
      res.status(201).json({
        success: true,
        data: event,
        message: 'Événement créé avec succès',
      });
    } catch (error) {
      logger.error('Erreur lors de la création de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la création de l\'événement',
        error: error.message,
      });
    }
  }

  /**
   * Mettre à jour un événement
   */
  async updateEvent(req, res) {
    try {
      const { id } = req.params;
      const updateData = req.body;
      const userId = req.user.id;
      
      const event = await functionalEventService.updateEvent(id, updateData, userId);
      
      res.json({
        success: true,
        data: event,
        message: 'Événement mis à jour avec succès',
      });
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la mise à jour de l\'événement',
        error: error.message,
      });
    }
  }

  /**
   * Activer un événement
   */
  async activateEvent(req, res) {
    try {
      const { id } = req.params;
      const { deactivateOthers = true } = req.body;
      
      const event = await functionalEventService.activateEvent(id, deactivateOthers);
      
      res.json({
        success: true,
        data: event,
        message: 'Événement activé avec succès',
      });
    } catch (error) {
      logger.error('Erreur lors de l\'activation de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'activation de l\'événement',
        error: error.message,
      });
    }
  }

  /**
   * Désactiver un événement
   */
  async deactivateEvent(req, res) {
    try {
      const { id } = req.params;
      
      const event = await functionalEventService.deactivateEvent(id);
      
      res.json({
        success: true,
        data: event,
        message: 'Événement désactivé avec succès',
      });
    } catch (error) {
      logger.error('Erreur lors de la désactivation de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la désactivation de l\'événement',
        error: error.message,
      });
    }
  }

  /**
   * Supprimer un événement
   */
  async deleteEvent(req, res) {
    try {
      const { id } = req.params;
      
      await functionalEventService.deleteEvent(id);
      
      res.json({
        success: true,
        message: 'Événement supprimé avec succès',
      });
    } catch (error) {
      logger.error('Erreur lors de la suppression de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la suppression de l\'événement',
        error: error.message,
      });
    }
  }

  /**
   * Initialiser les événements par défaut
   */
  async initializeDefaultEvents(req, res) {
    try {
      const userId = req.user.id;
      
      const events = await functionalEventService.initializeDefaultEvents(userId);
      
      res.json({
        success: true,
        data: events,
        message: `${events.length} événements par défaut initialisés`,
      });
    } catch (error) {
      logger.error('Erreur lors de l\'initialisation des événements par défaut:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'initialisation des événements par défaut',
        error: error.message,
      });
    }
  }
}

module.exports = new FunctionalEventController();
