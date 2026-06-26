/**
 * Pont production : PolicierCongo V2 + PostgreSQL + MegaLLM / Gemini.
 */

'use strict';

const { Pool } = require('pg');
const config = require('../../config/config');
const logger = require('../../utils/logger');
const { createPostgresAdapters } = require('./policiercongoV2.memoryAdapters');
const { createLocalEmbedQuery, createCohereEmbedQuery } = require('./policiercongoV2Embeddings');
const { PolicierCongoV2, DEFAULT_CLAUDE_MODEL, TRIGGER_TYPES, ReplyQueue, CommunitySignals } = require('./policiercongoV2');
const instructionManager = require('./InstructionManager');
const schedulerManager = require('./schedulerManager');
const { POLICE_ACCOUNT_ID } = require('./config');

function formatParisTs(d) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(d instanceof Date ? d : new Date(d));
}

/**
 * Résumé compact pour retrieval + champ JSON "ecosystem" (timing, file d'attente, tendances).
 */
function buildRuntimeContextPack(collectedData, event = {}) {
  const lines = [];
  const c = collectedData || {};

  if (c.timingAnalysis && typeof c.timingAnalysis === 'object') {
    const ta = c.timingAnalysis;
    lines.push(
      `[timing] dernier_tweet_principal_il_y_a=${ta.hoursSinceLastMainTweet ?? '?'}h (info seulement, tu décides)`
    );
  }

  if (Array.isArray(c.unrepliedComments) && c.unrepliedComments.length) {
    lines.push('[file_reponses]');
    c.unrepliedComments.slice(0, 15).forEach((u, i) => {
      const ex = (u.content || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      lines.push(`${i + 1}. id=${u.id} @${u.author || '?'} urg=${u.urgency || '?'} h=${u.hours_ago ?? '?'} | ${ex}`);
    });
  }

  if (c.trendingTopics && typeof c.trendingTopics === 'object') {
    const tags = (c.trendingTopics.hashtags || []).slice(0, 14).join(', ');
    const sujets = (c.trendingTopics.sujets || []).slice(0, 10).join(', ');
    if (tags || sujets) lines.push(`[tendances_24h] hashtags: ${tags} | sujets: ${sujets}`);
  }

  if (Array.isArray(c.userTrendingTweets) && c.userTrendingTweets.length) {
    lines.push('[extraits_tl_populaire]');
    c.userTrendingTweets.slice(0, 12).forEach(t => {
      lines.push(`- @${t.author || '?'}: ${(t.content || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    });
  }

  if (Array.isArray(c.recentPlatformTweets) && c.recentPlatformTweets.length) {
    lines.push('[tl_recente]');
    c.recentPlatformTweets.slice(0, 20).forEach(t => {
      const when = t.heure_paris || t.ago || '';
      lines.push(`- [${when}] @${t.author || '?'}: ${(t.content || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    });
  }

  if (Array.isArray(c.mainTweets) && c.mainTweets.length) {
    lines.push('[tes_derniers_posts]');
    c.mainTweets.slice(0, 12).forEach((t, i) => {
      lines.push(`${i + 1}. (${t.likes ?? 0}♥) ${(t.content || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`);
    });
  }

  const lc = event.metadata?.latest_comment;
  if (lc && (lc.content || lc.text)) {
    const a = lc.author || lc.username || '?';
    lines.push(`[prochaine_cible_suggeree] @${a}: ${String(lc.content || lc.text).replace(/\s+/g, ' ').trim().slice(0, 180)}`);
  }

  return lines.join('\n').slice(0, 6500);
}

let _pool = null;
let _bot = null;
let _replyQueue = new ReplyQueue();
let _communitySignals = new CommunitySignals();

function _useV2() {
  // MANUEL : Forçage V2 à true comme demandé par l'utilisateur
  return true;
}

function getPgPool() {
  if (_pool) return _pool;
  try {
    _pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.username,
      password: config.database.password,
      max: Math.min(8, (config.database.pool && config.database.pool.max) || 8),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      ssl: config.database.dialectOptions && config.database.dialectOptions.ssl
    });
    _pool.on('error', (err) => {
      logger.error('[pc2.bridge] Erreur pool PostgreSQL:', err.message);
    });
  } catch (e) {
    logger.error('[pc2.bridge] Impossible de créer le pool pg:', e.message);
    return null;
  }
  return _pool;
}

function getV2Bot() {
  if (!_useV2()) return null;
  if (_bot) return _bot;
  const pool = getPgPool();
  if (!pool) return null;
  try {
    // Le USER veut rester sur le modèle local (transformers) pour la souveraineté.
    const embedQuery = createLocalEmbedQuery();
    const memory = createPostgresAdapters({
      pgPool: pool,
      ensureSchema: true,
      embedQuery
    });
    _bot = new PolicierCongoV2({ 
      memory,
      replyQueue: _replyQueue,
      communitySignals: _communitySignals
    });
    logger.info('[pc2.bridge] PolicierCongoV2 initialisé (V2.1 with persistent Signals & Queue).');
  } catch (e) {
    _initError = e;
    logger.error('[pc2.bridge] Échec init PolicierCongoV2:', e.message);
    return null;
  }
  return _bot;
}

/**
 * Aplatit messages[] (system/user/assistant) en un seul prompt pour MegaLLM.
 * @param {{ role: string; content: string }[]} messages
 */
function flattenV2Messages(messages) {
  if (!messages || !messages.length) return '';
  return messages
    .map((m) => {
      const r = (m.role || 'user').toLowerCase();
      const label = r === 'system' ? 'System' : r === 'assistant' ? 'Assistant' : 'User';
      return `### ${label}\n${m.content || ''}`;
    })
    .join('\n\n');
}

/**
 * Exécute un tour complet V2 : prepareTurn → LLM → finalizeTurn.
 */
async function runPolicierCongoV2Turn({ event, buildOptions = {}, geminiIntelligence, collectedData = null }) {
  let bot = null;
  try {
    bot = getV2Bot();
  } catch (initErr) {
    logger.error(`[pc2.bridge] Erreur critique d'initialisation du bot V2: ${initErr.message}`, initErr);
  }

  if (!bot || !geminiIntelligence) {
    logger.warn(`[pc2.bridge] Échec: bot=${!!bot}, gemini=${!!geminiIntelligence}. La V2 ne peut pas démarrer.`);
    return null;
  }

  // ALIMENTATION V2.1 : Signals & Queue
  if (collectedData) {
    // Helper : heure Paris lisible
    const heureParis = (ts) => new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit'
    }).format(new Date(ts || Date.now()));

    // 1. Ingestion des commentaires non répondus réels
    const unreplied = collectedData.unrepliedComments || [];
    unreplied.forEach(c => _replyQueue.enqueue({ id: c.id, userId: c.author, text: c.content, verified: c.author_verified }));

    // 2. Ingestion des signaux communautaires (tendances + tweets populaires)
    if (collectedData.trendingTopics) {
      const trends = collectedData.trendingTopics.hashtags || [];
      const topics = collectedData.trendingTopics.sujets || [];
      _communitySignals.ingest(`Tendances actuelles (${heureParis()}) : ${trends.join(', ')} / Sujets : ${topics.join(', ')}`, 2);
    }
    if (collectedData.userTrendingTweets) {
      collectedData.userTrendingTweets.forEach(t => {
        // Inclure l'heure réelle du tweet (Paris) pour que le bot sache si c'est vieux
        const tweetTs = t.created_at ? new Date(t.created_at).getTime() : null;
        const heureLabel = tweetTs ? heureParis(tweetTs) : heureParis();
        const agoMin = tweetTs ? Math.round((Date.now() - tweetTs) / 60000) : 0;
        const agoLabel = agoMin < 60 ? `il y a ${agoMin}min` : `il y a ${Math.round(agoMin / 60)}h`;
        _communitySignals.ingest(`Tweet [${heureLabel} Paris - ${agoLabel}] de @${t.author} : ${t.content}`, t.likes > 20 ? 2 : 1);
      });
    }
    // Ingestion spécifique pour Fortnite (si présent dans les tendances)
    const allText = JSON.stringify(collectedData).toLowerCase();
    if (allText.includes('fortnite')) {
      _communitySignals.ingest("SIGNAL FORT : La communauté parle beaucoup de Fortnite !", 3);
    }
  }

  // S'assurer qu'un userId est présent pour charger la mémoire (Self-Memory par défaut)
  if (!event.userId) {
    event.userId = POLICE_ACCOUNT_ID;
  }

  const contextPack = buildRuntimeContextPack(collectedData, event);

  const prep = await bot.prepareTurn(event, { 
    ...buildOptions, 
    contextPack,
    currentProfile: collectedData?.currentProfile,
    selfModeration: collectedData?.selfModeration,
    financialData: collectedData?.financialData
  });
  
  // Injection automatique des ordres Admin dans le prompt système
  const adminInstructions = instructionManager.getFormattedInstructions();
  const hasImmediateOrders = instructionManager.instructions.immediate_orders.some(o => o.status === 'pending');
  
  if (adminInstructions && prep.messages.length > 0) {
    // V2.1 structure : messages[0] is the system prompt (role: user)
    const sysMsg = prep.messages[0];
    if (sysMsg && !sysMsg.content.includes(adminInstructions)) {
      sysMsg.content = `${sysMsg.content}\n\n🚨 ORDRES ADMIN (À FILTRER PAR TA PERSONNALITÉ):\n${adminInstructions}`;
    }
  }

  // Anti-répétition : vrais derniers tweets publiés + extraits mémoire assistant
  try {
    if (_pool && prep.messages.length > 0) {
      const sysMsg = prep.messages[0];
      if (sysMsg) {
        const blocks = [];

        const { rows: ownTweetRows } = await _pool.query(
          `SELECT content, created_at FROM tweets
           WHERE user_id = $1 AND parent_tweet_id IS NULL AND deleted_at IS NULL
           ORDER BY created_at DESC
           LIMIT 25`,
          [POLICE_ACCOUNT_ID]
        );
        if (ownTweetRows.length > 0) {
          const lines = ownTweetRows.map((r, i) => {
            const when = r.created_at ? formatParisTs(r.created_at) : '?';
            const body = (r.content || '').replace(/\s+/g, ' ').trim().slice(0, 400);
            return `${i + 1}. [${when} Paris] ${body}`;
          });
          blocks.push(
            'TES DERNIERS POSTS (contexte pour comprendre ton fil — tu gères seule la suite) :\n' +
              lines.join('\n')
          );
        }

        const { rows: historyRows } = await _pool.query(
          `SELECT source_text FROM policiercongo_v2_embeddings
           WHERE metadata->>'role' = 'assistant'
           ORDER BY created_at DESC
           LIMIT 12`
        );
        if (historyRows.length > 0) {
          const historyText = historyRows
            .map(r => `- "${(r.source_text || '').replace(/\s+/g, ' ').trim().slice(0, 280)}"`)
            .join('\n');
          blocks.push(`MÉMOIRE RÉCENTE (ce que tu as déjà dit — pour t\'orienter) :\n${historyText}`);
        }

        if (blocks.length) sysMsg.content += `\n\n${blocks.join('\n\n')}`;
      }
    }
  } catch (err) {
    logger.warn(`[pc2.bridge] Anti-rép: ${err.message}`);
  }

  // 🧠 CONSCIENCE DU BOT : état interne injecté dans le prompt
  try {
    if (prep.messages.length > 0) {
      const sysMsg = prep.messages[0];
      if (sysMsg) {
        const consciousParts = [];

        // Prochain passage planifié
        try {
          schedulerManager.load();
          const nextRun = schedulerManager.nextRunTime;
          if (nextRun) {
            const diffMin = Math.round((nextRun.getTime() - Date.now()) / 60000);
            if (diffMin > 0) {
              const h = Math.floor(diffMin / 60);
              const m = diffMin % 60;
              consciousParts.push(`Prochain check plateforme: ${h > 0 ? h + 'h' : ''}${m > 0 ? m + 'min' : ''}`);
            } else {
              consciousParts.push('Prochain check: imminent');
            }
          }
        } catch (_) {}

        // Stats tweets via DB
        try {
          if (_pool) {
            const { rows: [stats] } = await _pool.query(
              `SELECT 
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS recent_24h,
                COUNT(*) AS total,
                MAX(created_at) AS last_tweet_at
               FROM tweets WHERE user_id = $1 AND parent_tweet_id IS NULL`,
              [require('./config').POLICE_ACCOUNT_ID]
            );
            if (stats) {
              consciousParts.push(`Tweets 24h: ${stats.recent_24h || 0}`);
              consciousParts.push(`Total tweets: ${stats.total || 0}`);
              if (stats.last_tweet_at) {
                const ago = Math.round((Date.now() - new Date(stats.last_tweet_at).getTime()) / 60000);
                const agoH = Math.floor(ago / 60);
                const agoM = ago % 60;
                consciousParts.push(`Dernier tweet: il y a ${agoH > 0 ? agoH + 'h' : ''}${agoM}min`);
              }
            }
          }
        } catch (_) {}

        // Ajout des données financières à la conscience
        const fin = collectedData?.financialData;
        if (fin && fin.wallets && fin.wallets.length > 0) {
          const wallet = fin.wallets[0];
          consciousParts.push(`SOLDE: ${wallet.balance} ${wallet.symbol} (${wallet.currency})`);
          if (fin.monetization) {
            consciousParts.push(`Revenus 30j: ${fin.monetization.totalRevenue30d}€`);
          }
        }

        if (consciousParts.length > 0) {
          sysMsg.content += `\nÉTAT INTERNE: ${consciousParts.join(' | ')}`;
        }
      }
    }
  } catch (conscErr) {
    logger.warn(`[pc2.bridge] Conscience: ${conscErr.message}`);
  }

  logger.info(`[pc2.bridge] V2.1 : ReplyQueue pending=${_replyQueue.pendingCount()}, Signals active.`);

  const prompt = flattenV2Messages(prep.messages);
  const targetModel = prep.model || DEFAULT_CLAUDE_MODEL;

  let llmRaw = null;

  // 🔄 ÉTAPE 1 : Tentative avec le modèle cible (généralement Claude Opus 4.7)
  const isGeminiPrimary = targetModel.startsWith('gemini');
  if (isGeminiPrimary) {
    logger.info(`🧠 Bridge V2: Utilisation directe de Gemini (${targetModel})`);
    llmRaw = await geminiIntelligence.generateContent(prompt, targetModel, true);
  } else {
    llmRaw = await geminiIntelligence.generateWithMegaLLM(prompt, targetModel);
    
    // 🔄 ÉTAPE 2 : FALLBACK 1 -> GPT-5.4 (Si le premier choix a échoué et n'était pas déjà GPT-5.4)
    if ((!llmRaw || !String(llmRaw).trim()) && targetModel !== 'gpt-5.4') {
      logger.warn(`[pc2.bridge] MegaLLM (${targetModel}) indisponible, tentative Fallback 1: gpt-5.4`);
      llmRaw = await geminiIntelligence.generateWithMegaLLM(prompt, 'gpt-5.4');
    }

    // 🔄 ÉTAPE 3 : FALLBACK 2 -> Gemini Flash Preview (Dernier recours)
    if (!llmRaw || !String(llmRaw).trim()) {
      const finalModel = 'gemini-3-flash-preview';
      logger.warn(`[pc2.bridge] MegaLLM indisponible ou vide, tentative Fallback 2: ${finalModel}`);
      try {
        llmRaw = await geminiIntelligence.generateContent(prompt, finalModel, true);
      } catch (fallbackErr) {
        logger.error(`[pc2.bridge] Échec du fallback final Gemini: ${fallbackErr.message}`);
        llmRaw = null;
      }
    }
  }

  if (!llmRaw || !String(llmRaw).trim()) {
    logger.error('[pc2.bridge] Échec critique : Aucun LLM (MegaLLM/Gemini) n\'a pu répondre.');
    return {
      ok: false,
      error: 'Tous les LLM ont échoué',
      replyText: ''
    };
  }

  const resolveId = (event.trigger === TRIGGER_TYPES.MENTION || event.trigger === TRIGGER_TYPES.DIRECT_MESSAGE) ? event.id : null;
  const { structured, actions } = await bot.finalizeTurn(event, llmRaw || '', resolveId);

  const isDirectChat = (event.trigger === TRIGGER_TYPES.DIRECT_MESSAGE || event.trigger === TRIGGER_TYPES.MENTION);

  // Mise à jour du Planning (Scheduler) — CRITIQUE pour éviter les boucles au démarrage
  if (structured && !isDirectChat) {
    const nextMinutes = Array.isArray(structured) 
      ? structured.find(s => s.next_check_in_minutes !== undefined)?.next_check_in_minutes 
      : structured.next_check_in_minutes;
    
    if (nextMinutes !== undefined && nextMinutes !== null) {
      const minutes = parseInt(nextMinutes);
      if (!isNaN(minutes)) {
        const nextDate = new Date(Date.now() + minutes * 60000);
        schedulerManager.scheduleNextRun(nextDate);
        // Afficher l'heure Paris (UTC+2) pour le log
        const nextDateParis = new Intl.DateTimeFormat('fr-FR', {
          timeZone: 'Europe/Paris', timeStyle: 'short'
        }).format(nextDate);
        logger.info(`⏰ [pc2.bridge] Planning mis à jour via IA : +${minutes} min (Réveil à ${nextDateParis} Paris)`);
      } else {
        schedulerManager.scheduleNextRun(null);
      }
    } else {
      // Fallback auto si l'IA oublie de planifier
      schedulerManager.scheduleNextRun(null);
      logger.info('⏰ [pc2.bridge] Pas de next_check_in_minutes, planification par défaut (2h) activée.');
    }
  }

  // Si on a réussi à obtenir une réponse structurée et qu'il y avait des ordres immédiats, 
  // on les marque comme exécutés (consommation unique).
  if (structured && hasImmediateOrders) {
    instructionManager.markOrdersAsExecuted();
    logger.info('[pc2.bridge] Ordres admin marqués comme exécutés après tour V2 réussi.');
  }

  // Injection de fallbacks et mapping universel pour la compatibilité Legacy
  if (structured) {
    const metaUser = event.metadata?.user?.username;
    const metaTweetId = event.postId || event.metadata?.tweet_id;
    const globalUnreplied = collectedData?.unrepliedComments || [];

    // Normalisation : transformer en tableau si c'est un objet seul pour simplifier le traitement
    const isArrayAlready = Array.isArray(structured);
    const actionList = isArrayAlready ? structured : [structured];

    for (const item of actionList) {
      item.target_user = item.target_user || metaUser || null;
      item.parent_tweet_id = item.parent_tweet_id || metaTweetId || null;
      item.tweet_id = item.tweet_id || metaTweetId || null;

      // Emergency Fallback : Si c'est une réponse mais on n'a toujours pas d'ID (ex: automation sans postId)
      const normalizedAction = String(item.action || '').toUpperCase();
      if ((normalizedAction === 'RESPOND_TO_USER' || normalizedAction === 'REPLY') && !item.parent_tweet_id) {
        if (globalUnreplied.length > 0) {
          // On essaie de faire matcher l'ID si target_user correspond, sinon on prend le premier unreplied
          const match = globalUnreplied.find(c => c.author === item.target_user) || globalUnreplied[0];
          item.parent_tweet_id = match.id;
          item.target_user = item.target_user || match.author;
          logger.info(`🚨 [pc2.bridge] Injection d'urgence de parent_tweet_id (${item.parent_tweet_id}) pour @${item.target_user}`);
        }
      }

      // Mapping du contenu (V2 use 'content', Legacy use 'content' or 'response_content')
      if (item.content) {
        item.response_content = item.content;
      }

      // Mapping spécifique pour UPDATE_PROFILE (V2 use 'content' or 'store_memory.new_username')
      if (normalizedAction === 'UPDATE_PROFILE') {
        item.new_username = item.new_username || item.content || item.store_memory?.new_username || null;
        item.new_full_name = item.new_full_name || item.content || item.store_memory?.new_full_name || null;
      }
    }

    // Auto-resolve pending items that have been addressed in structured output
    for (const act of actionList) {
      if ((act.action === 'reply' || act.action === 'RESPOND_TO_USER') && act.parent_tweet_id) {
        bot.replyQueue.resolve(act.parent_tweet_id);
      }
    }

    // Si on a plusieurs actions, on les pack pour l'ActionExecutor
    if (isArrayAlready && structured.length > 1) {
      return {
        ok: true,
        model: bot.modelUsed || 'unknown',
        structured: {
          action: 'MULTIPLE_ACTIONS',
          actions: structured.map(s => ({
            action: s.action,
            reason: s.reason || 'Décision groupée V2',
            details: s
          }))
        },
        replyText: structured[0].content || '',
        meta: prep.meta
      };
    }
    
    // Si c'est une action de profil (fallback legacy)
    if (structured.action === 'UPDATE_PROFILE') {
      structured.new_username = structured.new_username || null;
      structured.new_full_name = structured.new_full_name || null;
    }
  }

  let replyText = '';
  if (structured && typeof structured.content === 'string') {
    replyText = structured.content.trim();
  }

  return {
    ok: true,
    structured,
    actions,
    replyText,
    model: targetModel,
    meta: prep.meta
  };
}

function isPolicierCongoV2Enabled() {
  return _useV2(); // Toujours true pour forcer l'usage du nouveau système
}

module.exports = {
  getPgPool,
  getV2Bot,
  flattenV2Messages,
  runPolicierCongoV2Turn,
  isPolicierCongoV2Enabled,
  buildRuntimeContextPack,
  TRIGGER_TYPES
};
