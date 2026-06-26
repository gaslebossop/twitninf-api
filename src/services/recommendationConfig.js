/**
 * ⚙️ Configuration Avancée du Moteur de Recommandation
 * 
 * Fichier de configuration centralisé pour tous les paramètres
 * de l'algorithme de recommandation ultra-avancé.
 * 
 * @author TwitNin Team
 * @version 1.0.0
 * @license MIT
 */

module.exports = {
  // Configuration des algorithmes
  algorithms: {
    ultra_hybrid: {
      name: 'Ultra-Hybrid Multi-Dimensionnel',
      description: 'Combinaison intelligente de tous les algorithmes avec pondération dynamique',
      weights: {
        behavioral: 0.25,
        social: 0.25,
        content: 0.20,
        trending: 0.15,
        discovery: 0.15
      }
    },
    behavioral_ai: {
      name: 'Intelligence Comportementale',
      description: 'Analyse approfondie du comportement utilisateur et des patterns',
      weights: {
        engagement_history: 0.35,
        content_preferences: 0.25,
        time_patterns: 0.20,
        social_behavior: 0.20
      }
    },
    trending_boost: {
      name: 'Boost Tendances',
      description: 'Mise en avant des contenus tendance avec analyse virale',
      weights: {
        viral_growth: 0.40,
        engagement_velocity: 0.30,
        topic_popularity: 0.20,
        author_momentum: 0.10
      }
    },
    social_graph: {
      name: 'Graphe Social Avancé',
      description: 'Analyse des relations sociales et de l\'influence',
      weights: {
        direct_connections: 0.30,
        influence_paths: 0.25,
        community_clusters: 0.25,
        social_signals: 0.20
      }
    },
    content_intelligence: {
      name: 'Intelligence du Contenu',
      description: 'Analyse sémantique et qualitative du contenu',
      weights: {
        semantic_relevance: 0.35,
        content_quality: 0.25,
        media_analysis: 0.20,
        topic_classification: 0.20
      }
    }
  },

  // Configuration des scores et pondérations
  scoring: {
    // Scores d'engagement
    engagement: {
      like: { weight: 15, maxScore: 100 },
      comment: { weight: 25, maxScore: 100 },
      retweet: { weight: 20, maxScore: 100 },
      view: { weight: 2, maxScore: 100 },
      share: { weight: 30, maxScore: 100 },
      bookmark: { weight: 18, maxScore: 100 }
    },

    // Scores de qualité du contenu
    contentQuality: {
      media_presence: { weight: 10, maxScore: 100 },
      hashtag_relevance: { weight: 12, maxScore: 100 },
      mention_engagement: { weight: 8, maxScore: 100 },
      url_quality: { weight: 5, maxScore: 100 },
      content_length: { weight: 8, maxScore: 100 },
      readability: { weight: 10, maxScore: 100 }
    },

    // Scores d'influence de l'auteur
    authorInfluence: {
      followers: { weight: 20, maxScore: 100 },
      verification: { weight: 15, maxScore: 100 },
      premium: { weight: 10, maxScore: 100 },
      role: { weight: 25, maxScore: 100 },
      activity: { weight: 20, maxScore: 100 },
      reputation: { weight: 15, maxScore: 100 }
    },

    // Scores de pertinence utilisateur
    userRelevance: {
      following: { weight: 40, maxScore: 100 },
      past_interactions: { weight: 35, maxScore: 100 },
      hashtag_similarity: { weight: 20, maxScore: 100 },
      mention_similarity: { weight: 15, maxScore: 100 },
      content_affinity: { weight: 25, maxScore: 100 }
    },

    // Scores temporels
    temporal: {
      recency: { weight: 25, maxScore: 100 },
      time_of_day: { weight: 10, maxScore: 100 },
      day_of_week: { weight: 8, maxScore: 100 },
      trending_momentum: { weight: 35, maxScore: 100 },
      seasonal_relevance: { weight: 12, maxScore: 100 }
    },

    // Scores de diversité
    diversity: {
      author_diversity: { weight: 15, maxScore: 100 },
      content_diversity: { weight: 20, maxScore: 100 },
      topic_diversity: { weight: 18, maxScore: 100 },
      format_diversity: { weight: 12, maxScore: 100 },
      perspective_diversity: { weight: 10, maxScore: 100 }
    },

    // Scores de modération
    moderation: {
      approval_status: { weight: 50, maxScore: 100 },
      report_ratio: { weight: -30, maxScore: 100 },
      spam_score: { weight: -40, maxScore: 100 },
      content_maturity: { weight: 15, maxScore: 100 },
      community_guidelines: { weight: 25, maxScore: 100 }
    }
  },

  // Configuration des seuils et limites
  thresholds: {
    // Seuils de base
    minScore: 0.05,
    maxScore: 100,
    minEngagement: 0.005,
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 an (au lieu de 14 jours)
    // Option pour récupérer TOUS les tweets (depuis toujours)
    retrieveAllTweets: true, // Désactive la limite de temps
    
    // Seuils de qualité
    qualityThreshold: 0.3,
    contentQualityThreshold: 0.4,
    authorQualityThreshold: 0.5,
    
    // Seuils de diversité
    diversityFactor: 0.4,
    authorDiversityLimit: 3, // Max tweets par auteur
    topicDiversityLimit: 5, // Max tweets par topic
    
    // Seuils de tendance
    trendingThreshold: 0.6,
    viralThreshold: 0.8,
    momentumThreshold: 0.7
  },

  // Configuration du cache
  cache: {
    // Cache principal
    main: {
      expiry: 3 * 60 * 1000, // 3 minutes
      maxSize: 1000,
      cleanupInterval: 10 * 60 * 1000 // 10 minutes
    },

    // Couches de cache spécialisées
    layers: {
      userPreferences: {
        expiry: 15 * 60 * 1000, // 15 minutes
        maxSize: 500
      },
      trendingTopics: {
        expiry: 5 * 60 * 1000, // 5 minutes
        maxSize: 200
      },
      authorScores: {
        expiry: 30 * 60 * 1000, // 30 minutes
        maxSize: 300
      },
      contentScores: {
        expiry: 10 * 60 * 1000, // 10 minutes
        maxSize: 400
      }
    }
  },

  // Configuration des métriques et monitoring
  metrics: {
    // Intervalles de collecte
    collectionIntervals: {
      performance: 60 * 1000, // 1 minute
      userSatisfaction: 5 * 60 * 1000, // 5 minutes
      algorithmPerformance: 10 * 60 * 1000, // 10 minutes
      cacheEfficiency: 2 * 60 * 1000 // 2 minutes
    },

    // Seuils d'alerte
    alerts: {
      responseTime: 2000, // 2 secondes
      cacheHitRate: 0.7, // 70%
      userSatisfaction: 0.6, // 60%
      errorRate: 0.05 // 5%
    }
  },

  // Configuration des filtres avancés
  filters: {
    // Filtres de contenu
    content: {
      minLength: 10,
      maxLength: 600,
      requiredHashtags: false,
      maxHashtags: 10,
      maxMentions: 5,
      maxUrls: 4,
      maxMedia: 4
    },

    // Filtres de modération
    moderation: {
      requireApproval: true,
      autoFlagKeywords: true,
      spamDetection: true,
      contentMaturity: true,
      communityGuidelines: true
    },

    // Filtres de diversité
    diversity: {
      authorRotation: true,
      topicRotation: true,
      formatRotation: true,
      perspectiveRotation: true,
      discoveryBoost: true
    }
  },

  // Configuration des algorithmes de découverte
  discovery: {
    // Nouveaux utilisateurs
    newUsers: {
      boostFactor: 1.5,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 jours
      engagementThreshold: 0.01
    },

    // Nouveaux contenus
    newContent: {
      boostFactor: 1.3,
      maxAge: 24 * 60 * 60 * 1000, // 24 heures
      qualityThreshold: 0.4
    },

    // Contenus sous-représentés
    underrepresented: {
      boostFactor: 1.4,
      minEngagement: 0.001,
      maxFollowers: 1000
    }
  },

  // Configuration des optimisations de performance
  performance: {
    // Parallélisation
    parallelization: {
      maxConcurrentQueries: 10,
      batchSize: 50,
      timeout: 5000 // 5 secondes
    },

    // Index et requêtes
    database: {
      useIndexes: true,
      optimizeQueries: true,
      connectionPool: 20,
      queryTimeout: 3000 // 3 secondes
    },

    // Cache et mémoire
    memory: {
      maxHeapSize: '512MB',
      gcOptimization: true,
      memoryLeakDetection: true
    }
  },

  // Configuration des tests A/B
  abTesting: {
    enabled: true,
    variants: {
      control: {
        name: 'Contrôle',
        weight: 0.2,
        algorithm: 'ultra_hybrid'
      },
      variant_a: {
        name: 'Variante A - Comportemental',
        weight: 0.3,
        algorithm: 'behavioral_ai'
      },
      variant_b: {
        name: 'Variante B - Social',
        weight: 0.3,
        algorithm: 'social_graph'
      },
      variant_c: {
        name: 'Variante C - Contenu',
        weight: 0.2,
        algorithm: 'content_intelligence'
      }
    },
    metrics: ['engagement_rate', 'click_through_rate', 'user_satisfaction', 'retention']
  }
};
