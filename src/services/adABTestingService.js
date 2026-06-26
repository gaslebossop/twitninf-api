/**
 * 🧪 Service de A/B Testing pour Publicités
 * 
 * Permet de tester différentes variantes de publicités pour optimiser
 * les performances et identifier les meilleures stratégies
 */

const logger = require('../utils/logger');
const { 
  Advertisement, 
  AdCampaign,
  AdImpression, 
  AdClick, 
  AdEngagement,
  User,
  UserBehaviorData 
} = require('../models');

class AdABTestingService {
  constructor() {
    this.activeTests = new Map();
    this.testResults = new Map();
    this.initialized = true;
    
    logger.info('🧪 Service de A/B testing publicitaire initialisé');
  }

  /**
   * 🧪 Créer un test A/B pour une publicité
   */
  async createABTest(testConfig) {
    try {
      const {
        name,
        description,
        original_advertisement_id,
        variants,
        traffic_split,
        success_metrics,
        test_duration_days,
        minimum_sample_size,
        confidence_level = 0.95
      } = testConfig;

      // Valider la configuration
      this.validateTestConfig(testConfig);

      // Créer les variantes de publicité
      const createdVariants = await this.createTestVariants(original_advertisement_id, variants);

      // Créer l'objet de test
      const test = {
        id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name,
        description,
        original_advertisement_id,
        variants: createdVariants,
        traffic_split: traffic_split || this.calculateOptimalTrafficSplit(variants.length),
        success_metrics: success_metrics || ['click_through_rate', 'engagement_rate', 'conversion_rate'],
        test_duration_days,
        minimum_sample_size: minimum_sample_size || 1000,
        confidence_level,
        status: 'active',
        start_date: new Date(),
        end_date: new Date(Date.now() + test_duration_days * 24 * 60 * 60 * 1000),
        results: {
          impressions: {},
          clicks: {},
          engagements: {},
          conversions: {},
          metrics: {}
        },
        statistical_significance: {
          achieved: false,
          p_value: null,
          confidence_interval: null
        }
      };

      // Stocker le test
      this.activeTests.set(test.id, test);

      // Initialiser les résultats
      createdVariants.forEach(variant => {
        test.results.impressions[variant.id] = 0;
        test.results.clicks[variant.id] = 0;
        test.results.engagements[variant.id] = 0;
        test.results.conversions[variant.id] = 0;
      });

      logger.info(`🧪 Test A/B créé: ${test.id} avec ${createdVariants.length} variantes`);
      
      return test;

    } catch (error) {
      logger.error('❌ Erreur lors de la création du test A/B:', error);
      throw error;
    }
  }

  /**
   * 🎯 Assigner un utilisateur à une variante de test
   */
  async assignUserToVariant(testId, userId) {
    try {
      const test = this.activeTests.get(testId);
      if (!test || test.status !== 'active') {
        throw new Error('Test non trouvé ou inactif');
      }

      // Vérifier si l'utilisateur a déjà été assigné
      const existingAssignment = await this.getUserVariantAssignment(testId, userId);
      if (existingAssignment) {
        return existingAssignment;
      }

      // Calculer l'assignation basée sur le split de trafic
      const variant = this.calculateVariantAssignment(userId, test.traffic_split, test.variants);
      
      // Enregistrer l'assignation
      await this.recordVariantAssignment(testId, userId, variant.id);

      logger.info(`🎯 Utilisateur ${userId} assigné à la variante ${variant.id} pour le test ${testId}`);
      
      return {
        test_id: testId,
        user_id: userId,
        variant_id: variant.id,
        assigned_at: new Date()
      };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'assignation de variante:', error);
      throw error;
    }
  }

  /**
   * 📊 Enregistrer une interaction pour un test A/B
   */
  async recordTestInteraction(testId, userId, interactionType, context = {}) {
    try {
      const test = this.activeTests.get(testId);
      if (!test) {
        throw new Error('Test non trouvé');
      }

      // Récupérer l'assignation de l'utilisateur
      const assignment = await this.getUserVariantAssignment(testId, userId);
      if (!assignment) {
        throw new Error('Utilisateur non assigné à une variante');
      }

      const variantId = assignment.variant_id;

      // Enregistrer l'interaction
      await UserBehaviorData.create({
        user_id: userId,
        action_type: `ab_test_${interactionType}`,
        target_id: variantId,
        target_type: 'ab_test_variant',
        context_data: {
          test_id: testId,
          variant_id: variantId,
          interaction_type: interactionType,
          ...context
        },
        timestamp: new Date()
      });

      // Mettre à jour les résultats du test
      await this.updateTestResults(testId, variantId, interactionType);

      logger.info(`📊 Interaction ${interactionType} enregistrée pour le test ${testId}, variante ${variantId}`);
      
      return {
        success: true,
        test_id: testId,
        variant_id: variantId,
        interaction_type: interactionType
      };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'enregistrement de l\'interaction:', error);
      throw error;
    }
  }

  /**
   * 📈 Analyser les résultats d'un test A/B
   */
  async analyzeTestResults(testId) {
    try {
      const test = this.activeTests.get(testId);
      if (!test) {
        throw new Error('Test non trouvé');
      }

      // Récupérer les données du test
      const testData = await this.getTestData(testId);
      
      // Calculer les métriques pour chaque variante
      const variantMetrics = await this.calculateVariantMetrics(testId, testData);
      
      // Effectuer les tests statistiques
      const statisticalAnalysis = await this.performStatisticalAnalysis(variantMetrics, test.confidence_level);
      
      // Déterminer la variante gagnante
      const winner = this.determineWinner(variantMetrics, statisticalAnalysis);
      
      // Générer des recommandations
      const recommendations = this.generateRecommendations(variantMetrics, statisticalAnalysis, winner);

      const analysis = {
        test_id: testId,
        test_name: test.name,
        analysis_date: new Date(),
        variant_metrics: variantMetrics,
        statistical_analysis: statisticalAnalysis,
        winner: winner,
        recommendations: recommendations,
        test_status: this.determineTestStatus(test, statisticalAnalysis)
      };

      // Mettre à jour le test avec les résultats
      test.results.metrics = variantMetrics;
      test.statistical_significance = statisticalAnalysis;
      this.activeTests.set(testId, test);

      logger.info(`📈 Analyse terminée pour le test ${testId}. Gagnant: ${winner?.variant_id || 'Aucun'}`);
      
      return analysis;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse des résultats:', error);
      throw error;
    }
  }

  /**
   * 🏆 Finaliser un test A/B
   */
  async finalizeTest(testId, action = 'implement_winner') {
    try {
      const test = this.activeTests.get(testId);
      if (!test) {
        throw new Error('Test non trouvé');
      }

      // Analyser les résultats finaux
      const finalAnalysis = await this.analyzeTestResults(testId);
      
      // Déterminer l'action à prendre
      let finalAction = action;
      if (action === 'implement_winner' && finalAnalysis.winner) {
        await this.implementWinner(testId, finalAnalysis.winner.variant_id);
        finalAction = 'winner_implemented';
      }

      // Mettre à jour le statut du test
      test.status = 'completed';
      test.end_date = new Date();
      test.final_analysis = finalAnalysis;
      test.final_action = finalAction;

      // Désactiver les variantes non gagnantes
      await this.deactivateNonWinningVariants(testId, finalAnalysis.winner?.variant_id);

      // Stocker les résultats finaux
      this.testResults.set(testId, {
        test: test,
        analysis: finalAnalysis,
        completed_at: new Date()
      });

      // Retirer du cache des tests actifs
      this.activeTests.delete(testId);

      logger.info(`🏆 Test ${testId} finalisé. Action: ${finalAction}`);
      
      return {
        test_id: testId,
        status: 'completed',
        final_analysis: finalAnalysis,
        action_taken: finalAction,
        completed_at: new Date()
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la finalisation du test:', error);
      throw error;
    }
  }

  /**
   * 📊 Obtenir les tests A/B actifs
   */
  getActiveTests() {
    const activeTests = [];
    for (const [testId, test] of this.activeTests.entries()) {
      if (test.status === 'active') {
        activeTests.push({
          id: testId,
          name: test.name,
          description: test.description,
          start_date: test.start_date,
          end_date: test.end_date,
          variants_count: test.variants.length,
          current_status: this.getTestProgress(test)
        });
      }
    }
    return activeTests;
  }

  /**
   * 📈 Obtenir l'historique des tests
   */
  getTestHistory(limit = 50) {
    const history = [];
    for (const [testId, result] of this.testResults.entries()) {
      history.push({
        id: testId,
        name: result.test.name,
        status: result.test.status,
        start_date: result.test.start_date,
        end_date: result.test.end_date,
        winner: result.analysis.winner?.variant_id,
        final_action: result.test.final_action,
        completed_at: result.completed_at
      });
    }
    
    return history
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))
      .slice(0, limit);
  }

  // Méthodes privées

  /**
   * ✅ Valider la configuration du test
   */
  validateTestConfig(config) {
    const required = ['name', 'original_advertisement_id', 'variants'];
    const missing = required.filter(field => !config[field]);
    
    if (missing.length > 0) {
      throw new Error(`Champs manquants: ${missing.join(', ')}`);
    }

    if (!Array.isArray(config.variants) || config.variants.length < 2) {
      throw new Error('Au moins 2 variantes sont requises');
    }

    if (config.traffic_split) {
      const total = config.traffic_split.reduce((sum, split) => sum + split, 0);
      if (Math.abs(total - 1.0) > 0.01) {
        throw new Error('Le split de trafic doit totaliser 1.0');
      }
    }
  }

  /**
   * 🎨 Créer les variantes de test
   */
  async createTestVariants(originalAdId, variants) {
    try {
      const originalAd = await Advertisement.findByPk(originalAdId);
      if (!originalAd) {
        throw new Error('Publicité originale non trouvée');
      }

      const createdVariants = [];

      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        
        // Créer une nouvelle publicité basée sur l'originale
        const variantAd = await Advertisement.create({
          user_id: originalAd.user_id,
          campaign_id: originalAd.campaign_id,
          tweet_id: variant.tweet_id || originalAd.tweet_id,
          title: variant.title || `${originalAd.title} - Variante ${i + 1}`,
          description: variant.description || originalAd.description,
          budget: variant.budget || originalAd.budget,
          cost_per_impression: variant.cost_per_impression || originalAd.cost_per_impression,
          cost_per_click: variant.cost_per_click || originalAd.cost_per_click,
          cost_per_engagement: variant.cost_per_engagement || originalAd.cost_per_engagement,
          start_date: originalAd.start_date,
          end_date: originalAd.end_date,
          max_impressions_per_day: variant.max_impressions_per_day || originalAd.max_impressions_per_day,
          max_impressions_per_user: variant.max_impressions_per_user || originalAd.max_impressions_per_user,
          targeting_criteria: variant.targeting_criteria || originalAd.targeting_criteria,
          creative_data: {
            ...originalAd.creative_data,
            ...variant.creative_data,
            variant_type: variant.type || 'content',
            variant_description: variant.description || `Variante ${i + 1}`
          },
          status: 'draft' // Les variantes commencent en draft
        });

        createdVariants.push({
          id: variantAd.id,
          name: variantAd.title,
          type: variant.type || 'content',
          description: variant.description,
          advertisement: variantAd
        });
      }

      return createdVariants;
    } catch (error) {
      logger.error('❌ Erreur lors de la création des variantes:', error);
      throw error;
    }
  }

  /**
   * 📊 Calculer le split de trafic optimal
   */
  calculateOptimalTrafficSplit(variantCount) {
    const split = 1.0 / variantCount;
    return Array(variantCount).fill(split);
  }

  /**
   * 🎯 Calculer l'assignation de variante
   */
  calculateVariantAssignment(userId, trafficSplit, variants) {
    // Utiliser un hash déterministe basé sur l'ID utilisateur
    const hash = this.hashUserId(userId);
    const normalizedHash = hash / 0xffffffff; // Normaliser entre 0 et 1
    
    let cumulativeSplit = 0;
    for (let i = 0; i < trafficSplit.length; i++) {
      cumulativeSplit += trafficSplit[i];
      if (normalizedHash <= cumulativeSplit) {
        return variants[i];
      }
    }
    
    // Fallback sur la dernière variante
    return variants[variants.length - 1];
  }

  /**
   * 🔢 Hasher l'ID utilisateur de manière déterministe
   */
  hashUserId(userId) {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      const char = userId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convertir en 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * 📝 Enregistrer l'assignation de variante
   */
  async recordVariantAssignment(testId, userId, variantId) {
    // Enregistrer dans UserBehaviorData pour la persistance
    await UserBehaviorData.create({
      user_id: userId,
      action_type: 'ab_test_assignment',
      target_id: variantId,
      target_type: 'ab_test_variant',
      context_data: {
        test_id: testId,
        variant_id: variantId,
        assignment_type: 'automatic'
      },
      timestamp: new Date()
    });
  }

  /**
   * 🔍 Récupérer l'assignation de variante d'un utilisateur
   */
  async getUserVariantAssignment(testId, userId) {
    const assignment = await UserBehaviorData.findOne({
      where: {
        user_id: userId,
        action_type: 'ab_test_assignment',
        'context_data.test_id': testId
      },
      order: [['timestamp', 'DESC']]
    });

    if (!assignment) return null;

    return {
      test_id: testId,
      user_id: userId,
      variant_id: assignment.target_id,
      assigned_at: assignment.timestamp
    };
  }

  /**
   * 📊 Mettre à jour les résultats du test
   */
  async updateTestResults(testId, variantId, interactionType) {
    const test = this.activeTests.get(testId);
    if (!test) return;

    // Mettre à jour les compteurs
    if (interactionType === 'impression') {
      test.results.impressions[variantId] = (test.results.impressions[variantId] || 0) + 1;
    } else if (interactionType === 'click') {
      test.results.clicks[variantId] = (test.results.clicks[variantId] || 0) + 1;
    } else if (['like', 'retweet', 'reply', 'share'].includes(interactionType)) {
      test.results.engagements[variantId] = (test.results.engagements[variantId] || 0) + 1;
    } else if (interactionType === 'conversion') {
      test.results.conversions[variantId] = (test.results.conversions[variantId] || 0) + 1;
    }

    this.activeTests.set(testId, test);
  }

  /**
   * 📊 Récupérer les données du test
   */
  async getTestData(testId) {
    const test = this.activeTests.get(testId);
    if (!test) return [];

    // Récupérer toutes les interactions pour ce test
    const interactions = await UserBehaviorData.findAll({
      where: {
        action_type: { [require('sequelize').Op.like]: 'ab_test_%' },
        'context_data.test_id': testId
      },
      order: [['timestamp', 'ASC']]
    });

    return interactions;
  }

  /**
   * 📈 Calculer les métriques pour chaque variante
   */
  async calculateVariantMetrics(testId, testData) {
    const test = this.activeTests.get(testId);
    const metrics = {};

    test.variants.forEach(variant => {
      const variantData = testData.filter(data => 
        data.context_data?.variant_id === variant.id
      );

      const impressions = variantData.filter(data => 
        data.action_type === 'ab_test_impression'
      ).length;

      const clicks = variantData.filter(data => 
        data.action_type === 'ab_test_click'
      ).length;

      const engagements = variantData.filter(data => 
        ['ab_test_like', 'ab_test_retweet', 'ab_test_reply', 'ab_test_share'].includes(data.action_type)
      ).length;

      const conversions = variantData.filter(data => 
        data.action_type === 'ab_test_conversion'
      ).length;

      metrics[variant.id] = {
        variant_id: variant.id,
        variant_name: variant.name,
        impressions,
        clicks,
        engagements,
        conversions,
        click_through_rate: impressions > 0 ? clicks / impressions : 0,
        engagement_rate: impressions > 0 ? engagements / impressions : 0,
        conversion_rate: clicks > 0 ? conversions / clicks : 0,
        sample_size: impressions
      };
    });

    return metrics;
  }

  /**
   * 📊 Effectuer l'analyse statistique
   */
  async performStatisticalAnalysis(variantMetrics, confidenceLevel) {
    const variants = Object.values(variantMetrics);
    if (variants.length < 2) {
      return { achieved: false, p_value: null, confidence_interval: null };
    }

    // Test de significativité pour le CTR
    const ctrResults = this.performChiSquareTest(variants, 'click_through_rate', 'impressions', 'clicks');
    
    // Test de significativité pour l'engagement
    const engagementResults = this.performChiSquareTest(variants, 'engagement_rate', 'impressions', 'engagements');

    // Calculer les intervalles de confiance
    const confidenceIntervals = this.calculateConfidenceIntervals(variants, confidenceLevel);

    return {
      achieved: ctrResults.significant || engagementResults.significant,
      p_value: Math.min(ctrResults.p_value, engagementResults.p_value),
      confidence_level: confidenceLevel,
      ctr_analysis: ctrResults,
      engagement_analysis: engagementResults,
      confidence_intervals: confidenceIntervals
    };
  }

  /**
   * 📊 Effectuer un test du chi-carré
   */
  performChiSquareTest(variants, metric, totalField, successField) {
    if (variants.length < 2) {
      return { significant: false, p_value: 1.0 };
    }

    // Calculer les totaux
    const totalSuccesses = variants.reduce((sum, v) => sum + v[successField], 0);
    const totalTrials = variants.reduce((sum, v) => sum + v[totalField], 0);

    if (totalTrials === 0) {
      return { significant: false, p_value: 1.0 };
    }

    // Calculer le chi-carré
    let chiSquare = 0;
    const expectedRate = totalSuccesses / totalTrials;

    variants.forEach(variant => {
      const observed = variant[successField];
      const expected = variant[totalField] * expectedRate;
      
      if (expected > 0) {
        chiSquare += Math.pow(observed - expected, 2) / expected;
      }
    });

    // Degrés de liberté
    const degreesOfFreedom = variants.length - 1;
    
    // Approximation simple du p-value (pour un vrai test, utiliser une table du chi-carré)
    const pValue = this.estimatePValue(chiSquare, degreesOfFreedom);
    const significant = pValue < (1 - 0.95); // Seuil de 5%

    return {
      significant,
      p_value: pValue,
      chi_square: chiSquare,
      degrees_of_freedom: degreesOfFreedom,
      expected_rate: expectedRate
    };
  }

  /**
   * 📊 Estimer le p-value (approximation simple)
   */
  estimatePValue(chiSquare, degreesOfFreedom) {
    // Approximation très simplifiée - dans un vrai système, utiliser une table du chi-carré
    if (chiSquare < 3.84) return 0.1; // Non significatif
    if (chiSquare < 6.63) return 0.05; // Seuil de 5%
    if (chiSquare < 10.83) return 0.01; // Seuil de 1%
    return 0.001; // Très significatif
  }

  /**
   * 📊 Calculer les intervalles de confiance
   */
  calculateConfidenceIntervals(variants, confidenceLevel) {
    const intervals = {};
    const zScore = this.getZScore(confidenceLevel);

    variants.forEach(variant => {
      const n = variant.impressions;
      const p = variant.click_through_rate;
      
      if (n > 0) {
        const marginOfError = zScore * Math.sqrt((p * (1 - p)) / n);
        intervals[variant.variant_id] = {
          lower: Math.max(0, p - marginOfError),
          upper: Math.min(1, p + marginOfError),
          point_estimate: p
        };
      }
    });

    return intervals;
  }

  /**
   * 📊 Obtenir le score Z pour un niveau de confiance
   */
  getZScore(confidenceLevel) {
    const zScores = {
      0.90: 1.645,
      0.95: 1.96,
      0.99: 2.576
    };
    return zScores[confidenceLevel] || 1.96;
  }

  /**
   * 🏆 Déterminer la variante gagnante
   */
  determineWinner(variantMetrics, statisticalAnalysis) {
    if (!statisticalAnalysis.achieved) {
      return null; // Pas de significativité statistique
    }

    const variants = Object.values(variantMetrics);
    
    // Trier par CTR (métrique principale)
    variants.sort((a, b) => b.click_through_rate - a.click_through_rate);
    
    const winner = variants[0];
    const secondBest = variants[1];
    
    // Vérifier que la différence est significative
    const improvement = (winner.click_through_rate - secondBest.click_through_rate) / secondBest.click_through_rate;
    
    if (improvement < 0.05) { // Amélioration d'au moins 5%
      return null;
    }

    return {
      variant_id: winner.variant_id,
      variant_name: winner.variant_name,
      improvement_percentage: improvement * 100,
      confidence: statisticalAnalysis.confidence_level
    };
  }

  /**
   * 💡 Générer des recommandations
   */
  generateRecommendations(variantMetrics, statisticalAnalysis, winner) {
    const recommendations = [];

    if (!statisticalAnalysis.achieved) {
      recommendations.push({
        type: 'insufficient_data',
        priority: 'high',
        title: 'Données insuffisantes',
        description: 'Le test n\'a pas encore atteint la significativité statistique',
        suggestions: [
          'Continuer le test pour collecter plus de données',
          'Augmenter le budget pour accélérer la collecte',
          'Vérifier que le split de trafic est équilibré'
        ]
      });
    } else if (winner) {
      recommendations.push({
        type: 'implement_winner',
        priority: 'high',
        title: 'Implémenter la variante gagnante',
        description: `La variante ${winner.variant_name} montre une amélioration de ${winner.improvement_percentage.toFixed(1)}%`,
        suggestions: [
          'Remplacer la publicité originale par la variante gagnante',
          'Analyser les éléments qui ont contribué au succès',
          'Appliquer ces apprentissages à d\'autres campagnes'
        ]
      });
    } else {
      recommendations.push({
        type: 'no_clear_winner',
        priority: 'medium',
        title: 'Aucun gagnant clair',
        description: 'Aucune variante ne montre d\'amélioration significative',
        suggestions: [
          'Tester des variantes plus différentes',
          'Analyser les métriques secondaires',
          'Considérer d\'autres facteurs d\'optimisation'
        ]
      });
    }

    return recommendations;
  }

  /**
   * 📊 Déterminer le statut du test
   */
  determineTestStatus(test, statisticalAnalysis) {
    const now = new Date();
    const timeElapsed = now - test.start_date;
    const totalDuration = test.end_date - test.start_date;
    const progress = timeElapsed / totalDuration;

    if (statisticalAnalysis.achieved) {
      return 'ready_for_analysis';
    } else if (progress >= 1.0) {
      return 'time_expired';
    } else if (this.getTotalSampleSize(test) >= test.minimum_sample_size) {
      return 'sufficient_data';
    } else {
      return 'collecting_data';
    }
  }

  /**
   * 📊 Obtenir la taille totale de l'échantillon
   */
  getTotalSampleSize(test) {
    return Object.values(test.results.impressions).reduce((sum, count) => sum + count, 0);
  }

  /**
   * 📈 Obtenir le progrès du test
   */
  getTestProgress(test) {
    const totalSampleSize = this.getTotalSampleSize(test);
    const progress = Math.min(1.0, totalSampleSize / test.minimum_sample_size);
    
    return {
      sample_size: totalSampleSize,
      target_sample_size: test.minimum_sample_size,
      progress_percentage: progress * 100,
      days_remaining: Math.max(0, Math.ceil((test.end_date - new Date()) / (1000 * 60 * 60 * 24)))
    };
  }

  /**
   * 🏆 Implémenter la variante gagnante
   */
  async implementWinner(testId, winnerVariantId) {
    try {
      const test = this.activeTests.get(testId);
      if (!test) return;

      // Activer la variante gagnante
      const winnerVariant = test.variants.find(v => v.id === winnerVariantId);
      if (winnerVariant) {
        await winnerVariant.advertisement.update({ status: 'active' });
        logger.info(`🏆 Variante gagnante ${winnerVariantId} activée`);
      }

      // Désactiver la publicité originale
      const originalAd = await Advertisement.findByPk(test.original_advertisement_id);
      if (originalAd) {
        await originalAd.update({ status: 'paused' });
        logger.info(`⏸️ Publicité originale ${test.original_advertisement_id} mise en pause`);
      }

    } catch (error) {
      logger.error('❌ Erreur lors de l\'implémentation du gagnant:', error);
      throw error;
    }
  }

  /**
   * ⏸️ Désactiver les variantes non gagnantes
   */
  async deactivateNonWinningVariants(testId, winnerVariantId) {
    try {
      const test = this.activeTests.get(testId);
      if (!test) return;

      for (const variant of test.variants) {
        if (variant.id !== winnerVariantId) {
          await variant.advertisement.update({ status: 'paused' });
          logger.info(`⏸️ Variante ${variant.id} désactivée`);
        }
      }

    } catch (error) {
      logger.error('❌ Erreur lors de la désactivation des variantes:', error);
      throw error;
    }
  }

  /**
   * 🔄 Nettoyer les tests expirés
   */
  cleanupExpiredTests() {
    const now = new Date();
    
    for (const [testId, test] of this.activeTests.entries()) {
      if (now > test.end_date && test.status === 'active') {
        logger.info(`⏰ Test ${testId} expiré, finalisation automatique`);
        this.finalizeTest(testId, 'no_action');
      }
    }
  }
}

module.exports = new AdABTestingService();
