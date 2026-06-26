const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000/api';

async function testSimpleBan() {
  try {
    console.log('🧪 Test simple des informations de ban...\n');

    // 1. Créer un utilisateur de test
    console.log('1️⃣ Création d\'un utilisateur de test...');
    const createResponse = await axios.post(`${API_BASE_URL}/auth/register`, {
      username: 'testbanuser2',
      fullName: 'Test Ban User 2',
      password: 'password123',
      platform: 'web'
    });

    if (createResponse.data.success) {
      console.log('✅ Utilisateur créé:', createResponse.data.data.user.username);
      const userId = createResponse.data.data.user.id;
      const token = createResponse.data.data.user.token;

      // 2. Vérifier le profil via /me
      console.log('\n2️⃣ Vérification du profil via /me...');
      const meResponse = await axios.get(`${API_BASE_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (meResponse.data.success) {
        const user = meResponse.data.data;
        console.log('📊 Informations de ban dans /me:');
        console.log('   - is_suspended:', user.is_suspended);
        console.log('   - ban_count:', user.ban_count);
        console.log('   - suspension_reason:', user.suspension_reason);
        console.log('   - suspended_until:', user.suspended_until);
      }

      // 3. Se reconnecter pour voir les informations
      console.log('\n3️⃣ Reconnexion pour vérifier les informations...');
      const loginResponse = await axios.post(`${API_BASE_URL}/auth/login`, {
        username: 'testbanuser2',
        password: 'password123'
      });

      if (loginResponse.data.success) {
        const user = loginResponse.data.data.user;
        console.log('🔐 Connexion réussie');
        console.log('📊 Informations de ban dans login:');
        console.log('   - is_suspended:', user.is_suspended);
        console.log('   - ban_count:', user.ban_count);
        console.log('   - suspension_reason:', user.suspension_reason);
        console.log('   - suspended_until:', user.suspended_until);
      }

    } else {
      console.log('❌ Erreur lors de la création:', createResponse.data.message);
    }

  } catch (error) {
    console.error('💥 Erreur:', error.response?.data || error.message);
  }
}

// Lancer le test
testSimpleBan();
