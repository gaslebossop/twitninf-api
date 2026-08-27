'use strict';

/**
 * Pont PolicierCongoV2 -> Claude Agent SDK.
 *
 * Remplace l'ancienne API MegaLLM (cassée, 403 WAF en permanence) par un appel
 * direct au Claude Agent SDK, qui réutilise la session `claude login` /
 * `claude setup-token` de la machine (abonnement Claude Code), et NON la clé
 * ANTHROPIC_API_KEY du compte API séparé.
 */

const logger = require('../../utils/logger');

const DEFAULT_MODEL = (process.env.POLICIERCONGO_CLAUDE_CODE_MODEL || 'claude-opus-5').trim();

let _queryFn = null;
async function loadQuery() {
  if (_queryFn) return _queryFn;
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  _queryFn = mod.query;
  return _queryFn;
}

/**
 * @param {string} prompt Prompt complet déjà aplati (system + user).
 * @param {string} [model] Modèle Claude Code : identifiant exact ('claude-opus-5')
 *   ou alias ('opus' | 'sonnet' | 'haiku').
 * @returns {Promise<string|null>} Texte brut de la réponse, ou null en cas d'échec.
 */
async function generateWithClaudeCode(prompt, model = DEFAULT_MODEL) {
  const startedAt = Date.now();
  const text = typeof prompt === 'string' ? prompt : String(prompt || '');
  console.log(`[PolicierCongo][LLM] -> Requête Claude Code | model=${model}`);

  try {
    const query = await loadQuery();
    let output = '';

    for await (const message of query({
      prompt: text,
      options: { model, allowedTools: [] }
    })) {
      if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text') output += block.text;
        }
      }
    }

    const cleaned = (output || '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    console.log(`[PolicierCongo][LLM] <- Réponse Claude Code OK | model=${model} | durationMs=${Date.now() - startedAt} | len=${cleaned.length}`);
    return cleaned || null;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logger.error(`❌ Erreur génération Claude Code (model=${model}, durationMs=${durationMs}): ${error?.message}`);
    console.log(`[PolicierCongo][LLM] <- Réponse Claude Code ERROR | model=${model} | durationMs=${durationMs} | ${error?.message}`);
    return null;
  }
}

module.exports = { generateWithClaudeCode, DEFAULT_MODEL };
