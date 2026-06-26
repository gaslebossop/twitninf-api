const runAutoMigration = require('./src/scripts/autoMigration');

async function testMigration() {
  try {
    console.log('🧪 Test de la migration automatique...');
    
    await runAutoMigration();
    
    console.log('✅ Test de migration terminé avec succès!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Erreur lors du test de migration:', error);
    process.exit(1);
  }
}

// Exécuter le test
testMigration();
