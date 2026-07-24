'use strict';

const VERSION = '3.0.0';

/**
 * Thread réservé à la veille autonome de l'agent principal (scheduler
 * persistant, réveil bootstrap). Un trigger conversationnel (chat, DM,
 * mention, reply) ne doit jamais écrire dans ce thread : voir le garde-fou
 * dans agentLoop.js qui isole toute tentative en ce sens, pour que le
 * prochain réveil déjà programmé de l'agent principal ne soit jamais
 * affecté par le traitement d'un message.
 */
const AUTONOMOUS_THREAD_ID = 'policiercongo:autonomous';

const TRIGGER_TYPES = Object.freeze({
  CHAT: 'chat',
  DIRECT_MESSAGE: 'direct_message',
  MENTION: 'mention',
  REPLY: 'reply',
  SCHEDULED: 'scheduled',
  PROACTIVE: 'proactive',
  ADMIN: 'admin',
  WEBHOOK: 'webhook'
});

const RUN_STATES = Object.freeze({
  CONTINUE: 'continue',
  COMPLETE: 'complete',
  BLOCKED: 'blocked'
});

const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

const TOOL_RISK = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  SENSITIVE: 'sensitive',
  DESTRUCTIVE: 'destructive'
});

const SUSPENDED_ACCOUNT_TOOL_NAMES = Object.freeze([
  'check_ban_status',
  'appeal_ban',
  'check_appeal_response'
]);

const MEMORY_KINDS = Object.freeze({
  FACT: 'fact',
  PREFERENCE: 'preference',
  RELATIONSHIP: 'relationship',
  COMMITMENT: 'commitment',
  EPISODE: 'episode',
  PROCEDURE: 'procedure',
  SELF: 'self',
  CORRECTION: 'correction'
});

/**
 * Cycle de vie d'un souvenir. Seul `active` est rappelé : un souvenir corrigé
 * devient `superseded` et un souvenir explicitement oublié `forgotten`, sans
 * jamais être supprimé, pour garder la trace auditable.
 */
const MEMORY_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  FORGOTTEN: 'forgotten'
});

const MEMORY_SCOPES = Object.freeze({
  USER: 'user',
  THREAD: 'thread',
  GLOBAL: 'global',
  SELF: 'self'
});

const EVENT_NAMES = Object.freeze({
  RUN_STARTED: 'run.started',
  CONTEXT_READY: 'context.ready',
  MODEL_STARTED: 'model.started',
  MODEL_COMPLETED: 'model.completed',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_FAILED: 'tool.failed',
  CHECKPOINT: 'checkpoint',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed'
});

module.exports = {
  VERSION,
  AUTONOMOUS_THREAD_ID,
  TRIGGER_TYPES,
  RUN_STATES,
  RUN_STATUS,
  TOOL_RISK,
  SUSPENDED_ACCOUNT_TOOL_NAMES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUS,
  EVENT_NAMES
};
