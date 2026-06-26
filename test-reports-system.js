const axios = require('axios');

const API_BASE_URL = 'http://51.255.48.125:3000/api';

// Token d'authentification (remplacez par un token valide)
const AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImQ3NmI5YTFjLTljNTktNDkzNi04MjUxLWZjMDI1OTI1MDNkNCIsInVzZXJuYW1lIjoiZyIsImVtYWlsIjpudWxsLCJ2ZXJpZmllZCI6dHJ1ZSwicHJlbWl1bSI6dHJ1ZSwicm9sZSI6InN1cGVyYWRtaW4iLCJtb2RlcmF0aW9uX3Blcm1pc3Npb25zIjp7ImNhbl9iYW5fdXNlcnMiOnRydWUsImNhbl92ZXJpZnlfdXNlcnMiOnRydWV9LCJpc19zdXNwZW5kZWQiOmZhbHNlLCJiYW5fY291bnQiOjAsInN1c3BlbnNpb25fcmVhc29uIjpudWxsLCJzdXNwZW5kZWRfdW50aWwiOm51bGwsImlhdCI6MTc1NTgyMTcxMCwiZXhwIjoxNzU2NDI2NTEwfQ.Fgt4bai8_yzWAp4_eyiiyaSyaYATJFI8xQ7BVLeEldE';

const headers = {
  'Authorization': `Bearer ${AUTH_TOKEN}`,
  'Content-Type': 'application/json'
};

async function testReportsSystem() {
  console.log('🧪 Test du système de signalements...\n');

  try {
    // 1. Créer un signalement
    console.log('1️⃣ Création d\'un signalement...');
    const createReportData = {
      target_id: '35fa400f-e563-4cb7-b060-dfa3b919ae6b', // ID d'un tweet existant
      target_type: 'tweet',
      reason: 'Contenu inapproprié',
      severity: 'medium'
    };

    const createResponse = await axios.post(`${API_BASE_URL}/moderation/reports`, createReportData, { headers });
    console.log('✅ Signalement créé:', createResponse.data);
    const reportId = createResponse.data.data.report.id;

    // 2. Récupérer la liste des signalements
    console.log('\n2️⃣ Récupération de la liste des signalements...');
    const getReportsResponse = await axios.get(`${API_BASE_URL}/moderation/reports`, { headers });
    console.log('✅ Signalements récupérés:', getReportsResponse.data.data.reports.length);

    // 3. Mettre à jour le statut d'un signalement
    console.log('\n3️⃣ Mise à jour du statut du signalement...');
    const updateData = {
      status: 'investigating',
      moderator_notes: 'En cours d\'investigation',
      resolution_action: 'warn',
      resolution_reason: 'Premier avertissement'
    };

    const updateResponse = await axios.put(`${API_BASE_URL}/moderation/reports/${reportId}`, updateData, { headers });
    console.log('✅ Statut mis à jour:', updateResponse.data);

    // 4. Récupérer les statistiques de modération
    console.log('\n4️⃣ Récupération des statistiques...');
    const statsResponse = await axios.get(`${API_BASE_URL}/moderation/stats`, { headers });
    console.log('✅ Statistiques récupérées:', statsResponse.data.data.stats);

    console.log('\n🎉 Tous les tests sont passés avec succès !');

  } catch (error) {
    console.error('❌ Erreur lors du test:', error.response?.data || error.message);
  }
}

// Exécuter le test
testReportsSystem();
