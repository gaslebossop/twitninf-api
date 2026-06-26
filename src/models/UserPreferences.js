/**
 * ⚙️ Modèle des Préférences Utilisateur Avancées
 * 
 * Stocke les préférences détaillées pour personnaliser l'algorithme
 */

const { DataTypes, Model } = require('sequelize');

class UserPreferences extends Model {}

// Schema de la table
const userPreferencesSchema = {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  
  // Préférences de contenu
  content_preferences: {
    type: DataTypes.JSON,
    defaultValue: {
      preferred_topics: [],          // Sujets préférés
      blocked_topics: [],            // Sujets bloqués
      preferred_languages: ['fr'],   // Langues préférées
      content_length_preference: 'mixed', // short, long, mixed
      media_preference: 'mixed'      // text, images, videos, mixed
    }
  },
  
  // Préférences d'engagement
  engagement_preferences: {
    type: DataTypes.JSON,
    defaultValue: {
      show_trending: true,           // Afficher les tendances
      show_new_content: true,        // Privilégier le nouveau contenu
      discovery_mode: 'balanced',    // conservative, balanced, adventurous
      interaction_weight: 'balanced' // prioritize_likes, prioritize_retweets, balanced
    }
  },
  
  // Préférences temporelles
  temporal_preferences: {
    type: DataTypes.JSON,
    defaultValue: {
      active_hours: [9, 18],         // Heures d'activité préférées
      timezone: 'Europe/Paris',      // Fuseau horaire
      content_freshness: 'mixed',    // recent, mixed, evergreen
      notification_frequency: 'normal' // low, normal, high
    }
  },
  
  // Préférences sociales
  social_preferences: {
    type: DataTypes.JSON,
    defaultValue: {
      follow_suggestions: true,      // Suggestions de suivi
      show_follower_activity: true,  // Activité des abonnés
      privacy_level: 'normal',       // private, normal, public
      interaction_visibility: 'friends' // none, friends, public
    }
  },
  
  // Préférences d'algorithme
  algorithm_preferences: {
    type: DataTypes.JSON,
    defaultValue: {
      preferred_algorithm: 'smart',  // Algorithme préféré
      customization_level: 'auto',  // manual, auto, hybrid
      feedback_weight: 1.0,          // Poids du feedback utilisateur
      exploration_rate: 0.3          // Taux d'exploration vs exploitation
    }
  },
  
  // Données d'apprentissage
  learning_data: {
    type: DataTypes.JSON,
    defaultValue: {
      explicit_feedback: {},        // Feedback explicite utilisateur
      implicit_patterns: {},        // Patterns implicites détectés
      preference_confidence: 0.5,   // Confiance dans les préférences
      last_preference_update: null  // Dernière mise à jour des préférences
    }
  },
  
  // Métriques de personnalisation
  personalization_score: {
    type: DataTypes.DECIMAL(3, 2),
    defaultValue: 0.5,
    comment: 'Score de personnalisation de 0 à 1'
  },
  
  // Consentement et confidentialité
  privacy_settings: {
    type: DataTypes.JSON,
    defaultValue: {
      data_collection_consent: true,     // Consentement collecte données
      analytics_consent: true,           // Consentement analytics
      personalization_consent: true,     // Consentement personnalisation
      third_party_sharing: false,        // Partage avec tiers
      data_retention_days: 365          // Durée conservation données
    }
  }
};

// Options du modèle
const modelOptions = {
  tableName: 'user_preferences',
  timestamps: true,
  indexes: [
    {
      fields: ['user_id']
    },
    {
      fields: ['personalization_score']
    }
  ]
};

// Fonction pour initialiser le modèle avec sequelize
function initUserPreferencesModel(sequelize) {
  UserPreferences.init(userPreferencesSchema, {
    ...modelOptions,
    sequelize
  });
}

// Associations
UserPreferences.associate = (models) => {
  UserPreferences.belongsTo(models.User, {
    foreignKey: 'user_id',
    as: 'user'
  });
};

module.exports = UserPreferences;
module.exports.initUserPreferencesModel = initUserPreferencesModel;
module.exports.userPreferencesSchema = userPreferencesSchema;
module.exports.modelOptions = modelOptions;
