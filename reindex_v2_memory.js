const { Pool } = require('pg');
const { createLocalEmbedQuery } = require('./src/services/policiercongo/policiercongoV2Embeddings');
const logger = console;

const DB_CONFIG = {
  host: "51.255.48.125",
  port: 5432,
  database: "twitninf",
  user: "admin",
  password: "myytree88",
  ssl: false
};

async function reindexMemory() {
  console.log('🔄 DÉBUT DE LA RÉ-INDEXATION MASSIVE (E5-Base 768-dim)');
  const pool = new Pool(DB_CONFIG);
  
  // On crée l'embedder E5 (mode passage/document par défaut)
  const embedDoc = createLocalEmbedQuery({ isQuery: false });

  try {
    // 1. Récupération de tous les souvenirs
    console.log('📥 Lecture de la base de données...');
    const { rows: allMemories } = await pool.query(
      "SELECT id, source_text FROM policiercongo_v2_embeddings ORDER BY id ASC"
    );
    
    console.log(`📊 ${allMemories.length} souvenirs à traiter.`);

    const start = Date.now();
    let success = 0;
    let errors = 0;

    // 2. Traitement un par un (plus sûr pour la RAM)
    for (let i = 0; i < allMemories.length; i++) {
      const memory = allMemories[i];
      process.stdout.write(`\r⏳ Progression : ${i + 1}/${allMemories.length} ... `);

      try {
        const newEmbedding = await embedDoc(memory.source_text);
        if (newEmbedding && newEmbedding.length > 0) {
          await pool.query(
            "UPDATE policiercongo_v2_embeddings SET embedding = $1::jsonb WHERE id = $2",
            [JSON.stringify(newEmbedding), memory.id]
          );
          success++;
        } else {
          errors++;
        }
      } catch (err) {
        console.error(`\n❌ Erreur sur ID ${memory.id}:`, err.message);
        errors++;
      }
    }

    const end = Date.now();
    console.log(`\n\n✅ RÉ-INDEXATION TERMINÉE !`);
    console.log(`⏱️ Durée totale : ${((end - start) / 1000).toFixed(2)}s`);
    console.log(`📈 Succès : ${success}`);
    console.log(`📉 Échecs : ${errors}`);
    console.log(`🚀 PolicierCongo utilise maintenant des vecteurs 768-dim.`);

  } catch (err) {
    console.error('❌ Erreur critique pendant la migration:', err.message);
  } finally {
    await pool.end();
  }
}

reindexMemory();
