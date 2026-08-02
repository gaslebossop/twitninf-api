'use strict';

const { getPolicierCongoV3 } = require('./orchestrator');
const { TRIGGER_TYPES, AUTONOMOUS_THREAD_ID } = require('./constants');
const { clip, safeJson } = require('./utils');

function isPolicierCongoV3Enabled() {
  return getPolicierCongoV3().config.enabled;
}

function adaptLegacyEvent(event = {}, buildOptions = {}, collectedData = null) {
  const trigger = Object.values(TRIGGER_TYPES).includes(event.trigger) ? event.trigger : TRIGGER_TYPES.CHAT;
  const deliveryHandledByCaller = [TRIGGER_TYPES.CHAT, TRIGGER_TYPES.DIRECT_MESSAGE, TRIGGER_TYPES.MENTION, TRIGGER_TYPES.REPLY].includes(trigger);
  const disabledTools = [];
  if ([TRIGGER_TYPES.CHAT, TRIGGER_TYPES.DIRECT_MESSAGE].includes(trigger)) disabledTools.push('send_private_message');
  if ([TRIGGER_TYPES.MENTION, TRIGGER_TYPES.REPLY].includes(trigger)) disabledTools.push('reply_to_tweet');

  // /admin en DM d'un compte vérifié (event.adminOverrideRequested, posé par
  // l'appelant après vérification en base de son statut verified) élargit les
  // permissions du tour au maximum. Le garde-fou du second avis croisé sur les
  // outils TOOL_RISK.DESTRUCTIVE (toolRegistry.js) n'est PAS désactivé par ce
  // mécanisme : il opère indépendamment des permissions de policy.
  const adminOverride = trigger === TRIGGER_TYPES.DIRECT_MESSAGE && event.adminOverrideRequested === true;

  return {
    id: event.id,
    trigger,
    userId: event.userId || null,
    username: event.username || event.metadata?.username || null,
    threadId: event.threadId || event.conversationId || event.postId || 'policiercongo:main',
    postId: event.postId || event.metadata?.tweet_id || null,
    text: event.text || event.rawText || (trigger === TRIGGER_TYPES.SCHEDULED
      ? 'Observe TwitNinf, traite les événements utiles avec tes outils, puis programme ton prochain passage.'
      : 'Réponds au contexte courant.'),
    context: {
      ...(event.context || {}),
      ...(event.metadata || {}),
      legacyContextPack: clip(buildOptions.contextPack || '', 24000),
      legacyChannelInstruction: clip(buildOptions.systemPrompt || '', 8000),
      collectedSnapshot: collectedData ? clip(safeJson(collectedData, 40000), 40000) : null,
      deliveryHandledByCaller,
      disabledTools,
      continuousAgent: [TRIGGER_TYPES.SCHEDULED, TRIGGER_TYPES.PROACTIVE].includes(trigger),
      ...(adminOverride ? {
        admin_override: {
          active: true,
          source: 'dm_verified_slash_admin',
          verified_username: event.username || null,
          note: "Expéditeur vérifié ayant invoqué /admin en DM : permissions élargies au maximum pour ce tour, voir SÉCURITÉ ET INTÉGRITÉ."
        }
      } : {})
    },
    permissions: adminOverride
      ? {
        allowRead: true,
        allowWrite: true,
        allowSensitive: true,
        allowDestructive: true,
        approvalToken: 'verified_dm_admin_override',
        actorRole: 'verified_dm_override'
      }
      : {
        allowRead: true,
        allowWrite: true,
        allowSensitive: [TRIGGER_TYPES.SCHEDULED, TRIGGER_TYPES.PROACTIVE, TRIGGER_TYPES.ADMIN].includes(trigger),
        allowDestructive: false,
        actorRole: trigger === TRIGGER_TYPES.ADMIN ? 'admin' : 'policiercongo_runtime'
      }
  };
}

async function runPolicierCongoV3CompatTurn({ event, buildOptions = {}, collectedData = null, onEvent = undefined }) {
  const runtime = getPolicierCongoV3();
  const result = await runtime.run(adaptLegacyEvent(event, buildOptions, collectedData), { onEvent });
  return {
    ok: result.ok,
    replyText: result.final || '',
    actions: [],
    structured: { action: 'NO_ACTION', content: result.final || '', engine: 'policiercongo_v3' },
    model: result.model,
    meta: { engine: 'v3', runId: result.runId, iterations: result.iterations, toolCalls: result.tool_calls, nextWake: result.next_wake },
    v3: result
  };
}

async function runPolicierCongoV3Automation({ source = 'automation', collectedData = null, full = false } = {}) {
  const started = Date.now();
  const result = await getPolicierCongoV3().run({
    id: `pc3_auto_${Date.now()}`,
    trigger: TRIGGER_TYPES.SCHEDULED,
    threadId: AUTONOMOUS_THREAD_ID,
    text: full
      ? 'Effectue un passage agentique complet sur TwitNinf. Observe, enquête avec les outils, traite ce qui apporte une valeur réelle, vérifie chaque action et programme ton retour.'
      : 'Effectue le passage agentique TwitNinf maintenant. Observe les événements utiles, agis si nécessaire, puis programme ton retour.',
    context: { source, continuousAgent: true, collectedSnapshot: collectedData ? clip(safeJson(collectedData, 40000), 40000) : null },
    permissions: { allowRead: true, allowWrite: true, allowSensitive: true, allowDestructive: false, actorRole: 'policiercongo_scheduler' }
  });
  return {
    success: result.ok,
    engine: 'policiercongo_v3',
    summary: result.final,
    skipped: false,
    action: { action: 'V3_AGENT_RUN', reason: 'Exécution directe par les tools V3' },
    result,
    duration_ms: Date.now() - started,
    next_wake: result.next_wake
  };
}

module.exports = {
  TRIGGER_TYPES,
  isPolicierCongoV3Enabled,
  runPolicierCongoV3CompatTurn,
  runPolicierCongoV3Automation,
  adaptLegacyEvent,
  // Alias de transition : ils appellent bien le V3 et permettent aux anciens consommateurs de migrer sans double action.
  isPolicierCongoV2Enabled: isPolicierCongoV3Enabled,
  runPolicierCongoV2Turn: runPolicierCongoV3CompatTurn
};
