/**
 * Script de test pour la limite de diversité des créateurs (maximum 3 tweets par créateur)
 */

const { User, Tweet } = require('../models');
const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class CreatorDiversityLimitTester {
  constructor() {
    this.progressiveEngine = new ProgressiveRecommendationEngine();
  }

  /**
   * Teste que la limite de 3 tweets par créateur est respectée
   */
  async testCreatorDiversityLimit() {
    try {
      logger.info('🧪 Test de la limite de diversité des créateurs (max 3 tweets)...\n');

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

      // Créer beaucoup de tweets pour le premier utilisateur (pour tester la limite)
      const tweets = [];
      
      // Utilisateur 1 : 8 tweets (pour tester la limite de 3)
      for (let i = 0; i < 8; i++) {
        const tweet = await Tweet.create({
          content: `Tweet ${i + 1} de ${users[0].username}`,
          user_id: users[0].id,
          moderation_status: 'approved',
          recommendation_group: 'expansion',
          view_count: 15,
          metadata: {
            source: 'test_diversity_limit',
            creator: users[0].username,
            tweet_index: i + 1
          }
        });
        tweets.push(tweet);
      }

      // Utilisateur 2 : 5 tweets
      for (let i = 0; i < 5; i++) {
        const tweet = await Tweet.create({
          content: `Tweet ${i + 1} de ${users[1].username}`,
          user_id: users[1].id,
          moderation_status: 'approved',
          recommendation_group: 'expansion',
          view_count: 15,
          metadata: {
            source: 'test_diversity_limit',
            creator: users[1].username,
            tweet_index: i + 1
          }
        });
        tweets.push(tweet);
      }

      // Utilisateur 3 : 2 tweets
      for (let i = 0; i < 2; i++) {
        const tweet = await Tweet.create({
          content: `Tweet ${i + 1} de ${users[2].username}`,
          user_id: users[2].id,
          moderation_status: 'approved',
          recommendation_group: 'expansion',
          view_count: 15,
          metadata: {
            source: 'test_diversity_limit',
            creator: users[2].username,
            tweet_index: i + 1
          }
        });
        tweets.push(tweet);
      }

      logger.info(`📝 Tweets créés:`);
      logger.info(`   - ${users[0].username}: 8 tweets`);
      logger.info(`   - ${users[1].username}: 5 tweets`);
      logger.info(`   - ${users[2].username}: 2 tweets`);
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
        const creatorsOverLimit = Object.entries(creatorCounts).filter(([_, count]) => count > 3);

        logger.info(`\n📈 Vérification de la limite:`);
        logger.info(`   - Maximum tweets par créateur: ${maxTweetsPerCreator}`);
        logger.info(`   - Créateurs dépassant la limite: ${creatorsOverLimit.length}`);

        if (maxTweetsPerCreator <= 3) {
          logger.info(`✅ SUCCÈS: Limite de 3 tweets par créateur respectée`);
        } else {
          logger.error(`❌ ÉCHEC: ${creatorsOverLimit.length} créateurs dépassent la limite de 3 tweets`);
          creatorsOverLimit.forEach(([creatorId, count]) => {
            const user = users.find(u => u.id === creatorId);
            const username = user ? user.username : `User ${creatorId}`;
            logger.error(`   - ${username}: ${count} tweets (limite: 3)`);
          });
        }

        // Vérifier la diversité
        const diversityRatio = Object.keys(creatorCounts).length / recommendations.recommendations.length;
        logger.info(`   - Ratio de diversité: ${(diversityRatio * 100).toFixed(1)}%`);

        if (diversityRatio >= 0.2) { // Au moins 20% de diversité
          logger.info(`✅ SUCCÈS: Diversité des créateurs respectée`);
        } else {
          logger.warn(`⚠️ ATTENTION: Diversité des créateurs faible`);
        }
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

      logger.info('✅ Test de limite de diversité des créateurs terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de limite de diversité:', error);
    }
  }

  /**
   * Teste avec différents scénarios de répartition
   */
  async testDiversityScenarios() {
    try {
      logger.info('\n🧪 Test de diversité avec différents scénarios...\n');

      const scenarios = [
        {
          name: 'Scénario 1: Un créateur avec beaucoup de tweets',
          setup: async () => {
            const users = [];
            const tweets = [];

            // Créer 1 utilisateur avec 10 tweets
            const prolificUser = await User.create({
              username: 'prolific_user',
              email: 'prolific@example.com',
              password: 'password123',
              last_activity: new Date()
            });
            users.push(prolificUser);

            for (let i = 0; i < 10; i++) {
              const tweet = await Tweet.create({
                content: `Tweet prolifique ${i + 1}`,
                user_id: prolificUser.id,
                moderation_status: 'approved',
                recommendation_group: 'expansion',
                view_count: 15,
                metadata: { source: 'test_prolific' }
              });
              tweets.push(tweet);
            }

            // Créer 2 autres utilisateurs avec 1 tweet chacun
            for (let i = 0; i < 2; i++) {
              const user = await User.create({
                username: `normal_user${i + 1}`,
                email: `normal${i + 1}@example.com`,
                password: 'password123',
                last_activity: new Date()
              });
              users.push(user);

              const tweet = await Tweet.create({
                content: `Tweet normal ${i + 1}`,
                user_id: user.id,
                moderation_status: 'approved',
                recommendation_group: 'expansion',
                view_count: 15,
                metadata: { source: 'test_normal' }
              });
              tweets.push(tweet);
            }

            return { users, tweets };
          }
        },
        {
          name: 'Scénario 2: Créateurs équilibrés',
          setup: async () => {
            const users = [];
            const tweets = [];

            // Créer 4 utilisateurs avec 3 tweets chacun
            for (let i = 0; i < 4; i++) {
              const user = await User.create({
                username: `balanced_user${i + 1}`,
                email: `balanced${i + 1}@example.com`,
                password: 'password123',
                last_activity: new Date()
              });
              users.push(user);

              for (let j = 0; j < 3; j++) {
                const tweet = await Tweet.create({
                  content: `Tweet équilibré ${i + 1}-${j + 1}`,
                  user_id: user.id,
                  moderation_status: 'approved',
                  recommendation_group: 'expansion',
                  view_count: 15,
                  metadata: { source: 'test_balanced' }
                });
                tweets.push(tweet);
              }
            }

            return { users, tweets };
          }
        }
      ];

      for (const scenario of scenarios) {
        logger.info(`\n📊 ${scenario.name}`);

        const { users, tweets } = await scenario.setup();

        // Tester les recommandations
        const recommendations = await this.progressiveEngine.getProgressiveRecommendations(users[0].id, {
          limit: 12, // Plus de tweets pour voir la diversité
          offset: 0
        });

        if (recommendations.recommendations && recommendations.recommendations.length > 0) {
          // Analyser la diversité
          const creatorCounts = {};
          recommendations.recommendations.forEach(tweet => {
            creatorCounts[tweet.user_id] = (creatorCounts[tweet.user_id] || 0) + 1;
          });

          const maxTweetsPerCreator = Math.max(...Object.values(creatorCounts));
          const diversityRatio = Object.keys(creatorCounts).length / recommendations.recommendations.length;

          logger.info(`   - Diversité: ${(diversityRatio * 100).toFixed(1)}%`);
          logger.info(`   - Créateurs uniques: ${Object.keys(creatorCounts).length}`);
          logger.info(`   - Max tweets par créateur: ${maxTweetsPerCreator}`);

          if (maxTweetsPerCreator <= 3) {
            logger.info(`   ✅ Limite de 3 tweets respectée`);
          } else {
            logger.error(`   ❌ Limite de 3 tweets dépassée`);
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

      logger.info('✅ Tests de scénarios terminés');

    } catch (error) {
      logger.error('❌ Erreur lors des tests de scénarios:', error);
    }
  }

  /**
   * Lance tous les tests
   */
  async runAllTests() {
    try {
      logger.info('🚀 Démarrage des tests de limite de diversité des créateurs...\n');

      await this.testCreatorDiversityLimit();
      await this.testDiversityScenarios();

      logger.info('\n🎉 Tous les tests de limite de diversité terminés avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    }
  }
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  const tester = new CreatorDiversityLimitTester();
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

module.exports = CreatorDiversityLimitTester;
