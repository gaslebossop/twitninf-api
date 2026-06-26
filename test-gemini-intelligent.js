const policiercongoAutomatisation = require('./src/services/policiercongoAutomatisation');
const logger = require('./src/utils/logger');

async function testGeminiIntelligentSystem() {
  console.log('🧠 Test du système intelligent PolicierCongo (Powered by Gemini)\n');
  
  try {
    // Test 1: Statut de la mémoire Gemini
    console.log('🔍 Test 1: Statut de la mémoire Gemini...');
    const memoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
    console.log('✅ Mémoire Gemini:');
    console.log(`   - Taille: ${JSON.stringify(memoryStatus.memorySize)}`);
    console.log(`   - Dernière mise à jour: ${memoryStatus.lastUpdated}`);
    console.log(`   - Humeur communauté: ${memoryStatus.communityMood}`);
    console.log(`   - Priorités: ${memoryStatus.priorities.join(', ') || 'Aucune'}`);
    
    console.log('\n' + '='.repeat(60) + '\n');
    
    // Test 2: Analyse intelligente Gemini
    console.log('🤖 Test 2: Analyse intelligente Gemini...');
    console.log('⚠️  Ce test va réellement analyser et prendre des décisions. Continuer ? (Ctrl+C pour arrêter)');
    
    // Attendre 3 secondes pour permettre l'arrêt
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const analysis = await policiercongoAutomatisation.geminiIntelligentAnalysis();
    
    if (analysis) {
      console.log('✅ Analyse Gemini réussie:');
      console.log(`   - Action: ${analysis.action}`);
      console.log(`   - Raison: ${analysis.reason}`);
      console.log(`   - Priorité: ${analysis.priority}`);
      
      if (analysis.details) {
        console.log('   - Détails:', JSON.stringify(analysis.details, null, 2));
      }
      
      if (analysis.memory_update) {
        console.log('   - Mise à jour mémoire:', Object.keys(analysis.memory_update));
      }
    } else {
      console.log('❌ Analyse Gemini échouée');
    }
    
    console.log('\n' + '='.repeat(60) + '\n');
    
    // Test 3: Exécution de la décision (si une action est décidée)
    if (analysis && analysis.action !== 'NO_ACTION') {
      console.log('🚀 Test 3: Exécution de la décision Gemini...');
      console.log(`⚠️  Exécution de l'action: ${analysis.action}`);
      
      // Attendre 2 secondes
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const result = await policiercongoAutomatisation.executeGeminiDecision(analysis);
      
      if (result && result.success) {
        console.log('✅ Action exécutée avec succès:');
        console.log(`   - Action: ${result.action}`);
        
        switch (result.action) {
          case 'POST_TWEET':
            console.log(`   - Tweet ID: ${result.tweet_id}`);
            console.log(`   - Contenu: "${result.content}"`);
            break;
            
          case 'UPDATE_PROFILE':
            console.log(`   - Nouveau username: ${result.username}`);
            console.log(`   - Nouvelle bio: ${result.bio}`);
            break;
            
          case 'DELETE_TWEET':
            console.log(`   - Tweet supprimé: ${result.deleted_tweet_id}`);
            break;
            
          case 'RESPOND_TO_USER':
            console.log(`   - Réponse créée: ${result.response_tweet_id}`);
            console.log(`   - Utilisateur cible: @${result.target_user}`);
            break;
        }
      } else {
        console.log('❌ Échec de l\'exécution:', result?.error || 'Erreur inconnue');
      }
    } else {
      console.log('⏰ Test 3: Aucune action à exécuter (NO_ACTION)');
    }
    
    console.log('\n' + '='.repeat(60) + '\n');
    
    // Test 4: Automatisation complète
    console.log('🎯 Test 4: Automatisation intelligente complète...');
    console.log('⚠️  Ce test va exécuter le cycle complet. Continuer ? (Ctrl+C pour arrêter)');
    
    // Attendre 3 secondes
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const automationResult = await policiercongoAutomatisation.runIntelligentAutomation();
    
    if (automationResult) {
      console.log('✅ Automatisation intelligente terminée avec succès');
    } else {
      console.log('❌ Automatisation intelligente échouée');
    }
    
    console.log('\n' + '='.repeat(60) + '\n');
    
    // Test 5: Nouveau statut de la mémoire
    console.log('🧠 Test 5: Nouveau statut de la mémoire après exécution...');
    const newMemoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
    
    console.log('✅ Nouvelle mémoire Gemini:');
    console.log(`   - Taille: ${JSON.stringify(newMemoryStatus.memorySize)}`);
    console.log(`   - Dernière mise à jour: ${newMemoryStatus.lastUpdated}`);
    
    if (newMemoryStatus.lastAnalysis) {
      console.log('   - Dernière analyse:');
      console.log(`     * Action: ${newMemoryStatus.lastAnalysis.decision.action}`);
      console.log(`     * Raison: ${newMemoryStatus.lastAnalysis.decision.reason}`);
      console.log(`     * Résultat: ${newMemoryStatus.lastAnalysis.result.success ? 'Succès' : 'Échec'}`);
    }
    
  } catch (error) {
    console.error('❌ Erreur lors des tests:', error);
    logger.error('Erreur lors des tests du système intelligent:', error);
  }
  
  console.log('\n🎯 Tests du système intelligent terminés !');
}

// Fonction pour tester une fonction spécifique
async function testSpecificFunction(functionName) {
  console.log(`🧪 Test de la fonction: ${functionName}\n`);
  
  try {
    switch (functionName) {
      case 'memory':
        const memoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
        console.log('Résultat:', JSON.stringify(memoryStatus, null, 2));
        break;
        
      case 'analysis':
        const analysis = await policiercongoAutomatisation.geminiIntelligentAnalysis();
        console.log('Résultat:', JSON.stringify(analysis, null, 2));
        break;
        
      case 'automation':
        const result = await policiercongoAutomatisation.runIntelligentAutomation();
        console.log('Résultat:', result);
        break;
        
      case 'reset':
        policiercongoAutomatisation.resetGeminiMemory();
        console.log('✅ Mémoire réinitialisée');
        break;
        
      default:
        console.log('❌ Fonction inconnue. Fonctions disponibles:');
        console.log('   - memory : Voir le statut de la mémoire');
        console.log('   - analysis : Lancer l\'analyse Gemini');
        console.log('   - automation : Lancer l\'automatisation complète');
        console.log('   - reset : Réinitialiser la mémoire');
    }
  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

// Gestion des arguments de ligne de commande
const args = process.argv.slice(2);

if (args.length > 0) {
  const functionName = args[0];
  testSpecificFunction(functionName);
} else {
  // Test complet par défaut
  testGeminiIntelligentSystem();
}

module.exports = {
  testGeminiIntelligentSystem,
  testSpecificFunction
};
