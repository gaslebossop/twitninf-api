const { createPostgresAdapters } = require('./src/services/policiercongo/policiercongoV2.memoryAdapters');
const { Pool } = require('pg');
const { createLocalEmbedQuery } = require('./src/services/policiercongo/policiercongoV2Embeddings');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Configuration manuelle pour le debug (plus simple que de tout importer)
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'twitninf',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD,
  ssl: false
};

async function debugGasMemory() {
  console.log('🧪 Simulation de la mémoire de PolicierCongo...');
  
  const pool = new Pool(DB_CONFIG);
  
  // On mocke logger pour éviter les bruits
  const logger = { info: console.log, warn: console.warn, error: console.error };
  
  // On initialise les adapteurs (le même code que la prod)
  const memory = createPostgresAdapters({ 
    pgPool: pool, 
    logger,
    // On n'a pas besoin d'embeddings réels pour tester le SQL ILIKE de la recherche hybride
    // mais on va quand même essayer de charger si possible.
    embedQuery: createLocalEmbedQuery({ isQuery: true })
  });

  const query = "tu connais @gas ?";
  console.log(`\n🔎 Requête : "${query}"`);

  try {
    const { rows: countRows } = await pool.query("SELECT count(*) FROM policiercongo_v2_embeddings");
    console.log(`📊 Total dans la table embeddings : ${countRows[0].count} lignes.`);

    // On appelle vectorSearch (ce que fait le bot en DM)
    const hits = await memory.vectorSearch(query, { limit: 20, global: true });

    console.log(`\n📊 Résultats trouvés : ${hits.length}`);
    
    if (hits.length === 0) {
      console.log('❌ AUCUN souvenir trouvé. Quelque chose ne va pas.');
    } else {
      hits.forEach((h, i) => {
        const role = h.metadata?.role || 'user';
        const speaker = role === 'assistant' ? 'MOI (Bot)' : (h.metadata?.user_username || 'Inconnu');
        
        console.log(`\n[${i+1}] 🕒 ${h.metadata?.timestamp || 'Date inconnue'}`);
        console.log(`    Auteur : ${speaker} ${role === 'assistant' ? '🤖' : '👤'}`);
        console.log(`    Texte  : "${(h.source_text || h.text || '').substring(0, 200)}..."`);
        console.log(`    Score  : ${h.score || 'N/A'}`);
        console.log(`    Meta   : ${JSON.stringify(h.metadata)}`);
      });
      
      console.log('\n✅ CONCLUSION : Si tu vois des messages de Gas ci-dessus, le bot les verra aussi dans son prompt.');
    }

  } catch (err) {
    console.error('❌ Erreur pendant la simulation:', err);
  } finally {
    await pool.end();
  }
}

debugGasMemory();
