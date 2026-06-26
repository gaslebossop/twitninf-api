const policiercongoAutomatisation = require('./src/services/policiercongoAutomatisation');

console.log('🚀 Test rapide de l\'architecture optimisée en 2 phases\n');

async function quickTest() {
  try {
    // Test 1: Vérifier que les nouvelles fonctions existent
    console.log('🔍 Vérification des nouvelles fonctions...');
    
    const hasPlanning = typeof policiercongoAutomatisation.geminiPhase1Planning === 'function';
    const hasExecution = typeof policiercongoAutomatisation.geminiPhase2Execution === 'function';
    const hasOptimized = typeof policiercongoAutomatisation.runOptimizedAutomation === 'function';
    
    console.log(`✅ geminiPhase1Planning: ${hasPlanning ? 'OK' : 'MANQUANT'}`);
    console.log(`✅ geminiPhase2Execution: ${hasExecution ? 'OK' : 'MANQUANT'}`);
    console.log(`✅ runOptimizedAutomation: ${hasOptimized ? 'OK' : 'MANQUANT'}`);
    
    if (!hasPlanning || !hasExecution || !hasOptimized) {
      console.log('\n❌ Certaines fonctions sont manquantes. Vérifiez l\'import.');
      return;
    }
    
    console.log('\n✅ Toutes les fonctions sont présentes !');
    
    // Test 2: Vérifier la mémoire
    console.log('\n🧠 Vérification de la mémoire Gemini...');
    const memoryStatus = policiercongoAutomatisation.getGeminiMemoryStatus();
    console.log(`✅ Mémoire accessible: ${memoryStatus ? 'OUI' : 'NON'}`);
    
    if (memoryStatus) {
      console.log(`   - Taille: ${JSON.stringify(memoryStatus.memorySize)}`);
      console.log(`   - Dernière mise à jour: ${memoryStatus.lastUpdated}`);
    }
    
    // Test 3: Test de planification simple (sans exécution)
    console.log('\n📋 Test de planification (Phase 1)...');
    console.log('⚠️  Ce test va planifier avec Gemini. Continuer ? (Ctrl+C pour arrêter)');
    
    // Attendre 2 secondes
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const plan = await policiercongoAutomatisation.geminiPhase1Planning();
    
    if (plan && plan.plan) {
      console.log('✅ Planification réussie !');
      console.log(`   - Actions: ${plan.plan.actions.length}`);
      console.log(`   - Ordre: ${plan.plan.execution_order}`);
      console.log(`   - Impact: ${plan.plan.community_impact}`);
      
      // Afficher les actions planifiées
      plan.plan.actions.forEach((action, index) => {
        console.log(`   ${index + 1}. ${action.type} (${action.priority})`);
      });
      
      console.log('\n🎯 Architecture optimisée en 2 phases : PRÊTE !');
      console.log('\n📚 Pour tester complètement, utilisez:');
      console.log('   node test-optimized-automation.js');
      
    } else {
      console.log('❌ Planification échouée');
      console.log('Plan reçu:', plan);
    }
    
  } catch (error) {
    console.error('❌ Erreur lors du test rapide:', error);
  }
}

// Lancer le test
quickTest();
