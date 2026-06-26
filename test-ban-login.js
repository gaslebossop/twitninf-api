const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000/api';

async function testBanLogin() {
  try {
    console.log('🧪 Test de connexion avec informations de ban...\n');

    // 1. Créer un utilisateur de test
    console.log('1️⃣ Création d\'un utilisateur de test...');
    const createResponse = await axios.post(`${API_BASE_URL}/auth/register`, {
      username: 'testbanuser',
      fullName: 'Test Ban User',
      password: 'password123',
      platform: 'web'
    });

    if (createResponse.data.success) {
      console.log('✅ Utilisateur créé:', createResponse.data.data.user.username);
      const userId = createResponse.data.data.user.id;
      const token = createResponse.data.data.user.token;

      // 2. Vérifier que l'utilisateur n'a pas d'informations de ban
      console.log('\n2️⃣ Vérification des informations de ban initiales...');
      const userResponse = await axios.get(`${API_BASE_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (userResponse.data.success) {
        const user = userResponse.data.data;
        console.log('📊 Informations de ban:');
        console.log('   - is_suspended:', user.is_suspended);
        console.log('   - ban_count:', user.ban_count);
        console.log('   - suspension_reason:', user.suspension_reason);
        console.log('   - suspended_until:', user.suspended_until);
      }

      // 3. Simuler une suspension (via l'API admin)
      console.log('\n3️⃣ Simulation d\'une suspension...');
      try {
        const suspendResponse = await axios.post(`${API_BASE_URL}/users/${userId}/suspend`, {
          reason: 'Test de suspension',
          duration_days: 7
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (suspendResponse.data.success) {
          console.log('✅ Utilisateur suspendu');
        }
      } catch (suspendError) {
        console.log('⚠️ Erreur lors de la suspension (peut être normal):', suspendError.response?.data?.message || suspendError.message);
      }

      // 4. Se reconnecter pour voir les nouvelles informations
      console.log('\n4️⃣ Reconnexion pour vérifier les informations de ban...');
      const loginResponse = await axios.post(`${API_BASE_URL}/auth/login`, {
        username: 'testbanuser',
        password: 'password123'
      });

      if (loginResponse.data.success) {
        const user = loginResponse.data.data.user;
        console.log('🔐 Connexion réussie');
        console.log('📊 Nouvelles informations de ban:');
        console.log('   - is_suspended:', user.is_suspended);
        console.log('   - ban_count:', user.ban_count);
        console.log('   - suspension_reason:', user.suspension_reason);
        console.log('   - suspended_until:', user.suspended_until);
        
        // 5. Vérifier que le token contient les informations de ban
        console.log('\n5️⃣ Vérification du token JWT...');
        const tokenData = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        console.log('🔑 Token payload:');
        console.log('   - is_suspended:', tokenData.is_suspended);
        console.log('   - ban_count:', tokenData.ban_count);
        console.log('   - suspension_reason:', tokenData.suspension_reason);
        console.log('   - suspended_until:', tokenData.suspended_until);
      }

    } else {
      console.log('❌ Erreur lors de la création:', createResponse.data.message);
    }

  } catch (error) {
    console.error('💥 Erreur:', error.response?.data || error.message);
  }
}

// Lancer le test
testBanLogin();
