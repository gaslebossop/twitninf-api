'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { delay, newId, withTimeout, clip } = require('./utils');

function collectClaudeText(message) {
  if (!message) return '';
  const content = message.message?.content || message.content || [];
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n');
}

/**
 * Un prompt peut arriver sous deux formes :
 *  - `{ system, user }` (prompt complet V3 : bloc statique cacheable + volatile) ;
 *  - une simple string (réparation, complétion d'urgence, delta de session,
 *    vérification croisée) — dans ce cas il n'y a pas de préfixe statique séparé.
 * On normalise toujours vers `{ system, user }` pour que chaque provider décide
 * quoi en faire sans se soucier de la forme reçue.
 */
function normalizePromptInput(input) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input)) {
    return { system: String(input.system || ''), user: String(input.user ?? input.text ?? '') };
  }
  return { system: '', user: String(input ?? '') };
}

/** Ré-aplatit en un seul flux (pour codex, qui n'a qu'un canal stdin). */
function flattenPrompt(input) {
  const { system, user } = normalizePromptInput(input);
  return system ? `${system}\n\n${user}` : user;
}

class ClaudeProvider {
  constructor(config) {
    this.name = 'claude';
    this.model = config.claudeModel;
    this.reasoningEffort = config.claudeReasoningEffort || 'xhigh';
    this.config = config;
    // Le SDK Claude Code expose `options.resume` (comme `codex exec resume`) :
    // un tour N>1 peut reprendre la session au lieu de retransmettre system +
    // catalogue d'outils + manuel (~40 000 caractères) à chaque itération.
    // AgentLoop appelle donc resume() pour les tours suivants d'un même run.
    this.supportsSessions = true;
  }

  async _run(promptInput, { signal, resumeSessionId } = {}) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { system, user } = normalizePromptInput(promptInput);

    // Le SDK attend un vrai AbortController, pas un littéral `{ signal }` :
    // avec l'ancienne forme, `.abort()` était introuvable et l'annulation d'un
    // run ne coupait jamais la génération en cours.
    let abortController;
    if (signal) {
      abortController = new AbortController();
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    // Le bloc statique (system + outils + manuel) passe en systemPrompt : le
    // SDK lui applique le cache de prompt Anthropic, donc ce préfixe identique
    // n'est refacturé qu'une fois par fenêtre de cache au lieu d'à chaque
    // itération. Passer une string custom REMPLACE aussi le preset
    // "claude_code" par défaut (persona assistant-code inutile ici). Absente
    // (repair/urgence/vérif croisée = string simple), on retombe sur l'appel
    // sans systemPrompt, à l'identique de l'ancien comportement.
    const options = {
      model: this.model,
      // Réflexion adaptative : le modèle décide lui-même de la profondeur,
      // `effort` ne fait qu'en donner le registre. Sur Opus 5 c'est déjà le
      // défaut, mais l'écrire protège d'un `thinking` désactivé hérité d'un
      // réglage global — et thinking coupé sur Opus 5 fait écrire les appels
      // d'outils en texte visible au lieu de blocs d'appel, ce que la boucle
      // V3 lirait comme une envelope illisible.
      thinking: { type: 'adaptive' },
      effort: this.reasoningEffort,
      allowedTools: [],
      abortController
    };
    if (resumeSessionId) {
      // Reprise : le SDK retrouve system/outils/manuel depuis la session
      // persistée, donc on ne renvoie jamais systemPrompt ici — l'envoyer
      // annulerait l'intérêt de resume en réinjectant les ~40 000 caractères
      // statiques dans le tour.
      options.resume = resumeSessionId;
    } else if (system) {
      options.systemPrompt = system;
    }

    let text = '';
    let sessionId = null;
    for await (const message of sdk.query({ prompt: user, options })) {
      text += collectClaudeText(message);
      if (message?.session_id) sessionId = message.session_id;
    }
    if (!text.trim()) throw new Error('Claude a renvoyé une réponse vide');
    return { text: text.trim(), sessionId };
  }

  async generate(promptInput, options = {}) {
    return this._run(promptInput, options);
  }

  /** Tour N>1 d'une session Claude déjà démarrée (voir agentLoop.js: `_generateTurn`). */
  async resume(sessionId, promptInput, options = {}) {
    if (!sessionId) throw new Error('resume() nécessite un sessionId Claude existant');
    return this._run(promptInput, { ...options, resumeSessionId: sessionId });
  }
}

class CodexProvider {
  constructor(config) {
    this.name = 'codex';
    this.model = config.codexModel;
    this.reasoningEffort = config.codexReasoningEffort;
    this.timeoutMs = config.modelTimeoutMs;
    // `codex exec resume <thread_id>` permet d'envoyer uniquement le delta
    // d'un tour à l'autre au lieu de reconstruire tout le prompt : AgentLoop
    // s'appuie sur ce flag pour savoir si le mode session est exploitable.
    this.supportsSessions = true;
  }

  /** Premier tour : démarre une nouvelle session codex. */
  async generate(promptInput, options = {}) {
    // Codex n'a qu'un canal stdin : on ré-aplatit `{system, user}` en
    // `system\n\nvolatile`, byte-identique au prompt monolithique d'avant.
    return this._run(null, flattenPrompt(promptInput), options);
  }

  /**
   * Tour suivant dans la MÊME session : `prompt` ne doit contenir QUE le
   * delta (nouvelles observations + instruction), jamais le contexte complet
   * — codex le retrouve lui-même depuis la session persistée.
   */
  async resume(sessionId, promptInput, options = {}) {
    if (!sessionId) throw new Error('resume() nécessite un sessionId codex existant');
    return this._run(sessionId, flattenPrompt(promptInput), options);
  }

  async _run(sessionId, prompt, { signal } = {}) {
    const outputFile = path.join(os.tmpdir(), `policiercongo-v3-${newId()}.txt`);
    // resume() n'accepte pas --sandbox : la politique de sandbox est fixée à
    // la création de la session (read-only) et persiste sur les tours
    // suivants — confirmé par le CLI, qui rejette le flag sur `resume`.
    const args = sessionId
      ? ['exec', 'resume', sessionId, '--skip-git-repo-check']
      : ['exec', '--skip-git-repo-check', '--sandbox', 'read-only'];
    args.push(
      '--model', this.model,
      '--config', `model_reasoning_effort=${JSON.stringify(this.reasoningEffort)}`,
      '--json',
      '--output-last-message', outputFile,
      '-'
    );
    try {
      let stdout = '';
      await new Promise((resolve, reject) => {
        const child = spawn(process.env.POLICIERCONGO_V3_CODEX_BIN || 'codex', args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let stderr = '';
        let settled = false;
        let killTimer = null;

        // Le délai est tenu ici, pas seulement par le routeur : une course de
        // promesses laissait le process codex tourner indéfiniment après
        // expiration, et chaque retry en empilait un de plus.
        const terminate = () => {
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
          killTimer.unref?.();
        };
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (killTimer) clearTimeout(killTimer);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };

        const deadline = setTimeout(() => {
          terminate();
          finish(new Error(`Timeout modèle codex après ${this.timeoutMs}ms`));
        }, this.timeoutMs);
        deadline.unref?.();

        const abort = () => {
          terminate();
          const error = new Error('Génération codex annulée');
          error.name = 'AbortError';
          finish(error);
        };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });

        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', error => finish(error));
        child.on('exit', code => {
          if (code === 0) finish();
          else finish(new Error(`Codex terminé avec le code ${code}: ${clip(stderr || extractCodexError(stdout), 3000)}`));
        });

        // Si codex sort avant d'avoir lu tout le prompt, l'écriture sur stdin
        // émet EPIPE. Sans ce handler, l'événement 'error' d'un flux sans
        // écouteur devient une exception non capturée qui tue le processus API.
        child.stdin.on('error', error => {
          if (error?.code === 'EPIPE') return;
          finish(error);
        });
        child.stdin.end(prompt, 'utf8');
      });

      const capturedSessionId = sessionId || extractThreadId(stdout);
      const text = await fs.readFile(outputFile, 'utf8');
      if (!text.trim()) throw new Error('Codex a renvoyé une réponse vide');
      return { text: text.trim(), sessionId: capturedSessionId };
    } finally {
      await fs.unlink(outputFile).catch(() => {});
    }
  }
}

/** Lit l'événement `thread.started` du flux JSONL de `codex exec --json`. */
function extractThreadId(stdout) {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'thread.started' && event.thread_id) return event.thread_id;
    } catch (_) { /* ligne non-JSON (log, warning...), ignorée */ }
  }
  return null;
}

function extractCodexError(stdout) {
  const messages = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed);
      const message = event.message || event.error?.message;
      if (message) messages.push(message);
    } catch (_) { /* ligne non-JSON (log, warning...), ignorée */ }
  }
  return messages.join(' | ');
}

/**
 * Les échecs que réessayer ne peut pas réparer : plafond d'usage atteint,
 * jeton expiré, compte non connecté, délai de génération dépassé.
 *
 * Le retry n'a de sens que sur une panne passagère — réseau coupé, flux
 * tronqué, sortie illisible. Appliqué à un plafond d'abonnement il refait
 * trois fois le même appel, avec des attentes entre chaque, pour une réponse
 * connue d'avance ; appliqué à un dépassement de délai il coûte deux fois
 * sept minutes de scheduler bloqué.
 *
 * On bascule donc immédiatement sur le provider suivant de `providerOrder`.
 * Rien n'est masqué : le message d'origine reste dans les `failures` remontées
 * et dans le journal, préfixé pour être reconnaissable d'un coup d'œil.
 */
const ERREURS_DEFINITIVES = [
  // Le plafond est déjà à sept minutes : un tour qui l'atteint n'est pas
  // « momentanément lent », il est bloqué. Le réessayer coûte sept minutes de
  // plus pendant lesquelles le scheduler ne traite aucun autre réveil — et
  // c'est redondant, puisqu'un run raté est de toute façon reprogrammé par
  // PersistentWakeScheduler (5 à 60 min selon le nombre de tentatives).
  /^Timeout mod[èe]le/i,
  /session limit/i,
  /usage limit/i,
  /rate.?limit/i,
  /quota/i,
  /credit balance/i,
  /insufficient.*(credit|fund)/i,
  /(401|403|unauthorized|forbidden)/i,
  /invalid api key/i,
  /authentication/i,
  /not logged in|please run .?claude login/i
];

function estDefinitive(message) {
  const texte = String(message || '');
  return ERREURS_DEFINITIVES.some(motif => motif.test(texte));
}

class ProviderRouter {
  constructor({ config, logger = console, providers = {} }) {
    this.config = config;
    this.logger = logger;
    this.providers = {
      codex: providers.codex || new CodexProvider(config),
      claude: providers.claude || new ClaudeProvider(config),
      ...providers
    };
  }

  async generate(prompt, options = {}) {
    const failures = [];
    for (const name of this.config.providerOrder) {
      const provider = this.providers[name];
      if (!provider) continue;
      try {
        return await this._call(name, provider, () => provider.generate(prompt, options), options.signal);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        failures.push(error.message);
        // échec définitif de ce provider après ses retries : on tente le suivant
      }
    }
    throw new Error(`Aucun provider V3 disponible. ${failures.join(' | ')}`);
  }

  /**
   * Appelle UN provider précis, sans bascule vers les autres.
   *
   * Sert à la vérification croisée des actions destructrices : on veut
   * délibérément l'avis de l'AUTRE modèle que celui qui a pris la décision,
   * jamais un repli sur le même. `providerOrder` n'entre pas en jeu ici — les
   * deux providers sont toujours instanciés (voir constructeur), même si un
   * seul figure dans `providerOrder`.
   */
  async generateWith(name, prompt, options = {}) {
    const provider = this.providers[name];
    if (!provider) throw new Error(`Provider inconnu ou non configuré: ${name}`);
    return this._call(name, provider, () => provider.generate(prompt, options), options.signal);
  }

  /**
   * Reprend une session existante d'UN provider précis (aucune bascule, aucun
   * retry inter-provider possible : une session appartient à un seul
   * provider). L'appelant (AgentLoop) doit se rabattre sur `generate()` en
   * cas d'échec — voir le commentaire sur `sessionId` dans agentLoop.js.
   */
  async resumeWith(name, sessionId, prompt, options = {}) {
    const provider = this.providers[name];
    if (!provider?.resume) throw new Error(`Provider "${name}" ne supporte pas la reprise de session`);
    return this._call(name, provider, () => provider.resume(sessionId, prompt, options), options.signal);
  }

  supportsSessions(name) {
    return Boolean(this.providers[name]?.supportsSessions);
  }

  /**
   * @param {() => Promise<{text, sessionId}>} attempt fabrique un NOUVEL appel
   *   à chaque tentative — jamais une promesse déjà créée, sinon un retry ne
   *   ferait que réattendre le même échec déjà réglé.
   */
  async _call(name, provider, attempt, signal) {
    const errors = [];
    for (let i = 0; i <= this.config.providerRetries; i += 1) {
      const started = Date.now();
      try {
        const result = await withTimeout(attempt(), this.config.modelTimeoutMs, `Timeout modèle ${name}`, signal);
        return { text: result.text, sessionId: result.sessionId ?? null, provider: name, model: provider.model, durationMs: Date.now() - started };
      } catch (error) {
        // Une annulation est une décision de l'appelant : la réessayer, ou
        // basculer sur un autre provider, relance un travail que personne
        // n'attend plus.
        if (error.name === 'AbortError' || signal?.aborted) throw error;
        if (estDefinitive(error.message)) {
          errors.push(`${name}#${i + 1} (définitif, pas de retry): ${error.message}`);
          this.logger.warn?.(`[pc3.provider] ${errors.at(-1)}`);
          break;
        }
        errors.push(`${name}#${i + 1}: ${error.message}`);
        this.logger.warn?.(`[pc3.provider] ${errors.at(-1)}`);
        if (i < this.config.providerRetries) await delay(500 * (2 ** i), signal);
      }
    }
    throw new Error(errors.join(' | '));
  }
}

module.exports = { ProviderRouter, CodexProvider, ClaudeProvider, collectClaudeText, extractThreadId, normalizePromptInput, flattenPrompt, estDefinitive };
