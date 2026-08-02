'use strict';

const { buildAgentPrompt } = require('./prompts');
const { clip, safeJson } = require('./utils');

/** Observations gardées intégralement en fin de boucle : les plus récentes. */
const VERBATIM_RECENT_OBSERVATIONS = 6;

class ContextEngine {
  constructor({ config, memory, tools }) {
    this.config = config;
    this.memory = memory;
    this.tools = tools;
  }

  async prepare(event) {
    const [thread, memories, episodes] = await Promise.all([
      this.memory.loadThread(event.threadId, event.userId),
      this.memory.recall({
        userId: event.userId,
        threadId: event.threadId,
        query: `${event.text}\n${safeJson(event.context, 8000)}`,
        limit: this.config.recallLimit
      }),
      this.config.episodeRecall > 0 && typeof this.memory.loadEpisodes === 'function'
        ? this.memory.loadEpisodes(event.threadId, this.config.episodeRecall).catch(() => [])
        : Promise.resolve([])
    ]);
    thread.messages = Array.isArray(thread.messages) ? thread.messages.slice(-this.config.shortTermMessages) : [];
    return { thread, memories, episodes };
  }

  /**
   * Compacte les observations avant l'assemblage.
   *
   * Les plus récentes gardent leur budget complet — ce sont celles sur
   * lesquelles le modèle doit décider maintenant. Les plus anciennes sont
   * fortement réduites : leur détail n'a plus d'usage, seul leur résultat
   * compte. Sans cette dégressivité, 72 observations à 24 000 caractères
   * produisaient un bloc de plusieurs centaines de milliers de caractères.
   */
  compactObservations(observations) {
    const kept = observations.slice(-Math.max(12, this.config.maxToolCalls));
    const pivot = Math.max(0, kept.length - VERBATIM_RECENT_OBSERVATIONS);
    const fullBudget = this.config.toolResultCharBudget;
    const oldBudget = Math.max(400, Math.floor(fullBudget / 8));

    return kept.map((item, index) => {
      if (item?.data === undefined || item?.data === null) return item;
      const budget = index >= pivot ? fullBudget : oldBudget;
      return { ...item, data: clip(safeJson(item.data, budget), budget) };
    });
  }

  build({ event, thread, memories, episodes = [], observations, iteration, toolCallsUsed, provider, runId = null }) {
    return buildAgentPrompt({
      event,
      thread,
      memories,
      episodes,
      tools: this.tools.catalog(event),
      // Schémas complets demandés par le modèle pendant ce run (inspect_tools)
      // ou renvoyés par une erreur d'arguments : ils restent acquis jusqu'à la
      // fin du run, y compris quand le prompt complet est reconstruit.
      toolSchemas: this.tools.expandedDetails?.(runId, event) || [],
      observations: this.compactObservations(observations),
      iteration,
      budgets: {
        max_iterations: this.config.maxIterations,
        iterations_left: this.config.maxIterations - iteration + 1,
        max_tool_calls: this.config.maxToolCalls,
        tool_calls_left: this.config.maxToolCalls - toolCallsUsed
      },
      runtime: { dryRun: this.config.dryRun, provider },
      contextCharBudget: this.config.contextCharBudget
    });
  }
}

module.exports = { ContextEngine, VERBATIM_RECENT_OBSERVATIONS };
