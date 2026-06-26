const { 
  executeGeminiDecision, 
  getGeminiMemoryStatus,
  resetGeminiMemory 
} = require('./src/services/policiercongoAutomatisation');

async function testActionsMultiples() {
  console.log('🧪 Test du système d\'actions multiples...\n');
  
  // Test 1: Action simple
  console.log('📋 Test 1: Action simple (RESPOND_TO_USER)');
  const decisionSimple = {
    action: 'RESPOND_TO_USER',
    reason: 'Test de réponse simple',
    priority: 'medium',
    details: {
      target_user: 'test_user',
      response_context: 'Test de réponse'
    }
  };
  
  try {
    const result1 = await executeGeminiDecision(decisionSimple);
    console.log('✅ Résultat action simple:', JSON.stringify(result1, null, 2));
  } catch (error) {
    console.error('❌ Erreur action simple:', error.message);
  }
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Test 2: Actions multiples
  console.log('📋 Test 2: Actions multiples (RESPOND_TO_USER + POST_TWEET)');
  const decisionMultiple = {
    action: ['RESPOND_TO_USER', 'POST_TWEET'],
    reason: 'Test d\'actions multiples - répondre ET poster',
    priority: 'high',
    details: {
      respond_to: {
        target_user: 'maman',
        response_context: 'Interaction ludique et sympathique'
      },
      post_tweet: {
        tweet_type: 'actualite',
        content: '🌟 Test d\'actions multiples ! La communauté est au cœur de nos préoccupations ! 🚔💪'
      }
    }
  };
  
  try {
    const result2 = await executeGeminiDecision(decisionMultiple);
    console.log('✅ Résultat actions multiples:', JSON.stringify(result2, null, 2));
  } catch (error) {
    console.error('❌ Erreur actions multiples:', error.message);
  }
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Test 3: Statut de la mémoire
  console.log('📋 Test 3: Statut de la mémoire Gemini');
  try {
    const memoryStatus = getGeminiMemoryStatus();
    console.log('✅ Statut mémoire:', JSON.stringify(memoryStatus, null, 2));
  } catch (error) {
    console.error('❌ Erreur statut mémoire:', error.message);
  }
  
  console.log('\n🧪 Tests terminés !');
}

// Exécuter les tests
if (require.main === module) {
  testActionsMultiples()
    .then(() => {
      console.log('✅ Tous les tests sont terminés');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Erreur lors des tests:', error);
      process.exit(1);
    });
}

module.exports = { testActionsMultiples };
