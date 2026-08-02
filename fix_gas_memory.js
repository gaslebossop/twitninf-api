const { Client } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const DB_HOST = "51.255.48.125";
const DB_PORT = 5432;
const DB_NAME = "twitninf";
const DB_USER = "admin";
const DB_PASSWORD = process.env.DB_PASSWORD;

const GAS_UUID = "d76b9a1c-9c59-4936-8251-fc02592503d4";

async function fixGasMemory() {
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
    console.log(`🚀 Début de la réparation de la mémoire pour Gas (${GAS_UUID})...`);

    // Mise à jour de la colonne metadata (JSONB)
    // On utilise jsonb_set pour ajouter/modifier les champs sans écraser le reste
    const query = `
      UPDATE policiercongo_v2_embeddings 
      SET metadata = metadata || '{"user_username": "gas", "username": "gas"}'::jsonb
      WHERE user_id::text = $1::text
      OR source_text ILIKE '%@gas%'
    `;

    const result = await client.query(query, [GAS_UUID]);
    
    console.log(`✅ Réparation terminée ! ${result.rowCount} souvenirs mis à jour avec le pseudo "gas".`);

    // Vérification rapide
    const { rows } = await client.query(
      "SELECT id, metadata FROM policiercongo_v2_embeddings WHERE user_id::text = $1 LIMIT 1",
      [GAS_UUID]
    );
    if (rows.length > 0) {
      console.log('🔍 Exemple de metadata après patch:', JSON.stringify(rows[0].metadata));
    }

  } catch (err) {
    console.error('❌ Erreur lors de la réparation:', err.message);
  } finally {
    await client.end();
  }
}

fixGasMemory();
