/**
 * Empreinte SÉMANTIQUE d'un avatar — un vecteur DINOv2.
 *
 * ── Pourquoi, en plus de la pyramide dHash ─────────────────────────────
 * La pyramide de `avatarFingerprint.js` ne reconnaît qu'une même IMAGE
 * (redimensionnée, recadrée, recolorée). Elle est aveugle au cas réel de
 * l'usurpation : le MÊME sujet rephotographié ou remis dans un autre cadre
 * (cf. `@levraicongo` qui reprend la peluche et le décor de `@policiercongo`
 * mais où le sujet a bougé — distance de Hamming ≥ 12, jamais détecté).
 *
 * DINOv2 est un modèle auto-supervisé fait pour la RECHERCHE D'INSTANCE : deux
 * photos du même objet/visage/scène tombent proches dans l'espace vectoriel,
 * même sous un cadrage, un fond ou une pose différents. On compare deux
 * avatars par la SIMILARITÉ COSINUS de leurs vecteurs.
 *
 * ── Local, CPU, paresseux ──────────────────────────────────────────────
 * Le modèle tourne via transformers.js (ONNX Runtime), en local sur le VPS,
 * sans appel externe : un avatar ne quitte jamais le serveur. Il est chargé
 * UNE fois, à la première demande (le calcul d'empreintes ne tourne que sur le
 * worker, pendant le scan d'usurpation). On réutilise `@xenova/transformers`,
 * DÉJÀ présent et employé par `policiercongoV2Embeddings.js` — pas de seconde
 * copie d'ONNX Runtime à installer. Le paquet est ESM : import dynamique,
 * comme le SDK Claude ailleurs. (v2 et v3 donnent le même vecteur, mesuré.)
 *
 * Ne jette jamais : un modèle indisponible ou une image illisible rend `null`,
 * et le signal visuel se réduit alors à la pyramide — jamais une panne du scan.
 */

const logger = require('../utils/logger');
const { readImageBuffer } = require('./avatarFingerprint');

// DINOv2-small : 384 dimensions, quelques dizaines de Mo en q8. Surchargeable
// si l'on veut monter en gamme (dinov2-base) ou changer de source ONNX.
const MODEL_ID = process.env.IMPERSONATION_EMBED_MODEL || 'Xenova/dinov2-small';

let _extractorPromise = null;
let _disabled = false;

/**
 * Charge (une fois) le pipeline d'extraction de traits. La première invocation
 * télécharge le modèle depuis le hub puis le met en cache disque ; les
 * suivantes sont instantanées. En cas d'échec de chargement, on désactive
 * proprement : le reste du scan continue sans le signal sémantique.
 */
async function getExtractor() {
  if (_disabled) return null;
  if (_extractorPromise) return _extractorPromise;

  _extractorPromise = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');
    // Cache du modèle à côté du code, pas dans un tmp éphémère : évite un
    // retéléchargement à chaque redémarrage du worker.
    if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE;
    // `quantized: true` (défaut v2) : poids en int8, plus léger et plus rapide
    // en CPU, sans perte mesurable sur la séparation des avatars.
    const extractor = await pipeline('image-feature-extraction', MODEL_ID, { quantized: true });
    logger.info(`[avatar-embedding] modèle ${MODEL_ID} chargé (quantized)`);
    return extractor;
  })().catch((error) => {
    _disabled = true;
    _extractorPromise = null;
    logger.warn(`[avatar-embedding] modèle indisponible, signal sémantique désactivé : ${error.message}`);
    return null;
  });

  return _extractorPromise;
}

/**
 * Vecteur normalisé (L2) d'une image en mémoire, ou `null`.
 * Normalisé pour que la similarité cosinus se réduise à un produit scalaire.
 */
async function embedBuffer(buffer) {
  if (!buffer) return null;
  const extractor = await getExtractor();
  if (!extractor) return null;

  try {
    const { RawImage } = await import('@xenova/transformers');
    const image = await RawImage.fromBlob(new Blob([buffer]));
    // Le pipeline image rend le `last_hidden_state` COMPLET (dims
    // [1, tokens, hidden]), pas un vecteur agrégé — l'option `pooling` du
    // pipeline texte n'y agit pas. On agrège donc à la main : moyenne sur les
    // jetons puis normalisation L2, pour obtenir UN vecteur `hidden`-D dont le
    // produit scalaire est la similarité cosinus (dans [-1, 1]).
    const output = await extractor(image);
    const dims = output.dims || [1, 1, output.data.length];
    const hidden = dims[dims.length - 1];
    const tokens = Math.max(1, Math.floor(output.data.length / hidden));
    const pooled = new Float32Array(hidden);
    for (let t = 0; t < tokens; t += 1) {
      for (let h = 0; h < hidden; h += 1) pooled[h] += output.data[t * hidden + h];
    }
    let norm = 0;
    for (let h = 0; h < hidden; h += 1) { pooled[h] /= tokens; norm += pooled[h] * pooled[h]; }
    norm = Math.sqrt(norm) || 1;
    for (let h = 0; h < hidden; h += 1) pooled[h] /= norm;
    return pooled;
  } catch (error) {
    logger.warn(`[avatar-embedding] extraction impossible : ${error.message}`);
    return null;
  }
}

/** Idem depuis une URL/chemin d'avatar (mêmes limites de taille/délai que la pyramide). */
async function embedAvatar(avatarUrl) {
  const buffer = await readImageBuffer(avatarUrl).catch(() => null);
  return embedBuffer(buffer);
}

/**
 * Similarité cosinus de deux vecteurs déjà normalisés (= produit scalaire).
 * Renvoie une valeur dans [-1, 1] ; `null` si l'un manque ou si les tailles
 * diffèrent (modèle changé entre deux calculs — on ne compare pas l'incomparable).
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

/** Sérialisation compacte pour la base : base64 des octets Float32 (~2 Ko en 384-d). */
function serializeEmbedding(vector) {
  if (!vector) return null;
  const f32 = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

function deserializeEmbedding(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    const buf = Buffer.from(text, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  } catch {
    return null;
  }
}

module.exports = {
  embedAvatar,
  embedBuffer,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  MODEL_ID,
};
