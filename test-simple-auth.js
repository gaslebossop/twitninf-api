const axios = require('axios');

async function testAuthRoutes() {
  const baseURL = 'http://localhost:3000/api';
  
  console.log('🧪 Test simple des routes d\'authentification\n');

  try {
    // Test 1: Route de santé
    console.log('1. Test route de santé...');
    const healthResponse = await axios.get(`${baseURL}/health`);
    console.log('✅ Santé:', healthResponse.status, healthResponse.data.message);

    // Test 2: Inscription
    console.log('\n2. Test inscription...');
    const registerData = {
      username: 'testuser_' + Date.now(),
      fullName: 'Test User',
      email: `test${Date.now()}@example.com`,
      phone: '+33123456789',
      password: 'TestPass123!',
      platform: 'web'
    };

    console.log('Données d\'inscription:', registerData);
    
    const registerResponse = await axios.post(`${baseURL}/auth/register`, registerData, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Platform': 'web'
      }
    });
    
    console.log('✅ Inscription réussie:', registerResponse.status);
    console.log('Token:', registerResponse.data.data.token ? 'Présent' : 'Absent');
    
    // Test 3: Connexion
    console.log('\n3. Test connexion...');
    const loginData = {
      email: registerData.email,
      password: registerData.password
    };

    const loginResponse = await axios.post(`${baseURL}/auth/login`, loginData, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Platform': 'web'
      }
    });
    
    console.log('✅ Connexion réussie:', loginResponse.status);
    console.log('Token:', loginResponse.data.data.token ? 'Présent' : 'Absent');

    console.log('\n🎉 Tous les tests réussis !');

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
    
    if (error.code === 'ECONNABORTED') {
      console.error('Timeout - Le serveur ne répond pas dans les temps');
    }
  }
}

testAuthRoutes();
