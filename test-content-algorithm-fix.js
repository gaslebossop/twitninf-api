const RecommendationEngine = require('./src/services/recommendationEngine');
const logger = require('./src/utils/logger');
const { User } = require('./src/models');

async function testContentAlgorithmFix() {
  try {
    logger.info('🧪 Test de correction de l\'algorithme de contenu...');
    
    // Initialiser le moteur de recommandation
    const engine = new RecommendationEngine();
    await engine.initialize();
    
    // Attendre un peu pour l'initialisation
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Récupérer un vrai utilisateur de la base de données
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
    
    // Test direct de la méthode getContentIntelligenceRecommendations
    logger.info('🔍 Test direct de getContentIntelligenceRecommendations...');
    
    try {
      const contentRecs = await engine.getContentIntelligenceRecommendations(
        realUser, 
        'discovery', 
        5
      );
      
      logger.info(`✅ getContentIntelligenceRecommendations: ${contentRecs.length} recommandations`);
      
      // Vérifier chaque recommandation
      contentRecs.forEach((rec, index) => {
        logger.info(`🔍 Recommandation ${index + 1}:`, {
          id: rec.id,
          type: typeof rec.id,
          hasContent: !!rec.content,
          hasAuthor: !!rec.author,
          authorId: rec.author?.id,
          hashtags: rec.hashtags
        });
      });
      
    } catch (contentError) {
      logger.error('❌ Erreur dans getContentIntelligenceRecommendations:', contentError);
    }
    
    // Test de la méthode principale getRecommendations
    logger.info('🚀 Test de getRecommendations avec content_intelligence...');
    
    try {
      const recommendations = await engine.getRecommendations(realUser.id, {
        limit: 5,
        algorithm: 'content_intelligence',
        includeUser: true,
        includeStats: true,
        forceRefresh: true
      });
      
      logger.info(`✅ getRecommendations: ${recommendations.length} recommandations`);
      
      // Vérifier que tous les tweets ont des IDs valides
      let validTweets = 0;
      let invalidTweets = 0;
      
      recommendations.forEach((rec, index) => {
        if (rec.id && typeof rec.id === 'string' && rec.id.trim() !== '') {
          validTweets++;
          logger.info(`✅ Tweet ${index + 1}: ID valide = ${rec.id}`);
        } else {
          invalidTweets++;
          logger.error(`❌ Tweet ${index + 1}: ID invalide = ${rec.id} (type: ${typeof rec.id})`);
        }
      });
      
      logger.info(`📊 Résultats: ${validTweets} tweets valides, ${invalidTweets} tweets invalides`);
      
      if (invalidTweets === 0) {
        logger.info('🎉 SUCCÈS: Tous les tweets ont des IDs valides !');
      } else {
        logger.error('❌ ÉCHEC: Certains tweets ont des IDs invalides');
      }
      
      // Vérifier la structure des recommandations
      if (recommendations.length > 0) {
        const sampleRec = recommendations[0];
        logger.info('🔍 Structure de la première recommandation:', {
          hasId: !!sampleRec.id,
          hasContent: !!sampleRec.content,
          hasAuthor: !!sampleRec.author,
          hasStats: !!sampleRec.stats,
          hasUserInteraction: !!sampleRec.user_interaction,
          tweetType: sampleRec.tweet_type,
          parentTweetId: sampleRec.parent_tweet_id
        });
      }
      
    } catch (mainError) {
      logger.error('❌ Erreur dans getRecommendations:', mainError);
    }
    
  } catch (error) {
    logger.error('❌ Erreur lors du test:', error);
  }
}

// Exécuter le test
testContentAlgorithmFix().then(() => {
  logger.info('🏁 Test terminé');
  process.exit(0);
}).catch((error) => {
  logger.error('💥 Erreur fatale:', error);
  process.exit(1);
});
