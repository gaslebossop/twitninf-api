const axios = require('axios');

const API_BASE = 'http://localhost:3000/api';

// Token d'un super admin (à remplacer par un vrai token)
const ADMIN_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImQ3NmI5YTFjLTljNTktNDkzNi04MjUxLWZjMDI1OTI1MDNkNCIsInVzZXJuYW1lIjoiZyIsImVtYWlsIjpudWxsLCJ2ZXJpZmllZCI6dHJ1ZSwicHJlbWl1bSI6dHJ1ZSwicm9sZSI6InN1cGVyYWRtaW4iLCJtb2RlcmF0aW9uX3Blcm1pc3Npb25zIjp7ImNhbl9iYW5fdXNlcnMiOnRydWUsImNhbl92ZXJpZnlfdXNlcnMiOnRydWUsImNhbl92aWV3X3JlcG9ydHMiOnRydWUsImNhbl9kZWxldGVfdHdlZXRzIjp0cnVlLCJjYW5fc3VzcGVuZF91c2VycyI6dHJ1ZSwiY2FuX3ZpZXdfYW5hbHl0aWNzIjp0cnVlLCJjYW5fbWFuYWdlX21vZGVyYXRvcnMiOnRydWV9LCJpc19zdXNwZW5kZWQiOmZhbHNlLCJzdXNwZW5zaW9uX3JlYXNvbiI6bnVsbCwic3VzcGVuZGVkX3VudGlsIjpudWxsLCJpYXQiOjE3NTU4NzAxODMsImV4cCI6MTc1NjQ3NDk4M30.6gSycH1x9xEJTRv3_zV2WfgRxtsoVPZ4cVr9GDwiXi0';

const headers = {
  'Authorization': `Bearer ${ADMIN_TOKEN}`,
  'Content-Type': 'application/json',
  'User-Platform': 'test'
};

async function testBanAPI() {
  try {
    console.log('🧪 Test de l\'API de bannissement...\n');

    // 1. Récupérer la liste des utilisateurs
    console.log('1. Récupération de la liste des utilisateurs...');
    const usersResponse = await axios.get(`${API_BASE}/moderation/users?limit=5`, { headers });
    console.log(`✅ ${usersResponse.data.data.users.length} utilisateurs récupérés`);

    if (usersResponse.data.data.users.length === 0) {
      console.log('❌ Aucun utilisateur trouvé pour tester');
      return;
    }

    // Prendre le premier utilisateur non-admin pour le test
    const testUser = usersResponse.data.data.users.find(user => 
      user.role === 'user' && !user.is_suspended
    );

    if (!testUser) {
      console.log('❌ Aucun utilisateur non-admin disponible pour le test');
      return;
    }

    console.log(`📝 Utilisateur de test: @${testUser.username} (${testUser.id})`);

    // 2. Tester le bannissement
    console.log('\n2. Test du bannissement...');
    const banData = {
      reason: 'Test de bannissement automatique',
      permanent: false
    };

    console.log('📦 Données envoyées:', banData);
    
    const banResponse = await axios.post(
      `${API_BASE}/moderation/users/${testUser.id}/ban`,
      banData,
      { headers }
    );

    console.log('✅ Bannissement réussi!');
    console.log('📄 Réponse:', JSON.stringify(banResponse.data, null, 2));

    // 3. Vérifier que l'utilisateur est bien banni
    console.log('\n3. Vérification du statut de bannissement...');
    const userDetailsResponse = await axios.get(
      `${API_BASE}/moderation/users/${testUser.id}`,
      { headers }
    );

    const updatedUser = userDetailsResponse.data.data.user;
    console.log(`📊 Statut utilisateur: is_suspended=${updatedUser.is_suspended}`);
    console.log(`📊 Raison: ${updatedUser.suspension_reason}`);

    if (updatedUser.is_suspended) {
      console.log('✅ Utilisateur correctement banni!');
    } else {
      console.log('❌ L\'utilisateur n\'est pas banni');
    }

    // 4. Tester le débannissement
    console.log('\n4. Test du débannissement...');
    const unbanData = {
      reason: 'Test de débannissement automatique'
    };

    const unbanResponse = await axios.post(
      `${API_BASE}/moderation/users/${testUser.id}/unban`,
      unbanData,
      { headers }
    );

    console.log('✅ Débannissement réussi!');
    console.log('📄 Réponse:', JSON.stringify(unbanResponse.data, null, 2));

    console.log('\n🎉 Tous les tests sont passés avec succès!');

  } catch (error) {
    console.error('❌ Erreur lors du test:', error.response?.data || error.message);
    
    if (error.response) {
      console.error('📊 Status:', error.response.status);
      console.error('📄 Headers:', error.response.headers);
    }
  }
}

// Lancer le test
testBanAPI();
