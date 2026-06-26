const axios = require('axios');

async function testSearchGlobal() {
  try {
    console.log('🧪 Test de la recherche globale...');
    
    // Test sans authentification (recherche publique)
    console.log('\n1️⃣ Test sans authentification:');
    const publicResponse = await axios.get('http://localhost:3000/api/search?q=test&limit=5');
    console.log('✅ Statut:', publicResponse.status);
    console.log('📊 Structure de réponse:', Object.keys(publicResponse.data));
    
    if (publicResponse.data.data && publicResponse.data.data.results) {
      const { users, tweets, hashtags } = publicResponse.data.data.results;
      console.log('👥 Users:', users.length);
      console.log('🐦 Tweets:', tweets.length);
      console.log('#️⃣ Hashtags:', hashtags.length);
      
      if (tweets.length > 0) {
        const firstTweet = tweets[0];
        console.log('\n📝 Premier tweet:');
        console.log('  - ID:', firstTweet.id);
        console.log('  - Content:', firstTweet.content?.substring(0, 50));
        console.log('  - Stats:', firstTweet.stats);
        console.log('  - User interaction:', firstTweet.user_interaction);
      }
    }
    
    // Test avec authentification (si on a un token)
    console.log('\n2️⃣ Test avec authentification:');
    console.log('⚠️ Pas de token disponible pour ce test');
    
  } catch (error) {
    console.error('❌ Erreur lors du test:', error.message);
    if (error.response) {
      console.error('📊 Statut:', error.response.status);
      console.error('📝 Données:', error.response.data);
    }
  }
}

// Lancer le test
testSearchGlobal();
