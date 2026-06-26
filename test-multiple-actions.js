const { 
  geminiIntelligentAnalysis, 
  executeGeminiDecision, 
  getGeminiMemoryStatus,
  resetGeminiMemory 
} = require('./src/services/policiercongoAutomatisation');

async function testMultipleActions() {
  try {
    console.log('🧪 Test des actions multiples...\n');
    
    // 1. Vérifier le statut initial
    console.log('📊 Statut initial de la mémoire:');
    const initialStatus = getGeminiMemoryStatus();
    console.log(JSON.stringify(initialStatus, null, 2));
    console.log('');
    
    // 2. Lancer l'analyse Gemini
    console.log('🧠 Lancement de l\'analyse Gemini...');
    const decision = await geminiIntelligentAnalysis();
    
    if (!decision) {
      console.log('❌ Aucune décision Gemini');
      return;
    }
    
    console.log('✅ Décision Gemini reçue:');
    console.log(JSON.stringify(decision, null, 2));
    console.log('');
    
    // 3. Vérifier si c'est une action multiple
    if (Array.isArray(decision.action)) {
      console.log(`🔄 Action multiple détectée: ${decision.action.length} actions`);
      console.log(`Actions: ${decision.action.join(', ')}`);
      console.log('');
      
      // 4. Exécuter la décision
      console.log('🚀 Exécution de la décision...');
      const result = await executeGeminiDecision(decision);
      
      console.log('✅ Résultat de l\'exécution:');
      console.log(JSON.stringify(result, null, 2));
      
    } else {
      console.log('📝 Action unique détectée:', decision.action);
      
      // 4. Exécuter la décision
      console.log('🚀 Exécution de la décision...');
      const result = await executeGeminiDecision(decision);
      
      console.log('✅ Résultat de l\'exécution:');
      console.log(JSON.stringify(result, null, 2));
    }
    
    // 5. Vérifier le statut final
    console.log('\n📊 Statut final de la mémoire:');
    const finalStatus = getGeminiMemoryStatus();
    console.log(JSON.stringify(finalStatus, null, 2));
    
  } catch (error) {
    console.error('❌ Erreur lors du test:', error);
  }
}

// Fonction pour tester une fonction spécifique
async function testSpecificFunction(functionName) {
  try {
    switch (functionName) {
      case 'memory':
        console.log('🧠 Statut de la mémoire Gemini:');
        const status = getGeminiMemoryStatus();
        console.log(JSON.stringify(status, null, 2));
        break;
        
      case 'reset':
        console.log('🔄 Réinitialisation de la mémoire Gemini...');
        resetGeminiMemory();
        console.log('✅ Mémoire réinitialisée');
        break;
        
      case 'analysis':
        console.log('🧠 Test de l\'analyse Gemini...');
        await testMultipleActions();
        break;
        
      default:
        console.log('❌ Fonction inconnue. Utilisez: memory, reset, ou analysis');
    }
  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

// Gestion des arguments de ligne de commande
const args = process.argv.slice(2);
if (args.length > 0) {
  testSpecificFunction(args[0]);
} else {
  testMultipleActions();
}
