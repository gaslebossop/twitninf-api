const axios = require('axios');
const logger = require('../utils/logger');

// Configuration de base
const BASE_URL = 'http://localhost:3000/api';
let authToken = null;

// Fonction pour se connecter et obtenir un token
async function login() {
  try {
    const response = await axios.post(`${BASE_URL}/auth/login`, {
      username: 'testuser',
      password: 'testpass123'
    });

    if (response.data.success) {
      authToken = response.data.token;
      console.log('✅ Connexion réussie');
      return true;
    } else {
      console.log('❌ Échec de la connexion:', response.data.message);
      return false;
    }
  } catch (error) {
    console.log('❌ Erreur de connexion:', error.response?.data?.message || error.message);
    return false;
  }
}

// Configuration axios avec le token d'authentification
const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Intercepteur pour ajouter le token à chaque requête
api.interceptors.request.use((config) => {
  if (authToken) {
    config.headers.Authorization = `Bearer ${authToken}`;
  }
  return config;
});

// Test des routes de monétisation
async function testMonetizationRoutes() {
  console.log('\n🧪 Test des routes de monétisation...\n');

  try {
    // Test 1: Obtenir les tweets éligibles
    console.log('1️⃣ Test - Obtenir les tweets éligibles');
    const eligibleTweetsResponse = await api.get('/monetization/eligible-tweets');
    console.log('✅ Tweets éligibles récupérés:', eligibleTweetsResponse.data.data.tweets.length);
    console.log('📊 Données:', JSON.stringify(eligibleTweetsResponse.data.data, null, 2));

    // Test 2: Obtenir les revenus utilisateur
    console.log('\n2️⃣ Test - Obtenir les revenus utilisateur');
    const revenueResponse = await api.get('/monetization/revenue?period=month');
    console.log('✅ Revenus récupérés:', revenueResponse.data.data);
    console.log('💰 Revenu total:', revenueResponse.data.data.totalRevenue);

    // Test 3: Obtenir les statistiques globales
    console.log('\n3️⃣ Test - Obtenir les statistiques globales');
    const statsResponse = await api.get('/monetization/stats');
    console.log('✅ Statistiques récupérées:', statsResponse.data.data);

    // Test 4: Simuler l'engagement (si des tweets existent)
    if (eligibleTweetsResponse.data.data.tweets.length > 0) {
      const firstTweet = eligibleTweetsResponse.data.data.tweets[0];
      console.log('\n4️⃣ Test - Simuler l\'engagement pour le tweet:', firstTweet.id);
      
      const simulateResponse = await api.post(`/monetization/tweets/${firstTweet.id}/simulate`);
      console.log('✅ Simulation réussie:', simulateResponse.data.data);
    }

    // Test 5: Mettre à jour les métriques (si des tweets existent)
    if (eligibleTweetsResponse.data.data.tweets.length > 0) {
      const firstTweet = eligibleTweetsResponse.data.data.tweets[0];
      console.log('\n5️⃣ Test - Mettre à jour les métriques pour le tweet:', firstTweet.id);
      
      const updateData = {
        views: 15000,
        clicks: 750,
        revenue: 375.50
      };
      
      const updateResponse = await api.put(`/monetization/tweets/${firstTweet.id}/metrics`, updateData);
      console.log('✅ Métriques mises à jour:', updateResponse.data.data);
    }

    console.log('\n🎉 Tous les tests de monétisation sont passés avec succès !');

  } catch (error) {
    console.error('❌ Erreur lors des tests:', error.response?.data || error.message);
  }
}

// Test de performance
async function testPerformance() {
  console.log('\n⚡ Test de performance...\n');

  try {
    const startTime = Date.now();
    
    // Test de récupération des tweets éligibles avec pagination
    const response = await api.get('/monetization/eligible-tweets?limit=50&offset=0');
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log(`⏱️ Temps de réponse: ${duration}ms`);
    console.log(`📊 Tweets récupérés: ${response.data.data.tweets.length}`);
    console.log(`📈 Performance: ${response.data.data.tweets.length / (duration / 1000)} tweets/seconde`);

  } catch (error) {
    console.error('❌ Erreur lors du test de performance:', error.response?.data || error.message);
  }
}

// Test des critères d'éligibilité
async function testEligibilityCriteria() {
  console.log('\n🎯 Test des critères d\'éligibilité...\n');

  try {
    // Test avec différents critères
    const criteriaTests = [
      { minViews: 1000, minEngagement: 0.01 },
      { minViews: 5000, minEngagement: 0.02 },
      { minViews: 10000, minEngagement: 0.05 }
    ];

    for (const criteria of criteriaTests) {
      console.log(`🔍 Test avec critères: ${JSON.stringify(criteria)}`);
      
      const response = await api.get(`/monetization/eligible-tweets?minViews=${criteria.minViews}&minEngagement=${criteria.minEngagement}`);
      
      console.log(`✅ Tweets éligibles: ${response.data.data.tweets.length}`);
      
      if (response.data.data.tweets.length > 0) {
        const firstTweet = response.data.data.tweets[0];
        console.log(`📊 Exemple - Vues: ${firstTweet.stats.views}, RPM: ${firstTweet.monetization.rpm}`);
      }
    }

  } catch (error) {
    console.error('❌ Erreur lors du test des critères:', error.response?.data || error.message);
  }
}

// Fonction principale
async function runMonetizationTests() {
  console.log('🚀 Démarrage des tests de monétisation...\n');

  // Se connecter d'abord
  const loginSuccess = await login();
  if (!loginSuccess) {
    console.log('❌ Impossible de continuer sans authentification');
    return;
  }

  // Exécuter tous les tests
  await testMonetizationRoutes();
  await testPerformance();
  await testEligibilityCriteria();

  console.log('\n🎯 Tests de monétisation terminés !');
}

// Exécuter les tests si le fichier est appelé directement
if (require.main === module) {
  runMonetizationTests().catch(console.error);
}

module.exports = {
  runMonetizationTests,
  testMonetizationRoutes,
  testPerformance,
  testEligibilityCriteria
};

