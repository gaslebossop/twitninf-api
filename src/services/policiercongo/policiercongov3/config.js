'use strict';

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function intEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name], 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

function numberEnv(name, fallback, min, max) {
  const parsed = Number.parseFloat(process.env[name]);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

function csvEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map(value => value.trim()).filter(Boolean);
}

function loadV3Config(overrides = {}) {
  const config = {
    enabled: boolEnv('POLICIERCONGO_V3_ENABLED', false),
    dryRun: boolEnv('POLICIERCONGO_V3_DRY_RUN', true),
    providerOrder: csvEnv('POLICIERCONGO_V3_PROVIDERS', ['codex']),
    claudeModel: process.env.POLICIERCONGO_V3_CLAUDE_MODEL || 'sonnet',
    claudeReasoningEffort: process.env.POLICIERCONGO_V3_CLAUDE_REASONING_EFFORT || 'low',
    codexModel: process.env.POLICIERCONGO_V3_CODEX_MODEL || 'gpt-5.5',
    codexReasoningEffort: process.env.POLICIERCONGO_V3_CODEX_REASONING_EFFORT || 'medium',
    maxIterations: intEnv('POLICIERCONGO_V3_MAX_ITERATIONS', 18, 2, 64),
    maxToolCalls: intEnv('POLICIERCONGO_V3_MAX_TOOL_CALLS', 72, 1, 500),
    maxParallelReads: intEnv('POLICIERCONGO_V3_MAX_PARALLEL_READS', 6, 1, 20),
    modelTimeoutMs: intEnv('POLICIERCONGO_V3_MODEL_TIMEOUT_MS', 240000, 10000, 900000),
    toolTimeoutMs: intEnv('POLICIERCONGO_V3_TOOL_TIMEOUT_MS', 600000, 1000, 600000),
    contextCharBudget: intEnv('POLICIERCONGO_V3_CONTEXT_CHARS', 150000, 16000, 500000),
    // Le prompt porte l'index compact des 84 outils (~25 000 caractères) au
    // lieu de leur JSON Schema intégral (~48 500, dont un tiers était coupé
    // faute de budget). 0 = descriptions entières : c'est la seule base sur
    // laquelle le modèle choisit un outil. Une valeur >0 les tronque pour
    // économiser davantage, au prix de la qualité de sélection.
    toolIndexDescriptionChars: intEnv('POLICIERCONGO_V3_TOOL_INDEX_DESC_CHARS', 0, 0, 2000),
    // 24 000 était généreux pour la quasi-totalité des sorties d'outils
    // réelles (get_tweet, get_user, la plupart des recherches bornées) —
    // seuls les tout derniers appels d'un lot gardent ce plafond, les plus
    // anciens sont déjà réduits d'un facteur 8 par compactObservations.
    // Abaisser le plafond réduit le pire cas sans changer le contenu utile.
    toolResultCharBudget: intEnv('POLICIERCONGO_V3_TOOL_RESULT_CHARS', 12000, 2000, 100000),
    shortTermMessages: intEnv('POLICIERCONGO_V3_SHORT_TERM_MESSAGES', 48, 8, 200),
    recallCandidates: intEnv('POLICIERCONGO_V3_RECALL_CANDIDATES', 180, 20, 1000),
    recallLimit: intEnv('POLICIERCONGO_V3_RECALL_LIMIT', 32, 4, 100),
    stallLimit: intEnv('POLICIERCONGO_V3_STALL_LIMIT', 3, 1, 10),
    providerRetries: intEnv('POLICIERCONGO_V3_PROVIDER_RETRIES', 2, 0, 5),
    // Second avis obligatoire de l'AUTRE modèle avant toute action
    // TOOL_RISK.DESTRUCTIVE (ban_user, admin_delete_tweet, delete_own_tweet,
    // update_algorithm_config, request_withdrawal…). Fail-closed : si le
    // second modèle ne répond pas clairement, l'action est refusée.
    crossVerificationEnabled: boolEnv('POLICIERCONGO_V3_CROSS_VERIFICATION', true),
    crossVerificationTimeoutMs: intEnv('POLICIERCONGO_V3_CROSS_VERIFICATION_TIMEOUT_MS', 60000, 5000, 300000),
    // À partir de la 2e itération d'un même run, réutilise la session du
    // provider primaire (codex exec resume) et n'envoie que le delta au lieu
    // de reconstruire tout le prompt (~40K caractères de catalogue d'outils
    // et de manuel identiques à chaque itération). Sans effet sur un
    // provider qui ne supporte pas les sessions (ex. Claude) : ce cas
    // retombe silencieusement sur le comportement plein prompt existant.
    sessionReuseEnabled: boolEnv('POLICIERCONGO_V3_SESSION_REUSE', true),
    defaultWakeMinutes: intEnv('POLICIERCONGO_V3_DEFAULT_WAKE_MINUTES', 30, 1, 10080),
    bootstrapWakeMinutes: intEnv('POLICIERCONGO_V3_BOOTSTRAP_WAKE_MINUTES', 2, 1, 1440),
    minWakeMinutes: intEnv('POLICIERCONGO_V3_MIN_WAKE_MINUTES', 2, 1, 1440),
    maxWakeMinutes: intEnv('POLICIERCONGO_V3_MAX_WAKE_MINUTES', 1440, 2, 43200),
    schedulerClaimSeconds: intEnv('POLICIERCONGO_V3_SCHEDULER_CLAIM_SECONDS', 300, 30, 3600),
    schedulerBatchSize: intEnv('POLICIERCONGO_V3_SCHEDULER_BATCH_SIZE', 10, 1, 100),
    schedulerEnabled: boolEnv('POLICIERCONGO_V3_SCHEDULER_ENABLED', false),
    schedulerIntervalMs: intEnv('POLICIERCONGO_V3_SCHEDULER_INTERVAL_MS', 30000, 5000, 300000),
    advancedSearchMaxLimit: intEnv('POLICIERCONGO_V3_SEARCH_MAX_LIMIT', 200, 10, 1000),
    memoryMinImportance: numberEnv('POLICIERCONGO_V3_MEMORY_MIN_IMPORTANCE', 0.15, 0, 1),
    memoryHalfLifeDays: numberEnv('POLICIERCONGO_V3_MEMORY_HALF_LIFE_DAYS', 45, 1, 3650),
    memoryEmbeddingsEnabled: boolEnv('POLICIERCONGO_V3_MEMORY_EMBEDDINGS', true),
    // Au-dessus de ce cosinus, une correction est considérée comme portant sur
    // le souvenir voisin et le remplace. Volontairement élevé : un faux positif
    // efface un fait juste.
    memoryContradictionThreshold: numberEnv('POLICIERCONGO_V3_MEMORY_CONTRADICTION_THRESHOLD', 0.86, 0.5, 0.99),
    episodeRecall: intEnv('POLICIERCONGO_V3_EPISODE_RECALL', 10, 0, 50),
    allowAutonomousWrites: boolEnv('POLICIERCONGO_V3_AUTONOMOUS_WRITES', false),
    allowSensitiveTools: boolEnv('POLICIERCONGO_V3_SENSITIVE_TOOLS', false),
    allowAllTools: boolEnv('POLICIERCONGO_V3_ALLOW_ALL_TOOLS', false),
    logPromptBodies: boolEnv('POLICIERCONGO_V3_LOG_PROMPTS', false),
    schemaPrefix: process.env.POLICIERCONGO_V3_SCHEMA_PREFIX || 'policiercongo_v3',
    ...overrides
  };

  if (!Array.isArray(config.providerOrder) || !config.providerOrder.length) {
    config.providerOrder = ['codex'];
  }
  return Object.freeze(config);
}

module.exports = { loadV3Config, boolEnv, intEnv, numberEnv, csvEnv };
