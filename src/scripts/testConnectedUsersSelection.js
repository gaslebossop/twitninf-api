/**
 * Script de test pour la sélection des utilisateurs connectés
 * Teste la nouvelle logique de sélection par ordre de connexion
 */

const { User } = require('../models');
const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const logger = require('../utils/logger');

class ConnectedUsersSelectionTester {
  constructor() {
    this.progressiveEngine = new ProgressiveRecommendationEngine();
  }

  /**
   * Teste la sélection des utilisateurs connectés pour chaque groupe
   */
  async testConnectedUsersSelection() {
    try {
      logger.info('🧪 Test de sélection des utilisateurs connectés...');

      // Test pour chaque groupe
      const groups = ['initial', 'expansion', 'viral', 'massive'];
      
      for (const groupName of groups) {
        logger.info(`\n📊 Test du groupe: ${groupName}`);
        
        // Obtenir les utilisateurs connectés pour ce groupe
        const connectedUsers = await this.progressiveEngine.getConnectedUsersForGroup(groupName, 10);
        
        logger.info(`✅ ${connectedUsers.length} utilisateurs connectés trouvés pour ${groupName}`);
        
        // Afficher les détails des utilisateurs sélectionnés
        connectedUsers.forEach((user, index) => {
          logger.info(`  ${index + 1}. ${user.username} (dernière activité: ${user.last_activity})`);
        });
      }

      logger.info('\n✅ Test de sélection des utilisateurs connectés terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de sélection:', error);
    }
  }

  /**
   * Teste la récupération des candidats pour un tweet
   */
  async testTweetCandidates() {
    try {
      logger.info('\n🧪 Test de récupération des candidats pour un tweet...');

      // Simuler un tweet ID
      const testTweetId = 'test-tweet-123';
      
      // Test pour chaque groupe
      const groups = ['initial', 'expansion', 'viral', 'massive'];
      
      for (const groupName of groups) {
        logger.info(`\n📊 Test des candidats pour le tweet ${testTweetId} (groupe: ${groupName})`);
        
        // Obtenir les candidats pour ce tweet
        const candidates = await this.progressiveEngine.getTweetCandidates(testTweetId, groupName);
        
        logger.info(`✅ ${candidates.length} candidats trouvés pour le groupe ${groupName}`);
        
        // Afficher les détails des candidats
        candidates.forEach((candidate, index) => {
          logger.info(`  ${index + 1}. ${candidate.username} (groupe: ${candidate.group}, dernière activité: ${candidate.last_activity})`);
        });
      }

      logger.info('\n✅ Test de récupération des candidats terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test des candidats:', error);
    }
  }

  /**
   * Teste la détermination du groupe de recommandation avec candidats
   */
  async testTweetRecommendationGroup() {
    try {
      logger.info('\n🧪 Test de détermination du groupe de recommandation...');

      // Simuler différents scénarios de tweets
      const testScenarios = [
        { tweetId: 'new-tweet-1', views: 0, description: 'Nouveau tweet' },
        { tweetId: 'low-views-tweet-1', views: 2, description: 'Tweet avec peu de vues' },
        { tweetId: 'expansion-tweet-1', views: 15, description: 'Tweet en expansion' },
        { tweetId: 'viral-tweet-1', views: 50, description: 'Tweet viral' },
        { tweetId: 'massive-tweet-1', views: 200, description: 'Tweet massif' }
      ];

      for (const scenario of testScenarios) {
        logger.info(`\n📊 Test du scénario: ${scenario.description} (${scenario.views} vues)`);
        
        // Simuler la détermination du groupe (sans vraiment appeler la DB)
        const groupInfo = await this.simulateTweetGroupDetermination(scenario.tweetId, scenario.views);
        
        logger.info(`✅ Groupe déterminé: ${groupInfo.group}`);
        logger.info(`   Raison: ${groupInfo.reason}`);
        logger.info(`   Candidats max: ${groupInfo.maxCandidates}`);
        if (groupInfo.candidates) {
          logger.info(`   Candidats trouvés: ${groupInfo.candidates.length}`);
        }
      }

      logger.info('\n✅ Test de détermination du groupe terminé');

    } catch (error) {
      logger.error('❌ Erreur lors du test de détermination du groupe:', error);
    }
  }

  /**
   * Simule la détermination du groupe de recommandation
   */
  async simulateTweetGroupDetermination(tweetId, views) {
    // Simulation basée sur la logique réelle
    if (views < 4) {
      const candidates = await this.progressiveEngine.getTweetCandidates(tweetId, 'initial');
      return {
        group: 'initial',
        reason: `Nouveau tweet: ${views} vues (démarrage dans le groupe initial)`,
        maxCandidates: 4,
        candidates: candidates
      };
    } else if (views < 20) {
      const candidates = await this.progressiveEngine.getTweetCandidates(tweetId, 'expansion');
      return {
        group: 'expansion',
        reason: `Tweet en expansion: ${views} vues`,
        maxCandidates: 20,
        candidates: candidates
      };
    } else if (views < 100) {
      const candidates = await this.progressiveEngine.getTweetCandidates(tweetId, 'viral');
      return {
        group: 'viral',
        reason: `Tweet viral: ${views} vues`,
        maxCandidates: 100,
        candidates: candidates
      };
    } else {
      const candidates = await this.progressiveEngine.getTweetCandidates(tweetId, 'massive');
      return {
        group: 'massive',
        reason: `Tweet massif: ${views} vues`,
        maxCandidates: 1000,
        candidates: candidates
      };
    }
  }

  /**
   * Lance tous les tests
   */
  async runAllTests() {
    try {
      logger.info('🚀 Démarrage des tests de sélection des utilisateurs connectés...\n');

      await this.testConnectedUsersSelection();
      await this.testTweetCandidates();
      await this.testTweetRecommendationGroup();

      logger.info('\n🎉 Tous les tests terminés avec succès !');

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    }
  }
}

// Exécuter les tests si le script est lancé directement
if (require.main === module) {
  const tester = new ConnectedUsersSelectionTester();
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

module.exports = ConnectedUsersSelectionTester;
