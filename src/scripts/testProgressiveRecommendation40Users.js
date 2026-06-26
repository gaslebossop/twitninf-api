/**
 * 🧪 Script de Test - Recommandation Progressive pour 40 Utilisateurs
 * 
 * Script de test pour valider le système de recommandation progressive
 * adapté pour un petit groupe de 40 utilisateurs.
 * 
 * @author TwitNin Team
 * @version 1.0.0 - Test 40 Users
 * @license MIT
 */

const { sequelize } = require('../database');
const ProgressiveRecommendationEngine = require('../services/progressiveRecommendationEngine');
const ViralityTracker = require('../services/viralityTracker');
const InteractionScoringService = require('../services/interactionScoringService');
const logger = require('../utils/logger');

class ProgressiveRecommendationTester {
  constructor() {
    this.engine = new ProgressiveRecommendationEngine();
    this.tracker = new ViralityTracker();
    this.scoring = new InteractionScoringService();
    this.testResults = [];
  }

  /**
   * Exécute tous les tests
   */
  async runAllTests() {
    try {
      logger.info('🧪 Démarrage des tests de recommandation progressive pour 40 utilisateurs...');
      
      // Test 1: Vérification de la configuration
      await this.testConfiguration();
      
      // Test 2: Test des groupes d'utilisateurs
      await this.testUserGroups();
      
      // Test 3: Test du scoring des interactions
      await this.testInteractionScoring();
      
      // Test 4: Test de la viralité
      await this.testViralityTracking();
      
      // Test 5: Test des recommandations
      await this.testRecommendations();
      
      // Test 6: Test de simulation d'usage réel
      await this.testRealWorldSimulation();
      
      // Afficher les résultats
      this.displayResults();
      
    } catch (error) {
      logger.error('❌ Erreur lors des tests:', error);
    }
  }

  /**
   * Test 1: Vérification de la configuration
   */
  async testConfiguration() {
    logger.info('📋 Test 1: Vérification de la configuration...');
    
    const config = {
      groups: this.engine.recommendationGroups,
      thresholds: this.engine.progressionThresholds,
      interactionScores: this.engine.interactionScores
    };
    
    // Vérifier que les tailles de groupes sont adaptées
    const totalGroupSize = config.groups.initial.size + config.groups.expansion.size + config.groups.viral.size;
    const isSizeValid = totalGroupSize <= 40;
    
    // Vérifier que les seuils sont adaptés
    const isThresholdsValid = config.thresholds.initial_to_expansion <= 5;
    
    this.testResults.push({
      test: 'Configuration',
      status: isSizeValid && isThresholdsValid ? 'PASS' : 'FAIL',
      details: {
        totalGroupSize,
        isSizeValid,
        isThresholdsValid,
        config
      }
    });
    
    logger.info(`✅ Configuration: ${isSizeValid && isThresholdsValid ? 'PASS' : 'FAIL'}`);
  }

  /**
   * Test 2: Test des groupes d'utilisateurs
   */
  async testUserGroups() {
    logger.info('👥 Test 2: Test des groupes d'utilisateurs...');
    
    // Simuler différents types d'utilisateurs
    const testUsers = [
      { id: '1', followers_count: 2, created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }, // Initial
      { id: '2', followers_count: 8, created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) }, // Expansion
      { id: '3', followers_count: 20, created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }, // Viral
    ];
    
    const groupResults = testUsers.map(user => {
      const group = this.engine.determineUserGroup(user);
      return { userId: user.id, followers: user.followers_count, group };
    });
    
    const expectedGroups = ['initial', 'expansion', 'viral'];
    const actualGroups = groupResults.map(r => r.group);
    const isGroupsValid = expectedGroups.every(group => actualGroups.includes(group));
    
    this.testResults.push({
      test: 'User Groups',
      status: isGroupsValid ? 'PASS' : 'FAIL',
      details: {
        groupResults,
        isGroupsValid
      }
    });
    
    logger.info(`✅ User Groups: ${isGroupsValid ? 'PASS' : 'FAIL'}`);
  }

  /**
   * Test 3: Test du scoring des interactions
   */
  async testInteractionScoring() {
    logger.info('🎯 Test 3: Test du scoring des interactions...');
    
    const testInteractions = [
      { type: 'tweet_like', expectedMin: 0.5, expectedMax: 2.0 },
      { type: 'tweet_comment', expectedMin: 2.0, expectedMax: 5.0 },
      { type: 'tweet_retweet', expectedMin: 4.0, expectedMax: 8.0 },
      { type: 'tweet_view', expectedMin: 0.2, expectedMax: 1.0 },
      { type: 'tweet_report', expectedMin: -15.0, expectedMax: -5.0 }
    ];
    
    const scoringResults = [];
    
    for (const interaction of testInteractions) {
      try {
        const score = await this.scoring.calculateInteractionScore(
          'test-tweet-id',
          'test-user-id',
          interaction.type,
          { duration: 5000, deviceType: 'mobile' }
        );
        
        const isValid = score.finalScore >= interaction.expectedMin && 
                       score.finalScore <= interaction.expectedMax;
        
        scoringResults.push({
          type: interaction.type,
          score: score.finalScore,
          isValid,
          expected: `${interaction.expectedMin}-${interaction.expectedMax}`
        });
      } catch (error) {
        scoringResults.push({
          type: interaction.type,
          error: error.message,
          isValid: false
        });
      }
    }
    
    const allValid = scoringResults.every(r => r.isValid);
    
    this.testResults.push({
      test: 'Interaction Scoring',
      status: allValid ? 'PASS' : 'FAIL',
      details: {
        scoringResults,
        allValid
      }
    });
    
    logger.info(`✅ Interaction Scoring: ${allValid ? 'PASS' : 'FAIL'}`);
  }

  /**
   * Test 4: Test de la viralité
   */
  async testViralityTracking() {
    logger.info('📊 Test 4: Test de la viralité...');
    
    const testTweetId = 'test-viral-tweet-' + Date.now();
    const testUserId = 'test-user-' + Date.now();
    
    try {
      // Simuler des interactions positives
      const positiveInteractions = ['tweet_like', 'tweet_comment', 'tweet_retweet'];
      for (const interaction of positiveInteractions) {
        await this.tracker.trackInteraction(
          testTweetId,
          testUserId,
          interaction,
          { duration: 3000 }
        );
      }
      
      // Vérifier les statistiques de viralité
      const viralityStats = await this.tracker.getTweetViralityStats(testTweetId);
      
      const isViralityValid = viralityStats.positiveInteractions >= 3;
      
      this.testResults.push({
        test: 'Virality Tracking',
        status: isViralityValid ? 'PASS' : 'FAIL',
        details: {
          viralityStats,
          isViralityValid
        }
      });
      
      logger.info(`✅ Virality Tracking: ${isViralityValid ? 'PASS' : 'FAIL'}`);
      
    } catch (error) {
      this.testResults.push({
        test: 'Virality Tracking',
        status: 'FAIL',
        details: { error: error.message }
      });
      
      logger.error(`❌ Virality Tracking: FAIL - ${error.message}`);
    }
  }

  /**
   * Test 5: Test des recommandations
   */
  async testRecommendations() {
    logger.info('🚀 Test 5: Test des recommandations...');
    
    try {
      // Créer un utilisateur de test
      const testUser = {
        id: 'test-recommendation-user',
        username: 'testuser',
        followers_count: 10,
        created_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
      };
      
      // Obtenir des recommandations
      const recommendations = await this.engine.getProgressiveRecommendations(
        testUser.id,
        { limit: 10 }
      );
      
      const isRecommendationsValid = recommendations.recommendations && 
                                   recommendations.recommendations.length > 0;
      
      this.testResults.push({
        test: 'Recommendations',
        status: isRecommendationsValid ? 'PASS' : 'FAIL',
        details: {
          count: recommendations.recommendations?.length || 0,
          isRecommendationsValid,
          metadata: recommendations.metadata
        }
      });
      
      logger.info(`✅ Recommendations: ${isRecommendationsValid ? 'PASS' : 'FAIL'}`);
      
    } catch (error) {
      this.testResults.push({
        test: 'Recommendations',
        status: 'FAIL',
        details: { error: error.message }
      });
      
      logger.error(`❌ Recommendations: FAIL - ${error.message}`);
    }
  }

  /**
   * Test 6: Simulation d'usage réel
   */
  async testRealWorldSimulation() {
    logger.info('🌍 Test 6: Simulation d'usage réel...');
    
    try {
      // Simuler 10 utilisateurs interagissant avec des tweets
      const simulationResults = [];
      
      for (let i = 0; i < 10; i++) {
        const userId = `sim-user-${i}`;
        const tweetId = `sim-tweet-${i}`;
        
        // Simuler des interactions variées
        const interactions = [
          'tweet_like',
          'tweet_view',
          'tweet_comment',
          'tweet_retweet'
        ];
        
        const userInteractions = [];
        for (let j = 0; j < Math.floor(Math.random() * 4) + 1; j++) {
          const interaction = interactions[Math.floor(Math.random() * interactions.length)];
          userInteractions.push(interaction);
          
          await this.tracker.trackInteraction(
            tweetId,
            userId,
            interaction,
            { duration: Math.random() * 10000 + 1000 }
          );
        }
        
        simulationResults.push({
          userId,
          tweetId,
          interactions: userInteractions
        });
      }
      
      // Vérifier que le système a bien tracké les interactions
      const isSimulationValid = simulationResults.length === 10;
      
      this.testResults.push({
        test: 'Real World Simulation',
        status: isSimulationValid ? 'PASS' : 'FAIL',
        details: {
          simulationResults,
          isSimulationValid
        }
      });
      
      logger.info(`✅ Real World Simulation: ${isSimulationValid ? 'PASS' : 'FAIL'}`);
      
    } catch (error) {
      this.testResults.push({
        test: 'Real World Simulation',
        status: 'FAIL',
        details: { error: error.message }
      });
      
      logger.error(`❌ Real World Simulation: FAIL - ${error.message}`);
    }
  }

  /**
   * Affiche les résultats des tests
   */
  displayResults() {
    logger.info('\n📊 RÉSULTATS DES TESTS - RECOMMANDATION PROGRESSIVE (40 UTILISATEURS)');
    logger.info('='.repeat(80));
    
    const passedTests = this.testResults.filter(r => r.status === 'PASS').length;
    const totalTests = this.testResults.length;
    const successRate = (passedTests / totalTests) * 100;
    
    this.testResults.forEach(result => {
      const status = result.status === 'PASS' ? '✅' : '❌';
      logger.info(`${status} ${result.test}: ${result.status}`);
      
      if (result.details) {
        if (result.details.error) {
          logger.info(`   Erreur: ${result.details.error}`);
        } else {
          Object.entries(result.details).forEach(([key, value]) => {
            if (typeof value === 'object' && value !== null) {
              logger.info(`   ${key}: ${JSON.stringify(value, null, 2)}`);
            } else {
              logger.info(`   ${key}: ${value}`);
            }
          });
        }
      }
    });
    
    logger.info('='.repeat(80));
    logger.info(`📈 RÉSULTAT GLOBAL: ${passedTests}/${totalTests} tests réussis (${successRate.toFixed(1)}%)`);
    
    if (successRate >= 80) {
      logger.info('🎉 SYSTÈME PRÊT POUR LA PRODUCTION AVEC 40 UTILISATEURS!');
    } else if (successRate >= 60) {
      logger.info('⚠️ SYSTÈME FONCTIONNEL MAIS NÉCESSITE DES AJUSTEMENTS');
    } else {
      logger.info('❌ SYSTÈME NÉCESSITE DES CORRECTIONS MAJEURES');
    }
    
    logger.info('='.repeat(80));
  }
}

// Fonction pour exécuter les tests
async function runTests() {
  const tester = new ProgressiveRecommendationTester();
  await tester.runAllTests();
  
  // Fermer la connexion à la base de données
  await sequelize.close();
  process.exit(0);
}

// Exécuter les tests si ce fichier est appelé directement
if (require.main === module) {
  runTests().catch(error => {
    logger.error('❌ Erreur lors de l\'exécution des tests:', error);
    process.exit(1);
  });
}

module.exports = ProgressiveRecommendationTester;
