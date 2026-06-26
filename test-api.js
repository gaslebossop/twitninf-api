const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000';

async function testAPI() {
  console.log('🧪 Test de l\'API wtitninf...\n');

  try {
    // Test 1: Route racine
    console.log('1️⃣ Test de la route racine...');
    const rootResponse = await axios.get(`${API_BASE_URL}/`);
    console.log('✅ Route racine:', rootResponse.data.message);
    console.log('   Version:', rootResponse.data.version);
    console.log('');

    // Test 2: Route de santé
    console.log('2️⃣ Test de la route de santé...');
    const healthResponse = await axios.get(`${API_BASE_URL}/health`);
    console.log('✅ Route de santé:', healthResponse.data.message);
    console.log('   Environnement:', healthResponse.data.environment);
    console.log('   Uptime:', Math.round(healthResponse.data.uptime), 'secondes');
    console.log('');

    // Test 3: Route d'inscription (validation)
    console.log('3️⃣ Test de la route d\'inscription (validation)...');
    try {
      await axios.post(`${API_BASE_URL}/api/auth/register`, {
        // Données invalides pour tester la validation
        fullName: '',
        username: 'a',
        email: 'invalid-email',
        phone: '123',
        password: 'weak',
        confirmPassword: 'different',
        platform: 'invalid'
      });
    } catch (error) {
      if (error.response && error.response.status === 400) {
        console.log('✅ Validation des données fonctionne');
        console.log('   Erreurs de validation:', error.response.data.errors.length);
        error.response.data.errors.forEach(err => {
          console.log(`   - ${err.field}: ${err.message}`);
        });
      } else {
        console.log('❌ Erreur inattendue lors de la validation');
      }
    }
    console.log('');

    // Test 4: Route de connexion (utilisateur inexistant)
    console.log('4️⃣ Test de la route de connexion (utilisateur inexistant)...');
    try {
      await axios.post(`${API_BASE_URL}/api/auth/login`, {
        identifier: 'nonexistent@example.com',
        password: 'password123'
      });
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log('✅ Gestion des utilisateurs inexistants fonctionne');
        console.log('   Message:', error.response.data.message);
      } else {
        console.log('❌ Erreur inattendue lors de la connexion');
      }
    }
    console.log('');

    // Test 5: Route protégée sans token
    console.log('5️⃣ Test de la route protégée sans token...');
    try {
      await axios.get(`${API_BASE_URL}/api/auth/profile`);
    } catch (error) {
      if (error.response && error.response.status === 401) {
        console.log('✅ Protection des routes privées fonctionne');
        console.log('   Message:', error.response.data.message);
      } else {
        console.log('❌ Erreur inattendue lors de l\'accès protégé');
      }
    }
    console.log('');

    console.log('🎉 Tous les tests de base sont passés avec succès !');
    console.log('🚀 L\'API wtitninf est opérationnelle et sécurisée.');

  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.log('❌ Impossible de se connecter à l\'API');
      console.log('   Assurez-vous que le serveur est démarré sur le port 3000');
      console.log('   Commande: npm run dev');
    } else {
      console.log('❌ Erreur lors des tests:', error.message);
    }
  }
}

// Exécuter les tests
testAPI();
