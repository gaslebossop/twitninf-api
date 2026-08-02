const { GoogleGenAI } = require('@google/genai');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { User, Tweet } = require('../models');

// La liste vivait ici en dur, dupliquée avec celle de la modération : une clé
// révoquée n'était corrigée que d'un côté. Elle a déménagé dans
// `config/geminiKeys`, seule source désormais.
const { KEYS: GEMINI_KEYS } = require('../config/geminiKeys');
const SEARCH_SUMMARY_USE_MEGALLM = true;
const SEARCH_SUMMARY_MEGALLM_MODEL =  'gpt-5.4';

const CACHE_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'search-summary-cache.json');
let cacheLoaded = false;
let summaryCache = {};
let writeQueue = Promise.resolve();

const normalizeQuery = (query = '') => String(query).trim().replace(/\s+/g, ' ').replace(/^#+/, '#').toLowerCase();
const makeCacheKey = ({ query, type = 'all' }) => `${type}:${normalizeQuery(query)}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const emitProgressive = async (text, onChunk) => {
  const safeText = String(text || '');
  if (!safeText) return;

  // Stream "visible" meme quand Gemini renvoie un bloc d'un coup.
  const chunkSize = 8;
  for (let i = 0; i < safeText.length; i += chunkSize) {
    const part = safeText.slice(i, i + chunkSize);
    onChunk(part);
    await wait(12);
  }
};

const streamWithMegaLLM = async (prompt, onChunk) => {
  const megaModulePath = path.resolve(__dirname, '..', 'megallm-client', 'index.js');
  const megaModule = await import(pathToFileURL(megaModulePath).href);
  const MegaLLMClient = megaModule?.MegaLLMClient;
  if (!MegaLLMClient) {
    throw new Error('MegaLLMClient introuvable');
  }

  const sessionCandidates = [
    path.resolve(__dirname, '..', 'megallm-client', 'megallm-session.json'),
    path.resolve(process.cwd(), 'src', 'megallm-client', 'megallm-session.json')
  ];
  const sessionPath = sessionCandidates.find((p) => fs.existsSync(p));
  if (!sessionPath) {
    throw new Error('Fichier megallm-session.json introuvable');
  }

  const client = new MegaLLMClient(sessionPath);
  client.defaultModel = SEARCH_SUMMARY_MEGALLM_MODEL;
  logger.info(`🧠 MegaLLM summary stream mode=true via megallm-client model=${SEARCH_SUMMARY_MEGALLM_MODEL}`);
  const fullText = await client.generate(prompt, {
    model: SEARCH_SUMMARY_MEGALLM_MODEL,
    stream: true,
    temperature: 0.5,
    maxTokens: 4096,
    onChunk
  });
  return String(fullText || '').trim();
};

const ensureCacheLoaded = () => {
  if (cacheLoaded) return;
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      summaryCache = raw ? JSON.parse(raw) : {};
    } else {
      summaryCache = {};
      fs.writeFileSync(CACHE_FILE, JSON.stringify(summaryCache, null, 2), 'utf-8');
    }
  } catch (error) {
    logger.warn(`⚠️ Impossible de charger le cache de resumés: ${error.message}`);
    summaryCache = {};
  }
  cacheLoaded = true;
};

const persistCache = async () => {
  writeQueue = writeQueue
    .then(async () => {
      await fs.promises.mkdir(CACHE_DIR, { recursive: true });
      await fs.promises.writeFile(CACHE_FILE, JSON.stringify(summaryCache, null, 2), 'utf-8');
    })
    .catch((error) => {
      logger.error(`❌ Erreur lors de la sauvegarde du cache JSON: ${error.message}`);
    });
  return writeQueue;
};

const parseGeminiText = (response) => {
  if (response?.response && typeof response.response.text === 'function') {
    return response.response.text() || '';
  }
  if (typeof response?.text === 'function') {
    return response.text() || '';
  }
  if (typeof response?.text === 'string') {
    return response.text;
  }
  return '';
};

const buildPlannerPrompt = ({ query, type, users = [], tweets = [], hashtags = [] }) => `Tu es un planificateur de contexte pour l'app twitninf.
Objectif: decider si la recherche doit etre approfondie, puis proposer jusqu'a 5 queries d'approfondissement vraiment utiles.

Réponds uniquement en JSON strict:
{"need_more_context": true|false, "queries": ["...", "..."] }

Règles prioritaires:
- Si le contexte actuel suffit pour un bon resume: need_more_context=false et queries=[]
- Sinon: need_more_context=true et 1 a 5 queries courtes (1 a 3 termes max chacune)
- Interdit de refaire la meme recherche: ne jamais renvoyer la query initiale, ni sa variante hashtag/mention.
- La query d'approfondissement doit venir des signaux reels visibles dans les resultats.

Comment choisir une bonne query:
- Priorite 1: un compte/personne connexe qui ressort dans les resultats (auteur, personne mentionnee, acteur du sujet).
- Priorite 2: un mot-cle concret vu dans les tweets (nom propre, sujet, evenement, conflit, trend).
- Priorite 3: un hashtag reel present dans les resultats.
- Eviter les mots vides/generiques (ex: "vous", "votre", "bien", "normal", etc.).

Cas attendu (important):
- Si query initiale = "twitninf" et que les resultats montrent un drama/relation entre "gas" et "twitninf",
  alors une bonne query d'approfondissement est "gas" (ou "@gas" si pertinent), PAS "twitninf".

Formats autorises pour chaque query:
1) @username lie aux resultats
2) mot-cle pertinent extrait des tweets/resultats
3) hashtag pertinent extrait des resultats

Contexte actuel:
- query: "${query}"
- type: "${type}"
- users_count: ${users.length}
- tweets_count: ${tweets.length}
- hashtags_count: ${hashtags.length}
`;

const parsePlannerJson = (text) => {
  try {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return { need_more_context: false, queries: [] };
    const parsed = JSON.parse(match[0]);
    const needMore = !!parsed?.need_more_context;
    const rawQueries = Array.isArray(parsed?.queries)
      ? parsed.queries
      : (typeof parsed?.query === 'string' && parsed.query.trim() ? [parsed.query.trim()] : []);
    const queries = rawQueries
      .map((q) => String(q || '').trim())
      .filter(Boolean)
      .slice(0, 5);
    return { need_more_context: needMore, queries };
  } catch {
    return { need_more_context: false, queries: [] };
  }
};

const PLANNER_STOPWORDS = new Set([
  'vous', 'votre', 'vos', 'nous', 'notre', 'nos', 'ils', 'elles', 'leur', 'leurs',
  'je', 'tu', 'il', 'elle', 'on', 'moi', 'toi', 'lui', 'eux',
  'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'ou', 'donc', 'or', 'ni', 'car',
  'dans', 'sur', 'sous', 'avec', 'sans', 'pour', 'par', 'chez', 'entre', 'vers', 'contre',
  'que', 'qui', 'quoi', 'dont', 'ou', 'quand', 'comme', 'ainsi', 'alors',
  'est', 'sont', 'etre', 'a', 'au', 'aux', 'ce', 'cet', 'cette', 'ces', 'ca',
  'plus', 'moins', 'tres', 'bien', 'mal', 'encore', 'aussi', 'seulement', 'juste',
  'bonjour', 'salut', 'merci'
]);

const isLowSignalPlannerToken = (token, { allowHandles = false } = {}) => {
  const raw = String(token || '').trim().toLowerCase();
  if (!raw) return true;

  // Garder @compte / #hashtag, mais eviter des trucs trop courts.
  if (allowHandles && (raw.startsWith('@') || raw.startsWith('#'))) {
    const core = raw.replace(/^[@#]+/, '');
    return core.length < 2;
  }

  const core = raw.replace(/^[@#]+/, '');
  if (core.length < 4) return true;
  if (/^\d+$/.test(core)) return true;
  if (PLANNER_STOPWORDS.has(core)) return true;
  return false;
};

const buildFallbackPlannerQuery = ({ query, users = [], tweets = [], hashtags = [] }) => {
  const baseQueryTokens = new Set(
    normalizeQuery(query || '')
      .split(/\s+/)
      .map((t) => t.replace(/^[@#]+/, '').trim())
      .filter(Boolean)
  );

  // 1) Priorite hashtag pertinent different de la query initiale
  const sortedHashtags = [...(hashtags || [])].sort((a, b) => (b?.count || 0) - (a?.count || 0));
  for (const h of sortedHashtags) {
    const tag = String(h?.tag || '').trim().replace(/^#+/, '').toLowerCase();
    if (!tag || baseQueryTokens.has(tag)) continue;
    return `#${tag}`;
  }

  // 2) Priorite utilisateur connexe
  for (const u of users || []) {
    const username = String(u?.username || '').trim().replace(/^@+/, '').toLowerCase();
    if (!username || baseQueryTokens.has(username)) continue;
    return `@${username}`;
  }

  // 3) Extraire un terme frequent des tweets
  const tokenCounts = new Map();
  (tweets || []).forEach((t) => {
    const content = String(t?.content || '').toLowerCase();
    const tokens = content.match(/[a-z0-9_]{4,}/gi) || [];
    tokens.forEach((tok) => {
      if (baseQueryTokens.has(tok)) return;
      if (isLowSignalPlannerToken(tok)) return;
      tokenCounts.set(tok, (tokenCounts.get(tok) || 0) + 1);
    });
  });

  let bestToken = '';
  let bestCount = 0;
  for (const [tok, count] of tokenCounts.entries()) {
    if (count > bestCount) {
      bestToken = tok;
      bestCount = count;
    }
  }

  return bestToken || '';
};

const sanitizePlannerQuery = (candidateQuery, baseContext) => {
  const candidate = String(candidateQuery || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

  if (!candidate) return '';
  const candidateTokens = candidate.match(/[@#]?[a-z0-9_]{2,}/gi) || [];
  const normalizedTokens = candidateTokens
    .map((tok) => tok.trim().toLowerCase())
    .filter((tok) => !isLowSignalPlannerToken(tok, { allowHandles: true }))
    .map((tok) => tok.replace(/^[@#]+/, '').trim())
    .filter(Boolean);

  // 1 a 4 termes max pour garder une requete courte et exploitable
  const unique = Array.from(new Set(normalizedTokens)).slice(0, 4);
  if (unique.length === 0) return '';

  const baseQueryTokens = normalizeQuery(baseContext?.query || '')
    .split(/\s+/)
    .map((t) => t.replace(/^[@#]+/, '').trim())
    .filter(Boolean);
  const baseQuerySet = new Set(baseQueryTokens);
  const baseRaw = normalizeQuery(baseContext?.query || '').replace(/^#+/, '');
  const sameAsBase = unique.every((t) => baseQueryTokens.includes(t));
  if (sameAsBase) {
    return '';
  }

  // Bloquer toute requete candidate qui retombe exactement sur le mot-cle principal
  // ou ses variantes hashtag/mention.
  const candidateNoPrefix = candidate.replace(/^[@#]+/, '');
  if (
    candidate === normalizeQuery(baseContext?.query || '') ||
    candidateNoPrefix === baseRaw ||
    candidate === `#${baseRaw}` ||
    candidate === `@${baseRaw}`
  ) {
    return '';
  }

  // Eviter une requete qui ne fait que recycler les tokens exacts de la query initiale.
  const allFromBase = unique.every((t) => baseQuerySet.has(t));
  if (allFromBase) {
    return '';
  }

  return unique.join(' ');
};

const sanitizePlannerQueries = (candidateQueries, baseContext) => {
  const seen = new Set();
  const safeQueries = [];

  (candidateQueries || []).forEach((q) => {
    const clean = sanitizePlannerQuery(q, baseContext);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    safeQueries.push(clean);
  });

  return safeQueries.slice(0, 5);
};

const maybeFetchAdditionalContext = async ({ query, type, users, tweets, hashtags }) => {
  try {
    logger.info(`🧭 Planner start query="${query}" type="${type}" users=${users.length} tweets=${tweets.length} hashtags=${hashtags.length}`);

    // Planification via MegaLLM (GPT-5.4) pour décider si on enrichit.
    const plannerPrompt = buildPlannerPrompt({ query, type, users, tweets, hashtags });
    let plannerText = '';
    try {
      plannerText = await streamWithMegaLLM(plannerPrompt, () => {});
    } catch (plannerMegaError) {
      logger.warn(`⚠️ Planner MegaLLM indisponible, fallback Gemini: ${plannerMegaError.message}`);
      const ai = new GoogleGenAI({ apiKey: GEMINI_KEYS[0] });
      const plannerResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: plannerPrompt
      });
      plannerText = parseGeminiText(plannerResponse);
    }
    const plan = parsePlannerJson(plannerText);
    logger.info(`🧭 Planner decision need_more_context=${plan.need_more_context} queries=${JSON.stringify(plan.queries || [])}`);

    let plannedQueries = Array.isArray(plan.queries) ? [...plan.queries] : [];
    let needMoreContext = plan.need_more_context;

    // Fallback: si l'IA ne propose rien, on tente une requete d'approfondissement deterministe.
    if (plannedQueries.length === 0) {
      const fallbackQuery = buildFallbackPlannerQuery({ query, users, tweets, hashtags });
      if (fallbackQuery) {
        plannedQueries = [fallbackQuery];
        needMoreContext = true;
        logger.info(`🧭 Planner fallback query="${fallbackQuery}"`);
      }
    }

    if (!needMoreContext || plannedQueries.length === 0) {
      logger.info('🧭 Planner stop: aucun enrichissement necessaire');
      return { users, tweets, hashtags, planner: { need_more_context: false, queries: [] } };
    }

    // Sanitize: eviter les doublons/triviales, mais sans verrou ultra strict.
    const safeQueries = sanitizePlannerQueries(plannedQueries, { query, users, tweets, hashtags });
    if (safeQueries.length === 0) {
      logger.info('ℹ️ Planner query ignoree (vide, dupliquee, ou trop proche de la query initiale)');
      return { users, tweets, hashtags, planner: { need_more_context: false, queries: [] } };
    }

    const mergedUsersMap = new Map();
    [...users].forEach((u) => {
      if (u?.id) mergedUsersMap.set(String(u.id), u);
    });

    const mergedTweetsMap = new Map();
    [...tweets].forEach((t) => {
      if (t?.id) mergedTweetsMap.set(String(t.id), t);
    });

    for (const safeQuery of safeQueries) {
      logger.info(`🔎 Summary planner demande contexte additionnel (safe): "${safeQuery}"`);
      const [extraUsers, extraTweets] = await Promise.all([
        User.searchUsers(safeQuery, 8),
        Tweet.searchTweets(safeQuery, {
          limit: 10,
          includeReplies: false,
          includeRetweets: true,
          sortBy: 'created_at',
          sortOrder: 'DESC'
        })
      ]);

      [...(extraUsers || [])].forEach((u) => {
        if (u?.id) mergedUsersMap.set(String(u.id), u);
      });
      [...(extraTweets || [])].forEach((t) => {
        if (t?.id) mergedTweetsMap.set(String(t.id), t);
      });
    }

    return {
      users: Array.from(mergedUsersMap.values()),
      tweets: Array.from(mergedTweetsMap.values()),
      hashtags,
      planner: { need_more_context: true, queries: safeQueries }
    };
  } catch (error) {
    logger.warn(`⚠️ Planner contexte additionnel indisponible: ${error.message}`);
    return { users, tweets, hashtags, planner: { need_more_context: false, queries: [] } };
  }
};

const buildSearchSummaryPrompt = ({ query, type, users = [], tweets = [], hashtags = [] }) => {
  const usersContext = users.slice(0, 10).map((u) => ({
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    verified: !!u.verified,
    followers: u.stats?.followers || 0
  }));

  const tweetsContext = tweets.slice(0, 12).map((t) => ({
    id: t.id,
    user_id: t.user_id || t.author?.id || null,
    author: t.author?.username || t.user?.username || 'inconnu',
    content: (t.content || '').substring(0, 220),
    hashtags: t.hashtags || [],
    likes: t.stats?.likes || 0,
    retweets: t.stats?.retweets || 0
  }));

  const hashtagsContext = hashtags.slice(0, 12).map((h) => ({
    tag: h.tag,
    count: h.count || 0
  }));

  return `Tu es l'assistant de recherche de l'application twitninf.
Ta mission: expliquer rapidement les resultats d'une recherche utilisateur.

Contraintes:
- Reponds en francais naturel, simple et utile.
- Max 120 mots.
- 1 petit paragraphe + 2 ou 3 points courts.
- Sois explicatif (qui ressort, de quoi on parle, contexte hashtag/compte/sujet).
- Priorise la mention des comptes (utilisateurs/auteurs) qui ressortent dans les resultats.
- Le contenu doit etre interessant: priorise sujets concrets, infos utiles, oppositions/dynamiques entre comptes, et elements actionnables.
- N'analyse JAMAIS le style d'ecriture, le ton litteraire, la ponctuation, ou la "facon d'ecrire" des tweets.
- Ne jamais inventer des informations absentes du contexte.
- Quand tu cites un utilisateur du contexte, ajoute le tag [USER:<id>].
- Quand tu cites un tweet du contexte, ajoute le tag [TWEET:<id>].
- Utilise uniquement des ids presents dans le contexte.

Recherche:
- terme: "${query}"
- filtre: "${type}"

Contexte utilisateurs:
${JSON.stringify(usersContext)}

Contexte tweets:
${JSON.stringify(tweetsContext)}

Contexte hashtags:
${JSON.stringify(hashtagsContext)}

Retourne uniquement le texte final (pas de JSON, pas de markdown).`;
};

const buildAdditionalSummaryPrompt = ({ query, type, mainSummary, users = [], tweets = [], hashtags = [] }) => {
  const usersContext = users.slice(0, 8).map((u) => ({
    id: u.id,
    username: u.username,
    followers: u.stats?.followers || 0
  }));

  const tweetsContext = tweets.slice(0, 8).map((t) => ({
    id: t.id,
    author: t.author?.username || t.user?.username || 'inconnu',
    content: (t.content || '').substring(0, 180)
  }));

  const hashtagsContext = hashtags.slice(0, 8).map((h) => ({ tag: h.tag, count: h.count || 0 }));

  return `Tu es l'assistant de recherche de l'application twitninf.
Tu dois ajouter UN COMPLEMENT au resume principal, sans le repeter.

Contraintes:
- Max 60 mots.
- Apporte uniquement de la valeur additionnelle.
- Si rien de pertinent a ajouter, reponds: "Aucun complement pertinent."
- Quand tu cites un utilisateur, ajoute [USER:<id>].
- Quand tu cites un tweet, ajoute [TWEET:<id>].

Recherche:
- terme: "${query}"
- filtre: "${type}"

Resume principal deja affiche:
${mainSummary}

Contexte additionnel utilisateurs:
${JSON.stringify(usersContext)}

Contexte additionnel tweets:
${JSON.stringify(tweetsContext)}

Contexte additionnel hashtags:
${JSON.stringify(hashtagsContext)}

Retourne uniquement le texte final (pas de JSON, pas de markdown).`;
};

const generateWithConfiguredProvider = async (prompt, onChunk) => {
  let lastError = null;

  if (SEARCH_SUMMARY_USE_MEGALLM) {
    try {
      logger.info(`🧠 Search summary provider: MegaLLM (${SEARCH_SUMMARY_MEGALLM_MODEL})`);
      const fullText = await streamWithMegaLLM(prompt, onChunk);
      return { success: true, text: String(fullText || '').trim(), provider: 'megallm' };
    } catch (error) {
      lastError = error;
      logger.error(`❌ Echec MegaLLM summary stream, fallback Gemini: ${error.message}`);
    }
  }

  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try {
      const ai = new GoogleGenAI({ apiKey: GEMINI_KEYS[i] });
      const stream = await ai.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: prompt
      });

      let fullText = '';
      for await (const chunk of stream) {
        const chunkText = parseGeminiText(chunk);
        if (!chunkText) continue;
        fullText += chunkText;
        await emitProgressive(chunkText, onChunk);
      }

      return { success: true, text: fullText.trim(), provider: 'gemini' };
    } catch (error) {
      lastError = error;
      logger.warn(`⚠️ Echec Gemini stream clé #${i + 1}: ${error.message}`);
    }
  }

  if (lastError) {
    logger.error('❌ Echec final generation summary:', lastError);
  }
  return { success: false, text: '', provider: null };
};

async function streamSearchSummary({
  query,
  type = 'all',
  users = [],
  tweets = [],
  hashtags = [],
  onChunk = () => {},
  onStatus = () => {}
}) {
  const totalResults = (users?.length || 0) + (tweets?.length || 0) + (hashtags?.length || 0);
  if (totalResults < 5) {
    return { success: true, text: '', skipped: true, reason: 'not_enough_results' };
  }

  ensureCacheLoaded();
  const cacheKey = makeCacheKey({ query, type });
  const cachedEntry = summaryCache[cacheKey];
  if (cachedEntry?.text) {
    // Cache hit: reponse immediate pour accelerer fortement les 2e generations.
    onChunk(cachedEntry.text);
    return { success: true, text: cachedEntry.text, cached: true };
  }

  const prompt = buildSearchSummaryPrompt({
    query,
    type,
    users,
    tweets,
    hashtags
  });
  const mainResult = await generateWithConfiguredProvider(prompt, onChunk);
  if (!mainResult.success || !mainResult.text) {
    const fallbackText = 'Je n’ai pas pu generer un resume intelligent pour cette recherche maintenant.';
    await emitProgressive(fallbackText, onChunk);
    return { success: false, text: fallbackText, cached: false };
  }

  let finalText = mainResult.text.trim();

  // Planner desactive: on garde uniquement le resume sur les resultats initiaux.
  onStatus('');

  summaryCache[cacheKey] = {
    key: cacheKey,
    query: normalizeQuery(query),
    type,
    text: finalText,
    provider: mainResult.provider || 'unknown',
    model: SEARCH_SUMMARY_USE_MEGALLM ? SEARCH_SUMMARY_MEGALLM_MODEL : 'gemini-2.5-flash',
    created_at: new Date().toISOString()
  };
  await persistCache();

  return { success: true, text: finalText, cached: false, provider: mainResult.provider };
}

module.exports = {
  streamSearchSummary
};
