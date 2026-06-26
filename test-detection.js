const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:3000/api/detection';

async function testDetection() {
  console.log('🚀 Test de la nouvelle route /api/detection...');

  try {
    // 1. Envoyer une requête GET avec des paramètres
    console.log('\n--- Test GET ---');
    const getRes = await axios.get(`${API_URL}?test_id=123&source=agent_test&message=hello`);
    console.log('Statut:', getRes.status);
    console.log('Réponse:', getRes.data);

    // 2. Envoyer une requête POST avec un corps et des paramètres
    console.log('\n--- Test POST ---');
    const postRes = await axios.post(`${API_URL}?query_param=important`, {
      payload: 'données de test',
      type: 'signalement'
    });
    console.log('Statut:', postRes.status);
    console.log('Réponse:', postRes.data);

    // 3. Vérifier le fichier detections.json
    console.log('\n--- Vérification du fichier JSON ---');
    const filePath = path.join(__dirname, 'storage', 'detections.json');
    if (fs.existsSync(filePath)) {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      console.log(`Nombre d'entrées trouvées: ${content.length}`);
      console.log('Dernière entrée:', JSON.stringify(content[content.length - 1], null, 2));
    } else {
      console.log('❌ Erreur: Le fichier storage/detections.json n\'a pas été créé.');
    }

  } catch (error) {
    console.error('❌ Erreur lors du test:', error.response ? error.response.data : error.message);
    console.log('\n💡 Assurez-vous que le serveur tourne sur le port 3000 (npm run dev)');
  }
}

testDetection();
