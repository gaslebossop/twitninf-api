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

/**
 * Niveaux de réflexion acceptés par le CLI Claude (EffortLevel du SDK).
 * Une valeur hors liste fait échouer l'appel à la génération, pas au
 * démarrage : elle serait donc découverte en production, un passage sur
 * deux, sous forme d'un run raté. On la ramène ici sur la valeur par
 * défaut plutôt que de la laisser passer.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function effortEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  return EFFORT_LEVELS.includes(raw) ? raw : fallback;
}

function loadV3Config(overrides = {}) {
  const config = {
    enabled: boolEnv('POLICIERCONGO_V3_ENABLED', false),
    dryRun: boolEnv('POLICIERCONGO_V3_DRY_RUN', true),
    // Claude Opus 5 est le modèle de PolicierCongo depuis le 2026-08-25.
    // Codex ne reste dans l'ordre par défaut qu'en second : il tient le rôle
    // de vérificateur croisé (voir crossModelVerification.js, qui exige
    // toujours l'AUTRE modèle) et de repli quand le compte Claude est à sec.
    providerOrder: csvEnv('POLICIERCONGO_V3_PROVIDERS', ['claude', 'codex']),
    claudeModel: process.env.POLICIERCONGO_V3_CLAUDE_MODEL || 'claude-opus-5',
    // xhigh : le niveau au-dessus de `high`, celui qui sert de défaut à
    // Claude Code sur les tâches agentiques. La boucle V3 en est une —
    // jusqu'à 18 tours et 72 appels d'outils par passage.
    claudeReasoningEffort: effortEnv('POLICIERCONGO_V3_CLAUDE_REASONING_EFFORT', 'xhigh'),
    codexModel: process.env.POLICIERCONGO_V3_CODEX_MODEL || 'gpt-5.5',
    codexReasoningEffort: process.env.POLICIERCONGO_V3_CODEX_REASONING_EFFORT || 'medium',
    // OpenRouter : API compatible OpenAI, SANS session serveur — chaque tour
    // renvoie le prompt complet (supportsSessions=false côté provider). La clé
    // vit dans le .env du VPS, jamais dans le dépôt.
    openrouterModel: process.env.POLICIERCONGO_V3_OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash',
    openrouterApiKey: process.env.POLICIERCONGO_V3_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '',
    openrouterBaseUrl: process.env.POLICIERCONGO_V3_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    // Cache de prompt OpenRouter (https://openrouter.ai/docs/.../prompt-caching).
    // Le bloc statique (persona + index d'outils + manuel, ~40 000 caractères)
    // est renvoyé à CHAQUE tour — sans session serveur côté OpenRouter. On le
    // pose comme préfixe stable en tête de messages : DeepSeek met en cache
    // automatiquement, facturé au tarif « cache read » sur les tours 2+.
    // On ajoute EN PLUS une balise `cache_control` explicite : inutile pour
    // DeepSeek (auto) mais indispensable si le modèle est un jour basculé sur
    // Anthropic/Gemini, et sans effet néfaste ici.
    openrouterCacheControl: boolEnv('POLICIERCONGO_V3_OPENROUTER_CACHE_CONTROL', true),
    // Épinglage du fournisseur en amont — le levier nº1 du cache. Ce modèle est
    // servi par ~17 fournisseurs OpenRouter, CHACUN avec son propre cache : sans
    // ordre stable, OpenRouter répartit les requêtes et une bonne moitié tombe
    // sur un cache froid. On met DONC en tête les fournisseurs qui cachent
    // (DeepInfra, DigitalOcean) : tant qu'ils répondent, tous les tours
    // réutilisent le même préfixe chaud.
    //
    // MAIS `allow_fallbacks=true` : quand ces deux-là sont saturés (429 du pool
    // partagé — vu en prod), OpenRouter DOIT pouvoir router vers un autre
    // fournisseur. À false, un 429 des deux têtes faisait échouer tout le tour
    // et le run repartait 5 à 60 min plus tard — d'où des réponses en 5 s et
    // d'autres en 5 min. Un cache froid ponctuel vaut mieux qu'un run mort.
    // Le vrai remède aux 429 est une clé fournisseur perso (BYOK) dans les
    // réglages OpenRouter, qui sort du pool partagé.
    openrouterProviderOrder: csvEnv('POLICIERCONGO_V3_OPENROUTER_PROVIDER_ORDER', ['DeepInfra', 'DigitalOcean']),
    openrouterAllowFallbacks: boolEnv('POLICIERCONGO_V3_OPENROUTER_ALLOW_FALLBACKS', true),
    maxIterations: intEnv('POLICIERCONGO_V3_MAX_ITERATIONS', 18, 2, 64),
    maxToolCalls: intEnv('POLICIERCONGO_V3_MAX_TOOL_CALLS', 72, 1, 500),
    maxParallelReads: intEnv('POLICIERCONGO_V3_MAX_PARALLEL_READS', 6, 1, 20),
    // 7 minutes, et non 4 : mesure des 1147 passages autonomes servis par
    // codex/medium — 50 s en moyenne, 86 s au 95e centile, 235 s au pire,
    // pour 3,7 itérations. Un tour Opus 5 à effort xhigh réfléchit
    // sensiblement plus longtemps, et le plafond de 4 minutes se serait
    // mis à mordre sur des tours parfaitement sains. Le plafond ne sert
    // qu'à couper ce qui est bloqué : le monter ne ralentit aucun tour
    // normal, il évite juste d'en tuer un qui allait aboutir.
    modelTimeoutMs: intEnv('POLICIERCONGO_V3_MODEL_TIMEOUT_MS', 420000, 10000, 900000),
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
    // et de manuel identiques à chaque itération). Les DEUX providers
    // supportent désormais les sessions : `codex exec resume` côté codex,
    // `options.resume` côté Claude. Un provider qui ne les supporterait pas
    // retombe silencieusement sur le comportement plein prompt.
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
    config.providerOrder = ['claude', 'codex'];
  }
  return Object.freeze(config);
}

module.exports = { loadV3Config, boolEnv, intEnv, numberEnv, csvEnv, effortEnv, EFFORT_LEVELS };
