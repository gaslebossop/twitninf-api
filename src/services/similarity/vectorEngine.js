/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  VECTOR ENGINE — Moteur vectoriel local ultra-performant (Pure JS)
 *
 *  Trois modules fusionnés pour la vitesse :
 *    1. VectorMath   — cosine, normalize, EWMA, top-K en O(n)
 *    2. HashVectorizer — TF-IDF via hashing trick (zéro vocabulaire, instant)
 *    3. VectorStore  — Index en RAM + persistance binaire
 *
 *  Perf :  cosine 256-dim → ~0.002ms
 *          search 10K vecs → ~2ms
 *          vectorize tweet → ~0.05ms
 *
 *  Zéro dépendance externe. Pure JS. Compatible Node ≥16.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DIMS = 768;                  // Dimension des vecteurs (E5-Base)
const HASH_SEED = 0x9E3779B9;     // FNV-like seed
const EWMA_ALPHA = 0.85;          // Facteur de mémoire pour les user vectors
const MAX_NGRAM = 3;              // 1-gram + 2-gram + 3-gram

// ─────────────────────────────────────────────────────────────────────────────
//  STOPWORDS (FR + EN, les plus fréquents)
// ─────────────────────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  // FR — Déterminants, pronoms, prépositions, conjonctions
  'le','la','les','de','du','des','un','une','et','en','est','je','tu','il',
  'elle','nous','vous','ils','elles','ce','se','ne','pas','que','qui','quoi',
  'dans','sur','pour','par','avec','au','aux','son','sa','ses','mon','ma',
  'mes','ton','ta','tes','mais','ou','donc','car','ni','si','plus','très',
  'tout','tous','bien','aussi','fait','être','avoir','faire','dire','aller',
  'comme','cette','ces','dont','lui','leur','même','encore','entre','après',
  'avant','sans','sous','vers','chez','aussi','peu','trop','assez','ici',
  'là','quand','comment','pourquoi','votre','notre','on','me','te','soi',
  // FR — Verbes fréquents conjugués
  'suis','es','sommes','êtes','sont','ai','as','avons','avez','ont',
  'sera','serai','fera','vais','vas','va','allons','allez','vont',
  'été','eu','fais','faites','font','dit','dis','dites','peut','peux',
  'peuvent','veut','veux','veulent','doit','dois','doivent','sait','sais',
  'savent','voit','vois','voient','prend','prends','prennent',
  // FR — Mots de liaison et transition
  'alors','ainsi','cependant','néanmoins','toutefois','pourtant','enfin',
  'ensuite','puis','surtout','depuis','pendant','jusqu','jusque','déjà',
  'toujours','jamais','souvent','parfois','vraiment','juste','tellement',
  'quelque','quelques','chaque','autre','autres','aucun','aucune',
  'certain','certains','certaine','certaines','plusieurs','beaucoup',
  // EN — Full common set
  'the','be','to','of','and','a','in','that','have','i','it','for','not',
  'on','with','he','as','you','do','at','this','but','his','by','from',
  'they','we','say','her','she','or','an','will','my','one','all','would',
  'there','their','what','so','up','out','if','about','who','get','which',
  'go','me','when','make','can','like','time','no','just','him','know',
  'take','people','into','year','your','good','some','could','them','see',
  'other','than','then','now','look','only','come','its','over','think',
  'also','back','after','use','two','how','our','work','first','well',
  'way','even','new','want','because','any','these','give','day','most',
  'us','was','is','are','were','been','has','had','did','does',
  'should','might','must','shall','may','need','let','got',
  'very','really','much','still','already','again','being','those',
  'here','where','why','each','between','under','before','through',
  'during','while','though','although','such','same','both',
  // Common short / noise / internet speak
  'rt','http','https','www','com','lol','mdr','ptdr','omg','ok','oui','non',
  'ca','ça','ya','nan','bah','bon','ah','oh','hein','euh','ptn','jsp',
  'cc','svp','stp','pk','pcq','pr','tt','tkt','nn','wsh','frr','srx',
  'ui','tmtc','nrv','chui','jpense','jcrois','jveux','jsais','jvais'
]);

// ═════════════════════════════════════════════════════════════════════════════
//  MODULE 1 — VECTOR MATH
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Crée un vecteur vide de dimension DIMS.
 */
function createVec() {
  return new Float32Array(DIMS);
}

/**
 * Hash rapide d'un token → index [0, DIMS).
 * FNV-1a variant, très rapide en JS.
 */
function hashToken(token) {
  let h = HASH_SEED;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % DIMS);
}

/**
 * Hash secondaire pour le signe (+1/-1), réduit les collisions.
 */
function hashSign(token) {
  let h = 0x811C9DC5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h & 1) ? 1.0 : -1.0;
}

/**
 * Norme L2 d'un vecteur.
 */
function vecNorm(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/**
 * Normalise un vecteur en place (L2).
 */
function vecNormalize(v) {
  const n = vecNorm(v);
  if (n > 1e-10) {
    for (let i = 0; i < v.length; i++) v[i] /= n;
  }
  return v;
}

/**
 * Produit scalaire.
 */
function vecDot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/**
 * Cosine similarity entre deux vecteurs PRÉ-NORMALISÉS.
 * = produit scalaire (puisque ||a|| = ||b|| = 1).
 */
function cosineSim(a, b) {
  return vecDot(a, b); // déjà normalisés
}

/**
 * Cosine similarity entre deux vecteurs NON normalisés.
 */
function cosineSimRaw(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

/**
 * Mise à jour EWMA d'un vecteur utilisateur.
 * userVec = α * userVec + (1-α) * weight * tweetVec
 */
function vecEWMA(userVec, tweetVec, weight = 1.0) {
  const beta = (1 - EWMA_ALPHA) * weight;
  for (let i = 0; i < userVec.length; i++) {
    userVec[i] = EWMA_ALPHA * userVec[i] + beta * tweetVec[i];
  }
  return vecNormalize(userVec);
}

/**
 * Additionne un vecteur pondéré à un accumulateur.
 */
function vecAddWeighted(acc, vec, weight) {
  for (let i = 0; i < acc.length; i++) {
    acc[i] += weight * vec[i];
  }
}

/**
 * Top-K par score (Partial sort, O(n) pour petit K).
 *
 * Toujours utilisée ailleurs dans le dépôt (`recommendationEngine.js`) —
 * `VectorStore.search()` n'en a plus besoin depuis l'AUDIT R4-06
 * (2026-08-19) : elle maintient désormais son propre tampon borné pendant
 * le parcours, au lieu d'allouer la liste complète puis de la trier ici.
 */
function topK(items, k) {
  if (items.length <= k) {
    return items.sort((a, b) => b.score - a.score);
  }
  // Quick select approach pour les grands arrays
  const result = items.slice(0, k).sort((a, b) => b.score - a.score);
  let minScore = result[k - 1].score;
  for (let i = k; i < items.length; i++) {
    if (items[i].score > minScore) {
      result[k - 1] = items[i];
      result.sort((a, b) => b.score - a.score);
      minScore = result[k - 1].score;
    }
  }
  return result;
}


// ═════════════════════════════════════════════════════════════════════════════
//  MODULE 2 — HASH VECTORIZER (TF-IDF via Hashing Trick)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Tokenize un texte : lowercase, split, remove stopwords, n-grams.
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];

  // Nettoyage : lowercase, remove URLs, mentions, emojis (garder alphanumérique + accents)
  const clean = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')           // URLs
    .replace(/@[\w]+/g, '')                     // @mentions
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')       // garder lettres/chiffres/espaces
    .replace(/\s+/g, ' ')
    .trim();

  const words = clean.split(' ').filter(w => w.length >= 2 && !STOPWORDS.has(w));

  // 1-grams
  const tokens = [...words];

  // 2-grams
  if (MAX_NGRAM >= 2) {
    for (let i = 0; i < words.length - 1; i++) {
      tokens.push(words[i] + '_' + words[i + 1]);
    }
  }

  // 3-grams (captures richer semantic context)
  if (MAX_NGRAM >= 3) {
    for (let i = 0; i < words.length - 2; i++) {
      tokens.push(words[i] + '_' + words[i + 1] + '_' + words[i + 2]);
    }
  }

  return tokens;
}

/**
 * Vectorise un texte via hashing trick.
 * Retourne un Float32Array normalisé de dimension DIMS.
 */
function vectorize(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;

  const vec = createVec();

  // Compter les fréquences (TF)
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }

  // Hash + signed projection
  for (const [token, count] of Object.entries(tf)) {
    const idx = hashToken(token);
    const sign = hashSign(token);
    // TF log-normalisé
    const weight = sign * (1 + Math.log(count));
    vec[idx] += weight;
  }

  return vecNormalize(vec);
}


// ═════════════════════════════════════════════════════════════════════════════
//  MODULE 3 — VECTOR STORE (In-Memory + Binary Persistence)
// ═════════════════════════════════════════════════════════════════════════════

class VectorStore {
  /**
   * @param {string} name     - Nom du store (ex: 'tweets', 'users')
   * @param {string} dataDir  - Répertoire de persistance
   */
  constructor(name, dataDir) {
    this.name = name;
    this.dataDir = dataDir;

    /** @type {Map<string, Float32Array>} id → vecteur normalisé */
    this.index = new Map();

    this.stats = {
      inserts: 0,
      searches: 0,
      avgSearchMs: 0,
    };
  }

  /** Nombre de vecteurs en mémoire */
  get size() { return this.index.size; }

  /**
   * Ajoute ou met à jour un vecteur.
   * @param {string} id
   * @param {Float32Array} vec - doit être normalisé
   */
  upsert(id, vec) {
    // Le format binaire de save() suppose un Float32Array de DIMS floats.
    // On refuse ici tout ce qui ne l'est pas : sinon l'erreur ne surgit qu'à la
    // sauvegarde, où elle fait échouer l'index entier sans désigner le coupable.
    if (!(vec instanceof Float32Array) || vec.length !== DIMS) {
      console.warn(
        `⚠️ [VectorStore:${this.name}] upsert(${id}) refusé : ` +
        `attendu Float32Array(${DIMS}), reçu ${vec && vec.constructor ? vec.constructor.name : typeof vec}` +
        `(${vec && vec.length !== undefined ? vec.length : '?'})`
      );
      return false;
    }
    this.index.set(id, vec);
    this.stats.inserts++;
    return true;
  }

  /**
   * Récupère un vecteur.
   */
  get(id) {
    return this.index.get(id) || null;
  }

  /**
   * Supprime un vecteur.
   */
  delete(id) {
    return this.index.delete(id);
  }

  /**
   * Vérifie si un vecteur existe.
   */
  has(id) {
    return this.index.has(id);
  }

  /**
   * Recherche les K vecteurs les plus similaires à queryVec.
   * @param {Float32Array} queryVec - vecteur normalisé
   * @param {number} k
   * @param {Set<string>} [exclude] - IDs à exclure
   * @returns {Array<{id: string, score: number}>}
   */
  search(queryVec, k = 20, exclude = null) {
    const t0 = Date.now();

    // AUDIT R4-06 (2026-08-19) : l'ancienne version allouait un objet
    // `{id, score}` par entrée de l'index — y compris pour les 99,98 % que
    // `topK` jetterait ensuite — avant de tout trier. Ici, un tampon borné à
    // `k` (tri par insertion sur un tableau minuscule) : la pression mémoire
    // et la collecte qui suivait disparaissent. Le calcul du score, lui,
    // reste entier — c'est le découpage en tranches (asynchrone) qui
    // supprimerait le gel restant, pas ce point-ci.
    const results = [];
    let minScore = -Infinity;

    for (const [id, vec] of this.index) {
      if (exclude && exclude.has(id)) continue;
      const score = cosineSim(queryVec, vec);

      if (results.length < k) {
        // Insertion triée (ordre décroissant) tant que le tampon n'est pas plein.
        let i = results.length;
        while (i > 0 && results[i - 1].score < score) {
          results[i] = results[i - 1];
          i--;
        }
        results[i] = { id, score };
        if (results.length === k) minScore = results[k - 1].score;
      } else if (score > minScore) {
        // Remplace le pire élément du tampon, puis le repositionne.
        let i = k - 1;
        while (i > 0 && results[i - 1].score < score) {
          results[i] = results[i - 1];
          i--;
        }
        results[i] = { id, score };
        minScore = results[k - 1].score;
      }
    }

    const elapsed = Date.now() - t0;

    this.stats.searches++;
    this.stats.avgSearchMs =
      (this.stats.avgSearchMs * (this.stats.searches - 1) + elapsed) / this.stats.searches;

    return results;
  }

  /**
   * Recherche batch : pour chaque query, retourne les top-K.
   * Plus efficace que N appels search() individuels.
   */
  searchBatch(queryVecs, k = 20, exclude = null) {
    return queryVecs.map(({ id: qId, vec }) => ({
      queryId: qId,
      results: this.search(vec, k, exclude)
    }));
  }

  // ─── Persistance binaire ──────────────────────────────────────────────────

  /**
   * Format binaire :
   *   [4 bytes] uint32 : nombre d'entrées (N)
   *   [4 bytes] uint32 : dimension (DIMS)
   *   Répété N fois :
   *     [4 bytes]        uint32    : longueur de l'ID en bytes
   *     [id_len bytes]   UTF-8     : ID
   *     [DIMS * 4 bytes] float32[] : vecteur
   */
  // AUDIT R4-03 (2026-08-19) : `fs.writeFileSync` bloquait le fil principal
  // jusqu'à la fin de l'écriture (~1,4 s mesurés à 100 000 vecteurs, deux
  // fois par appel de `_periodicSave` — un gel total du processus, pas une
  // requête ralentie), toutes les 5 minutes. Passage en asynchrone, plus une
  // écriture atomique (fichier temporaire puis renommage) : un redémarrage
  // pendant l'écriture ne laisse plus de `.vdb` tronqué.
  async save() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      const entries = [...this.index.entries()];
      if (entries.length === 0) return;

      // Calculer la taille totale
      let totalSize = 8; // header
      for (const [id] of entries) {
        totalSize += 4 + Buffer.byteLength(id, 'utf8') + DIMS * 4;
      }

      const buf = Buffer.alloc(totalSize);
      let offset = 0;

      // Header
      buf.writeUInt32LE(entries.length, offset); offset += 4;
      buf.writeUInt32LE(DIMS, offset); offset += 4;

      // Entries
      for (const [id, vec] of entries) {
        const idBuf = Buffer.from(id, 'utf8');
        buf.writeUInt32LE(idBuf.length, offset); offset += 4;
        idBuf.copy(buf, offset); offset += idBuf.length;
        Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).copy(buf, offset);
        offset += DIMS * 4;
      }

      const filePath = path.join(this.dataDir, `${this.name}.vdb`);
      const tmpPath = `${filePath}.tmp`;
      await fs.promises.writeFile(tmpPath, buf);
      await fs.promises.rename(tmpPath, filePath);
      return entries.length;
    } catch (err) {
      logger.error(`❌ [VectorStore:${this.name}] Erreur sauvegarde: ${err.message}`);
      return 0;
    }
  }

  /**
   * Charge l'index depuis le fichier binaire.
   */
  load() {
    try {
      const filePath = path.join(this.dataDir, `${this.name}.vdb`);

      // AUDIT B2-05 (2026-08-19) : un `.tmp` résiduel ne peut provenir que
      // d'un `save()` interrompu (crash/redémarrage) — `save()` le supprime
      // toujours lui-même via le `rename` qui le remplace. Purger ici, avant
      // toute lecture, évite qu'il traîne indéfiniment dans `dataDir`.
      const tmpPath = `${filePath}.tmp`;
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
        console.warn(`⚠️ [VectorStore:${this.name}] ${tmpPath} résiduel supprimé (sauvegarde interrompue précédente)`);
      }

      if (!fs.existsSync(filePath)) return 0;

      const buf = fs.readFileSync(filePath);
      let offset = 0;

      const count = buf.readUInt32LE(offset); offset += 4;
      const dims = buf.readUInt32LE(offset); offset += 4;

      if (dims !== DIMS) {
        console.warn(`⚠️ [VectorStore:${this.name}] Dimension mismatch ${dims} vs ${DIMS}, skip load`);
        return 0;
      }

      this.index.clear();

      for (let i = 0; i < count; i++) {
        const idLen = buf.readUInt32LE(offset); offset += 4;
        const id = buf.toString('utf8', offset, offset + idLen); offset += idLen;
        const vec = new Float32Array(DIMS);
        for (let d = 0; d < DIMS; d++) {
          vec[d] = buf.readFloatLE(offset); offset += 4;
        }
        this.index.set(id, vec);
      }

      console.log(`📂 [VectorStore:${this.name}] ${this.index.size} vecteurs chargés depuis ${filePath}`);
      return this.index.size;
    } catch (err) {
      logger.error(`❌ [VectorStore:${this.name}] Erreur chargement: ${err.message}`);
      return 0;
    }
  }

  /**
   * Retourne les statistiques du store.
   */
  getStats() {
    return {
      name: this.name,
      size: this.index.size,
      dims: DIMS,
      ...this.stats,
    };
  }
}


// ═════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Constants
  DIMS,
  EWMA_ALPHA,

  // Math
  createVec,
  vecNorm,
  vecNormalize,
  vecDot,
  cosineSim,
  cosineSimRaw,
  vecEWMA,
  vecAddWeighted,
  topK,

  // Vectorizer
  tokenize,
  vectorize,
  hashToken,
  hashSign,

  // Store
  VectorStore,
};
