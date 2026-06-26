const { Pool } = require('pg');
const config = require('./src/config/config');

const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.username,
  password: config.database.password,
  ssl: config.database.dialectOptions && config.database.dialectOptions.ssl
});

async function cleanup() {
  try {
    console.log('🧹 Nettoyage de la base vectorielle (PolicierCongo V2)...');
    
    const query = `
      DELETE FROM policiercongo_v2_embeddings 
      WHERE source_text = 'Analyse automatique de la plateforme.' 
         OR source_text = 'Analyse automatique.'
         OR source_text = 'Automatisation complète PolicierCongo.';
    `;
    
    const result = await pool.query(query);
    console.log(`✅ Succès : ${result.rowCount} entrées supprimées.`);
    
    const countQuery = `SELECT COUNT(*) as total FROM policiercongo_v2_embeddings`;
    const countResult = await pool.query(countQuery);
    console.log(`📊 Total restant : ${countResult.rows[0].total} vecteurs.`);

  } catch (err) {
    console.error('❌ Erreur :', err.message);
  } finally {
    await pool.end();
  }
}

cleanup();
