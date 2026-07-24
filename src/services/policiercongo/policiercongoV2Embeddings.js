/**
 * Embeddings Locaux (Transformers.js) pour la mémoire vectorielle PolicierCongo V2.
 * Utilise un modèle CPU léger (MiniLM-L6-v2) pour minimiser la RAM.
 */

'use strict';

const logger = require('../../utils/logger');

let _pipeline = null;
let _pipelinePromise = null;

/**
 * Charge le modèle de façon "lazy" pour économiser la RAM si non utilisé.
 *
 * IMPORTANT : mémoïse aussi la PROMESSE en cours de chargement, pas seulement le
 * résultat final. Sans ça, plusieurs appels concurrents (recherche + sauvegarde
 * mémoire lancées en parallèle) démarrent chacun leur propre chargement du modèle
 * (~1.3 Go chacun) avant que le premier ait fini → pic mémoire multiplié et OOM
 * (constaté en prod le 21/07/2026 : +2.5 Go en ~1s sous charge concurrente).
 */
async function getPipeline() {
  if (_pipeline) return _pipeline;
  if (_pipelinePromise) return _pipelinePromise;

  _pipelinePromise = (async () => {
    try {
      const { pipeline } = await import('@xenova/transformers');
      // Passage au modèle E5-Base (768-dim, beaucoup plus puissant)
      _pipeline = await pipeline('feature-extraction', 'Xenova/multilingual-e5-base');
      logger.info('[pc2.embed] Modèle d\'embeddings ELITE chargé (multilingual-e5-base).');
      return _pipeline;
    } catch (e) {
      logger.error(`[pc2.embed] Erreur chargement Transformers.js: ${e.message}`);
      _pipelinePromise = null; // permettre une nouvelle tentative plus tard
      return null;
    }
  })();

  return _pipelinePromise;
}

// Sérialise aussi les inférences elles-mêmes : deux appels concurrents à l'extracteur
// peuvent dupliquer les buffers internes du runtime WASM. Une seule inférence à la fois.
let _inferenceChain = Promise.resolve();
function runSerialized(fn) {
  const result = _inferenceChain.then(fn, fn);
  _inferenceChain = result.then(() => {}, () => {});
  return result;
}

/**
 * @param {{ model?: string, isQuery?: boolean }} [opts]
 * @returns {(text: string) => Promise<number[]>}
 */
function createLocalEmbedQuery(opts = {}) {
  /**
   * @param {string} text
   * @param {string} [inputType] 'search_query' ou 'search_document' (format Cohere/E5)
   */
  return async function embedQuery(text, inputType) {
    if (process.env.POLICIERCONGO_DISABLE_LOCAL_EMBED === 'true') return [];

    let t = String(text || '').trim().slice(0, 1024);
    if (!t) return [];

    // Mapping des types pour le modèle E5
    const isSearchQuery = inputType === 'search_query' || inputType === 'query' || opts.isQuery;
    const prefix = isSearchQuery ? 'query: ' : 'passage: ';

    if (!t.startsWith(prefix)) {
      t = prefix + t;
    }

    try {
      const extractor = await getPipeline();
      if (!extractor) return [];

      const output = await runSerialized(() => extractor(t, { pooling: 'mean', normalize: true }));
      return Array.from(output.data);
    } catch (e) {
      logger.warn(`[pc2.embed] Erreur embedding local (E5): ${e.message}`);
      return [];
    }
  };
}

/**
 * [LEGACY/CLOUDFRONT] Fallback Cohere si besoin
 */
function createCohereEmbedQuery(opts = {}) {
  const apiKey = opts.apiKey || process.env.COHERE_API_KEY;
  if (!apiKey) {
    logger.info('[pc2.embed] Pas de COHERE_API_KEY, passage au mode local.');
    return createLocalEmbedQuery();
  }

  const { CohereClient } = require('cohere-ai');
  const client = new CohereClient({ token: apiKey });
  const model = opts.model || 'embed-multilingual-v3.0';

  return async function embedQuery(text, inputType = 'search_query') {
    try {
      const { cohereEmbedOne } = require('./policiercongoV2Embeddings');
      return await cohereEmbedOne(client, text, inputType, model);
    } catch (e) {
      logger.warn(`[pc2.embed] Cohere: ${e.message}`);
      return [];
    }
  };
}

/**
 * @param {import('cohere-ai').CohereClient} client
 * @param {string} text
 * @param {string} inputType
 * @param {string} model
 */
async function cohereEmbedOne(client, text, inputType, model) {
  const t = String(text || '').trim().slice(0, 8000);
  if (!t) return [];
  const raw = await client.embed({ texts: [t], model, inputType, embeddingTypes: ['float'] });
  const data = raw && (raw.data !== undefined ? raw.data : raw);
  if (!data || !data.embeddings) return [];
  const row = Array.isArray(data.embeddings) ? data.embeddings[0] : (data.embeddings.float ? data.embeddings.float[0] : []);
  return Array.isArray(row) ? row : [];
}

function cosineSimilarity(a, b) {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

function rankByCosine(queryVec, rows, topK) {
  return rows
    .map((r) => ({
      id: String(r.id),
      score: cosineSimilarity(queryVec, r.embedding),
      metadata: { ...(typeof r.metadata === 'object' && r.metadata ? r.metadata : {}), snippet: r.source_text }
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = {
  createLocalEmbedQuery,
  createCohereEmbedQuery,
  cohereEmbedOne,
  cosineSimilarity,
  rankByCosine
};
