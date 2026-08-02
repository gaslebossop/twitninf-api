'use strict';

const { MEMORY_KINDS } = require('./constants');

const STOP_WORDS = new Set('a au aux avec ce ces dans de des du elle en et eux il je la le les leur lui ma mais me même mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous y est sont était être avoir fait comme plus'.split(' '));

/** Poids de rappel par type : une correction ou un engagement prime sur un épisode. */
const KIND_PRIORS = Object.freeze({
  [MEMORY_KINDS.CORRECTION]: 1,
  [MEMORY_KINDS.COMMITMENT]: 0.92,
  [MEMORY_KINDS.PREFERENCE]: 0.85,
  [MEMORY_KINDS.RELATIONSHIP]: 0.82,
  [MEMORY_KINDS.SELF]: 0.8,
  [MEMORY_KINDS.PROCEDURE]: 0.7,
  [MEMORY_KINDS.FACT]: 0.62,
  [MEMORY_KINDS.EPISODE]: 0.45
});

/** Une correction ne doit jamais s'effacer avec le temps ; un épisode oui. */
const KIND_HALF_LIFE_FACTOR = Object.freeze({
  [MEMORY_KINDS.CORRECTION]: 8,
  [MEMORY_KINDS.COMMITMENT]: 6,
  [MEMORY_KINDS.PREFERENCE]: 6,
  [MEMORY_KINDS.RELATIONSHIP]: 6,
  [MEMORY_KINDS.SELF]: 8,
  [MEMORY_KINDS.PROCEDURE]: 4,
  [MEMORY_KINDS.FACT]: 2,
  [MEMORY_KINDS.EPISODE]: 0.5
});

function normalize(value) {
  return String(value || '')
    .toLocaleLowerCase('fr')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function tokenize(value) {
  return normalize(value)
    .split(/[^a-z0-9_@#-]+/)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Clé d'entité stable pour une personne nommée.
 * `@Gas`, `gas` et `Gas ` produisent tous `user:gas`, ce qui permet de
 * retrouver une relation depuis n'importe quelle conversation.
 */
function entityKey(value) {
  const clean = normalize(value).replace(/^@/, '').replace(/[^a-z0-9_.-]/g, '');
  return clean ? `user:${clean}` : null;
}

/** Toutes les entités @mentionnées dans un texte libre. */
function extractEntityKeys(text) {
  const keys = new Set();
  for (const match of String(text || '').matchAll(/@([a-zA-Z0-9_.-]{2,32})/g)) {
    const key = entityKey(match[1]);
    if (key) keys.add(key);
  }
  return [...keys];
}

/**
 * Étale les similarités sémantiques sur l'ensemble des candidats.
 *
 * Les cosinus d'un modèle E5 vivent dans une bande étroite : sur un même jeu de
 * souvenirs on observe 0.77 à 0.83, bon souvenir compris. Utilisés bruts, ces
 * écarts de deux centièmes sont écrasés par l'importance et le type, et le
 * classement ignore le sens. Ce qui porte l'information, c'est la position
 * relative dans le lot, pas la valeur absolue.
 *
 * On garde malgré tout une part d'absolu : sans elle, le moins mauvais
 * candidat d'un lot entièrement hors sujet obtiendrait un score parfait.
 */
function spreadSemanticScores(scores) {
  if (scores.size < 2) return scores;
  const values = [...scores.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range < 0.02) return scores;

  const spread = new Map();
  for (const [id, value] of scores) {
    const normalized = (value - min) / range;
    spread.set(id, normalized * 0.65 + value * 0.35);
  }
  return spread;
}

function lexicalOverlap(wanted, words) {
  if (!wanted.size) return 0;
  const unique = new Set(words);
  let hits = 0;
  for (const word of wanted) if (unique.has(word)) hits += 1;
  return hits / wanted.size;
}

/**
 * Classement hybride de la mémoire longue.
 *
 * Le score combine proximité sémantique (embeddings) et lexicale, priorité du
 * type, importance, confiance, récence pondérée par type, fréquence de rappel
 * et correspondance d'entité. Les souvenirs épinglés remontent toujours.
 *
 * @param {object[]} candidates
 * @param {string} query
 * @param {{limit?:number, halfLifeDays?:number, semanticScores?:Map<string,number>,
 *          entityKeys?:string[], now?:number}} [options]
 */
function rankMemories(candidates, query, options = {}) {
  const { limit = 24, halfLifeDays = 45, semanticScores: rawSemantic = new Map(), entityKeys = [], now = Date.now() } = options;
  const wanted = new Set(tokenize(query));
  const wantedEntities = new Set([...entityKeys, ...extractEntityKeys(query)]);
  const semanticScores = spreadSemanticScores(rawSemantic);
  const hasSemantic = semanticScores.size > 0;

  const scored = (candidates || []).map(memory => {
    const tags = Array.isArray(memory.metadata?.tags) ? memory.metadata.tags : [];
    const words = tokenize(`${memory.content || ''} ${tags.join(' ')}`);
    const lexical = lexicalOverlap(wanted, words);
    const semantic = semanticScores.get(String(memory.id)) ?? null;

    // Sans vecteur disponible pour ce souvenir, le lexical reprend tout le
    // poids de la similarité : sinon un souvenir non vectorisé serait
    // injustement écrasé par ses voisins vectorisés.
    const similarity = semantic === null ? lexical : semantic * 0.72 + lexical * 0.28;
    const similarityWeight = hasSemantic ? 0.46 : 0.42;

    const kind = memory.kind || MEMORY_KINDS.FACT;
    const prior = KIND_PRIORS[kind] ?? 0.6;
    const importance = Number(memory.importance ?? 0.5);
    const confidence = Number(memory.confidence ?? 0.7);

    const timestamp = new Date(memory.updated_at || memory.created_at || 0).getTime();
    const ageDays = Math.max(0, now - timestamp) / 86400000;
    const effectiveHalfLife = Math.max(1, halfLifeDays * (KIND_HALF_LIFE_FACTOR[kind] ?? 1));
    const recency = Math.exp(-Math.log(2) * ageDays / effectiveHalfLife);

    const access = Math.min(1, Math.log2(2 + Number(memory.access_count || 0)) / 6);
    const entityHit = wantedEntities.size && memory.entity_key && wantedEntities.has(memory.entity_key) ? 1 : 0;

    const score = similarity * similarityWeight
      + prior * 0.14
      + importance * 0.14
      + confidence * 0.07
      + recency * 0.09
      + access * 0.03
      + entityHit * 0.07;

    // Le score exposé est le cosinus brut, pas la valeur étalée : c'est celui
    // qui est comparable d'une requête à l'autre lors d'un débogage.
    return { memory, score, semantic: rawSemantic.get(String(memory.id)) ?? null };
  });

  // Un souvenir épinglé est une garantie, pas une préférence : un simple bonus
  // de score le laissait passer derrière n'importe quelle correspondance
  // lexicale exacte. Ils sont donc placés en tête, classés entre eux.
  const byScore = (a, b) => b.score - a.score;
  const pinned = scored.filter(item => item.memory.pinned).sort(byScore);
  const rest = scored.filter(item => !item.memory.pinned).sort(byScore);
  const ordered = [...pinned, ...rest];

  // Diversité par type : évite qu'une avalanche d'épisodes noie les corrections
  // et préférences, qui sont les souvenirs qui changent réellement le
  // comportement. Le débordement sert de complément si la place reste libre.
  const perKindCap = Math.max(2, Math.ceil(limit * 0.35));
  const selected = [];
  const kindCounts = new Map();
  const overflow = [];

  for (const item of ordered) {
    const kind = item.memory.kind || MEMORY_KINDS.FACT;
    const used = kindCounts.get(kind) || 0;
    const enriched = {
      ...item.memory,
      relevance_score: Number(item.score.toFixed(4)),
      semantic_score: item.semantic === null ? null : Number(item.semantic.toFixed(4))
    };
    if (!item.memory.pinned && used >= perKindCap) {
      overflow.push(enriched);
      continue;
    }
    selected.push(enriched);
    kindCounts.set(kind, used + 1);
    if (selected.length >= limit) break;
  }

  for (const item of overflow) {
    if (selected.length >= limit) break;
    selected.push(item);
  }
  return selected;
}

module.exports = { tokenize, normalize, rankMemories, entityKey, extractEntityKeys, KIND_PRIORS, KIND_HALF_LIFE_FACTOR };
