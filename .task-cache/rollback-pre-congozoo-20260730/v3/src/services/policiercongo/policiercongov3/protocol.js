'use strict';

const { RUN_STATES, MEMORY_KINDS, MEMORY_SCOPES, TRIGGER_TYPES } = require('./constants');
const { clip, newId, normalizeWhitespace } = require('./utils');

function normalizeEvent(input = {}) {
  const trigger = Object.values(TRIGGER_TYPES).includes(input.trigger) ? input.trigger : TRIGGER_TYPES.CHAT;
  const text = String(input.text ?? input.rawText ?? input.message ?? '').trim();
  const userId = input.userId ? String(input.userId) : null;
  const threadId = String(input.threadId || input.conversationId || input.postId || `${trigger}:${userId || 'anonymous'}`);
  return {
    id: String(input.id || newId('evt')),
    trigger,
    userId,
    username: input.username ? String(input.username).replace(/^@/, '') : null,
    threadId,
    postId: input.postId ? String(input.postId) : null,
    text,
    context: input.context && typeof input.context === 'object' ? input.context : {},
    permissions: normalizePermissions(input.permissions),
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function normalizePermissions(value = {}) {
  return {
    allowRead: value.allowRead !== false,
    allowWrite: value.allowWrite === true,
    allowSensitive: value.allowSensitive === true,
    allowDestructive: value.allowDestructive === true,
    approvalToken: value.approvalToken ? String(value.approvalToken) : null,
    actorRole: value.actorRole || 'user'
  };
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(raw); } catch (_) { /* continue */ }

  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{' && raw[start] !== '[') continue;
    const open = raw[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === open) depth += 1;
      if (char === close) depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, index + 1)); } catch (_) { break; }
      }
    }
  }
  throw new Error('Réponse modèle non JSON');
}

function parseAgentEnvelope(text) {
  const parsed = extractJson(text);
  const source = Array.isArray(parsed)
    ? { state: RUN_STATES.CONTINUE, tool_calls: parsed }
    : parsed;
  if (!source || typeof source !== 'object') throw new Error('Envelope agent invalide');

  const state = Object.values(RUN_STATES).includes(source.state) ? source.state : inferState(source);
  const toolCalls = dedupeCallIds(
    Array.isArray(source.tool_calls) ? source.tool_calls.slice(0, 100).map(normalizeToolCall).filter(Boolean) : []
  );
  const memoryWrites = Array.isArray(source.memory_writes)
    ? source.memory_writes.slice(0, 40).map(normalizeMemoryWrite).filter(Boolean)
    : [];
  const final = typeof source.final === 'string' ? source.final.trim() : '';

  return {
    state,
    final,
    decision_summary: clip(normalizeWhitespace(source.decision_summary || source.plan_summary || ''), 1000),
    tool_calls: toolCalls,
    memory_writes: memoryWrites,
    thread_summary: clip(normalizeWhitespace(source.thread_summary || ''), 3000),
    next_check_in_minutes: normalizeNextCheck(source.next_check_in_minutes),
    blocked_reason: clip(normalizeWhitespace(source.blocked_reason || ''), 1000)
  };
}

function inferState(source) {
  if (source.blocked_reason) return RUN_STATES.BLOCKED;
  if (source.final && !(source.tool_calls || []).length) return RUN_STATES.COMPLETE;
  return RUN_STATES.CONTINUE;
}

function normalizeToolCall(call, index) {
  if (!call || typeof call !== 'object' || !call.name) return null;
  return {
    id: String(call.id || `tool_${index + 1}`),
    name: String(call.name).trim(),
    args: call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {},
    purpose: clip(normalizeWhitespace(call.purpose || call.reason || ''), 500)
  };
}

/** `supersedes` accepte un id seul ou une liste ; toujours normalisé en liste. */
function normalizeSupersedes(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * Garantit un id unique par appel dans un même lot.
 * Les modèles réutilisent souvent `t1` pour plusieurs appels ; les résultats
 * étaient alors indistinguables côté observations.
 */
function dedupeCallIds(calls) {
  const seen = new Set();
  return calls.map((call, index) => {
    let id = call.id;
    if (!id || seen.has(id)) id = `${call.id || 'tool'}_${index + 1}`;
    while (seen.has(id)) id = `${id}_b`;
    seen.add(id);
    return id === call.id ? call : { ...call, id };
  });
}

function normalizeMemoryWrite(item) {
  if (!item || typeof item !== 'object') return null;
  const content = normalizeWhitespace(item.content);
  if (!content) return null;
  const kind = Object.values(MEMORY_KINDS).includes(item.kind) ? item.kind : MEMORY_KINDS.FACT;
  const scope = Object.values(MEMORY_SCOPES).includes(item.scope) ? item.scope : MEMORY_SCOPES.USER;
  const entity = item.entity || item.entity_key;
  return {
    kind,
    scope,
    subject_id: item.subject_id ? String(item.subject_id) : null,
    entity: entity ? String(entity).replace(/^@/, '').slice(0, 64) : null,
    supersedes: normalizeSupersedes(item.supersedes),
    content: clip(content, 4000),
    // Une correction est par nature importante : un modèle qui la note à 0.3
    // la ferait passer sous le seuil d'écriture et l'erreur corrigée
    // resurgirait au tour suivant.
    importance: kind === MEMORY_KINDS.CORRECTION
      ? Math.max(0.75, Math.min(1, Number(item.importance ?? 0.85)))
      : Math.max(0, Math.min(1, Number(item.importance ?? 0.5))),
    confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.75))),
    tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 12) : [],
    pinned: item.pinned === true,
    expires_at: item.expires_at || null,
    source: clip(normalizeWhitespace(item.source || ''), 300)
  };
}

function normalizeNextCheck(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(10080, Math.round(number))) : null;
}

function validateCompletion(envelope, event) {
  if (envelope.state !== RUN_STATES.COMPLETE) return null;
  if ([TRIGGER_TYPES.CHAT, TRIGGER_TYPES.DIRECT_MESSAGE, TRIGGER_TYPES.MENTION, TRIGGER_TYPES.REPLY].includes(event.trigger) && !envelope.final) {
    return 'Une interaction directe doit se terminer par une réponse visible non vide.';
  }
  if (envelope.tool_calls.length) return 'state=complete ne peut pas contenir de tool_calls.';
  return null;
}

module.exports = {
  normalizeEvent,
  normalizePermissions,
  extractJson,
  parseAgentEnvelope,
  validateCompletion
};
