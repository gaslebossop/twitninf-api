const policiercongoAutomatisation = require('./src/services/policiercongoAutomatisation');
const logger = require('./src/utils/logger');

/**
 * Test du nouveau système d'automatisation optimisé en 2 phases
 */
async function testOptimizedAutomation() {
  console.log('🚀 Test du système d\'automatisation optimisé en 2 phases\n');
  
  try {
    // Test 1: Vérifier que les nouvelles fonctions existent
    console.log('🔍 Test 1: Vérification des nouvelles fonctions...');
    
    if (typeof policiercongoAutomatisation.geminiPhase1Planning === 'function') {
      console.log('✅ geminiPhase1Planning: OK');
    } else {
      console.log('❌ geminiPhase1Planning: MANQUANT');
    }
    
    if (typeof policiercongoAutomatisation.geminiPhase2Execution === 'function') {
      console.log('✅ geminiPhase2Execution: OK');
    } else {
      console.log('❌ geminiPhase2Execution: MANQUANT');
    }
    
    if (typeof policiercongoAutomatisation.runOptimizedAutomation === 'function') {
      console.log('✅ runOptimizedAutomation: OK');
    } else {
      console.log('❌ runOptimizedAutomation: MANQUANT');
    }
    
    console.log('\n' + '='.repeat(60) + '\n');
    
    // Test 2: Phase 1 - Planification
    console.log('🧠 Test 2: Phase 1 - Planification stratégique...');
    console.log('⚠️  Ce test va réellement planifier avec Gemini. Continuer ? (Ctrl+C pour arrêter)');
    
    // Attendre 3 secondes pour permettre l'arrêt
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const plan = await policiercongoAutomatisation.geminiPhase1Planning();
    
    if (plan && plan.plan) {
      console.log('✅ Planification réussie:');
      console.log(`   - Actions planifiées: ${plan.plan.actions.length}`);
      console.log(`   - Ordre d'exécution: ${plan.plan.execution_order}`);
      console.log(`   - Durée estimée: ${plan.plan.estimated_duration}`);
      console.log(`   - Impact communautaire: ${plan.plan.community_impact}`);
      
      console.log('\n📋 Détail des actions:');
      plan.plan.actions.forEach((action, index) => {
        console.log(`   ${index + 1}. ${action.type} (${action.priority})`);
        console.log(`      Raison: ${action.reason}`);
        console.log(`      Cible: ${action.target_user || 'Aucune'}`);
        console.log(`      Contexte: ${action.context}`);
      });
      
      console.log('\n' + '='.repeat(60) + '\n');
      
      // Test 3: Phase 2 - Exécution (si plan valide)
      console.log('🚀 Test 3: Phase 2 - Exécution du plan...');
      console.log('⚠️  Ce test va exécuter le plan. Continuer ? (Ctrl+C pour arrêter)');
      
      // Attendre 3 secondes
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const executionResult = await policiercongoAutomatisation.geminiPhase2Execution(plan);
      
      if (executionResult.success) {
        console.log('✅ Exécution réussie:');
        console.log(`   - Actions totales: ${executionResult.total_actions}`);
        console.log(`   - Actions réussies: ${executionResult.successful_actions}`);
        console.log(`   - Actions échouées: ${executionResult.failed_actions}`);
        console.log(`   - Résumé: ${executionResult.summary}`);
        
        if (executionResult.results && executionResult.results.length > 0) {
          console.log('\n📊 Détail des résultats:');
          executionResult.results.forEach((result, index) => {
            console.log(`   ${index + 1}. ${result.action_type} (${result.priority})`);
            console.log(`      Succès: ${result.result.success ? '✅' : '❌'}`);
            if (result.result.error) {
              console.log(`      Erreur: ${result.result.error}`);
            }
            if (result.context_used) {
              console.log(`      Contexte utilisé: OUI`);
            }
          });
        }
        
      } else {
        console.log('❌ Exécution échouée:');
        console.log(`   - Erreur: ${executionResult.error}`);
      }
      
    } else {
      console.log('❌ Planification échouée');
      console.log('Plan reçu:', plan);
    }
    
    console.log('\n' + '='.repeat(60) + '\n');
    
    // Test 4: Test complet de l'automatisation optimisée
    console.log('🎯 Test 4: Test complet de l\'automatisation optimisée...');
    console.log('⚠️  Ce test va lancer l\'automatisation complète. Continuer ? (Ctrl+C pour arrêter)');
    
    // Attendre 3 secondes
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const automationResult = await policiercongoAutomatisation.runOptimizedAutomation();
    
    if (automationResult.success) {
      console.log('✅ Automatisation optimisée réussie !');
      console.log(`📈 Résumé: ${automationResult.summary}`);
      
      if (automationResult.total_actions) {
        console.log(`📊 Statistiques:`);
        console.log(`   - Total actions: ${automationResult.total_actions}`);
        console.log(`   - Actions réussies: ${automationResult.successful_actions}`);
        console.log(`   - Actions échouées: ${automationResult.failed_actions}`);
      }
      
    } else {
      console.log('❌ Automatisation optimisée échouée:');
      console.log(`   - Raison: ${automationResult.reason || automationResult.error}`);
    }
    
    console.log('\n' + '='.repeat(60) + '\n');
    
    // Test 5: Vérifier la mémoire mise à jour
    console.log('🧠 Test 5: Vérification de la mémoire mise à jour...');
    const memoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
    
    console.log('✅ Statut de la mémoire:');
    console.log(`   - Taille: ${JSON.stringify(memoryStatus.memorySize)}`);
    console.log(`   - Dernière mise à jour: ${memoryStatus.lastUpdated}`);
    
    if (memoryStatus.last_optimized_automation) {
      console.log(`   - Dernière automatisation optimisée: ${memoryStatus.last_optimized_automation.success ? '✅ Succès' : '❌ Échec'}`);
      console.log(`   - Timestamp: ${memoryStatus.last_optimized_automation.timestamp}`);
    }
    
    if (memoryStatus.automation_stats) {
      console.log(`   - Statistiques d'automatisation:`);
      console.log(`     * Total runs: ${memoryStatus.automation_stats.total_runs}`);
      console.log(`     * Succès: ${memoryStatus.automation_stats.successful_runs || 0}`);
      console.log(`     * Échecs: ${memoryStatus.automation_stats.failed_runs || 0}`);
      console.log(`     * Erreurs: ${memoryStatus.automation_stats.error_runs || 0}`);
    }
    
  } catch (error) {
    console.error('❌ Erreur lors des tests:', error);
    logger.error('Erreur lors des tests de l\'automatisation optimisée:', error);
  }
  
  console.log('\n🎯 Tests de l\'automatisation optimisée terminés !');
}

/**
 * Test d'une fonction spécifique
 */
async function testSpecificFunction(functionName) {
  console.log(`🧪 Test de la fonction: ${functionName}\n`);
  
  try {
    switch (functionName) {
      case 'planning':
        const plan = await policiercongoAutomatisation.geminiPhase1Planning();
        console.log('Résultat:', JSON.stringify(plan, null, 2));
        break;
        
      case 'execution':
        // Créer un plan de test simple
        const testPlan = {
          plan: {
            actions: [
              {
                type: 'NO_ACTION',
                priority: 'low',
                reason: 'Test de la fonction d\'exécution',
                target_user: null,
                context: 'Test uniquement'
              }
            ],
            execution_order: 'sequential',
            estimated_duration: '1 minute',
            community_impact: 'Test'
          }
        };
        
        const result = await policiercongoAutomatisation.geminiPhase2Execution(testPlan);
        console.log('Résultat:', JSON.stringify(result, null, 2));
        break;
        
      case 'automation':
        const automationResult = await policiercongoAutomatisation.runOptimizedAutomation();
        console.log('Résultat:', JSON.stringify(automationResult, null, 2));
        break;
        
      case 'memory':
        const memoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
        console.log('Résultat:', JSON.stringify(memoryStatus, null, 2));
        break;
        
      case 'reset':
        policiercongoAutomatisation.resetGeminiMemory();
        console.log('✅ Mémoire réinitialisée');
        break;
        
      default:
        console.log('❌ Fonction inconnue. Fonctions disponibles:');
        console.log('   - planning : Tester la phase 1 (planification)');
        console.log('   - execution : Tester la phase 2 (exécution)');
        console.log('   - automation : Tester l\'automatisation complète');
        console.log('   - memory : Voir le statut de la mémoire');
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
  testOptimizedAutomation();
}

module.exports = {
  testOptimizedAutomation,
  testSpecificFunction
};
