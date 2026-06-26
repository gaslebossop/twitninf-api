const { DataTypes, Model } = require('sequelize');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');

class User extends Model {
  // Méthode pour comparer les mots de passe
  async comparePassword(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
  }

  // Méthode pour mettre à jour la dernière activité
  async updateLastActivity() {
    this.last_activity = new Date();
    return this.save();
  }

  // Méthode pour vérifier si l'utilisateur est actif
  isUserActive() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return this.last_activity > thirtyDaysAgo;
  }

  toJSON() {
    const { rewriteMediaUrl } = require('../utils/publicMediaOrigin');
    const values = { ...this.get() };
    if (values.avatar) values.avatar = rewriteMediaUrl(values.avatar);
    if (values.banner) values.banner = rewriteMediaUrl(values.banner);
    return values;
  }

  // Méthode pour obtenir le profil public
  getPublicProfile() {
    const { rewriteMediaUrl } = require('../utils/publicMediaOrigin');
    return {
      id: this.id,
      username: this.username,
      full_name: this.full_name,
      avatar: rewriteMediaUrl(this.avatar),
      banner: this.banner ? rewriteMediaUrl(this.banner) : null,
      bio: this.bio || null,
      verified: this.verified,
      premium: this.premium,
      subscription_tier: this.subscription_tier || 'free',
      subscription_expires_at: this.subscription_expires_at || null,
      verification_style: this.verification_style || 'default',
      role: this.role || 'user',
      moderation_permissions: this.moderation_permissions || {},
      stats: this.stats,
      created_at: this.created_at,
      last_activity: this.last_activity,
      is_suspended: this.is_suspended || false,
      suspension_reason: this.suspension_reason || null,
      suspended_until: this.suspended_until || null,
      is_ios_native: this.is_ios_native || false
    };
  }

  // Méthode statique pour rechercher des utilisateurs
  static async searchUsers(query, limit = 10) {
    const { Op } = require('sequelize');
    return this.findAll({
      where: {
        [Op.or]: [
          { username: { [Op.iLike]: `%${query}%` } },
          { full_name: { [Op.iLike]: `%${query}%` } }
        ],
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'stats', 'is_ios_native'],
      limit,
      order: [['created_at', 'DESC']]
    });
  }

  // Méthode statique pour obtenir les utilisateurs populaires
  static async getPopularUsers(limit = 10) {
    return this.findAll({
      where: { 
        is_active: true,
        is_suspended: false 
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'stats', 'is_ios_native'],
      order: [['stats', 'DESC']],
      limit
    });
  }

  // Virtual pour l'âge du compte
  get accountAge() {
    const now = new Date();
    const created = this.created_at;
    const diffTime = Math.abs(now - created);
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  // Virtual pour le statut d'activité
  get activityStatus() {
    const now = new Date();
    const lastActivity = this.last_activity;
    const diffTime = Math.abs(now - lastActivity);
    const diffHours = Math.ceil(diffTime / (1000 * 60 * 60));
    
    if (diffHours < 1) return 'online';
    if (diffHours < 24) return 'recent';
    if (diffHours < 168) return 'weekly';
    return 'inactive';
  }
}

// Définition du schéma du modèle
const userSchema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  
  // Identifiants
  username: {
    type: DataTypes.STRING(30),
    allowNull: false,
    unique: true,
    validate: {
      len: [3, 30],
      is: /^[a-zA-Z0-9_]+$/
    }
  },
  
  // Informations personnelles
  full_name: {
    type: DataTypes.STRING(100),
    allowNull: false,
    validate: {
      len: [2, 100]
    }
  },
  
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  
  phone: {
    type: DataTypes.STRING(20),
    allowNull: true,
    unique: true,
    validate: {
      is: /^\+?[1-9]\d{1,14}$/
    }
  },
  
  // Authentification
  password: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      len: [7, 255]
    }
  },
  
  // Profil
  avatar: {
    type: DataTypes.STRING,
    defaultValue: 'https://static.vecteezy.com/system/resources/previews/009/292/244/non_2x/default-avatar-icon-of-social-media-user-vector.jpg',
    validate: {
      isUrl: {
        msg: 'L\'avatar doit être une URL valide'
      }
    }
  },

  banner: {
    type: DataTypes.STRING,
    allowNull: true,
  },

  bio: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null
  },
  
  // Statuts
  verified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  
  premium: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  /** Palier d'abonnement : free, plus (payant), pro (payant, tout inclus) */
  subscription_tier: {
    type: DataTypes.ENUM('free', 'plus', 'pro'),
    allowNull: false,
    defaultValue: 'free'
  },

  /** Fin d'abonnement payant ; null = pas d'expiration (ex. comptes historiques « premium ») */
  subscription_expires_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null
  },
  
  // Informations de plateforme
  platform: {
    type: DataTypes.ENUM('ios', 'android', 'web'),
    allowNull: false
  },
  
  // Activité
  last_activity: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  
  // Notifications
  id_notif: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: true
  },
  
  // Sécurité
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },

  // Gestion des sanctions
  ban_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  is_suspended: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  suspended_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  suspended_until: {
    type: DataTypes.DATE,
    allowNull: true
  },
  suspension_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  suspension_meta: {
    type: DataTypes.JSONB,
    defaultValue: {}
  },
  
  // Rôles de modération
  role: {
    type: DataTypes.ENUM('user', 'moderateur', 'admin', 'superadmin', 'classeurdetweets', 'economiegardien'),
    defaultValue: 'user',
    allowNull: false
  },
  
  // Permissions de modération (JSONB pour flexibilité)
  moderation_permissions: {
    type: DataTypes.JSONB,
    defaultValue: {
      can_ban_users: false,
      can_suspend_users: false,
      can_delete_tweets: false,
      can_verify_users: false,
      can_view_reports: false,
      can_view_analytics: false,
      can_manage_moderators: false
    }
  },
  
  // Historique des actions de modération
  moderation_history: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  
  email_verified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  
  phone_verified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  
  // Tokens de réinitialisation
  reset_password_token: {
    type: DataTypes.STRING,
    allowNull: true
  },
  
  reset_password_expires: {
    type: DataTypes.DATE,
    allowNull: true
  },
  
  // Statistiques (JSONB pour de meilleures performances)
  stats: {
    type: DataTypes.JSONB,
    defaultValue: {
      followers: 0,
      following: 0,
      tweets: 0,
      likes: 0
    }
  },
  
  // Préférences (JSONB)
  preferences: {
    type: DataTypes.JSONB,
    defaultValue: {
      language: 'fr',
      theme: 'dark',
      notifications: {
        push: true,
        email: true,
        sms: false
      }
    }
  },
  
  // Style de badge vérifié
  verification_style: {
    type: DataTypes.ENUM('default', 'rose', 'gray', 'gold'),
    defaultValue: 'default',
    allowNull: false
  },
  
  // Nouveau champ pour détecter l'application iOS native
  is_ios_native: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  // Visibilité fil algorithmique : 1 = normal, 0 = quasi absent, jusqu’à 5 = +500 % (×5)
  algorithmic_visibility_multiplier: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 1.0
  }
};

// Options du modèle
const modelOptions = {
  modelName: 'User',
  tableName: 'users',
  timestamps: true,
  underscored: true,
  
  // Index pour optimiser les requêtes
  indexes: [
    {
      unique: true,
      fields: ['username']
    },
    {
      unique: true,
      fields: ['email']
    },
    {
      unique: true,
      fields: ['phone']
    },
    {
      fields: ['verified']
    },
    {
      fields: ['premium']
    },
    {
      fields: ['subscription_tier']
    },
    {
      fields: ['last_activity']
    },
    {
      fields: ['created_at']
    },
    {
      fields: ['is_active']
    },
    // Index GIN pour JSONB
    {
      fields: ['stats'],
      using: 'gin'
    },
    {
      fields: ['preferences'],
      using: 'gin'
    }
  ],
  
  // Hooks
  hooks: {
    beforeCreate: async (user) => {
      if (user.password) {
        const salt = await bcrypt.genSalt(12);
        user.password = await bcrypt.hash(user.password, salt);
      }
      if (user.subscription_tier && user.subscription_tier !== 'free') {
        user.premium = true;
      }
    },
    
    beforeUpdate: async (user) => {
      if (user.changed('password')) {
        const salt = await bcrypt.genSalt(12);
        user.password = await bcrypt.hash(user.password, salt);
      }
      if (user.changed('subscription_tier')) {
        user.premium = user.subscription_tier !== 'free';
      }
    },
    
    afterCreate: async (user) => {
      logger.info(`Nouvel utilisateur créé: ${user.username}`);
      try {
        const NewEconomyService = require('../services/newEconomyService');
        await NewEconomyService.ensureWalletsForUser(user.id);
      } catch (e) {
        logger.warn(`Portefeuilles virtuels non initialisés pour ${user.id}: ${e.message}`);
      }
    },
    
    afterUpdate: (user) => {
      logger.info(`Utilisateur mis à jour: ${user.username}`);
    }
  }
};

// Fonction pour initialiser le modèle avec sequelize
function initUserModel(sequelize) {
  User.init(userSchema, {
    ...modelOptions,
    sequelize
  });
}

module.exports = User;
module.exports.initUserModel = initUserModel;
module.exports.userSchema = userSchema;
module.exports.modelOptions = modelOptions;
