
const { MemoryManager } = require('./src/services/policiercongo/index');
const logger = require('./src/utils/logger');
const { sequelize } = require('./src/models');

async function testBridge() {
  try {
    const { memoryManager } = require('./src/services/policiercongo/index');
    console.log('🚀 Test du Pont Mémoire V1 -> V2...');
    const mm = memoryManager;

    const testId = `test_bridge_${Date.now()}`;
    const testUsername = 'gas_test_unif';

    console.log(`📝 Création d'une interaction significative pour @${testUsername}...`);
    
    await mm.addSignificantInteraction({
      user_id: '88888888-4444-4444-4444-888888888888',
      user_username: testUsername,
      content: 'Wesh PolicierCongo, fais moi une dédicace pour le quartier !',
      type: 'dedication_request',
      importance: 'high',
      user_request: 'Demande de dédicace quartier'
    });

    console.log('⏳ Attente du chargement du modèle et de l\'embedding (8s)...');
    await new Promise(r => setTimeout(r, 8000));

    console.log('🔍 Vérification dans la base vectorielle V2...');
    const [rows] = await sequelize.query(
      `SELECT source_text, metadata FROM policiercongo_v2_embeddings 
       WHERE metadata->>'user_username' = :username 
       ORDER BY created_at DESC LIMIT 1`,
      { replacements: { username: testUsername } }
    );

    if (rows.length > 0) {
      console.log('✅ SUCCÈS : Le souvenir a été correctement vectorisé et taggué !');
      console.log('Source:', rows[0].source_text);
      console.log('Meta:', JSON.stringify(rows[0].metadata));
    } else {
      console.log('❌ ÉCHEC : Le souvenir n\'a pas été trouvé dans la base V2.');
    }

  } catch (err) {
    console.error('❌ Erreur pendant le test:', err);
  } finally {
    process.exit();
  }
}

testBridge();
