/**
 * Signaux d'usurpation — fonctions pures, sans base de donnees.
 *
 * Separees de `impersonationWatchService` pour une raison pratique : ce sont
 * elles qui portent les decisions delicates, et elles doivent pouvoir se
 * tester une par une sans monter Sequelize.
 *
 * ── Le principe qui gouverne tout ce fichier ─────────────────────────────
 *
 * Une usurpation n'est presque jamais une copie parfaite. C'est un FAISCEAU :
 * un pseudo a une lettre pres, un nom repris, une photo refaite, l'audience de
 * la cible demarchee. Chaque signal pris seul a une explication innocente —
 * deux personnes peuvent porter le meme prenom, publier la meme phrase banale,
 * suivre les memes comptes.
 *
 * Chaque fonction ici rend donc une VALEUR CONTINUE et non un booleen, et
 * refuse de se prononcer quand la matiere manque (chaine trop courte,
 * audience trop petite). C'est l'appelant qui compose. Un signal qui tranche
 * tout seul est un signal qui se trompe seul.
 */

/* ══════════════════════════════════════════════════════════════════════════
   1. Normalisation
   ══════════════════════════════════════════════════════════════════════════ */

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯﻿]/gu;
const MARKS = /\p{Mark}/gu;

/** Minuscule, sans accents, sans caracteres invisibles. */
function fold(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(INVISIBLE, '')
    .replace(MARKS, '')
    .toLowerCase()
    .trim();
}

/** Lettres et chiffres uniquement — la forme comparable d'un identifiant. */
function alnum(value) {
  return fold(value).replace(/[^a-z0-9]/g, '');
}

/* ══════════════════════════════════════════════════════════════════════════
   2. Distances
   ══════════════════════════════════════════════════════════════════════════ */

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      current[j + 1] = Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function editSimilarity(a, b) {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. Le pseudo — quatre deformations que la distance d'edition rate
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Adjacence AZERTY.
 *
 * Le typosquatting joue sur la PROXIMITE DES TOUCHES, pas sur la ressemblance
 * des lettres : `policiercpngo` (o → p) est a distance 1 d'edition comme
 * `policiercxngo` (o → x), mais seul le premier est plausible — personne ne
 * tape `x` en visant `o`. Sans cette table, les deux se valent, et il faut
 * donc soit accepter les deux (bruit), soit refuser les deux (angle mort).
 *
 * Clavier FRANCAIS : c'est celui des comptes de cette plateforme. Un clavier
 * QWERTY donnerait des voisinages differents et manquerait le cas courant.
 */
const AZERTY_NEIGHBOURS = Object.freeze({
  a: 'zqs', z: 'aeqsd', e: 'zrsdf', r: 'etdfg', t: 'ryfgh', y: 'tughj',
  u: 'yihjk', i: 'uojkl', o: 'ipklm', p: 'olm',
  q: 'aswz', s: 'qdwxaz', d: 'sfxcze', f: 'dgcvre', g: 'fhvbtr', h: 'gjbnty',
  j: 'hknyu', k: 'jlnui', l: 'kmio', m: 'lop',
  w: 'xsq', x: 'wcds', c: 'xvfd', v: 'cbgf', b: 'vnhg', n: 'bjh',
  0: 'o9', 1: '2', 2: '13', 3: '24', 4: '35', 5: '46',
  6: '57', 7: '68', 8: '79', 9: '80',
});

function areNeighbours(a, b) {
  return Boolean(a && b && AZERTY_NEIGHBOURS[a]?.includes(b));
}

/**
 * Similarite qui pardonne les fautes de frappe PLAUSIBLES.
 *
 * Une substitution entre touches voisines coute 0,35 au lieu de 1. Le reste
 * garde son cout plein : on veut distinguer « la main a glisse » de « ce n'est
 * pas le meme mot ».
 */
function keyboardSimilarity(a, b) {
  const x = alnum(a);
  const y = alnum(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const rows = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = 0; i <= x.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= y.length; j += 1) rows[0][j] = j;

  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      let cost;
      if (x[i - 1] === y[j - 1]) cost = 0;
      else if (areNeighbours(x[i - 1], y[j - 1])) cost = 0.35;
      else cost = 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost,
      );
    }
  }
  return Math.max(0, 1 - rows[x.length][y.length] / Math.max(x.length, y.length));
}

/**
 * Le pseudo prive de ce qui ne fait que le decorer.
 *
 * `policiercongo2`, `policiercongo_01`, `xX_policiercongo_Xx`, `policiercongo.`
 * designent tous la meme intention : reprendre un identifiant deja pris en y
 * accolant du remplissage. Comparer les formes NUES ramene ces variantes a
 * une egalite exacte, la ou la distance d'edition les eloigne d'autant plus
 * que le remplissage est long.
 */
function stripDecoration(value) {
  let core = alnum(value);
  // Chiffres de queue : la facon la plus courante de contourner un pseudo pris.
  core = core.replace(/\d+$/, '');
  /*
   * Repetitions de bord utilisees comme ornement (« xX_…_Xx », « oo… »).
   *
   * DEUX caracteres minimum, et c'est essentiel : la regle a d'abord accepte
   * une seule lettre, et elle mangeait alors le `o` final de
   * `policiercongo_01`, qui devenait `policiercong`. Un `o` isole est une
   * lettre ordinaire ; c'est sa REPETITION qui trahit l'ornement.
   */
  core = core.replace(/^(x{2,3}|o{2,3})/, '').replace(/(x{2,3}|o{2,3})$/, '');
  return core;
}

/**
 * Les mots du pseudo, remis dans l'ordre.
 *
 * `congopolicier` face a `policiercongo` : ce sont les memes morceaux
 * permutes. Aucune distance d'edition ne le voit — elle mesure des insertions
 * et des substitutions, pas des deplacements de blocs — alors que pour un
 * lecteur c'est manifestement le meme nom.
 *
 * On ne dispose pas d'un decoupage en mots fiable sur un pseudo colle : on
 * compare donc les MULTI-ENSEMBLES de trigrammes, qui sont invariants par
 * permutation de blocs des que les blocs depassent trois caracteres.
 */
function trigrams(value) {
  const core = alnum(value);
  if (core.length < 3) return [];
  const out = [];
  for (let i = 0; i <= core.length - 3; i += 1) out.push(core.slice(i, i + 3));
  return out;
}

function permutationSimilarity(a, b) {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.length < 3 || y.length < 3) return 0;
  const counts = new Map();
  for (const g of x) counts.set(g, (counts.get(g) || 0) + 1);
  let shared = 0;
  for (const g of y) {
    const left = counts.get(g) || 0;
    if (left > 0) { shared += 1; counts.set(g, left - 1); }
  }
  return (2 * shared) / (x.length + y.length);
}

/**
 * Cle phonetique approximative, calibree pour le francais.
 *
 * `polissiercongo`, `policierkongo`, `polisierkongot` s'ecrivent differemment
 * et se PRONONCENT pareil. A l'oral — et c'est ainsi qu'un pseudo se
 * transmet, se recommande, se retient — ce sont le meme nom.
 *
 * Ce n'est pas un algorithme phonetique complet : c'est une reduction des
 * confusions les plus frequentes en francais, appliquee dans un ordre qui
 * compte (les digrammes avant les lettres isolees, sinon `ph` deviendrait
 * `p`+`h` avant d'avoir pu devenir `f`).
 */
function phoneticKey(value) {
  let key = alnum(value);
  if (!key) return '';
  key = key
    .replace(/ph/g, 'f')
    .replace(/qu/g, 'k')
    .replace(/gu(?=[ei])/g, 'g')
    .replace(/ch/g, 'x')
    .replace(/(?<=[aeiou])ss(?=[aeiou])/g, 's')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/g(?=[eiy])/g, 'j')
    .replace(/[yw]/g, 'i')
    .replace(/z/g, 's')
    .replace(/(?<=[^aeiou])h/g, '')
    .replace(/^h/, '')
    // Les doublements ne s'entendent pas.
    .replace(/(.)\1+/g, '$1')
    // Les voyelles finales muettes non plus.
    .replace(/[e]+$/, '');
  return key;
}

/**
 * Verdict lexical sur un couple de pseudos.
 *
 * Rend la meilleure des cinq lectures, avec l'etiquette de celle qui a gagne —
 * l'etiquette compte autant que le score : elle dit a la personne visee
 * POURQUOI un compte lui est signale, et « pseudo qui se prononce pareil » ne
 * se defend pas comme « pseudo a une lettre pres ».
 */
function handleAnalysis(targetHandle, suspectHandle) {
  const a = alnum(targetHandle);
  const b = alnum(suspectHandle);
  if (!a || !b || a === b) {
    return { score: a && a === b ? 1 : 0, kind: a && a === b ? 'identical' : null };
  }
  // Sous 4 caracteres, tout se ressemble : `leo` et `lea` ne prouvent rien.
  if (a.length < 4 || b.length < 4) return { score: 0, kind: null };

  const readings = [
    { kind: 'edit', value: editSimilarity(a, b) },
    { kind: 'keyboard', value: keyboardSimilarity(a, b) },
    { kind: 'permutation', value: permutationSimilarity(a, b) },
  ];

  // Formes nues : `policiercongo2` contre `policiercongo`.
  const bareA = stripDecoration(a);
  const bareB = stripDecoration(b);
  if (bareA.length >= 4 && bareB.length >= 4 && (bareA !== a || bareB !== b)) {
    readings.push({ kind: 'decorated', value: bareA === bareB ? 0.97 : editSimilarity(bareA, bareB) });
  }

  // Phonetique : seulement si les cles sont assez longues pour signifier
  // quelque chose, sinon deux mots courts se reduisent au meme squelette.
  const keyA = phoneticKey(a);
  const keyB = phoneticKey(b);
  if (keyA.length >= 5 && keyB.length >= 5 && keyA === keyB) {
    readings.push({ kind: 'phonetic', value: 0.93 });
  }

  return readings.reduce((best, r) => (r.value > best.score ? { score: r.value, kind: r.kind } : best),
    { score: 0, kind: null });
}

/* ══════════════════════════════════════════════════════════════════════════
   4. Le texte — ce qui est RARE vaut plus que ce qui est frequent
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Mots trop courants pour prouver quoi que ce soit.
 *
 * Deux bios francaises partagent forcement « de », « la », « pour ». Les
 * compter comme des indices dilue le signal jusqu'a le rendre inutile : une
 * mesure de recouvrement brute donne deja 0,3 entre deux textes sans aucun
 * rapport.
 */
const STOPWORDS = new Set([
  'a', 'au', 'aux', 'avec', 'ce', 'ces', 'dans', 'de', 'des', 'du', 'elle',
  'en', 'et', 'eux', 'il', 'ils', 'je', 'la', 'le', 'les', 'leur', 'lui',
  'ma', 'mais', 'me', 'meme', 'mes', 'moi', 'mon', 'ne', 'nos', 'notre',
  'nous', 'on', 'ou', 'par', 'pas', 'pour', 'qu', 'que', 'qui', 'sa', 'se',
  'ses', 'son', 'sur', 'ta', 'te', 'tes', 'toi', 'ton', 'tu', 'un', 'une',
  'vos', 'votre', 'vous', 'y', 'est', 'sont', 'etre', 'avoir', 'plus', 'tout',
  'the', 'and', 'for', 'you', 'with', 'this', 'that',
]);

function contentWords(value) {
  return fold(value)
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/**
 * Recouvrement PONDERE par la rarete.
 *
 * Un mot rare partage vaut beaucoup plus qu'un mot courant : reprendre
 * « astreinte » n'a pas la meme portee que reprendre « toujours ». Le poids
 * est l'inverse de la frequence du mot dans le corpus fourni — une TF-IDF du
 * pauvre, mais suffisante ici : on ne classe pas des documents, on cherche
 * une reprise.
 *
 * `corpusFrequencies` est optionnel. Sans lui, tous les mots hors liste vide
 * pesent pareil — c'est le comportement degrade, honnete faute de corpus.
 */
function weightedOverlap(a, b, corpusFrequencies = null, corpusSize = 0) {
  const left = new Set(contentWords(a));
  const right = new Set(contentWords(b));
  if (left.size < 3 || right.size < 3) return 0;

  const weightOf = (word) => {
    if (!corpusFrequencies || !corpusSize) return 1;
    const seen = corpusFrequencies.get(word) || 1;
    // Logarithme : un mot vu une fois ne doit pas peser mille fois un mot vu
    // mille fois, sinon une seule coincidence rare emporte la decision.
    return Math.log((corpusSize + 1) / seen) + 1;
  };

  let shared = 0;
  let total = 0;
  for (const word of left) total += weightOf(word);
  for (const word of right) {
    const w = weightOf(word);
    total += w;
    if (left.has(word)) shared += 2 * w;
  }
  return total > 0 ? shared / total : 0;
}

/**
 * La plus longue suite de mots identiques entre deux textes.
 *
 * Une phrase entiere reprise mot pour mot est d'une autre nature qu'un
 * vocabulaire commun : personne n'ecrit par hasard sept mots consecutifs
 * identiques. Ce signal-la ne se dilue pas avec la longueur des textes,
 * contrairement a un recouvrement d'ensembles.
 */
function longestSharedRun(a, b) {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.length || !y.length) return 0;
  let best = 0;
  let previous = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i += 1) {
    const current = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j += 1) {
      if (x[i - 1] === y[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

/* ══════════════════════════════════════════════════════════════════════════
   5. Le contexte — qui etait la avant, et a quoi ressemble le compte
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Multiplicateur de contexte, autour de 1.
 *
 * Ce n'est pas un signal de plus : c'est ce qui distingue deux comptes aux
 * signaux IDENTIQUES mais aux situations opposees.
 *
 * - **L'anteriorite tranche.** Si le suspect existait avant la cible, ce n'est
 *   pas lui qui copie — c'est peut-etre meme l'inverse. Le meme faisceau doit
 *   alors peser beaucoup moins. C'est la seule regle ici qui puisse diviser un
 *   score, et elle est indispensable : sans elle, on signale le compte
 *   historique a l'arrivant.
 * - **Un compte vide qui adopte une identite est suspect.** Zero tweet, zero
 *   abonne, cree il y a trois jours : le profil n'a servi qu'a ressembler.
 * - **Un compte etabli l'est beaucoup moins.** Cent tweets et une audience
 *   propre, c'est une vie en ligne, pas un leurre.
 */
function contextMultiplier(target, suspect) {
  let factor = 1;
  const reasons = [];

  const targetAge = Date.parse(target?.created_at || '') || 0;
  const suspectAge = Date.parse(suspect?.created_at || '') || 0;
  if (targetAge && suspectAge) {
    if (suspectAge < targetAge) {
      // Il etait la avant : ce n'est pas une usurpation, c'est une anteriorite.
      factor *= 0.35;
      reasons.push('suspect_is_older');
    } else if (suspectAge - targetAge > 400 * 86400000) {
      // Cree tres longtemps apres : la ressemblance a eu le temps d'etre
      // fortuite, et la cible a eu le temps de devenir un nom commun.
      factor *= 0.9;
    }
  }

  const tweets = Number(suspect?._tweetCount ?? NaN);
  const followers = Number(suspect?._followerCount ?? NaN);
  if (Number.isFinite(tweets) && Number.isFinite(followers)) {
    if (tweets <= 2 && followers <= 2) {
      factor *= 1.18;
      reasons.push('empty_shell');
    } else if (tweets >= 50 && followers >= 20) {
      factor *= 0.82;
      reasons.push('established_account');
    }
  }

  return { factor, reasons };
}

/**
 * Part de l'audience du suspect qui vient de celle de la cible.
 *
 * ── Pourquoi c'est le signal le plus difficile a contrefaire ─────────────
 *
 * Un usurpateur ne se contente pas de ressembler : il demarche les gens qui
 * suivent sa cible, parce que ce sont les seuls a pouvoir se tromper. Cette
 * trace-la est involontaire et couteuse a effacer — changer de pseudo prend
 * une seconde, se construire une autre audience prend des semaines.
 *
 * On rapporte le recouvrement a l'audience du SUSPECT, pas a celle de la
 * cible : c'est lui qui puise dedans. Rapporte a la cible, un gros compte
 * diluerait tout et le signal ne se declencherait jamais.
 *
 * Sous cinq abonnes, on ne se prononce pas — deux comptes qui partagent leurs
 * trois seuls abonnes, c'est le hasard d'une petite plateforme.
 */
function audienceOverlap(targetFollowerIds, suspectFollowerIds) {
  const target = targetFollowerIds instanceof Set ? targetFollowerIds : new Set(targetFollowerIds || []);
  const suspect = Array.from(suspectFollowerIds || []);
  if (target.size < 5 || suspect.length < 5) return 0;
  let shared = 0;
  for (const id of suspect) if (target.has(id)) shared += 1;
  return shared / suspect.length;
}

module.exports = {
  fold,
  alnum,
  editSimilarity,
  keyboardSimilarity,
  stripDecoration,
  permutationSimilarity,
  phoneticKey,
  handleAnalysis,
  contentWords,
  weightedOverlap,
  longestSharedRun,
  contextMultiplier,
  audienceOverlap,
  AZERTY_NEIGHBOURS,
  STOPWORDS,
};
