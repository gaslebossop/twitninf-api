/**
 * 🧠 Intelligence Gemini - Interface avec l'API Gemini de Google
 * 
 * Ce module gère toutes les interactions avec l'API Gemini pour l'analyse
 * intelligente et la prise de décision automatisée.
 */

const logger = require('../../utils/logger');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { LLM_CONFIG } = require('./config');

class GeminiIntelligence {
  constructor() {
    this.apiKeys = [
      'AIzaSyD--8mAE-Wwr6em-iJNZFpfaR8JX-p3CO0',
      'AIzaSyAWqaeqcKXy5eGv5XwAcSmpfEnUlUXV7AM',
      'AIzaSyAym2vUwH85VbgX2MzQJ3rULYfsCcY_XIE',
      'AIzaSyBEat6WA9Kx0-PAsY3vNdwSqEOPMVF9GSc',
      'AIzaSyBvBnqQvezndbMdisr8j1GAwF183xEIwvs',
      'AIzaSyAetk-R-AllglFwWclFsrVLm7Q1AQFdKlE',
      'AIzaSyDf0cgSNzBCgJLzOtb05wPsk7fMO5UtMUo',
      'AIzaSyCYOfKUVUkToCeHTvRuyfatgrTUipq0YDk'
    ];
    this.currentKeyIndex = 0;
    this.apiKey = this.apiKeys[this.currentKeyIndex];
    this.ai = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.megaLLMClient = null;
    this.megaLLMModel = (process.env.MEGALLM_MODEL || 'claude-opus-4-6').trim();
    // Forcer MegaLLM actif pour ce service (demande produit)
    LLM_CONFIG.useMegaLLM = true;

    this.initialize();
  }

  formatParisDateSafe(value, options = { timeStyle: 'short' }, fallback = 'Inconnu') {
    try {
      if (!value) return fallback;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return fallback;
      return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', ...options }).format(d);
    } catch (_) {
      return fallback;
    }
  }

  getPersonaCorePrompt() {
    return `Tu es PolicierCongo. Pseudo marrant, t'es juste un ado de 19 ans sur TwitNinf.
Tu tweets comme tu penses: court, naturel, un peu con parfois. Pas de "rapport", pas de "brigade".
Ton = scroll paresseux + reaction spontanee. Si t'as rien a dire, tu dis rien.`;
  }

  async buildMegaLLMClient() {
    const modulePath = '../../megallm-client/index.js';
    const configuredPath = LLM_CONFIG.megaLLMSessionPath;
    const candidates = [
      path.isAbsolute(configuredPath) ? configuredPath : null,
      path.resolve(process.cwd(), configuredPath),
      path.resolve(__dirname, '..', '..', 'megallm-client', 'megallm-session.json'),
      path.resolve(process.cwd(), 'src', 'megallm-client', 'megallm-session.json')
    ].filter(Boolean);

    const absoluteSessionPath = candidates.find((p) => fs.existsSync(p));
    if (!absoluteSessionPath) {
      throw new Error(`Fichier session MegaLLM introuvable. Candidats testés: ${candidates.join(' | ')}`);
    }

    const megaModule = await import(modulePath);
    const MegaLLMClient = megaModule?.MegaLLMClient;

    if (!MegaLLMClient) {
      throw new Error('MegaLLMClient introuvable dans le module');
    }

    logger.info(`🧠 MegaLLM session utilisée: ${absoluteSessionPath}`);
    return new MegaLLMClient(absoluteSessionPath);
  }

  async generateWithMegaLLM(prompt, model = this.megaLLMModel) {
    const startedAt = Date.now();
    console.log(`[PolicierCongo][LLM] -> Requête MegaLLM | model=${model}`);
    try {
      // Même logique que test.js: client neuf à chaque appel
      const client = await this.buildMegaLLMClient();
      const megaPrompt = typeof prompt === 'string' ? prompt : String(prompt || '');
      logger.info(`🧠 MegaLLM prompt size: raw=${megaPrompt.length}, sent=${megaPrompt.length}`);
      try {
        const promptLogPath = path.join(__dirname, 'megallm-prompts.log');
        const promptLogEntry = [
          '---',
          `timestamp: ${new Date().toISOString()}`,
          `model: ${model}`,
          `length: ${megaPrompt.length}`,
          'prompt:',
          megaPrompt,
          ''
        ].join('\n');
        await fsp.appendFile(promptLogPath, promptLogEntry, 'utf8');
        logger.info(`📝 Prompt MegaLLM enregistré dans: ${promptLogPath}`);
      } catch (logError) {
        logger.warn(`⚠️ Impossible d'écrire le log prompt MegaLLM: ${logError?.message}`);
      }
      client.defaultModel = model;
      // Utiliser le même chemin d'appel que test.js (le plus stable observé)
      const text = await client.generate(megaPrompt);
      console.log(`[PolicierCongo][LLM] <- Réponse MegaLLM OK | model=${model} | durationMs=${Date.now() - startedAt}`);
      return (text || '').trim() || null;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const statusFromMessage = Number((error?.message || '').match(/MegaLLM API Error \((\d+)\)/)?.[1] || 0) || null;
      const rawMessage = error?.message || String(error);
      const shortenedMessage = rawMessage.length > 500 ? `${rawMessage.substring(0, 500)}...` : rawMessage;
      const errorPayload = {
        model,
        durationMs,
        name: error?.name || null,
        message: shortenedMessage,
        code: error?.code || error?.error?.code || null,
        status: error?.status || error?.error?.status || statusFromMessage,
        stack: error?.stack ? error.stack.split('\n').slice(0, 5).join(' | ') : null
      };

      console.log(`[PolicierCongo][LLM] <- Réponse MegaLLM ERROR | ${JSON.stringify(errorPayload)}`);
      logger.error('❌ Erreur génération MegaLLM détaillée:', errorPayload);

      // Auto-fallback si le modèle n'est pas dispo chez MegaLLM
      const isModelUnavailable =
        (errorPayload.status === 404 || statusFromMessage === 404) &&
        /model .* is not available|invalid_request_error/i.test(rawMessage);
      if (isModelUnavailable) {
        const rotation = [
          'claude-opus-4-6',
          'gpt-5.4',
          'gemini-3-flash-preview'
        ];
        const currentIndex = rotation.indexOf(model);
        const next = (currentIndex !== -1 && currentIndex < rotation.length - 1) 
          ? rotation[currentIndex + 1] 
          : null;

        if (next) {
          logger.warn(`⚠️ MegaLLM model indisponible (${model}). Rotation vers : ${next}`);
          // Si on retombe sur Gemini, on laisse le bridge gérer le canal natif GoogleGenAI
          if (next.startsWith('gemini')) {
            return null;
          }
          return await this.generateWithMegaLLM(prompt, next);
        }
      }

      // Auto-fallback si timeout/gateway côté MegaLLM
      const isGatewayTimeout = (errorPayload.status === 504 || statusFromMessage === 504);
      if (isGatewayTimeout) {
        const fallbackModels = [
          'gpt-5.4'
        ];
        const next = fallbackModels.find((m) => m !== model);
        if (next && next !== model) {
          logger.warn(`⚠️ MegaLLM timeout (${model}). Retry avec: ${next}`);
          return await this.generateWithMegaLLM(prompt, next);
        }
      }
      return null;
    }
  }

  async generateCreativeContent(prompt, fallbackModel = 'gpt-5.4') {
    try {
      // Pour la redaction (tweets/reponses), on veut MegaLLM en priorite.
      if (LLM_CONFIG.useMegaLLM) {
        const megaText = await this.generateWithMegaLLM(prompt, this.megaLLMModel);
        if (megaText && megaText.length > 0) {
          logger.info('🧠 Provider generation: MegaLLM (creative path)');
          return megaText;
        }
      }

      logger.warn('⚠️ MegaLLM indisponible sur creative path, fallback Gemini');
      return await this.generateContent(prompt, fallbackModel, true);
    } catch (error) {
      logger.warn(`⚠️ generateCreativeContent fallback Gemini (erreur): ${error?.message}`);
      return await this.generateContent(prompt, fallbackModel, true);
    }
  }

  /**
   * Bascule sur la prochaine clé API disponible
   */
  switchApiKey() {
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    this.apiKey = this.apiKeys[this.currentKeyIndex];
    this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    logger.info(`🔄 Rotation de clé API Gemini terminée: Passage à la clé d'index ${this.currentKeyIndex}`);
  }

  /**
   * Initialise l'API Gemini
   */
  initialize() {
    try {
      if (!this.apiKey) {
        logger.error('❌ Clé API Gemini non configurée');
        return false;
      }

      this.ai = new GoogleGenAI({ apiKey: this.apiKey });
      this.isInitialized = true;

      logger.info('✅ Intelligence Gemini initialisée avec succès');
      return true;
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation de Gemini:', error);
      return false;
    }
  }

  /**
   * Génère du contenu avec retries et fallback de modèle
   */
  async safeGenerateWithFallback(prompt, primaryModel = 'gpt-5.4', secondaryModel = 'gpt-5.4', retries = 2, forceGemini = false) {
    // Essai avec le modèle primaire
    for (let attempt = 1; attempt <= retries; attempt++) {
      const text = await this.generateContent(prompt, primaryModel, forceGemini);
      if (text && text.length > 0) {
        return { text, modelUsed: primaryModel, attempts: attempt };
      }
    }

    // Fallback au modèle secondaire
    for (let attempt = 1; attempt <= retries; attempt++) {
      const text = await this.generateContent(prompt, secondaryModel, forceGemini);
      if (text && text.length > 0) {
        return { text, modelUsed: secondaryModel, attempts: attempt };
      }
    }

    return { text: null, modelUsed: null, attempts: retries * 2 };
  }

  /**
   * Crée un plan d'actions via Gemini avec retries/fallbacks robustes
   */
  async createPlan(collectedData) {
    try {
      if (!this.isInitialized) {
        throw new Error('Intelligence Gemini non initialisée');
      }

      this.requestCount++;
      logger.info('🧠 Création d\'un plan via Gemini...');

      const prompt = this.buildPlanningPrompt(collectedData);
      // Tentatives robustes avec fallback de modèle beaucoup plus léger
      const { text: response, modelUsed } = await this.safeGenerateWithFallback(
        prompt,
        'gpt-5.4',
        'gpt-5.4',
        2
      );

      if (!response) {
        // Dernière tentative: modèle plus léger et prompt simplifié
        const minimalPrompt = `Retourne strictement un JSON avec un plan minimal si nécessaire.
{
  "plan": {
    "actions": [
      { "type": "NO_ACTION", "priority": "low", "reason": "fallback" }
    ],
    "execution_order": "sequential"
  }
}`;
        const finalTry = await this.generateContent(minimalPrompt, 'gemini-3-flash-preview');
        if (!finalTry) {
          logger.warn('⚠️ Aucune réponse Gemini après retries et fallbacks, retour plan de secours');
          return {
            plan: {
              actions: [
                { type: 'NO_ACTION', priority: 'low', reason: 'Plan invalide - fallback automatique', target_user: null, context: 'Aucune action requise' }
              ],
              execution_order: 'sequential',
              estimated_duration: '0 minutes',
              community_impact: 'Aucun impact'
            },
            meta: { source: 'fallback', modelUsed: null }
          };
        }
        // essayer de parser cette dernière tentative
        const parsed = this.parsePlanResponse(finalTry) || this.attemptJsonRepair(finalTry);
        if (parsed && parsed.plan) {
          this.successCount++;
          logger.info(`✅ Plan (fallback) créé via modèle de secours`);
          return { ...parsed, meta: { source: 'fallback_model', modelUsed: 'gemini-3-flash-preview' } };
        }
        // si toujours pas, renvoyer plan de secours
        return {
          plan: {
            actions: [
              { type: 'NO_ACTION', priority: 'low', reason: 'Plan invalide - fallback automatique', target_user: null, context: 'Aucune action requise' }
            ],
            execution_order: 'sequential',
            estimated_duration: '0 minutes',
            community_impact: 'Aucun impact'
          },
          meta: { source: 'hard_fallback', modelUsed: null }
        };
      }

      // Parser le plan
      const plan = this.parsePlanResponse(response) || this.attemptJsonRepair(response);

      if (plan && plan.plan) {
        this.successCount++;
        logger.info(`✅ Plan créé (${modelUsed}) avec ${plan.plan.actions.length} actions`);
        return plan;
      } else {
        logger.warn('⚠️ Impossible d\'extraire un plan valide, retour plan de secours');
        return {
          plan: {
            actions: [
              { type: 'NO_ACTION', priority: 'low', reason: 'Plan invalide - fallback automatique', target_user: null, context: 'Aucune action requise' }
            ],
            execution_order: 'sequential',
            estimated_duration: '0 minutes',
            community_impact: 'Aucun impact'
          },
          meta: { source: 'parse_fallback', modelUsed }
        };
      }

    } catch (error) {
      this.errorCount++;
      logger.error('❌ Erreur lors de la création du plan Gemini:', error);
      // Ne pas retourner null: toujours un plan de secours
      return {
        plan: {
          actions: [
            { type: 'NO_ACTION', priority: 'low', reason: 'Erreur lors de la planification - fallback automatique', target_user: null, context: 'Aucune action requise' }
          ],
          execution_order: 'sequential',
          estimated_duration: '0 minutes',
          community_impact: 'Aucun impact'
        },
        meta: { source: 'exception_fallback', error: error.message }
      };
    }
  }

  /**
   * Analyse intelligente et prise de décision complète
   */
  async analyze() {
    try {
      if (!this.isInitialized) {
        throw new Error('Intelligence Gemini non initialisée');
      }

      const { memoryManager, dataCollector } = require('./index');
      const geminiMemory = await memoryManager.getStatus();
      const collectedData = await dataCollector.collectRecentData();

      // 🚀 REDIRECTION V2 (NOUVEAU SYSTÈME)
      const pc2 = require('./policiercongoV2Bridge');
      if (pc2.isPolicierCongoV2Enabled()) {
        logger.info('🧠 geminiIntelligence.analyze() -> Redirection vers PolicierCongoV2');
        const event = {
          id: `analyze_${Date.now()}`,
          trigger: pc2.TRIGGER_TYPES.PROACTIVE,
          rawText: 'Analyse proactive via geminiIntelligence.',
          metadata: { source: 'gemini_intelligence_redirect' }
        };
        const v2 = await pc2.runPolicierCongoV2Turn({ event, geminiIntelligence: this, collectedData });
        if (v2 && v2.ok) {
          return {
            action: v2.structured?.action || 'NO_ACTION',
            reason: 'Décision V2 - Redirection geminiIntelligence',
            priority: v2.meta?.priorityScore > 70 ? 'high' : 'medium',
            details: v2.structured || {},
            memory_update: v2.structured?.store_memory || {}
          };
        }
      }

      // 📜 LOGIQUE LEGACY (GEMINI/MEGALLM)
      // Vérifier si des ordres admin stricts sont en attente
      const instructionManager = require('./InstructionManager');
      const hasPendingOrders = instructionManager.instructions.immediate_orders.some(o => o.status === 'pending');
      const forceGemini = false;

      if (hasPendingOrders) {
        logger.info('🚨 Ordres admin détectés: MegaLLM reste prioritaire (fallback Gemini si besoin).');
      }

      const prompt = (LLM_CONFIG.useMegaLLM && !forceGemini)
        ? this.buildMegaLLMAnalysisPrompt(collectedData, geminiMemory)
        : await this.buildAnalysisPrompt(collectedData, geminiMemory);

      // Utiliser un mécanisme robuste avec des modèles rapides pour ne pas surcharger
      const { text: response, modelUsed } = await this.safeGenerateWithFallback(
        prompt,
        'gpt-5.4',
        'gpt-5.4',
        2,
        forceGemini
      );

      // Log explicite de la réponse et du modèle utilisé
      logger.info(`🧠 Analyse - modèle utilisé: ${modelUsed || 'inconnu'}`);
      logger.info('🧠 Analyse - réponse brute:', response || '(vide)');

      if (!response) {
        logger.warn('⚠️ Analyse Gemini: aucune réponse après retries/fallbacks. Retour NO_ACTION.');
        return {
          action: 'NO_ACTION',
          reason: 'Analyse indisponible (fallback) - aucune action forcée',
          priority: 'low',
          details: {},
          memory_update: { lastActions: ['analysis_no_response_fallback'] }
        };
      }

      // Parser la décision, tenter réparation si besoin
      let decision = this.parseDecisionResponse(response) || this.attemptJsonRepair(response);

      // Enrichissement: s'assurer que les détails requis sont présents
      const enrichDecisionDetails = async (dec) => {
        try {
          const ensurePostTweet = async (detailsKey = null) => {
            if (detailsKey) {
              dec.details = dec.details || {};
              dec.details[detailsKey] = dec.details[detailsKey] || {};
              if (!dec.details[detailsKey].content || dec.details[detailsKey].content.trim().length === 0) {
                const generated = await this.generateTweetContent({ action: 'POST_TWEET', reason: dec.reason, priority: dec.priority, details: dec.details[detailsKey] }, { collectedData });
                if (generated) dec.details[detailsKey].content = generated;
                dec.details[detailsKey].tweet_type = dec.details[detailsKey].tweet_type || 'general';
              }
            } else {
              dec.details = dec.details || {};
              if (!dec.details.content || dec.details.content.trim().length === 0) {
                const generated = await this.generateTweetContent(dec, { collectedData });
                if (generated) dec.details.content = generated;
                dec.details.tweet_type = dec.details.tweet_type || 'general';
              }
            }
          };

          const ensureRespondToUser = async (detailsKey = null) => {
            const pickFirstUnreplied = () => {
              const first = (collectedData.unrepliedComments || [])[0];
              if (!first) return null;
              return { target_user: first.author, parent_tweet_id: first.id };
            };
            const fill = async (obj) => {
              if (!obj.parent_tweet_id || !obj.response_content) {
                const picked = pickFirstUnreplied();
                if (picked) {
                  obj.parent_tweet_id = obj.parent_tweet_id || picked.parent_tweet_id;
                  obj.target_user = obj.target_user || picked.target_user;
                }
              }
              if (!obj.response_content || obj.response_content.trim().length === 0) {
                const generated = await this.generateResponseContent({ action: 'RESPOND_TO_USER', reason: dec.reason, priority: dec.priority, details: obj });
                if (generated) obj.response_content = generated;
              }
            };
            if (detailsKey) {
              dec.details = dec.details || {};
              dec.details[detailsKey] = dec.details[detailsKey] || {};
              await fill(dec.details[detailsKey]);
            } else {
              dec.details = dec.details || {};
              await fill(dec.details);
            }
          };

          const ensureUpdateProfile = async () => {
            dec.details = dec.details || {};
            if (!dec.details.new_full_name && !dec.details.new_username) {
              const suggestion = await this.generateProfileUpdateSuggestion(dec, collectedData.currentProfile || {});
              if (suggestion) {
                if (suggestion.new_full_name) dec.details.new_full_name = suggestion.new_full_name;
                if (suggestion.new_username) dec.details.new_username = suggestion.new_username;
              }
            }
          };

          if (Array.isArray(dec?.action)) {
            // Actions multiples
            const actions = dec.action;
            // Préparer sous-détails
            dec.details = dec.details || {};
            if (actions.includes('POST_TWEET')) {
              dec.details.post_tweet = dec.details.post_tweet || {};
              await ensurePostTweet('post_tweet');
            }
            if (actions.includes('RESPOND_TO_USER')) {
              dec.details.respond_to = dec.details.respond_to || {};
              await ensureRespondToUser('respond_to');
            }
            if (actions.includes('UPDATE_PROFILE')) {
              dec.details.update_profile = dec.details.update_profile || {};
              // transférer dans racine pour l'exécuteur actuel
              await ensureUpdateProfile();
              // Copier les détails de profil dans la racine pour compatibilité avec l'exécuteur
              if (dec.details.update_profile.new_full_name) dec.details.new_full_name = dec.details.update_profile.new_full_name;
              if (dec.details.update_profile.new_username) dec.details.new_username = dec.details.update_profile.new_username;
            }
          } else if (typeof dec?.action === 'string') {
            switch (dec.action) {
              case 'POST_TWEET':
                await ensurePostTweet();
                break;
              case 'RESPOND_TO_USER':
                await ensureRespondToUser();
                break;
              case 'UPDATE_PROFILE':
                await ensureUpdateProfile();
                break;
              default:
                break;
            }
          }
        } catch (e) {
          logger.warn('⚠️ Enrichissement de décision partiel:', e?.message);
        }
        return dec;
      };

      if (decision) {
        decision = await enrichDecisionDetails(decision);
      }

      if (decision && decision.action) {
        this.successCount++;
        logger.info(`🧠 Décision Gemini: ${Array.isArray(decision.action) ? decision.action.join(',') : decision.action} - ${decision.reason}`);
        return decision;
      } else {
        logger.warn('⚠️ Analyse Gemini: décision non valide. Retour NO_ACTION.');
        return {
          action: 'NO_ACTION',
          reason: 'Décision inutilisable (fallback) - aucune action forcée',
          priority: 'low',
          details: {},
          memory_update: { lastActions: ['analysis_invalid_decision_fallback'] }
        };
      }

    } catch (error) {
      this.errorCount++;
      logger.error('❌ Erreur lors de l\'analyse Gemini:', error);
      // Toujours retourner une décision de fallback
      return {
        action: 'NO_ACTION',
        reason: 'Erreur analyse - fallback NO_ACTION',
        priority: 'low',
        details: {},
        memory_update: { lastActions: ['analysis_exception_fallback'] }
      };
    }
  }

  /**
   * Prompt d'analyse compact dédié à MegaLLM (moins de bruit / moins de risque WAF)
   */
  buildMegaLLMAnalysisPrompt(collectedData, geminiMemory) {
    return this.buildAnalysisPrompt(collectedData, geminiMemory);
  }

  /**
   * Génère du contenu via Gemini avec retry infini sur erreurs transitoires
   */
  async generateContent(prompt, model = 'gemini-3-flash-preview', forceGemini = false) {
    try {
      const isGeminiModel = String(model).toLowerCase().startsWith('gemini');
      const shouldForceGemini = forceGemini || isGeminiModel;

      if (LLM_CONFIG.useMegaLLM && !shouldForceGemini) {
        logger.info('🧠 Provider LLM: MegaLLM activé (POLICIER_USE_MEGALLM=true)');
        const megaResponse = await this.generateWithMegaLLM(prompt, this.megaLLMModel);
        if (megaResponse) {
          logger.info('🧠 Réponse brute de MegaLLM:', megaResponse);
          return megaResponse;
        }
        logger.warn('⚠️ MegaLLM indisponible, fallback vers Gemini...');
      }

      if (!this.ai) {
        throw new Error('API Gemini non initialisée');
      }

      // Retry limité au nombre de clés API disponibles (sans délai)
      const MAX_ATTEMPTS = this.apiKeys.length;
      let attempt = 0;

      // Assurance que Gemini ne reçoit pas un nom de modèle GPT/Claude
      const geminiModel = model.startsWith('gemini') ? model : 'gemini-3-flash-preview';

      while (attempt < MAX_ATTEMPTS) {
        attempt++;
        const startedAt = Date.now();
        console.log(`[PolicierCongo][LLM] -> Requête Gemini | model=${geminiModel} | attempt=${attempt}/${MAX_ATTEMPTS}`);
        try {
          const response = await this.ai.models.generateContent({
            model: geminiModel,
            contents: prompt,
            generationConfig: {
              maxOutputTokens: 4096,
              temperature: 0.8
            }
          });

          let text = '';
          if (response?.response && typeof response.response.text === 'function') {
            text = response.response.text();
          } else if (typeof response.text === 'function') {
            text = response.text();
          } else if (typeof response.text === 'string') {
            text = response.text;
          }

          text = (text || '').trim();

          logger.info('🧠 Réponse brute de Gemini:', text);
          console.log(`[PolicierCongo][LLM] <- Réponse Gemini OK | model=${model} | attempt=${attempt}/${MAX_ATTEMPTS} | durationMs=${Date.now() - startedAt}`);

          return text;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          const rawMessage = error?.error?.message || error?.message || '';
          const parsedCodeFromMessage = Number((rawMessage.match(/status:\s*(\d{3})|code":\s*(\d{3})|code:\s*(\d{3})/i) || []).slice(1).find(Boolean) || 0) || null;
          const code = error?.error?.code || error?.code || parsedCodeFromMessage;
          const status = error?.error?.status || error?.status || (/RESOURCE_EXHAUSTED/i.test(rawMessage) ? 'RESOURCE_EXHAUSTED' : null);
          const message = rawMessage;
          const errorPayload = {
            model,
            attempt: `${attempt}/${MAX_ATTEMPTS}`,
            durationMs,
            code: code || null,
            status: status || null,
            message: message || 'Erreur inconnue',
            stack: error?.stack ? error.stack.split('\n').slice(0, 5).join(' | ') : null
          };
          console.log(`[PolicierCongo][LLM] <- Réponse Gemini ERROR | ${JSON.stringify(errorPayload)}`);

          const isOverloaded = code === 503 || status === 'UNAVAILABLE' || /overloaded|try again later/i.test(message);
          const isInternal = code === 500 || status === 'INTERNAL' || /internal error/i.test(message);
          const isGateway = code === 502 || code === 504 || /bad gateway|gateway timeout/i.test(message);
          const isRateLimited = code === 429 || /rate limit|quota/i.test(message);
          const isDailyQuotaExceeded = /quota exceeded|perday|free_tier_requests|RESOURCE_EXHAUSTED/i.test(message);

          const isRetryable = isOverloaded || isInternal || isGateway || isRateLimited;

          if (isRateLimited || isOverloaded) {
            logger.warn(`⚠️ Erreur liée à l'API (${code || status}). Tentative de rotation de la clé API...`);
            this.switchApiKey();
          }

          if (isDailyQuotaExceeded) {
            logger.warn('⛔ Quota Gemini épuisé pour cette clé, rotation...');
            this.switchApiKey();
            if (attempt < MAX_ATTEMPTS) continue;
            return null;
          }

          if (isRetryable && attempt < MAX_ATTEMPTS) {
            const retryDelaySec = Number((message.match(/Please retry in\s+([0-9.]+)s/i) || [])[1] || 0);
            if (retryDelaySec > 0) {
              const waitMs = Math.ceil(retryDelaySec * 1000);
              logger.warn(`⚠️ Erreur transitoire Gemini (code=${code || status}). Attente ${waitMs}ms avant retry #${attempt + 1}/${MAX_ATTEMPTS}.`);
              await new Promise((resolve) => setTimeout(resolve, waitMs));
            } else {
              logger.warn(`⚠️ Erreur transitoire Gemini (code=${code || status}). Tentative #${attempt}/${MAX_ATTEMPTS}. Nouvelle tentative immédiate...`);
            }
            continue;
          }

          logger.error(`❌ Erreur lors de la génération de contenu Gemini après ${attempt} tentatives :`, errorPayload);
          return null;
        }
      }
      return null;

    } catch (error) {
      logger.error('❌ Erreur fatale dans generateContent:', error);
      return null;
    }
  }

  /**
   * Construit le prompt pour la planification
   */
  buildPlanningPrompt(collectedData) {
    const instructionManager = require('./InstructionManager');
    const adminOrders = instructionManager.getFormattedInstructions();
    const unreplied = (collectedData.unrepliedComments || [])
      .slice(0, 8)
      .map((c, i) => `[ID_REF:${i + 1}] @${c.author} (${c.hours_ago}h) - ID_SQL:${c.id}\n  "${(c.content || '').substring(0, 100)}"`)
      .join('\n');

    const vibeTimeline = (collectedData.recentPlatformTweets || [])
      .slice(0, 6)
      .map(t => `@${t.author}: ${(t.content || '').substring(0, 100)}`)
      .join('\n');

    const sm = collectedData.selfModeration || {};

    return `PolicierCongo - ado 19 ans, pseudo, tweet naturel.
${sm.is_suspended ? `COMPTE SUSPENDU (${sm.reason}) - actions limitees.` : ''}
${adminOrders ? `ORDRE ADMIN:\n${adminOrders}` : ''}

VIBE TL:
${vibeTimeline || 'rien'}

COMMENTAIRES A TRAITER (utilise ID_SQL pour parent_tweet_id, JAMAIS ID_REF):
${unreplied || 'aucun'}

Retourne UNIQUEMENT ce JSON:
{
  "plan": {
    "actions": [
      {
        "type": "RESPOND_TO_USER|POST_TWEET|UPDATE_PROFILE|NO_ACTION",
        "priority": "high|medium|low",
        "reason": "...",
        "details": {
          "target_user": "...",
          "parent_tweet_id": "...(ID_SQL exact)",
          "response_content": "...(max 280c, naturel, pas de hashtags)",
          "content": "...(si POST_TWEET)",
          "new_full_name": "...",
          "new_username": "..."
        }
      }
    ],
    "execution_order": "sequential"
  },
  "memory_update": {}
}`;
  }

  /**
   * Construit le prompt pour l'analyse complète avec contexte enrichi
   */
  buildAnalysisPrompt(collectedData, geminiMemory) {
    const instructionManager = require('./InstructionManager');
    const adminOrders = instructionManager.getFormattedInstructions();

    const nowFr = new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', timeStyle: 'short', dateStyle: 'short'
    }).format(new Date());

    const timing = collectedData.timingAnalysis || {};
    const hours = timing.hoursSinceLastMainTweet ?? '?';

    const unreplied = (collectedData.unrepliedComments || [])
      .slice(0, 15)
      .map(c => `• @${c.author} [ID_SQL:${c.id}] (${c.hours_ago ?? '?'}h): "${(c.content || '').substring(0, 200)}"`)
      .join('\n');

    const vibeTimeline = (collectedData.recentPlatformTweets || [])
      .slice(0, 20)
      .map(t => `@${t.author} [${t.heure_paris || t.ago || ''}]: ${(t.content || '').substring(0, 180)}`)
      .join('\n');

    const myLastTweets = (collectedData.mainTweets || [])
      .slice(0, 12)
      .map(t => `"${(t.content || '').substring(0, 160)}" (${t.likes}♥)`)
      .join('\n');

    const sm = collectedData.selfModeration || {};
    const banned = sm.is_suspended ? `COMPTE SUSPENDU: ${sm.reason}` : '';

    return `Tu es PolicierCongo sur TwitNinf - ado 19 ans, pseudo chelou, tweets naturels.
${this.getPersonaCorePrompt()}
Heure Paris: ${nowFr} | Dernier tweet: il y a ${hours}h
${banned}
${adminOrders ? `ORDRE ADMIN (priorite absolue, execute en restant naturel):\n${adminOrders}` : ''}

MES DERNIERS TWEETS: ${myLastTweets || 'aucun'}

VIBE TL EN CE MOMENT (contexte, pas a resumer - reagis si quelque chose te parle):
${vibeTimeline || 'rien'}

COMMENTAIRES SANS REPONSE (traite-les en priorite si presents):
${unreplied || 'aucun'}

--- DECISION (tu es libre) ---
-> Dernier tweet principal: il y a ${hours}h (info). Poste, reponds ou noop selon ce que tu comprends de la TL.
${unreplied ? '-> Commentaires en attente: priorise les replies si tu veux, sinon tweet.' : ''}
${adminOrders ? '-> Ordre admin = priorite absolue.' : ''}

Retourne UNIQUEMENT ce JSON (rien avant, rien apres):
{
  "action": ["POST_TWEET" | "RESPOND_TO_USER" | "UPDATE_PROFILE" | "NO_ACTION"],
  "reason": "...",
  "priority": "high|medium|low",
  "details": {
    "content": "...(si POST_TWEET, max 280c, PAS de hashtags)",
    "respond_to_users": [{"target_user":"...","parent_tweet_id":"...","response_content":"..."}],
    "new_full_name": "...(si UPDATE_PROFILE)",
    "new_username": "...(si UPDATE_PROFILE)"
  },
  "memory_update": {}
}`;
  }

  /**
   * Parse la réponse de planification de Gemini
   */
  parsePlanResponse(text) {
    try {
      // Essayer plusieurs méthodes d'extraction JSON
      const jsonPatterns = [
        /\{[\s\S]*\}/,
        /\{[^}]*"plan"[^}]*\}/,
      ];

      for (const pattern of jsonPatterns) {
        const match = text.match(pattern);
        if (match) {
          try {
            const plan = JSON.parse(match[0]);
            if (plan && plan.plan && plan.plan.actions) {
              return plan;
            }
          } catch (e) {
            continue;
          }
        }
      }

      // Si aucun pattern n'a fonctionné, essayer de réparer le JSON
      return this.attemptJsonRepair(text);

    } catch (error) {
      logger.error('❌ Erreur lors du parsing du plan Gemini:', error);
      return null;
    }
  }

  /**
   * Parse la réponse de décision de Gemini
   */
  parseDecisionResponse(text) {
    try {
      // Essayer plusieurs méthodes d'extraction JSON
      const jsonPatterns = [
        /\{[\s\S]*\}/,
        /\{[^}]*"action"[^}]*"reason"[^}]*\}/,
        /\{[^}]*"action"[^}]*\}/,
      ];

      for (const pattern of jsonPatterns) {
        const match = text.match(pattern);
        if (match) {
          try {
            const decision = JSON.parse(match[0]);

            // Validation stricte de la structure
            if (decision && typeof decision === 'object' &&
              decision.action &&
              decision.reason && typeof decision.reason === 'string') {

              // Validation des actions multiples
              if (Array.isArray(decision.action)) {
                const validActions = ['POST_TWEET', 'UPDATE_PROFILE', 'DELETE_TWEET', 'RESPOND_TO_USER', 'NO_ACTION'];
                const validActionsFound = decision.action.filter(action => validActions.includes(action));

                if (validActionsFound.length > 0) {
                  return {
                    ...decision,
                    action: validActionsFound
                  };
                }
              } else {
                const validActions = ['POST_TWEET', 'UPDATE_PROFILE', 'DELETE_TWEET', 'RESPOND_TO_USER', 'NO_ACTION', 'DEACTIVATE'];
                if (validActions.includes(decision.action)) {
                  return decision;
                }
              }
            }
          } catch (e) {
            continue;
          }
        }
      }

      // Si aucun pattern n'a fonctionné, essayer de réparer le JSON
      return this.attemptJsonRepair(text);

    } catch (error) {
      logger.error('❌ Erreur lors du parsing de la décision Gemini:', error);
      return null;
    }
  }

  /**
   * Tente de réparer un JSON malformé de Gemini
   */
  attemptJsonRepair(rawText) {
    try {
      logger.info('🔧 Tentative de réparation du JSON Gemini...');

      // Nettoyer le texte
      let cleanedText = rawText
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .replace(/\n/g, ' ')
        .replace(/\r/g, ' ')
        .replace(/\t/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Essayer d'extraire le JSON complet d'abord
      const completeJsonMatch = cleanedText.match(/\{[\s\S]*\}/);
      if (completeJsonMatch) {
        try {
          const parsed = JSON.parse(completeJsonMatch[0]);

          // Vérifier si c'est une structure valide avec action
          if (parsed && typeof parsed === 'object' && parsed.action) {

            // Si c'est une action multiple, la valider
            if (Array.isArray(parsed.action)) {
              const validActions = ['POST_TWEET', 'UPDATE_PROFILE', 'DELETE_TWEET', 'RESPOND_TO_USER', 'NO_ACTION'];
              const validActionsFound = parsed.action.filter(action => validActions.includes(action));

              if (validActionsFound.length > 0) {
                logger.info(`✅ JSON avec actions multiples réparé: ${validActionsFound.join(', ')}`);
                return {
                  ...parsed,
                  action: validActionsFound,
                  memory_update: {
                    ...parsed.memory_update,
                    lastActions: [...(parsed.memory_update?.lastActions || []), 'json_repaired_multiple_actions'],
                    lastAnalysis: {
                      repair_method: 'complete_json_extraction',
                      original_text: rawText.substring(0, 100) + '...',
                      timestamp: new Date()
                    }
                  }
                };
              }
            }

            // Si c'est une action unique, la valider
            if (typeof parsed.action === 'string') {
              const validActions = ['POST_TWEET', 'UPDATE_PROFILE', 'DELETE_TWEET', 'RESPOND_TO_USER', 'NO_ACTION'];
              if (validActions.includes(parsed.action)) {
                logger.info(`✅ JSON avec action unique réparé: ${parsed.action}`);
                return {
                  ...parsed,
                  memory_update: {
                    ...parsed.memory_update,
                    lastActions: [...(parsed.memory_update?.lastActions || []), 'json_repaired_single_action'],
                    lastAnalysis: {
                      repair_method: 'complete_json_extraction',
                      original_text: rawText.substring(0, 100) + '...',
                      timestamp: new Date()
                    }
                  }
                };
              }
            }
          }
        } catch (parseError) {
          logger.debug(`⚠️ Parsing du JSON complet échoué: ${parseError.message}`);
        }
      }

      // Chercher des patterns JSON partiels
      const partialPatterns = [
        /"action"\s*:\s*"([^"]+)"[^}]*"reason"\s*:\s*"([^"]+)"/,
        /"action"\s*:\s*"([^"]+)"/,
        /"reason"\s*:\s*"([^"]+)"/
      ];

      for (const pattern of partialPatterns) {
        const match = cleanedText.match(pattern);
        if (match) {
          // Construire un JSON minimal valide
          const action = match[1] || 'NO_ACTION';
          const reason = match[2] || 'Réponse partielle de Gemini';

          // Vérifier que l'action est valide
          const validActions = ['POST_TWEET', 'UPDATE_PROFILE', 'DELETE_TWEET', 'RESPOND_TO_USER', 'NO_ACTION'];
          const validAction = validActions.includes(action) ? action : 'NO_ACTION';

          const repairedJson = {
            action: validAction,
            reason: reason,
            priority: 'medium',
            details: {},
            memory_update: {
              lastActions: ['json_repaired'],
              lastAnalysis: {
                repair_method: pattern.toString(),
                original_text: cleanedText.substring(0, 100) + '...',
                timestamp: new Date()
              }
            }
          };

          logger.info(`✅ JSON réparé avec succès: ${validAction} - ${reason}`);
          return repairedJson;
        }
      }

      // Si aucun pattern ne fonctionne, essayer de détecter des mots-clés
      const keywordDetection = this.detectActionFromKeywords(cleanedText);
      if (keywordDetection) {
        logger.info(`✅ Action détectée par mots-clés: ${keywordDetection.action}`);
        return keywordDetection;
      }

      logger.warn('⚠️ Impossible de réparer le JSON Gemini');
      return null;

    } catch (error) {
      logger.error('❌ Erreur lors de la réparation du JSON:', error);
      return null;
    }
  }

  /**
   * Détecte l'action à partir de mots-clés dans le texte
   */
  detectActionFromKeywords(text) {
    const lowerText = text.toLowerCase();

    // Détection par mots-clés
    if (lowerText.includes('poster') || lowerText.includes('tweet') || lowerText.includes('nouveau')) {
      return {
        action: 'POST_TWEET',
        reason: 'Détection par mots-clés: demande de nouveau contenu',
        priority: 'medium',
        details: {},
        memory_update: {
          lastActions: ['action_detected_by_keywords'],
          lastAnalysis: {
            detection_method: 'keyword_analysis',
            keywords_found: ['poster', 'tweet', 'nouveau'],
            timestamp: new Date()
          }
        }
      };
    }

    if (lowerText.includes('répondre') || lowerText.includes('utilisateur') || lowerText.includes('question')) {
      return {
        action: 'RESPOND_TO_USER',
        reason: 'Détection par mots-clés: demande de réponse',
        priority: 'high',
        details: {},
        memory_update: {
          lastActions: ['action_detected_by_keywords'],
          lastAnalysis: {
            detection_method: 'keyword_analysis',
            keywords_found: ['répondre', 'utilisateur', 'question'],
            timestamp: new Date()
          }
        }
      };
    }

    // Par défaut, ne rien faire
    return {
      action: 'NO_ACTION',
      reason: 'Détection par mots-clés: aucune action détectée',
      priority: 'low',
      details: {},
      memory_update: {
        lastActions: ['action_detected_by_keywords'],
        lastAnalysis: {
          detection_method: 'keyword_analysis',
          keywords_found: [],
          timestamp: new Date()
        }
      }
    };
  }

  /**
   * Génère du contenu de réponse contextuelle
   */
  async generateResponseContent(decision) {
    try {
      logger.info('🔧 Génération automatique du contenu de réponse...');

      const targetUser = decision.details?.target_user || decision.details?.respond_to?.target_user || '';
      const parentTweetId =
        decision.details?.parent_tweet_id ||
        decision.details?.respond_to?.parent_tweet_id ||
        (decision.details?.respond_to_users && decision.details.respond_to_users[0]?.parent_tweet_id) ||
        null;

      let commentContent =
        decision.details?.comment_content ||
        decision.details?.respond_to?.comment_content ||
        (decision.details?.respond_to_users && decision.details.respond_to_users[0]?.comment_content) ||
        '';

      // Si le contenu du commentaire n'est pas fourni par la décision, le récupérer depuis la DB
      if ((!commentContent || commentContent.trim().length === 0) && parentTweetId) {
        try {
          const { Tweet } = require('../../models');
          const parentTweet = await Tweet.findByPk(parentTweetId, { attributes: ['content'] });
          if (parentTweet?.content) {
            commentContent = parentTweet.content;
            logger.info(`🧠 Contexte réponse: contenu parent chargé depuis DB (${parentTweetId})`);
          }
        } catch (dbErr) {
          logger.warn(`⚠️ Impossible de charger le contenu du tweet parent (${parentTweetId}): ${dbErr?.message}`);
        }
      }

      const instructionManager = require('./InstructionManager');
      const adminInstructions = instructionManager.getFormattedInstructions();

      // On injecte l'"esprit" courant (traits/tone + interdits mémoire) pour que
      // les réponses gardent la même vibe et ne replongent pas dans les sujets interdits.
      const { memoryManager } = require('./index');
      const mem = memoryManager?.getMemory?.() || {};
      const personality = mem?.personalityProfile || {};
      const traits = Array.isArray(personality.traits) ? personality.traits.slice(0, 10) : [];
      const toneKeywords = Array.isArray(personality.toneKeywords) ? personality.toneKeywords.slice(0, 10) : [];

      const latestBig = Array.isArray(mem?.bigContexts) ? mem.bigContexts[0] : null;
      const riskKeywords = Array.isArray(latestBig?.risk_keywords) ? latestBig.risk_keywords : [];
      const antiKeywords = Array.from(new Set(
        riskKeywords.map((k) => {
          const s = String(k || '').toLowerCase();
          if (s.includes('gas')) return 'no_gas_mentions';
          if (s.includes('bail')) return 'no_bails';
          if (s.includes('no_gas_mentions')) return 'no_gas_mentions';
          if (s.includes('no_bails')) return 'no_bails';
          return s;
        })
      )).filter(Boolean).slice(0, 5);
      const antiStr = antiKeywords.length > 0 ? antiKeywords.join(', ') : 'no_bails, no_gas_mentions';

      // On garde le contenu original: le prompt limitera la fréquence des mentions.
      const safeComment = String(commentContent || '').trim();

      const prompt = `PolicierCongo, ado 19 ans sur TwitNinf.
${adminInstructions ? `Ordre admin: ${adminInstructions}` : ''}
${targetUser || 'quelquun'} t'a dit: "${safeComment.substring(0, 150)}"

ESPRIT ACTUEL (mémoire):
traits: ${traits.length ? traits.join(', ') : '—'}
ton: ${toneKeywords.length ? toneKeywords.join(', ') : '—'}
interdits: ${antiStr}

POURQUOI TU PENSES COMME CA:
la commu veut du chill et "zéro bails / zéro discussion de compte", donc tu recadres et tu réponds utilement.

RÈGLES:
- Pas de "bails" / transactions / arrangements. Si le sujet tourne autour de ça, recadre en mode chill.
- Tu as le droit de citer @gas ou un pseudo si c'est utile, mais max 1 mention de handle/pseudo dans ta réponse (pas une liste).
- Garde ton esprit: tu réponds pour calmer, recadrer, et apporter une réponse utile.

Reponds naturellement. Max 200 caracteres. Pas de hashtags. Ton = pote decontracte.
JSON uniquement: {"content":"..."}`;

      const response = await this.generateCreativeContent(prompt, 'gemini-3-flash-preview');

      if (!response) {
        // Fallback si Gemini échoue
        return this.generateFallbackResponseContent(decision);
      }

      // Extraire le JSON de la réponse
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.content) {
            logger.info('✅ Contenu de réponse généré automatiquement');
            return String(parsed.content).trim().substring(0, 280);
          }
        } catch (parseError) {
          logger.debug('⚠️ Erreur parsing JSON de la réponse générée:', parseError.message);
        }
      }

      // Fallback si Gemini échoue
      return this.generateFallbackResponseContent(decision);

    } catch (error) {
      logger.error('❌ Erreur lors de la génération automatique du contenu:', error);
      return this.generateFallbackResponseContent(decision);
    }
  }

  /**
   * Génère une réponse de fallback si Gemini échoue
   */
  generateFallbackResponseContent(decision) {
    const reason = decision.reason || 'interaction communautaire';
    const priority = decision.priority || 'medium';

    // Réponses de fallback basées sur la priorité et la raison (max 280 caractères)
    if (priority === 'high') {
      return `Salut ! 🚨 ${reason.substring(0, 30)}... Je suis là ! 💪`;
    } else if (priority === 'medium') {
      return `Hey ! 😊 ${reason.substring(0, 30)}... Merci ! 🤝`;
    } else {
      return `Bonjour ! 👋 ${reason.substring(0, 30)}... Plaisir ! 🌟`;
    }
  }

  /**
   * Génère du contenu de tweet (max 280 caractères) lorsque Gemini a décidé POST_TWEET mais n'a pas fourni de contenu
   */
  async generateTweetContent(decision, extraContext = {}) {
    try {
      logger.info('🔧 Génération automatique du contenu de tweet (max 280 caractères)...');

      const vibeTimeline = (extraContext?.collectedData?.recentPlatformTweets || [])
        .slice(0, 6)
        // Anti-mention: on retire le '@' pour éviter que le modèle recopie des handles interdits.
        .map(t => `${String(t.author || '').replace(/^@/, '')}: ${(t.content || '').substring(0, 100)}`)
        .join('\n');

      const myLast = (extraContext?.collectedData?.mainTweets || [])
        .slice(0, 3)
        .map(t => `"${(t.content || '').substring(0, 80)}"`)
        .join(' / ');

      const instructionManager = require('./InstructionManager');
      const adminInstructions = instructionManager.getFormattedInstructions();

      // Injections mémoire: garde la vibe + le "pourquoi" (esprit) sur les tweets.
      const { memoryManager } = require('./index');
      const mem = memoryManager?.getMemory?.() || {};
      const personality = mem?.personalityProfile || {};
      const traits = Array.isArray(personality.traits) ? personality.traits.slice(0, 10) : [];
      const toneKeywords = Array.isArray(personality.toneKeywords) ? personality.toneKeywords.slice(0, 10) : [];

      const latestBig = Array.isArray(mem?.bigContexts) ? mem.bigContexts[0] : null;
      const riskKeywords = Array.isArray(latestBig?.risk_keywords) ? latestBig.risk_keywords : [];
      const antiKeywords = Array.from(new Set(
        riskKeywords.map((k) => {
          const s = String(k || '').toLowerCase();
          if (s.includes('gas')) return 'no_gas_mentions';
          if (s.includes('bail')) return 'no_bails';
          if (s.includes('no_gas_mentions')) return 'no_gas_mentions';
          if (s.includes('no_bails')) return 'no_bails';
          return s;
        })
      )).filter(Boolean).slice(0, 5);
      const antiStr = antiKeywords.length > 0 ? antiKeywords.join(', ') : 'no_bails, no_gas_mentions';

      const prompt = `PolicierCongo, ado 19 ans sur TwitNinf. Tu dois poster 1 tweet maintenant.
${adminInstructions ? `Ordre: ${adminInstructions}` : `Raison: ${decision?.reason || 'poster quelque chose de naturel'}`}

Mes derniers tweets (evite de repeter le meme trip): ${myLast || 'aucun'}

Vibe TL en ce moment (reagis si quelque chose te parle, sinon poste autre chose):
${vibeTimeline || 'rien'}

POURQUOI / ESPRIT (mémoire):
traits: ${traits.length ? traits.join(', ') : '—'}
ton: ${toneKeywords.length ? toneKeywords.join(', ') : '—'}
interdits: ${antiStr}

REGLES:
- Max 280 caracteres
- Pas de hashtags
- Pas de "bails" / transactions / arrangements. Si ça arrive, recadre et reste chill.
- Si tu mentionnes un handle/pseudo (@gas ou autre), fais-le max 1 fois sur le tweet (pas systématique).
- Pas de "Rapport", "brigade", "analyse", stats d'engagement
- Ado chill: ironie, vanne, avis tranquille, reaction scroll - pas un pitch de concept

JSON uniquement: {"content":"..."}`;

      const response = await this.generateCreativeContent(prompt, 'gemini-3-flash-preview');
      if (!response) return this.generateFallbackTweetContent(decision);

      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          let content = (parsed.content || '').trim();
          if (content.length > 280) content = content.substring(0, 280);
          if (content.length > 0) {
            logger.info('✅ Contenu de tweet généré automatiquement');
            return content;
          }
        } catch (_) { }
      }

      return this.generateFallbackTweetContent(decision);
    } catch (error) {
      logger.error('❌ Erreur generateTweetContent:', error);
      return this.generateFallbackTweetContent(decision);
    }
  }

  generateFallbackTweetContent(decision) {
    const reason = (decision?.reason || '').toLowerCase();
    const needsApology = /répétitif|repetitif|excuse|désolé|desole/.test(reason);
    let base = needsApology ? "Désolé pour la répétition 🙏" : "On avance ensemble ✨";
    const extras = needsApology ? " Nouveau cap, merci pour vos retours !" : " Force à la communauté 🇨🇩";
    let content = `${base}${extras}`;
    if (content.length > 280) content = content.substring(0, 280);
    return content;
  }

  /**
   * Génère une suggestion de mise à jour de profil (méthode de compatibilité)
   */
  async generateProfileUpdateSuggestion(decision, currentProfile = {}) {
    try {
      logger.info('🧠 Génération de suggestion de profil...');

      // Utiliser la méthode existante avec un contexte minimal
      const suggestion = await this.requestProfileUpdateFromMemory(currentProfile, {
        decision_context: {
          action: decision.action,
          reason: decision.reason,
          priority: decision.priority,
          details: decision.details
        }
      });

      return suggestion;
    } catch (error) {
      logger.warn('⚠️ Échec de la génération de suggestion de profil:', error?.message);
      return null;
    }
  }

  /**
   * Demande à Gemini une proposition de mise à jour de profil en utilisant la mémoire complète
   */
  async requestProfileUpdateFromMemory(currentProfile = {}, memorySummary = {}) {
    try {
      logger.info('🧠 Requête Gemini: suggestion de profil basée sur la mémoire...');

      const prompt = `Tu es Policier Congo.

OBJECTIF: Proposer une mise à jour de profil claire pour améliorer l'identité (peut inclure 🇨🇩) et la cohérence du compte.

CONTEXTE PROFIL ACTUEL:
${JSON.stringify(currentProfile, null, 2)}

MÉMOIRE (résumé utile):
${JSON.stringify(memorySummary, null, 2)}

EXIGENCES:
- Fournis un JSON STRICT avec au moins un des deux: "new_full_name" ou "new_username".
- new_full_name: court, lisible, peut inclure le drapeau 🇨🇩 si pertinent.
- new_username: ne change que si vraiment nécessaire (évite de casser les liens).
- Ajoute un champ "reason" (court) qui explique la proposition.

FORMAT STRICT:
{
  "new_full_name": "..." (optionnel),
  "new_username": "..." (optionnel),
  "reason": "..." (obligatoire)
}
`;

      const { text } = await this.safeGenerateWithFallback(prompt, 'gemini-3-flash-preview', 'gemini-3-flash-preview', 2);
      logger.info('🧠 Suggestion profil - réponse brute:', text || '(vide)');

      if (!text) return null;

      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]);
      if (typeof parsed !== 'object' || !parsed.reason) return null;

      return {
        new_full_name: parsed.new_full_name || null,
        new_username: parsed.new_username || null,
        reason: parsed.reason
      };
    } catch (error) {
      logger.warn('⚠️ Échec de la suggestion de profil via mémoire:', error?.message);
      return null;
    }
  }

  /**
   * Génère un Big Context à partir des tweets/réactions récents
   */
  async generateBigContext(collectedData, geminiMemory) {
    try {
      logger.info('🧠 Génération du Big Context (synthèse stratégique)...');

      const lastMainTweetHourParis = this.formatParisDateSafe(
        collectedData?.timingAnalysis?.lastMainTweet || null,
        { timeStyle: 'short', dateStyle: 'short' },
        'inconnu'
      );

      const prompt = `Tu es Policier Congo.

OBJECTIF: Synthétiser un "Big Context" (vue d'ensemble stratégique) à partir des TWEETS PRINCIPAUX récents, des RÉPONSES récentes et des DEMANDES de la communauté.

FOCUS:
- Thèmes majeurs (topics)
- Sentiment global (positif/neutre/négatif) + 1-5 keywords ultra-courts
- Principales demandes utilisateurs (user_requests) en keywords (1 mot clé chacun)
- Stratégie de contenu à court terme (content_strategy) en keywords (1 mot clé chacun, séparés par des virgules)
- Risques à éviter (risks) en keywords (1 mot clé chacun)
- Idées concrètes de prochains contenus (next_ideas) en keywords (1 mot clé chacun)

CONTRAINTES:
- Sois concis, concret, directement exploitable
- Ne pas imposer l'identité; rester à l'écoute, humble et adaptable
- Respecte la limite de 600 dans les idées
- RISQUES / INTERDITS (obligatoire):
  - La commu ne veut PAS de "bails" (contenu du type "bail/transactions/arrangements").
  - La commu ne veut PAS les messages qui tournent autour de @gas.

- Toujours produire des keywords en 1 seul token (pas de phrase, pas d'espace).
- Pour chaque champ liste ci-dessous: maximum 5 éléments.

ENTRÉES:
HEURE DU DERNIER TWEET PRINCIPAL (Paris): ${lastMainTweetHourParis}
RECENT MAIN TWEETS: ${JSON.stringify(collectedData.mainTweets || [], null, 2)}
RECENT REPLIES: ${JSON.stringify(collectedData.replies || [], null, 2)}
UNREPLIED (ids): ${JSON.stringify((collectedData.unrepliedComments || []).map(c => c.id))}
MEMORY SUMMARY: interactions=${(geminiMemory.significantInteractions || []).length}, dedications=${(geminiMemory.dedicationRequests || []).length}, special_requests=${(geminiMemory.userSpecialRequests || []).length}

Retourne STRICTEMENT un JSON:
{
  "window": "last_24h|last_6h|custom",
  "topics": ["kw1","kw2","kw3","kw4","kw5"],
  "sentiment_summary": "kw1,kw2,kw3",
  "user_requests": ["kw1","kw2","kw3","kw4","kw5"],
  "content_strategy": "kw1,kw2,kw3,kw4,kw5",
  "risks": ["no_bails","@exemple","no_exemple_mentions", "..."],
  "next_ideas": ["kw1","kw2","kw3","kw4","kw5"],
  "source_notes": "kw1,kw2,kw3"
}`;

      const { text } = await this.safeGenerateWithFallback(prompt, 'gemini-3-flash-preview', 'gemini-3-flash-preview', 2);
      logger.info('🧠 Big Context - réponse brute:', text || '(vide)');
      if (!text) return null;
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch (error) {
      logger.warn('⚠️ Échec de génération du Big Context:', error?.message);
      return null;
    }
  }

  /**
   * Obtient le statut de l'intelligence Gemini
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      apiKeyConfigured: !!this.apiKey,
      statistics: {
        request_count: this.requestCount,
        success_count: this.successCount,
        error_count: this.errorCount,
        success_rate: this.requestCount > 0 ? (this.successCount / this.requestCount * 100).toFixed(2) + '%' : '0%'
      }
    };
  }

  /**
   * Réinitialise l'API Gemini
   */
  reset() {
    this.isInitialized = false;
    this.ai = null;
    this.requestCount = 0;
    this.successCount = 0;
    this.errorCount = 0;

    return this.initialize();
  }

  /**
   * Génère un embedding vectoriel pour un texte via Gemini (text-embedding-004)
   * Supporte la rotation automatique des clés.
   */
  async embedText(text) {
    if (!text || !String(text).trim()) return [];
    
    const MAX_ATTEMPTS = this.apiKeys.length;
    let attempt = 0;
    const cleanText = String(text).trim().slice(0, 8000);

    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      try {
        if (!this.ai) this.initialize();
        
        // Utilisation du modèle d'embedding dédié
        const model = this.ai.getGenerativeModel({ model: "text-embedding-004" });
        const result = await model.embedContent(cleanText);
        const embedding = result.embedding.values;
        
        if (embedding && Array.isArray(embedding)) {
          return embedding;
        }
        throw new Error("Format d'embedding invalide");
      } catch (error) {
        const status = error?.status || (error?.message?.includes('503') ? 503 : (error?.message?.includes('429') ? 429 : 500));
        
        if (status === 429 || status === 503 || status === 500) {
          logger.warn(`⚠️ Erreur embedding Gemini (${status}). Rotation de clé...`);
          this.switchApiKey();
          continue;
        }
        
        logger.error(`❌ Erreur critique embedding Gemini: ${error.message}`);
        return [];
      }
    }
    return [];
  }
}

module.exports = GeminiIntelligence;
