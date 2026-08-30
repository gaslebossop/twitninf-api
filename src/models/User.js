const { DataTypes, Model } = require('sequelize');
// AUDIT R4-02 (2026-08-19), CRITIQUE : `bcryptjs` est une réimplémentation
// pure JavaScript — tout le calcul se fait sur le fil principal de Node, en
// concurrence directe avec toutes les autres requêtes en cours (mesuré :
// ~93 ms de retard de boucle d'événements par connexion, au coût 12). Le
// module natif exécute le même calcul dans le pool de travail de libuv, hors
// du fil principal — API identique, aucun autre changement nécessaire. Les
// empreintes déjà stockées ($2a$/$2b$) restent valides : vérifié qu'un hash
// `bcryptjs` se valide avec `bcrypt` natif et réciproquement.
const bcrypt = require('bcrypt');
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
      city: this.city || null,
      verified: this.verified,
      premium: this.premium,
      subscription_tier: this.subscription_tier || 'free',
      subscription_expires_at: this.subscription_expires_at || null,
      verification_style: this.verification_style || 'default',
      // Publique par nature : c'est elle qui habille le nom et la pastille
      // partout où le compte apparaît (fil, recherche, suggestions,
      // notifications). Omise ici, elle était silencieusement retirée des
      // réponses même quand la requête SQL la chargeait bien.
      profile_customization: this.profile_customization || {},
      role: this.role || 'user',
      moderation_permissions: this.moderation_permissions || {},
      is_private_account: this.is_private_account || false,
      stats: this.stats,
      created_at: this.created_at,
      last_activity: this.last_activity,
      is_suspended: this.is_suspended || false,
      suspension_reason: this.suspension_reason || null,
      suspended_until: this.suspended_until || null,
      is_ios_native: this.is_ios_native || false,
      // Jamais le sub g-auth lui-même (identifiant tiers opaque) : le client
      // n'a besoin que de savoir si le lien existe, pour afficher l'état
      // correct du bouton d'association dans les réglages.
      g_auth_linked: !!this.g_auth_sub
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
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'stats', 'is_ios_native', 'profile_customization'],
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
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'stats', 'is_ios_native', 'profile_customization'],
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

  city: {
    type: DataTypes.STRING(30),
    allowNull: true,
    defaultValue: null
  },

  // Donnees privees renseignees par le proprietaire du compte. Elles ne sont
  // volontairement jamais incluses dans getPublicProfile().
  declared_age: {
    type: DataTypes.SMALLINT,
    allowNull: true,
    validate: { min: 13, max: 120 }
  },
  birth_day: {
    type: DataTypes.SMALLINT,
    allowNull: true,
    validate: { min: 1, max: 31 }
  },
  birth_month: {
    type: DataTypes.SMALLINT,
    allowNull: true,
    validate: { min: 1, max: 12 }
  },
  demographics_validated_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  location_consent_status: {
    type: DataTypes.STRING(24),
    allowNull: false,
    defaultValue: 'undetermined'
  },
  location_consent_updated_at: {
    type: DataTypes.DATE,
    allowNull: true
  },

  // Consentement RGPD. `consent_version` porte la version du socle acceptee :
  // une version differente de celle en vigueur vaut « jamais accepte », donc la
  // question est reposee. La preuve detaillee vit dans user_consent_records.
  consent_version: {
    type: DataTypes.STRING(20),
    allowNull: true,
    defaultValue: null
  },
  consent_accepted_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  consent_preferences: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {}
  },

  // Étape d'abonnements de l'inscription. Renseignée une fois pour toutes :
  // se désabonner ensuite ne fait pas réapparaître l'écran.
  follow_onboarding_completed_at: {
    type: DataTypes.DATE,
    allowNull: true
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

  /** Compte privé : les tweets/le profil ne sont visibles qu'aux abonnés acceptés (statut `active` sur UserFollow). Ne pas confondre avec `Tweet.is_private`. */
  is_private_account: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  /** Palier d'abonnement : free, plus (payant), pro (payant, tout inclus), ultra (payant, 10x les limites API) */
  subscription_tier: {
    type: DataTypes.ENUM('free', 'plus', 'pro', 'ultra'),
    allowNull: false,
    defaultValue: 'free'
  },

  /** Prix indicatif (en NF) affiché sur la marketplace de contrats Ultra. Purement informatif : une marque peut proposer n'importe quel montant. */
  ultra_indicative_price_nf: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: true,
  },

  /** Fin d'abonnement payant ; null = pas d'expiration (ex. comptes historiques « premium ») */
  subscription_expires_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null
  },

  /** Solde de Super Cœurs (palier Pro) — voir `src/utils/superHeartHelpers.js`. */
  super_hearts_remaining: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },

  /** Prochain renouvellement du solde de Super Cœurs ; null = jamais accordé. */
  super_hearts_renew_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null
  },

  /**
   * Programme de monétisation : condition supplémentaire à l'abonnement
   * payant. `approved` est nécessaire pour toucher des récompenses tweet
   * (voir `TweetMonetizationService.isAuthorMonetizable`), même avec un
   * abonnement actif. Passe toujours par une validation manuelle, même
   * quand les seuils (vues, abonnés, qualité) sont atteints.
   */
  monetization_program_status: {
    type: DataTypes.ENUM('none', 'pending', 'approved', 'rejected'),
    allowNull: false,
    defaultValue: 'none'
  },
  monetization_applied_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null
  },
  monetization_reviewed_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null
  },
  monetization_reviewed_by: {
    type: DataTypes.UUID,
    allowNull: true,
    defaultValue: null
  },
  monetization_rejection_reason: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null
  },

  /** Solde du générateur de tweets à la demande (5 offerts par achat payant). */
  tweet_generation_credits: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: { min: 0 }
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

  // ── Double authentification ───────────────────────────────────────────
  // Deux drapeaux plutôt qu'un seul champ « méthode » : les deux facteurs
  // coexistent, et couper l'e-mail ne doit pas désactiver l'application
  // d'authentification.
  two_factor_email_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  two_factor_totp_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  // Secret partagé de l'application d'authentification. Lisible par le
  // serveur par nature (l'algorithme l'exige) : il n'est jamais rendu par une
  // route après confirmation, et `getPublicProfile` ne le voit pas.
  two_factor_totp_secret: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  two_factor_enabled_at: {
    type: DataTypes.DATE,
    allowNull: true
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
  
  /**
   * Langue de lecture choisie par l'utilisateur (« Traduction bêta »).
   *
   * `null` signifie « jamais choisie » — c'est ce qui déclenche l'écran de
   * choix à la première connexion. Ne pas remplacer par un défaut 'fr' : on ne
   * pourrait plus distinguer un compte qui a explicitement gardé le français
   * d'un compte à qui la question n'a jamais été posée, et l'app reposerait la
   * question à chaque démarrage.
   *
   * Distinct de `preferences.language`, qui concerne la langue de l'interface.
   */
  preferred_language: {
    type: DataTypes.STRING(8),
    allowNull: true,
    defaultValue: null
  },

  // Style de badge vérifié
  verification_style: {
    type: DataTypes.ENUM('default', 'rose', 'gray', 'gold'),
    defaultValue: 'default',
    allowNull: false
  },

  /**
   * Personnalisation de profil façon Discord (réservée Plus/Pro).
   * Volontairement séparée de `preferences`, qui porte les réglages
   * applicatifs (langue, notifications) et n'a pas vocation à être exposée
   * publiquement, alors que ceci s'affiche sur le profil de tout le monde.
   * Forme : { accent_color, secondary_color, banner_style, theme_intensity,
   *           avatar_decoration, name_font, name_effect, name_size,
   *           profile_effect, profile_title, about_me }
   * Les clés sont validées côté route (`sanitizeCustomization`) : rien de ce
   * qui arrive du client n'est stocké tel quel.
   */
  profile_customization: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {}
  },

  /**
   * Habillage payant mis de côté quand l'abonnement expire, restauré tel quel
   * au réabonnement.
   *
   * Colonne à part, et non une clé de `profile_customization` : cette dernière
   * part dans toutes les charges utiles d'auteur (fil, messages, recherche), et
   * y glisser une archive la ferait voyager partout pour rien. Aucune route ne
   * l'expose — elle ne figure dans aucune liste d'`attributes`.
   */
  profile_customization_archive: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null
  },


  // Nouveau champ pour détecter l'application iOS native
  is_ios_native: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },

  // Visibilité fil algorithmique : 1 = normal, 0 = quasi absent, jusqu’à 5 = +500 % (×5)
  is_data_test: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },

  data_test_batch_id: {
    type: DataTypes.STRING,
    allowNull: true
  },

  /**
   * Bonus temporaire sur les gains, gagné en récompense d'événement.
   *
   * L'échéance vit dans la colonne voisine plutôt que dans une tâche de
   * nettoyage : un bonus expiré se lit comme absent, sans qu'aucun cron n'ait
   * à passer, et rien n'est à réparer si le serveur redémarre au mauvais
   * moment. La colonne est créée par `scripts/autoMigration.js` — `sync()`
   * tourne en `alter: false` et n'ajoute jamais de colonne à une table
   * existante.
   */
  earn_multiplier: {
    type: DataTypes.DOUBLE,
    allowNull: false,
    defaultValue: 1.0
  },

  /** Fin du bonus. `null` = aucun bonus en cours. */
  earn_multiplier_until: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null
  },

  algorithmic_visibility_multiplier: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 1.0
  },

  /**
   * Identifiant g-auth (claim `sub`) lié à ce compte, si l'utilisateur s'est
   * connecté ou associé via G. L'unicité réelle est un index partiel posé en
   * SQL brut (migrate.js) — pas ici, `sync({alter:true})` n'ajoute pas les
   * colonnes existantes de façon fiable en production.
   */
  g_auth_sub: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  g_auth_linked_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Distinct de g_auth_linked_at : si un délien/relien est ajouté plus tard,
  // il ne doit pas permettre de reclaimer le bonus d'association.
  g_auth_bonus_claimed_at: {
    type: DataTypes.DATE,
    allowNull: true
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
