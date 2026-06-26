/**
 * 🧠 Gestionnaire de Mémoire PolicierCongo
 * 
 * Gère la mémoire intelligente de Gemini et l'historique des actions
 */

const logger = require('../../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const { LIMITS } = require('./config');
const memoryConfig = require('./memoryConfig');
const { sequelize } = require('../../models');
const { createLocalEmbedQuery } = require('./policiercongoV2Embeddings');

class MemoryManager {
  constructor() {
    this.memory = {
      lastAnalysis: null,
      userPreferences: {},
      engagementHistory: [],
      profileUpdateHistory: [],
      tweetHistory: [],
      lastActions: [],
      communityMood: 'neutral',
      priorities: [],
      personalityProfile: {
        traits: ['ado', 'chill', 'spontane'],
        toneKeywords: ['naturel', 'court'],
        updated_at: new Date()
      },
      lastUpdated: new Date(),
      automation_stats: {
        total_runs: 0,
        successful_runs: 0,
        failed_runs: 0,
        error_runs: 0,
        last_success: null,
        last_failure: null,
        last_error: null
      },
      processedPlatformTweets: []
    };
    
    // Chemin du fichier de sauvegarde
    this.memoryFile = path.join(__dirname, 'memory.json');
    this.backupFile = path.join(__dirname, 'memory.backup.json');
    
    // Auto-sauvegarde activée par défaut
    this.autoSave = true;
    
    // Délai de debounce pour éviter trop de sauvegardes
    this.saveTimeout = null;
    this.SAVE_DEBOUNCE_MS = 1000; // 1 seconde
    
    // Flag pour éviter les sauvegardes en boucle
    this.isSaving = false;
    
    logger.info('✅ Auto-sauvegarde activée par défaut');
  }

  async loadMemoryFromDb() {
    try {
      const [rows] = await sequelize.query(
        `
        SELECT memory_json
        FROM policiercongo_memory_states
        WHERE scope = 'global'
        LIMIT 1
        `
      );
      if (!rows.length || !rows[0].memory_json) return null;
      return rows[0].memory_json;
    } catch (error) {
      logger.warn(`⚠️ Chargement mémoire DB impossible: ${error.message}`);
      return null;
    }
  }

  async saveMemoryToDb(memoryData) {
    try {
      await sequelize.query(
        `
        INSERT INTO policiercongo_memory_states (scope, memory_json, created_at, updated_at)
        VALUES ('global', :memoryJson::jsonb, NOW(), NOW())
        ON CONFLICT (scope)
        DO UPDATE SET memory_json = :memoryJson::jsonb, updated_at = NOW()
        `,
        { replacements: { memoryJson: JSON.stringify(memoryData) } }
      );
      return true;
    } catch (error) {
      logger.warn(`⚠️ Sauvegarde mémoire DB impossible: ${error.message}`);
      return false;
    }
  }

  /**
   * Initialise le gestionnaire de mémoire
   */
  async initialize() {
    try {
      logger.info('🧠 Initialisation du gestionnaire de mémoire...');
      
      // Charger la mémoire depuis le fichier JSON
      await this.loadMemory();
      
      logger.info('✅ Gestionnaire de mémoire initialisé');
      return true;
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation de la mémoire:', error);
      return false;
    }
  }

  /**
   * Met à jour la mémoire avec de nouvelles informations
   */
  async update(newData) {
    try {
      this.memory = {
        ...this.memory,
        ...newData,
        lastUpdated: new Date()
      };
      
      // Limiter la taille des tableaux pour éviter la surcharge
      this._limitArraySizes();
      
      // Sauvegarder automatiquement avec debounce
      await this._autoSave();
      
      logger.info('🧠 Mémoire mise à jour:', Object.keys(newData));
      return true;
    } catch (error) {
      logger.error('❌ Erreur lors de la mise à jour de la mémoire:', error);
      return false;
    }
  }

  /**
   * Sauvegarde automatique avec debounce
   */
  async _autoSave() {
    if (!this.autoSave || this.isSaving) {
      return;
    }

    // Annuler la sauvegarde précédente si elle existe
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    // Programmer la sauvegarde avec un délai
    this.saveTimeout = setTimeout(async () => {
      try {
        await this.saveMemory();
      } catch (error) {
        logger.error('❌ Erreur lors de la sauvegarde automatique:', error);
      }
    }, this.SAVE_DEBOUNCE_MS);
  }

  /**
   * Limite la taille des tableaux pour éviter la surcharge
   */
  _limitArraySizes() {
    if (this.memory.engagementHistory.length > LIMITS.maxMemoryEntries) {
      this.memory.engagementHistory = this.memory.engagementHistory.slice(-LIMITS.maxMemoryEntries);
    }
    
    if (this.memory.tweetHistory.length > LIMITS.maxMemoryEntries) {
      this.memory.tweetHistory = this.memory.tweetHistory.slice(-LIMITS.maxMemoryEntries);
    }
    
    if (this.memory.lastActions.length > LIMITS.maxActionsHistory) {
      this.memory.lastActions = this.memory.lastActions.slice(-LIMITS.maxActionsHistory);
    }
  }

  /**
   * Obtient le statut de la mémoire
   */
  getStatus() {
    return {
      memorySize: {
        engagementHistory: this.memory.engagementHistory.length,
        tweetHistory: this.memory.tweetHistory.length,
        profileUpdateHistory: this.memory.profileUpdateHistory.length,
        lastActions: this.memory.lastActions.length
      },
      lastUpdated: this.memory.lastUpdated,
      communityMood: this.memory.communityMood,
      priorities: this.memory.priorities,
      personalityProfile: this.memory.personalityProfile || {},
      lastAnalysis: this.memory.lastAnalysis,
      automation_stats: this.memory.automation_stats,
      autoSave: this.autoSave
    };
  }

  /**
   * Obtient la mémoire complète
   */
  getMemory() {
    return { ...this.memory };
  }

  /**
   * Obtient une partie spécifique de la mémoire
   */
  getMemorySection(section) {
    return this.memory[section] || null;
  }

  /**
   * Met à jour une section spécifique de la mémoire
   */
  async updateSection(section, data) {
    if (this.memory.hasOwnProperty(section)) {
      this.memory[section] = data;
      this.memory.lastUpdated = new Date();
      
      // Auto-sauvegarde
      await this._autoSave();
      
      return true;
    }
    return false;
  }

  /**
   * Ajoute une action à l'historique
   */
  async addAction(action) {
    this.memory.lastActions.push({
      ...action,
      timestamp: new Date()
    });
    this._limitArraySizes();
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Ajoute un tweet à l'historique
   * TOUJOURS ajouter, même si similaire - garde l'historique complet
   */
  async addTweet(tweetData) {
    // TOUJOURS ajouter un nouveau tweet à la liste
    this.memory.tweetHistory.push({
      ...tweetData,
      timestamp: tweetData.timestamp || new Date(),
      created_at: tweetData.created_at || new Date(),
      added_at: new Date() // Timestamp d'ajout à la mémoire
    });
    
    this._limitArraySizes();
    logger.info('➕ Tweet ajouté à l\'historique (total:', this.memory.tweetHistory.length, ')');
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Ajoute une action à l'historique
   * TOUJOURS ajouter, même si similaire
   */
  async addAction(action) {
    this.memory.lastActions.push({
      ...(typeof action === 'string' ? { action, description: action } : action),
      timestamp: new Date(),
      added_at: new Date()
    });
    
    this._limitArraySizes();
    logger.info('➕ Action ajoutée à l\'historique (total:', this.memory.lastActions.length, ')');
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Ajoute un engagement à l'historique
   * TOUJOURS ajouter pour garder la trace de tous les événements
   */
  async addEngagement(engagementData) {
    this.memory.engagementHistory.push({
      ...engagementData,
      timestamp: engagementData.timestamp || new Date(),
      added_at: new Date()
    });
    
    this._limitArraySizes();
    logger.info('➕ Engagement ajouté à l\'historique (total:', this.memory.engagementHistory.length, ')');
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Ajoute une mise à jour de profil à l'historique
   */
  async addProfileUpdate(updateData) {
    this.memory.profileUpdateHistory.push({
      ...updateData,
      timestamp: updateData.timestamp || new Date(),
      added_at: new Date()
    });
    
    this._limitArraySizes();
    logger.info('➕ Mise à jour de profil ajoutée (total:', this.memory.profileUpdateHistory.length, ')');
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Trouve un tweet existant dans l'historique
   * Recherche par ID, text, ou combinaison timestamp + contenu
   */
  _findExistingTweet(tweetData) {
    return this.memory.tweetHistory.findIndex(existingTweet => {
      // 1. Recherche par ID exact (le plus fiable)
      if (tweetData.id && existingTweet.id && tweetData.id === existingTweet.id) {
        return true;
      }
      
      // 2. Recherche par tweet_id ou parent_tweet_id
      if (tweetData.tweet_id && existingTweet.tweet_id && tweetData.tweet_id === existingTweet.tweet_id) {
        return true;
      }
      
      // 3. Recherche par contenu identique et timestamp proche (±5 minutes)
      if (tweetData.text && existingTweet.text && tweetData.text.trim() === existingTweet.text.trim()) {
        const timeDiff = Math.abs(
          new Date(tweetData.timestamp || tweetData.created_at || Date.now()).getTime() - 
          new Date(existingTweet.timestamp || existingTweet.created_at || Date.now()).getTime()
        );
        const fiveMinutes = 5 * 60 * 1000;
        
        if (timeDiff <= fiveMinutes) {
          return true;
        }
      }
      
      // 4. Recherche par hash de contenu (si disponible)
      if (tweetData.content_hash && existingTweet.content_hash && 
          tweetData.content_hash === existingTweet.content_hash) {
        return true;
      }
      
      return false;
    });
  }

  /**
   * Fusionne intelligemment les données de deux tweets
   * Priorité : nouvelles données > anciennes, sauf pour les timestamps de création
   */
  _mergeTweetData(existingTweet, newTweetData) {
    const merged = { ...existingTweet };
    
    // Fusionner toutes les propriétés
    Object.keys(newTweetData).forEach(key => {
      const newValue = newTweetData[key];
      const existingValue = existingTweet[key];
      
      if (newValue !== null && newValue !== undefined) {
        switch (key) {
          case 'timestamp':
          case 'created_at':
            // Garder le timestamp le plus ancien (création originale)
            if (!existingValue || new Date(newValue) < new Date(existingValue)) {
              merged[key] = newValue;
            }
            break;
            
          case 'stats':
          case 'metrics':
          case 'engagement':
            // Fusionner les statistiques en prenant les valeurs les plus élevées
            merged[key] = this._mergeStats(existingValue, newValue);
            break;
            
          case 'reactions':
          case 'replies':
          case 'mentions':
            // Fusionner les tableaux en évitant les doublons
            if (Array.isArray(existingValue) && Array.isArray(newValue)) {
              merged[key] = this._mergeArraysUnique(existingValue, newValue);
            } else {
              merged[key] = newValue;
            }
            break;
            
          case 'media':
          case 'images':
          case 'attachments':
            // Fusionner les médias
            if (Array.isArray(existingValue) && Array.isArray(newValue)) {
              merged[key] = this._mergeArraysUnique(existingValue, newValue, 'url');
            } else if (!existingValue && newValue) {
              merged[key] = newValue;
            }
            break;
            
          default:
            // Pour les autres champs, prioriser la nouvelle valeur si elle est plus complète
            if (!existingValue || 
                (typeof newValue === 'string' && newValue.length > (existingValue?.length || 0)) ||
                (typeof newValue === 'object' && Object.keys(newValue).length > Object.keys(existingValue || {}).length)) {
              merged[key] = newValue;
            }
            break;
        }
      }
    });
    
    // Toujours mettre à jour updated_at
    merged.updated_at = new Date();
    
    // Marquer comme mis à jour
    merged.update_count = (merged.update_count || 0) + 1;
    
    return merged;
  }

  /**
   * Fusionne les statistiques en prenant les valeurs les plus élevées
   */
  _mergeStats(existingStats, newStats) {
    if (!existingStats) return newStats;
    if (!newStats) return existingStats;
    
    const merged = { ...existingStats };
    
    Object.keys(newStats).forEach(key => {
      const newValue = newStats[key];
      const existingValue = existingStats[key];
      
      if (typeof newValue === 'number' && typeof existingValue === 'number') {
        // Prendre la valeur la plus élevée pour les métriques
        merged[key] = Math.max(existingValue, newValue);
      } else if (newValue !== null && newValue !== undefined) {
        merged[key] = newValue;
      }
    });
    
    return merged;
  }

  /**
   * Fusionne deux tableaux en évitant les doublons
   */
  _mergeArraysUnique(arr1, arr2, uniqueKey = null) {
    const combined = [...(arr1 || []), ...(arr2 || [])];
    
    if (uniqueKey) {
      // Supprimer les doublons basés sur une clé spécifique
      const seen = new Set();
      return combined.filter(item => {
        const key = item[uniqueKey];
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } else {
      // Supprimer les doublons basés sur la valeur complète
      return [...new Set(combined.map(JSON.stringify))].map(JSON.parse);
    }
  }

  /**
   * Met à jour les statistiques d'automatisation
   */
  async updateAutomationStats(success, error = null) {
    this.memory.automation_stats.total_runs++;
    
    if (success) {
      this.memory.automation_stats.successful_runs++;
      this.memory.automation_stats.last_success = new Date();
    } else if (error) {
      this.memory.automation_stats.error_runs++;
      this.memory.automation_stats.last_error = new Date();
    } else {
      this.memory.automation_stats.failed_runs++;
      this.memory.automation_stats.last_failure = new Date();
    }
    
    this.memory.lastUpdated = new Date();
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Met à jour l'humeur de la communauté
   */
  async updateCommunityMood(mood) {
    this.memory.communityMood = mood;
    this.memory.lastUpdated = new Date();
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Met à jour les priorités
   */
  async updatePriorities(priorities) {
    this.memory.priorities = priorities;
    this.memory.lastUpdated = new Date();
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Met à jour les préférences utilisateur
   */
  async updateUserPreferences(preferences) {
    this.memory.userPreferences = {
      ...this.memory.userPreferences,
      ...preferences
    };
    this.memory.lastUpdated = new Date();
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Obtient les préférences utilisateur
   */
  getUserPreferences() {
    return { ...this.memory.userPreferences };
  }

  /**
   * Obtient l'historique d'engagement
   */
  getEngagementHistory() {
    return [...this.memory.engagementHistory];
  }

  /**
   * Obtient l'historique des tweets
   */
  getTweetHistory() {
    return [...this.memory.tweetHistory];
  }

  /**
   * Obtient les dernières actions
   */
  getLastActions() {
    return [...this.memory.lastActions];
  }

  /**
   * Vérifie si une action a été effectuée récemment
   */
  hasRecentAction(action, withinMinutes = 60) {
    const cutoffTime = new Date(Date.now() - withinMinutes * 60 * 1000);
    return this.memory.lastActions.some(actionItem => {
      if (typeof actionItem === 'string') {
        return actionItem.includes(action);
      }
      return actionItem.action === action && 
             actionItem.timestamp && 
             new Date(actionItem.timestamp) > cutoffTime;
    });
  }

  /**
   * Obtient le dernier tweet principal
   */
  getLastMainTweet() {
    const mainTweets = this.memory.tweetHistory.filter(tweet => 
      !tweet.parent_tweet_id && tweet.action === 'POST_TWEET'
    );
    
    if (mainTweets.length > 0) {
      return mainTweets[mainTweets.length - 1];
    }
    return null;
  }

  /**
   * Ajoute une interaction significative à l'historique
   * Enregistre les dédicaces, demandes spéciales, et contextes importants
   */
  async addSignificantInteraction(interactionData) {
    const interaction = {
      ...interactionData,
      timestamp: interactionData.timestamp || new Date(),
      added_at: new Date(),
      type: interactionData.type || 'general',
      importance: interactionData.importance || 'medium',
      context: interactionData.context || '',
      user_request: interactionData.user_request || '',
      response_given: interactionData.response_given || null,
      follow_up_needed: interactionData.follow_up_needed || false
    };

    // Ajouter à la mémoire des interactions significatives
    if (!this.memory.significantInteractions) {
      this.memory.significantInteractions = [];
    }
    
    this.memory.significantInteractions.push(interaction);

    // Faire évoluer la personnalité en fonction des interactions récentes
    // On inclut aussi le texte des réponses (quand dispo), mais on le "nettoie"
    // pour éviter que des mentions interdites contaminent les traits.
    const ctxStr = typeof interaction.context === 'string'
      ? interaction.context
      : JSON.stringify(interaction.context || {});

    const reqStr = String(interaction.user_request || '');

    const respStr = typeof interaction.response_given === 'string'
      ? interaction.response_given
      : (typeof interaction.content === 'string' ? interaction.content : '');

    const safeRespStr = String(respStr)
      .replace(/@gas/gi, 'no_gas_mentions')
      .replace(/\bbails?\b/gi, 'no_bails')
      .replace(/\btransactions?\b/gi, 'no_bails')
      .replace(/\barrangements?\b/gi, 'no_bails');

    const traitKeywords = this._toKeywords(
      `${interaction.type || ''} ${ctxStr} ${reqStr} ${safeRespStr}`,
      8
    );
    if (!this.memory.personalityProfile) {
      this.memory.personalityProfile = { traits: [], toneKeywords: [], updated_at: new Date() };
    }
    const currentTraits = Array.isArray(this.memory.personalityProfile.traits) ? this.memory.personalityProfile.traits : [];
    const mergedTraits = Array.from(new Set([...traitKeywords, ...currentTraits])).slice(0, 20);
    this.memory.personalityProfile = {
      ...this.memory.personalityProfile,
      traits: mergedTraits,
      updated_at: new Date()
    };
    
    // Limiter la taille du tableau
    if (this.memory.significantInteractions.length > LIMITS.maxMemoryEntries) {
      this.memory.significantInteractions = this.memory.significantInteractions.slice(-LIMITS.maxMemoryEntries);
    }
    
    logger.info('💬 Interaction significative enregistrée:', {
      type: interaction.type,
      user: interactionData.user_username || interactionData.user_id,
      importance: interaction.importance
    });
    
    // Auto-sauvegarde
    await this._autoSave();

    // 🌉 PONT V2 : Indexer sémantiquement dans la mémoire haute-fidélité
    try {
      const metadata = {
        role: 'user',
        trigger: 'DATA_COLLECTOR_SIGNIFICANT',
        type: interaction.type,
        importance: interaction.importance,
        user_username: interactionData.user_username || null,
        username: interactionData.user_username || null,
        tweet_id: interactionData.tweet_id || null,
        context_type: 'significant_interaction'
      };
      
      const textToEmbed = `[${interaction.type}] ${interactionData.user_username || 'Utilisateur'}: ${interaction.user_request || interactionData.content || ''}`;
      
      this._syncToV2Vector(textToEmbed, interactionData.user_id, metadata);
    } catch (e) {
      logger.warn(`[memory] Échec synchronisation V2: ${e.message}`);
    }
  }

  /**
   * Pont interne pour synchroniser vers la mémoire vectorielle V2
   */
  async _syncToV2Vector(text, userId, metadata) {
    try {
      const embedder = createLocalEmbedQuery();
      const vector = await embedder(text, 'search_document');
      if (!vector || !vector.length) return;

      await sequelize.query(
        `INSERT INTO policiercongo_v2_embeddings (user_id, source_text, embedding, metadata, created_at)
         VALUES (:userId, :text, :embedding::jsonb, :metadata::jsonb, NOW())`,
        {
          replacements: {
            userId: userId || null,
            text: text.slice(0, 8000),
            embedding: JSON.stringify(vector),
            metadata: JSON.stringify(metadata)
          }
        }
      );
      logger.info(`🌉 [sync-v2] Interaction significance synchronisée (768-dim) pour ${metadata.user_username || 'inconnu'}`);
    } catch (e) {
      logger.warn(`[memory] _syncToV2Vector: ${e.message}`);
    }
  }

  /**
   * Enregistre une demande de dédicace ou de contenu spécial
   */
  async addDedicationRequest(requestData) {
    const dedication = {
      ...requestData,
      timestamp: requestData.timestamp || new Date(),
      added_at: new Date(),
      type: 'dedication_request',
      status: 'pending', // pending, fulfilled, declined
      user_username: requestData.user_username || requestData.user_id,
      request_content: requestData.request_content || '',
      user_context: requestData.user_context || '',
      priority: requestData.priority || 'medium',
      deadline: requestData.deadline || null,
      notes: requestData.notes || ''
    };

    // Ajouter à la mémoire des demandes de dédicaces
    if (!this.memory.dedicationRequests) {
      this.memory.dedicationRequests = [];
    }
    
    this.memory.dedicationRequests.push(dedication);
    
    // Limiter la taille
    if (this.memory.dedicationRequests.length > LIMITS.maxMemoryEntries) {
      this.memory.dedicationRequests = this.memory.dedicationRequests.slice(-LIMITS.maxMemoryEntries);
    }
    
    logger.info('🎯 Demande de dédicace enregistrée:', {
      user: dedication.user_username,
      priority: dedication.priority,
      content: dedication.request_content.substring(0, 50) + '...'
    });
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Enregistre une demande spéciale d'un utilisateur
   */
  async addUserSpecialRequest(requestData) {
    const specialRequest = {
      ...requestData,
      timestamp: requestData.timestamp || new Date(),
      added_at: new Date(),
      type: 'special_request',
      category: requestData.category || 'general', // conseil, aide, information, etc.
      status: 'pending', // pending, in_progress, completed, declined
      user_username: requestData.user_username || requestData.user_id,
      request_details: requestData.request_details || '',
      user_context: requestData.user_context || '',
      urgency: requestData.urgency || 'normal',
      priority: requestData.priority || 'medium',
      response_required: requestData.response_required !== false,
      follow_up_needed: requestData.follow_up_needed || false,
      notes: requestData.notes || ''
    };

    // Ajouter à la mémoire des demandes spéciales
    if (!this.memory.userSpecialRequests) {
      this.memory.userSpecialRequests = [];
    }
    
    this.memory.userSpecialRequests.push(specialRequest);
    
    // Limiter la taille
    if (this.memory.userSpecialRequests.length > LIMITS.maxMemoryEntries) {
      this.memory.userSpecialRequests = this.memory.userSpecialRequests.slice(-LIMITS.maxMemoryEntries);
    }
    
    logger.info('📝 Demande spéciale utilisateur enregistrée:', {
      user: specialRequest.user_username,
      category: specialRequest.category,
      urgency: specialRequest.urgency,
      priority: specialRequest.priority
    });
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Enregistre le contexte d'une conversation ou interaction
   */
  async addConversationContext(contextData) {
    const conversationContext = {
      ...contextData,
      timestamp: contextData.timestamp || new Date(),
      added_at: new Date(),
      type: 'conversation_context',
      conversation_id: contextData.conversation_id || `conv_${Date.now()}`,
      participants: contextData.participants || [],
      topic: contextData.topic || '',
      mood: contextData.mood || 'neutral',
      key_points: contextData.key_points || [],
      user_preferences: contextData.user_preferences || {},
      follow_up_actions: contextData.follow_up_actions || [],
      importance: contextData.importance || 'medium',
      notes: contextData.notes || ''
    };

    // Ajouter à la mémoire des contextes de conversation
    if (!this.memory.conversationContexts) {
      this.memory.conversationContexts = [];
    }
    
    this.memory.conversationContexts.push(conversationContext);
    
    // Limiter la taille
    if (this.memory.conversationContexts.length > LIMITS.maxMemoryEntries) {
      this.memory.conversationContexts = this.memory.conversationContexts.slice(-LIMITS.maxMemoryEntries);
    }
    
    logger.info('💭 Contexte de conversation enregistré:', {
      conversation_id: conversationContext.conversation_id,
      participants: conversationContext.participants.length,
      topic: conversationContext.topic,
      importance: conversationContext.importance
    });
    
    // Auto-sauvegarde
    await this._autoSave();
  }

  /**
   * Obtient le contexte complet pour l'IA Gemini
   */
  async getCompleteContextForAI() {
    const context = {
      // Informations de base
      lastUpdated: this.memory.lastUpdated,
      totalInteractions: this.memory.significantInteractions?.length || 0,
      totalDedicationRequests: this.memory.dedicationRequests?.length || 0,
      totalSpecialRequests: this.memory.userSpecialRequests?.length || 0,
      totalConversations: this.memory.conversationContexts?.length || 0,
      
      // Interactions récentes (dernières 24h)
      recentInteractions: this.memory.significantInteractions?.filter(i => {
        const hoursAgo = (new Date() - new Date(i.timestamp)) / (1000 * 60 * 60);
        return hoursAgo <= 24;
      }) || [],
      
      // Demandes de dédicaces en attente
      pendingDedications: this.memory.dedicationRequests?.filter(d => d.status === 'pending') || [],
      
      // Demandes spéciales en attente
      pendingSpecialRequests: this.memory.userSpecialRequests?.filter(r => r.status === 'pending') || [],
      
      // Contextes de conversation récents
      recentConversations: this.memory.conversationContexts?.filter(c => {
        const hoursAgo = (new Date() - new Date(c.timestamp)) / (1000 * 60 * 60);
        return hoursAgo <= 48; // Garder 48h de contexte
      }) || [],
      
      // Préférences utilisateur cumulées
      userPreferences: this.memory.userPreferences || {},
      personalityProfile: this.memory.personalityProfile || {},
      
      // Historique des tweets
      tweetHistory: this.memory.tweetHistory || [],
      
      // Actions récentes
      lastActions: this.memory.lastActions?.slice(-10) || [],
      
      // Statistiques d'automatisation
      automationStats: this.memory.automation_stats || {}
    };
    
    return context;
  }

  /**
   * Obtient le temps écoulé depuis le dernier tweet principal
   */
  getTimeSinceLastMainTweet() {
    if (!this.memory.tweetHistory || this.memory.tweetHistory.length === 0) {
      return {
        hours: null,
        minutes: null,
        total_minutes: null,
        last_tweet_date: null,
        status: 'no_tweets'
      };
    }
    
    // Trouver le dernier tweet principal (pas une réponse)
    const mainTweets = this.memory.tweetHistory.filter(tweet => 
      !tweet.parent_tweet_id && tweet.type !== 'reply'
    );
    
    if (mainTweets.length === 0) {
      return {
        hours: null,
        minutes: null,
        total_minutes: null,
        last_tweet_date: null,
        status: 'no_main_tweets'
      };
    }
    
    const lastMainTweet = mainTweets[0];
    const lastTweetDate = new Date(lastMainTweet.timestamp || lastMainTweet.created_at);
    const now = new Date();
    const timeDiff = now - lastTweetDate;
    
    const totalMinutes = Math.floor(timeDiff / (1000 * 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    
    return {
      hours,
      minutes,
      total_minutes: totalMinutes,
      last_tweet_date: lastTweetDate,
      last_tweet_content: lastMainTweet.text || lastMainTweet.content,
      status: 'has_main_tweets'
    };
  }

  /**
   * Vérifie si il faut poster un tweet principal (règle des 4h)
   */
  shouldPostMainTweet() {
    const timeSince = this.getTimeSinceLastMainTweet();
    const fourHours = 4 * 60 * 60 * 1000; // 4h en millisecondes
    return timeSince >= fourHours;
  }

  /**
   * Réinitialise la mémoire (pour les tests)
   */
  async reset() {
    this.memory = {
      lastAnalysis: null,
      userPreferences: {},
      engagementHistory: [],
      profileUpdateHistory: [],
      tweetHistory: [],
      lastActions: [],
      communityMood: 'neutral',
      priorities: [],
      personalityProfile: {
        traits: ['ado', 'chill', 'spontane'],
        toneKeywords: ['naturel', 'court'],
        updated_at: new Date()
      },
      lastUpdated: new Date(),
      automation_stats: {
        total_runs: 0,
        successful_runs: 0,
        failed_runs: 0,
        error_runs: 0,
        last_success: null,
        last_failure: null,
        last_error: null
      },
      processedPlatformTweets: []
    };
    
    // Sauvegarder immédiatement la mémoire réinitialisée
    await this.saveMemory();
    
    logger.info('🧠 Mémoire réinitialisée et sauvegardée');
    return true;
  }

  /**
   * Sauvegarde la mémoire en JSON avec système de backup
   */
  async saveMemory() {
    if (this.isSaving) {
      return false;
    }

    this.isSaving = true;

    try {
      const memoryData = {
        ...this.memory,
        lastUpdated: this.memory.lastUpdated.toISOString(),
        // Ajouter des métadonnées de sauvegarde
        _metadata: {
          version: '1.0.0',
          savedAt: new Date().toISOString(),
          nodeVersion: process.version
        }
      };

      // DB d'abord (source of truth), puis fichier fallback/debug
      await this.saveMemoryToDb(memoryData);

      // Créer un backup du fichier existant avant d'écrire
      try {
        await fs.access(this.memoryFile);
        await fs.copyFile(this.memoryFile, this.backupFile);
      } catch {
        // Fichier n'existe pas encore, pas de backup nécessaire
      }
      
      // Sauvegarder avec une écriture atomique
      const tempFile = this.memoryFile + '.tmp';
      await fs.writeFile(tempFile, JSON.stringify(memoryData, null, 2), 'utf8');
      await fs.rename(tempFile, this.memoryFile);
      
      logger.info('💾 Mémoire sauvegardée en JSON');
      return true;
    } catch (error) {
      logger.error('❌ Erreur lors de la sauvegarde de la mémoire:', error);
      
      // Tenter de restaurer depuis le backup en cas d'erreur
      try {
        await fs.copyFile(this.backupFile, this.memoryFile);
        logger.info('🔄 Backup restauré après erreur de sauvegarde');
      } catch (backupError) {
        logger.error('❌ Impossible de restaurer le backup:', backupError);
      }
      
      return false;
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * Force la sauvegarde de la mémoire
   */
  async forceSave() {
    logger.info('💾 Sauvegarde forcée de la mémoire...');
    
    // Annuler la sauvegarde avec debounce
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    
    return await this.saveMemory();
  }

  /**
   * Charge la mémoire depuis le JSON avec gestion d'erreurs améliorée
   * IMPORTANTE: Ne réinitialise JAMAIS la mémoire existante
   */
  async loadMemory() {
    try {
      logger.info('📂 Chargement de la mémoire...');

      const dbMemory = await this.loadMemoryFromDb();
      if (dbMemory && typeof dbMemory === 'object') {
        this._restoreDates(dbMemory);
        delete dbMemory._metadata;
        this.memory = this._mergeMemoryData(this.memory, dbMemory);
        logger.info('📂 Mémoire chargée depuis la DB');
        return true;
      }

      // Vérifier si le fichier principal existe
      let fileToLoad = this.memoryFile;
      let useBackup = false;

      try {
        await fs.access(this.memoryFile);
      } catch {
        // Tenter de charger le backup
        try {
          await fs.access(this.backupFile);
          fileToLoad = this.backupFile;
          useBackup = true;
          logger.warn('⚠️ Fichier principal non trouvé, chargement du backup');
        } catch {
          logger.info('📁 Aucun fichier de mémoire trouvé, CONSERVATION de la mémoire actuelle');
          // IMPORTANT: On ne réinitialise PAS - on garde la mémoire actuelle
          return true;
        }
      }

      // Lire et parser le fichier
      const memoryData = await fs.readFile(fileToLoad, 'utf8');
      
      if (!memoryData.trim()) {
        throw new Error('Fichier de mémoire vide');
      }

      let loadedMemory;
      try {
        loadedMemory = JSON.parse(memoryData);
      } catch (parseError) {
        throw new Error(`JSON invalide: ${parseError.message}`);
      }

      // Valider la structure des données
      if (!this._validateMemoryStructure(loadedMemory)) {
        logger.warn('⚠️ Structure de mémoire invalide détectée, fusion avec mémoire actuelle');
      }
      
      // Restaurer les dates avec gestion d'erreurs
      this._restoreDates(loadedMemory);
      
      // Nettoyer les métadonnées de sauvegarde
      delete loadedMemory._metadata;
      
      // FUSION INTELLIGENTE: Préserver les données existantes et ajouter les nouvelles
      this.memory = this._mergeMemoryData(this.memory, loadedMemory);
      
      if (useBackup) {
        logger.warn('🔄 Mémoire fusionnée depuis le backup');
        // Sauvegarder immédiatement pour restaurer le fichier principal
        await this.saveMemory();
      } else {
        logger.info('📂 Mémoire fusionnée depuis le fichier principal');
      }
      
      return true;
    } catch (error) {
      logger.error('❌ Erreur lors du chargement de la mémoire:', error);
      logger.info('🔄 CONSERVATION de la mémoire actuelle (aucune perte de données)');
      // IMPORTANT: En cas d'erreur, on garde la mémoire actuelle
      return false;
    }
  }

  /**
   * Fusionne intelligemment les données de mémoire
   * AJOUT de tous les éléments sans suppression
   */
  _mergeMemoryData(currentMemory, loadedMemory) {
    const merged = { ...currentMemory };

    // Pour les tableaux, AJOUTER tous les éléments (pas de fusion)
    ['engagementHistory', 'tweetHistory', 'lastActions', 'profileUpdateHistory'].forEach(arrayKey => {
      if (Array.isArray(loadedMemory[arrayKey])) {
        if (Array.isArray(currentMemory[arrayKey])) {
          // Ajouter TOUS les éléments du fichier chargé à la fin
          merged[arrayKey] = [...currentMemory[arrayKey], ...loadedMemory[arrayKey]];
        } else {
          merged[arrayKey] = loadedMemory[arrayKey];
        }
      }
      // Supprimer seulement les doublons EXACTS (même JSON)
      if (merged[arrayKey]) {
        merged[arrayKey] = this._removeDuplicateEntries(merged[arrayKey]);
      }
    });

    // Pour les objets, fusion profonde (priorité aux données chargées SAUF si les actuelles sont plus récentes)
    ['userPreferences', 'automation_stats'].forEach(objKey => {
      if (loadedMemory[objKey] && typeof loadedMemory[objKey] === 'object') {
        merged[objKey] = {
          ...(currentMemory[objKey] || {}), // Charger les défauts/actuels
          ...(loadedMemory[objKey] || {})  // ÉCRASER avec ce qui vient du fichier
        };
      }
    });

    // Pour les valeurs simples, prioriser les données CHARGÉES
    ['lastAnalysis', 'communityMood', 'priorities'].forEach(key => {
      if (loadedMemory[key] !== null && loadedMemory[key] !== undefined) {
        merged[key] = loadedMemory[key];
      }
    });

    // Cas particulier: ne pas écraser une humeur hostile ou spécifique par le défaut "neutral"
    if (merged.communityMood === 'neutral' && loadedMemory.communityMood && loadedMemory.communityMood !== 'neutral') {
      merged.communityMood = loadedMemory.communityMood;
    }

    // lastUpdated: prendre la plus récente
    if (loadedMemory.lastUpdated && currentMemory.lastUpdated) {
      merged.lastUpdated = new Date(Math.max(
        new Date(loadedMemory.lastUpdated).getTime(),
        new Date(currentMemory.lastUpdated).getTime()
      ));
    } else {
      merged.lastUpdated = loadedMemory.lastUpdated || currentMemory.lastUpdated || new Date();
    }

    logger.info('➕ Mémoire fusionnée par ajout - historique complet préservé');
    logger.info(`📊 Totaux: tweets=${merged.tweetHistory?.length}, actions=${merged.lastActions?.length}, engagements=${merged.engagementHistory?.length}`);
    
    return merged;
  }

  /**
   * Supprime les entrées dupliquées dans un tableau
   * Version simple - supprime seulement les doublons exacts
   */
  _removeDuplicateEntries(array) {
    const seen = new Set();
    return array.filter(item => {
      // Créer une clé unique simple basée sur le contenu complet
      const key = JSON.stringify(item);
      
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * Obtient tous les tweets pour un ID spécifique (historique complet)
   */
  getTweetsById(tweetId) {
    return this.memory.tweetHistory.filter(tweet => 
      tweet.id === tweetId || tweet.tweet_id === tweetId
    );
  }

  /**
   * Obtient toutes les actions d'un type spécifique
   */
  getActionsByType(actionType) {
    return this.memory.lastActions.filter(action => 
      action.action === actionType || 
      (typeof action === 'string' && action.includes(actionType))
    );
  }

  /**
   * Compte le nombre d'occurrences d'un tweet spécifique
   */
  countTweetOccurrences(tweetId) {
    return this.memory.tweetHistory.filter(tweet => 
      tweet.id === tweetId || tweet.tweet_id === tweetId
    ).length;
  }

  /**
   * Compte le nombre d'occurrences d'une action spécifique
   */
  countActionOccurrences(actionType) {
    return this.memory.lastActions.filter(action => 
      action.action === actionType || 
      (typeof action === 'string' && action.includes(actionType))
    ).length;
  }

  /**
   * Obtient les derniers N tweets
   */
  getLastNTweets(n = 10) {
    return this.memory.tweetHistory.slice(-n);
  }

  /**
   * Obtient les dernières N actions
   */
  getLastNActions(n = 10) {
    return this.memory.lastActions.slice(-n);
  }

  /**
   * Obtient tous les événements dans une période donnée
   */
  getEventsInTimeRange(startTime, endTime) {
    const start = new Date(startTime);
    const end = new Date(endTime);
    
    const tweets = this.memory.tweetHistory.filter(tweet => {
      const timestamp = new Date(tweet.timestamp || tweet.created_at);
      return timestamp >= start && timestamp <= end;
    });
    
    const actions = this.memory.lastActions.filter(action => {
      const timestamp = new Date(action.timestamp);
      return timestamp >= start && timestamp <= end;
    });
    
    const engagements = this.memory.engagementHistory.filter(engagement => {
      const timestamp = new Date(engagement.timestamp);
      return timestamp >= start && timestamp <= end;
    });
    
    return {
      tweets,
      actions,
      engagements,
      total: tweets.length + actions.length + engagements.length
    };
  }

  /**
   * Valide la structure de base de la mémoire
   */
  _validateMemoryStructure(memory) {
    const requiredFields = [
      'userPreferences',
      'engagementHistory',
      'tweetHistory',
      'lastActions',
      'automation_stats'
    ];

    return requiredFields.every(field => 
      memory.hasOwnProperty(field) && 
      (Array.isArray(memory[field]) || typeof memory[field] === 'object')
    );
  }

  /**
   * Restaure les dates depuis les chaînes ISO
   */
  _restoreDates(memory) {
    try {
      if (memory.lastUpdated) {
        memory.lastUpdated = new Date(memory.lastUpdated);
      }

      if (memory.automation_stats) {
        const stats = memory.automation_stats;
        if (stats.last_success) stats.last_success = new Date(stats.last_success);
        if (stats.last_failure) stats.last_failure = new Date(stats.last_failure);
        if (stats.last_error) stats.last_error = new Date(stats.last_error);
      }

      // Restaurer les timestamps dans les tableaux
      ['engagementHistory', 'tweetHistory', 'lastActions'].forEach(arrayName => {
        if (Array.isArray(memory[arrayName])) {
          memory[arrayName].forEach(item => {
            if (item.timestamp) {
              item.timestamp = new Date(item.timestamp);
            }
          });
        }
      });
    } catch (error) {
      logger.warn('⚠️ Erreur lors de la restauration des dates:', error);
    }
  }

  /**
   * Active/désactive l'auto-sauvegarde
   */
  setAutoSave(enabled) {
    this.autoSave = enabled;
    
    if (!enabled && this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    
    logger.info(`🔄 Auto-sauvegarde ${enabled ? 'activée' : 'désactivée'}`);
  }

  /**
   * Obtient des informations sur l'état du système de sauvegarde
   */
  getSaveStatus() {
    return {
      autoSave: this.autoSave,
      isSaving: this.isSaving,
      hasPendingSave: !!this.saveTimeout,
      memoryFile: this.memoryFile,
      backupFile: this.backupFile
    };
  }

  /**
   * Nettoie les ressources avant fermeture
   */
  async cleanup() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    
    // Sauvegarder une dernière fois si nécessaire
    if (this.autoSave && !this.isSaving) {
      await this.saveMemory();
    }
    
    logger.info('🧹 Gestionnaire de mémoire nettoyé');
  }

  /**
   * Raccourcit une chaîne à maxLen (avec ellipse)
   */
  _trimText(text, maxLen = 600) {
    if (typeof text !== 'string') return text;
    if (text.length <= maxLen) return text;
    return text.substring(0, Math.max(0, maxLen - 3)) + '...';
  }

  _toKeywords(input, limit = 20) {
    const stop = new Set([
      'le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'ou', 'a', 'au', 'aux',
      'en', 'dans', 'sur', 'pour', 'par', 'avec', 'sans', 'que', 'qui', 'quoi', 'est',
      'sont', 'etre', 'avoir', 'mais', 'donc', 'car', 'se', 'sa', 'son', 'ses', 'ne',
      'pas', 'plus', 'tres', 'trop', 'this', 'that'
    ]);
    const text = Array.isArray(input) ? input.join(' ') : String(input || '');
    const tokens = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_#@\s-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter(t => t.length >= 3 && !stop.has(t));
    const uniq = [];
    const seen = new Set();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      uniq.push(t);
      if (uniq.length >= limit) break;
    }
    return uniq;
  }

  /**
   * Résume un gros contexte d'analyse en informations essentielles
   */
  _summarizeAnalysisContext(context = {}) {
    try {
      const recentTweets = Array.isArray(context.recentTweets) ? context.recentTweets : [];
      const mainTweets = Array.isArray(context.mainTweets) ? context.mainTweets : [];
      const unreplied = Array.isArray(context.unrepliedComments) ? context.unrepliedComments : [];

      const lastMain = mainTweets.find(t => t && t.id) || null;

      return {
        counts: {
          recentTweets: recentTweets.length,
          mainTweets: mainTweets.length,
          replyTweets: Array.isArray(context.replyTweets) ? context.replyTweets.length : 0,
          replies: Array.isArray(context.replies) ? context.replies.length : 0,
          unrepliedComments: unreplied.length
        },
        sample: {
          last_main_tweet_id: lastMain ? lastMain.id : null,
          last_main_tweet_at: lastMain ? lastMain.created_at || null : null,
          unreplied_ids: unreplied.slice(0, 10).map(c => c.id)
        },
        engagement: context.engagementMetrics ? {
          total: context.engagementMetrics.total || 0,
          average: context.engagementMetrics.average || 0
        } : undefined,
        timing: context.timingAnalysis ? {
          currentTime: context.timingAnalysis.currentTime || null,
          hoursSinceLastMainTweet: context.timingAnalysis.hoursSinceLastMainTweet || null,
          shouldPostMainTweet: !!context.timingAnalysis.shouldPostMainTweet
        } : undefined
      };
    } catch (e) {
      return {};
    }
  }

  /**
   * Compacte la mémoire: garde l'essentiel et limite la taille des tableaux
   */
  async optimizeMemory() {
    try {
      // Limiter les historiques
      const keepLast = (arr, max) => (Array.isArray(arr) ? arr.slice(-max) : []);

      this.memory.engagementHistory = keepLast(this.memory.engagementHistory, 50).map(e => ({
        action: e.action,
        target_user: e.target_user,
        tweet_id: e.tweet_id,
        parent_tweet_id: e.parent_tweet_id,
        timestamp: e.timestamp
      }));

      this.memory.profileUpdateHistory = keepLast(this.memory.profileUpdateHistory, 10).map(p => ({
        username: p.username,
        full_name: this._trimText(p.full_name || '', 140),
        timestamp: p.timestamp
      }));

      this.memory.tweetHistory = keepLast(this.memory.tweetHistory, 40).map(t => ({
        id: t.id,
        content: this._trimText(t.content || '', 600),
        action: t.action,
        timestamp: t.timestamp,
        is_main_tweet: t.is_main_tweet || (!t.parent_tweet_id)
      }));

      this.memory.lastActions = keepLast(this.memory.lastActions, 30).map(a => (
        typeof a === 'string' ? a : (a.description || a.action || 'action')
      ));

      // Journal des commentaires déjà répondus
      if (Array.isArray(this.memory.repliedCommentsLog)) {
        this.memory.repliedCommentsLog = keepLast(this.memory.repliedCommentsLog, 200).map(x => ({
          comment_id: x.comment_id,
          added_at: x.added_at
        }));
      }

      // Analyses intelligentes: garder 5 et compacter
      if (Array.isArray(this.memory.intelligentAnalyses)) {
        this.memory.intelligentAnalyses = keepLast(this.memory.intelligentAnalyses, 5).map(a => ({
          action: a.action,
          decision_made: a.decision_made || a.action,
          reason: this._trimText(a.reason || a.reasoning || '', 500),
          priority: a.priority,
          source: a.source,
          timestamp: a.timestamp,
          analysis_id: a.analysis_id,
          context_used: this._summarizeAnalysisContext(a.context_used)
        }));
      }

      // Nettoyer préférences vides
      if (this.memory.userPreferences && Object.keys(this.memory.userPreferences).length === 0) {
        this.memory.userPreferences = {};
      }

      // Mettre à jour la date
      this.memory.lastUpdated = new Date();

      await this._autoSave();
      logger.info('🧹 Mémoire compactée (essentiels conservés)');
      return true;
    } catch (error) {
      logger.error('❌ Erreur lors de la compaction de la mémoire:', error);
      return false;
    }
  }

  // --- Mise à jour existante: ajuster storeIntelligentAnalysis pour compacter le contexte ---
  async storeIntelligentAnalysis(analysisData) {
    try {
      const analysis = {
        ...analysisData,
        timestamp: new Date(),
        stored_at: new Date(),
        analysis_id: `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        context_used: this._summarizeAnalysisContext(analysisData.context_used || analysisData.context || {}),
        decision_made: analysisData.action || analysisData.decision,
        reasoning: analysisData.reason || analysisData.reasoning,
        priority: analysisData.priority || 'medium',
        source: analysisData.source || 'gemini_decision',
        execution_result: analysisData.execution_result || null,
        community_feedback: analysisData.community_feedback || null
      };

      const currentMemory = await this.getStatus();
      if (!currentMemory.intelligentAnalyses) {
        currentMemory.intelligentAnalyses = [];
      }

      currentMemory.intelligentAnalyses.unshift(analysis);
      if (currentMemory.intelligentAnalyses.length > 5) {
        currentMemory.intelligentAnalyses = currentMemory.intelligentAnalyses.slice(0, 5);
      }

      await this.update({
        intelligentAnalyses: currentMemory.intelligentAnalyses,
        last_intelligent_analysis: {
          timestamp: analysis.timestamp,
          decision: analysis.decision_made,
          priority: analysis.priority,
          source: analysis.source
        }
      });

      // Compacter après ajout
      await this.optimizeMemory();

      logger.info(`🧠 Nouvelle analyse intelligente stockée (compactée): ${analysis.analysis_id} - ${analysis.decision_made}`);
      return analysis;

    } catch (error) {
      logger.error('❌ Erreur lors du stockage de l\'analyse intelligente:', error);
      return null;
    }
  }

  /**
   * Récupère les 5 dernières analyses intelligentes
   */
  async getRecentIntelligentAnalyses(limit = 5) {
    try {
      const memory = await this.getStatus();
      const analyses = memory.intelligentAnalyses || [];
      
      // Retourner les analyses les plus récentes
      return analyses.slice(0, limit);

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des analyses intelligentes:', error);
      return [];
    }
  }

  /**
   * Supprime une analyse intelligente de la mémoire (après exécution)
   */
  async removeIntelligentAnalysis(analysisId) {
    try {
      const memory = await this.getStatus();
      
      if (!memory.intelligentAnalyses) {
        return false;
      }

      // Filtrer pour retirer l'analyse spécifiée
      const filteredAnalyses = memory.intelligentAnalyses.filter(
        analysis => analysis.analysis_id !== analysisId
      );

      // Mettre à jour la mémoire
      await this.update({
        intelligentAnalyses: filteredAnalyses
      });

      logger.info(`🗑️ Analyse intelligente supprimée: ${analysisId}`);
      return true;

    } catch (error) {
      logger.error('❌ Erreur lors de la suppression de l\'analyse intelligente:', error);
      return false;
    }
  }

  /**
   * Marque une analyse intelligente comme exécutée
   */
  async markIntelligentAnalysisAsExecuted(analysisId, executionResult) {
    try {
      const memory = await this.getStatus();
      
      if (!memory.intelligentAnalyses) {
        return false;
      }

      // Trouver et mettre à jour l'analyse
      const analysisIndex = memory.intelligentAnalyses.findIndex(
        analysis => analysis.analysis_id === analysisId
      );

      if (analysisIndex === -1) {
        return false;
      }

      // Mettre à jour l'analyse avec le résultat d'exécution
      memory.intelligentAnalyses[analysisIndex].execution_result = executionResult;
      memory.intelligentAnalyses[analysisIndex].executed_at = new Date();
      memory.intelligentAnalyses[analysisIndex].status = 'executed';

      // Mettre à jour la mémoire
      await this.update({
        intelligentAnalyses: memory.intelligentAnalyses
      });

      logger.info(`✅ Analyse intelligente marquée comme exécutée: ${analysisId}`);
      return true;

    } catch (error) {
      logger.error('❌ Erreur lors du marquage de l\'analyse intelligente:', error);
      return false;
    }
  }

  /**
   * Obtient le contexte des analyses intelligentes récentes pour Gemini
   */
  async getIntelligentAnalysisContext() {
    try {
      const analyses = await this.getRecentIntelligentAnalyses(5);
      
      if (analyses.length === 0) {
        return {
          recent_decisions: [],
          learning_patterns: [],
          community_response_trends: [],
          decision_effectiveness: 'unknown'
        };
      }

      // Analyser les tendances des décisions récentes
      const decisions = analyses.map(analysis => ({
        decision: analysis.decision_made,
        priority: analysis.priority,
        reasoning: analysis.reasoning,
        timestamp: analysis.timestamp,
        source: analysis.source,
        executed: analysis.status === 'executed',
        result: analysis.execution_result
      }));

      // Identifier les patterns d'apprentissage
      const learningPatterns = this.extractLearningPatterns(analyses);

      // Analyser les tendances de réponse communautaire
      const communityTrends = this.analyzeCommunityResponseTrends(analyses);

      // Calculer l'efficacité des décisions
      const effectiveness = this.calculateDecisionEffectiveness(analyses);

      return {
        recent_decisions: decisions,
        learning_patterns: learningPatterns,
        community_response_trends: communityTrends,
        decision_effectiveness: effectiveness,
        total_analyses_stored: analyses.length,
        last_analysis_timestamp: analyses[0]?.timestamp
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération du contexte des analyses:', error);
      return {
        recent_decisions: [],
        learning_patterns: [],
        community_response_trends: [],
        decision_effectiveness: 'unknown'
      };
    }
  }

  /**
   * Extrait les patterns d'apprentissage des analyses récentes
   */
  extractLearningPatterns(analyses) {
    const patterns = [];

    // Analyser les types de décisions qui marchent
    const successfulDecisions = analyses.filter(a => 
      a.execution_result && a.execution_result.success
    );

    if (successfulDecisions.length > 0) {
      const decisionTypes = successfulDecisions.map(d => d.decision_made);
      const mostSuccessful = decisionTypes.reduce((acc, type) => {
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {});

      patterns.push({
        type: 'successful_decisions',
        data: mostSuccessful,
        insight: 'Types de décisions qui ont bien fonctionné'
      });
    }

    // Analyser les priorités utilisées
    const priorityUsage = analyses.reduce((acc, a) => {
      acc[a.priority] = (acc[a.priority] || 0) + 1;
      return acc;
    }, {});

    patterns.push({
      type: 'priority_distribution',
      data: priorityUsage,
      insight: 'Distribution des priorités dans les décisions'
    });

    return patterns;
  }

  /**
   * Analyse les tendances de réponse communautaire
   */
  analyzeCommunityResponseTrends(analyses) {
    const trends = [];

    // Analyser la fréquence des décisions
    const timeDistribution = analyses.map(a => ({
      hour: new Date(a.timestamp).getHours(),
      decision: a.decision_made,
      priority: a.priority
    }));

    trends.push({
      type: 'temporal_distribution',
      data: timeDistribution,
      insight: 'Distribution temporelle des décisions'
    });

    // Analyser les sources de décision
    const sourceUsage = analyses.reduce((acc, a) => {
      acc[a.source] = (acc[a.source] || 0) + 1;
      return acc;
    }, {});

    trends.push({
      type: 'source_usage',
      data: sourceUsage,
      insight: 'Utilisation des différentes sources de décision'
    });

    return trends;
  }

  /**
   * Calcule l'efficacité des décisions récentes
   */
  calculateDecisionEffectiveness(analyses) {
    const executedAnalyses = analyses.filter(a => a.status === 'executed');
    
    if (executedAnalyses.length === 0) {
      return 'unknown';
    }

    const successfulExecutions = executedAnalyses.filter(a => 
      a.execution_result && a.execution_result.success
    ).length;

    const successRate = successfulExecutions / executedAnalyses.length;

    if (successRate >= 0.8) return 'excellent';
    if (successRate >= 0.6) return 'good';
    if (successRate >= 0.4) return 'fair';
    return 'poor';
  }

  /**
   * Marque un commentaire (tweet) comme répondu par PolicierCongo
   */
  async markCommentAsReplied(commentId, extra = {}) {
    try {
      if (!commentId) {
        return false;
      }
      if (!this.memory.repliedCommentsLog) {
        this.memory.repliedCommentsLog = [];
      }
      // éviter les doublons
      const exists = this.memory.repliedCommentsLog.find((e) => e.comment_id === commentId);
      if (!exists) {
        this.memory.repliedCommentsLog.push({
          comment_id: commentId,
          user: extra.user || null,
          response_tweet_id: extra.response_tweet_id || null,
          reason: extra.reason || null,
          added_at: new Date()
        });
        // Limiter la taille
        if (this.memory.repliedCommentsLog.length > (this.memory?.limits?.maxMemoryEntries || 100)) {
          this.memory.repliedCommentsLog = this.memory.repliedCommentsLog.slice(- (this.memory?.limits?.maxMemoryEntries || 100));
        }
        await this._autoSave();
        logger.info(`💾 Commentaire marqué comme répondu (mémoire): ${commentId}`);
      }
      return true;
    } catch (error) {
      logger.error('❌ Erreur lors du marquage du commentaire répondu:', error);
      return false;
    }
  }

  /**
   * Retourne la liste des IDs de commentaires déjà marqués comme répondus
   */
  getRepliedCommentIds() {
    const list = Array.isArray(this.memory.repliedCommentsLog) ? this.memory.repliedCommentsLog.map(e => e.comment_id) : [];
    // Nettoyer valeurs falsy
    return list.filter(Boolean);
  }

  /**
   * Retourne les IDs des tweets plateforme deja traites
   */
  getProcessedPlatformTweetIds() {
    if (!Array.isArray(this.memory.processedPlatformTweets)) return [];
    return this.memory.processedPlatformTweets
      .map((x) => x?.tweet_id)
      .filter(Boolean);
  }

  /**
   * Marque des tweets plateforme comme traites pour eviter les redites
   */
  async markPlatformTweetsAsProcessed(tweetIds = [], meta = {}) {
    try {
      const ids = Array.from(new Set((Array.isArray(tweetIds) ? tweetIds : []).filter(Boolean)));
      if (ids.length === 0) return true;

      if (!Array.isArray(this.memory.processedPlatformTweets)) {
        this.memory.processedPlatformTweets = [];
      }

      const existing = new Set(this.memory.processedPlatformTweets.map((x) => x?.tweet_id).filter(Boolean));
      const now = new Date();

      ids.forEach((id) => {
        if (!existing.has(id)) {
          this.memory.processedPlatformTweets.push({
            tweet_id: id,
            reason: meta.reason || 'context_used_for_generation',
            source_action: meta.source_action || null,
            added_at: now
          });
        }
      });

      // Garder seulement un historique recent et eviter la croissance infinie
      if (this.memory.processedPlatformTweets.length > 400) {
        this.memory.processedPlatformTweets = this.memory.processedPlatformTweets.slice(-400);
      }

      await this._autoSave();
      logger.info(`💾 Tweets plateforme marques comme traites: +${ids.length}`);
      return true;
    } catch (error) {
      logger.error('❌ Erreur marquage tweets plateforme traites:', error);
      return false;
    }
  }

  /**
   * Stocke un Big Context (contexte stratégique global) et garde max 15
   */
  async storeBigContext(bigContext) {
    try {
      const normalized = {
        id: bigContext.id || `bigctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        created_at: bigContext.created_at || new Date(),
        window: bigContext.window || 'last_24h',
        // Keywords ultra-compacts: on garde max ~5 par catégorie (chaque token doit être 1 mot).
        topics: this._toKeywords(bigContext.topics || bigContext.source_notes || '', 5),
        sentiment_keywords: this._toKeywords(bigContext.sentiment_summary || '', 5),
        request_keywords: this._toKeywords(bigContext.user_requests || '', 5),
        strategy_keywords: this._toKeywords(bigContext.content_strategy || '', 5),
        risk_keywords: this._toKeywords(bigContext.risks || '', 5),
        next_idea_keywords: this._toKeywords(bigContext.next_ideas || '', 5),
        source_keywords: this._toKeywords(bigContext.source_notes || '', 5),
        latest_main_tweets: Array.isArray(bigContext.latest_main_tweets) ? bigContext.latest_main_tweets.slice(0, 10) : [],
        latest_replies: [],
        latest_reply_replies: [],
        top_popular_tweets: Array.isArray(bigContext.top_popular_tweets) ? bigContext.top_popular_tweets.slice(0, 10) : [],
        latest_feed_tweets: Array.isArray(bigContext.latest_feed_tweets) ? bigContext.latest_feed_tweets.slice(0, 10) : []
      };

      // Sécurité “communauté”: on force des keywords d’interdit pour que l’IA “voie” ce cadre.
      // (Le prompt essaie déjà de le faire, mais on le verrouille côté mémoire.)
      const prohibited = ['no_bails', 'no_gas_mentions', '@gas', 'anti_bail_content'];
      const riskSet = new Set([...(normalized.risk_keywords || []), ...prohibited]);
      normalized.risk_keywords = Array.from(riskSet).slice(0, 5);

      if (!Array.isArray(this.memory.bigContexts)) {
        this.memory.bigContexts = [];
      }

      this.memory.bigContexts.unshift(normalized);
      if (this.memory.bigContexts.length > 15) {
        this.memory.bigContexts = this.memory.bigContexts.slice(0, 15);
      }

      await this._autoSave();
      logger.info(`🧠 Big Context stocké: ${normalized.id} (total=${this.memory.bigContexts.length})`);
      return normalized;
    } catch (error) {
      logger.error('❌ Erreur lors du stockage du Big Context:', error);
      return null;
    }
  }

  /**
   * Retourne les N derniers Big Contexts
   */
  getRecentBigContexts(limit = 15) {
    const arr = Array.isArray(this.memory.bigContexts) ? this.memory.bigContexts : [];
    return arr.slice(0, limit);
  }
}

module.exports = MemoryManager;