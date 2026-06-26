const policiercongoAutomatisation = require('./src/services/policiercongoAutomatisation');
const logger = require('./src/utils/logger');

// Configuration de la planification
const SCHEDULE_CONFIG = {
  // Intervalle principal (toutes les 2 heures)
  mainInterval: 2 * 60 * 60 * 1000, // 2 heures en millisecondes
  
  // Heures d'activité (9h-21h)
  activeHours: {
    start: 9,
    end: 21
  },
  
  // Fréquence des analyses intelligentes
  analysisInterval: 4 * 60 * 60 * 1000, // 4 heures
  
  // Fréquence de mise à jour de la mémoire
  memoryUpdateInterval: 24 * 60 * 60 * 1000 // 24 heures
};

let isRunning = false;
let mainTimer = null;
let lastIntelligentAnalysis = null;
let lastMemoryUpdate = null;

/**
 * Vérifie si c'est le bon moment pour une analyse intelligente
 */
function shouldRunIntelligentAnalysis() {
  const now = new Date();
  const hour = now.getHours();
  
  // Vérifier les heures d'activité
  if (hour < SCHEDULE_CONFIG.activeHours.start || hour > SCHEDULE_CONFIG.activeHours.end) {
    logger.info('⏰ Hors des heures d\'activité, pas d\'analyse');
    return false;
  }
  
  // Vérifier l'intervalle depuis la dernière analyse
  if (lastIntelligentAnalysis) {
    const timeSinceLastAnalysis = now - lastIntelligentAnalysis;
    if (timeSinceLastAnalysis < SCHEDULE_CONFIG.analysisInterval) {
      logger.info('⏳ Trop tôt pour une nouvelle analyse intelligente');
      return false;
    }
  }
  
  return true;
}

/**
 * Vérifie si c'est le bon moment pour mettre à jour la mémoire
 */
function shouldUpdateMemory() {
  if (!lastMemoryUpdate) {
    return true; // Première fois
  }
  
  const now = new Date();
  const timeSinceLastUpdate = now - lastMemoryUpdate;
  
  return timeSinceLastUpdate >= SCHEDULE_CONFIG.memoryUpdateInterval;
}

/**
 * Exécute une itération d'automatisation intelligente
 */
async function runIntelligentAutomationIteration() {
  if (isRunning) {
    logger.info('⏳ Automatisation intelligente déjà en cours, attente...');
    return;
  }
  
  isRunning = true;
  logger.info('🚀 Démarrage d\'une itération d\'automatisation intelligente...');
  
  try {
    // 1. Vérifier si on doit faire une analyse intelligente
    if (shouldRunIntelligentAnalysis()) {
      logger.info('🧠 Lancement de l\'analyse intelligente Gemini...');
      
      // NOUVEAU : Utiliser l'architecture optimisée en 2 phases
      const result = await policiercongoAutomatisation.runOptimizedAutomation();
      
      if (result && result.success) {
        lastIntelligentAnalysis = new Date();
        logger.info('✅ Analyse intelligente optimisée terminée avec succès');
        logger.info(`📊 Résumé: ${result.summary}`);
        
        if (result.total_actions) {
          logger.info(`📈 Statistiques: ${result.successful_actions}/${result.total_actions} actions réussies`);
        }
      } else {
        logger.warn('⚠️ Analyse intelligente optimisée échouée');
        if (result && result.error) {
          logger.warn(`❌ Erreur: ${result.error}`);
        }
      }
    } else {
      logger.info('⏰ Conditions non remplies pour l\'analyse intelligente');
    }
    
    // 2. Vérifier si on doit mettre à jour la mémoire
    if (shouldUpdateMemory()) {
      logger.info('🧠 Mise à jour de la mémoire Gemini...');
      
      // Collecter des données supplémentaires pour enrichir la mémoire
      const memoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
      logger.info('📊 Statut de la mémoire:', memoryStatus);
      
      lastMemoryUpdate = new Date();
      logger.info('✅ Mémoire mise à jour');
    }
    
  } catch (error) {
    logger.error('❌ Erreur lors de l\'itération d\'automatisation intelligente:', error);
  } finally {
    isRunning = false;
    logger.info('✅ Itération d\'automatisation intelligente terminée');
  }
}

/**
 * Démarre le planificateur intelligent
 */
function startScheduler() {
  if (mainTimer) {
    logger.warn('⚠️ Le planificateur intelligent est déjà démarré');
    return;
  }
  
  logger.info('🚀 Démarrage du planificateur intelligent PolicierCongo...');
  logger.info(`📅 Configuration:`);
  logger.info(`   - Intervalle principal: ${SCHEDULE_CONFIG.mainInterval / (60 * 60 * 1000)}h`);
  logger.info(`   - Heures d'activité: ${SCHEDULE_CONFIG.activeHours.start}h-${SCHEDULE_CONFIG.activeHours.end}h`);
  logger.info(`   - Intervalle d'analyse: ${SCHEDULE_CONFIG.analysisInterval / (60 * 60 * 1000)}h`);
  logger.info(`   - Mise à jour mémoire: ${SCHEDULE_CONFIG.memoryUpdateInterval / (24 * 60 * 60 * 1000)} jours`);
  
  // Exécuter immédiatement la première itération
  setImmediate(runIntelligentAutomationIteration);
  
  // Planifier les itérations suivantes
  mainTimer = setInterval(runIntelligentAutomationIteration, SCHEDULE_CONFIG.mainInterval);
  
  logger.info('✅ Planificateur intelligent démarré avec succès');
}

/**
 * Arrête le planificateur intelligent
 */
function stopScheduler() {
  if (!mainTimer) {
    logger.warn('⚠️ Le planificateur intelligent n\'est pas démarré');
    return;
  }
  
  logger.info('🛑 Arrêt du planificateur intelligent PolicierCongo...');
  
  clearInterval(mainTimer);
  mainTimer = null;
  isRunning = false;
  
  logger.info('✅ Planificateur intelligent arrêté');
}

/**
 * Obtient le statut du planificateur intelligent
 */
function getSchedulerStatus() {
  return {
    isRunning: !!mainTimer,
    isProcessing: isRunning,
    lastIntelligentAnalysis: lastIntelligentAnalysis,
    lastMemoryUpdate: lastMemoryUpdate,
    nextCheck: mainTimer ? new Date(Date.now() + SCHEDULE_CONFIG.mainInterval) : null,
    config: SCHEDULE_CONFIG,
    geminiMemory: policiercongoAutomatisation.getGeminiMemoryStatus()
  };
}

/**
 * Force l'exécution d'une itération
 */
async function forceRun() {
  logger.info('⚡ Exécution forcée de l\'automatisation intelligente...');
  await runIntelligentAutomationIteration();
}

/**
 * Affiche le statut de la mémoire Gemini
 */
function showGeminiMemory() {
  const memoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
  console.log('🧠 Statut de la mémoire Gemini:');
  console.log(JSON.stringify(memoryStatus, null, 2));
}

/**
 * Réinitialise la mémoire Gemini
 */
function resetGeminiMemory() {
  logger.info('🔄 Réinitialisation de la mémoire Gemini...');
  policiercongoAutomatisation.resetGeminiMemory();
  console.log('✅ Mémoire Gemini réinitialisée');
}

/**
 * Gestion des signaux d'arrêt
 */
process.on('SIGINT', () => {
  logger.info('🛑 Signal SIGINT reçu, arrêt du planificateur intelligent...');
  stopScheduler();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('🛑 Signal SIGTERM reçu, arrêt du planificateur intelligent...');
  stopScheduler();
  process.exit(0);
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  logger.error('💥 Erreur non capturée:', error);
  stopScheduler();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Promesse rejetée non gérée:', reason);
  stopScheduler();
  process.exit(1);
});

// Interface de ligne de commande
if (require.main === module) {
  const command = process.argv[2];
  
  switch (command) {
    case 'start':
      startScheduler();
      break;
      
    case 'stop':
      stopScheduler();
      break;
      
    case 'status':
      console.log('📊 Statut du planificateur intelligent:', JSON.stringify(getSchedulerStatus(), null, 2));
      break;
      
    case 'run':
      forceRun().then(() => {
        console.log('✅ Exécution forcée terminée');
        process.exit(0);
      }).catch(error => {
        console.error('❌ Erreur lors de l\'exécution forcée:', error);
        process.exit(1);
      });
      break;
      
    case 'memory':
      showGeminiMemory();
      break;
      
    case 'reset-memory':
      resetGeminiMemory();
      break;
      
    case 'test':
      console.log('🧪 Mode test - démarrage et arrêt automatique après 1 minute...');
      startScheduler();
      setTimeout(() => {
        console.log('⏰ Test terminé, arrêt du planificateur...');
        stopScheduler();
        process.exit(0);
      }, 60000);
      break;
      
    default:
      console.log('🚔 Planificateur Intelligent PolicierCongo (Powered by Gemini)');
      console.log('');
      console.log('Usage:');
      console.log('  node policiercongo-scheduler.js start        - Démarrer le planificateur intelligent');
      console.log('  node policiercongo-scheduler.js stop         - Arrêter le planificateur intelligent');
      console.log('  node policiercongo-scheduler.js status       - Voir le statut complet');
      console.log('  node policiercongo-scheduler.js run          - Exécuter une itération');
      console.log('  node policiercongo-scheduler.js memory       - Voir la mémoire Gemini');
      console.log('  node policiercongo-scheduler.js reset-memory - Réinitialiser la mémoire');
      console.log('  node policiercongo-scheduler.js test         - Mode test (1 minute)');
      console.log('');
      console.log('Exemple:');
      console.log('  node policiercongo-scheduler.js start');
      console.log('');
      console.log('🎯 Ce planificateur utilise Gemini IA pour toutes les décisions !');
      break;
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  getSchedulerStatus,
  forceRun,
  runIntelligentAutomationIteration
};
