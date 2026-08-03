const { Client } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT, 10) || 5432;
const DB_NAME = process.env.DB_NAME || 'twitninf'; // Correction du nom de la DB
const DB_USER = process.env.DB_USER || 'admin';
const DB_PASSWORD = process.env.DB_PASSWORD;

async function checkGas() {
  const client = new Client({
    host: DB_HOST,
    port: DB_PORT,
    database: DB_NAME,
    user: DB_USER,
    password: DB_PASSWORD,
    ssl: false
  });

  try {
    await client.connect();
    // 1. Trouver l'ID de "gas"
    console.log('🔍 Recherche de l\'UUID pour le username "gas"...');
    const { rows: userRows } = await client.query(
      "SELECT id, username FROM users WHERE username ILIKE 'gas' LIMIT 1"
    );

    if (userRows.length === 0) {
      console.log('❌ Utilisateur "gas" non trouvé dans la table users.');
    } else {
      const gasId = userRows[0].id;
      console.log(`✅ Utilisateur "gas" trouvé : UUID = ${gasId}`);

      // 2. Chercher les souvenirs par user_id
      const { rows: memoryRows } = await client.query(
        "SELECT source_text, metadata, created_at FROM policiercongo_v2_embeddings WHERE user_id::text = $1::text LIMIT 10",
        [gasId]
      );

      if (memoryRows.length === 0) {
        console.log(`❌ Aucun souvenir rattaché à l'ID ${gasId} dans la table embeddings.`);
      } else {
        console.log(`✅ ${memoryRows.length} souvenirs trouvés rattachés à l'ID de Gas :`);
        memoryRows.forEach((r, i) => console.log(`   - (${r.created_at}) "${r.source_text.substring(0, 100)}..."`));
      }
    }

    // 3. Recherche textuelle globale (déjà faite avant)
    console.log('\n🔍 Recherche textuelle globale du mot "gas"...');
    const { rows } = await client.query(
      "SELECT source_text FROM policiercongo_v2_embeddings WHERE source_text ILIKE '%gas%' LIMIT 5"
    );
    console.log(`📊 ${rows.length} mentions du mot "gas" trouvées dans le texte.`);

  } catch (err) {
    console.error('❌ Erreur:', err.message);
  } finally {
    await client.end();
  }
}

checkGas();
