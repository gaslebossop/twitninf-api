'use strict';

const { TOOL_RISK, SUSPENDED_ACCOUNT_TOOL_NAMES } = require('./constants');
const { withTimeout, stableStringify, hash, redact, mapWithConcurrency, clip } = require('./utils');
const { verifyDestructiveAction } = require('./crossModelVerification');
const { renderToolIndex, toolDetail } = require('./toolIndex');
const { manualFor } = require('./toolManual');

const SUSPENDED_ACCOUNT_TOOL_SET = new Set(SUSPENDED_ACCOUNT_TOOL_NAMES);

function normalizeEvent(value) {
  return value?.event || value || {};
}

function isSuspendedAccountMode(value) {
  return normalizeEvent(value).context?.policiercongoSuspended === true;
}

function isSuspendedAccountToolAllowed(toolName) {
  return SUSPENDED_ACCOUNT_TOOL_SET.has(toolName);
}

function validateSchema(schema = {}, value, path = 'args') {
  const errors = [];
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path} doit être un objet`];
    for (const required of schema.required || []) if (value[required] === undefined) errors.push(`${path}.${required} requis`);
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) errors.push(...validateSchema(child, value[key], `${path}.${key}`));
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} doit être un tableau`];
    if (schema.maxItems && value.length > schema.maxItems) errors.push(`${path}: maximum ${schema.maxItems} éléments`);
    value.forEach((item, i) => errors.push(...validateSchema(schema.items || {}, item, `${path}[${i}]`)));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') errors.push(`${path} doit être une chaîne`);
    else {
      if (schema.maxLength && value.length > schema.maxLength) errors.push(`${path}: maximum ${schema.maxLength} caractères`);
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: valeur invalide`);
      if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${path}: format invalide`);
    }
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) errors.push(`${path} doit être un nombre${schema.type === 'integer' ? ' entier' : ''}`);
    else {
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} doit être >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} doit être <= ${schema.maximum}`);
    }
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} doit être booléen`);
  return errors;
}

/**
 * Certains exécuteurs (ActionExecutor) n'échouent pas par exception : ils
 * renvoient `{ success: false, error }`. Sans cette détection, le runtime
 * annonçait `success: true` au modèle, qui déclarait alors publiquement avoir
 * effectué une action qui n'a jamais eu lieu.
 */
function extractHandlerFailure(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  if (output.success !== false && output.ok !== false) return null;
  const message = output.error || output.message || output.reason;
  return typeof message === 'string' && message.trim()
    ? message.trim()
    : "L'outil a signalé un échec sans message";
}

class ToolRegistry {
  constructor({ config, policy, memory, logger = console, providerRouter = null }) {
    this.config = config; this.policy = policy; this.memory = memory; this.logger = logger;
    this.providerRouter = providerRouter;
    this.tools = new Map(); this.idempotency = new Map();
    // runId → outils dont le modèle a demandé (ou dont il a besoin après une
    // erreur d'arguments) le schéma complet. Voir `expandedDetails`.
    this.expanded = new Map();
  }

  /**
   * Libère le cache d'idempotence d'un run terminé.
   * Les clés incluent le runId, donc elles ne sont jamais réutilisées : sans
   * purge, la Map croissait indéfiniment dans un processus de longue durée.
   */
  releaseRun(runId) {
    if (!runId) return;
    for (const key of this.idempotency.keys()) {
      if (key.startsWith(`${runId}|`)) this.idempotency.delete(key);
    }
    this.expanded.delete(runId);
  }

  register(definition) {
    if (!definition?.name || typeof definition.handler !== 'function') throw new Error('Définition outil invalide');
    if (this.tools.has(definition.name)) throw new Error(`Outil déjà enregistré: ${definition.name}`);
    this.tools.set(definition.name, { risk: TOOL_RISK.READ, inputSchema: { type: 'object', properties: {} }, ...definition });
    return this;
  }

  catalog(eventOrContext = null) {
    const tools = [...this.tools.values()];
    const visibleTools = isSuspendedAccountMode(eventOrContext)
      ? tools.filter(tool => isSuspendedAccountToolAllowed(tool.name))
      : tools;
    return visibleTools.map(({ handler, validate, ...publicDefinition }) => publicDefinition);
  }

  /**
   * Index compact envoyé dans le prompt : une ligne par outil (signature +
   * risque + description), tous outils visibles compris. Remplace l'envoi du
   * JSON Schema intégral de 84 outils, qui ne tenait plus dans son budget et
   * amputait silencieusement le catalogue. Voir toolIndex.js.
   */
  index(eventOrContext = null) {
    return renderToolIndex(this.catalog(eventOrContext), {
      descriptionMax: this.config?.toolIndexDescriptionChars || 0
    });
  }

  /**
   * Schéma complet + recettes d'usage des outils demandés. C'est le modèle qui
   * décide de ce dont il a besoin (outil `inspect_tools`) ; rien n'est décidé
   * à sa place.
   *
   * @param {string[]} names
   * @param {object|null} eventOrContext filtre de visibilité (compte suspendu)
   * @param {{withManual?: boolean}} options
   */
  describe(names, eventOrContext = null, { withManual = true } = {}) {
    const wanted = [...new Set((Array.isArray(names) ? names : [names]).map(name => String(name || '').trim()).filter(Boolean))];
    const visible = new Map(this.catalog(eventOrContext).map(tool => [tool.name, tool]));
    const found = [];
    const unknown = [];
    for (const name of wanted) {
      const tool = visible.get(name);
      if (!tool) { unknown.push(name); continue; }
      const detail = toolDetail(tool);
      if (withManual) {
        const manual = manualFor([name]);
        if (manual) detail.usage = manual;
      }
      found.push(detail);
    }
    return { tools: found, unknown };
  }

  /** Marque des outils comme « schéma complet à garder dans le contexte de ce run ». */
  markExpanded(runId, names) {
    if (!runId) return;
    const set = this.expanded.get(runId) || new Set();
    for (const name of (Array.isArray(names) ? names : [names])) {
      if (this.tools.has(name)) set.add(name);
    }
    this.expanded.set(runId, set);
  }

  /**
   * Schémas complets accumulés pendant le run, réinjectés à chaque prompt
   * plein : ce que le modèle a demandé une fois reste acquis pour la suite du
   * run, il n'a jamais à le redemander.
   */
  expandedDetails(runId, eventOrContext = null) {
    const set = this.expanded.get(runId);
    if (!set?.size) return [];
    return this.describe([...set], eventOrContext).tools;
  }

  async execute(call, context) {
    const tool = this.tools.get(call.name);
    if (!tool) {
      // Suggestion de proximité : un nom approché (pluriel oublié, préfixe
      // différent) coûtait sinon une itération entière à retrouver.
      // Seuil à 5 caractères, pas 4 : à 4, un préfixe générique partagé par
      // des dizaines d'outils (list_, get_, post_) faisait ressortir des
      // outils sans rapport (list_replies -> list_reports, list_community_
      // currencies, simplement parce que tous commencent par "list"). À 5,
      // "reply"/"search"/"tweets" restent des signaux réels tout en filtrant
      // ce bruit.
      const MIN_TOKEN_LENGTH = 5;
      const near = [...this.tools.keys()]
        .filter(name => name.includes(call.name) || call.name.includes(name)
          || name.split('_').some(part => part.length >= MIN_TOKEN_LENGTH && call.name.includes(part)))
        .slice(0, 5);
      return this.result(call, false, null,
        `Outil inconnu: ${call.name}.${near.length ? ` Outils proches: ${near.join(', ')}.` : ''} Le catalogue complet est dans available_tools ; inspect_tools en donne le schéma exact.`);
    }
    if (isSuspendedAccountMode(context?.event) && !isSuspendedAccountToolAllowed(call.name)) {
      return this.result(call, false, null,
        `Compte PolicierCongo suspendu: seul ${SUSPENDED_ACCOUNT_TOOL_NAMES.join(', ')} est autorise jusqu'a resolution du ban.`,
        { denied: true, suspended_account_mode: true });
    }
    const errors = [...validateSchema(tool.inputSchema, call.args || {})];
    if (tool.validate) errors.push(...(await tool.validate(call.args || {}, context) || []));
    if (errors.length) {
      // Le schéma complet part avec l'erreur et reste dans le contexte du run :
      // l'index compact suffit à la majorité des appels, et l'outil dont les
      // arguments ont raté est exactement celui dont le modèle a besoin de
      // voir le détail. Il se corrige donc au tour suivant sans rien demander.
      this.markExpanded(context?.runId, call.name);
      const detail = toolDetail(tool);
      const usage = manualFor([call.name]);
      return this.result(call, false, null, `Arguments invalides: ${errors.join('; ')}`, {
        expected_schema: detail.input_schema,
        ...(usage ? { usage: clip(usage, 4000) } : {})
      });
    }

    const authorization = this.policy.authorize(tool, context.event);
    if (!authorization.allowed) return this.result(call, false, null, authorization.reason, { denied: true });
    // Le runId reste en clair devant le hash pour que `releaseRun` puisse
    // purger toutes les entrées d'un run terminé.
    const key = `${context.runId}|${hash(`${call.name}|${stableStringify(call.args)}`)}`;
    if (tool.idempotent !== false && this.idempotency.has(key)) {
      return { ...this.idempotency.get(key), duplicate: true, call_id: call.id };
    }

    let crossVerification = null;
    if (tool.risk === TOOL_RISK.DESTRUCTIVE && this.config.crossVerificationEnabled !== false) {
      crossVerification = await this.verifyDestructive(tool, call, context);
      if (!crossVerification.approved) {
        const response = this.result(call, false, null,
          `Action destructive refusée par la vérification croisée (${crossVerification.verifier || 'second avis'}): ${crossVerification.reasoning || 'aucune justification suffisante'}`,
          { cross_verification: crossVerification });
        await this.audit(tool, call, context, response, 'blocked', 0);
        context.onEvent?.({ type: 'tool.failed', callId: call.id, tool: call.name, error: response.error, crossVerification });
        return response;
      }
    }

    if (this.config.dryRun && tool.risk !== TOOL_RISK.READ) {
      return this.result(call, true, { simulated: true, args: redact(call.args) }, null,
        { simulated: true, ...(crossVerification ? { cross_verification: crossVerification } : {}) });
    }

    const started = Date.now();
    let output;
    try {
      context.onEvent?.({ type: 'tool.started', callId: call.id, tool: call.name });
      output = await withTimeout(() => tool.handler(call.args || {}, context), tool.timeoutMs || this.config.toolTimeoutMs, call.name, context.signal);

      const handlerFailure = extractHandlerFailure(output);
      if (handlerFailure) {
        const response = this.result(call, false, output, handlerFailure);
        await this.audit(tool, call, context, response, 'failed', Date.now() - started);
        context.onEvent?.({ type: 'tool.failed', callId: call.id, tool: call.name, error: handlerFailure });
        return response;
      }

      const response = this.result(call, true, output, null, crossVerification ? { cross_verification: crossVerification } : {});
      // Seuls les succès sont mémoïsés : rejouer un appel qui a échoué peut
      // réussir au tour suivant (verrou levé, cible créée, réseau rétabli).
      if (tool.idempotent !== false) this.idempotency.set(key, response);
      await this.audit(tool, call, context, response, 'success', Date.now() - started);
      context.onEvent?.({ type: 'tool.completed', callId: call.id, tool: call.name, durationMs: Date.now() - started });
      return response;
    } catch (error) {
      const response = this.result(call, false, null, error.message);
      await this.audit(tool, call, context, response, 'failed', Date.now() - started);
      context.onEvent?.({ type: 'tool.failed', callId: call.id, tool: call.name, error: error.message });
      return response;
    }
  }

  /**
   * Demande un second avis à L'AUTRE modèle avant une action destructrice.
   *
   * Fail-closed : sans providerRouter, sans provider primaire identifiable,
   * ou en cas d'erreur/timeout du second modèle, l'action est refusée. Une
   * destruction non vérifiable ne s'exécute jamais par défaut — voir
   * crossModelVerification.js pour le détail du contrat fail-closed.
   */
  async verifyDestructive(tool, call, context) {
    if (!this.providerRouter) {
      return { approved: false, reasoning: 'Aucun provider disponible pour la vérification croisée (providerRouter non configuré).', verifier: null };
    }
    return verifyDestructiveAction({
      providerRouter: this.providerRouter,
      primaryProvider: context.provider,
      tool, call, event: context.event,
      decisionSummary: context.decisionSummary,
      signal: context.signal
    }, this.config);
  }

  /**
   * Lectures en parallèle, écritures en série dans l'ordre demandé.
   *
   * Les résultats sont indexés par position et non par `call.id` : les modèles
   * réutilisent régulièrement le même identifiant (`t1`) dans un même lot, ce
   * qui faisait s'écraser deux résultats et renvoyait deux fois le même.
   */
  async executeBatch(calls, context) {
    const capped = calls.slice(0, Math.max(0, context.remainingToolCalls));
    const results = new Array(capped.length);
    const reads = [];
    const writes = [];
    capped.forEach((call, index) => {
      const entry = { call, index };
      if (this.tools.get(call.name)?.risk === TOOL_RISK.READ) reads.push(entry);
      else writes.push(entry);
    });

    const readResults = await mapWithConcurrency(reads, this.config.maxParallelReads, entry => this.execute(entry.call, context));
    reads.forEach((entry, i) => { results[entry.index] = readResults[i]; });
    for (const entry of writes) results[entry.index] = await this.execute(entry.call, context);
    return results;
  }

  result(call, success, data, error = null, extra = {}) {
    return { call_id: call.id, tool: call.name, success, data: data === undefined ? null : data, error, ...extra };
  }

  async audit(tool, call, context, response, status, durationMs) {
    const cleanResponse = redact(response);
    const serialized = JSON.stringify(cleanResponse);
    const auditResult = serialized.length <= 20000
      ? cleanResponse
      : { truncated: true, original_chars: serialized.length, preview: clip(serialized, 19500) };
    await this.memory.auditTool({ runId: context.runId, threadId: context.event.threadId, toolName: tool.name,
      risk: tool.risk, args: redact(call.args), result: auditResult, status, durationMs }).catch(error => {
      this.logger.warn?.(`[pc3.audit] ${error.message}`);
    });
  }
}

module.exports = { ToolRegistry, validateSchema, isSuspendedAccountMode, isSuspendedAccountToolAllowed };
