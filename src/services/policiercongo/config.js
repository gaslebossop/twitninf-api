/**
 * 🚔 Configuration PolicierCongo
 * 
 * Configuration centralisée pour le service d'automatisation
 */

// Configuration du compte PolicierCongo
const POLICE_ACCOUNT_ID = 'a13a7745-448f-4faa-892a-f6ea140f2f5b';
const POLICE_USERNAME = 'policiercongo';

// Configuration des intervalles
const SCHEDULE_CONFIG = {
  mainInterval: 2 * 60 * 60 * 1000,        // 2h
  activeHours: { start: 9, end: 22 },       // 9h-22h (Heure FR)
  analysisInterval: 2 * 60 * 60 * 1000,     // 2h
  memoryUpdateInterval: 24 * 60 * 60 * 1000, // 24h
  schedulerFile: './scheduler.json'        // Fichier de planification IA
};

// Configuration des limites
const LIMITS = {
  maxActionsPerCycle: Infinity, // Illimité sur demande admin
  maxRepliesPerCycle: Infinity, // Illimité sur demande admin
  maxTweetLength: 600,
  maxReplyLength: 600,
  maxMemoryEntries: 60,
  maxActionsHistory: 10
};

// Configuration des priorités
const PRIORITIES = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0
};

// Configuration des types d'actions
const ACTION_TYPES = {
  POST_TWEET: 'POST_TWEET',
  UPDATE_PROFILE: 'UPDATE_PROFILE',
  DELETE_TWEET: 'DELETE_TWEET',
  RESPOND_TO_USER: 'RESPOND_TO_USER',
  NO_ACTION: 'NO_ACTION'
};

// Configuration des types de tweets
const TWEET_TYPES = {
  tweet: 'tweet',
  reply: 'reply',
  retweet: 'retweet',
  quote: 'quote'
};

// Configuration des types de réponses
const RESPONSE_TYPES = {
  salutation: 'salutation',
  conseil: 'conseil',
  encouragement: 'encouragement',
  actualite: 'actualite',
  humour: 'humour',
  professionnel: 'professionnel',
  ecoute: 'ecoute'
};

// Configuration des niveaux d'urgence
const URGENCY_LEVELS = {
  urgent: 'urgent',     // < 6h
  normal: 'normal',     // 6-24h
  old: 'old'           // > 24h
};

// Configuration des statuts de modération
const MODERATION_STATUS = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  flagged: 'flagged',
  not_eligible: 'not_eligible'
};

// Configuration des métadonnées par défaut
const DEFAULT_METADATA = {
  source: 'policiercongo_automation',
  version: '2.0.0',
  generated_at: null,
  action_type: 'single'
};

// Configuration des prompts Gemini
const GEMINI_PROMPTS = {
  analysis: {
    model: 'gemini-2.5-pro',
    maxTokens: 10000,
    temperature: 0.7
  },
  response: {
    model: 'gemini-2.5-flash',
    maxTokens: 5000,
    temperature: 0.8
  }
};

// Configuration des logs
const LOG_CONFIG = {
  level: 'info',
  enableConsole: true,
  enableFile: true,
  maxFileSize: '10m',
  maxFiles: 5
};

// Configuration des erreurs
const ERROR_CONFIG = {
  maxRetries: 3,
  retryDelay: 1000,
  fallbackAction: 'NO_ACTION',
  logErrors: true
};

// Configuration provider LLM
const LLM_CONFIG = {
  useMegaLLM: true,
  megaLLMSessionPath: './src/megallm-client/megallm-session.json'
};

module.exports = {
  // Configuration principale
  POLICE_ACCOUNT_ID,
  POLICE_USERNAME,
  
  // Configuration des intervalles
  SCHEDULE_CONFIG,
  
  // Configuration des limites
  LIMITS,
  
  // Configuration des priorités
  PRIORITIES,
  
  // Configuration des types
  ACTION_TYPES,
  TWEET_TYPES,
  RESPONSE_TYPES,
  URGENCY_LEVELS,
  MODERATION_STATUS,
  
  // Configuration des métadonnées
  DEFAULT_METADATA,
  
  // Configuration Gemini
  GEMINI_PROMPTS,
  
  // Configuration des logs
  LOG_CONFIG,
  
  // Configuration des erreurs
  ERROR_CONFIG,

  // Configuration provider LLM
  LLM_CONFIG
};
