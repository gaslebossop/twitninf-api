const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000';

async function testModerationActions() {
  try {
    console.log('🧪 Test des actions de modération\n');

    // 1. Se connecter en tant que superadmin
    console.log('1. Connexion en tant que superadmin...');
    const adminLoginResponse = await axios.post(`${API_BASE_URL}/api/auth/login`, {
      identifier: 'g',
      password: 'password'
    });

    if (!adminLoginResponse.data.success) {
      console.error('❌ Erreur de connexion admin:', adminLoginResponse.data.message);
      return;
    }

    const adminToken = adminLoginResponse.data.data.token;
    console.log('✅ Connexion admin réussie');

    // 2. Créer un utilisateur test
    console.log('\n2. Création d\'un utilisateur test...');
    const testUserResponse = await axios.post(`${API_BASE_URL}/api/auth/register`, {
      username: 'test_moderation',
      email: 'test.moderation@example.com',
      password: 'TestPassword123!',
      full_name: 'Test Modération'
    });

    if (!testUserResponse.data.success) {
      console.log('⚠️ Utilisateur test existe déjà, on continue...');
    } else {
      console.log('✅ Utilisateur test créé');
    }

    // 3. Récupérer les utilisateurs pour obtenir l'ID
    console.log('\n3. Récupération de la liste des utilisateurs...');
    const usersResponse = await axios.get(`${API_BASE_URL}/api/moderation/users`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    if (!usersResponse.data.success) {
      console.error('❌ Erreur lors de la récupération des utilisateurs:', usersResponse.data.message);
      return;
    }

    const testUser = usersResponse.data.data.users.find(u => u.username === 'test_moderation');
    if (!testUser) {
      console.error('❌ Utilisateur test non trouvé');
      return;
    }

    console.log('✅ Utilisateur test trouvé:', testUser.username, '-', testUser.id);

    // 4. Tester la vérification
    console.log('\n4. Test de vérification d\'utilisateur...');
    const verifyResponse = await axios.put(`${API_BASE_URL}/api/moderation/users/${testUser.id}/verify`, {}, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    if (verifyResponse.data.success) {
      console.log('✅ Vérification réussie');
    } else {
      console.log('⚠️ Erreur de vérification:', verifyResponse.data.message);
    }

    // 5. Tester la suppression de vérification
    console.log('\n5. Test de suppression de vérification...');
    const unverifyResponse = await axios.put(`${API_BASE_URL}/api/moderation/users/${testUser.id}/unverify`, {}, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    if (unverifyResponse.data.success) {
      console.log('✅ Suppression de vérification réussie');
    } else {
      console.log('⚠️ Erreur de suppression de vérification:', unverifyResponse.data.message);
    }

    // 6. Tester la suspension
    console.log('\n6. Test de suspension d\'utilisateur...');
    const suspendResponse = await axios.post(`${API_BASE_URL}/api/moderation/users/${testUser.id}/suspend`, {
      reason: 'Test de suspension depuis le script',
      duration: 7
    }, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    if (suspendResponse.data.success) {
      console.log('✅ Suspension réussie');
    } else {
      console.log('⚠️ Erreur de suspension:', suspendResponse.data.message);
    }

    // 7. Tester la levée de suspension
    console.log('\n7. Test de levée de suspension...');
    const unsuspendResponse = await axios.post(`${API_BASE_URL}/api/moderation/users/${testUser.id}/unsuspend`, {}, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    if (unsuspendResponse.data.success) {
      console.log('✅ Levée de suspension réussie');
    } else {
      console.log('⚠️ Erreur de levée de suspension:', unsuspendResponse.data.message);
    }

    // 8. Récupérer les tweets pour tester la modération de contenu
    console.log('\n8. Récupération des tweets pour test de modération...');
    const tweetsResponse = await axios.get(`${API_BASE_URL}/api/moderation/tweets`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    if (tweetsResponse.data.success && tweetsResponse.data.data.tweets.length > 0) {
      const testTweet = tweetsResponse.data.data.tweets[0];
      console.log('✅ Tweet test trouvé:', testTweet.id);

      // 9. Tester l'approbation de tweet
      console.log('\n9. Test d\'approbation de tweet...');
      const approveTweetResponse = await axios.put(`${API_BASE_URL}/api/moderation/tweets/${testTweet.id}/approve`, {}, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      if (approveTweetResponse.data.success) {
        console.log('✅ Approbation de tweet réussie');
      } else {
        console.log('⚠️ Erreur d\'approbation:', approveTweetResponse.data.message);
      }

      // 10. Tester le rejet de tweet
      console.log('\n10. Test de rejet de tweet...');
      const rejectTweetResponse = await axios.put(`${API_BASE_URL}/api/moderation/tweets/${testTweet.id}/reject`, {
        reason: 'Test de rejet depuis le script'
      }, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      if (rejectTweetResponse.data.success) {
        console.log('✅ Rejet de tweet réussi');
      } else {
        console.log('⚠️ Erreur de rejet:', rejectTweetResponse.data.message);
      }
    } else {
      console.log('⚠️ Aucun tweet disponible pour les tests');
    }

    console.log('\n🎉 Tests des actions de modération terminés !');

  } catch (error) {
    console.error('❌ Erreur lors des tests:', error.response?.data || error.message);
  }
}

testModerationActions();

