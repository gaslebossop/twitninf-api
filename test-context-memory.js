/**
 * 🧪 Test du système de mémoire contextuelle PolicierCongo
 * 
 * Ce fichier teste les nouvelles fonctionnalités :
 * - Enregistrement des interactions significatives
 * - Gestion des dédicaces et demandes spéciales
 * - Contexte temporel depuis le dernier tweet
 * - Suppression de generateDefaultTweet
 */

const { policierCongoService } = require('./src/services/policiercongo');

async function testContextMemory() {
  console.log('🧪 Test du système de mémoire contextuelle PolicierCongo\n');

  try {
    // 1. Test de la détection des interactions significatives
    console.log('1️⃣ Test de la détection des interactions significatives...');
    const interactionsResult = await policierCongoService.dataCollector.detectAndRecordSignificantInteractions();
    console.log(`✅ ${interactionsResult.length} interactions détectées\n`);

    // 2. Test de la mémoire enrichie
    console.log('2️⃣ Test de la mémoire enrichie...');
    const completeContext = await policierCongoService.memoryManager.getCompleteContextForAI();
    console.log('📊 Statistiques de la mémoire:');
    console.log(`   - Interactions significatives: ${completeContext.totalInteractions}`);
    console.log(`   - Demandes de dédicaces: ${completeContext.totalDedicationRequests}`);
    console.log(`   - Demandes spéciales: ${completeContext.totalSpecialRequests}`);
    console.log(`   - Contextes de conversation: ${completeContext.totalConversations}\n`);

    // 3. Test du contexte temporel
    console.log('3️⃣ Test du contexte temporel...');
    const timeContext = policierCongoService.memoryManager.getTimeSinceLastMainTweet();
    console.log('⏰ Contexte temporel:');
    console.log(`   - Statut: ${timeContext.status}`);
    if (timeContext.status === 'has_main_tweets') {
      console.log(`   - Dernier tweet: il y a ${timeContext.hours}h ${timeContext.minutes}min`);
      console.log(`   - Contenu: "${timeContext.last_tweet_content?.substring(0, 50)}..."`);
    }
    console.log('');

    // 4. Test de l'ajout d'interactions manuelles
    console.log('4️⃣ Test de l\'ajout d\'interactions manuelles...');
    
    // Ajouter une demande de dédicace
    await policierCongoService.memoryManager.addDedicationRequest({
      user_username: 'testuser1',
      request_content: 'Salut PolicierCongo ! Peux-tu me faire une dédicace spéciale ? 😊',
      priority: 'high',
      user_context: { hasEmotion: 'happy', hasQuestion: true }
    });
    console.log('✅ Demande de dédicace ajoutée');

    // Ajouter une demande spéciale
    await policierCongoService.memoryManager.addUserSpecialRequest({
      user_username: 'testuser2',
      request_details: 'J\'ai besoin de conseils de sécurité pour mon quartier',
      category: 'security',
      urgency: 'high',
      priority: 'critical'
    });
    console.log('✅ Demande spéciale ajoutée');

    // Ajouter un contexte de conversation
    await policierCongoService.memoryManager.addConversationContext({
      participants: ['testuser1', 'testuser2'],
      topic: 'Sécurité du quartier',
      mood: 'concerned',
      importance: 'high',
      key_points: ['conseils sécurité', 'dédicace demandée', 'quartier concerné']
    });
    console.log('✅ Contexte de conversation ajouté\n');

    // 5. Vérifier la mémoire mise à jour
    console.log('5️⃣ Vérification de la mémoire mise à jour...');
    const updatedContext = await policierCongoService.memoryManager.getCompleteContextForAI();
    console.log('📊 Mémoire mise à jour:');
    console.log(`   - Dédicaces en attente: ${updatedContext.pendingDedications.length}`);
    console.log(`   - Demandes spéciales en attente: ${updatedContext.pendingSpecialRequests.length}`);
    console.log(`   - Conversations récentes: ${updatedContext.recentConversations.length}\n`);

    // 6. Test de l'automatisation avec contexte enrichi
    console.log('6️⃣ Test de l\'automatisation avec contexte enrichi...');
    const automationResult = await policierCongoService.runIntelligentAutomation();
    
    if (automationResult.success) {
      console.log('✅ Automatisation réussie avec contexte enrichi');
      console.log(`   - Actions exécutées: ${automationResult.execution?.total_actions || 0}`);
      console.log(`   - Interactions détectées: ${automationResult.interactions?.count || 0}`);
    } else {
      console.log('❌ Échec de l\'automatisation:', automationResult.error);
    }

    console.log('\n🎉 Test du système de mémoire contextuelle terminé !');

  } catch (error) {
    console.error('❌ Erreur lors du test:', error);
  }
}

// Exécuter le test
if (require.main === module) {
  testContextMemory();
}

module.exports = { testContextMemory };
