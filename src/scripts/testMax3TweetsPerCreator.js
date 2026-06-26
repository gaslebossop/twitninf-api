/**
 * Script de test pour vérifier la limite de 3 tweets maximum par créateur
 * Teste que les tweets non-initial respectent cette limite
 */

const { User, Tweet } = require('../models');
const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class Max3TweetsPerCreatorTester {
  constructor() {
    this.progressiveEngine = new ProgressiveRecommendationEngine();
  }

  /**
   * Teste la limite de 3 tweets maximum par créateur
   */
  async testMax3TweetsPerCreator() {
    try {
      logger.info('🧪 Test de la limite de 3 tweets maximum par créateur...\n');

      // Créer plusieurs utilisateurs
      const users = [];
      for (let i = 0; i < 3; i++) {
        const user = await User.create({
          username: `testuser${i + 1}`,
          email: `testuser${i + 1}@example.com`,
          password: 'password123',
          last_activity: new Date()
        });
        users.push(user);
      }

      // Créer des tweets pour chaque utilisateur (plus de 3 pour tester la limite)
      const tweets = [];
      
      // Utilisateur 1 : 5 tweets (devrait être limité à 3)
      for (let i = 0; i < 5; i++) {
        const tweet = await Tweet.create({
          content: `Tweet ${i + 1} de ${users[0].username}`,
          user_id: users[0].id,
          moderation_status: 'approved',
          recommendation_group: 'expansion',
          view_count: 15,
          metadata: {
            source: 'test_max3',
            creator: users[0].username,
            tweet_index: i + 1
          }
        });
        tweets.push(tweet);
      }

      // Utilisateur 2 : 2 tweets (devrait être inclus)
      for (let i = 0; i < 2; i++) {
        const tweet = await Tweet.create({
          content: `Tweet ${i + 1} de ${users[1].username}`,
          user_id: users[1].id,
          moderation_status: 'approved',
          recommendation_group: 'expansion',
          view_count: 20,
          metadata: {
            source: 'test_max3',
            creator: users[1].username,
            tweet_index: i + 1
          }
        });
        tweets.push(tweet);
      }

      // Utilisateur 3 : 4 tweets (devrait être limité à 3)
      for (let i = 0; i < 4; i++) {
        const tweet = await Tweet.create({
          content: `Tweet ${i + 1} de ${users[2].username}`,
          user_id: users[2].id,
          moderation_status: 'approved',
          recommendation_group: 'expansion',
          view_count: 25,
          metadata: {
            source: 'test_max3',
            creator: users[2].username,
            tweet_index: i + 1
          }
        });
        tweets.push(tweet);
      }

      logger.info(`📝 Tweets créés:`);
      logger.info(`   - ${users[0].username}: 5 tweets`);
      logger.info(`   - ${users[1].username}: 2 tweets`);
      logger.info(`   - ${users[2].username}: 4 tweets`);
      logger.info(`   - Total: ${tweets.length} tweets`);

      // Tester la récupération des recommandations
      const recommendations = await this.progressiveEngine.getProgressiveRecommendations(users[0].id, {
        limit: 15, // Plus de tweets pour voir la diversité
        offset: 0
      });

      logger.info(`\n📊 Recommandations récupérées: ${recommendations.recommendations?.length || 0}`);

      if (recommendations.recommendations && recommendations.recommendations.length > 0) {
        // Analyser la diversité des créateurs
        const creatorCounts = {};
        const creatorTweets = {};
        
        recommendations.recommendations.forEach(tweet => {
          const creatorId = tweet.user_id;
          creatorCounts[creatorId] = (creatorCounts[creatorId] || 0) + 1;
          
          if (!creatorTweets[creatorId]) {
            creatorTweets[creatorId] = [];
          }
          creatorTweets[creatorId].push(tweet.id);
        });

        logger.info(`\n🎭 Analyse de la diversité des créateurs:`);
        logger.info(`   - Nombre de créateurs uniques: ${Object.keys(creatorCounts).length}`);
        logger.info(`   - Total tweets recommandés: ${recommendations.recommendations.length}`);

        // Afficher les détails par créateur
        Object.entries(creatorCounts).forEach(([creatorId, count]) => {
          const user = users.find(u => u.id === creatorId);
          const username = user ? user.username : `User ${creatorId}`;
          logger.info(`   - ${username}: ${count} tweets`);
        });

        // Vérifier que la limite de 3 tweets par créateur est respectée
        const maxTweetsPerCreator = Math.max(...Object.values(creatorCounts));
        const creatorsWithMoreThan3 = Object.entries(creatorCounts).filter(([_, count]) => count > 3);

        logger.info(`\n📈 Vérification de la limite:`);
        logger.info(`   - Maximum tweets par créateur: ${maxTweetsPerCreator}`);
        logger.info(`   - Créateurs avec plus de 3 tweets: ${creatorsWithMoreThan3.length}`);

        if (maxTweetsPerCreator <= 3) {
          logger.info(`✅ SUCCÈS: Limite de 3 tweets par créateur respectée`);
        } else {
          logger.error(`❌ ÉCHEC: ${creatorsWithMoreThan3.length} créateurs dépassent la limite de 3 tweets`);
          creatorsWithMoreThan3.forEach(([creatorId, count]) => {
            const user = users.find(u => u.id === creatorId);
            const username = user ? user.username : `User ${creatorId}`;
            logger.error(`   - ${username}: ${count} tweets (limite: 3)`);
          });
        }

        // Vérifier la diversité
        const diversityRatio = Object.keys(creatorCounts).length / recommendations.recommendations.length;
        logger.info(`   - Ratio de diversité: ${(diversityRatio * 100).toFixed(1)}%`);
      }

      // Nettoyer les tweets de test
      for (const tweet of tweets) {
        await tweet.destroy();
      }
      
      // Nettoyer les utilisateurs de test
      for (const user of users) {
        await user.destroy();
      }
      
      logger.info(`\n🗑️ ${tweets.length} tweets et ${users.length} utilisateurs de test supprimés`);

      logger.info('✅ Test de la limite de 3 tweets par créateur terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de la limite de 3 tweets par créateur:', error);
    }
  }

  /**
   * Teste avec différents nombres de tweets par créateur
   */
  async testDifferentTweetCounts() {
    try {
      logger.info('\n🧪 Test avec différents nombres de tweets par créateur...\n');

      const testCases = [
        { tweetsPerUser: 1, expectedMax: 1, description: '1 tweet par utilisateur' },
        { tweetsPerUser: 2, expectedMax: 2, description: '2 tweets par utilisateur' },
        { tweetsPerUser: 3, expectedMax: 3, description: '3 tweets par utilisateur' },
        { tweetsPerUser: 5, expectedMax: 3, description: '5 tweets par utilisateur (limite à 3)' },
        { tweetsPerUser: 10, expectedMax: 3, description: '10 tweets par utilisateur (limite à 3)' }
      ];

      for (const testCase of testCases) {
        logger.info(`\n📊 Test: ${testCase.description}`);

        // Créer 2 utilisateurs avec le nombre spécifié de tweets
        const users = [];
        const tweets = [];

        for (let i = 0; i < 2; i++) {
          const user = await User.create({
            username: `testuser_${testCase.tweetsPerUser}_${i + 1}`,
            email: `testuser_${testCase.tweetsPerUser}_${i + 1}@example.com`,
            password: 'password123',
            last_activity: new Date()
          });
          users.push(user);

          // Créer les tweets pour cet utilisateur
          for (let j = 0; j < testCase.tweetsPerUser; j++) {
            const tweet = await Tweet.create({
              content: `Tweet ${j + 1} de ${user.username}`,
              user_id: user.id,
              moderation_status: 'approved',
              recommendation_group: 'expansion',
              view_count: 15,
              metadata: {
                source: 'test_different_counts',
                creator: user.username,
                tweet_index: j + 1
              }
            });
            tweets.push(tweet);
          }
        }

        // Tester les recommandations
        const recommendations = await this.progressiveEngine.getProgressiveRecommendations(users[0].id, {
          limit: 20, // Assez pour voir tous les tweets
          offset: 0
        });

        if (recommendations.recommendations && recommendations.recommendations.length > 0) {
          // Analyser la diversité
          const creatorCounts = {};
          recommendations.recommendations.forEach(tweet => {
            creatorCounts[tweet.user_id] = (creatorCounts[tweet.user_id] || 0) + 1;
          });

          const maxTweetsPerCreator = Math.max(...Object.values(creatorCounts));
          const actualMax = Math.min(testCase.tweetsPerUser, 3);

          logger.info(`   - Tweets créés par utilisateur: ${testCase.tweetsPerUser}`);
          logger.info(`   - Maximum attendu: ${testCase.expectedMax}`);
          logger.info(`   - Maximum obtenu: ${maxTweetsPerCreator}`);

          if (maxTweetsPerCreator <= testCase.expectedMax) {
            logger.info(`   ✅ SUCCÈS: Limite respectée`);
          } else {
            logger.error(`   ❌ ÉCHEC: Limite dépassée`);
          }
        }

        // Nettoyer
        for (const tweet of tweets) {
          await tweet.destroy();
        }
        for (const user of users) {
          await user.destroy();
        }
      }

      logger.info('✅ Tests avec différents nombres de tweets terminés');

    } catch (error) {
      logger.error('❌ Erreur lors des tests avec différents nombres:', error);
    }
  }

  /**
   * Lance tous les tests
   */
  async runAllTests() {
    try {
      logger.info('🚀 Démarrage des tests de limite de 3 tweets par créateur...\n');

      await this.testMax3TweetsPerCreator();
      await this.testDifferentTweetCounts();

      logger.info('\n🎉 Tous les tests de limite de 3 tweets par créateur terminés avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    }
  }
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  const tester = new Max3TweetsPerCreatorTester();
  tester.runAllTests()
    .then(() => {
      logger.info('✅ Tests terminés');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Erreur lors des tests:', error);
      process.exit(1);
    });
}

module.exports = Max3TweetsPerCreatorTester;
