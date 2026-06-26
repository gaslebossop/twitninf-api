const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000/api';

async function testTweetCreation() {
  try {
    console.log('🧪 Test de création de tweet pour l\'utilisateur g...\n');

    // 1. Se connecter
    console.log('1️⃣ Connexion...');
    const loginResponse = await axios.post(`${API_BASE_URL}/auth/login`, {
      username: 'g',
      password: 'myytre88'
    });

    if (!loginResponse.data.success) {
      console.log('❌ Échec de connexion');
      return;
    }

    const token = loginResponse.data.data.token;
    console.log('✅ Connecté avec succès');

    // 2. Tenter de créer un tweet
    console.log('\n2️⃣ Création d\'un tweet...');
    try {
      const tweetResponse = await axios.post(`${API_BASE_URL}/tweets`, {
        content: 'Test tweet après débanage - ' + new Date().toLocaleString()
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (tweetResponse.data.success) {
        console.log('✅ Tweet créé avec succès!');
        console.log('📝 Contenu:', tweetResponse.data.data.content);
        console.log('🆔 ID:', tweetResponse.data.data.id);
      }
    } catch (tweetError) {
      console.log('❌ Erreur lors de la création du tweet:');
      console.log('   Status:', tweetError.response?.status);
      console.log('   Message:', tweetError.response?.data?.message);
      if (tweetError.response?.data?.ban_info) {
        console.log('   Ban info:', tweetError.response.data.ban_info);
      }
    }

    // 3. Tester aussi le like d'un tweet
    console.log('\n3️⃣ Test de like d\'un tweet...');
    try {
      // D'abord récupérer un tweet existant
      const tweetsResponse = await axios.get(`${API_BASE_URL}/tweets?limit=1`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (tweetsResponse.data.success && tweetsResponse.data.data.length > 0) {
        const tweetId = tweetsResponse.data.data[0].id;
        console.log('📝 Tweet trouvé, ID:', tweetId);

        // Tenter de liker
        const likeResponse = await axios.post(`${API_BASE_URL}/tweets/${tweetId}/like`, {}, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (likeResponse.data.success) {
          console.log('✅ Like réussi!');
        }
      }
    } catch (likeError) {
      console.log('❌ Erreur lors du like:');
      console.log('   Message:', likeError.response?.data?.message);
      if (likeError.response?.data?.ban_info) {
        console.log('   Ban info:', likeError.response.data.ban_info);
      }
    }

  } catch (error) {
    console.error('💥 Erreur générale:', error.message);
  }
}

// Lancer le test
testTweetCreation();
