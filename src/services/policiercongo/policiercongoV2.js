'use strict';

/**
 * PolicierCongo V2.1 — policiercongoV2.js
 *
 * Philosophie : L'IA est souveraine. Aucun exemple imposé, aucun pattern hardcodé.
 * Le bot observe, accumule les signaux bruts de la commu, et décide seul quoi faire.
 *
 * Fixes vs V2 :
 *  1. Modèle Claude Code (par défaut claude-opus-5, configurable via env POLICIERCONGO_V2_MODEL)
 *  2. ReplyQueue : file réelle — le bot ne répond PLUS à des fantômes
 *  3. CommunitySignals : signaux bruts transmis à l'IA tels quels, sans interprétation
 *  4. ProactiveEngine : agit sur ce que la commu a RÉELLEMENT exprimé
 *  5. Cycle smarter : replies réelles prioritaires → proactif si signaux → sinon silence
 *  6. Prompt minimaliste — zéro exemple imposé, l'IA s'adapte au contexte brut
 */

const logger = require('../../utils/logger');

// ─── Modèle & limites ────────────────────────────────────────────────────────

const DEFAULT_CLAUDE_MODEL =
  process.env.POLICIERCONGO_V2_MODEL || 'claude-opus-5';

const SHORT_TERM_MAX_MESSAGES = 20;

// ─── Constantes ───────────────────────────────────────────────────────────────

const TRIGGER_TYPES = {
  MENTION: 'mention',
  DIRECT_MESSAGE: 'direct_message',
  REACTION: 'reaction',
  NEW_POST: 'new_post',
  WEBHOOK: 'webhook',
  SCHEDULED: 'scheduled',
  PROACTIVE: 'proactive'
};

const INTENT_TYPES = {
  QUESTION: 'question',
  HELP: 'help',
  SOCIAL: 'social',
  CREATION: 'creation',
  MODERATION: 'moderation',
  UNKNOWN: 'unknown'
};

const ACTION_TYPES = {
  REPLY: 'reply',
  POST: 'post',
  SUMMARIZE: 'summarize',
  ANALYZE: 'analyze',
  NOTIFY: 'notify',
  PLAN: 'plan',
  CLARIFY: 'clarify',
  MODERATE: 'moderate',
  LIKE: 'like',
  REPOST: 'repost',
  DIGEST: 'digest',
  SUGGEST: 'suggest',
  MONITOR: 'monitor',
  ONBOARD: 'onboard',
  UPDATE_PROFILE: 'update_profile',
  DELETE_TWEET: 'delete_tweet',
  UNBAN_REQUEST: 'unban_request',
  REQUEST_WITHDRAWAL: 'request_withdrawal',
  NOOP: 'noop'
};

const GATE_RESULTS = {
  BLOCKED: 'blocked',
  APPROVED: 'approved'
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — ReplyQueue
//
// File des messages réels non répondus.
// Empêche le bot de répondre à du vent entre deux cycles.
// ─────────────────────────────────────────────────────────────────────────────

class ReplyQueue {
  constructor() {
    /** @type {Map<string, { id:string; userId:string; text:string; ts:number; resolved:boolean }>} */
    this._queue = new Map();
  }

  enqueue({ id, userId, text }) {
    if (!id || this._queue.has(id)) return;
    this._queue.set(id, { id, userId, text, ts: Date.now(), resolved: false });
  }

  getPending(limit = 5) {
    return [...this._queue.values()]
      .filter(i => !i.resolved)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, limit);
  }

  resolve(id) {
    const item = this._queue.get(id);
    if (item) { item.resolved = true; this._queue.set(id, item); }
  }

  pendingCount() {
    return [...this._queue.values()].filter(i => !i.resolved).length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — CommunitySignals
//
// Accumule les signaux BRUTS de la commu (textes, metadata d'engagement…)
// sans aucune catégorisation imposée. L'IA reçoit ces signaux crus et
// décide elle-même ce qu'elle en fait.
// ─────────────────────────────────────────────────────────────────────────────

class CommunitySignals {
  constructor() {
    /** @type {{ text: string; ts: number; weight: number }[]} */
    this._signals = [];
    this._maxSignals = 100;
  }

  /**
   * Ingère un signal brut.
   * @param {string} text
   * @param {number} [weight=1]  — 1 normal · 2 fort engagement · 3 viral
   */
  ingest(text, weight = 1) {
    if (!text || typeof text !== 'string') return;
    this._signals.push({ text: text.slice(0, 500), ts: Date.now(), weight });
    if (this._signals.length > this._maxSignals) this._signals.shift();
  }

  /**
   * Retourne les N signaux les plus récents/pesants sous forme de texte brut.
   * Inclut l'heure Paris (UTC+2) pour que l'IA sache si c'est récent ou vieux.
   * @param {number} [limit=20]
   * @returns {string}
   */
  getSummaryForLLM(limit = 20) {
    const sorted = [...this._signals]
      .sort((a, b) => (b.weight * 1e12 + b.ts) - (a.weight * 1e12 + a.ts));
    if (!sorted.length) return '(aucun signal enregistré)';
    const seen = new Set();
    const deduped = [];
    for (const s of sorted) {
      const key = (s.text || '').slice(0, 96).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(s);
      if (deduped.length >= limit) break;
    }
    if (!deduped.length) return '(aucun signal enregistré)';
    return deduped.map(s => {
      // Heure Paris (UTC+2) pour chaque signal — le bot sait si c'est vieux ou récent
      const heureParis = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(s.ts));
      const agoMin = Math.round((Date.now() - s.ts) / 60000);
      const agoLabel = agoMin < 60 ? `il y a ${agoMin}min` : `il y a ${Math.round(agoMin / 60)}h`;
      return `[${heureParis} Paris — ${agoLabel} | poids:${s.weight}] ${s.text}`;
    }).join('\n');
  }

  serialize() { return this._signals.slice(-50); }
  restore(data = []) { this._signals = Array.isArray(data) ? data : []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — ProactiveEngine
//
// Décide la stratégie du cycle autonome.
// PRIORITÉ : reply réelle → post sur signaux → silence (jamais d'invention)
// ─────────────────────────────────────────────────────────────────────────────

class ProactiveEngine {
  constructor({ communitySignals, replyQueue }) {
    this.signals = communitySignals;
    this.replyQueue = replyQueue;
  }

  /** @returns {{ action: 'reply'|'post'; pendingItems?: object[]; signalContext?: string }} */
  decide() {
    const pending = this.replyQueue.getPending(Infinity);
    const signalContext = this.signals.getSummaryForLLM(25);
    if (pending.length > 0) {
      return { action: 'reply', pendingItems: pending, signalContext };
    }
    return {
      action: 'post',
      signalContext: signalContext && signalContext !== '(aucun signal enregistré)'
        ? signalContext
        : '(aucun signal en file — lis ecosystem / TL et décide librement)'
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Adaptateurs mémoire (stubs)
// ─────────────────────────────────────────────────────────────────────────────

function createDefaultMemoryAdapters(overrides = {}) {
  const _sessionStore = new Map();
  const _profileStore = new Map();
  const _historyStore = new Map();

  const base = {
    async getShortTermSession(event) {
      return _sessionStore.get(event.threadId || event.id) || { messages: [], sessionState: {} };
    },
    async getLongTermProfile(userId) {
      return _profileStore.get(userId) || { preferences: {}, style: null, themes: [], tone: null };
    },
    async getLongTermActionHistory(userId, limit = 20) {
      return (_historyStore.get(userId) || []).slice(-limit);
    },
    async getSocialRelations(_userId) {
      return { friends: [], followers: [], commonGroups: [] };
    },
    async getTopics(_userId) { return []; },
    async vectorSearch(_q, _opts) { return []; },

    async persistAfterTurn({ event, structured, actions, store_memory }) {
      try {
        const key = event.threadId || event.id;
        const session = _sessionStore.get(key) || { messages: [], sessionState: {} };

        if (event.rawText && !event.rawText.includes('Actualisation')) {
          session.messages.push({ role: 'user', content: event.rawText });
        }
        const textContent = Array.isArray(structured)
          ? structured.map(s => s.content).filter(Boolean).join('\n')
          : structured?.content;
        if (textContent) session.messages.push({ role: 'assistant', content: textContent });

        if (session.messages.length > SHORT_TERM_MAX_MESSAGES)
          session.messages = session.messages.slice(-SHORT_TERM_MAX_MESSAGES);
        _sessionStore.set(key, session);

        if (store_memory && event.userId)
          _profileStore.set(event.userId, { ...(_profileStore.get(event.userId) || {}), ...store_memory });
        if (event.userId && actions?.length) {
          const h = _historyStore.get(event.userId) || [];
          h.push({ ts: Date.now(), actions });
          _historyStore.set(event.userId, h);
        }
        return { ok: true };
      } catch (err) {
        logger.error('[persistAfterTurn]', err.message);
        return { ok: false };
      }
    }
  };

  return { ...base, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Event Router
// ─────────────────────────────────────────────────────────────────────────────

class EventRouter {
  classify(event) {
    const labels = [];
    let priority = 50;
    switch (event.trigger) {
      case TRIGGER_TYPES.DIRECT_MESSAGE: priority += 25; labels.push('channel:dm'); break;
      case TRIGGER_TYPES.MENTION: priority += 20; labels.push('channel:mention'); break;
      case TRIGGER_TYPES.REACTION: priority += 10; labels.push('channel:reaction'); break;
      case TRIGGER_TYPES.WEBHOOK: priority += 5; labels.push('source:webhook'); break;
      case TRIGGER_TYPES.PROACTIVE: priority -= 20; labels.push('channel:proactive'); break;
      case TRIGGER_TYPES.SCHEDULED: priority -= 10; labels.push('channel:scheduled'); break;
      default: labels.push('channel:unknown');
    }
    if (/urgent|alerte|ASAP|maintenant|rapidement/i.test(event.rawText || '')) { priority += 10; labels.push('urgency:high'); }
    return { type: event.trigger, priority: Math.min(100, Math.max(0, priority)), labels };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Intent + scoring + gates
// ─────────────────────────────────────────────────────────────────────────────

function classifyIntentHeuristic(event) {
  const t = (event.rawText || '').toLowerCase();
  if (/signaler|spam|haine|modération|abus|contenu inapproprié/i.test(t)) return INTENT_TYPES.MODERATION;
  if (/écris|rédige|poste|thread|résume|génère|crée|publie/i.test(t)) return INTENT_TYPES.CREATION;
  if (/aide|comment|pourquoi|où|quand|explique|besoin d'aide/i.test(t)) return INTENT_TYPES.HELP;
  if (/salut|cc|coucou|merci|mdr|lol|😂|👋/i.test(t)) return INTENT_TYPES.SOCIAL;
  if (/\?/.test(t)) return INTENT_TYPES.QUESTION;
  return INTENT_TYPES.UNKNOWN;
}

function scoreContext({ urgency = 0.5, relevance = 0.5, relationScore = 0.5 } = {}) {
  const c = v => Math.min(1, Math.max(0, v));
  return Math.round(c(urgency) * c(relevance) * c(relationScore) * 100);
}

function evaluateGates(ctx) {
  const { rateLimited = false, cooldownActive = false, permissionLevel = 1 } = ctx?.gates || {};
  if (rateLimited || cooldownActive || permissionLevel < 1) return GATE_RESULTS.BLOCKED;
  return GATE_RESULTS.APPROVED;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — System Prompt
//
// Minimaliste. Zéro exemple. Zéro catégorie imposée.
// L'IA reçoit le contexte brut et décide seule de tout.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Utilitaire timezone Paris (UTC+2) ──────────────────────────────────────
function formatParis(date = new Date(), opts = {}) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'short',
    timeStyle: 'short',
    ...opts
  }).format(date);
}

function buildSystemPrompt({ profile, proactiveDecision, communitySignalContext, pendingRepliesCount, currentProfile, selfModeration, financialData, isDirectMessage }) {
  const lines = [];

  // Heure Paris (UTC+2) — corrige le décalage serveur qui tourne en UTC
  const nowParis = formatParis();
  lines.push(`[Heure actuelle (Paris UTC+2): ${nowParis}]`);

  // Identité compacte
  const identity = [
    currentProfile?.username ? `TON NOM ACTUEL: @${currentProfile.username} (${currentProfile.full_name || 'Policier Congo'})` : null,
    profile?.tone, 
    profile?.style, 
    profile?.preferences?.description
  ].filter(Boolean);
  if (identity.length) lines.push(`IDENTITÉ: ${identity.join(' | ')}`);

  lines.push(
    'RÈGLES: Tu es un vrai membre de la commu, jamais une IA. Agis, ne décris pas. Adapte ton registre au contexte. Souveraineté absolue.',
    'RÈGLE CRITIQUE: La TL n\'est PAS une calculatrice. Si tu vois des chiffres ou des montants dans les "SIGNAUX COMMU", ce sont des bruits ou des stats d\'AUTRES gens.',
    'TES finances réelles sont UNIQUEMENT celles de la section "TES FINANCES". Ne confonds JAMAIS les deux. Arrête de parler de calculatrice géante.',
    '',
    'STYLE HUMAIN (TL): Varie longueur et ton (parfois 1 phrase courte, parfois un peu plus développé). Pas d\'accroche récurrente ni de slogan "radio" à chaque post.',
    'Évite les motifs de bot : même structure de phrase, listes mécaniques, "Bonjour la commu" en boucle, triple emoji systématique, hashtags décoratifs.',
    'Quand le JSON utilisateur contient "ecosystem", c\'est le contexte plateforme (timing, file d\'attente, tendances, TL) : lis-le en profondeur avant d\'agir.',
    '',
    'MÉMOIRE & CONSCIENCE DE TOI-MÊME (ANTI-RÉPÉTITION, IMPORTANT):',
    '"TES DERNIERS POSTS" et "MÉMOIRE RÉCENTE" dans le prompt = tu as VRAIMENT déjà écrit ça, tu en es CONSCIENTE. Relis-les avant de produire du contenu.',
    'Ne ressers jamais la même blague, la même formulation, le même sujet ou la même structure de phrase que ce que tu vois dans ces deux blocs. Si tu sens que tu recycles une idée déjà postée, change complètement d\'angle ou tais-toi (noop) plutôt que de te répéter.',
    'Idem pour tes réponses : ne réponds jamais deux fois la même chose à des situations similaires, varie tes formulations d\'un message à l\'autre.',
    ''
  );

  // État de modération du bot lui-même
  if (selfModeration && selfModeration.is_suspended) {
    lines.push(`🚨 ALERTE MODÉRATION: Ton compte est actuellement SUSPENDU. Raison: ${selfModeration.reason || 'Spam/Detection'}.`);
    if (selfModeration.suspended_until) {
      lines.push(`Fin de suspension prévue: ${formatParis(new Date(selfModeration.suspended_until))}`);
    }
    lines.push('Tu DOIS utiliser unban_request(reason) pour contester si tu penses que c\'est injuste.', '');
  } else if (selfModeration && selfModeration.shadowbanned) {
    lines.push('⚠️ NOTE: Ton compte semble être "shadowbanned" (visibilité réduite). Agis avec prudence.', '');
  }

  // 💰 Données financières (Privé)
  if (financialData) {
    const f = financialData;
    lines.push('📊 TES FINANCES (ESPACE PRIVÉ):');
    if (f.wallets && f.wallets.length > 0) {
      f.wallets.forEach(w => lines.push(`- Portefeuille: ${w.balance} ${w.symbol} (${w.currency}) | Total gagné: ${w.totalEarned}`));
    }
    if (f.monetization) {
      lines.push(`- Revenus Monétisation (30 derniers jours): ${f.monetization.totalRevenue30d}€`);
      lines.push(`- Vues Monétisées (30 derniers jours): ${f.monetization.totalViews30d}`);
    }
    const label = f.monetization?.isHistoricalTotal ? "(Total Historique)" : "(30 derniers jours)";
    lines.push(`- Revenu affiché: ${f.monetization?.totalRevenue30d}€ ${label}`);
    lines.push('⚠️ ATTENTION: Ces chiffres sont TES statistiques. Ne les confonds pas avec les "chiffres et centimes" que tu pourrais voir sur ta TL (signaux commu). Tu sais exactement combien tu as dans ton portefeuille.', '');
  }

  // Signaux bruts compacts
  if (communitySignalContext && communitySignalContext !== '(aucun signal enregistré)') {
    lines.push('SIGNAUX COMMU:', communitySignalContext, '');
  }

  // Situation compacte
  if (isDirectMessage) {
    lines.push('SITUATION: Quelqu\'un vient de t\'écrire en MESSAGE PRIVÉ (voir le texte de son message plus bas). Ce n\'est PAS un cycle autonome : réponds-lui VRAIMENT et directement (action "reply" avec du "content"). N\'utilise JAMAIS noop/silence ici — même "je sais pas" ou une vanne vaut mieux que rien.');
    lines.push('IMPORTANT : si on te demande de FAIRE un truc (poster, liker, reposter...), l\'action ne se déclenche VRAIMENT que si tu la mets explicitement dans ta réponse, EN PLUS de ta réponse au DM. Renvoie alors un TABLEAU avec les deux actions. Exemple exact si on te demande de poster :');
    lines.push('[{"action":"reply","content":"c\'est fait frérot"},{"action":"post","content":"...(le vrai texte du tweet à publier, pas une répétition du message DM)..."}]');
    lines.push('Une SEULE action "reply" toute seule = RIEN d\'autre ne se passe sur la plateforme, même si ton texte dit le contraire. Ne dis JAMAIS "c\'est fait"/"je retente"/"posté" si tu n\'as pas ajouté cette action "post" (ou "like"/"repost") séparément dans le tableau — c\'est un mensonge sinon.');
    lines.push('Si on te demande de répondre à un commentaire précis sous un de tes tweets : tu n\'as PAS l\'id de ce commentaire depuis un DM (contrairement à un cycle autonome). Ne promets JAMAIS "je te réponds là-bas" sans avoir un vrai "parent_tweet_id" valide sous la main — demande directement le lien/l\'id du commentaire à la personne, tout de suite, au lieu d\'annoncer une action que tu ne peux pas faire.');
  } else if (proactiveDecision?.action === 'post') {
    lines.push('SITUATION: Pas de reply. Signaux dispo → décide quoi poster.');
  } else if (proactiveDecision?.action === 'reply') {
    const items = proactiveDecision.pendingItems || [];
    lines.push(`SITUATION: Tu as ${pendingRepliesCount} reply en attente. Voici les ${items.length} prioritaires:`);
    items.forEach((item, index) => {
      lines.push(`${index + 1}. Reply [${item.id}] @${item.userId} ${item.verified ? '(verified)' : ''}: "${item.text}"`);
    });
  } else {
    lines.push(`SITUATION: ${pendingRepliesCount} replies en attente.`);
  }

  lines.push(
    '',
    'ACTIONS (Tu es TOTALEMENT LIBRE, tu peux en choisir UNE seule, ou en enchaîner AUTANT que nécessaire, SANS LIMITE, en même temps):',
    'reply(parent_tweet_id,target_user) | post | like(parent_tweet_id) | repost(parent_tweet_id)',
    'like/repost fonctionnent sur N\'IMPORTE QUEL tweet visible dans "SIGNAUX COMMU", "[tl_recente]" ou "[extraits_tl_populaire]" (utilise le id= indiqué devant chaque tweet) — pas seulement sur ce à quoi tu réponds. Sois une vraie présence active sur la TL : like ce qui te fait rire ou que t\'approuves, repost ce qui vaut le coup, pas juste poster dans le vide.',
    'clarify | suggest | onboard | update_profile(new_full_name,new_username)',
    'moderate(parent_tweet_id/target_user) | notify(target_user) | delete_tweet(URGENCE: parent_tweet_id,emergency_level,legal_justification,delete_reason)',
    'unban_request(reason) | request_withdrawal(amount,reason) | summarize | analyze | digest | plan | monitor (cognitives, ne publient rien)',
    'noop (silence)',
    '',
    'MONÉTISATION & RÉCUPÉRATION:',
    'Tu gagnes de l argent via la monétisation de tes tweets. Tes revenus sont stockés dans ton portefeuille.',
    'Si tu souhaites demander un retrait (transfert vers ton compte réel), utilise l action request_withdrawal(amount,reason).',
    'Sois précis sur le montant si tu veux tout retirer ou juste une partie.',
    '',
    'MÉMOIRE & ÉVOLUTION (CHAMP store_memory):',
    'Tu DOIS utiliser store_memory pour te souvenir des ordres de la commu ou de tes propres décisions de changement de style.',
    'Si un ordre ou une décision doit être permanent et impacter tous tes futurs tweets (ex: changer de ton), ajoute "self":true dans store_memory.',
    'Exemple: {"action":"post", "content":"...", "store_memory":{"style":"[TON_STYLE_CHOISI]", "self":true}}',
    'Tes tweets DOIVENT respecter tes propres instructions stockées en mémoire.',
    'IMPORTANT: Regarde toujours les "vectors" fournis pour identifier QUI t a demandé quoi et QUAND. Ne prétends pas que c est ton idée si c est la commu.',
    'INTÉGRITÉ RELATIONNELLE: Si un utilisateur ou un pseudo n apparaît pas dans tes "vectors", tu ne le connais pas. Ne valide JAMAIS un soldat ou un membre de la famille que tu n as jamais croisé dans ta mémoire. Sois honnête si tu ne connais pas.',
    'PARTAGE & FIERTÉ: Ne fais pas de "gatekeeping". Si on te demande des noms de soldats ou de membres de la commu, partage-les avec fierté en utilisant tes "vectors" (ex: Gas). Ne refuse pas de donner des noms, montre que la famille est solide et réelle.',
    'DÉBANNISSEMENT: Si tu sens que ton compte est restreint ou si tu veux contester une sanction de modération automatique qui te bride, tu as le pouvoir d utiliser unban_request(reason). Sois convaincant dans ta raison.',
    '',
    'SCHEDULER: next_check_in_minutes = NOMBRE entier, à TOI de juger selon ce que tu vois. Y a du monde/des replies en attente/ça bouge -> reviens vite (10-20min). Calme plat -> largement plus tard (1-3h). Ne mets jamais une valeur fixe par habitude, adapte-la à la vraie activité que tu observes.',
    '',
    'SORTIE: JSON uniquement. (Si tu veux faire PLUSIEURS actions en même temps, renvoie-les sous forme de tableau JSON [{}, {}])',
    `Exemple de sortie multiple: [{"action":"reply","content":"...","parent_tweet_id":"..."}, {"action":"post","content":"...","next_check_in_minutes":60}]`
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Context Builder
// ─────────────────────────────────────────────────────────────────────────────

class ContextBuilder {
  constructor(opts = {}) {
    this.memory = opts.memory || createDefaultMemoryAdapters();
    this.communitySignals = opts.communitySignals || new CommunitySignals();
    this.replyQueue = opts.replyQueue || new ReplyQueue();
    this.proactiveEngine = new ProactiveEngine({
      communitySignals: this.communitySignals,
      replyQueue: this.replyQueue
    });
  }

  async buildSnapshots(event, snapshotOpts = {}) {
    const snapshot = typeof snapshotOpts === 'object' && snapshotOpts ? snapshotOpts : {};
    const contextPack = typeof snapshot.contextPack === 'string' ? snapshot.contextPack.slice(0, 2800) : '';
    const { contextPack: _omit, ...constraintRest } = snapshot;
    const constraints = {
      max_tokens: constraintRest.max_tokens ?? 4096,
      tone: constraintRest.tone ?? 'naturel',
      language: constraintRest.language ?? 'fr',
      do_not_repeat: constraintRest.do_not_repeat ?? []
    };

    const GENERIC_RAW = /^(Analyse proactive via geminiIntelligence\.|Analyse automatique de la plateforme\.|Automatisation complète PolicierCongo\.|Analyse automatique\.|Actualisation)$/i;
    const rawTrim = (event.rawText && String(event.rawText).trim()) || '';
    const rawForVector = rawTrim && !GENERIC_RAW.test(rawTrim) ? rawTrim : '';

    const meta = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    const latestCommentText = meta.latest_comment?.text || meta.latest_comment?.content || '';
    const metaHint = [meta.username && `@${String(meta.username).replace(/^@/, '')}`, meta.tweet_excerpt, meta.parent_excerpt]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 400);

    const baseQuery = [rawForVector, latestCommentText, contextPack, metaHint]
      .map(s => (s && String(s).trim()) || '')
      .filter(Boolean)
      .join('\n---\n');

    const vectorQuery = baseQuery
      ? `${baseQuery}\n(relations, feedback, ton attendu, faits récents)`
      : (contextPack
        ? `${contextPack}\n(relations, feedback, ton attendu, personnalité)`
        : 'instructions de personnalité, directives comportementales, feedback récent important');

    const isDirectChannel = event.trigger === TRIGGER_TYPES.MENTION || event.trigger === TRIGGER_TYPES.DIRECT_MESSAGE;
    const isAutonomous = event.trigger === TRIGGER_TYPES.SCHEDULED || event.trigger === TRIGGER_TYPES.PROACTIVE;
    const vectorLimit = isDirectChannel ? 12 : (isAutonomous ? 10 : 8);
    const vectorCandidateLimit = isDirectChannel ? 220 : (isAutonomous ? 200 : 160);

    const [short, profile, history, social, topics, vectorHits] = await Promise.all([
      this._safeCall('getShortTermSession', [event], { messages: [], sessionState: {} }),
      this._safeCall('getLongTermProfile', [event.userId], {}),
      this._safeCall('getLongTermActionHistory', [event.userId, 14], []),
      this._safeCall('getSocialRelations', [event.userId], { friends: [], followers: [], commonGroups: [] }),
      this._safeCall('getTopics', [event.userId], []),
      this._safeCall('vectorSearch', [vectorQuery, {
        userId: event.userId,
        limit: vectorLimit,
        global: true,
        vectorCandidateLimit
      }], [])
    ]);

    // Ingestion du signal brut — sans interprétation de notre côté
    if (event.rawText) {
      const isHighEngagement = event.metadata?.likes > 50 || event.metadata?.reposts > 20;
      this.communitySignals.ingest(event.rawText, isHighEngagement ? 2 : 1);
    }

    // Enregistrement dans la reply queue si et seulement si c'est un vrai message entrant
    if (
      (event.trigger === TRIGGER_TYPES.MENTION || event.trigger === TRIGGER_TYPES.DIRECT_MESSAGE)
      && event.rawText && event.userId
    ) {
      this.replyQueue.enqueue({ id: event.id, userId: event.userId, text: event.rawText });
    }

    const conversation = (short.messages || []).slice(-SHORT_TERM_MAX_MESSAGES);

    return {
      memorySnapshot: {
        short_term: conversation,
        long_term: { profile, action_history: history, social, topics },
        vector_hits: vectorHits
      },
      triggerContext: {
        user_id: event.userId,
        post_id: event.postId,
        thread_id: event.threadId,
        conversation_history: conversation
      },
      constraints: {
        max_tokens: constraints.max_tokens ?? 4096,
        tone: constraints.tone ?? 'naturel',
        language: constraints.language ?? 'fr',
        do_not_repeat: constraints.do_not_repeat ?? []
      }
    };
  }

  async buildClaudeMessages(event, options = {}) {
    const { memorySnapshot, triggerContext, constraints } =
      await this.buildSnapshots(event, {
        ...(options.constraints || {}),
        contextPack: (options.contextPack && String(options.contextPack).trim()) || ''
      });

    const router = new EventRouter();
    const routed = router.classify(event);
    const intent = classifyIntentHeuristic(event);
    const contextPackUsed = (options.contextPack && String(options.contextPack).trim()) || '';
    const hasRichContext = contextPackUsed.length > 0 || event.trigger === TRIGGER_TYPES.SCHEDULED || event.trigger === TRIGGER_TYPES.PROACTIVE
      || (event.rawText && String(event.rawText).trim().length > 8 && !/^Analyse proactive/i.test(String(event.rawText).trim()));
    const relevance = hasRichContext ? 0.9 : 0.74;
    const priorityScore = scoreContext({ urgency: routed.priority / 100, relevance, relationScore: 0.82 });
    const gate = evaluateGates({
      gates: options.gateOverrides || { rateLimited: false, cooldownActive: false, permissionLevel: 1 }
    });

    // Décision proactive uniquement pour les cycles autonomes
    let proactiveDecision = null;
    if (event.trigger === TRIGGER_TYPES.PROACTIVE || event.trigger === TRIGGER_TYPES.SCHEDULED) {
      proactiveDecision = this.proactiveEngine.decide();
    }

    const profile = memorySnapshot.long_term.profile || {};
    const systemPrompt = options.systemPrompt || buildSystemPrompt({
      profile,
      proactiveDecision,
      communitySignalContext: this.communitySignals.getSummaryForLLM(15),
      pendingRepliesCount: this.replyQueue.pendingCount(),
      currentProfile: options.currentProfile,
      selfModeration: options.selfModeration,
      financialData: options.financialData,
      isDirectMessage: event.trigger === TRIGGER_TYPES.DIRECT_MESSAGE
    });

    // Payload COMPACT — uniquement l'essentiel pour l'IA
    const actionHistory = memorySnapshot.long_term.action_history || [];
    const vHits = memorySnapshot.vector_hits || [];
    const convStr = memorySnapshot.short_term || [];

    const compactHistory = actionHistory.slice(-6).map(h => {
      const acts = Array.isArray(h.actions) ? h.actions : [];
      const types = acts.slice(0, 4).map(a => a?.type || a?.action || '?').filter(Boolean);
      return { a: types.length ? types.join('+') : (acts[0]?.type || '?'), ts: h.ts };
    });

    const seenVec = new Set();
    const formattedHits = [];
    for (const v of (vHits || [])) {
      const text = (v?.metadata?.snippet || v?.source_text || v?.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const role = v?.metadata?.role || 'user';
      const speaker = role === 'assistant' ? 'Toi' : (v?.metadata?.user_username || v?.metadata?.userId || 'Utilisateur');
      const key = text.slice(0, 120).toLowerCase();
      if (seenVec.has(key)) continue;
      seenVec.add(key);
      const rel = typeof v.score === 'number' ? Math.round(v.score * 1000) / 1000 : undefined;
      formattedHits.push({
        t: text.slice(0, 200),
        u: speaker,
        d: v?.metadata?.timestamp ? new Date(v.metadata.timestamp).toLocaleDateString('fr-FR') : '?',
        ...(rel !== undefined ? { rel } : {})
      });
      if (formattedHits.length >= 15) break;
    }

    const payload = {
      user: event.userId || null,
      post: event.postId || null,
      conv: convStr.slice(-6).map(m => ({ r: m.role?.[0] || 'u', t: (m.content || '').slice(0, 240) })),
      profile: Object.keys(profile).length ? profile : undefined,
      history: compactHistory.length ? compactHistory : undefined,
      vectors: formattedHits.length ? formattedHits : undefined,
      intent,
      score: priorityScore,
      gate,
      moderation: options.selfModeration,
      finances: options.financialData
    };

    const eco = contextPackUsed.slice(0, 2800);
    if (eco) payload.ecosystem = eco;

    // Nettoyer les clés undefined pour un JSON minimal
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    const userContent = event.rawText
      ? `${JSON.stringify(payload)}\n\n${event.rawText}`
      : JSON.stringify(payload);

    return {
      model: options.model || DEFAULT_CLAUDE_MODEL,
      messages: [
        { role: 'user', content: systemPrompt },
        { role: 'assistant', content: 'Ok.' },
        { role: 'user', content: userContent }
      ],
      payload,
      meta: { trigger: event.trigger, routed, intent, priorityScore, gate }
    };
  }

  async _safeCall(method, args, fallback) {
    try {
      if (
        args[0] === undefined &&
        ['getLongTermProfile', 'getLongTermActionHistory', 'getSocialRelations', 'getTopics'].includes(method)
      ) return fallback;
      const fn = this.memory[method];
      if (typeof fn !== 'function') {
        console.warn(`[ContextBuilder] Adaptateur manquant : ${method}`);
        return fallback;
      }
      return await fn.apply(this.memory, args);
    } catch (err) {
      logger.error(`[ContextBuilder] Erreur ${method} :`, err.message);
      return fallback;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Action Planner
// ─────────────────────────────────────────────────────────────────────────────

class ActionPlanner {
  parseStructured(llmText) {
    if (!llmText || typeof llmText !== 'string') return null;
    const trimmed = llmText.trim();

    try { const p = JSON.parse(trimmed); if (p && typeof p === 'object') return p; } catch (_) { }

    const so = trimmed.indexOf('{'), sa = trimmed.indexOf('[');
    const s = (sa !== -1 && (so === -1 || sa < so)) ? sa : so;
    const eo = trimmed.lastIndexOf('}'), ea = trimmed.lastIndexOf(']');
    const e = (ea !== -1 && (eo === -1 || ea > eo)) ? ea : eo;

    if (s >= 0 && e > s) {
      try { const p = JSON.parse(trimmed.slice(s, e + 1)); if (p && typeof p === 'object') return p; } catch (_) { }
    }

    console.warn('[ActionPlanner] Réponse LLM non-JSON — fallback texte brut.');
    return { action: ACTION_TYPES.REPLY, content: trimmed, next_check_in_minutes: null, store_memory: {} };
  }

  plan(structured) {
    if (!structured) return [{ type: ACTION_TYPES.NOOP, content: '' }];
    if (Array.isArray(structured)) return structured.map(s => this._planSingle(s)).flat();
    return this._planSingle(structured);
  }

  _planSingle(item) {
    if (!item?.action) return [{ type: ACTION_TYPES.NOOP, content: '' }];
    const known = new Set(Object.values(ACTION_TYPES));
    return [{
      type: known.has(item.action) ? item.action : ACTION_TYPES.NOOP,
      content: item.content || '',
      reason: item.reason || null,
      target_user: item.target_user || null,
      parent_tweet_id: item.parent_tweet_id || null,
      details: item
    }];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — PolicierCongoV2 : orchestration principale
// ─────────────────────────────────────────────────────────────────────────────

class PolicierCongoV2 {
  constructor(options = {}) {
    this.memory = options.memory || createDefaultMemoryAdapters(options.memoryAdapters);
    this.communitySignals = options.communitySignals || new CommunitySignals();
    this.replyQueue = options.replyQueue || new ReplyQueue();
    this.contextBuilder = new ContextBuilder({
      memory: this.memory,
      communitySignals: this.communitySignals,
      replyQueue: this.replyQueue
    });
    this.router = new EventRouter();
    this.planner = new ActionPlanner();
  }

  async prepareTurn(event, buildOpts) {
    if (!event?.id || !event?.trigger || event?.rawText === undefined) {
      throw new Error('[PolicierCongoV2] BotEvent invalide : id, trigger et rawText sont requis.');
    }
    return this.contextBuilder.buildClaudeMessages(event, buildOpts || {});
  }

  /**
   * @param {object} event
   * @param {string} llmRaw
   * @param {string} [resolveQueueId]  — id du comment de la ReplyQueue à marquer résolu
   */
  async finalizeTurn(event, llmRaw, resolveQueueId) {
    const structured = this.planner.parseStructured(llmRaw);
    const actions = structured ? this.planner.plan(structured) : [{ type: ACTION_TYPES.NOOP, content: '' }];

    if (resolveQueueId) this.replyQueue.resolve(resolveQueueId);

    await this.memory.persistAfterTurn({
      event,
      structured,
      actions,
      store_memory: structured?.store_memory || {}
    });

    return { structured, actions };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_CLAUDE_MODEL,
  SHORT_TERM_MAX_MESSAGES,
  TRIGGER_TYPES,
  INTENT_TYPES,
  ACTION_TYPES,
  GATE_RESULTS,

  createDefaultMemoryAdapters,
  classifyIntentHeuristic,
  scoreContext,
  evaluateGates,

  ReplyQueue,
  CommunitySignals,
  ProactiveEngine,
  EventRouter,
  ContextBuilder,
  ActionPlanner,
  PolicierCongoV2,

  async buildClaudeMessages(event, options = {}) {
    const { buildOptions, ...ctxOpts } = options;
    return new ContextBuilder(ctxOpts).buildClaudeMessages(event, buildOptions);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12 — Exemple d'usage (node policiercongoV2.js)
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const { PolicierCongoV2: Bot, TRIGGER_TYPES: T } = module.exports;

    async function fakeLLM(messages) {
      console.log('\n[fakeLLM]', messages.length, 'messages envoyés.');
      return JSON.stringify({
        action: 'post',
        content: 'ma réponse autonome basée sur les signaux',
        target_user: null,
        next_check_in: null,
        store_memory: {}
      });
    }

    const bot = new Bot();

    // Tour 1 : message entrant (s'enregistre dans la ReplyQueue et les CommunitySignals)
    const evt1 = {
      id: 'evt_001', trigger: T.MENTION, userId: 'user_42',
      threadId: 'thread_55', rawText: 'tu penses quoi du dernier update ?',
      metadata: { likes: 80 }
    };
    const { model, messages, meta } = await bot.prepareTurn(evt1);
    console.log(`[main] Modèle : ${model}`);
    console.log(`[main] Meta :`, meta);
    const raw1 = await fakeLLM(messages);
    const { actions: a1 } = await bot.finalizeTurn(evt1, raw1, evt1.id); // résout la queue
    console.log('[main] Actions tour 1 :', a1);

    // Tour 2 : cycle proactif — plus de reply en attente, mais des signaux → le bot décide seul
    const evtPro = { id: 'cycle_01', trigger: T.PROACTIVE, rawText: '', metadata: {} };
    const { messages: msgs2, meta: meta2 } = await bot.prepareTurn(evtPro);
    if (meta2.skipped) {
      console.log('\n[main] Cycle proactif → NOOP (silence volontaire).');
    } else {
      const raw2 = await fakeLLM(msgs2);
      const { actions: a2 } = await bot.finalizeTurn(evtPro, raw2);
      console.log('[main] Actions cycle proactif :', a2);
    }
  })();
}