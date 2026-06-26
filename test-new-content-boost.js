const RecommendationEngine = require('./src/services/recommendationEngine');
const logger = require('./src/utils/logger');
const { User } = require('./src/models');

async function testNewContentBoost() {
  try {
    logger.info('🧪 Test du système de boost des nouveaux contenus...');

    const engine = new RecommendationEngine();
    await engine.initialize();
    await new Promise(resolve => setTimeout(resolve, 2000));

    logger.info('🔍 Recherche d\'un utilisateur réel dans la base de données...');
    const realUser = await User.findOne({
      where: { is_active: true },
      limit: 1
    });

    if (!realUser) {
      logger.error('❌ Aucun utilisateur actif trouvé dans la base de données');
      return;
    }
    logger.info(`✅ Utilisateur trouvé: ${realUser.username} (${realUser.id})`);

    // Test 1: Algorithme de découverte de nouveaux contenus
    logger.info('🚀 Test 1: Algorithme new_content_discovery...');
    let newContentRecs = [];
    try {
      newContentRecs = await engine.getNewContentDiscoveryRecommendations(
        realUser,
        'discovery',
        5
      );
      logger.info(`✅ new_content_discovery: ${newContentRecs.length} recommandations`);
      
      newContentRecs.forEach((rec, index) => {
        const ageInHours = (Date.now() - new Date(rec.created_at)) / (1000 * 60 * 60);
        logger.info(`🔍 Recommandation ${index + 1}:`, {
          id: rec.id,
          boost: rec.newContentBoost,
          isNewContent: rec.isNewContent,
          views: rec.view_count || 0,
          age: `${ageInHours.toFixed(2)}h`,
          content: rec.content?.substring(0, 100)
        });
      });
    } catch (error) {
      logger.error('❌ Erreur dans new_content_discovery:', error);
    }

    // Test 2: Vérifier que le boost est appliqué dans le scoring
    logger.info('🚀 Test 2: Vérification du boost dans le scoring...');
    let recommendations = [];
    try {
      recommendations = await engine.getRecommendations(realUser.id, {
        limit: 5,
        algorithm: 'new_content_discovery',
        includeUser: true,
        includeStats: true,
        forceRefresh: true
      });
      
      logger.info(`✅ getRecommendations avec new_content_discovery: ${recommendations.length} recommandations`);
      
      recommendations.forEach((rec, index) => {
        logger.info(`📊 Tweet ${index + 1}:`, {
          id: rec.id,
          score: rec.score?.toFixed(2),
          boostedScore: rec.boostedScore?.toFixed(2),
          newContentBoost: rec.newContentBoost,
          finalScore: rec.finalScore?.toFixed(2),
          views: rec.view_count || 0,
          age: `${((Date.now() - new Date(rec.created_at)) / (1000 * 60 * 60)).toFixed(2)}h`
        });
      });
      
      // Vérifier que les nouveaux contenus ont bien un boost
      const boostedTweets = recommendations.filter(rec => rec.newContentBoost > 0);
      logger.info(`🚀 Résultats: ${boostedTweets.length} tweets boostés sur ${recommendations.length} total`);
      
      if (boostedTweets.length > 0) {
        logger.info('🎉 SUCCÈS: Le système de boost des nouveaux contenus fonctionne !');
      } else {
        logger.warn('⚠️ ATTENTION: Aucun tweet n\'a reçu de boost. Vérifiez qu\'il y a des tweets récents avec 0 vues.');
      }
      
    } catch (error) {
      logger.error('❌ Erreur dans getRecommendations:', error);
    }

    // Test 3: Comparaison avec l'algorithme classique
    logger.info('🚀 Test 3: Comparaison avec l\'algorithme classique...');
    try {
      const classicRecs = await engine.getRecommendations(realUser.id, {
        limit: 5,
        algorithm: 'content_intelligence',
        includeUser: true,
        includeStats: true,
        forceRefresh: true
      });
      
      logger.info(`✅ Algorithmes comparés:`);
      logger.info(`   - new_content_discovery: ${recommendations?.length || 0} recommandations`);
      logger.info(`   - content_intelligence: ${classicRecs?.length || 0} recommandations`);
      
      // Vérifier que les nouveaux contenus sont mieux classés avec new_content_discovery
      if (recommendations && classicRecs) {
        const newContentScore = recommendations[0]?.finalScore || 0;
        const classicScore = classicRecs[0]?.finalScore || 0;
        
        logger.info(`📊 Scores de tête:`);
        logger.info(`   - new_content_discovery: ${newContentScore.toFixed(2)}`);
        logger.info(`   - classicScore: ${classicScore.toFixed(2)}`);
        
        if (newContentScore > classicScore) {
          logger.info('🎉 SUCCÈS: L\'algorithme new_content_discovery donne de meilleurs scores aux nouveaux contenus !');
        } else {
          logger.info('ℹ️ INFO: Les scores sont similaires (normal si pas de nouveaux contenus récents)');
        }
      }
      
    } catch (error) {
      logger.error('❌ Erreur dans la comparaison:', error);
    }

  } catch (error) {
    logger.error('❌ Erreur lors du test:', error);
  }
}

testNewContentBoost()
  .then(() => { 
    logger.info('🏁 Test terminé'); 
    process.exit(0); 
  })
  .catch((error) => { 
    logger.error('💥 Erreur fatale:', error); 
    process.exit(1); 
  });
