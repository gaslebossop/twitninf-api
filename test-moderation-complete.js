const axios = require('axios');

const API_BASE = 'http://51.255.48.125:3000/api';
let authToken = '';

// Fonction pour se connecter
async function login() {
  try {
    const response = await axios.post(`${API_BASE}/auth/login`, {
      username: 'g',
      password: 'g'
    });
    
    authToken = response.data.token;
    console.log('✅ Connexion réussie');
    console.log('👤 Rôle:', response.data.user.role);
    console.log('🔑 Permissions:', response.data.user.moderation_permissions);
    
    return true;
  } catch (error) {
    console.error('❌ Erreur de connexion:', error.response?.data || error.message);
    return false;
  }
}

// Fonction pour tester la création de données de test
async function createTestData() {
  try {
    const response = await axios.post(`${API_BASE}/moderation/test-data`, {}, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    
    console.log('✅ Données de test créées:', response.data);
    return true;
  } catch (error) {
    console.error('❌ Erreur création données de test:', error.response?.data || error.message);
    return false;
  }
}

// Fonction pour tester les signalements
async function testReports() {
  try {
    const response = await axios.get(`${API_BASE}/moderation/reports`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    
    console.log('✅ Signalements récupérés:', response.data.data.reports.length);
    return true;
  } catch (error) {
    console.error('❌ Erreur récupération signalements:', error.response?.data || error.message);
    return false;
  }
}

// Fonction pour tester les statistiques
async function testStats() {
  try {
    const response = await axios.get(`${API_BASE}/moderation/stats`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    
    console.log('✅ Statistiques récupérées:', response.data.data.stats);
    return true;
  } catch (error) {
    console.error('❌ Erreur récupération statistiques:', error.response?.data || error.message);
    return false;
  }
}

// Fonction pour tester les tendances
async function testTrends() {
  try {
    const response = await axios.get(`${API_BASE}/moderation/analytics/trends?period=7d`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    
    console.log('✅ Tendances récupérées:', response.data.data.trends);
    return true;
  } catch (error) {
    console.error('❌ Erreur récupération tendances:', error.response?.data || error.message);
    return false;
  }
}

// Fonction pour tester l'historique
async function testHistory() {
  try {
    const response = await axios.get(`${API_BASE}/moderation/history`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    
    console.log('✅ Historique récupéré:', response.data.data.history.length);
    return true;
  } catch (error) {
    console.error('❌ Erreur récupération historique:', error.response?.data || error.message);
    return false;
  }
}

// Fonction pour tester une action de modération (suspendre un utilisateur)
async function testModerationAction() {
  try {
    // D'abord, récupérer la liste des utilisateurs
    const usersResponse = await axios.get(`${API_BASE}/moderation/users?limit=5`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    
    if (usersResponse.data.data.users.length === 0) {
      console.log('⚠️ Aucun utilisateur trouvé pour tester');
      return false;
    }
    
    const testUser = usersResponse.data.data.users[0];
    console.log(`🧪 Test avec l'utilisateur: ${testUser.username}`);
    
    // Suspendre l'utilisateur
    const suspendResponse = await axios.post(`${API_BASE}/moderation/users/${testUser.id}/suspend`, {
      reason: 'Test de suspension',
      duration: 1, // 1 heure
      moderator_note: 'Test automatique'
    }, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    
    console.log('✅ Utilisateur suspendu:', suspendResponse.data);
    
    // Attendre un peu
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Lever la suspension
    const unsuspendResponse = await axios.post(`${API_BASE}/moderation/users/${testUser.id}/unsuspend`, {
      reason: 'Test terminé'
    }, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    
    console.log('✅ Suspension levée:', unsuspendResponse.data);
    
    return true;
  } catch (error) {
    console.error('❌ Erreur test action modération:', error.response?.data || error.message);
    return false;
  }
}

// Fonction principale de test
async function runTests() {
  console.log('🚀 Démarrage des tests de modération...\n');
  
  // Test de connexion
  if (!await login()) {
    console.log('❌ Impossible de continuer sans connexion');
    return;
  }
  
  console.log('\n📊 Test des fonctionnalités de base...');
  
  // Test création de données de test
  await createTestData();
  
  // Test des signalements
  await testReports();
  
  // Test des statistiques
  await testStats();
  
  // Test des tendances
  await testTrends();
  
  // Test de l'historique
  await testHistory();
  
  console.log('\n🔧 Test des actions de modération...');
  
  // Test d'une action de modération
  await testModerationAction();
  
  console.log('\n✅ Tests terminés !');
}

// Lancer les tests
runTests().catch(console.error);
