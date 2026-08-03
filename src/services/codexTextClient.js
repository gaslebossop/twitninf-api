'use strict';

/**
 * Client Codex générique — génération de texte pour les fonctionnalités produit.
 *
 * Même mécanique que `policiercongo/codexClient.js` (appel `codex exec` en
 * non-interactif, authentifié par la session `codex login` de la MACHINE et non
 * par une clé API), mais découplé de PolicierCongo : celui-là porte le préfixe
 * de logs, le modèle et les réglages de l'agent, qui n'ont rien à faire dans le
 * co-pilote de rédaction.
 *
 * ── Ce qu'il faut savoir avant de s'en servir ─────────────────────────────
 * 1. Chaque appel SPAWNE UN PROCESSUS. C'est acceptable pour une action
 *    déclenchée par un bouton, pas pour un appel à chaque frappe. Les appelants
 *    doivent limiter la cadence côté utilisateur.
 * 2. L'authentification est celle de la machine qui exécute l'API. Sur le VPS,
 *    tant que `codex login` n'y a pas été fait, tous les appels échouent —
 *    proprement (`codex_unavailable`), sans faire tomber la route appelante.
 * 3. La latence se compte en secondes. Toute route qui l'utilise doit le dire à
 *    l'utilisateur (état de chargement explicite).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');

const DEFAULT_MODEL = process.env.CODEX_TEXT_MODEL || 'gpt-5.6-sol';
const DEFAULT_REASONING_EFFORT = process.env.CODEX_TEXT_REASONING_EFFORT || 'low';
const DEFAULT_TIMEOUT_MS = Number(process.env.CODEX_TEXT_TIMEOUT_MS || 45000);

/**
 * Nombre d'appels Codex simultanés.
 *
 * Sans plafond, dix utilisateurs qui cliquent en même temps lancent dix
 * processus `codex` sur le VPS — c'est le genre de charge qui fait tomber
 * l'API elle-même. Au-delà, on refuse tout de suite plutôt que de faire
 * patienter derrière une file dont personne ne connaît la longueur.
 */
const MAX_CONCURRENT = Number(process.env.CODEX_TEXT_MAX_CONCURRENT || 3);
let inFlight = 0;

/** Le binaire est-il présent ? Résultat mémorisé : un `spawn` raté par appel coûte cher. */
let binaryAvailable = null;

function checkBinary() {
  if (binaryAvailable !== null) return Promise.resolve(binaryAvailable);
  return new Promise((resolve) => {
    const child = spawn('codex', ['--version'], { stdio: 'ignore' });
    child.on('error', () => {
      binaryAvailable = false;
      logger.warn('[Codex] Binaire `codex` introuvable — les fonctions IA seront désactivées.');
      resolve(false);
    });
    child.on('close', (code) => {
      binaryAvailable = code === 0;
      if (!binaryAvailable) {
        logger.warn(`[Codex] \`codex --version\` a quitté avec le code ${code}.`);
      }
      resolve(binaryAvailable);
    });
  });
}

function runCodexExec(prompt, { model, reasoningEffort, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(
      os.tmpdir(),
      `twitninf-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    // `-s read-only` : le co-pilote rédige, il n'a aucune raison d'écrire sur le
    // disque du serveur. `--skip-git-repo-check` car l'API ne tourne pas
    // forcément depuis un dépôt git.
    const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '-o', outFile];
    if (model) args.push('-m', model);
    if (reasoningEffort) args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
    args.push('-'); // prompt lu sur stdin

    const child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      try { fs.unlinkSync(outFile); } catch { /* déjà absent */ }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      cleanup();
      reject(new Error(`timeout après ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch { /* rien écrit */ }
      cleanup();
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
 * Génère du texte via Codex.
 *
 * Ne jette jamais : les appelants sont des routes produit, un échec IA doit
 * dégrader la fonctionnalité, pas renvoyer un 500.
 *
 * @returns {Promise<{success: true, text: string} | {success: false, error: string}>}
 */
async function generateText(prompt, options = {}) {
  const {
    model = DEFAULT_MODEL,
    reasoningEffort = DEFAULT_REASONING_EFFORT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const text = typeof prompt === 'string' ? prompt : String(prompt || '');
  if (!text.trim()) return { success: false, error: 'empty_prompt' };

  if (!(await checkBinary())) {
    return { success: false, error: 'codex_unavailable' };
  }

  if (inFlight >= MAX_CONCURRENT) {
    return { success: false, error: 'codex_busy' };
  }

  inFlight += 1;
  const startedAt = Date.now();
  try {
    const raw = await runCodexExec(text, { model, reasoningEffort, timeoutMs });
    const cleaned = String(raw || '').trim();
    if (!cleaned) {
      return { success: false, error: 'empty_response' };
    }
    logger.info(`[Codex] Réponse OK | ${Date.now() - startedAt}ms | ${cleaned.length} car.`);
    return { success: true, text: cleaned };
  } catch (error) {
    logger.warn(`[Codex] Échec (${Date.now() - startedAt}ms): ${error?.message || error}`);
    return { success: false, error: 'generation_failed' };
  } finally {
    inFlight -= 1;
  }
}

/**
 * Extrait un objet JSON d'une réponse.
 *
 * Le modèle enrobe régulièrement le JSON de backticks ou le fait précéder d'une
 * phrase d'introduction, malgré la consigne : on nettoie plutôt que d'échouer.
 */
function parseJsonLoose(raw) {
  const cleaned = String(raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/** Codex est-il utilisable ici ? Sert aux routes de statut et à l'app. */
async function isAvailable() {
  return checkBinary();
}

module.exports = {
  generateText,
  parseJsonLoose,
  isAvailable,
  DEFAULT_MODEL,
};
