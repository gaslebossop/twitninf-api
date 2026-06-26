/**
 * Modèle Event pour la gestion des événements thématiques
 * Permet aux admins de contrôler les événements dans l'application
 */

const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Event = sequelize.define('Event', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Nom de l\'événement (ex: Halloween, Noël)',
    },
    slug: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: 'Identifiant unique pour l\'événement (ex: halloween, christmas)',
    },
    description: {
      type: DataTypes.TEXT,
      comment: 'Description de l\'événement',
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
    theme_id: {
      type: DataTypes.STRING,
      comment: 'ID du preset de thème pour les tweets (valentine, halloween, christmas, newyear, easter)',
      allowNull: true,
    },
    theme_config: {
      type: DataTypes.JSON,
      comment: 'Configuration du thème pour cet événement',
      defaultValue: {},
    },
    start_date: {
      type: DataTypes.DATE,
      comment: 'Date de début de l\'événement (optionnel pour activation manuelle)',
    },
    end_date: {
      type: DataTypes.DATE,
      comment: 'Date de fin de l\'événement (optionnel pour activation manuelle)',
    },
    auto_activate: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Activation automatique basée sur les dates',
    },
    icon: {
      type: DataTypes.STRING,
      comment: 'Icône de l\'événement',
    },
    colors: {
      type: DataTypes.JSON,
      comment: 'Couleurs principales de l\'événement',
      defaultValue: [],
    },
    effects: {
      type: DataTypes.JSON,
      comment: 'Effets visuels spéciaux pour l\'événement',
      defaultValue: {},
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
    tableName: 'events',
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

  Event.associate = function(models) {
    // Un événement est créé par un utilisateur admin
    Event.belongsTo(models.User, {
      foreignKey: 'created_by',
      as: 'creator',
    });

    // Un événement est modifié par un utilisateur admin
    Event.belongsTo(models.User, {
      foreignKey: 'updated_by',
      as: 'updater',
    });
  };

  // Méthodes du modèle
  Event.prototype.activate = async function() {
    this.is_active = true;
    await this.save();
    return this;
  };

  Event.prototype.deactivate = async function() {
    this.is_active = false;
    await this.save();
    return this;
  };

  Event.prototype.isCurrentlyActive = function() {
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

  // Méthodes statiques
  Event.getActiveEvent = async function() {
    const events = await Event.findAll({
      where: {
        is_active: true,
      },
      order: [['priority', 'DESC'], ['created_at', 'DESC']],
      limit: 1,
      include: [
        {
          model: sequelize.models.User,
          as: 'creator',
          attributes: ['id', 'username', 'full_name'],
        },
      ],
    });

    return events.length > 0 ? events[0] : null;
  };

  Event.getActiveEvents = async function() {
    return await Event.findAll({
      where: {
        is_active: true,
      },
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

  Event.createDefaultEvents = async function() {
    const defaultEvents = [
      {
        name: 'Halloween',
        slug: 'halloween',
        description: 'Événement Halloween avec thème sombre et effets spéciaux',
        theme_id: 'halloween',
        theme_config: {
          id: 'halloween',
          name: 'Halloween',
          description: 'Thème Halloween effrayant',
          colors: ['#1a0a00', '#ff4500', '#ff6b00', '#8b0000'],
          icon: 'skull',
        },
        icon: 'skull',
        colors: ['#1a0a00', '#ff4500', '#ff6b00', '#8b0000'],
        effects: {
          particles: 'pumpkins',
          animations: ['floating', 'spooky'],
          sounds: false,
        },
        priority: 10,
      },
      {
        name: 'Noël',
        slug: 'christmas',
        description: 'Événement de Noël avec thème festif',
        theme_id: 'christmas',
        theme_config: {
          id: 'christmas',
          name: 'Noël',
          description: 'Thème de Noël festif',
          colors: ['#0d4f3c', '#c41e3a', '#ffd700', '#228b22'],
          icon: 'gift',
        },
        icon: 'gift',
        colors: ['#0d4f3c', '#c41e3a', '#ffd700', '#228b22'],
        effects: {
          particles: 'snowflakes',
          animations: ['sparkle', 'snow'],
          sounds: false,
        },
        priority: 10,
      },
      {
        name: 'Nouvel An',
        slug: 'new-year',
        description: 'Événement du Nouvel An avec feux d\'artifice',
        theme_id: 'newyear',
        theme_config: {
          id: 'new-year',
          name: 'Nouvel An',
          description: 'Thème du Nouvel An éclatant',
          colors: ['#000015', '#ffd700', '#ff6b6b', '#4ecdc4'],
          icon: 'star',
        },
        icon: 'star',
        colors: ['#000015', '#ffd700', '#ff6b6b', '#4ecdc4'],
        effects: {
          particles: 'fireworks',
          animations: ['burst', 'sparkle'],
          sounds: false,
        },
        priority: 10,
      },
      {
        name: 'Saint-Valentin',
        slug: 'valentine',
        description: 'Événement de la Saint-Valentin romantique',
        theme_id: 'valentine',
        theme_config: {
          id: 'valentine',
          name: 'Saint-Valentin',
          description: 'Thème romantique de la Saint-Valentin',
          colors: ['#2d1b29', '#ff69b4', '#ff1493', '#dc143c'],
          icon: 'heart',
        },
        icon: 'heart',
        colors: ['#2d1b29', '#ff69b4', '#ff1493', '#dc143c'],
        effects: {
          particles: 'hearts',
          animations: ['float', 'pulse'],
          sounds: false,
        },
        priority: 10,
      },
    ];

    for (const eventData of defaultEvents) {
      const existing = await Event.findOne({ where: { slug: eventData.slug } });
      if (!existing) {
        await Event.create(eventData);
        console.log(`✅ Événement par défaut créé: ${eventData.name}`);
      }
    }
  };

  return Event;
};
