'use strict';

/**
 * Détection de redite pour PolicierCongo V2 — tweets quasi identiques / mêmes tournures.
 */

function normalizeTweetBody(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\w+/g, '@')
    .trim();
}

function wordTokenSet(text) {
  const m = String(text).toLowerCase().match(/[a-zàâäéèêëïîôùûçœæ0-9]+/gi);
  return m ? new Set(m) : new Set();
}

function jaccardTokenSimilarity(a, b) {
  const A = wordTokenSet(a);
  const B = wordTokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) {
    if (B.has(w)) inter++;
  }
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function diceBigramSimilarity(a, b) {
  const x = normalizeTweetBody(a);
  const y = normalizeTweetBody(b);
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (str) => {
    const m = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const g = str.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = grams(x);
  const B = grams(y);
  let inter = 0;
  for (const [g, c] of A) {
    if (B.has(g)) inter += Math.min(c, B.get(g));
  }
  const denom = x.length - 1 + y.length - 1;
  return denom ? (2 * inter) / denom : 0;
}

function openingPrefix(text, len = 48) {
  const n = normalizeTweetBody(text);
  return n.slice(0, len);
}

/**
 * @param {string} candidate
 * @param {string[]} previousBodies
 * @param {{ jaccardBlock?: number; diceBlock?: number }} [opts]
 * @returns {{ duplicate: boolean; reason?: string; matched?: string }}
 */
function assessTweetDuplicate(candidate, previousBodies, opts = {}) {
  const jaccardBlock = opts.jaccardBlock ?? 0.48;
  const diceBlock = opts.diceBlock ?? 0.36;

  const cand = String(candidate || '').trim();
  if (!cand) return { duplicate: false };

  const candNorm = normalizeTweetBody(cand);
  const prevList = (previousBodies || []).map(p => String(p || '').trim()).filter(Boolean);

  const open = openingPrefix(cand, 56);
  for (const p of prevList) {
    const pNorm = normalizeTweetBody(p);
    if (!pNorm || !candNorm) continue;

    if (candNorm === pNorm) {
      return { duplicate: true, reason: 'exact_normalized', matched: p.slice(0, 120) };
    }

    const shorter = candNorm.length <= pNorm.length ? candNorm : pNorm;
    const longer = candNorm.length > pNorm.length ? candNorm : pNorm;
    if (shorter.length >= 28 && longer.includes(shorter)) {
      return { duplicate: true, reason: 'substring_containment', matched: p.slice(0, 120) };
    }

    const j = jaccardTokenSimilarity(cand, p);
    if (j >= jaccardBlock) {
      return { duplicate: true, reason: `high_jaccard_${j.toFixed(2)}`, matched: p.slice(0, 120) };
    }

    const d = diceBigramSimilarity(cand, p);
    if (d >= diceBlock) {
      return { duplicate: true, reason: `high_dice_${d.toFixed(2)}`, matched: p.slice(0, 120) };
    }

    const po = openingPrefix(p, 56);
    if (open.length >= 24 && po.length >= 24 && open === po) {
      return { duplicate: true, reason: 'same_opening', matched: p.slice(0, 120) };
    }
  }

  return { duplicate: false };
}

module.exports = {
  normalizeTweetBody,
  jaccardTokenSimilarity,
  diceBigramSimilarity,
  assessTweetDuplicate
};
