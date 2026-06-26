/**
 * Contrôleur pour la gestion des événements thématiques
 * Permet aux admins de créer, modifier et activer des événements
 */

const { Event, User } = require('../models');
const { Op } = require('sequelize');

class EventController {
  // Obtenir tous les événements (accessible à tous)
  async getEvents(req, res) {
    try {
      const { 
        page = 1, 
        limit = 20, 
        active_only = false,
        include_inactive = false 
      } = req.query;

      const offset = (page - 1) * limit;
      const whereClause = {};

      // Si on veut seulement les événements actifs
      if (active_only === 'true') {
        whereClause.is_active = true;
      }

      // Si on exclut les inactifs (par défaut)
      if (include_inactive !== 'true' && active_only !== 'true') {
        whereClause.is_active = true;
      }

      const { count, rows: events } = await Event.findAndCountAll({
        where: whereClause,
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [['priority', 'DESC'], ['created_at', 'DESC']],
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'username', 'full_name'],
          },
        ],
      });

      res.json({
        success: true,
        data: {
          events,
          pagination: {
            current_page: parseInt(page),
            total_pages: Math.ceil(count / limit),
            total_items: count,
            items_per_page: parseInt(limit),
          },
        },
      });
    } catch (error) {
      console.error('❌ Erreur lors de la récupération des événements:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des événements',
        error: error.message,
      });
    }
  }

  // Obtenir l'événement actuellement actif (accessible à tous)
  async getActiveEvent(req, res) {
    try {
      const activeEvent = await Event.getActiveEvent();

      if (!activeEvent) {
        return res.json({
          success: true,
          data: null,
          message: 'Aucun événement actuellement actif',
        });
      }

      // Vérifier si l'événement est vraiment actif (dates auto)
      if (activeEvent.auto_activate && !activeEvent.isCurrentlyActive()) {
        await activeEvent.deactivate();
        return res.json({
          success: true,
          data: null,
          message: 'Événement expiré automatiquement',
        });
      }

      res.json({
        success: true,
        data: activeEvent,
      });
    } catch (error) {
      console.error('❌ Erreur lors de la récupération de l\'événement actif:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération de l\'événement actif',
        error: error.message,
      });
    }
  }

  // Obtenir un événement par ID ou slug (accessible à tous)
  async getEvent(req, res) {
    try {
      const { id } = req.params;
      
      const whereClause = {};
      // Vérifier si c'est un UUID ou un slug
      if (id.length === 36 && id.includes('-')) {
        whereClause.id = id;
      } else {
        whereClause.slug = id;
      }

      const event = await Event.findOne({
        where: whereClause,
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'username', 'full_name'],
          },
          {
            model: User,
            as: 'updater',
            attributes: ['id', 'username', 'full_name'],
          },
        ],
      });

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
      console.error('❌ Erreur lors de la récupération de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération de l\'événement',
        error: error.message,
      });
    }
  }

  // Créer un nouvel événement (admin uniquement)
  async createEvent(req, res) {
    try {
      const {
        name,
        slug,
        description,
        theme_config,
        start_date,
        end_date,
        auto_activate,
        icon,
        colors,
        effects,
        priority = 0,
      } = req.body;

      // Vérifications
      if (!name || !slug) {
        return res.status(400).json({
          success: false,
          message: 'Le nom et le slug sont requis',
        });
      }

      // Vérifier si le slug existe déjà
      const existingEvent = await Event.findOne({ where: { slug } });
      if (existingEvent) {
        return res.status(400).json({
          success: false,
          message: 'Un événement avec ce slug existe déjà',
        });
      }

      const event = await Event.create({
        name,
        slug,
        description,
        theme_config: theme_config || {},
        start_date,
        end_date,
        auto_activate: auto_activate || false,
        icon,
        colors: colors || [],
        effects: effects || {},
        priority,
        created_by: req.user.id,
        updated_by: req.user.id,
      });

      // Récupérer l'événement avec les relations
      const createdEvent = await Event.findByPk(event.id, {
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'username', 'full_name'],
          },
        ],
      });

      res.status(201).json({
        success: true,
        data: createdEvent,
        message: 'Événement créé avec succès',
      });
    } catch (error) {
      console.error('❌ Erreur lors de la création de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la création de l\'événement',
        error: error.message,
      });
    }
  }

  // Modifier un événement (admin uniquement)
  async updateEvent(req, res) {
    try {
      const { id } = req.params;
      const updateData = { ...req.body };
      updateData.updated_by = req.user.id;

      const event = await Event.findByPk(id);
      if (!event) {
        return res.status(404).json({
          success: false,
          message: 'Événement non trouvé',
        });
      }

      // Vérifier le slug si modifié
      if (updateData.slug && updateData.slug !== event.slug) {
        const existingEvent = await Event.findOne({ 
          where: { 
            slug: updateData.slug,
            id: { [Op.ne]: id },
          },
        });
        if (existingEvent) {
          return res.status(400).json({
            success: false,
            message: 'Un événement avec ce slug existe déjà',
          });
        }
      }

      await event.update(updateData);

      // Récupérer l'événement mis à jour avec les relations
      const updatedEvent = await Event.findByPk(id, {
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'username', 'full_name'],
          },
          {
            model: User,
            as: 'updater',
            attributes: ['id', 'username', 'full_name'],
          },
        ],
      });

      res.json({
        success: true,
        data: updatedEvent,
        message: 'Événement mis à jour avec succès',
      });
    } catch (error) {
      console.error('❌ Erreur lors de la mise à jour de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la mise à jour de l\'événement',
        error: error.message,
      });
    }
  }

  // Activer un événement (admin uniquement)
  async activateEvent(req, res) {
    try {
      const { id } = req.params;
      const { deactivate_others = true } = req.body;

      const event = await Event.findByPk(id);
      if (!event) {
        return res.status(404).json({
          success: false,
          message: 'Événement non trouvé',
        });
      }

      // Désactiver les autres événements si demandé
      if (deactivate_others) {
        await Event.update(
          { is_active: false },
          { where: { id: { [Op.ne]: id } } }
        );
      }

      await event.activate();
      await event.update({ updated_by: req.user.id });

      res.json({
        success: true,
        data: event,
        message: 'Événement activé avec succès',
      });
    } catch (error) {
      console.error('❌ Erreur lors de l\'activation de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'activation de l\'événement',
        error: error.message,
      });
    }
  }

  // Désactiver un événement (admin uniquement)
  async deactivateEvent(req, res) {
    try {
      const { id } = req.params;

      const event = await Event.findByPk(id);
      if (!event) {
        return res.status(404).json({
          success: false,
          message: 'Événement non trouvé',
        });
      }

      await event.deactivate();
      await event.update({ updated_by: req.user.id });

      res.json({
        success: true,
        data: event,
        message: 'Événement désactivé avec succès',
      });
    } catch (error) {
      console.error('❌ Erreur lors de la désactivation de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la désactivation de l\'événement',
        error: error.message,
      });
    }
  }

  // Supprimer un événement (admin uniquement)
  async deleteEvent(req, res) {
    try {
      const { id } = req.params;

      const event = await Event.findByPk(id);
      if (!event) {
        return res.status(404).json({
          success: false,
          message: 'Événement non trouvé',
        });
      }

      await event.destroy();

      res.json({
        success: true,
        message: 'Événement supprimé avec succès',
      });
    } catch (error) {
      console.error('❌ Erreur lors de la suppression de l\'événement:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de la suppression de l\'événement',
        error: error.message,
      });
    }
  }

  // Initialiser les événements par défaut (admin uniquement)
  async initializeDefaultEvents(req, res) {
    try {
      await Event.createDefaultEvents();

      res.json({
        success: true,
        message: 'Événements par défaut initialisés avec succès',
      });
    } catch (error) {
      console.error('❌ Erreur lors de l\'initialisation des événements:', error);
      res.status(500).json({
        success: false,
        message: 'Erreur lors de l\'initialisation des événements',
        error: error.message,
      });
    }
  }
}

module.exports = new EventController();
