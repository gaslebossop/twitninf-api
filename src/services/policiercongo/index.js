/**
 * 🚔 PolicierCongo - Service Principal d'Automatisation
 * 
 * Ce module centralise tous les services d'automatisation intelligente
 * pour le compte PolicierCongo sur les réseaux sociaux.
 */

// Services principaux
const AutomationEngine = require('./automationEngine');
const GeminiIntelligence = require('./geminiIntelligence');
const ReplyManager = require('./replyManager');
const TweetManager = require('./tweetManager');
const MemoryManager = require('./memoryManager');
const DataCollector = require('./dataCollector');
const ActionExecutor = require('./actionExecutor');
const ConceptManager = require('./ConceptManager');
const policiercongoV2Bridge = require('./policiercongoV2Bridge');

// Configuration
const { POLICE_ACCOUNT_ID, POLICE_USERNAME } = require('./config');

// Instance principale du service
class PolicierCongoService {
  constructor() {
    this.automationEngine = new AutomationEngine();
    this.geminiIntelligence = new GeminiIntelligence();
    this.replyManager = new ReplyManager();
    this.tweetManager = new TweetManager();
    this.memoryManager = new MemoryManager();
    this.conceptManager = new ConceptManager(this.memoryManager);
    this.dataCollector = new DataCollector();
    this.actionExecutor = new ActionExecutor();
    
    // Initialiser les services
    this.initialize();
  }

  async initialize() {
    try {
      await this.memoryManager.initialize();
      await this.dataCollector.initialize();
      await this.tweetManager.initialize();
      
      // Enregistrer les hooks de fermeture pour sauvegarder la mémoire
      this._setupGracefulShutdown();
      
      console.log('🚔 PolicierCongo Service initialisé avec succès');
    } catch (error) {
      console.error('❌ Erreur lors de l\'initialisation de PolicierCongo:', error);
    }
  }

  /**
   * Configure les hooks pour sauvegarder la mémoire à l'arrêt du serveur
   */
  _setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n🛑 Signal ${signal} reçu. Sauvegarde de la mémoire de PolicierCongo...`);
      try {
        await this.memoryManager.forceSave();
        console.log('💾 Mémoire sauvegardée avec succès avant l\'arrêt.');
      } catch (error) {
        console.error('❌ Erreur lors de la sauvegarde finale de la mémoire:', error);
      }
    };

    // Écouter les signaux d'arrêt
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Également sur beforeExit si possible
    process.on('beforeExit', () => shutdown('beforeExit'));
  }


  // Méthodes principales
  async runIntelligentAutomation() {
    return await this.automationEngine.run();
  }

  async runOptimizedAutomation() {
    return await this.automationEngine.runOptimized();
  }

  async geminiIntelligentAnalysis() {
    return await this.geminiIntelligence.analyze();
  }

  async executeGeminiDecision(decision) {
    return await this.actionExecutor.execute(decision);
  }

  async respondToCongoTweet(tweetId, context = {}) {
    return await this.replyManager.respondToTweet(tweetId, context);
  }

  async detectCongoTweetsForResponse() {
    return await this.replyManager.detectTweetsForResponse();
  }

  // Gestion de la mémoire
  getGeminiMemoryStatus() {
    return this.memoryManager.getStatus();
  }

  resetGeminiMemory() {
    return this.memoryManager.reset();
  }

  updateGeminiMemory(newData) {
    return this.memoryManager.update(newData);
  }

  getConceptStatus() {
    return this.conceptManager.getNextConcepts(20);
  }

  // Utilitaires
  async forceAppropriateAction(collectedData, geminiMemory) {
    return await this.automationEngine.forceAppropriateAction(collectedData, geminiMemory);
  }

  async detectUnrepliedComments() {
    return await this.dataCollector.detectUnrepliedComments();
  }

  async detectUnrepliedCommentsFromDB() {
    return await this.dataCollector.detectUnrepliedCommentsFromDB();
  }
}

// Instance singleton
const policierCongoService = new PolicierCongoService();

// Exports
module.exports = {
  // Instance principale
  policierCongoService,
  
  // Modules individuels (pour accès direct)
  automationEngine: policierCongoService.automationEngine,
  geminiIntelligence: policierCongoService.geminiIntelligence,
  replyManager: policierCongoService.replyManager,
  tweetManager: policierCongoService.tweetManager,
  memoryManager: policierCongoService.memoryManager,
  conceptManager: policierCongoService.conceptManager,
  dataCollector: policierCongoService.dataCollector,
  actionExecutor: policierCongoService.actionExecutor,
  policiercongoV2Bridge,
  
  // Méthodes principales (pour compatibilité)
  runIntelligentAutomation: () => policierCongoService.runIntelligentAutomation(),
  runOptimizedAutomation: () => policierCongoService.runOptimizedAutomation(),
  geminiIntelligentAnalysis: () => policierCongoService.geminiIntelligentAnalysis(),
  executeGeminiDecision: (decision) => policierCongoService.executeGeminiDecision(decision),
  respondToCongoTweet: (tweetId, context) => policierCongoService.respondToCongoTweet(tweetId, context),
  detectCongoTweetsForResponse: () => policierCongoService.detectCongoTweetsForResponse(),
  
  // Gestion de la mémoire
  getGeminiMemoryStatus: () => policierCongoService.getGeminiMemoryStatus(),
  resetGeminiMemory: () => policierCongoService.resetGeminiMemory(),
  updateGeminiMemory: (newData) => policierCongoService.updateGeminiMemory(newData),
  getConceptStatus: () => policierCongoService.getConceptStatus(),
  
  // Utilitaires
  forceAppropriateAction: (collectedData, geminiMemory) => policierCongoService.forceAppropriateAction(collectedData, geminiMemory),
  detectUnrepliedComments: () => policierCongoService.detectUnrepliedComments(),
  detectUnrepliedCommentsFromDB: () => policierCongoService.detectUnrepliedCommentsFromDB(),
  
  // Configuration
  POLICE_ACCOUNT_ID,
  POLICE_USERNAME
};
