const axios = require('axios');

const API_BASE = 'http://51.255.48.125:3000/api';
const TEST_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImQ3NmI5YTFjLTljNTktNDkzNi04MjUxLWZjMDI1OTI1MDNkNCIsInVzZXJuYW1lIjoiZyIsImVtYWlsIjpudWxsLCJ2ZXJpZmllZCI6dHJ1ZSwicHJlbWl1bSI6dHJ1ZSwicm9sZSI6InN1cGVyYWRtaW4iLCJtb2RlcmF0aW9uX3Blcm1pc3Npb25zIjp7ImNhbl9iYW5fdXNlcnMiOnRydWUsImNhbl92ZXJpZnlfdXNlcnMiOnRydWUsImNhbl92aWV3X3JlcG9ydHMiOnRydWUsImNhbl9kZWxldGVfdHdlZXRzIjp0cnVlLCJjYW5fc3VzcGVuZF91c2VycyI6dHJ1ZSwiY2FuX3ZpZXdfYW5hbHl0aWNzIjp0cnVlLCJjYW5fbWFuYWdlX21vZGVyYXRvcnMiOnRydWV9LCJpc19zdXNwZW5kZWQiOmZhbHNlLCJzdXNwZW5zaW9uX3JlYXNvbiI6bnVsbCwic3VzcGVuZGVkX3VudGlsIjpudWxsLCJpYXQiOjE3NTU5MTUwMDUsImV4cCI6MTc1NjUxOTgwNX0.rrioV15qvsG9xPGwfrlBY66LwDeRQMoPY5-9yaVgjCg';

async function testAlgorithms() {
  try {
    console.log('🧪 Test des différents algorithmes de recommandation...\n');

    const algorithms = [
      'hybrid',
      'behavioral',
      'trending',
      'social',
      'content',
      'discovery',
      'popularity'
    ];

    for (const algorithm of algorithms) {
      try {
        console.log(`📊 Test de l'algorithme: ${algorithm}`);
        
        const response = await axios.get(`${API_BASE}/recommendations`, {
          params: {
            limit: 3,
            algorithm,
            includeUser: true,
            includeStats: true,
            forceRefresh: true
          },
          headers: {
            'Authorization': `Bearer ${TEST_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });

        if (response.data.success) {
          const recommendations = response.data.data.recommendations;
          console.log(`✅ ${algorithm}: ${recommendations.length} recommandations reçues`);
          
          if (recommendations.length > 0) {
            const firstRec = recommendations[0];
            console.log(`   - Premier tweet ID: ${firstRec.id || 'MANQUANT'}`);
            console.log(`   - Contenu: ${firstRec.content ? `"${firstRec.content.substring(0, 30)}..."` : 'MANQUANT'}`);
            console.log(`   - Auteur: ${firstRec.author ? firstRec.author.username : 'MANQUANT'}`);
            console.log(`   - Score: ${firstRec.score || 'MANQUANT'}`);
          }
        } else {
          console.log(`❌ ${algorithm}: Erreur - ${response.data.error}`);
        }
        console.log('');
        
      } catch (algoError) {
        console.log(`❌ ${algorithm}: Erreur lors du test - ${algoError.message}\n`);
      }
    }

  } catch (error) {
    console.error('❌ Erreur générale lors du test:', error.message);
  }
}

testAlgorithms();
