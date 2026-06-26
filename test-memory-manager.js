/**
 * 🧪 Test du Gestionnaire de Mémoire PolicierCongo
 * 
 * Teste les fonctionnalités de mémoire sans relancer l'API
 */

const MemoryManager = require('./src/services/policiercongo/memoryManager');

async function testMemoryManager() {
  console.log('🧪 Test du Gestionnaire de Mémoire...\n');

  try {
    // Créer une instance
    const memoryManager = new MemoryManager();
    
    // Initialiser
    await memoryManager.initialize();
    
    console.log('📊 Statut initial:', memoryManager.getStatus());
    
    // Tester les mises à jour
    console.log('\n🔄 Test des mises à jour...');
    
    await memoryManager.update({
      tweetHistory: [{
        id: 'test_1',
        content: 'Tweet de test 1',
        action: 'POST_TWEET',
        timestamp: new Date()
      }],
      lastActions: ['posted_test_tweet']
    });
    
    console.log('✅ Première mise à jour effectuée');
    console.log('📊 Statut après mise à jour:', memoryManager.getStatus());
    
    // Tester la sauvegarde forcée
    console.log('\n💾 Test de la sauvegarde forcée...');
    await memoryManager.forceSave();
    
    // Tester une autre mise à jour
    console.log('\n🔄 Deuxième mise à jour...');
    await memoryManager.update({
      engagementHistory: [{
        action: 'user_response',
        target_user: 'test_user',
        timestamp: new Date()
      }]
    });
    
    console.log('✅ Deuxième mise à jour effectuée');
    console.log('📊 Statut final:', memoryManager.getStatus());
    
    // Tester l'activation/désactivation de l'auto-sauvegarde
    console.log('\n🔄 Test de l\'auto-sauvegarde...');
    memoryManager.setAutoSave(true);
    await memoryManager.update({ test: 'auto_save_enabled' });
    
    memoryManager.setAutoSave(false);
    await memoryManager.update({ test: 'auto_save_disabled' });
    
    console.log('✅ Tests terminés avec succès !');
    
  } catch (error) {
    console.error('❌ Erreur lors du test:', error);
  }
}

// Lancer le test
testMemoryManager();
