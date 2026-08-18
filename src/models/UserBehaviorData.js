/**
 * 📊 Modèle de Données Comportementales Utilisateur
 * 
 * Ce modèle stocke toutes les interactions utilisateur pour enrichir
 * l'algorithme de recommandation Smart Engine
 */

const { DataTypes, Model } = require('sequelize');

class UserBehaviorData extends Model {}

// Schema de la table
const userBehaviorDataSchema = {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  
  // Identification
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  
  // Type d'action
  action_type: {
    type: DataTypes.ENUM(
      // Actions sur tweets
      'tweet_view', 'tweet_like', 'tweet_unlike', 'tweet_retweet', 'tweet_unretweet',
      'tweet_reply', 'tweet_share', 'tweet_bookmark', 'tweet_report',
      
      // Actions de navigation
      'profile_view', 'hashtag_click', 'mention_click', 'link_click', 'media_view',
      'search_query', 'search_clear', 'search_type_change', 'scroll_speed', 'time_spent',
      
      // Actions de scroll et interface
      'scroll_25', 'scroll_50', 'scroll_75', 'refresh', 'tab_change',
      'create_tweet_button', 'retry_after_error',
      
      // Actions sur contenu
      'content_skip', 'content_pause', 'content_replay', 'content_fullscreen',
      
      // Actions sociales
      'user_follow', 'user_unfollow', 'user_block', 'user_mute',
      
      // Préférences et paramètres
      'algorithm_change', 'theme_change', 'notification_setting', 'setting_change',
      
      // Actions de recherche avancées
      'search_completed', 'search_error',
      
      // Engagement temporel
      'session_start', 'session_end', 'app_background', 'app_foreground',
      
      // Nouvelles actions anti-bot (V5)
      'tap_gesture', 'device_motion_noise', 'system_stats_sync', 'keyboard_rhythm', 'scroll_jitter',
      
      // Actions génériques
      'screen_view', 'custom_action',

      // Emises par `trackCustomAction` cote mobile, et refusees par cet enum
      // jusqu'au 2026-08-18 : 145 ouvertures depuis la grille Explorer et 20
      // reponses au controle d'algorithme ont ete perdues avant l'ajout.
      // Ajouter une valeur ici ne suffit PAS : `sync` tourne en `alter:false`
      // et ne touche jamais un type existant, il faut un
      // `ALTER TYPE ... ADD VALUE` en base.
      'open_tweet', 'algo_check_answer'
    ),
    allowNull: false
  },
  
  // Objet de l'action (tweet_id, user_id, etc.)
  target_id: {
    type: DataTypes.STRING,
    allowNull: true
  },
  
  target_type: {
    type: DataTypes.ENUM(
      'tweet', 'user', 'hashtag', 'link', 'search', 'app', 'setting',
      'user_action', 'navigation', 'screen', 'interface', 'content'
    ),
    allowNull: true
  },
  
  // Contexte de l'action
  context_data: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Données contextuelles: position dans le feed, source, etc.'
  },
  
  // Métriques temporelles
  duration_ms: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Durée de l\'action en millisecondes'
  },
  
  timestamp: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },

  client_timestamp: {
    type: DataTypes.DATE(6),
    allowNull: true,
    comment: 'Timestamp haute précision fourni par le client (ms/µs)'
  },
  
  // Géolocalisation (si autorisée)
  location_data: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Données de localisation si autorisées'
  },
  
  // Informations sur l'appareil/session
  device_info: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Info appareil: OS, version app, réseau, etc.'
  },

  // Réseau (V6)
  ip_address: {
    type: DataTypes.STRING(45),
    allowNull: true,
    comment: 'Adresse IP du client (IPv4/IPv6)'
  },
  
  // Score de qualité de l'interaction
  interaction_quality: {
    type: DataTypes.DECIMAL(3, 2),
    allowNull: true,
    comment: 'Score de 0 à 1 représentant la qualité de l\'interaction'
  },
  
  // Métadonnées d'analyse
  processed: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Indique si cette donnée a été traitée par l\'algorithme'
  },
  
  is_data_test: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },

  data_test_batch_id: {
    type: DataTypes.STRING,
    allowNull: true
  },

  processing_date: {
    type: DataTypes.DATE,
    allowNull: true
  }
};

// Options du modèle
const modelOptions = {
  tableName: 'user_behavior_data',
  timestamps: true,
  indexes: [
    {
      fields: ['user_id', 'timestamp']
    },
    {
      fields: ['action_type', 'timestamp']
    },
    {
      fields: ['target_id', 'target_type']
    },
    {
      fields: ['processed', 'timestamp']
    }
  ]
};

// Fonction pour initialiser le modèle avec sequelize
function initUserBehaviorDataModel(sequelize) {
  UserBehaviorData.init(userBehaviorDataSchema, {
    ...modelOptions,
    sequelize
  });
}

// Associations
UserBehaviorData.associate = (models) => {
  UserBehaviorData.belongsTo(models.User, {
    foreignKey: 'user_id',
    as: 'user'
  });
};

module.exports = UserBehaviorData;
module.exports.initUserBehaviorDataModel = initUserBehaviorDataModel;
module.exports.userBehaviorDataSchema = userBehaviorDataSchema;
module.exports.modelOptions = modelOptions;
