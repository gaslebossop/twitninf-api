'use strict';

/**
 * Couche sémantique de la mémoire V3.
 *
 * Réutilise le modèle d'embeddings local déjà chargé par le V2
 * (`policiercongoV2Embeddings`, multilingual-e5-base, 768 dim) au lieu d'en
 * charger un second : le module mémoïse son pipeline et sérialise ses
 * inférences, donc partager la même instance évite de doubler la RAM.
 *
 * Tout ici est best-effort : si le modèle est indisponible, `embed` renvoie
 * null et la mémoire retombe sur le classement purement lexical. Aucune
 * fonction de ce fichier ne doit jamais faire échouer un run.
 */

const EMBEDDING_MODEL = 'local:multilingual-e5-base';
const MAX_CONSECUTIVE_FAILURES = 5;

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dot / denominator : 0;
}

/** Vecteur lisible depuis une colonne JSONB, une chaîne JSON ou un tableau brut. */
function parseVector(value) {
  if (Array.isArray(value)) return value.every(Number.isFinite) ? value : null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every(Number.isFinite) ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

class MemoryEmbedder {
  constructor({ config = {}, logger = console } = {}) {
    this.config = config;
    this.logger = logger;
    this.model = EMBEDDING_MODEL;
    this.failures = 0;
    this.embedFn = null;
    this.cache = new Map();
    this.cacheLimit = 512;
  }

  available() {
    return this.config.memoryEmbeddingsEnabled !== false && this.failures < MAX_CONSECUTIVE_FAILURES;
  }

  loadFn() {
    if (!this.embedFn) {
      const { createLocalEmbedQuery } = require('../policiercongoV2Embeddings');
      this.embedFn = createLocalEmbedQuery();
    }
    return this.embedFn;
  }

  /**
   * @param {string} text
   * @param {'document'|'query'} role E5 distingue les passages des requêtes.
   * @returns {Promise<number[]|null>}
   */
  async embed(text, role = 'document') {
    if (!this.available()) return null;
    const clean = String(text || '').trim();
    if (clean.length < 3) return null;

    const cacheKey = `${role}:${clean.slice(0, 512)}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    try {
      const embed = this.loadFn();
      const vector = await embed(clean, role === 'query' ? 'search_query' : 'search_document');
      if (!Array.isArray(vector) || !vector.length) {
        this.failures += 1;
        return null;
      }
      this.failures = 0;
      if (this.cache.size >= this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(cacheKey, vector);
      return vector;
    } catch (error) {
      this.failures += 1;
      this.logger.warn?.(`[pc3.embed] ${error.message}`);
      return null;
    }
  }
}

/**
 * Similarité cosinus entre une requête et chaque candidat porteur d'un vecteur.
 * @returns {Map<string, number>} id -> score dans [0,1]
 */
function scoreSemantic(queryVector, rows) {
  const scores = new Map();
  if (!Array.isArray(queryVector) || !queryVector.length) return scores;
  for (const row of rows || []) {
    const vector = parseVector(row.embedding);
    if (!vector || vector.length !== queryVector.length) continue;
    scores.set(String(row.id), Math.max(0, cosine(queryVector, vector)));
  }
  return scores;
}

/**
 * Le souvenir actif le plus proche d'un nouveau contenu, dans le même périmètre.
 * Sert à détecter qu'une correction contredit un souvenir existant.
 */
function findClosest(vector, rows, { minScore = 0.86, excludeIds = new Set() } = {}) {
  if (!Array.isArray(vector) || !vector.length) return null;
  let best = null;
  for (const row of rows || []) {
    if (excludeIds.has(String(row.id))) continue;
    const candidate = parseVector(row.embedding);
    if (!candidate || candidate.length !== vector.length) continue;
    const score = cosine(vector, candidate);
    if (score >= minScore && (!best || score > best.score)) best = { row, score };
  }
  return best;
}

module.exports = { MemoryEmbedder, cosine, parseVector, scoreSemantic, findClosest, EMBEDDING_MODEL };
