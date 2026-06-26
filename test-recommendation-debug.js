const axios = require('axios');

const API_BASE = 'http://51.255.48.125:3000/api';
const TEST_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImQ3NmI5YTFjLTljNTktNDkzNi04MjUxLWZjMDI1OTI1MDNkNCIsInVzZXJuYW1lIjoiZyIsImVtYWlsIjpudWxsLCJ2ZXJpZmllZCI6dHJ1ZSwicHJlbWl1bSI6dHJ1ZSwicm9sZSI6InN1cGVyYWRtaW4iLCJtb2RlcmF0aW9uX3Blcm1pc3Npb25zIjp7ImNhbl9iYW5fdXNlcnMiOnRydWUsImNhbl92ZXJpZnlfdXNlcnMiOnRydWUsImNhbl92aWV3X3JlcG9ydHMiOnRydWUsImNhbl9kZWxldGVfdHdlZXRzIjp0cnVlLCJjYW5fc3VzcGVuZF91c2VycyI6dHJ1ZSwiY2FuX3ZpZXdfYW5hbHl0aWNzIjp0cnVlLCJjYW5fbWFuYWdlX21vZGVyYXRvcnMiOnRydWV9LCJpc19zdXNwZW5kZWQiOmZhbHNlLCJzdXNwZW5zaW9uX3JlYXNvbiI6bnVsbCwic3VzcGVuZGVkX3VudGlsIjpudWxsLCJpYXQiOjE3NTU5MTUwMDUsImV4cCI6MTc1NjUxOTgwNX0.rrioV15qvsG9xPGwfrlBY66LwDeRQMoPY5-9yaVgjCg';

async function testRecommendations() {
  try {
    console.log('🧪 Test de l\'API de recommandations...');
    
    const response = await axios.get(`${API_BASE}/recommendations`, {
      params: {
        limit: 5,
        algorithm: 'hybrid',
        includeUser: true,
        includeStats: true,
        forceRefresh: true
      },
      headers: {
        'Authorization': `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Réponse API reçue');
    console.log('📊 Status:', response.status);
    console.log('📦 Données brutes:', JSON.stringify(response.data, null, 2));

    if (response.data.success && response.data.data.recommendations) {
      const recommendations = response.data.data.recommendations;
      console.log(`\n🎯 ${recommendations.length} recommandations reçues:`);
      
      recommendations.forEach((rec, index) => {
        console.log(`\n--- Recommandation ${index + 1} ---`);
        console.log('ID:', rec.id);
        console.log('Content:', rec.content ? `"${rec.content}"` : 'AUCUN CONTENU');
        console.log('Content length:', rec.content ? rec.content.length : 0);
        console.log('Author:', rec.author ? rec.author.username : 'AUCUN AUTEUR');
        console.log('Score:', rec.score);
        console.log('Keys disponibles:', Object.keys(rec));
      });
    }

  } catch (error) {
    console.error('❌ Erreur lors du test:', error.response ? {
      status: error.response.status,
      data: error.response.data
    } : error.message);
  }
}

testRecommendations();
