/**
 * ⚙️ Configuration de la Mémoire PolicierCongo
 * 
 * Contrôle le comportement de sauvegarde et chargement
 */

module.exports = {
  // Auto-sauvegarde
  AUTO_SAVE: {
    // Désactiver en développement pour éviter les relances
    DEVELOPMENT: false,
    // Activer en production
    PRODUCTION: true,
    // Activer en test
    TEST: false
  },

  // Fréquence de sauvegarde (en millisecondes)
  SAVE_INTERVALS: {
    // Sauvegarde immédiate pour les actions importantes
    IMMEDIATE: ['tweet_created', 'user_responded', 'profile_updated'],
    // Sauvegarde différée pour les actions mineures
    DELAYED: 30000, // 30 secondes
    // Sauvegarde forcée au redémarrage
    ON_SHUTDOWN: true
  },

  // Fichiers de sauvegarde
  FILES: {
    // Fichier principal
    MEMORY: 'memory.json',
    // Fichier de backup
    BACKUP: 'memory.backup.json',
    // Fichier temporaire
    TEMP: 'memory.temp.json'
  },

  // Limites de taille
  LIMITS: {
    // Taille maximale du fichier JSON (en bytes)
    MAX_FILE_SIZE: 1024 * 1024, // 1MB
    // Nombre maximum d'entrées dans l'historique
    MAX_HISTORY_ENTRIES: 1000,
    // Nombre maximum d'actions récentes
    MAX_RECENT_ACTIONS: 100
  },

  // Gestion des erreurs
  ERROR_HANDLING: {
    // Continuer en cas d'erreur de sauvegarde
    CONTINUE_ON_SAVE_ERROR: true,
    // Continuer en cas d'erreur de chargement
    CONTINUE_ON_LOAD_ERROR: true,
    // Logger les erreurs de sauvegarde
    LOG_SAVE_ERRORS: true,
    // Logger les erreurs de chargement
    LOG_LOAD_ERRORS: true
  }
};
