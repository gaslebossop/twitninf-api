const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000/api';

// Configuration Axios
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    'User-Platform': 'mobile'
  }
});

// Variables pour stocker les tokens
let authToken = null;
let refreshToken = null;
let testUserId = null;

// Fonction pour tester une route
async function testRoute(method, endpoint, data = null, description = '') {
  try {
    const config = {
      method,
      url: endpoint,
      headers: {}
    };

    if (authToken) {
      config.headers.Authorization = `Bearer ${authToken}`;
    }

    if (data) {
      config.data = data;
    }

    console.log(`\n🧪 Test: ${description}`);
    console.log(`${method.toUpperCase()} ${endpoint}`);
    
    const response = await api(config);
    
    console.log(`✅ Succès (${response.status}):`, response.data.message || 'OK');
    
    return response.data;
  } catch (error) {
    console.log(`❌ Erreur (${error.response?.status || 'Network'}):`, error.response?.data?.message || error.message);
    return null;
  }
}

// Tests des routes publiques
async function testPublicRoutes() {
  console.log('\n🚀 === TESTS DES ROUTES PUBLIQUES ===');
  
  // Test de la route de santé
  await testRoute('GET', '/health', null, 'Route de santé');
  
  // Test d'inscription
  const registerData = {
    username: 'testuser_' + Date.now(),
    fullName: 'Test User',
    email: `test${Date.now()}@example.com`,
    phone: '+33123456789',
    password: 'TestPass123!',
    platform: 'mobile'
  };
  
  const registerResult = await testRoute('POST', '/auth/register', registerData, 'Inscription utilisateur');
  
  if (registerResult && registerResult.success) {
    authToken = registerResult.data.token;
    refreshToken = registerResult.data.refreshToken;
    testUserId = registerResult.data.user.id;
    console.log('✅ Utilisateur créé avec succès');
  }
  
  // Test de connexion
  const loginData = {
    email: registerData.email,
    password: registerData.password
  };
  
  const loginResult = await testRoute('POST', '/auth/login', loginData, 'Connexion utilisateur');
  
  if (loginResult && loginResult.success) {
    authToken = loginResult.data.token;
    refreshToken = loginResult.data.refreshToken;
    console.log('✅ Connexion réussie');
  }
  
  // Test de refresh token
  if (refreshToken) {
    await testRoute('POST', '/auth/refresh', { refreshToken }, 'Refresh token');
  }
}

// Tests des routes protégées
async function testProtectedRoutes() {
  console.log('\n🔒 === TESTS DES ROUTES PROTÉGÉES ===');
  
  if (!authToken) {
    console.log('❌ Pas de token d\'authentification, impossible de tester les routes protégées');
    return;
  }
  
  // Test de récupération du profil
  await testRoute('GET', '/auth/me', null, 'Récupération du profil utilisateur');
  
  // Test de récupération du profil (route alternative)
  await testRoute('GET', '/auth/profile', null, 'Récupération du profil (route alternative)');
  
  // Test de mise à jour du profil
  const updateData = {
    full_name: 'Test User Updated',
    preferences: {
      language: 'fr',
      theme: 'dark',
      notifications: {
        push: true,
        email: true,
        sms: false
      }
    }
  };
  
  await testRoute('PUT', '/auth/profile', updateData, 'Mise à jour du profil');
  
  // Test de vérification d'authentification
  await testRoute('GET', '/auth/verify-auth', null, 'Vérification d\'authentification');
  
  // Test des statistiques
  await testRoute('GET', '/auth/stats', null, 'Statistiques utilisateur');
  
  // Test de recherche d'utilisateurs
  await testRoute('GET', '/auth/search?query=test&limit=5', null, 'Recherche d\'utilisateurs');
  
  // Test des utilisateurs populaires
  await testRoute('GET', '/auth/popular?limit=5', null, 'Utilisateurs populaires');
  
  // Test de performance
  await testRoute('GET', '/auth/performance-test', null, 'Test de performance');
}

// Tests des routes premium et vérifiées
async function testPremiumRoutes() {
  console.log('\n⭐ === TESTS DES ROUTES PREMIUM ===');
  
  if (!authToken) {
    console.log('❌ Pas de token d\'authentification');
    return;
  }
  
  // Test des fonctionnalités premium
  await testRoute('GET', '/auth/premium-features', null, 'Fonctionnalités premium');
  
  // Test des fonctionnalités vérifiées
  await testRoute('GET', '/auth/verified-features', null, 'Fonctionnalités vérifiées');
}

// Test de déconnexion
async function testLogout() {
  console.log('\n👋 === TEST DE DÉCONNEXION ===');
  
  if (!authToken) {
    console.log('❌ Pas de token d\'authentification');
    return;
  }
  
  await testRoute('POST', '/auth/logout', null, 'Déconnexion utilisateur');
  
  // Test d'accès à une route protégée après déconnexion
  await testRoute('GET', '/auth/me', null, 'Accès au profil après déconnexion (doit échouer)');
}

// Test des routes d'erreur
async function testErrorRoutes() {
  console.log('\n🚫 === TESTS DES ROUTES D\'ERREUR ===');
  
  // Test d'une route inexistante
  await testRoute('GET', '/auth/route-inexistante', null, 'Route inexistante');
  
  // Test d'inscription avec données invalides
  const invalidData = {
    username: 'a', // Trop court
    email: 'email-invalide',
    password: '123' // Trop court
  };
  
  await testRoute('POST', '/auth/register', invalidData, 'Inscription avec données invalides');
  
  // Test de connexion avec identifiants incorrects
  const invalidLogin = {
    email: 'nonexistent@example.com',
    password: 'wrongpassword'
  };
  
  await testRoute('POST', '/auth/login', invalidLogin, 'Connexion avec identifiants incorrects');
}

// Fonction principale
async function runAllTests() {
  console.log('🧪 === DÉBUT DES TESTS DE L\'API WTITNINF ===\n');
  
  try {
    await testPublicRoutes();
    await testProtectedRoutes();
    await testPremiumRoutes();
    await testLogout();
    await testErrorRoutes();
    
    console.log('\n🎉 === TOUS LES TESTS TERMINÉS ===');
    console.log('\n📊 Résumé:');
    console.log('- Routes publiques: Testées');
    console.log('- Routes protégées: Testées');
    console.log('- Routes premium: Testées');
    console.log('- Gestion d\'erreurs: Testée');
    
  } catch (error) {
    console.error('\n💥 Erreur lors des tests:', error.message);
  }
}

// Exécuter les tests si le script est appelé directement
if (require.main === module) {
  runAllTests();
}

module.exports = {
  testRoute,
  testPublicRoutes,
  testProtectedRoutes,
  testPremiumRoutes,
  testLogout,
  testErrorRoutes,
  runAllTests
};
