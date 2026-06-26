const { Client } = require('pg');

// Paramètres de connexion identiques au script Python
const DB_HOST = "51.255.48.125";
const DB_PORT = 5432;
const DB_NAME = "wtitninf";
const DB_USER = "admin";
const DB_PASSWORD = "myytree88";

// Configuration du client PostgreSQL
const client = new Client({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  ssl: false,
  connectionTimeoutMillis: 60000,
  idleTimeoutMillis: 10000,
  keepAlive: true
});

async function testConnection() {
  try {
    console.log('Tentative de connexion à PostgreSQL...');
    console.log(`Host: ${DB_HOST}:${DB_PORT}`);
    console.log(`Database: ${DB_NAME}`);
    console.log(`User: ${DB_USER}`);
    
    await client.connect();
    console.log('✅ Connexion PostgreSQL réussie !');
    
    const result = await client.query('SELECT NOW();');
    console.log('✅ Requête test réussie:', result.rows[0].now);
    
    await client.end();
    console.log('✅ Connexion fermée proprement');
    
  } catch (error) {
    console.error('❌ Erreur de connexion:', error.message);
    console.error('Détails:', error);
  }
}

testConnection();
