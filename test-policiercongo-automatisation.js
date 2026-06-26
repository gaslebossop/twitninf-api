const policiercongoAutomatisation = require('./src/services/policiercongoAutomatisation');
const logger = require('./src/utils/logger');

async function testPolicierCongoAutomatisation() {
  console.log('🚔 Test de l\'automatisation PolicierCongo\n');
  
  try {
    // Test 1: Analyse des préférences
    console.log('🔍 Test 1: Analyse des préférences utilisateurs...');
    const analysis = await policiercongoAutomatisation.analyzeUserPreferences();
    
    if (analysis) {
      console.log('✅ Analyse réussie:');
      console.log(`   - Thèmes détectés: ${Object.keys(analysis.themes).join(', ')}`);
      console.log(`   - Demandes utilisateurs: ${analysis.userRequests.length}`);
      console.log(`   - Total réponses: ${analysis.totalReplies}`);
      console.log(`   - Total tweets: ${analysis.totalTweets}`);
      
      if (Object.keys(analysis.engagementByType).length > 0) {
        console.log('   - Engagement par type:');
        Object.entries(analysis.engagementByType).forEach(([type, data]) => {
          console.log(`     * ${type}: ${data.average?.toFixed(1) || 0} (${data.count} tweets)`);
        });
      }
    } else {
      console.log('❌ Analyse échouée');
    }
    
    console.log('\n' + '='.repeat(50) + '\n');
    
    // Test 2: Génération de tweet autonome
    console.log('🤖 Test 2: Génération de tweet autonome...');
    const tweetData = await policiercongoAutomatisation.generateAutonomousTweet();
    
    if (tweetData) {
      console.log('✅ Tweet généré avec succès:');
      console.log(`   - Contenu: "${tweetData.content}"`);
      console.log(`   - Type: ${tweetData.type}`);
      console.log(`   - Longueur: ${tweetData.content.length} caractères`);
    } else {
      console.log('❌ Génération de tweet échouée');
    }
    
    console.log('\n' + '='.repeat(50) + '\n');
    
    // Test 3: Planification intelligente
    console.log('📅 Test 3: Planification intelligente des tweets...');
    const schedule = await policiercongoAutomatisation.scheduleIntelligentTweets();
    
    if (schedule && schedule.success) {
      console.log('✅ Planification réussie:');
      console.log(`   - Tweets par jour: ${schedule.tweets_per_day}`);
      console.log(`   - Plan créé: ${schedule.plan.length} créneaux`);
      
      schedule.plan.forEach((slot, index) => {
        const time = slot.scheduled_time.toLocaleTimeString('fr-FR', { 
          hour: '2-digit', 
          minute: '2-digit' 
        });
        console.log(`     * ${index + 1}. ${time} - ${slot.type} (${slot.priority})`);
      });
    } else {
      console.log('❌ Planification échouée');
    }
    
    console.log('\n' + '='.repeat(50) + '\n');
    
    // Test 4: Mise à jour du profil
    console.log('🔄 Test 4: Mise à jour intelligente du profil...');
    const profileUpdate = await policiercongoAutomatisation.updatePoliceProfile();
    
    if (profileUpdate && profileUpdate.success) {
      console.log('✅ Mise à jour du profil réussie:');
      console.log(`   - Nouveau username: ${profileUpdate.username}`);
      console.log(`   - Nouvelle bio: ${profileUpdate.bio}`);
    } else {
      console.log('❌ Mise à jour du profil échouée');
    }
    
    console.log('\n' + '='.repeat(50) + '\n');
    
    // Test 5: Automatisation complète
    console.log('🚀 Test 5: Automatisation complète...');
    const automationResult = await policiercongoAutomatisation.runPoliceAutomation();
    
    if (automationResult) {
      console.log('✅ Automatisation terminée avec succès');
    } else {
      console.log('❌ Automatisation échouée');
    }
    
    console.log('\n' + '='.repeat(50) + '\n');
    
    // Test 6: Publication d'un tweet autonome (optionnel)
    console.log('📝 Test 6: Publication d\'un tweet autonome (optionnel)...');
    console.log('⚠️  Ce test va réellement poster un tweet. Continuer ? (Ctrl+C pour arrêter)');
    
    // Attendre 5 secondes pour permettre l'arrêt
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const tweetResult = await policiercongoAutomatisation.postAutonomousTweet();
    
    if (tweetResult && tweetResult.success) {
      console.log('✅ Tweet autonome posté avec succès:');
      console.log(`   - ID du tweet: ${tweetResult.tweet_id}`);
      console.log(`   - Contenu: "${tweetResult.content}"`);
      console.log(`   - Type: ${tweetResult.type}`);
    } else {
      console.log('❌ Publication du tweet échouée:', tweetResult?.error || 'Erreur inconnue');
    }
    
  } catch (error) {
    console.error('❌ Erreur lors des tests:', error);
    logger.error('Erreur lors des tests PolicierCongo:', error);
  }
  
  console.log('\n🎯 Tests terminés !');
}

// Fonction pour tester une fonction spécifique
async function testSpecificFunction(functionName) {
  console.log(`🧪 Test de la fonction: ${functionName}\n`);
  
  try {
    switch (functionName) {
      case 'analyzeUserPreferences':
        const analysis = await policiercongoAutomatisation.analyzeUserPreferences();
        console.log('Résultat:', analysis);
        break;
        
      case 'generateAutonomousTweet':
        const tweetData = await policiercongoAutomatisation.generateAutonomousTweet();
        console.log('Résultat:', tweetData);
        break;
        
      case 'scheduleIntelligentTweets':
        const schedule = await policiercongoAutomatisation.scheduleIntelligentTweets();
        console.log('Résultat:', schedule);
        break;
        
      case 'updatePoliceProfile':
        const profileUpdate = await policiercongoAutomatisation.updatePoliceProfile();
        console.log('Résultat:', profileUpdate);
        break;
        
      default:
        console.log('❌ Fonction inconnue. Fonctions disponibles:');
        console.log('   - analyzeUserPreferences');
        console.log('   - generateAutonomousTweet');
        console.log('   - scheduleIntelligentTweets');
        console.log('   - updatePoliceProfile');
    }
  } catch (error) {
    console.error('❌ Erreur:', error);
  }
}

// Gestion des arguments de ligne de commande
const args = process.argv.slice(2);

if (args.length > 0) {
  const functionName = args[0];
  testSpecificFunction(functionName);
} else {
  // Test complet par défaut
  testPolicierCongoAutomatisation();
}

module.exports = {
  testPolicierCongoAutomatisation,
  testSpecificFunction
};
