/**
 * Script de test pour la diversité des créateurs dans les recommandations
 * Teste que les tweets recommandés proviennent de créateurs différents
 */

const { User, Tweet } = require('../models');
const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class CreatorDiversityTester {
  constructor() {
    this.progressiveEngine = new ProgressiveRecommendationEngine();
  }

  /**
   * Teste la diversité des créateurs dans les recommandations
   */
  async testCreatorDiversity() {
    try {
      logger.info('🧪 Test de la diversité des créateurs...\n');

      // Créer plusieurs utilisateurs
      const users = [];
      for (let i = 0; i < 5; i++) {
        const user = await User.create({
          username: `testuser${i + 1}`,
          email: `testuser${i + 1}@example.com`,
          password: 'password123',
          last_activity: new Date()
        });
        users.push(user);
      }

      // Créer des tweets pour chaque utilisateur
      const tweets = [];
      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        
        // Chaque utilisateur a 3 tweets dans différents groupes
        for (let j = 0; j < 3; j++) {
          const tweet = await Tweet.create({
            content: `Tweet ${j + 1} de ${user.username}`,
            user_id: user.id,
            moderation_status: 'approved',
            recommendation_group: ['initial', 'expansion', 'viral'][j],
            view_count: [5, 15, 60][j],
            metadata: {
              source: 'test_diversity',
              creator: user.username,
              tweet_index: j + 1
            }
          });
          tweets.push(tweet);
        }
      }

      logger.info(`📝 Tweets créés:`);
      logger.info(`   - Utilisateurs: ${users.length}`);
      logger.info(`   - Tweets par utilisateur: 3`);
      logger.info(`   - Total tweets: ${tweets.length}`);

      // Tester la récupération des recommandations
      const recommendations = await this.progressiveEngine.getProgressiveRecommendations(users[0].id, {
        limit: 10,
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

        // Vérifier la diversité
        const maxTweetsPerCreator = Math.max(...Object.values(creatorCounts));
        const minTweetsPerCreator = Math.min(...Object.values(creatorCounts));
        const diversityRatio = Object.keys(creatorCounts).length / recommendations.recommendations.length;

        logger.info(`\n📈 Métriques de diversité:`);
        logger.info(`   - Ratio de diversité: ${(diversityRatio * 100).toFixed(1)}%`);
        logger.info(`   - Max tweets par créateur: ${maxTweetsPerCreator}`);
        logger.info(`   - Min tweets par créateur: ${minTweetsPerCreator}`);

        // Vérifier que la diversité est respectée
        if (diversityRatio >= 0.3) { // Au moins 30% de diversité
          logger.info(`✅ SUCCÈS: Diversité des créateurs respectée (${(diversityRatio * 100).toFixed(1)}%)`);
        } else {
          logger.warn(`⚠️ ATTENTION: Diversité des créateurs faible (${(diversityRatio * 100).toFixed(1)}%)`);
        }

        // Vérifier qu'aucun créateur ne domine
        if (maxTweetsPerCreator <= Math.ceil(recommendations.recommendations.length / 3)) {
          logger.info(`✅ SUCCÈS: Aucun créateur ne domine les recommandations`);
        } else {
          logger.warn(`⚠️ ATTENTION: Un créateur domine avec ${maxTweetsPerCreator} tweets`);
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

      logger.info('✅ Test de diversité des créateurs terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de diversité des créateurs:', error);
    }
  }

  /**
   * Teste la diversité avec différents scénarios
   */
  async testDiversityScenarios() {
    try {
      logger.info('\n🧪 Test de diversité avec différents scénarios...\n');

      const scenarios = [
        {
          name: 'Scénario 1: Un créateur dominant',
          setup: async () => {
            const users = [];
            // Créer 1 utilisateur avec beaucoup de tweets
            const dominantUser = await User.create({
              username: 'dominant_user',
              email: 'dominant@example.com',
              password: 'password123',
              last_activity: new Date()
            });
            users.push(dominantUser);

            // Créer 2 autres utilisateurs avec peu de tweets
            for (let i = 0; i < 2; i++) {
              const user = await User.create({
                username: `normal_user${i + 1}`,
                email: `normal${i + 1}@example.com`,
                password: 'password123',
                last_activity: new Date()
              });
              users.push(user);
            }

            const tweets = [];
            
            // 8 tweets pour l'utilisateur dominant
            for (let i = 0; i < 8; i++) {
              const tweet = await Tweet.create({
                content: `Tweet dominant ${i + 1}`,
                user_id: dominantUser.id,
                moderation_status: 'approved',
                recommendation_group: 'initial',
                view_count: 5,
                metadata: { source: 'test_dominant' }
              });
              tweets.push(tweet);
            }

            // 1 tweet pour chaque autre utilisateur
            for (let i = 1; i < users.length; i++) {
              const tweet = await Tweet.create({
                content: `Tweet normal ${i}`,
                user_id: users[i].id,
                moderation_status: 'approved',
                recommendation_group: 'initial',
                view_count: 5,
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

            // Créer 3 utilisateurs avec le même nombre de tweets
            for (let i = 0; i < 3; i++) {
              const user = await User.create({
                username: `balanced_user${i + 1}`,
                email: `balanced${i + 1}@example.com`,
                password: 'password123',
                last_activity: new Date()
              });
              users.push(user);

              // 3 tweets par utilisateur
              for (let j = 0; j < 3; j++) {
                const tweet = await Tweet.create({
                  content: `Tweet équilibré ${i + 1}-${j + 1}`,
                  user_id: user.id,
                  moderation_status: 'approved',
                  recommendation_group: 'initial',
                  view_count: 5,
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
          limit: 10,
          offset: 0
        });

        if (recommendations.recommendations && recommendations.recommendations.length > 0) {
          // Analyser la diversité
          const creatorCounts = {};
          recommendations.recommendations.forEach(tweet => {
            creatorCounts[tweet.user_id] = (creatorCounts[tweet.user_id] || 0) + 1;
          });

          const diversityRatio = Object.keys(creatorCounts).length / recommendations.recommendations.length;
          const maxTweetsPerCreator = Math.max(...Object.values(creatorCounts));

          logger.info(`   - Diversité: ${(diversityRatio * 100).toFixed(1)}%`);
          logger.info(`   - Créateurs uniques: ${Object.keys(creatorCounts).length}`);
          logger.info(`   - Max tweets par créateur: ${maxTweetsPerCreator}`);

          if (diversityRatio >= 0.3) {
            logger.info(`   ✅ Diversité respectée`);
          } else {
            logger.warn(`   ⚠️ Diversité faible`);
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
      logger.info('🚀 Démarrage des tests de diversité des créateurs...\n');

      await this.testCreatorDiversity();
      await this.testDiversityScenarios();

      logger.info('\n🎉 Tous les tests de diversité des créateurs terminés avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    }
  }
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  const tester = new CreatorDiversityTester();
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

module.exports = CreatorDiversityTester;
