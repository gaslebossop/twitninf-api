const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000/api';

async function testLoginG() {
  try {
    console.log('🧪 Test de connexion pour l\'utilisateur g...\n');

    // 1. Tenter de se connecter avec l'utilisateur g
    console.log('1️⃣ Tentative de connexion...');
    const loginResponse = await axios.post(`${API_BASE_URL}/auth/login`, {
      username: 'g',
      password: 'myytre88'
    });

    if (loginResponse.data.success) {
      console.log('✅ Connexion réussie!');
      const user = loginResponse.data.data.user;
      console.log('📊 Informations de l\'utilisateur:');
      console.log('   - username:', user.username);
      console.log('   - is_suspended:', user.is_suspended);
      console.log('   - ban_count:', user.ban_count);
      console.log('   - suspension_reason:', user.suspension_reason);
      console.log('   - suspended_until:', user.suspended_until);
      
      // 2. Vérifier le token JWT
      console.log('\n2️⃣ Vérification du token JWT...');
      const token = loginResponse.data.data.token;
      const tokenData = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      console.log('🔑 Token payload:');
      console.log('   - is_suspended:', tokenData.is_suspended);
      console.log('   - ban_count:', tokenData.ban_count);
      console.log('   - suspension_reason:', tokenData.suspension_reason);
      console.log('   - suspended_until:', tokenData.suspended_until);

      // 3. Tester la création d'un tweet
      console.log('\n3️⃣ Test de création d\'un tweet...');
      try {
        const tweetResponse = await axios.post(`${API_BASE_URL}/tweets`, {
          content: 'Test tweet après débanage'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (tweetResponse.data.success) {
          console.log('✅ Tweet créé avec succès!');
        }
      } catch (tweetError) {
        console.log('❌ Erreur lors de la création du tweet:');
        console.log('   Message:', tweetError.response?.data?.message);
        if (tweetError.response?.data?.ban_info) {
          console.log('   Ban info:', tweetError.response.data.ban_info);
        }
      }

    } else {
      console.log('❌ Échec de connexion:', loginResponse.data.message);
    }

  } catch (error) {
    console.error('💥 Erreur:', error.response?.data || error.message);
  }
}

// Lancer le test
testLoginG();
