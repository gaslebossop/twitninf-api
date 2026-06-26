const policiercongoAutomatisation = require('./src/services/policiercongoAutomatisation');
const logger = require('./src/utils/logger');

async function testContextualResponses() {
  console.log('🇨🇬 Test des réponses contextuelles PolicierCongo\n');
  
  try {
    // Test 1: Détection automatique des tweets Congo
    console.log('🔍 Test 1: Détection automatique des tweets Congo...');
    const tweetsToRespond = await policiercongoAutomatisation.detectCongoTweetsForResponse();
    
    if (tweetsToRespond && tweetsToRespond.length > 0) {
      console.log('✅ Tweets détectés pour réponse contextuelle:');
      tweetsToRespond.forEach((tweetData, index) => {
        console.log(`   ${index + 1}. @${tweetData.tweet.author?.username || 'utilisateur'}`);
        console.log(`      - Contenu: "${tweetData.tweet.content.substring(0, 50)}..."`);
        console.log(`      - Priorité: ${tweetData.priority}`);
        console.log(`      - Raison: ${tweetData.reason}`);
        console.log(`      - Score: ${tweetData.context?.relevanceScore || 'N/A'}`);
        console.log('');
      });
    } else {
      console.log('ℹ️ Aucun tweet détecté pour réponse contextuelle');
    }
    
    console.log('='.repeat(60) + '\n');
    
    // Test 2: Analyse d'un tweet spécifique
    console.log('📊 Test 2: Analyse d\'un tweet spécifique...');
    if (tweetsToRespond && tweetsToRespond.length > 0) {
      const sampleTweet = tweetsToRespond[0].tweet;
      const analysis = await policiercongoAutomatisation.analyzeTweetForResponse(sampleTweet);
      
      console.log('✅ Analyse du tweet:');
      console.log(`   - Tweet: "${sampleTweet.content.substring(0, 80)}..."`);
      console.log(`   - Auteur: @${sampleTweet.author?.username || 'utilisateur'}`);
      console.log(`   - Doit répondre: ${analysis.shouldRespond ? 'OUI' : 'NON'}`);
      console.log(`   - Priorité: ${analysis.priority}`);
      console.log(`   - Raison: ${analysis.reason}`);
      console.log(`   - Score de pertinence: ${analysis.relevanceScore}`);
      console.log(`   - Contexte détecté:`, analysis.context);
    } else {
      console.log('ℹ️ Aucun tweet disponible pour l\'analyse');
    }
    
    console.log('='.repeat(60) + '\n');
    
    // Test 3: Génération de réponse contextuelle (simulation)
    console.log('🤖 Test 3: Génération de réponse contextuelle...');
    if (tweetsToRespond && tweetsToRespond.length > 0) {
      const sampleTweet = tweetsToRespond[0].tweet;
      
      console.log(`📝 Génération de réponse pour @${sampleTweet.author?.username || 'utilisateur'}...`);
      console.log(`   Tweet original: "${sampleTweet.content.substring(0, 60)}..."`);
      
      // Simuler la génération sans créer de vrai tweet
      const mockResponse = await policiercongoAutomatisation.generateContextualResponse(
        sampleTweet,
        [], // Pas de tweets récents pour la simulation
        [], // Pas de tweets policier récents pour la simulation
        { desiredFrequency: 'modérée' }
      );
      
      if (mockResponse) {
        console.log('✅ Réponse contextuelle générée:');
        console.log(`   - Contenu: "${mockResponse.content}"`);
        console.log(`   - Type: ${mockResponse.type}`);
        console.log(`   - Analyse du contexte:`, mockResponse.contextAnalysis);
      } else {
        console.log('❌ Échec de la génération de réponse contextuelle');
      }
    } else {
      console.log('ℹ️ Aucun tweet disponible pour la génération de réponse');
    }
    
    console.log('='.repeat(60) + '\n');
    
    // Test 4: Test complet avec un tweet simulé
    console.log('🧪 Test 4: Test complet avec tweet simulé...');
    
    // Créer un tweet simulé pour le test
    const mockTweet = {
      id: 'test-tweet-123',
      content: 'Salut @policiercongo ! J\'ai une question sur la sécurité dans notre quartier de Kinshasa. Y a-t-il des patrouilles prévues ce soir ? 🚔',
      created_at: new Date(),
      user_id: 'test-user-456',
      author: {
        username: 'citoyen_kinshasa',
        bio: 'Citoyen engagé de Kinshasa',
        created_at: new Date()
      },
      likes: [],
      retweets: []
    };
    
    console.log('📝 Test avec tweet simulé:');
    console.log(`   - Auteur: @${mockTweet.author.username}`);
    console.log(`   - Contenu: "${mockTweet.content}"`);
    
    const mockAnalysis = await policiercongoAutomatisation.analyzeTweetForResponse(mockTweet);
    console.log('✅ Analyse du tweet simulé:');
    console.log(`   - Doit répondre: ${mockAnalysis.shouldRespond ? 'OUI' : 'NON'}`);
    console.log(`   - Priorité: ${mockAnalysis.priority}`);
    console.log(`   - Score: ${mockAnalysis.relevanceScore}`);
    console.log(`   - Contexte:`, mockAnalysis.context);
    
    console.log('='.repeat(60) + '\n');
    
    // Test 5: Test de la fonction complète (optionnel)
    console.log('🚀 Test 5: Test de la fonction complète (optionnel)...');
    console.log('⚠️  Ce test va réellement créer une réponse. Continuer ? (Ctrl+C pour arrêter)');
    
    // Attendre 5 secondes pour permettre l'arrêt
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    if (tweetsToRespond && tweetsToRespond.length > 0) {
      const testTweet = tweetsToRespond[0].tweet;
      console.log(`📝 Test de réponse contextuelle pour @${testTweet.author?.username || 'utilisateur'}...`);
      
      const responseResult = await policiercongoAutomatisation.respondToCongoTweet(
        testTweet.id,
        { 
          desiredFrequency: 'modérée',
          priority: 'high',
          context: { test: true }
        }
      );
      
      if (responseResult.success) {
        console.log('✅ Réponse contextuelle créée avec succès:');
        console.log(`   - ID de la réponse: ${responseResult.response_tweet_id}`);
        console.log(`   - Contenu: "${responseResult.content}"`);
        console.log(`   - Type: ${responseResult.type}`);
        console.log(`   - Analyse du contexte:`, responseResult.context_analysis);
      } else {
        console.log('❌ Échec de la création de réponse contextuelle:', responseResult.error);
      }
    } else {
      console.log('ℹ️ Aucun tweet disponible pour le test complet');
    }
    
  } catch (error) {
    console.error('❌ Erreur lors des tests de réponses contextuelles:', error);
    logger.error('Erreur lors des tests de réponses contextuelles:', error);
  }
  
  console.log('\n🎯 Tests des réponses contextuelles terminés !');
}

// Fonction pour tester une fonction spécifique
async function testSpecificContextualFunction(functionName) {
  console.log(`🧪 Test de la fonction contextuelle: ${functionName}\n`);
  
  try {
    switch (functionName) {
      case 'detect':
        const tweets = await policiercongoAutomatisation.detectCongoTweetsForResponse();
        console.log('Résultat:', tweets);
        break;
        
      case 'analyze':
        // Créer un tweet de test pour l'analyse
        const mockTweet = {
          id: 'test-analyze',
          content: 'Test de sécurité dans le quartier de Kinshasa',
          created_at: new Date(),
          user_id: 'test-user',
          author: { username: 'test_user', bio: 'Test', created_at: new Date() },
          likes: [],
          retweets: []
        };
        const analysis = await policiercongoAutomatisation.analyzeTweetForResponse(mockTweet);
        console.log('Résultat de l\'analyse:', analysis);
        break;
        
      case 'generate':
        const mockTweetForGen = {
          id: 'test-generate',
          content: 'Test de génération de réponse',
          created_at: new Date(),
          user_id: 'test-user',
          author: { username: 'test_user', bio: 'Test', created_at: new Date() },
          likes: [],
          retweets: []
        };
        const response = await policiercongoAutomatisation.generateContextualResponse(
          mockTweetForGen, [], [], { desiredFrequency: 'modérée' }
        );
        console.log('Réponse générée:', response);
        break;
        
      default:
        console.log('❌ Fonction inconnue. Fonctions disponibles:');
        console.log('   - detect (détection des tweets)');
        console.log('   - analyze (analyse d\'un tweet)');
        console.log('   - generate (génération de réponse)');
    }
  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

// Gestion des arguments de ligne de commande
const args = process.argv.slice(2);

if (args.length > 0) {
  const functionName = args[0];
  testSpecificContextualFunction(functionName);
} else {
  // Test complet par défaut
  testContextualResponses();
}

module.exports = {
  testContextualResponses,
  testSpecificContextualFunction
};
