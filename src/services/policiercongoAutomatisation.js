/**
 * 🔄 Fichier de Compatibilité - PolicierCongo Automatisation
 * 
 * Ce fichier maintient la compatibilité avec l'ancien système tout en utilisant
 * la nouvelle architecture modulaire en arrière-plan.
 * 
 * MÉTHODES EXPOSÉES (compatibilité avec l'ancien système) :
 * - runIntelligentAutomation()
 * - runOptimizedAutomation()
 * - geminiPhase1Planning()
 * - geminiPhase2Execution()
 * - getGeminiMemoryStatus()
 * - resetGeminiMemory()
 * - analyzeUserPreferences()
 * - generateAutonomousTweet()
 * - scheduleIntelligentTweets()
 * - updatePoliceProfile()
 * - runPoliceAutomation()
 * - postAutonomousTweet()
 * - geminiIntelligentAnalysis()
 * - executeGeminiDecision()
 * - detectCongoTweetsForResponse()
 * - analyzeTweetForResponse()
 * - generateContextualResponse()
 * - respondToCongoTweet()
 * - generateDefaultTweet()
 * - generateFallbackResponseContent()
 * - generateFallbackResponse()
 */

const logger = require('../utils/logger');

// Import du nouveau système modulaire
const { 
  policierCongoService,
  automationEngine,
  geminiIntelligence,
  memoryManager,
  dataCollector,
  tweetManager,
  replyManager
} = require('./policiercongo');

/**
 * 🚀 Exécute l'automatisation intelligente complète
 */
async function runIntelligentAutomation() {
  try {
    logger.info('🔄 Compatibilité: runIntelligentAutomation() -> nouveau système');
    return await policierCongoService.runIntelligentAutomation();
  } catch (error) {
    logger.error('❌ Erreur dans runIntelligentAutomation (compatibilité):', error);
    return { success: false, error: error.message };
  }
}

/**
 * ⚡ Exécute l'automatisation optimisée
 */
async function runOptimizedAutomation() {
  try {
    logger.info('🔄 Compatibilité: runOptimizedAutomation() -> nouveau système');
    return await policierCongoService.runOptimizedAutomation();
  } catch (error) {
    logger.error('❌ Erreur dans runOptimizedAutomation (compatibilité):', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🧠 Phase 1: Planification intelligente par Gemini
 */
async function geminiPhase1Planning() {
  try {
    logger.info('🔄 Compatibilité: geminiPhase1Planning() -> nouveau système');
    return await automationEngine.geminiPhase1Planning();
  } catch (error) {
    logger.error('❌ Erreur dans geminiPhase1Planning (compatibilité):', error);
    return null;
  }
}

/**
 * 🚀 Phase 2: Exécution du plan avec contexte futur
 */
async function geminiPhase2Execution(plan) {
  try {
    logger.info('🔄 Compatibilité: geminiPhase2Execution() -> nouveau système');
    return await automationEngine.geminiPhase2Execution(plan);
  } catch (error) {
    logger.error('❌ Erreur dans geminiPhase2Execution (compatibilité):', error);
    return { success: false, error: error.message };
  }
}

/**
 * 📊 Obtient le statut de la mémoire Gemini
 */
async function getGeminiMemoryStatus() {
  try {
    logger.info('🔄 Compatibilité: getGeminiMemoryStatus() -> nouveau système');
    return await memoryManager.getStatus();
  } catch (error) {
    logger.error('❌ Erreur dans getGeminiMemoryStatus (compatibilité):', error);
    return { error: error.message };
  }
}

/**
 * 🔄 Réinitialise la mémoire Gemini
 */
async function resetGeminiMemory() {
  try {
    logger.info('🔄 Compatibilité: resetGeminiMemory() -> nouveau système');
    return await memoryManager.reset();
      } catch (error) {
    logger.error('❌ Erreur dans resetGeminiMemory (compatibilité):', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🧠 Analyse des préférences utilisateur
 */
async function analyzeUserPreferences() {
  try {
    logger.info('🔄 Compatibilité: analyzeUserPreferences() -> nouveau système');
    return await geminiIntelligence.analyze();
  } catch (error) {
    logger.error('❌ Erreur dans analyzeUserPreferences (compatibilité):', error);
    return null;
  }
}

/**
 * 📝 Génère un tweet autonome
 */
async function generateAutonomousTweet() {
  try {
    logger.info('🔄 Compatibilité: generateAutonomousTweet() -> nouveau système');
    const analysis = await geminiIntelligence.analyze();
    if (analysis && analysis.action === 'POST_TWEET') {
      return await tweetManager.createTweet({
        content: analysis.details?.content || 'Tweet autonome généré ! 🚔',
        tweet_type: 'autonomous',
        metadata: { source: 'compatibility_layer' }
      });
    }
    return null;
  } catch (error) {
    logger.error('❌ Erreur dans generateAutonomousTweet (compatibilité):', error);
    return null;
  }
}

/**
 * 📅 Planifie des tweets intelligents
 */
async function scheduleIntelligentTweets() {
  try {
    logger.info('🔄 Compatibilité: scheduleIntelligentTweets() -> nouveau système');
    return await automationEngine.createFallbackPlan({});
        } catch (error) {
    logger.error('❌ Erreur dans scheduleIntelligentTweets (compatibilité):', error);
    return null;
  }
}

/**
 * 🔄 Met à jour le profil de police
 */
async function updatePoliceProfile() {
  try {
    logger.info('🔄 Compatibilité: updatePoliceProfile() -> nouveau système');
    // Cette fonction n'existe pas dans le nouveau système, retourner un statut
    return { success: true, message: 'Fonction de compatibilité - profil non modifié' };
  } catch (error) {
    logger.error('❌ Erreur dans updatePoliceProfile (compatibilité):', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🚔 Exécute l'automatisation de police
 */
async function runPoliceAutomation() {
  try {
    logger.info('🔄 Compatibilité: runPoliceAutomation() -> nouveau système');
    return await policierCongoService.runIntelligentAutomation();
  } catch (error) {
    logger.error('❌ Erreur dans runPoliceAutomation (compatibilité):', error);
    return { success: false, error: error.message };
  }
}

/**
 * 📝 Poste un tweet autonome
 */
async function postAutonomousTweet() {
  try {
    logger.info('🔄 Compatibilité: postAutonomousTweet() -> nouveau système');
    const tweet = await generateAutonomousTweet();
    if (tweet) {
      return { success: true, tweet_id: tweet.id, content: tweet.content };
    }
    return { success: false, error: 'Impossible de générer le tweet' };
  } catch (error) {
    logger.error('❌ Erreur dans postAutonomousTweet (compatibilité):', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🧠 Analyse intelligente Gemini
 */
async function geminiIntelligentAnalysis() {
  try {
    logger.info('🔄 Compatibilité: geminiIntelligentAnalysis() -> nouveau système');
    return await geminiIntelligence.analyze();
  } catch (error) {
    logger.error('❌ Erreur dans geminiIntelligentAnalysis (compatibilité):', error);
    return null;
  }
}

/**
 * ⚡ Exécute une décision Gemini
 */
async function executeGeminiDecision(analysis) {
  try {
    logger.info('🔄 Compatibilité: executeGeminiDecision() -> nouveau système');
    if (!analysis || !analysis.action) {
      return { success: false, error: 'Analyse invalide' };
    }
    
    const { actionExecutor } = require('./policiercongo');
    return await actionExecutor.execute(analysis);
  } catch (error) {
    logger.error('❌ Erreur dans executeGeminiDecision (compatibilité):', error);
    return { success: false, error: error.message };
  }
}

/**
 * 🔍 Détecte les tweets Congo pour réponse
 */
async function detectCongoTweetsForResponse() {
  try {
    logger.info('🔄 Compatibilité: detectCongoTweetsForResponse() -> nouveau système');
    return await dataCollector.detectUnrepliedCommentsFromDB();
  } catch (error) {
    logger.error('❌ Erreur dans detectCongoTweetsForResponse (compatibilité):', error);
    return [];
  }
}

/**
 * 🧠 Analyse un tweet pour réponse
 */
async function analyzeTweetForResponse(tweet) {
  try {
    logger.info('🔄 Compatibilité: analyzeTweetForResponse() -> nouveau système');
    // Simuler l'analyse pour la compatibilité
    return {
      action: 'RESPOND_TO_USER',
      reason: 'Réponse automatique pour engagement communautaire',
      priority: 'medium',
      target_user: tweet.author || 'utilisateur',
      details: { tweet_content: tweet.content }
    };
  } catch (error) {
    logger.error('❌ Erreur dans analyzeTweetForResponse (compatibilité):', error);
      return null;
  }
}

/**
 * 💬 Génère une réponse contextuelle
 */
async function generateContextualResponse(analysis, tweet, context) {
  try {
    logger.info('🔄 Compatibilité: generateContextualResponse() -> nouveau système');
    return await geminiIntelligence.generateResponseContent(analysis);
  } catch (error) {
    logger.error('❌ Erreur dans generateContextualResponse (compatibilité):', error);
    return 'Merci pour votre message ! 💪';
  }
}

/**
 * 💬 Répond à un tweet Congo
 */
async function respondToCongoTweet(tweetId, responseContent, metadata = {}) {
  try {
    logger.info('🔄 Compatibilité: respondToCongoTweet() -> nouveau système');
    return await replyManager.respondToTweet(tweetId, responseContent, metadata);
  } catch (error) {
    logger.error('❌ Erreur dans respondToCongoTweet (compatibilité):', error);
    return { success: false, error: error.message };
  }
}

/**
 * 📝 Génère un tweet par défaut
 */
function generateDefaultTweet() {
  try {
    logger.info('🔄 Compatibilité: generateDefaultTweet() -> nouveau système');
  const defaultTweets = [
      "Bonjour la communauté ! 👋 Restez vigilants ! 💪",
      "Conseil du jour : Verrouillez vos portes ! 🔒",
      "Salut ! 😄 Questions sur la sécurité ? 🚔",
    "En cas d'urgence : 112. Restez calmes ! 🚨",
    "Bonjour ! 🌟 Comment va votre journée ? 🤝"
  ];
  const randomIndex = Math.floor(Math.random() * defaultTweets.length);
  return defaultTweets[randomIndex];
  } catch (error) {
    logger.error('❌ Erreur dans generateDefaultTweet (compatibilité):', error);
    return "Bonjour ! 👋";
  }
}

/**
 * 💬 Génère une réponse de fallback
 */
function generateFallbackResponseContent(decision) {
  try {
    logger.info('🔄 Compatibilité: generateFallbackResponseContent() -> nouveau système');
    const reason = decision.reason || 'interaction communautaire';
    const priority = decision.priority || 'medium';
    
    if (priority === 'high') {
      return `Salut ! 🚨 ${reason.substring(0, 30)}... Je suis là ! 💪`;
    } else if (priority === 'medium') {
      return `Hey ! 😊 ${reason.substring(0, 30)}... Merci ! 🤝`;
    } else {
      return `Bonjour ! 👋 ${reason.substring(0, 30)}... Plaisir ! 🌟`;
    }
  } catch (error) {
    logger.error('❌ Erreur dans generateFallbackResponseContent (compatibilité):', error);
    return 'Merci ! 💪';
  }
}

/**
 * 💬 Génère une réponse de fallback (ancienne signature)
 */
function generateFallbackResponse(tweet, context) {
  try {
    logger.info('🔄 Compatibilité: generateFallbackResponse() -> nouveau système');
    return 'Merci pour votre message ! Je suis là pour vous aider ! 💪🚔';
  } catch (error) {
    logger.error('❌ Erreur dans generateFallbackResponse (compatibilité):', error);
    return 'Merci ! 💪';
  }
}

// Export de toutes les méthodes pour la compatibilité
module.exports = {
  // Méthodes principales
  runIntelligentAutomation,
  runOptimizedAutomation,
  geminiPhase1Planning,
  geminiPhase2Execution,
  
  // Gestion de la mémoire
  getGeminiMemoryStatus,
  resetGeminiMemory,
  
  // Analyse et génération
  analyzeUserPreferences,
  generateAutonomousTweet,
  scheduleIntelligentTweets,
  updatePoliceProfile,
  runPoliceAutomation,
  postAutonomousTweet,
  
  // Intelligence Gemini
  geminiIntelligentAnalysis,
  executeGeminiDecision,
  
  // Gestion des réponses
  detectCongoTweetsForResponse,
  analyzeTweetForResponse,
  generateContextualResponse,
  respondToCongoTweet,
  
  // Utilitaires
  generateDefaultTweet,
  generateFallbackResponseContent,
  generateFallbackResponse
};