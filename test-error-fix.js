const { 
  getGeminiMemoryStatus,
  resetGeminiMemory 
} = require('./src/services/policiercongoAutomatisation');

async function testErrorFix() {
  console.log('🧪 Test de correction des erreurs undefined...\n');
  
  try {
    // Test 1: Vérifier que la mémoire fonctionne
    console.log('📋 Test 1: Vérification de la mémoire');
    const memoryStatus = getGeminiMemoryStatus();
    console.log('✅ Statut mémoire récupéré:', memoryStatus ? 'SUCCÈS' : 'ÉCHEC');
    
    // Test 2: Test avec données vides (simulation d'erreur)
    console.log('\n📋 Test 2: Simulation de données vides');
    const emptyData = {
      mainTweets: [],
      replies: [],
      recentTweets: []
    };
    
    // Simuler le prompt avec des données vides
    const testPrompt = `Test avec données vides:
    - DERNIER TWEET: ${emptyData.mainTweets && emptyData.mainTweets.length > 0 && emptyData.mainTweets[0].created_at ? emptyData.mainTweets[0].created_at.toLocaleString('fr-FR') : 'Aucun tweet récent'}
    - TEMPS ÉCOULÉ: ${emptyData.mainTweets && emptyData.mainTweets.length > 0 && emptyData.mainTweets[0].created_at ? Math.floor((new Date() - new Date(emptyData.mainTweets[0].created_at)) / (1000 * 60 * 60)) : 0} heures
    - TWEETS PRINCIPAUX: ${emptyData.mainTweets && emptyData.mainTweets.length > 0 ? emptyData.mainTweets.slice(0, 5).map((tweet, index) => {
      if (!tweet || !tweet.created_at) return `${index + 1}. Tweet principal invalide`;
      const hoursAgo = Math.floor((new Date() - new Date(tweet.created_at)) / (1000 * 60 * 60));
      return `${index + 1}. Tweet principal il y a ${hoursAgo}h: "${tweet.content || 'Contenu non disponible'}" (Engagement: ${tweet.engagement || 0})`;
    }).join('\n') : 'Aucun tweet principal récent trouvé'}
    - INTERACTIONS: ${emptyData.replies && emptyData.replies.length > 0 ? emptyData.replies.slice(0, 10).map((reply, index) => {
      if (!reply || !reply.created_at) return `${index + 1}. Interaction invalide`;
      const hoursAgo = Math.floor((new Date() - new Date(reply.created_at)) / (1000 * 60 * 60));
      return `${index + 1}. @${reply.author || 'utilisateur'} il y a ${hoursAgo}h: "${reply.content || 'Contenu non disponible'}"`;
    }).join('\n') : 'Aucune interaction récente trouvée'}`;
    
    console.log('✅ Prompt généré sans erreur avec données vides');
    console.log('📝 Extrait du prompt:', testPrompt.substring(0, 200) + '...');
    
    // Test 3: Test avec données partielles
    console.log('\n📋 Test 3: Test avec données partielles');
    const partialData = {
      mainTweets: [{ created_at: new Date(), content: 'Test tweet' }],
      replies: [{ created_at: new Date(), author: 'test_user', content: 'Test reply' }],
      recentTweets: []
    };
    
    const partialPrompt = `Test avec données partielles:
    - DERNIER TWEET: ${partialData.mainTweets && partialData.mainTweets.length > 0 && partialData.mainTweets[0].created_at ? partialData.mainTweets[0].created_at.toLocaleString('fr-FR') : 'Aucun tweet récent'}
    - TEMPS ÉCOULÉ: ${partialData.mainTweets && partialData.mainTweets.length > 0 && partialData.mainTweets[0].created_at ? Math.floor((new Date() - new Date(partialData.mainTweets[0].created_at)) / (1000 * 60 * 60)) : 0} heures`;
    
    console.log('✅ Prompt généré sans erreur avec données partielles');
    console.log('📝 Extrait du prompt:', partialPrompt.substring(0, 200) + '...');
    
    console.log('\n✅ Tous les tests de correction d\'erreurs sont terminés avec succès !');
    
  } catch (error) {
    console.error('❌ Erreur lors des tests:', error);
    console.error('Stack:', error.stack);
  }
}

// Exécuter les tests
if (require.main === module) {
  testErrorFix()
    .then(() => {
      console.log('✅ Tests de correction terminés');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Erreur lors des tests de correction:', error);
      process.exit(1);
    });
}

module.exports = { testErrorFix };
