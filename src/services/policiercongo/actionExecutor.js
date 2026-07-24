/**
 * ⚡ Exécuteur d'Actions - Exécution des actions décidées par Gemini
 * 
 * Ce module exécute toutes les actions décidées par l'intelligence Gemini
 * en coordonnant avec les autres services et en gérant les erreurs.
 */

const logger = require('../../utils/logger');
const messagingManager = require('./messagingManager');
const moderationManager = require('./moderationManager');
const { User, Tweet } = require('../../models');
const { POLICE_ACCOUNT_ID } = require('./config');

class ActionExecutor {
  constructor() {
    this.executionCount = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.lastExecution = null;
  }

  /**
   * Résout une cible (handle ou UUID) en UUID
   */
  async _resolveTargetToUuid(target) {
    if (!target || typeof target !== 'string') return null;
    
    // Si c'est déjà un UUID
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (uuidRegex.test(target)) return target;

    // Si c'est un handle (commence par @ ou non)
    const handle = target.startsWith('@') ? target.substring(1) : target;
    
    try {
      const user = await User.findOne({ where: { username: handle } });
      if (user) return user.id;
      logger.warn(`⚠️ Impossible de résoudre le handle @${handle} en UUID.`);
      return null;
    } catch (err) {
      logger.error(`❌ Erreur lors de la résolution du handle @${handle}:`, err);
      return null;
    }
  }

  /**
   * Exécute une action avec son contexte
   */
  async executeWithContext(action, context) {
    try {
      logger.info(`🎯 Exécution de ${action.type} avec contexte futur...`);
      
      // Construire la décision pour l'exécution
      const executionDecision = {
        action: action.type,
        reason: action.reason,
        priority: action.priority,
        details: {
          target_user: action.target_user,
          context: action.context,
          future_context: context
        }
      };

      // Exécuter l'action avec le contexte enrichi
      const result = await this.execute(executionDecision);
      
      // Enrichir le résultat avec le contexte utilisé
      return {
        ...result,
        context_used: context,
        strategic_impact: this.assessStrategicImpact(action, result, context)
      };

    } catch (error) {
      logger.error(`❌ Erreur lors de l'exécution avec contexte:`, error);
      return { success: false, error: error.message, context_used: context };
    }
  }

  /**
   * Exécute une action simple ou multiple
   */
  async execute(decision) {
    try {
      this.executionCount++;
      const startTime = new Date();

      // Vérifier si c'est une action multiple
      if (Array.isArray(decision.action)) {
        logger.info(`🚀 Exécution de ${decision.action.length} actions multiples: ${decision.action.join(', ')}`);
        return await this.executeMultipleActions(decision);
      }

      return await this.executeSingleAction(decision, startTime);

    } catch (error) {
      this.errorCount++;
      logger.error(`❌ Erreur lors de l'exécution de l'action ${decision.action}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute une action simple
   */
  async executeSingleAction(decision, startTime = new Date()) {
    try {
      // Normalisation universelle pour éviter les bugs de casse (ex: update_profile vs UPDATE_PROFILE)
      const actionType = String(decision.action || '').toUpperCase();
      logger.info(`🚀 Exécution de l'action: ${actionType}`);

      let result;
      
      switch (actionType) {
        case 'POST_TWEET':
        case 'POST':
        case 'TWEET':
        case 'tweet':
        case 'post':
          result = await this.executePostTweet(decision);
          break;
          
        case 'UPDATE_PROFILE':
        case 'UPDATE':
        case 'profile':
          result = await this.executeUpdateProfile(decision);
          break;
          
        case 'DELETE_TWEET':
        case 'delete':
          logger.warn('🚨🚨🚨 TENTATIVE DE SUPPRESSION DE TWEET DÉTECTÉE - Validation stricte...');
          result = await this.executeDeleteTweet(decision);
          break;
          
        case 'RESPOND_TO_USER':
        case 'REPLY':
        case 'RESPOND':
        case 'reply':
        case 'respond':
        case 'CLARIFY':
        case 'SUGGEST':
        case 'ONBOARD':
          logger.info(`💬 Tentative de réponse à @${decision.details?.target_user || 'inconnu'} sur ${decision.details?.parent_tweet_id || 'aucun ID'}`);
          result = await this.executeRespondToUser(decision);
          break;

        case 'LIKE':
          result = await this.executeLike(decision);
          break;

        case 'REPOST':
        case 'RETWEET':
          result = await this.executeRepost(decision);
          break;

        case 'FOLLOW':
          result = await this.executeFollow(decision);
          break;

        case 'NOTIFY':
          result = await this.executeNotify(decision);
          break;

        case 'MODERATE':
          result = await this.executeModerate(decision);
          break;

        case 'SUMMARIZE':
        case 'ANALYZE':
        case 'DIGEST':
        case 'PLAN':
        case 'MONITOR':
          result = await this.executeCognitiveAction(decision);
          break;
          
        case 'UNBAN_REQUEST':
          result = await this.executeUnbanRequest(decision);
          break;

        case 'REQUEST_WITHDRAWAL':
          result = await this.executeRequestWithdrawal(decision);
          break;
          
        case 'DEACTIVATE':
          logger.warn('🚨🚨🚨 DÉSACTIVATION DÉTECTÉE (SUICIDE SOCIAL) !');
          result = await this.executeDeactivate(decision);
          break;
          
        case 'NO_ACTION':
        case 'NOOP':
        case 'noop':
          logger.info('⏰ Aucune action requise selon Gemini (NOOP)');
          result = { success: true, action: 'NO_ACTION' };
          break;
          
        case 'RESTART_CYCLE':
        case 'cycle_restart':
          logger.info('🔄 Relance du cycle reconnue et acquittée.');
          result = { success: true, action: 'RESTART_CYCLE', reason: 'Redémarrage demandé par l\'admin' };
          break;

        case 'MULTIPLE_ACTIONS':
          // Robustesse : On cherche le tableau d'actions soit dans details.actions (nouveau), soit dans details.details.actions (ancien/nesté)
          const batchActions = decision.details?.actions || decision.details?.details?.actions || [];
          logger.info(`🔄 Exécution de ${batchActions.length} actions groupées V2...`);
          const results = [];
          
          for (let i = 0; i < batchActions.length; i++) {
            const actionItem = batchActions[i];
            logger.info(`🎯 Action groupée ${i + 1}/${batchActions.length}: ${actionItem.action}`);
            
            // On s'assure que chaque action a bien ses détails passés
            const individualDecision = {
              action: actionItem.action,
              reason: actionItem.reason || decision.reason,
              priority: decision.priority,
              details: actionItem.details || actionItem // Support fallback
            };

            const itemResult = await this.executeSingleAction(individualDecision, new Date());
            results.push({
              index: i,
              action: actionItem.action,
              result: itemResult
            });
            
            // Délai entre les actions (2s) pour la sécurité
            if (i < batchActions.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
          
          result = {
            success: results.some(r => r.result.success),
            action: 'MULTIPLE_ACTIONS',
            results: results,
            summary: `${results.filter(r => r.result.success).length}/${batchActions.length} réussies`
          };
          break;
          
        default:
          logger.warn(`⚠️ Action inconnue: ${decision.action}`);
          result = { success: false, error: 'Action inconnue' };
      }

      const endTime = new Date();
      const duration = endTime - startTime;

      // Mettre à jour les statistiques
      if (result.success) {
        this.successCount++;
      } else {
        this.errorCount++;
      }

      this.lastExecution = {
        action: decision.action,
        timestamp: startTime,
        duration,
        success: result.success,
        result: result
      };

      logger.info(`✅ Action ${decision.action} exécutée en ${duration}ms - ${result.success ? 'Succès' : 'Échec'}`);

      return result;

    } catch (error) {
      this.errorCount++;
      logger.error(`❌ Erreur lors de l'exécution de l'action ${decision.action}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute des actions multiples
   */
  async executeMultipleActions(decision) {
    try {
      logger.info(`🔄 Exécution de ${decision.action.length} actions multiples...`);
      
      const results = [];
      const actions = decision.action;
      
      for (let i = 0; i < actions.length; i++) {
        const actionType = actions[i];
        logger.info(`🎯 Action ${i + 1}/${actions.length}: ${actionType}`);
        
        try {
          // Créer une décision individuelle pour chaque action
          const individualDecision = {
            action: actionType,
            reason: decision.reason,
            priority: decision.priority,
            details: this.extractDetailsForAction(decision.details, actionType, i)
          };
          
          // Exécuter l'action individuelle
          const result = await this.executeSingleAction(individualDecision);
          
          results.push({
            action_index: i,
            action_type: actionType,
            result: result
          });
          
          // Attendre entre les actions pour éviter la surcharge
          if (i < actions.length - 1) {
            const waitTime = decision.priority === 'critical' ? 1000 : 2000;
            logger.info(`⏳ Attente ${waitTime}ms avant la prochaine action...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
          
        } catch (error) {
          logger.error(`❌ Erreur lors de l'action ${actionType}:`, error);
          results.push({
            action_index: i,
            action_type: actionType,
            result: { success: false, error: error.message }
          });
        }
      }
      
      // Résumé des résultats
      const successCount = results.filter(r => r.result.success).length;
      const overallSuccess = successCount > 0;
      
      logger.info(`✅ Actions multiples terminées: ${successCount}/${actions.length} réussies`);
      
      return {
        success: overallSuccess,
        action: 'MULTIPLE_ACTIONS',
        total_actions: actions.length,
        successful_actions: successCount,
        failed_actions: actions.length - successCount,
        results: results,
        summary: `${successCount}/${actions.length} actions exécutées avec succès`
      };
      
    } catch (error) {
      logger.error('❌ Erreur lors de l\'exécution des actions multiples:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Extrait les détails appropriés pour une action spécifique
   */
  extractDetailsForAction(details, actionType, actionIndex) {
    if (!details) return {};
    
    switch (actionType) {
      case 'POST_TWEET':
        return details.post_tweet || details.content ? { content: details.post_tweet?.content || details.content, tweet_type: details.post_tweet?.tweet_type || details.tweet_type || 'general' } : {};
        
      case 'RESPOND_TO_USER':
        if (details.respond_to_users && Array.isArray(details.respond_to_users) && details.respond_to_users[actionIndex]) {
          return details.respond_to_users[actionIndex];
        }
        return details.respond_to || details.parent_tweet_id ? {
          parent_tweet_id: details.respond_to?.parent_tweet_id || details.parent_tweet_id,
          target_user: details.respond_to?.target_user || details.target_user,
          response_content: details.respond_to?.response_content || details.response_content
        } : {};
        
      case 'UPDATE_PROFILE':
        return {
          new_username: details.new_username,
          new_full_name: details.new_full_name
        };
        
      case 'DELETE_TWEET':
        return details.delete_tweet || details.tweet_id ? {
          tweet_id: details.delete_tweet?.tweet_id || details.tweet_id,
          emergency_level: details.delete_tweet?.emergency_level || details.emergency_level,
          legal_justification: details.delete_tweet?.legal_justification || details.legal_justification
        } : {};
        
      default:
        return {};
    }
  }

  /**
   * Exécute l'action de poster un tweet
   */
  async executePostTweet(decision) {
    try {
      logger.info('📝 Exécution de la création de tweet...');

      let tweetContent = decision.details?.content;
      
      // Si c'est une action multiple, chercher le contenu dans les sous-détails
      if (!tweetContent && decision.details?.post_tweet) {
        tweetContent = decision.details.post_tweet.content;
      }
      
      // Si toujours pas de contenu, utiliser le fallback
      if (!tweetContent) {
        logger.info('ℹ️ Aucun contenu fourni par l\'IA pour POST_TWEET. Tentative de génération via Gemini...');
        try {
          const { geminiIntelligence, memoryManager } = require('./index');
          const extraContext = await memoryManager.getCompleteContextForAI?.();
          const generated = await geminiIntelligence.generateTweetContent({
            action: decision.action,
            reason: decision.reason,
            priority: decision.priority,
            details: decision.details
          }, { timeSinceLastTweet: memoryManager.getTimeSinceLastMainTweet?.(), extraContext });
          if (generated && generated.trim().length > 0) {
            tweetContent = generated.trim();
            logger.info('✅ Contenu généré via Gemini pour POST_TWEET');
          } else {
            logger.info('ℹ️ Génération de contenu échouée. Aucune publication forcée.');
            return { success: true, action: 'NO_ACTION', reason: 'No tweet content provided by AI' };
          }
        } catch (genErr) {
          logger.warn('⚠️ Échec de génération de contenu via Gemini:', genErr?.message);
          return { success: true, action: 'NO_ACTION', reason: 'No tweet content provided by AI' };
        }
      }
      
      if (!tweetContent) {
        logger.info('ℹ️ Aucun contenu fourni par l\'IA pour POST_TWEET. Aucune publication forcée.');
        return { success: true, action: 'NO_ACTION', reason: 'No tweet content provided by AI' };
      }

      // Limiter strictement à la longueur maximale configurée
      const { LIMITS } = require('./config');
      if (tweetContent.length > LIMITS.maxTweetLength) {
        logger.warn(`⚠️ Contenu trop long (${tweetContent.length} caractères), troncature à ${LIMITS.maxTweetLength} caractères`);
        tweetContent = tweetContent.substring(0, LIMITS.maxTweetLength - 3) + '...';
      }
      
      // Utiliser le service TweetManager pour créer le tweet
      logger.info('🔧 Tentative d\'accès au TweetManager...');
      const { tweetManager } = require('./index');
      
      if (!tweetManager) {
        logger.error('❌ TweetManager non accessible depuis actionExecutor');
        return { success: false, error: 'TweetManager non accessible' };
      }
      
      if (typeof tweetManager.createTweet !== 'function') {
        logger.error('❌ Méthode createTweet non disponible sur TweetManager');
        return { success: false, error: 'Méthode createTweet non disponible' };
      }
      
      logger.info('✅ TweetManager accessible, création du tweet...');
      logger.info(`📝 Contenu du tweet: "${tweetContent}"`);
      logger.info(`📝 Type: ${decision.details?.tweet_type || decision.details?.post_tweet?.tweet_type || 'general'}`);
      
      const tweetResult = await tweetManager.createTweet({
        content: tweetContent,
        tweet_type: decision.details?.tweet_type || decision.details?.post_tweet?.tweet_type || 'general',
        metadata: {
          source: 'gemini_decision',
          action: decision.action,
          reason: decision.reason,
          priority: decision.priority,
          generated_at: new Date().toISOString(),
          action_type: Array.isArray(decision.action) ? 'multiple' : 'single'
        }
      });
      
      if (!tweetResult.success) {
        logger.error('❌ Échec de la création du tweet:', tweetResult.error);
        return { success: false, error: tweetResult.error };
      }
      
      const tweet = tweetResult.tweet;
      logger.info('✅ Tweet créé avec succès, ID:', tweet?.id);

      // Mettre à jour la mémoire
      const { memoryManager, conceptManager } = require('./index');
      await memoryManager.update({
        tweetHistory: [{
          id: tweet.id,
          content: tweetContent,
          action: decision.action,
          timestamp: new Date()
        }],
        lastActions: [`posted_tweet_${tweet.id}`]
      });

      // Marquer automatiquement le concept le plus probable comme "used"
      try {
        await conceptManager?.markConceptUsedFromContent?.(tweetContent);
      } catch (conceptErr) {
        logger.warn('⚠️ ConceptManager markUsed échoué:', conceptErr?.message);
      }

      // Marquer les tweets plateforme recents comme "deja traites" pour eviter les redites
      try {
        const { dataCollector } = require('./index');
        const freshContext = await dataCollector.collectRecentData();
        const sourceTweetIds = (freshContext?.recentPlatformTweets || [])
          .map((t) => t?.id)
          .filter(Boolean)
          .slice(0, 5);

        if (sourceTweetIds.length > 0) {
          await memoryManager.markPlatformTweetsAsProcessed?.(sourceTweetIds, {
            reason: 'used_for_post_tweet',
            source_action: 'POST_TWEET'
          });
        }
      } catch (sourceMarkErr) {
        logger.warn('⚠️ Marquage tweets plateforme traites échoué:', sourceMarkErr?.message);
      }

      logger.info(`✅ Tweet créé avec succès: ${tweet.id}`);
      
      return {
        success: true,
        action: 'POST_TWEET',
        tweet_id: tweet.id,
        content: tweetContent,
        action_type: Array.isArray(decision.action) ? 'multiple' : 'single'
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la création du tweet:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute l'action de mettre à jour le profil
   */
  async executeUpdateProfile(decision) {
    try {
      logger.info('🔄 Exécution de la mise à jour du profil...');
      logger.info('🔍 Détails initiaux de la décision (profil): ' + JSON.stringify(decision.details || {}, null, 2));
      
      let newUsername = decision.details?.new_username;
      let newFullName = decision.details?.new_full_name;
      let newBio = decision.details?.new_bio;
      let newProfilePicture = decision.details?.new_profile_picture;
      const hasAnyProfileValue = () => [newUsername, newFullName, newBio, newProfilePicture]
        .some(value => value !== undefined && value !== null);
      
      if (!hasAnyProfileValue()) {
        logger.warn('⚠️ Données de profil manquantes dans la décision, tentative de suggestion via Gemini');
        try {
          const { geminiIntelligence } = require('./index');
          const currentProfile = await require('../../models').User.findByPk(require('./config').POLICE_ACCOUNT_ID, { attributes: ['username', 'full_name'] });
          const suggestion = await geminiIntelligence.generateProfileUpdateSuggestion({
            action: 'UPDATE_PROFILE',
            reason: decision.reason,
            priority: decision.priority,
            details: decision.details
          }, currentProfile);
          
          if (suggestion) {
            if (!newUsername && suggestion.new_username) newUsername = suggestion.new_username;
            if (!newFullName && suggestion.new_full_name) newFullName = suggestion.new_full_name;
            logger.info(`✅ Suggestion profil reçue: username=${suggestion.new_username || '(inchangé)'}, full_name=${suggestion.new_full_name || '(inchangé)'} | reason=${suggestion.reason}`);
          }
          
          // Fallback sur le profil actuel si suggestion échoue
          if (!newUsername) newUsername = currentProfile?.username;
          if (!newFullName) newFullName = currentProfile?.full_name || 'PolicierCongo 🇨🇩';
        } catch (e) {
          logger.warn('⚠️ Échec de la suggestion de profil via Gemini:', e?.message);
        }
      }

      if (!hasAnyProfileValue()) {
        logger.warn('⚠️ Toujours pas de données de profil suffisantes après tentative, application d\'un fallback local');
        try {
          const { User } = require('../../models');
          const current = await User.findByPk(require('./config').POLICE_ACCOUNT_ID, { attributes: ['username', 'full_name'] });
          if (current) {
            newUsername = current.username;
            const hasFlag = (current.full_name || '').includes('🇨🇩');
            newFullName = hasFlag ? current.full_name : `${current.full_name || 'PolicierCongo'} 🇨🇩`;
            logger.info(`✅ Fallback profil: username=${newUsername}, full_name=${newFullName}`);
          }
        } catch (e) {
          logger.warn('⚠️ Fallback local profil impossible:', e?.message);
        }
        // Si encore insuffisant, déclencher une requête dédiée à Gemini avec la mémoire complète
        if (!hasAnyProfileValue()) {
          try {
            const { geminiIntelligence, memoryManager, dataCollector } = require('./index');
            const currentProfile = await require('../../models').User.findByPk(require('./config').POLICE_ACCOUNT_ID, { attributes: ['username', 'full_name'] });
            const memorySummary = await memoryManager.getCompleteContextForAI?.();
            const suggestion = await geminiIntelligence.requestProfileUpdateFromMemory(currentProfile?.toJSON?.() || currentProfile, memorySummary || {});
            if (suggestion) {
              if (suggestion.new_full_name) newFullName = suggestion.new_full_name;
              if (suggestion.new_username) newUsername = suggestion.new_username;
              logger.info(`✅ Suggestion profil via mémoire: username=${newUsername || '(inchangé)'}, full_name=${newFullName || '(inchangé)'} | reason=${suggestion.reason}`);
            }
          } catch (reqErr) {
            logger.warn('⚠️ Requête dédiée Gemini pour profil échouée:', reqErr?.message);
          }
        }
        if (!hasAnyProfileValue()) {
          return { success: false, error: 'Données de profil manquantes' };
        }
      }

      // Utiliser le service User pour mettre à jour le profil
      const { User } = require('../../models');
      const profileUpdates = { updated_at: new Date() };
      if (newUsername !== undefined && newUsername !== null) profileUpdates.username = newUsername;
      if (newFullName !== undefined && newFullName !== null) profileUpdates.full_name = newFullName;
      if (newBio !== undefined && newBio !== null) profileUpdates.bio = newBio;
      if (newProfilePicture !== undefined && newProfilePicture !== null) profileUpdates.avatar = newProfilePicture;
      let updated = false;
      try {
        const [affected] = await User.update(profileUpdates, {
          where: { id: require('./config').POLICE_ACCOUNT_ID },
          returning: false,
          validate: false
        });
        updated = affected > 0;
      } catch (bulkErr) {
        logger.warn('⚠️ Mise à jour bulk du profil échouée, tentative via instance:', bulkErr?.message);
      }

      if (!updated) {
        try {
          const userInstance = await User.findByPk(require('./config').POLICE_ACCOUNT_ID);
          if (!userInstance) {
            logger.warn('⚠️ Utilisateur PolicierCongo introuvable pour mise à jour de profil');
            return { success: false, error: 'Utilisateur introuvable' };
          }
          if (newUsername) userInstance.username = newUsername;
          if (newFullName) userInstance.full_name = newFullName;
          if (newBio !== undefined && newBio !== null) userInstance.bio = newBio;
          if (newProfilePicture !== undefined && newProfilePicture !== null) userInstance.avatar = newProfilePicture;
          userInstance.updated_at = new Date();
          await userInstance.save({ validate: false, hooks: true });
          updated = true;
        } catch (instErr) {
          logger.error('❌ Échec de la mise à jour via instance:', instErr);
          return { success: false, error: 'Mise à jour du profil échouée' };
        }
      }

      const updatedUser = await User.findByPk(require('./config').POLICE_ACCOUNT_ID, { attributes: ['username', 'full_name', 'bio', 'avatar', 'updated_at'] });
      const expected = Object.fromEntries(Object.entries(profileUpdates).filter(([key]) => key !== 'updated_at'));
      const mismatches = Object.entries(expected).filter(([key, value]) => updatedUser?.get(key) !== value);
      if (!updatedUser || mismatches.length) {
        const fields = mismatches.map(([key]) => key).join(', ') || 'profil';
        logger.error(`❌ Mise à jour profil non persistée pour: ${fields}`);
        return { success: false, error: `Mise à jour non persistée pour: ${fields}` };
      }
      logger.info(`✅ Profil vérifié après écriture: username=${updatedUser.username}, full_name=${updatedUser.full_name}, bio=${updatedUser.bio || '(vide)'}`);

      // Mettre à jour la mémoire
      try {
        const { memoryManager } = require('./index');
        Promise.resolve(memoryManager.update({
          profileUpdateHistory: [{
            username: updatedUser.username,
            full_name: updatedUser.full_name,
            bio: updatedUser.bio,
            avatar: updatedUser.avatar,
            timestamp: new Date(),
            reason: decision.reason
          }],
          lastActions: ['updated_profile']
        })).catch(error => logger.warn('⚠️ Mémoire legacy profil non mise à jour (non bloquant):', error?.message));
      } catch (memoryError) {
        logger.warn('⚠️ Mémoire legacy profil indisponible (non bloquant):', memoryError?.message);
      }

      logger.info('✅ Profil mis à jour et vérifié');
      
      return {
        success: true,
        action: 'UPDATE_PROFILE',
        username: updatedUser.username,
        full_name: updatedUser.full_name,
        bio: updatedUser.bio,
        avatar: updatedUser.avatar,
        verified_persisted: true
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour du profil:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute l'action de supprimer un tweet (EXTRÊME URGENCE SEULEMENT)
   */
  async executeDeleteTweet(decision) {
    try {
      logger.info('🚨🚨🚨 EXÉCUTION DE SUPPRESSION DE TWEET D\'URGENCE...');
      
      // Validation stricte des conditions d'urgence
      const emergencyLevel = decision.details?.emergency_level;
      const legalJustification = decision.details?.legal_justification;
      const deleteReason = decision.details?.delete_reason;
      
      if (!emergencyLevel || emergencyLevel !== 'critical') {
        logger.error('❌❌❌ TENTATIVE DE SUPPRESSION NON AUTORISÉE - Niveau d\'urgence insuffisant');
        return { 
          success: false, 
          error: 'Suppression non autorisée - Niveau d\'urgence insuffisant',
          required: 'critical_emergency_level'
        };
      }
      
      if (!legalJustification || !deleteReason) {
        logger.error('❌❌❌ TENTATIVE DE SUPPRESSION NON AUTORISÉE - Justification légale manquante');
        return { 
          success: false, 
          error: 'Suppression non autorisée - Justification légale manquante',
          required: 'legal_justification'
        };
      }
      
      // Vérifier que la raison est valide (contenu illégal, dangereux, menaçant)
      const validReasons = ['illégal', 'dangereux', 'menaçant', 'sécurité publique', 'urgence'];
      const hasValidReason = validReasons.some(reason => 
        deleteReason.toLowerCase().includes(reason) || 
        legalJustification.toLowerCase().includes(reason)
      );
      
      if (!hasValidReason) {
        logger.error('❌❌❌ TENTATIVE DE SUPPRESSION NON AUTORISÉE - Raison invalide');
        return { 
          success: false, 
          error: 'Suppression non autorisée - Raison invalide',
          required: 'valid_emergency_reason'
        };
      }
      
      const tweetId = decision.details?.tweet_id;
      if (!tweetId) {
        logger.warn('⚠️ ID de tweet manquant dans la décision');
        return { success: false, error: 'ID de tweet manquant' };
      }

      // Utiliser le service TweetManager pour supprimer le tweet
      const { tweetManager } = require('./index');
      const tweet = await tweetManager.getTweet(tweetId);
      
      if (!tweet) {
        logger.warn(`⚠️ Tweet ${tweetId} non trouvé`);
        return { success: false, error: 'Tweet non trouvé' };
      }

      // LOG D'URGENCE - Enregistrer les détails de la suppression
      logger.warn(`🚨🚨🚨 SUPPRESSION D'URGENCE AUTORISÉE - Tweet ${tweetId}`);
      logger.warn(`🚨 Raison: ${deleteReason}`);
      logger.warn(`🚨 Justification légale: ${legalJustification}`);
      logger.warn(`🚨 Niveau d'urgence: ${emergencyLevel}`);
      logger.warn(`🚨 Contenu du tweet: ${tweet.content.substring(0, 100)}...`);

      // Supprimer le tweet
      await tweetManager.deleteTweet(tweetId);

      // Mettre à jour la mémoire avec les détails d'urgence
      const { memoryManager } = require('./index');
      await memoryManager.update({
        tweetHistory: [], // À récupérer depuis la mémoire actuelle et filtrer
        lastActions: [`emergency_deleted_tweet_${tweetId}`],
        emergencyLog: [{
          action: 'emergency_tweet_deletion',
          tweet_id: tweetId,
          reason: deleteReason,
          legal_justification: legalJustification,
          emergency_level: emergencyLevel,
          timestamp: new Date(),
          content_preview: tweet.content.substring(0, 100)
        }]
      });

      logger.warn(`🚨🚨🚨 TWEET ${tweetId} SUPPRIMÉ D'URGENCE AVEC SUCCÈS`);
      
      return {
        success: true,
        action: 'DELETE_TWEET',
        deleted_tweet_id: tweetId,
        emergency_level: emergencyLevel,
        legal_justification: legalJustification,
        reason: deleteReason
      };
    } catch (error) {
      logger.error('❌❌❌ Erreur lors de la suppression d\'urgence du tweet:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute l'action de répondre à un utilisateur
   */
  async executeRespondToUser(decision) {
    try {
      logger.info('💬 Exécution de la réponse à l\'utilisateur...');
      
      // Debug: afficher la structure de la décision
      logger.info('🔍 Structure de la décision reçue:', JSON.stringify(decision.details, null, 2));
      
      let targetUser = decision.details?.target_user;
      let responseContent = decision.details?.response_content;
      let parentTweetId = decision.details?.parent_tweet_id;
      
      // Si c'est une action multiple, chercher les détails dans les sous-détails
      if (!targetUser && decision.details?.respond_to) {
        targetUser = decision.details.respond_to.target_user;
        responseContent = decision.details.respond_to.response_content;
        parentTweetId = decision.details.respond_to.parent_tweet_id;
      }
      
      // Vérifier si le parent_tweet_id est directement dans les détails
      if (!parentTweetId && decision.details?.parent_tweet_id) {
        parentTweetId = decision.details.parent_tweet_id;
        logger.info(`✅ Parent tweet ID trouvé dans les détails: ${parentTweetId}`);
      }
      const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      
      // Gestion des réponses multiples dans les actions multiples
      if (!targetUser && decision.details?.respond_to_users && Array.isArray(decision.details.respond_to_users)) {
        logger.info(`🔄 Détection de ${decision.details.respond_to_users.length} utilisateurs à répondre...`);
        
        // Traiter le premier utilisateur de la liste
        const firstUser = decision.details.respond_to_users[0];
        targetUser = firstUser.target_user;
        responseContent = firstUser.response_content;
        parentTweetId = firstUser.parent_tweet_id;
        
        // Validation UUID immédiate pour le tweet parent
        if (parentTweetId && !uuidRegex.test(parentTweetId)) {
          logger.warn(`⚠️ ID de tweet parent invalide (non-UUID) fourni par l'IA: ${parentTweetId}. Recherche d'un tweet parent valide...`);
          parentTweetId = null; // Forcer la recherche dans la DB
        }
        
        logger.info(`📝 Traitement du premier utilisateur: @${targetUser} (tweet parent: ${parentTweetId})`);
        logger.info(`📝 Contenu du commentaire: "${firstUser.comment_content || 'N/A'}"`);
        
        // Mettre à jour la liste pour les prochaines exécutions
        if (decision.details.respond_to_users.length > 1) {
          decision.details.respond_to_users = decision.details.respond_to_users.slice(1);
          logger.info(`⏳ ${decision.details.respond_to_users.length} utilisateurs restants à traiter`);
        }
      }
      
      // Si le contenu de réponse manque, le générer automatiquement
      if (!responseContent) {
        logger.info('🔧 Génération automatique du contenu de réponse...');
        const { geminiIntelligence } = require('./index');
        responseContent = await geminiIntelligence.generateResponseContent(decision);
        
        if (!responseContent) {
          logger.warn('⚠️ Impossible de générer le contenu de réponse');
          return { success: false, error: 'Génération de contenu échouée' };
        }
      }
      
      // Limiter strictement à la longueur maximale configurée
      const { LIMITS: POLICE_LIMITS } = require('./config');
      if (responseContent.length > POLICE_LIMITS.maxTweetLength) {
        logger.warn(`⚠️ Contenu trop long (${responseContent.length} caractères), troncature à ${POLICE_LIMITS.maxTweetLength} caractères`);
        responseContent = responseContent.substring(0, POLICE_LIMITS.maxTweetLength - 3) + '...';
      }
      
      if (!targetUser) {
        logger.warn('⚠️ Utilisateur cible manquant dans la décision (non bloquant)');
      }
      
      // Réponse possible sur n'importe quel tweet tant qu'un ID valide est fourni
      if (!parentTweetId) {
        logger.warn('⚠️ parent_tweet_id manquant pour RESPOND_TO_USER');
        return { success: false, error: 'parent_tweet_id requis pour répondre à un tweet' };
      }
      if (!uuidRegex.test(parentTweetId)) {
        logger.warn(`⚠️ parent_tweet_id invalide: ${parentTweetId}`);
        return { success: false, error: 'parent_tweet_id invalide (UUID attendu)' };
      }

      // Vérifier que le tweet parent existe réellement
      try {
        const { Tweet } = require('../../models');
        const parentTweet = await Tweet.findByPk(parentTweetId, { attributes: ['id', 'user_id', 'parent_tweet_id'] });
        if (!parentTweet) {
          logger.warn(`⚠️ parent_tweet_id introuvable en base: ${parentTweetId}`);
          return { success: false, error: 'parent_tweet_id introuvable' };
        }
      } catch (parentCheckError) {
        logger.error('❌ Erreur lors de la vérification du parent_tweet_id:', parentCheckError);
        return { success: false, error: 'Vérification parent_tweet_id échouée' };
      }

      // Empêcher de répondre à un commentaire déjà répondu par PolicierCongo
      if (parentTweetId) {
        try {
          const { tweetManager } = require('./index');
          const { POLICE_ACCOUNT_ID } = require('./config');
          const can = await tweetManager.canReplyToTweet(parentTweetId, POLICE_ACCOUNT_ID);
          if (!can.canReply && can.reason === 'Déjà répondu') {
            logger.info(`⏭️ Réponse ignorée: commentaire ${parentTweetId} déjà répondu par PolicierCongo`);
            return { success: true, action: 'NO_ACTION', reason: 'already_replied' };
          }
        } catch (checkErr) {
          logger.warn('⚠️ Vérification canReplyToTweet échouée:', checkErr?.message);
        }
      }
      
      // Utiliser le service TweetManager pour créer la réponse
      const { tweetManager } = require('./index');
      const responseTweetResult = await tweetManager.createReplyTweet({
        content: responseContent,
        parent_tweet_id: parentTweetId,
        target_user: targetUser,
        reason: decision.reason,
        priority: decision.priority,
        auto_generated: !responseContent || !decision.details?.response_content,
        response_context: decision.details?.respond_to?.response_context || 
                         decision.details?.response_context ||
                         (decision.details?.respond_to_users && decision.details.respond_to_users[0] ? 
                          decision.details.respond_to_users[0].response_context : null),
        comment_content: decision.details?.respond_to_users && decision.details.respond_to_users[0] ? 
          decision.details.respond_to_users[0].comment_content : null
      });
      
      if (!responseTweetResult.success) {
        logger.error('❌ Échec de la création de la réponse:', responseTweetResult.error);
        return { success: false, error: responseTweetResult.error };
      }
      
      const responseTweet = responseTweetResult.reply_tweet;

      // Mettre à jour la mémoire
      const { memoryManager } = require('./index');
      await memoryManager.update({
        lastActions: [`responded_to_${targetUser}`],
        engagementHistory: [{
          action: 'user_response',
          target_user: targetUser,
          tweet_id: responseTweet.id,
          parent_tweet_id: parentTweetId,
          timestamp: new Date(),
          response_context: decision.details?.respond_to?.response_context || 
                           decision.details?.response_context ||
                           (decision.details?.respond_to_users && decision.details.respond_to_users[0] ? 
                            decision.details.respond_to_users[0].response_context : null),
          comment_content: decision.details?.respond_to_users && decision.details.respond_to_users[0] ? 
            decision.details.respond_to_users[0].comment_content : null
        }]
      });

      // IMPORTANT: on enregistre aussi le contenu de la réponse générée
      // pour faire évoluer la personnalité à partir de "ce que PolicierCongo fait"
      // (pas seulement à partir de ce que les autres disent).
      try {
        const commentContent =
          decision.details?.respond_to_users && decision.details.respond_to_users[0]
            ? decision.details.respond_to_users[0].comment_content
            : (decision.details?.respond_to?.comment_content || decision.details?.comment_content || '');

        const responseContext =
          decision.details?.respond_to?.response_context ||
          decision.details?.response_context ||
          (decision.details?.respond_to_users && decision.details.respond_to_users[0] ? decision.details.respond_to_users[0].response_context : null);

        await memoryManager.addSignificantInteraction({
          tweet_id: responseTweet.id,
          user_username: targetUser,
          user_full_name: null,
          content: responseContent,
          timestamp: new Date(),
          type: 'response_under_tweet',
          importance: decision.priority || 'medium',
          context: {
            response_context: responseContext,
            parent_tweet_id: parentTweetId || null
          },
          user_request: commentContent || 'interaction_commentaire',
          response_given: responseContent,
          follow_up_needed: false
        });
      } catch (e) {
        logger.warn('⚠️ Enregistrement interaction perso (réponse) échoué:', e?.message || e);
      }

      // Marquer le commentaire comme répondu pour ne pas le re-proposer
      try {
        await memoryManager.markCommentAsReplied(parentTweetId, {
          user: targetUser,
          response_tweet_id: responseTweet.id,
          reason: decision.reason
        });
      } catch (_) {}

      logger.info(`✅ Réponse créée pour @${targetUser}: ${responseTweet.id} (parent: ${parentTweetId || 'aucun'})`);
      
      return {
        success: true,
        action: 'RESPOND_TO_USER',
        response_tweet_id: responseTweet.id,
        target_user: targetUser,
        content: responseContent,
        parent_tweet_id: parentTweetId,
        auto_generated: !responseContent || !decision.details?.response_content,
        action_type: Array.isArray(decision.action) ? 'multiple' : 'single',
        remaining_users: decision.details?.respond_to_users || [],
        multiple_response: decision.details?.respond_to_users ? true : false,
        comment_content: decision.details?.respond_to_users && decision.details.respond_to_users[0] ? 
          decision.details.respond_to_users[0].comment_content : null
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la création de la réponse:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute la désactivation (Suicide social)
   */
  async executeDeactivate(decision) {
    try {
      logger.warn('🚨 DÉBUT DE LA PROCÉDURE DE SUICIDE SOCIAL (DEACTIVATE)...');
      let tweetContent = decision.details?.content || "Je n'en peux plus. C'est trop pour moi. Adieu TwitNinf... 💔";
      
      // 1. Poster le message d'adieu
      const { tweetManager } = require('./index');
      try {
        await tweetManager.createTweet({
          content: tweetContent,
          tweet_type: 'general',
          metadata: { action: 'DEACTIVATE', reason: decision.reason }
        });
        logger.warn('🚨 TWEET D\'ADIEU POSTÉ.');
      } catch(e) {
        logger.error('❌ Impossible de poster le tweet d\'adieu:', e);
      }

      // 2. Créer le fichier de verrouillage
      const fs = require('fs');
      const path = require('path');
      const lockPath = path.join(__dirname, '.suicide_lock');
      fs.writeFileSync(lockPath, JSON.stringify({
        deactivatedAt: new Date().toISOString(),
        reason: decision.reason
      }), 'utf8');

      logger.warn('🚨🚨🚨 LE COMPTE EST MAINTENANT VERROUILLÉ DÉFINITIVEMENT.');
      
      return {
        success: true,
        action: 'DEACTIVATE',
        reason: decision.reason
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la désactivation:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute un Like technique
   */
  async executeLike(decision) {
    try {
      const { tweetManager } = require('./index');
      const tweetId = decision.details?.parent_tweet_id || decision.details?.target_id;
      if (!tweetId) throw new Error('parent_tweet_id manquant pour LIKE');

      const result = await tweetManager.likeTweet(tweetId);
      return { ...result, action: 'LIKE' };
    } catch (error) {
      logger.error('❌ Erreur executeLike:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute un Repost technique
   */
  async executeRepost(decision) {
    try {
      const { tweetManager } = require('./index');
      const tweetId = decision.details?.parent_tweet_id || decision.details?.target_id;
      if (!tweetId) throw new Error('parent_tweet_id manquant pour REPOST');

      const result = await tweetManager.retweetTweet(tweetId);
      return { ...result, action: 'REPOST' };
    } catch (error) {
      logger.error('❌ Erreur executeRepost:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute un Follow technique
   */
  async executeFollow(decision) {
    try {
      const { tweetManager } = require('./index');
      const targetUserId = decision.details?.target_user_id || decision.details?.target_id;
      if (!targetUserId) throw new Error('target_user_id manquant pour FOLLOW');

      const result = await tweetManager.followUser(targetUserId);
      return { ...result, action: 'FOLLOW' };
    } catch (error) {
      logger.error('❌ Erreur executeFollow:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute l'envoi d'une notification (DM)
   */
  async executeNotify(decision) {
    try {
      let targetUserId = decision.details?.target_user || decision.details?.userId;
      const content = decision.content || decision.details?.content;
      if (!targetUserId || !content) throw new Error('target_user ou content manquant pour NOTIFY');

      // Résolution handle -> UUID si nécessaire
      const resolvedId = await this._resolveTargetToUuid(targetUserId);
      if (resolvedId) targetUserId = resolvedId;

      const result = await messagingManager.sendPrivateMessage(targetUserId, content);
      return { ...result, action: 'NOTIFY' };
    } catch (error) {
      logger.error('❌ Erreur executeNotify:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute un signalement (Moderation)
   */
  async executeModerate(decision) {
    try {
      let targetId = decision.details?.parent_tweet_id || decision.details?.target_user || decision.details?.target_id;
      const targetType = decision.details?.parent_tweet_id ? 'tweet' : 'user';
      const reason = decision.reason || decision.details?.reason || 'Contenu inapproprié détecté par PolicierCongo';
      const severity = decision.details?.severity || 'medium';

      if (!targetId) throw new Error('Cible manquante pour MODERATE');

      // Résolution handle -> UUID si c'est un utilisateur
      if (targetType === 'user') {
        const resolvedId = await this._resolveTargetToUuid(targetId);
        if (resolvedId) targetId = resolvedId;
      }

      const result = await moderationManager.createReport(targetId, targetType, reason, severity);
      return { ...result, action: 'MODERATE' };
    } catch (error) {
      logger.error('❌ Erreur executeModerate:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Exécute une action cognitive (interne, pas d'effet de bord direct sur la plateforme)
   */
  async executeCognitiveAction(decision) {
    try {
      const type = String(decision.action).toUpperCase();
      logger.info(`🧠 Action cognitive [${type}] : ${decision.reason || 'Analyse en cours'}`);
      
      // Ici on pourrait persister le résultat de l'analyse dans la mémoire longue du bot
      // Pour l'instant on acquitte juste le succès car l'IA utilise store_memory de toute façon
      // via finalizeTurn() dans PolicierCongoV2.
      
      return { 
        success: true, 
        action: type, 
        reason: decision.reason,
        processed_at: new Date().toISOString()
      };
    } catch (error) {
      logger.error('❌ Erreur executeCognitiveAction:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Évalue l'impact stratégique d'une action
   */
  assessStrategicImpact(action, result, context) {
    if (!result.success) return 'negative';
    
    const impact = {
      community_engagement: 'neutral',
      strategic_value: 'medium',
      momentum_building: 'neutral'
    };
    
    // Évaluer l'engagement communautaire
    if (action.type === 'RESPOND_TO_USER' && result.response_tweet_id) {
      impact.community_engagement = 'positive';
    } else if (action.type === 'POST_TWEET' && result.tweet_id) {
      impact.community_engagement = 'positive';
    }
    
    // Évaluer la valeur stratégique
    if (action.priority === 'critical') {
      impact.strategic_value = 'high';
    } else if (action.priority === 'low') {
      impact.strategic_value = 'low';
    }
    
    // Évaluer le building du momentum
    if (context.previous_context.recent_actions.length > 0) {
      const recentSuccess = context.previous_context.recent_actions.filter(a => a.success).length;
      if (recentSuccess > context.previous_context.recent_actions.length / 2) {
        impact.momentum_building = 'positive';
      }
    }
    
    return impact;
  }

  /**
   * L'IA décide si elle veut tweeter ou non - pas de tweet forcé
   * Cette méthode est maintenant obsolète car l'IA prend ses propres décisions
   */
  // generateDefaultTweet() - SUPPRIMÉ : L'IA décide elle-même si elle veut tweeter

  /**
   * Obtient le statut de l'exécuteur d'actions
   */
  getStatus() {
    return {
      execution_count: this.executionCount,
      success_count: this.successCount,
      error_count: this.errorCount,
      success_rate: this.executionCount > 0 ? (this.successCount / this.executionCount * 100).toFixed(2) + '%' : '0%',
      last_execution: this.lastExecution
    };
  }

  /**
   * Réinitialise les statistiques
   */
  reset() {
    this.executionCount = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.lastExecution = null;
    
    logger.info('🔄 Statistiques de l\'exécuteur d\'actions réinitialisées');
  }

  /**
   * Exécute l'action de demander un débannissement
   */
  async executeUnbanRequest(decision) {
    try {
      logger.info('🔓 Exécution de la demande d\'unban par PolicierCongo...');
      
      const reason = decision.details?.reason || decision.reason || "Demande de débannissement automatique générée par PolicierCongo pour tester ou restaurer ses capacités.";
      
      const { UnbanTicket, User } = require('../../models');
      const config = require('./config');
      
      const user = await User.findByPk(config.POLICE_ACCOUNT_ID);
      if (!user) {
        return { success: false, error: 'Utilisateur PolicierCongo non trouvé' };
      }

      // Vérifier s'il y a déjà un ticket en attente
      const existingTicket = await UnbanTicket.findOne({
        where: {
          user_id: user.id,
          status: 'pending'
        }
      });

      if (existingTicket) {
        logger.info('ℹ️ Un ticket d\'unban est déjà en attente pour PolicierCongo.');
        return { success: true, action: 'UNBAN_REQUEST', message: 'Ticket déjà en attente', ticket_id: existingTicket.id };
      }

      // Création du ticket
      const ticket = await UnbanTicket.create({
        user_id: user.id,
        reason: reason,
        status: 'pending'
      });

      logger.info(`✅ Ticket d'unban créé pour PolicierCongo: ${ticket.id}`);
      
      return {
        success: true,
        action: 'UNBAN_REQUEST',
        ticket_id: ticket.id,
        reason: reason
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la création du ticket d\'unban pour PolicierCongo:', error);
      return { success: false, error: error.message };
    }
  }
  /**
   * Exécute une demande de retrait d'argent
   */
  async executeRequestWithdrawal(decision) {
    try {
      const reason = decision.details?.reason || 'Retrait des récompenses de monétisation';
      logger.info(`💰 Collecte des récompenses de monétisation en attente | Raison: ${reason}`);

      // Les récompenses de PolicierCongo sont ses propres gains (vues/likes/RT
      // sur ses tweets) : il n'y a personne d'autre à qui demander l'autorisation,
      // donc on les traite et crédite réellement au lieu de simplement journaliser
      // une "demande" fantôme qui ne débouchait jamais sur rien.
      const TweetMonetizationService = require('../tweetMonetizationService');
      const result = await TweetMonetizationService.processEligibleTweets(POLICE_ACCOUNT_ID);

      if (result.totalRewards <= 0) {
        return {
          success: true,
          action: 'REQUEST_WITHDRAWAL',
          amount: 0,
          reason,
          message: 'Aucune récompense en attente à collecter pour le moment.'
        };
      }

      logger.info(`💰 Récompenses collectées: ${result.totalRewards} sur ${result.processedCount} publication(s)`);

      return {
        success: true,
        action: 'REQUEST_WITHDRAWAL',
        amount: result.totalRewards,
        processedTweets: result.processedCount,
        reason,
        message: `${result.totalRewards} crédité(s) au portefeuille (${result.processedCount} publication(s) traitée(s)).`
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la collecte des récompenses:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = ActionExecutor;
