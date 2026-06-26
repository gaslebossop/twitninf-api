const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000/api';

async function testSimple() {
  try {
    console.log('🧪 Test simple de connexion...\n');
    console.log('URL:', `${API_BASE_URL}/auth/login`);

    const response = await axios.post(`${API_BASE_URL}/auth/login`, {
      username: 'g',
      password: 'myytre88'
    });

    console.log('✅ Réponse reçue:', response.data);

  } catch (error) {
    console.error('❌ Erreur détaillée:');
    console.error('Message:', error.message);
    console.error('Code:', error.code);
    console.error('Response:', error.response?.data);
    console.error('Status:', error.response?.status);
  }
}

testSimple();
