'use strict';

const { RUN_STATES, RUN_STATUS, TRIGGER_TYPES, AUTONOMOUS_THREAD_ID } = require('./constants');
const { normalizeEvent, parseAgentEnvelope, validateCompletion } = require('./protocol');
const { buildRepairPrompt, buildDeltaPrompt, buildRepairDeltaPrompt, buildEmergencyCompletionPrompt } = require('./prompts');
const { KeyedLock, newId, hash, stableStringify, clip } = require('./utils');

/** Déclencheurs où l'agent agit de lui-même, sans humain en face. */
const AUTONOMOUS_TRIGGERS = [TRIGGER_TYPES.SCHEDULED, TRIGGER_TYPES.PROACTIVE];

/** Déclencheurs correspondant à une vraie conversation avec quelqu'un. */
const CONVERSATIONAL_TRIGGERS = [
  TRIGGER_TYPES.CHAT, TRIGGER_TYPES.DIRECT_MESSAGE, TRIGGER_TYPES.MENTION, TRIGGER_TYPES.REPLY
];

function formatParis(date) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(date);
}

class AgentLoop {
  constructor({ config, provider, memory, tools, contextEngine, logger = console }) {
    this.config = config; this.provider = provider; this.memory = memory; this.tools = tools;
    this.contextEngine = contextEngine; this.logger = logger; this.lock = new KeyedLock();
  }

  async run(input, options = {}) {
    const event = normalizeEvent(input);
    return this.lock.run(event.threadId, () => this._run(event, options));
  }

  /**
   * Génère un tour en réutilisant la session active du provider primaire si
   * possible (delta seul envoyé, ex. `codex exec resume`), sinon reconstruit
   * le prompt complet. `buildFull` n'est appelée QUE si la reprise échoue ou
   * n'est pas disponible — pas de gaspillage à construire le prompt complet
   * pour rien quand la session marche.
   *
   * @returns {Promise<{result, session}>} `session` est la session à utiliser
   *   pour le PROCHAIN appel (peut être `null` si non disponible/abandonnée).
   */
  async _generateTurn({ session, buildDelta, buildFull, signal }) {
    if (this.config.sessionReuseEnabled && session && this.provider.supportsSessions(session.providerName)) {
      try {
        const result = await this.provider.resumeWith(session.providerName, session.sessionId, buildDelta(), { signal });
        return { result, session: this._trackSession(result) };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        // La session peut avoir expiré ou été purgée côté CLI : on abandonne
        // proprement et on repart sur un prompt complet, jamais une erreur
        // de run pour une simple perte de session.
        this.logger.warn?.(`[pc3] reprise de session ${session.providerName} échouée (${error.message}), reconstruction complète du prompt pour ce tour.`);
      }
    }
    const result = await this.provider.generate(buildFull(), { signal });
    return { result, session: this._trackSession(result) };
  }

  _trackSession(result) {
    if (this.config.sessionReuseEnabled && result.sessionId && this.provider.supportsSessions(result.provider)) {
      return { providerName: result.provider, sessionId: result.sessionId };
    }
    return null;
  }

  async _run(event, { signal, onEvent = () => {} } = {}) {
    const runId = newId('run');
    const isAutonomous = AUTONOMOUS_TRIGGERS.includes(event.trigger);
    const isConversational = CONVERSATIONAL_TRIGGERS.includes(event.trigger);

    // Le thread AUTONOMOUS_THREAD_ID porte le réveil persistant de l'agent
    // principal. Un message (chat/DM/mention/reply) ne doit jamais pouvoir
    // écrire dedans : sans cette isolation, traiter ce message pourrait
    // superséder — donc changer — l'heure de réveil déjà programmée pour la
    // veille autonome, pour une raison qui n'a rien à voir avec elle. Ça ne
    // devrait jamais arriver avec les appelants actuels (leur threadId par
    // défaut diffère toujours), mais la garantie est tenue ici plutôt que par
    // convention chez chaque appelant.
    if (!isAutonomous && event.threadId === AUTONOMOUS_THREAD_ID) {
      this.logger.warn?.(`[pc3] Thread "${AUTONOMOUS_THREAD_ID}" réservé à la veille autonome, reçu depuis un trigger "${event.trigger}" — isolé pour ne jamais affecter le prochain réveil de l'agent principal.`);
      event.threadId = `${AUTONOMOUS_THREAD_ID}:external:${event.id}`;
    }

    let iterations = 0, toolCallsUsed = 0, lastProvider = null, lastModel = null, scheduledWake = null;
    let thread = null;
    const observations = [], memoryWrites = [], batchHistory = new Map();
    let protocolFailures = 0;
    // Session du provider primaire, réutilisée d'une itération à l'autre pour
    // n'envoyer que le delta (voir _generateTurn). `observationsSent` marque
    // jusqu'où le modèle a déjà vu `observations` — full prompt ou delta,
    // peu importe l'un des deux couvre toujours tout depuis ce curseur.
    let session = null;
    let observationsSent = 0;

    const emit = payload => { try { onEvent({ runId, at: new Date().toISOString(), ...payload }); } catch (_) {} };

    const scheduleWake = async (minutes, reason) => {
      const safeMinutes = Math.max(this.config.minWakeMinutes, Math.min(this.config.maxWakeMinutes, Number(minutes) || this.config.defaultWakeMinutes));
      const runAfter = new Date(Date.now() + safeMinutes * 60000);
      scheduledWake = await this.memory.scheduleWake({
        threadId: event.threadId, userId: event.userId, runAfter: runAfter.toISOString(), reason,
        event: {
          trigger: TRIGGER_TYPES.SCHEDULED, userId: event.userId, username: event.username, threadId: event.threadId,
          text: `Reprise agentique planifiée: ${reason}`,
          context: { ...event.context, resumedFromRunId: runId, continuousAgent: true },
          permissions: event.permissions
        }
      });
      return { ...scheduledWake, minutes: safeMinutes, local_time: formatParis(runAfter) };
    };

    /**
     * Programme plusieurs passages en un seul appel (ex: 3 réveils espacés
     * dans la journée) au lieu de rappeler `schedule_next_wake` un par un —
     * chaque appel individuel écraserait le précédent puisque le modèle de
     * données ne garde qu'un réveil "pending" par thread à la fois.
     * Chaque entrée accepte soit `minutes` (délai depuis maintenant), soit
     * `run_at` (horodatage ISO absolu).
     */
    const scheduleWakes = async (items) => {
      const now = Date.now();
      const planned = items.map(item => {
        const runAfter = item.run_at
          ? new Date(item.run_at)
          : new Date(now + Math.max(this.config.minWakeMinutes, Math.min(this.config.maxWakeMinutes, Number(item.minutes) || this.config.defaultWakeMinutes)) * 60000);
        return {
          runAfter,
          reason: item.reason,
          event: {
            trigger: TRIGGER_TYPES.SCHEDULED, userId: event.userId, username: event.username, threadId: event.threadId,
            text: `Reprise agentique planifiée: ${item.reason}`,
            context: { ...event.context, resumedFromRunId: runId, continuousAgent: true },
            permissions: event.permissions
          }
        };
      }).sort((a, b) => a.runAfter - b.runAfter);

      const results = await this.memory.scheduleWakes(
        event.threadId, event.userId,
        planned.map(p => ({ runAfter: p.runAfter.toISOString(), reason: p.reason, event: p.event }))
      );

      // Le premier réveil du lot fait foi pour la reprogrammation automatique
      // de fin de run (évite qu'elle superspose le lot qu'on vient de poser).
      if (results[0]) scheduledWake = { wakeId: results[0].wakeId, runAfter: results[0].runAfter };

      return results.map((r, i) => ({ ...r, reason: planned[i].reason, local_time: formatParis(new Date(r.runAfter)) }));
    };

    /**
     * Persiste les souvenirs accumulés jusqu'ici et vide la file.
     *
     * Appelé après chaque itération productive et sur le chemin d'erreur :
     * l'ancienne version n'écrivait qu'à la toute fin, donc un run qui plantait
     * perdait tout ce que l'agent avait appris pendant le tour.
     */
    const flushMemories = async () => {
      if (!memoryWrites.length) return;
      const batch = memoryWrites.splice(0, memoryWrites.length);
      await this.memory.writeMemories(batch, {
        userId: event.userId, threadId: event.threadId, source: `run:${runId}`
      }).catch(error => this.logger.warn?.(`[pc3] mémoire non écrite: ${error.message}`));
    };

    await this.memory.recordRunStart({ runId, threadId: event.threadId, userId: event.userId, trigger: event.trigger, metadata: { eventId: event.id } });
    emit({ type: 'run.started', trigger: event.trigger });

    try {
      const prepared = await this.contextEngine.prepare(event);
      thread = prepared.thread;
      const { memories, episodes } = prepared;
      emit({ type: 'context.ready', recalledMemories: memories.length, recentMessages: thread.messages.length, episodes: episodes.length });

      let finalEnvelope = null;
      for (iterations = 1; iterations <= this.config.maxIterations; iterations += 1) {
        if (signal?.aborted) throw Object.assign(new Error('Run annulé'), { name: 'AbortError' });

        const budgets = () => ({
          max_iterations: this.config.maxIterations, iterations_left: this.config.maxIterations - iterations + 1,
          max_tool_calls: this.config.maxToolCalls, tool_calls_left: this.config.maxToolCalls - toolCallsUsed
        });
        emit({ type: 'model.started', iteration: iterations });
        const { result: modelResult, session: sessionAfterTurn } = await this._generateTurn({
          session,
          buildDelta: () => buildDeltaPrompt({ newObservations: observations.slice(observationsSent), iteration: iterations, budgets: budgets() }),
          buildFull: () => this.contextEngine.build({
            event, thread, memories, episodes, observations,
            iteration: iterations, toolCallsUsed, provider: this.config.providerOrder[0]
          }),
          signal
        });
        session = sessionAfterTurn;
        observationsSent = observations.length;
        lastProvider = modelResult.provider; lastModel = modelResult.model;
        emit({ type: 'model.completed', iteration: iterations, provider: lastProvider, model: lastModel, durationMs: modelResult.durationMs });

        // Une sortie non conforme, même après réparation, ne doit pas faire
        // échouer le run : elle devient une observation et le modèle réessaie
        // au tour suivant avec le contexte de son erreur.
        let envelope = null;
        try {
          envelope = parseAgentEnvelope(modelResult.text);
        } catch (parseError) {
          try {
            const { result: repaired, session: sessionAfterRepair } = await this._generateTurn({
              session,
              buildDelta: () => buildRepairDeltaPrompt(modelResult.text, parseError.message),
              buildFull: () => buildRepairPrompt(modelResult.text, parseError.message),
              signal
            });
            session = sessionAfterRepair;
            lastProvider = repaired.provider; lastModel = repaired.model;
            envelope = parseAgentEnvelope(repaired.text);
          } catch (repairError) {
            if (repairError.name === 'AbortError') throw repairError;
            protocolFailures += 1;
            observations.push({
              tool: 'protocol', success: false,
              error: `Sortie illisible même après réparation (${clip(repairError.message, 300)}). Réponds strictement avec l'envelope JSON.`
            });
            if (protocolFailures > this.config.stallLimit) break;
            continue;
          }
        }

        memoryWrites.push(...envelope.memory_writes);
        if (envelope.thread_summary) thread.summary = envelope.thread_summary;

        // Trace exposée aux appelants (ex: rendu "Claude Code" côté app) : le
        // raisonnement court de ce tour et les outils qu'il s'apprête à
        // appeler, AVANT leur exécution — permet d'afficher la réflexion puis
        // les tool.started/tool.completed qui suivent dans le bon ordre.
        emit({
          type: 'model.decision',
          iteration: iterations,
          decision_summary: envelope.decision_summary || '',
          tool_calls: (envelope.tool_calls || []).map(call => ({ id: call.id, name: call.name, purpose: call.purpose || '' }))
        });

        if (envelope.state === RUN_STATES.COMPLETE || envelope.state === RUN_STATES.BLOCKED) {
          if (isAutonomous && toolCallsUsed === 0) {
            const calls = [{
              id: `v3_initial_observation_${iterations}`,
              name: 'collect_ecosystem',
              args: {},
              purpose: 'Observation minimale obligatoire avant toute conclusion autonome'
            }];
            const results = await this.tools.executeBatch(calls, {
              event, runId, iteration: iterations, signal, onEvent: emit,
              remainingToolCalls: this.config.maxToolCalls, scheduleWake, scheduleWakes,
              provider: lastProvider, decisionSummary: envelope.decision_summary
            });
            toolCallsUsed += calls.length;
            observations.push(...results, {
              tool: 'protocol',
              success: false,
              error: 'Un cycle scheduled/proactive ne peut pas conclure avant une observation réelle. Le catalogue available_tools est connecté via les tool_calls JSON.'
            });
            await this.memory.saveCheckpoint(runId, iterations, {
              decision_summary: 'Garde-fou V3: observation initiale injectée avant une conclusion autonome sans outil.',
              tool_calls: calls.map(c => ({ name: c.name, args: c.args })), results, toolCallsUsed
            });
            emit({ type: 'checkpoint', iteration: iterations, toolCallsUsed, safeguard: 'required_initial_observation' });
            continue;
          }

          const completionError = validateCompletion(envelope, event);
          if (completionError) {
            protocolFailures += 1;
            observations.push({ tool: 'protocol', success: false, error: completionError });
            // Sans ce garde-fou, un modèle qui reconcluait mal en boucle
            // consommait toutes les itérations pour rien.
            if (protocolFailures > this.config.stallLimit) break;
            continue;
          }
          finalEnvelope = envelope;
          break;
        }

        if (!envelope.tool_calls.length) {
          protocolFailures += 1;
          observations.push({ tool: 'protocol', success: false, error: 'state=continue exige au moins un tool_call' });
          if (protocolFailures > this.config.stallLimit) break;
          continue;
        }

        const remaining = this.config.maxToolCalls - toolCallsUsed;
        if (remaining <= 0) {
          observations.push({ tool: 'loop_guard', success: false, error: 'Budget d’outils épuisé pour ce passage. Conclus maintenant.' });
          break;
        }

        const signature = hash(stableStringify(envelope.tool_calls.map(call => ({ name: call.name, args: call.args }))));
        const repeats = (batchHistory.get(signature) || 0) + 1;
        batchHistory.set(signature, repeats);
        if (repeats > this.config.stallLimit) {
          observations.push({ tool: 'loop_guard', success: false, error: 'Même série d’outils répétée sans progrès. Change d’approche ou termine.' });
          if (repeats > this.config.stallLimit + 1) break;
          continue;
        }

        const calls = envelope.tool_calls.slice(0, remaining);
        const results = await this.tools.executeBatch(calls, {
          event, runId, iteration: iterations, signal, onEvent: emit,
          remainingToolCalls: remaining, scheduleWake, scheduleWakes,
          provider: lastProvider, decisionSummary: envelope.decision_summary
        });
        toolCallsUsed += calls.length;
        observations.push(...results);
        await this.memory.saveCheckpoint(runId, iterations, {
          decision_summary: envelope.decision_summary,
          tool_calls: calls.map(c => ({ name: c.name, args: c.args })), results, toolCallsUsed
        });
        await flushMemories();
        emit({ type: 'checkpoint', iteration: iterations, toolCallsUsed });
      }

      if (!finalEnvelope) {
        const emergency = await this.provider.generate(buildEmergencyCompletionPrompt({ event, observations }), { signal }).catch(() => null);
        if (emergency) {
          lastProvider = emergency.provider; lastModel = emergency.model;
          try { finalEnvelope = parseAgentEnvelope(emergency.text); } catch (_) { /* repli ci-dessous */ }
        }
      }
      if (!finalEnvelope || ![RUN_STATES.COMPLETE, RUN_STATES.BLOCKED].includes(finalEnvelope.state)) {
        finalEnvelope = {
          state: RUN_STATES.BLOCKED,
          final: 'Je me suis arrêté proprement car le budget de ce passage est épuisé. Je reprendrai avec un nouveau contexte.',
          blocked_reason: 'Budget agentique épuisé',
          next_check_in_minutes: this.config.defaultWakeMinutes,
          memory_writes: [], thread_summary: thread.summary
        };
      }

      const continuous = event.context?.continuousAgent === true || isAutonomous;
      const wakeMinutes = finalEnvelope.next_check_in_minutes || (continuous ? this.config.defaultWakeMinutes : null);
      if (wakeMinutes && !scheduledWake) {
        await scheduleWake(wakeMinutes, finalEnvelope.blocked_reason || finalEnvelope.decision_summary || 'Continuer la veille agentique');
      }

      let finalText = finalEnvelope.final || (finalEnvelope.state === RUN_STATES.BLOCKED ? finalEnvelope.blocked_reason : 'Terminé.');
      // L'horaire du prochain passage n'intéresse que les cycles autonomes.
      // L'ajouter à une réponse humaine donnait un ton de robot d'astreinte.
      if (scheduledWake && !isConversational) {
        finalText = `${finalText}\n\nProchain passage agentique : ${formatParis(new Date(scheduledWake.runAfter))}.`;
      }

      emit({ type: 'final.ready', state: finalEnvelope.state, conversational: isConversational });
      await this._persistTurn({ event, thread, runId, finalText, finalEnvelope, scheduledWake, isConversational, toolCallsUsed, observations });
      await flushMemories();

      const status = finalEnvelope.state === RUN_STATES.BLOCKED ? RUN_STATUS.BLOCKED : RUN_STATUS.COMPLETED;
      await this.memory.finishRun(runId, {
        status, iterations: Math.min(iterations, this.config.maxIterations), toolCalls: toolCallsUsed,
        provider: lastProvider, model: lastModel, finalText,
        metadata: { wake: scheduledWake, observations: observations.length, protocolFailures }
      });

      const result = {
        ok: true, runId, state: finalEnvelope.state, final: finalText,
        blocked_reason: finalEnvelope.blocked_reason || '', next_wake: scheduledWake,
        iterations: Math.min(iterations, this.config.maxIterations), tool_calls: toolCallsUsed,
        provider: lastProvider, model: lastModel
      };
      emit({ type: 'run.completed', ...result });
      return result;
    } catch (error) {
      // Ce que l'agent a appris avant le plantage reste acquis.
      await flushMemories().catch(() => {});
      const status = error.name === 'AbortError' ? RUN_STATUS.CANCELLED : RUN_STATUS.FAILED;
      await this.memory.finishRun(runId, {
        status, iterations, toolCalls: toolCallsUsed, provider: lastProvider, model: lastModel, error: error.message
      }).catch(() => {});
      emit({ type: 'run.failed', status, error: error.message });
      throw error;
    } finally {
      this.tools.releaseRun?.(runId);
    }
  }

  /**
   * Enregistre le tour au bon endroit.
   *
   * Un échange avec une personne va dans la conversation. Un passage autonome
   * va dans le journal épisodique : l'écrire comme un message `user` faisait
   * croire au modèle, au tour suivant, qu'un humain lui avait écrit « Effectue
   * le passage agentique maintenant », ce qui déformait son ton et sa mémoire
   * de la relation.
   */
  async _persistTurn({ event, thread, runId, finalText, finalEnvelope, scheduledWake, isConversational, toolCallsUsed, observations }) {
    if (isConversational) {
      thread.messages = [
        ...(thread.messages || []),
        { role: 'user', content: clip(event.text, 12000), at: event.createdAt },
        { role: 'assistant', content: clip(finalText, 12000), at: new Date().toISOString() }
      ].slice(-this.config.shortTermMessages);
    } else if (typeof this.memory.recordEpisode === 'function') {
      const failures = observations.filter(item => item && item.success === false).length;
      await this.memory.recordEpisode({
        threadId: event.threadId,
        runId,
        trigger: event.trigger,
        summary: clip(finalEnvelope.decision_summary || finalText, 2000),
        outcome: finalEnvelope.state,
        details: {
          tool_calls: toolCallsUsed,
          failed_observations: failures,
          next_wake: scheduledWake?.runAfter || null
        }
      }).catch(error => this.logger.warn?.(`[pc3] épisode non enregistré: ${error.message}`));
    }

    thread.user_id = event.userId || thread.user_id;
    thread.working_state = { lastRunId: runId, lastWake: scheduledWake, lastStatus: finalEnvelope.state };
    await this.memory.saveThread(thread);
  }
}

module.exports = { AgentLoop, formatParis, AUTONOMOUS_TRIGGERS, CONVERSATIONAL_TRIGGERS };
