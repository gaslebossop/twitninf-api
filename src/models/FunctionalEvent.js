/**
 * Modèle FunctionalEvent pour la gestion des événements fonctionnels
 * Permet d'ajouter des fonctionnalités temporaires à des pages spécifiques
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const FunctionalEvent = sequelize.define('FunctionalEvent', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Nom de l\'événement fonctionnel (ex: "Double XP", "Messages Illimités")',
    },
    slug: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: 'Identifiant unique pour l\'événement (ex: double-xp-weekend)',
    },
    description: {
      type: DataTypes.TEXT,
      comment: 'Description de l\'événement et de ses fonctionnalités',
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Indique si l\'événement est actuellement actif',
    },
    priority: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      comment: 'Priorité de l\'événement (plus élevé = plus prioritaire)',
    },
    target_pages: {
      type: DataTypes.JSON,
      allowNull: false,
      comment: 'Pages ciblées par l\'événement (ex: ["tweets", "profile", "messages"])',
      defaultValue: [],
    },
    features: {
      type: DataTypes.JSON,
      allowNull: false,
      comment: 'Fonctionnalités ajoutées par l\'événement',
      defaultValue: {},
    },
    start_date: {
      type: DataTypes.DATE,
      comment: 'Date de début de l\'événement',
    },
    end_date: {
      type: DataTypes.DATE,
      comment: 'Date de fin de l\'événement',
    },
    auto_activate: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Activation automatique basée sur les dates',
    },
    icon: {
      type: DataTypes.STRING,
      comment: 'Icône de l\'événement',
      defaultValue: 'star',
    },
    banner_message: {
      type: DataTypes.TEXT,
      comment: 'Message à afficher dans la bannière de l\'événement',
    },
    notification_message: {
      type: DataTypes.TEXT,
      comment: 'Message de notification pour l\'événement',
    },
    created_by: {
      type: DataTypes.UUID,
      comment: 'ID de l\'admin qui a créé l\'événement',
    },
    updated_by: {
      type: DataTypes.UUID,
      comment: 'ID de l\'admin qui a modifié l\'événement en dernier',
    },
  }, {
    tableName: 'functional_events',
    timestamps: true,
    paranoid: true, // Soft delete
    indexes: [
      {
        fields: ['slug'],
        unique: true,
      },
      {
        fields: ['is_active', 'priority'],
      },
      {
        fields: ['start_date', 'end_date'],
      },
    ],
  });

  FunctionalEvent.associate = function(models) {
    // Un événement est créé par un utilisateur admin
    FunctionalEvent.belongsTo(models.User, {
      foreignKey: 'created_by',
      as: 'creator',
    });

    // Un événement est modifié par un utilisateur admin
    FunctionalEvent.belongsTo(models.User, {
      foreignKey: 'updated_by',
      as: 'updater',
    });
  };

  // Méthodes du modèle
  FunctionalEvent.prototype.activate = async function() {
    this.is_active = true;
    await this.save();
    return this;
  };

  FunctionalEvent.prototype.deactivate = async function() {
    this.is_active = false;
    await this.save();
    return this;
  };

  FunctionalEvent.prototype.isCurrentlyActive = function() {
    if (!this.auto_activate) {
      return this.is_active;
    }

    const now = new Date();
    const start = this.start_date ? new Date(this.start_date) : null;
    const end = this.end_date ? new Date(this.end_date) : null;

    if (start && now < start) return false;
    if (end && now > end) return false;

    return this.is_active;
  };

  FunctionalEvent.prototype.isActiveForPage = function(pageName) {
    if (!this.isCurrentlyActive()) return false;
    return this.target_pages.includes(pageName) || this.target_pages.includes('all');
  };

  // Méthodes statiques
  FunctionalEvent.getActiveEvents = async function() {
    return await this.findAll({
      where: { is_active: true },
      order: [['priority', 'DESC'], ['created_at', 'DESC']],
      include: [
        {
          model: sequelize.models.User,
          as: 'creator',
          attributes: ['id', 'username', 'full_name'],
        },
      ],
    });
  };

  FunctionalEvent.getActiveEventsForPage = async function(pageName) {
    const events = await this.getActiveEvents();
    return events.filter(event => event.isActiveForPage(pageName));
  };

  FunctionalEvent.getActiveEvent = async function() {
    const events = await this.getActiveEvents();
    return events.length > 0 ? events[0] : null;
  };

  FunctionalEvent.activateEvent = async function(eventId, deactivateOthers = true) {
    const transaction = await sequelize.transaction();
    
    try {
      if (deactivateOthers) {
        await this.update(
          { is_active: false },
          { where: { is_active: true }, transaction }
        );
      }

      const event = await this.findByPk(eventId, { transaction });
      if (!event) {
        throw new Error('Événement non trouvé');
      }

      await event.activate();
      await transaction.commit();
      return event;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  };

  FunctionalEvent.deactivateEvent = async function(eventId) {
    const event = await this.findByPk(eventId);
    if (!event) {
      throw new Error('Événement non trouvé');
    }

    return await event.deactivate();
  };

  return FunctionalEvent;
};
