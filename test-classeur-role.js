const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000';

async function testClasseurRole() {
  try {
    console.log('🧪 Test du rôle classeurdetweets\n');

    // 1. Créer un utilisateur classeur de tweets
    console.log('1. Création d\'un utilisateur classeur de tweets...');
    const registerResponse = await axios.post(`${API_BASE_URL}/api/auth/register`, {
      username: 'classeur_test',
      email: 'classeur@test.com',
      password: 'TestPassword123!',
      full_name: 'Classeur Test'
    });

    if (!registerResponse.data.success) {
      console.error('❌ Erreur lors de l\'inscription:', registerResponse.data.message);
      return;
    }

    const token = registerResponse.data.data.token;
    console.log('✅ Utilisateur créé avec succès');

    // 2. Promouvoir l'utilisateur au rôle classeurdetweets
    console.log('\n2. Attribution du rôle classeurdetweets...');
    
    // D'abord, se connecter en tant que superadmin pour modifier le rôle
    const adminLoginResponse = await axios.post(`${API_BASE_URL}/api/auth/login`, {
      identifier: 'g',
      password: 'password'
    });

    if (!adminLoginResponse.data.success) {
      console.error('❌ Erreur de connexion admin:', adminLoginResponse.data.message);
      return;
    }

    const adminToken = adminLoginResponse.data.data.token;
    const userId = registerResponse.data.data.user.id;

    // Modifier le rôle de l'utilisateur
    const updateRoleResponse = await axios.put(`${API_BASE_URL}/api/moderation/moderators/${userId}/role`, {
      new_role: 'classeurdetweets'
    }, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    if (!updateRoleResponse.data.success) {
      console.error('❌ Erreur lors de la modification du rôle:', updateRoleResponse.data.message);
      return;
    }

    console.log('✅ Rôle classeurdetweets attribué avec succès');

    // 3. Se reconnecter avec le nouvel utilisateur pour obtenir les bonnes permissions
    console.log('\n3. Reconnexion avec les nouvelles permissions...');
    const newLoginResponse = await axios.post(`${API_BASE_URL}/api/auth/login`, {
      identifier: 'classeur_test',
      password: 'TestPassword123!'
    });

    if (!newLoginResponse.data.success) {
      console.error('❌ Erreur de reconnexion:', newLoginResponse.data.message);
      return;
    }

    const classeurToken = newLoginResponse.data.data.token;
    const userWithRole = newLoginResponse.data.data.user;

    console.log('✅ Reconnexion réussie');
    console.log('👤 Utilisateur:', userWithRole.username);
    console.log('🎭 Rôle:', userWithRole.role);
    console.log('🔐 Permissions:', JSON.stringify(userWithRole.moderation_permissions, null, 2));

    // 4. Tester l'accès aux tweets de modération
    console.log('\n4. Test d\'accès aux tweets de modération...');
    const tweetsResponse = await axios.get(`${API_BASE_URL}/api/moderation/tweets`, {
      headers: { Authorization: `Bearer ${classeurToken}` }
    });

    if (tweetsResponse.data.success) {
      console.log('✅ Accès aux tweets autorisé');
      console.log('📊 Nombre de tweets:', tweetsResponse.data.data.tweets.length);
    } else {
      console.log('❌ Accès aux tweets refusé:', tweetsResponse.data.message);
    }

    // 5. Tester l'accès aux signalements (devrait être refusé)
    console.log('\n5. Test d\'accès aux signalements (devrait être refusé)...');
    try {
      const reportsResponse = await axios.get(`${API_BASE_URL}/api/moderation/reports`, {
        headers: { Authorization: `Bearer ${classeurToken}` }
      });
      
      if (reportsResponse.data.success) {
        console.log('⚠️ Accès aux signalements autorisé (inattendu)');
      } else {
        console.log('✅ Accès aux signalements refusé comme attendu:', reportsResponse.data.message);
      }
    } catch (error) {
      if (error.response?.status === 403) {
        console.log('✅ Accès aux signalements refusé comme attendu (403)');
      } else {
        console.log('❌ Erreur inattendue:', error.message);
      }
    }

    // 6. Tester l'accès à la gestion des utilisateurs (devrait être refusé)
    console.log('\n6. Test d\'accès à la gestion des utilisateurs (devrait être refusé)...');
    try {
      const usersResponse = await axios.get(`${API_BASE_URL}/api/moderation/users`, {
        headers: { Authorization: `Bearer ${classeurToken}` }
      });
      
      if (usersResponse.data.success) {
        console.log('⚠️ Accès à la gestion des utilisateurs autorisé (inattendu)');
      } else {
        console.log('✅ Accès à la gestion des utilisateurs refusé comme attendu:', usersResponse.data.message);
      }
    } catch (error) {
      if (error.response?.status === 403) {
        console.log('✅ Accès à la gestion des utilisateurs refusé comme attendu (403)');
      } else {
        console.log('❌ Erreur inattendue:', error.message);
      }
    }

    console.log('\n🎉 Test du rôle classeurdetweets terminé !');

  } catch (error) {
    console.error('❌ Erreur lors du test:', error.response?.data || error.message);
  }
}

testClasseurRole();
