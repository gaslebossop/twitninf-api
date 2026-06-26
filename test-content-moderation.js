const axios = require('axios');

// Configuration
const API_BASE_URL = 'http://localhost:3000/api';
const MODERATOR_TOKEN = 'YOUR_MODERATOR_TOKEN'; // Remplacez par un vrai token

async function testContentModerationAPI() {
  try {
    console.log('🧪 Test de l\'API de modération de contenu...\n');

    // 1. Récupérer la liste des tweets à modérer
    console.log('1️⃣ Récupération de la liste des tweets...');
    const tweetsResponse = await axios.get(`${API_BASE_URL}/moderation/tweets`, {
      headers: { Authorization: `Bearer ${MODERATOR_TOKEN}` }
    });
    
    console.log('   ✅ Réponse reçue:', tweetsResponse.status);
    console.log('   📊 Données reçues:', JSON.stringify(tweetsResponse.data, null, 2));
    
    if (tweetsResponse.data.success && tweetsResponse.data.data.tweets) {
      const tweets = tweetsResponse.data.data.tweets;
      console.log(`   🐦 Nombre de tweets: ${tweets.length}`);
      
      if (tweets.length > 0) {
        const firstTweet = tweets[0];
        console.log('\n2️⃣ Analyse du premier tweet:');
        console.log(`   ID: ${firstTweet.id}`);
        console.log(`   Contenu: ${firstTweet.content}`);
        console.log(`   Modération status: ${firstTweet.moderation_status}`);
        console.log(`   Gravité: ${firstTweet.severity}`);
        
        if (firstTweet.author) {
          console.log(`   Auteur - ID: ${firstTweet.author.id}`);
          console.log(`   Auteur - Username: ${firstTweet.author.username}`);
          console.log(`   Auteur - Full name: ${firstTweet.author.full_name}`);
          console.log(`   Auteur - Vérifié: ${firstTweet.author.verified}`);
        }
        
        console.log(`   Créé le: ${firstTweet.created_at}`);
        console.log(`   Likes: ${firstTweet.likes}`);
        console.log(`   Retweets: ${firstTweet.retweets}`);
        console.log(`   Réponses: ${firstTweet.replies}`);
        console.log(`   Signalements: ${firstTweet.reports}`);
      }
    }

  } catch (error) {
    console.error('❌ Erreur lors du test:', error.response?.data || error.message);
    
    if (error.response?.status === 401) {
      console.log('\n💡 Assurez-vous d\'avoir un token de modérateur valide');
    }
  }
}

// Exécuter le test
testContentModerationAPI();
