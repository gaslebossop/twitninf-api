const { testConnection, syncDatabase, closeConnection } = require('./src/database');
const logger = require('./src/utils/logger');

async function testDatabaseSync() {
  try {
    console.log('🧪 Test de synchronisation de la base de données...\n');

    // Test de connexion
    console.log('1. Test de connexion à PostgreSQL...');
    const connected = await testConnection();
    if (!connected) {
      throw new Error('Impossible de se connecter à PostgreSQL');
    }
    console.log('✅ Connexion réussie\n');

    // Test de synchronisation
    console.log('2. Test de synchronisation des tables...');
    await syncDatabase();
    console.log('✅ Synchronisation réussie\n');

    // Vérification des tables
    console.log('3. Vérification des tables créées...');
    const { sequelize } = require('./src/database');
    const tables = await sequelize.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      { type: sequelize.QueryTypes.SELECT }
    );
    
    console.log('📋 Tables trouvées:');
    tables.forEach(table => {
      console.log(`   - ${table.table_name}`);
    });

    console.log('\n🎉 Test terminé avec succès !');
    
  } catch (error) {
    console.error('❌ Erreur lors du test:', error.message);
    process.exit(1);
  } finally {
    await closeConnection();
    process.exit(0);
  }
}

// Exécuter le test si le script est appelé directement
if (require.main === module) {
  testDatabaseSync();
}

module.exports = testDatabaseSync;
