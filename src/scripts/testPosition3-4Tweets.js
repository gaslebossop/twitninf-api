/**
 * 🧪 Test de Position 3-4 pour les Tweets Initial
 * 
 * Teste que les tweets initial avec < 4 vues sont placés en position 3-4 de chaque page
 * 
 * @author TwitNin Team
 * @version 1.0.0
 */

const { User, Tweet } = require('../models');
const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class Position3_4Tester {
  constructor() {
    this.engine = new ProgressiveRecommendationEngine();
  }

  async testPosition3_4Tweets() {
    try {
      logger.info('🚀 Test de position 3-4 pour les tweets initial...\n');

      // Créer des utilisateurs de test
      const users = [];
      for (let i = 1; i <= 5; i++) {
        const user = await User.create({
          username: `testuser_pos${i}`,
          email: `testuser_pos${i}@example.com`,
          password: 'password123',
          full_name: `Test User Position ${i}`,
          platform: 'web',
          last_activity: new Date()
        });
        users.push(user);
        logger.info(`✅ Utilisateur créé: ${user.username}`);
      }

      // Créer des tweets de test avec différents groupes
      const tweets = [];
      
      // Tweets initial (à tester) - < 4 vues
      for (let i = 1; i <= 4; i++) {
        const tweet = await Tweet.create({
          content: `Tweet initial à tester ${i} - < 4 vues`,
          user_id: users[0].id,
          view_count: Math.floor(Math.random() * 4), // 0-3 vues
          recommendation_group: 'initial',
          created_at: new Date('2025-09-13T10:00:00Z') // Après la date de test
        });
        tweets.push(tweet);
        logger.info(`✅ Tweet initial créé: ${tweet.id} (${tweet.view_count} vues)`);
      }

      // Tweets expansion (autres) - > 4 vues
      for (let i = 1; i <= 8; i++) {
        const tweet = await Tweet.create({
          content: `Tweet expansion ${i} - > 4 vues`,
          user_id: users[1].id,
          view_count: Math.floor(Math.random() * 20) + 5, // 5-24 vues
          recommendation_group: 'expansion',
          created_at: new Date('2025-09-12T10:00:00Z') // Avant la date de test
        });
        tweets.push(tweet);
        logger.info(`✅ Tweet expansion créé: ${tweet.id} (${tweet.view_count} vues)`);
      }

      // Ajouter les tweets au cache de l'engine
      logger.info('\n🔄 Ajout des tweets au cache de l\'engine...');
      
      for (const tweet of tweets) {
        await this.engine.addNewTweet(tweet.id);
      }

      // Tester la récupération des recommandations
      logger.info('\n📊 Test de récupération des recommandations...');
      
      const recommendations = await this.engine.getCachedTweets(users[0].id, {
        limit: 10,
        offset: 0,
        group: 'all'
      });

      logger.info(`\n📋 Recommandations récupérées: ${recommendations.length} tweets`);

      // Analyser les positions des tweets initial
      const initialTweets = recommendations.filter(tweet => 
        tweet.recommendation_group === 'initial' && tweet.view_count < 4
      );

      logger.info(`\n🎯 Tweets initial trouvés: ${initialTweets.length}`);

      // Vérifier les positions
      recommendations.forEach((tweet, index) => {
        const position = index + 1;
        const isInitial = tweet.recommendation_group === 'initial' && tweet.view_count < 4;
        const isInPosition3_4 = position >= 3 && position <= 4;
        
        if (isInitial) {
          logger.info(`📍 Tweet initial "${tweet.content.substring(0, 30)}..." en position ${position} ${isInPosition3_4 ? '✅' : '❌'}`);
        } else {
          logger.info(`📍 Tweet autre "${tweet.content.substring(0, 30)}..." en position ${position}`);
        }
      });

      // Vérifier que les tweets initial sont bien en position 3-4
      const initialPositions = recommendations
        .map((tweet, index) => {
          const isInitial = tweet.recommendation_group === 'initial' && tweet.view_count < 4;
          return isInitial ? index + 1 : null;
        })
        .filter(pos => pos !== null);

      const correctPositions = initialPositions.filter(pos => pos >= 3 && pos <= 4);
      
      logger.info(`\n📊 Résultats:`);
      logger.info(`   - Tweets initial trouvés: ${initialTweets.length}`);
      logger.info(`   - Positions des tweets initial: ${initialPositions.join(', ')}`);
      logger.info(`   - Positions correctes (3-4): ${correctPositions.length}/${initialTweets.length}`);
      
      if (correctPositions.length === initialTweets.length) {
        logger.info('✅ SUCCÈS: Tous les tweets initial sont en position 3-4');
      } else {
        logger.warn('⚠️ ATTENTION: Certains tweets initial ne sont pas en position 3-4');
      }

      // Test avec une deuxième page
      logger.info('\n📄 Test de la deuxième page...');
      
      const recommendationsPage2 = await this.engine.getCachedTweets(users[0].id, {
        limit: 10,
        offset: 10,
        group: 'all'
      });

      logger.info(`📋 Recommandations page 2: ${recommendationsPage2.length} tweets`);

      const initialTweetsPage2 = recommendationsPage2.filter(tweet => 
        tweet.recommendation_group === 'initial' && tweet.view_count < 4
      );

      if (initialTweetsPage2.length > 0) {
        const initialPositionsPage2 = recommendationsPage2
          .map((tweet, index) => {
            const isInitial = tweet.recommendation_group === 'initial' && tweet.view_count < 4;
            return isInitial ? index + 1 : null;
          })
          .filter(pos => pos !== null);

        logger.info(`   - Tweets initial page 2: ${initialTweetsPage2.length}`);
        logger.info(`   - Positions page 2: ${initialPositionsPage2.join(', ')}`);
      }

      logger.info('\n✅ Test de position 3-4 terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de position 3-4:', error);
    } finally {
      // Nettoyage
      await this.cleanup();
    }
  }

  async cleanup() {
    try {
      logger.info('🧹 Nettoyage des données de test...');
      
      // Supprimer les tweets de test
      await Tweet.destroy({
        where: {
          content: {
            [require('sequelize').Op.like]: '%Tweet initial à tester%'
          }
        }
      });

      await Tweet.destroy({
        where: {
          content: {
            [require('sequelize').Op.like]: '%Tweet expansion%'
          }
        }
      });

      // Supprimer les utilisateurs de test
      await User.destroy({
        where: {
          username: {
            [require('sequelize').Op.like]: 'testuser_pos%'
          }
        }
      });

      logger.info('✅ Nettoyage terminé');
    } catch (error) {
      logger.error('❌ Erreur lors du nettoyage:', error);
    }
  }

  async runAllTests() {
    await this.testPosition3_4Tweets();
  }
}

// Exécuter les tests si le script est appelé directement
if (require.main === module) {
  const tester = new Position3_4Tester();
  tester.runAllTests()
    .then(() => {
      logger.info('🎉 Tous les tests terminés');
      process.exit(0);
    })
    .catch(error => {
      logger.error('💥 Erreur lors de l\'exécution des tests:', error);
      process.exit(1);
    });
}

module.exports = Position3_4Tester;
