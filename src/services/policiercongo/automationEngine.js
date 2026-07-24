/**
 * 🚀 Moteur d'Automatisation - Orchestration de l'automatisation intelligente
 * 
 * Ce module orchestre tous les processus d'automatisation pour PolicierCongo
 * en coordonnant les différents services et en gérant l'exécution des actions.
 */

const logger = require('../../utils/logger');
const instructionManager = require('./InstructionManager');
const {
  runPolicierCongoV2Turn,
  runPolicierCongoV3Automation,
  TRIGGER_TYPES,
  isPolicierCongoV2Enabled
} = require('./policiercongov3/compatibilityBridge');
const schedulerManager = require('./schedulerManager');

class AutomationEngine {
  constructor() {
    this.isRunning = false;
    this.lastRun = null;
    this.runCount = 0;
    this.successCount = 0;
    this.errorCount = 0;
  }

  /**
   * Exécute l'automatisation intelligente complète
   */
  async run() {
    try {
      const fs = require('fs');
      const path = require('path');
      
      // ✅ GATE 1: Désactivation manuelle
      if (fs.existsSync(path.join(__dirname, '.suicide_lock'))) {
        logger.warn('🚨 Automatisation bloquée: Le compte PolicierCongo est DÉSACTIVÉ (Suicide Social).');
        return { success: false, error: 'Compte désactivé' };
      }

      // GATE 2: Planification IA désactivée ici (pilotée par server.js / schedulerManager)
      

      if (this.isRunning) {
        logger.warn('⚠️ Automatisation déjà en cours d\'exécution');
        return { success: false, error: 'Automatisation déjà en cours' };
      }

      this.isRunning = true;
      this.runCount++;
      const startTime = new Date();

      logger.info('🚀 Démarrage de l\'automatisation intelligente...');

      if (isPolicierCongoV2Enabled()) {
        logger.info('🧠 Moteur actif: PolicierCongo V3 agentique');
        const v3Result = await runPolicierCongoV3Automation({ source: 'automation_engine_full', full: true });
        if (v3Result.success) this.successCount++; else this.errorCount++;
        this.lastRun = {
          timestamp: startTime,
          duration: Date.now() - startTime.getTime(),
          success: v3Result.success,
          engine: 'policiercongo_v3',
          run_id: v3Result.result?.runId,
          tool_calls: v3Result.result?.tool_calls || 0,
          next_wake: v3Result.next_wake || null
        };
        return { ...v3Result, statistics: { run_count: this.runCount, success_count: this.successCount, error_count: this.errorCount, last_run: this.lastRun } };
      }

      // Phase 0: Détection et enregistrement des interactions significatives
      const interactionsResult = await this.detectSignificantInteractions();
      if (interactionsResult.success) {
        logger.info(`🎯 ${interactionsResult.count} interactions significatives détectées et enregistrées`);
      }

      // Phase 0-bis: Collecte des données pour analyse (V1 et V2)
      let collectedData = null;
      try {
        const { dataCollector } = require('./index');
        collectedData = await dataCollector.collectRecentData();
        logger.info(`📊 Données collectées pour l'analyse (${collectedData?.unrepliedComments?.length || 0} commentaires non répondus)`);
      } catch (e) {
        logger.warn('⚠️ Collecte de données: erreur non bloquante:', e?.message);
      }

      // Phase 0-ter: Générer et stocker un Big Context (seulement V1 legacy)
      if (!isPolicierCongoV2Enabled() && collectedData) {
        try {
          const { geminiIntelligence, memoryManager, conceptManager } = require('./index');
          const big = await geminiIntelligence.generateBigContext(collectedData, await memoryManager.getStatus());
          if (big) {
            await memoryManager.storeBigContext(big);
            await conceptManager.refreshFromBigContexts(5);
          }
        } catch (e) {
          logger.warn('⚠️ Big Context legacy: génération/stockage ignoré:', e?.message);
        }
      }

      // Phase 1: Planification par Gemini (V2 Prioritaire)
      let plan;
      let usedV2 = false;

      if (isPolicierCongoV2Enabled()) {
        logger.info('🧠 Utilisation de PolicierCongoV2 pour la planification...');
        const { geminiIntelligence } = require('./index');
        const event = {
          id: `run_${Date.now()}`,
          trigger: TRIGGER_TYPES.SCHEDULED,
          rawText: null,
          metadata: { source: 'automation_engine_full' }
        };

        const v2Result = await runPolicierCongoV2Turn({
          event,
          geminiIntelligence,
          collectedData // ✅ Maintenant passé pour que la V2 "lise" le bail
        });

        if (v2Result && v2Result.ok) {
          logger.info(`✅ Planification V2 réussie (${v2Result.model})`);
          
          plan = {
            action: v2Result.structured?.action || 'NO_ACTION',
            reason: 'Décision V2 - Full Run',
            priority: v2Result.meta?.priorityScore > 70 ? 'high' : 'medium',
            details: v2Result.structured || {}
          };
          usedV2 = true;
        }
      }

      if (!usedV2) {
        logger.info('🧠 Utilisation de Gemini Phase 1 Legacy...');
        plan = await this.geminiPhase1Planning();
      }

      if (!plan) {
        throw new Error('Échec de la planification (V2/Gemini)');
      }

      // Phase 2: Exécution du plan
      let executionResult;
      if (usedV2) {
        // En V2, le "plan" est déjà une action structurée
        const result = await this.executeAction(plan);
        executionResult = {
          success: result.success,
          total_actions: 1,
          successful_actions: result.success ? 1 : 0,
          details: result
        };
      } else {
        executionResult = await this.geminiPhase2Execution(plan);
      }
      
      const endTime = new Date();
      const duration = endTime - startTime;

      // Mise à jour des statistiques
      if (executionResult.success) {
        this.successCount++;
      } else {
        this.errorCount++;
      }

      this.lastRun = {
        timestamp: startTime,
        duration,
        success: executionResult.success,
        actions_executed: executionResult.total_actions || 0,
        successful_actions: executionResult.successful_actions || 0,
        interactions_detected: interactionsResult.count || 0
      };

      // Construire un résumé informatif
      const summary = this.buildMainSummary(plan, executionResult, interactionsResult, duration);

      logger.info(`✅ Automatisation terminée en ${duration}ms - ${executionResult.successful_actions || 0}/${executionResult.total_actions || 0} actions réussies`);

      const finalResponse = {
        success: true,
        plan,
        execution: executionResult,
        interactions: interactionsResult,
        summary,
        statistics: {
          run_count: this.runCount,
          success_count: this.successCount,
          error_count: this.errorCount,
          last_run: this.lastRun
        }
      };

      // ✅ Marquer les ordres comme exécutés si des actions ont été réalisées
      if (executionResult && executionResult.success && executionResult.total_actions > 0) {
        instructionManager.markOrdersAsExecuted();
        logger.info('🏁 Ordres administratifs marqués comme exécutés (run classique)');
      } else {
        logger.info('⚠️ Ordres non marqués comme exécutés (échec ou aucune action)');
      }

      return finalResponse;

    } catch (error) {
      this.errorCount++;
      logger.error('❌ Erreur lors de l\'automatisation:', error);
      
      return {
        success: false,
        error: error.message,
        statistics: {
          run_count: this.runCount,
          success_count: this.successCount,
          error_count: this.errorCount,
          last_run: this.lastRun
        }
      };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Exécute l'automatisation optimisée (version rapide)
   */
  async runOptimized() {
    try {
      const fs = require('fs');
      const path = require('path');
      
      // ✅ GATE 1: Désactivation manuelle
      if (fs.existsSync(path.join(__dirname, '.suicide_lock'))) {
        logger.warn('🚨 Automatisation bloquée: Le compte PolicierCongo est DÉSACTIVÉ (Suicide Social).');
        return { success: false, error: 'Compte désactivé' };
      }

      // GATE 2: Planification IA déléguée au scheduler externe (server.js)
      

      logger.info('⚡ Démarrage de l\'automatisation optimisée...');

      if (isPolicierCongoV2Enabled()) {
        logger.info('🧠 Moteur actif: PolicierCongo V3 agentique');
        return await runPolicierCongoV3Automation({ source: 'automation_engine_optimized', full: false });
      }
      
      // Collecter les données récentes
      const collectedData = await this.collectRecentData();
      if (!collectedData) {
        throw new Error('Impossible de collecter les données');
      }

             // ESSAYER D'ABORD GEMINI pour la planification intelligente
       logger.info('🧠 Tentative de planification intelligente par Gemini...');
       let action;
       let storedAnalysis = null;
       
       // Big Context (obsolète en V2)
       if (!isPolicierCongoV2Enabled()) {
       try {
         const { dataCollector, geminiIntelligence, memoryManager, conceptManager } = require('./index');
         const collectedDataForBig = await dataCollector.collectRecentData();
         if (collectedDataForBig) {
           const big = await geminiIntelligence.generateBigContext(collectedDataForBig, await memoryManager.getStatus());
           if (big) {
             await memoryManager.storeBigContext(big);
             await conceptManager.refreshFromBigContexts(5);
           }
         }
       } catch (e) {
         logger.warn('⚠️ Big Context (optimisé): génération/stockage ignoré:', e?.message);
        }
      }
       
        try {
          const { geminiIntelligence } = require('./index');
          let usedV2 = false;

          // 🚀 TENTATIVE V2 (NOUVEAU SYSTÈME UNIFIÉ)
          if (isPolicierCongoV2Enabled()) {
            logger.info('🧠 Utilisation de PolicierCongoV2 pour l\'analyse...');
            
            const latestComment = collectedData?.unrepliedComments?.[0];
            const event = {
              id: `auto_${Date.now()}`,
              trigger: TRIGGER_TYPES.SCHEDULED,
              rawText: null,
              metadata: { 
                source: 'automation_engine_optimized',
                latest_comment: latestComment
              }
            };

            const v2Result = await runPolicierCongoV2Turn({
              event,
              geminiIntelligence,
              collectedData
            });

            if (v2Result && v2Result.ok) {
              logger.info(`✅ Analyse V2 réussie (${v2Result.model})`);

              action = {
                action: v2Result.structured?.action || 'NO_ACTION',
                reason: 'Décision V2 - Pipeline structuré',
                priority: v2Result.meta?.priorityScore > 70 ? 'high' : 'medium',
                details: v2Result.structured || {}
              };
              usedV2 = true;
            }
          }

          // Fallback legacy si V2 échoue ou désactivée
          if (!usedV2) {
            logger.info('🧠 Utilisation de Gemini Legacy pour l\'analyse...');
            const geminiDecision = await geminiIntelligence.analyze();
            
            if (geminiDecision && geminiDecision.action) {
              logger.info('✅ Décision Gemini Legacy obtenue');
              action = geminiDecision;
            } else {
              logger.warn('⚠️ Gemini n\'a pas pu prendre de décision');
              action = { action: 'NO_ACTION', reason: 'Gemini n\'a pas pris de décision', priority: 'low', details: {} };
            }
          }
          
          // STOCKER L'ANALYSE DANS LA MÉMOIRE POUR LE SUIVI
          const { memoryManager } = require('./index');
          storedAnalysis = await memoryManager.storeIntelligentAnalysis({
            ...action,
            source: usedV2 ? 'v2_decision' : 'gemini_decision',
            context_used: collectedData
          });
          
          if (storedAnalysis) {
            logger.info(`🧠 Analyse intelligente stockée avec ID: ${storedAnalysis.analysis_id}`);
          }
        } catch (error) {
          logger.warn('⚠️ Erreur lors de l\'analyse intelligence artificielle:', error.message);
          action = { action: 'NO_ACTION', reason: `Erreur analyse: ${error.message}`, priority: 'low', details: {} };
        }
      
             // Exécuter l'action
       const result = await this.executeAction(action);
       
       // Construire un résumé informatif
       const summary = this.buildOptimizedSummary(action, result);
       
       // Marquer l'analyse comme exécutée si elle existe
       if (storedAnalysis) {
         const { memoryManager } = require('./index');
         await memoryManager.markIntelligentAnalysisAsExecuted(storedAnalysis.analysis_id, result);
         logger.info(`✅ Analyse intelligente marquée comme exécutée: ${storedAnalysis.analysis_id}`);
         // Supprimer l'analyse exécutée de la mémoire pour ne garder que les analyses utiles
         await memoryManager.removeIntelligentAnalysis(storedAnalysis.analysis_id);
         logger.info(`🗑️ Analyse intelligente retirée de la mémoire: ${storedAnalysis.analysis_id}`);
       }
       
        const finalResponse = {
          success: true,
          action,
          result,
          summary,
          stored_analysis_id: storedAnalysis?.analysis_id || null,
          optimization: 'gemini_attempted',
          gemini_used: action.source === 'gemini_decision'
        };

        // ✅ Marquer les ordres comme exécutés si on a vraiment fait une action valide
        if (action && action.action !== 'NO_ACTION' && result && result.success) {
          instructionManager.markOrdersAsExecuted();
          logger.info('🏁 Ordres administratifs marqués comme exécutés (run optimisé)');
        } else {
          logger.info('⚠️ Ordres non effacés (aucune action valide exécutée ou échec)');
        }

        return finalResponse;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'automatisation optimisée:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Phase 1: Planification intelligente par Gemini
   */
  async geminiPhase1Planning() {
    try {
      logger.info('🧠 PHASE 1: Planification intelligente par Gemini...');
      
      const collectedData = await this.collectRecentData();
      if (!collectedData) {
        throw new Error('Impossible de collecter les données');
      }

      // Utiliser le service Gemini Intelligence pour la planification
      const { geminiIntelligence } = require('./index');
      const plan = await geminiIntelligence.createPlan(collectedData);
      
      if (!plan || !plan.plan) {
        logger.warn('⚠️ Impossible d\'extraire un plan valide, fallback automatique');
        return this.createFallbackPlan(collectedData);
      }

      logger.info(`✅ Plan créé avec ${plan.plan.actions.length} actions`);
      return plan;

    } catch (error) {
      logger.error('❌ Erreur lors de la planification Gemini:', error);
      return null;
    }
  }

  /**
   * Phase 2: Exécution du plan avec contexte futur
   */
  async geminiPhase2Execution(plan) {
    try {
      logger.info('🚀 PHASE 2: Exécution du plan avec contexte futur...');
      
      if (!plan || !plan.plan || !plan.plan.actions) {
        throw new Error('Plan invalide pour l\'exécution');
      }

      const { actions, execution_order } = plan.plan;
      const results = [];
      const contextHistory = [];

      logger.info(`📋 Exécution de ${actions.length} actions (ordre: ${execution_order})`);

      // Exécuter les actions selon l'ordre spécifié
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        logger.info(`🎯 Action ${i + 1}/${actions.length}: ${action.type} (${action.priority})`);
        
        try {
          // Construire le contexte futur pour cette action
          const futureContext = this.buildFutureContext(action, contextHistory, i, actions.length);
          
          // Exécuter l'action avec le contexte futur
          const { actionExecutor } = require('./index');
          const result = await actionExecutor.executeWithContext(action, futureContext);
          
          results.push({
            action_index: i,
            action_type: action.type,
            priority: action.priority,
            target_user: action.target_user,
            result: result,
            context_used: futureContext
          });

          // Mettre à jour l'historique du contexte
          contextHistory.push({
            action: action.type,
            target_user: action.target_user,
            result: result.success,
            timestamp: new Date(),
            impact: result.impact || 'unknown'
          });

          // Attendre entre les actions si séquentiel
          if (execution_order === 'sequential' && i < actions.length - 1) {
            const waitTime = action.priority === 'critical' ? 1000 : 2000;
            logger.info(`⏳ Attente ${waitTime}ms avant la prochaine action...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }

        } catch (error) {
          logger.error(`❌ Erreur lors de l'action ${action.type}:`, error);
          results.push({
            action_index: i,
            action_type: action.type,
            priority: action.priority,
            target_user: action.target_user,
            result: { success: false, error: error.message },
            context_used: null
          });
        }
      }

      // Résumé de l'exécution
      const successCount = results.filter(r => r.result.success).length;
      const executionSummary = {
        success: successCount > 0,
        total_actions: actions.length,
        successful_actions: successCount,
        failed_actions: actions.length - successCount,
        execution_order: execution_order,
        results: results,
        context_history: contextHistory,
        summary: `${successCount}/${actions.length} actions exécutées avec succès`
      };

      // Mettre à jour la mémoire avec les résultats
      const { memoryManager } = require('./index');
      await memoryManager.update({
        last_execution: {
          plan: plan.plan,
          results: executionSummary,
          timestamp: new Date()
        },
        execution_history: contextHistory
      });

      logger.info(`✅ Phase 2 terminée: ${successCount}/${actions.length} actions réussies`);
      return executionSummary;

    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution du plan:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Construit le contexte futur pour une action
   */
  buildFutureContext(action, contextHistory, currentIndex, totalActions) {
    const previousActions = contextHistory.slice(-3); // 3 dernières actions
    const remainingActions = totalActions - currentIndex - 1;
    
    const context = {
      current_action: {
        type: action.type,
        priority: action.priority,
        target_user: action.target_user,
        reason: action.reason
      },
      previous_context: {
        recent_actions: previousActions.map(ctx => ({
          type: ctx.action,
          target: ctx.target_user,
          success: ctx.result,
          impact: ctx.impact
        })),
        lessons_learned: this.extractLessonsFromContext(previousActions)
      },
      future_context: {
        remaining_actions: remainingActions,
        next_actions: remainingActions > 0 ? 'Actions suivantes à venir' : 'Dernière action du plan',
        strategic_considerations: this.getStrategicConsiderations(remainingActions, action.priority)
      },
      community_state: {
        current_mood: 'neutral', // À récupérer depuis le memory manager
        recent_engagement: contextHistory.length > 0 ? 'positive' : 'neutral',
        momentum: contextHistory.filter(ctx => ctx.result).length > contextHistory.length / 2 ? 'building' : 'maintaining'
      }
    };

    return context;
  }

  /**
   * Extrait les leçons apprises du contexte précédent
   */
  extractLessonsFromContext(contextHistory) {
    if (contextHistory.length === 0) return [];
    
    const lessons = [];
    const recentResults = contextHistory.slice(-3);
    
    // Analyser les succès et échecs récents
    const successRate = recentResults.filter(ctx => ctx.result).length / recentResults.length;
    
    if (successRate > 0.8) {
      lessons.push('Engagement communautaire élevé - maintenir le ton actuel');
    } else if (successRate < 0.5) {
      lessons.push('Engagement en baisse - ajuster l\'approche');
    }
    
    // Analyser les types d'actions qui marchent
    const successfulActions = recentResults.filter(ctx => ctx.result).map(ctx => ctx.action);
    if (successfulActions.includes('RESPOND_TO_USER')) {
      lessons.push('Réponses aux utilisateurs très efficaces');
    }
    
    return lessons;
  }

  /**
   * Obtient les considérations stratégiques pour les actions futures
   */
  getStrategicConsiderations(remainingActions, currentPriority) {
    const considerations = [];
    
    if (remainingActions === 0) {
      considerations.push('Dernière action - maximiser l\'impact final');
    } else if (remainingActions <= 2) {
      considerations.push('Phase finale - consolider l\'engagement');
    } else {
      considerations.push('Phase intermédiaire - maintenir le momentum');
    }
    
    if (currentPriority === 'critical') {
      considerations.push('Action critique - priorité absolue');
    } else if (currentPriority === 'high') {
      considerations.push('Action importante - attention particulière');
    }
    
    return considerations;
  }

  /**
   * Collecte les données récentes pour l'analyse
   */
  async collectRecentData() {
    try {
      const { dataCollector } = require('./index');
      return await dataCollector.collectRecentData();
    } catch (error) {
      logger.error('❌ Erreur lors de la collecte des données:', error);
      return null;
    }
  }

  /**
   * Force une action appropriée basée sur les données collectées
   */
  async forceAppropriateAction(_collectedData, _geminiMemory = null) {
    logger.info('🔧 Analyse forcée désactivée — décision laissée à l\'IA');
    return null;
  }

  /**
   * Crée un plan de fallback si Gemini échoue
   */
  createFallbackPlan(collectedData) {
    return {
      plan: {
        actions: [
          {
            type: 'NO_ACTION',
            priority: 'low',
            reason: 'Plan invalide - fallback automatique',
            target_user: null,
            context: 'Aucune action requise'
          }
        ],
        execution_order: 'sequential',
        estimated_duration: '0 minutes',
        community_impact: 'Aucun impact'
      }
    };
  }

  /**
   * Exécute une action simple ou multiple
   */
  async executeAction(action) {
    try {
      const { actionExecutor } = require('./index');
      
      // Vérifier si c'est une action multiple
      if (action.action && Array.isArray(action.action)) {
        logger.info(`🔄 Exécution de ${action.action.length} actions multiples: ${action.action.join(', ')}`);
        
        const results = [];
        let successCount = 0;
        
        // Exécuter chaque action séquentiellement
        for (let i = 0; i < action.action.length; i++) {
          const actionType = action.action[i];
          logger.info(`🎯 Action ${i + 1}/${action.action.length}: ${actionType}`);
          
          try {
            // Créer une décision pour chaque action
            const decision = {
              action: actionType,
              reason: action.reason,
              priority: action.priority,
              details: action.details,
              target_user: action.target_user
            };
            
            const result = await actionExecutor.execute(decision);
            results.push({
              action_type: actionType,
              success: result.success,
              result: result
            });
            
            if (result.success) {
              successCount++;
            }
            
            // Attendre un peu entre les actions
            if (i < action.action.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
          } catch (error) {
            logger.error(`❌ Erreur lors de l'action ${actionType}:`, error);
            results.push({
              action_type: actionType,
              success: false,
              error: error.message
            });
          }
        }
        
        // Résumé des actions multiples
        const summary = {
          success: successCount > 0,
          total_actions: action.action.length,
          successful_actions: successCount,
          failed_actions: action.action.length - successCount,
          results: results,
          summary: `${successCount}/${action.action.length} actions réussies`
        };
        
        logger.info(`✅ Actions multiples terminées: ${successCount}/${action.action.length} réussies`);
        return summary;
        
      } else {
        // Action simple
        logger.info(`🎯 Exécution d'une action simple: ${action.action}`);
        return await actionExecutor.execute(action);
      }
      
    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution de l\'action:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Détecte et enregistre les interactions significatives
   */
  async detectSignificantInteractions() {
    try {
      logger.info('🔍 Phase 0: Détection des interactions significatives...');
      
      const { dataCollector } = require('./index');
      const interactions = await dataCollector.detectAndRecordSignificantInteractions();
      
      return {
        success: true,
        count: interactions.length,
        interactions: interactions,
        timestamp: new Date()
      };
      
    } catch (error) {
      logger.error('❌ Erreur lors de la détection des interactions significatives:', error);
      return {
        success: false,
        error: error.message,
        count: 0
      };
    }
  }

  /**
   * Obtient le statut du moteur d'automatisation
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      statistics: {
        run_count: this.runCount,
        success_count: this.successCount,
        error_count: this.errorCount
      }
    };
  }

  /**
   * Construit un résumé informatif pour l'automatisation optimisée
   */
  buildOptimizedSummary(action, result) {
    try {
      if (!action) {
        return 'Aucune action décidée';
      }

      let summary = '';
      
      // Résumé de l'action
      if (Array.isArray(action.action)) {
        const actionCount = action.action.length;
        const actions = action.action.join(', ');
        summary += `${actionCount} action(s) exécutée(s): ${actions}`;
      } else {
        summary += `Action exécutée: ${action.action}`;
      }

      // Ajouter la raison si disponible
      if (action.reason) {
        summary += ` | Raison: ${action.reason}`;
      }

      // Ajouter la priorité si disponible
      if (action.priority) {
        summary += ` | Priorité: ${action.priority}`;
      }

      // Ajouter le résultat de l'exécution
      if (result) {
        if (result.success) {
          summary += ' | ✅ Exécution réussie';
          
          // Détails selon le type d'action
          if (result.tweet_id) {
            summary += ` | Tweet créé: ${result.tweet_id}`;
          }
          if (result.response_tweet_id) {
            summary += ` | Réponse créée: ${result.response_tweet_id}`;
          }
          if (result.actions_executed) {
            summary += ` | ${result.actions_executed} action(s) traitée(s)`;
          }
        } else {
          summary += ` | ❌ Échec: ${result.error || 'Erreur inconnue'}`;
        }
      }

      // Ajouter l'optimisation utilisée
      summary += ' | ⚡ Mode optimisé avec Gemini';

      return summary;

    } catch (error) {
      logger.error('❌ Erreur lors de la construction du résumé:', error);
      return 'Résumé non disponible - Erreur de génération';
    }
  }

  /**
   * Construit un résumé informatif pour l'automatisation principale
   */
  buildMainSummary(plan, executionResult, interactionsResult, duration) {
    try {
      let summary = '';

      // Résumé des interactions détectées
      if (interactionsResult && interactionsResult.count > 0) {
        summary += `🎯 ${interactionsResult.count} interaction(s) significative(s) détectée(s)`;
      }

      // Résumé du plan
      if (plan && plan.plan && plan.plan.actions) {
        const actionCount = plan.plan.actions.length;
        summary += summary ? ' | ' : '';
        summary += `📋 Plan: ${actionCount} action(s) planifiée(s)`;
      }

      // Résumé de l'exécution
      if (executionResult) {
        summary += summary ? ' | ' : '';
        
        if (executionResult.success) {
          const totalActions = executionResult.total_actions || 0;
          const successfulActions = executionResult.successful_actions || 0;
          
          if (totalActions > 0) {
            summary += `✅ ${successfulActions}/${totalActions} action(s) réussie(s)`;
          } else {
            summary += '✅ Exécution réussie';
          }
        } else {
          summary += `❌ Échec: ${executionResult.error || 'Erreur inconnue'}`;
        }
      }

      // Ajouter la durée
      if (duration) {
        summary += summary ? ' | ' : '';
        summary += `⏱️ ${duration}ms`;
      }

      // Ajouter le mode d'automatisation
      summary += summary ? ' | ' : '';
      summary += '🚀 Mode principal avec phases Gemini';

      return summary || 'Résumé non disponible';

    } catch (error) {
      logger.error('❌ Erreur lors de la construction du résumé principal:', error);
      return 'Résumé non disponible - Erreur de génération';
    }
  }
}

module.exports = AutomationEngine;
