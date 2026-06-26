/**
 * 🧪 Test Complet du Système PolicierCongo
 * 
 * Teste toutes les fonctionnalités sans relancer l'API
 */

const path = require('path');

// Importer les services
const DataCollector = require('./src/services/policiercongo/dataCollector');
const MemoryManager = require('./src/services/policiercongo/memoryManager');
const ActionExecutor = require('./src/services/policiercongo/actionExecutor');

async function testCompleteSystem() {
  console.log('🧪 Test Complet du Système PolicierCongo...\n');

  try {
    // 1. Test du DataCollector
    console.log('📊 1. Test du DataCollector...');
    const dataCollector = new DataCollector();
    await dataCollector.initialize();
    
    const recentData = await dataCollector.collectRecentData();
    console.log('✅ Données collectées:', {
      tweets: recentData?.recentTweets?.length || 0,
      unreplied: recentData?.unrepliedComments?.length || 0
    });

    // 2. Test du MemoryManager
    console.log('\n🧠 2. Test du MemoryManager...');
    const memoryManager = new MemoryManager();
    await memoryManager.initialize();
    
    console.log('📊 Statut mémoire:', memoryManager.getStatus());
    
    // 3. Test de l'ActionExecutor
    console.log('\n⚡ 3. Test de l\'ActionExecutor...');
    const actionExecutor = new ActionExecutor();
    
    // Simuler une décision
    const testDecision = {
      action: 'POST_TWEET',
      reason: 'Test du système',
      priority: 'medium',
      details: {
        content: 'Test du système PolicierCongo ! 🚔'
      }
    };
    
    console.log('🎯 Décision de test:', testDecision);
    
    // 4. Test de la mémoire avec sauvegarde forcée
    console.log('\n💾 4. Test de la sauvegarde forcée...');
    await memoryManager.update({
      testData: 'Données de test',
      timestamp: new Date()
    });
    
    await memoryManager.forceSave();
    console.log('✅ Sauvegarde forcée effectuée');
    
    // 5. Test de la détection des commentaires non répondu
    console.log('\n🔍 5. Test de la détection des commentaires...');
    const unrepliedComments = await dataCollector.detectUnrepliedCommentsFromDB();
    console.log(`✅ ${unrepliedComments.length} commentaires non répondu détectés`);
    
    if (unrepliedComments.length > 0) {
      console.log('📝 Premier commentaire:', {
        author: unrepliedComments[0].author,
        content: unrepliedComments[0].content.substring(0, 50) + '...',
        hours_ago: unrepliedComments[0].hours_ago
      });
    }
    
    // 6. Test des statistiques
    console.log('\n📈 6. Test des statistiques...');
    const memoryStatus = memoryManager.getStatus();
    console.log('📊 Taille de la mémoire:', memoryStatus.memorySize);
    console.log('🕒 Dernière mise à jour:', memoryStatus.lastUpdated);
    
    console.log('\n✅ Test complet terminé avec succès !');
    
  } catch (error) {
    console.error('❌ Erreur lors du test complet:', error);
  }
}

// Lancer le test
testCompleteSystem();
