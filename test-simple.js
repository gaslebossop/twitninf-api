const { 
  getGeminiMemoryStatus,
  resetGeminiMemory 
} = require('./src/services/policiercongoAutomatisation');

async function testSimple() {
  console.log('🧪 Test simple du système...\n');
  
  try {
    // Test 1: Statut de la mémoire
    console.log('📋 Test 1: Statut de la mémoire Gemini');
    const memoryStatus = getGeminiMemoryStatus();
    console.log('✅ Statut mémoire:', JSON.stringify(memoryStatus, null, 2));
    
    // Test 2: Reset de la mémoire
    console.log('\n📋 Test 2: Reset de la mémoire');
    resetGeminiMemory();
    console.log('✅ Mémoire réinitialisée');
    
    // Test 3: Nouveau statut
    console.log('\n📋 Test 3: Nouveau statut après reset');
    const newMemoryStatus = getGeminiMemoryStatus();
    console.log('✅ Nouveau statut mémoire:', JSON.stringify(newMemoryStatus, null, 2));
    
    console.log('\n✅ Tous les tests sont terminés avec succès !');
    
  } catch (error) {
    console.error('❌ Erreur lors des tests:', error);
  }
}

// Exécuter les tests
if (require.main === module) {
  testSimple()
    .then(() => {
      console.log('✅ Tests terminés');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Erreur lors des tests:', error);
      process.exit(1);
    });
}

module.exports = { testSimple };
