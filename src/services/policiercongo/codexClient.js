'use strict';

/**
 * Pont PolicierCongoV2 -> Codex CLI (OpenAI).
 *
 * Alternative à claudeCodeClient.js : appelle `codex exec` en non-interactif.
 * S'authentifie via la session `codex login` de la machine (abonnement ChatGPT
 * Plus/Pro/Team), pas via une clé API OPENAI_API_KEY séparée.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../../utils/logger');

const DEFAULT_MODEL = process.env.POLICIERCONGO_CODEX_MODEL || 'gpt-5.6-sol';
const DEFAULT_REASONING_EFFORT = process.env.POLICIERCONGO_CODEX_REASONING_EFFORT || 'medium';
const EXEC_TIMEOUT_MS = 120000;

function runCodexExec(prompt, model, reasoningEffort) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(os.tmpdir(), `pc2-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '-o', outFile];
    if (model) args.push('-m', model);
    if (reasoningEffort) args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
    args.push('-'); // lit le prompt depuis stdin

    const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`codex exec timeout après ${EXEC_TIMEOUT_MS}ms`));
    }, EXEC_TIMEOUT_MS);

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch (_) { /* rien à lire */ }
      try { fs.unlinkSync(outFile); } catch (_) { /* déjà absent */ }
      if (!text && code !== 0) {
        return reject(new Error(stderr.trim() || `codex exec a quitté avec le code ${code}`));
      }
      resolve(text);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * @param {string} prompt Prompt complet déjà aplati (system + user).
 * @param {string|null} [model] Modèle Codex (ex: 'gpt-5.6-sol'). Laisser vide pour le défaut.
 * @param {string|null} [reasoningEffort] 'low'|'medium'|'high'|... Laisser vide pour le défaut.
 * @returns {Promise<string|null>}
 */
async function generateWithCodex(prompt, model = DEFAULT_MODEL, reasoningEffort = DEFAULT_REASONING_EFFORT) {
  const startedAt = Date.now();
  const text = typeof prompt === 'string' ? prompt : String(prompt || '');
  console.log(`[PolicierCongo][LLM] -> Requête Codex | model=${model || 'default'} | effort=${reasoningEffort || 'default'}`);

  try {
    const raw = await runCodexExec(text, model, reasoningEffort);
    const cleaned = (raw || '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    console.log(`[PolicierCongo][LLM] <- Réponse Codex OK | durationMs=${Date.now() - startedAt} | len=${cleaned.length}`);
    return cleaned || null;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logger.error(`❌ Erreur génération Codex (durationMs=${durationMs}): ${error?.message}`);
    console.log(`[PolicierCongo][LLM] <- Réponse Codex ERROR | durationMs=${durationMs} | ${error?.message}`);
    return null;
  }
}

module.exports = { generateWithCodex, DEFAULT_MODEL };
