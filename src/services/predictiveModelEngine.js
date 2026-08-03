'use strict';

/**
 * Moteur statistique pur des analytics créateur.
 *
 * Ce module ne connaît ni Sequelize ni Express. Il transforme un historique
 * déjà chargé en un ensemble prédictif traçable :
 *
 *   1. une base robuste pondérée dans le temps ;
 *   2. une régression Ridge sur log(1 + résultat), pour apprendre les effets
 *      combinés sans exploser quand les variables sont corrélées ;
 *   3. des voisins proches, à la fois sur la forme et sur le vocabulaire ;
 *   4. un poids de chaque sous-modèle choisi sur une validation temporelle ;
 *   5. des intervalles et probabilités calibrés sur les erreurs observées.
 *
 * Aucun coefficient métier arbitraire ne devient une promesse de performance.
 * Les constantes ci-dessous servent à la régularisation, à la maturité et à la
 * stabilité numérique ; le niveau de performance vient toujours des données.
 */

const MODEL_VERSION = 'creator-ensemble-v2.0.0';
const RECENCY_HALF_LIFE_DAYS = 60;
const ENGAGEMENT_MATURITY_HOURS = 18;
const MIN_MATURE_AGE_HOURS = 6;
const MIN_TRAINING_ROWS = 5;
const MIN_BACKTEST_ROWS = 12;
const MAX_HISTORY_ROWS = 600;
const EPSILON = 1e-9;

const EMOJI_RE_GLOBAL = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/gu;
const URL_RE_GLOBAL = /https?:\/\/\S+/gi;
const HASHTAG_RE_GLOBAL = /#[\p{L}\p{N}_]+/gu;
const MENTION_RE_GLOBAL = /@[\p{L}\p{N}_]+/gu;

const STOP_WORDS = new Set(`
  a afin ai ainsi alors apres après au aucun aussi autre aux avec avoir bon car
  ce ceci cela ces cet cette chaque chez comme comment dans de des du dedans
  dehors depuis devrait doit donc dos droite elle elles en encore est et eu fait
  faites fois font force haut hors ici il ils je juste la le les leur là ma mais
  me mes moi moins mon mot meme même ni nommes notre nous nouveaux on ou où par
  parce parole pas personne peut peu plupart pour pourquoi quand que quel quelle
  quelles quels qui sa sans ses seulement si sien son sont sous soyez sujet sur
  ta tandis tellement tels tes ton tous tout trop tres très tu un une valeur voie
  voient vont votre vous vu ca ça c est d j l m n qu s t y the and for from that
  this with you your are was were have has not but all can will just its our out
  plus bien faire fait comme dans pour avec sans chez entre encore alors quand
`.split(/\s+/).filter(Boolean));

const POSITIVE_WORDS = new Set(`
  excellent incroyable génial genial superbe bravo merci heureux heureuse succès
  succes gagner victoire amour aime utile fort forte progrès progres nouveau
  nouvelle meilleur meilleure parfait parfaite fier fière fiere opportunité
  opportunite solution réussite reussite positif positive confiance
`.split(/\s+/));

const NEGATIVE_WORDS = new Set(`
  mauvais mauvaise nul nulle problème probleme erreur échec echec triste colère
  colere peur honte danger arnaque faux fausse pire déteste deteste difficile
  impossible crise perdre perdu déçu decu décevant decevant négatif negative
`.split(/\s+/));

const CTA_PATTERNS = [
  /\b(?:dites[- ]moi|dis[- ]moi|réponds|reponds|répondez|repondez)\b/giu,
  /\b(?:partage|partagez|commente|commentez|like|likez|abonne[- ]toi|abonnez[- ]vous)\b/giu,
  /\b(?:qu['’]en pensez[- ]vous|tu en penses quoi|vous en pensez quoi)\b/giu,
  /\b(?:clique|cliquez|découvre|decouvre|découvrez|decouvrez|regarde|regardez)\b/giu,
];

const FIRST_PERSON_RE = /\b(?:je|j['’]|moi|mon|ma|mes|nous|notre|nos)\b/giu;
const SECOND_PERSON_RE = /\b(?:tu|toi|ton|ta|tes|vous|votre|vos)\b/giu;

const FEATURE_DEFINITIONS = [
  ['length_log', (f) => Math.log1p(f.length)],
  ['words_log', (f) => Math.log1p(f.words)],
  ['lexical_diversity', (f) => f.lexicalDiversity],
  ['average_word_length', (f) => f.averageWordLength / 12],
  ['sentences_log', (f) => Math.log1p(f.sentenceCount)],
  ['average_sentence_length', (f) => Math.min(f.averageSentenceLength, 80) / 80],
  ['readability', (f) => f.readabilityScore / 100],
  ['hashtags_log', (f) => Math.log1p(f.hashtagCount)],
  ['mentions_log', (f) => Math.log1p(f.mentionCount)],
  ['emojis_log', (f) => Math.log1p(f.emojiCount)],
  ['urls_log', (f) => Math.log1p(f.urlCount)],
  ['questions_log', (f) => Math.log1p(f.questionCount)],
  ['exclamations_log', (f) => Math.log1p(f.exclamationCount)],
  ['punctuation_density', (f) => f.punctuationDensity],
  ['uppercase_ratio', (f) => f.uppercaseRatio],
  ['digit_ratio', (f) => f.digitRatio],
  ['line_breaks_log', (f) => Math.log1p(f.lineBreakCount)],
  ['has_media', (f) => Number(f.hasMedia)],
  ['media_count_log', (f) => Math.log1p(f.mediaCount)],
  ['has_question', (f) => Number(f.hasQuestion)],
  ['has_link', (f) => Number(f.hasLink)],
  ['has_emoji', (f) => Number(f.hasEmoji)],
  ['has_line_breaks', (f) => Number(f.hasLineBreaks)],
  ['call_to_action', (f) => Math.min(f.callToActionCount, 3) / 3],
  ['first_person', (f) => Math.min(f.firstPersonCount, 5) / 5],
  ['second_person', (f) => Math.min(f.secondPersonCount, 5) / 5],
  ['sentiment', (f) => f.sentimentScore],
  ['emotional_intensity', (f) => f.emotionalIntensity],
  ['hook_strength', (f) => f.hookStrength / 100],
  ['repeated_punctuation', (f) => Math.min(f.repeatedPunctuationCount, 4) / 4],
  ['repeated_characters', (f) => Math.min(f.repeatedCharacterRuns, 4) / 4],
  ['hour_sin', (f) => f.hourSin],
  ['hour_cos', (f) => f.hourCos],
  ['day_sin', (f) => f.daySin],
  ['day_cos', (f) => f.dayCos],
  ['weekend', (f) => Number(f.isWeekend)],
  ['posting_gap_log', (f) => Math.log1p(Math.min(f.hoursSinceLastPost || 0, 336)) / Math.log1p(336)],
];

const FEATURE_LABELS = {
  length_log: 'Longueur du texte',
  words_log: 'Volume de mots',
  lexical_diversity: 'Diversité du vocabulaire',
  average_word_length: 'Complexité des mots',
  sentences_log: 'Découpage en phrases',
  average_sentence_length: 'Longueur des phrases',
  readability: 'Lisibilité',
  hashtags_log: 'Nombre de hashtags',
  mentions_log: 'Nombre de mentions',
  emojis_log: 'Emojis',
  urls_log: 'Liens externes',
  questions_log: 'Questions',
  exclamations_log: 'Exclamations',
  punctuation_density: 'Densité de ponctuation',
  uppercase_ratio: 'Majuscules',
  digit_ratio: 'Chiffres et données',
  line_breaks_log: 'Mise en forme aérée',
  has_media: 'Présence d’un média',
  media_count_log: 'Nombre de médias',
  has_question: 'Forme interrogative',
  has_link: 'Lien externe',
  has_emoji: 'Présence d’emojis',
  has_line_breaks: 'Texte sur plusieurs lignes',
  call_to_action: 'Appel à l’action',
  first_person: 'Expression personnelle',
  second_person: 'Adresse directe au lecteur',
  sentiment: 'Tonalité émotionnelle',
  emotional_intensity: 'Intensité émotionnelle',
  hook_strength: 'Force de l’accroche',
  repeated_punctuation: 'Ponctuation répétée',
  repeated_characters: 'Caractères répétés',
  hour_sin: 'Heure de publication',
  hour_cos: 'Heure de publication',
  day_sin: 'Jour de publication',
  day_cos: 'Jour de publication',
  weekend: 'Publication le week-end',
  posting_gap_log: 'Espacement depuis le tweet précédent',
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 0) {
  const scale = 10 ** digits;
  return Math.round(finite(value) * scale) / scale;
}

function countMatches(text, regex) {
  return (String(text || '').match(regex) || []).length;
}

function normalizeWord(word) {
  return String(word || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]/g, '');
}

function tokenizeContent(content) {
  return String(content || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(URL_RE_GLOBAL, ' ')
    .replace(/[@#]/g, ' ')
    .replace(/[^\p{L}\p{N}_'’\s-]/gu, ' ')
    .split(/\s+/)
    .map(normalizeWord)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function approximateSyllables(word) {
  const normalized = normalizeWord(word);
  if (!normalized) return 0;
  const groups = normalized.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function frenchReadability(words, sentences) {
  if (!words.length) return 0;
  const syllables = words.reduce((sum, word) => sum + approximateSyllables(word), 0);
  const sentenceCount = Math.max(1, sentences);
  // Adaptation de Flesch pour le français, bornée pour l'interface.
  return clamp(207 - 1.015 * (words.length / sentenceCount) - 73.6 * (syllables / words.length), 0, 100);
}

function extractFeatures(content, {
  mediaCount = 0,
  publishAt = new Date(),
  hoursSinceLastPost = 24,
} = {}) {
  const text = String(content || '');
  const whenCandidate = publishAt instanceof Date ? publishAt : new Date(publishAt);
  const when = Number.isNaN(whenCandidate.getTime()) ? new Date() : whenCandidate;
  const rawWords = text.match(/[\p{L}\p{N}_'’’-]+/gu) || [];
  const normalizedWords = rawWords.map(normalizeWord).filter(Boolean);
  const uniqueWords = new Set(normalizedWords);
  const topicTokens = tokenizeContent(text);
  const hashtags = text.match(HASHTAG_RE_GLOBAL) || [];
  const mentions = text.match(MENTION_RE_GLOBAL) || [];
  const urls = text.match(URL_RE_GLOBAL) || [];
  const emojis = text.match(EMOJI_RE_GLOBAL) || [];
  const sentenceFragments = text.split(/[.!?…]+/).map((part) => part.trim()).filter(Boolean);
  const sentenceCount = Math.max(1, sentenceFragments.length || (text.trim() ? 1 : 0));
  const letters = text.match(/\p{L}/gu) || [];
  const uppercase = text.match(/\p{Lu}/gu) || [];
  const digits = text.match(/\p{N}/gu) || [];
  const punctuation = text.match(/[.,;:!?…—–()[\]{}"«»'’]/g) || [];
  const questionCount = countMatches(text, /\?/g);
  const exclamationCount = countMatches(text, /!/g);
  const lineBreakCount = countMatches(text, /\n/g);
  const repeatedPunctuationCount = countMatches(text, /([!?.,])\1{1,}/g);
  const repeatedCharacterRuns = countMatches(text, /(\p{L})\1{2,}/giu);
  const callToActionCount = CTA_PATTERNS.reduce((sum, pattern) => sum + countMatches(text, pattern), 0);
  const firstPersonCount = countMatches(text, FIRST_PERSON_RE);
  const secondPersonCount = countMatches(text, SECOND_PERSON_RE);

  let positiveWords = 0;
  let negativeWords = 0;
  normalizedWords.forEach((word) => {
    if (POSITIVE_WORDS.has(word)) positiveWords += 1;
    if (NEGATIVE_WORDS.has(word)) negativeWords += 1;
  });
  const sentimentDenominator = Math.max(1, positiveWords + negativeWords);
  const sentimentScore = (positiveWords - negativeWords) / sentimentDenominator;
  const emotionalIntensity = clamp(
    (positiveWords + negativeWords + emojis.length * 0.45 + exclamationCount * 0.3)
      / Math.max(4, normalizedWords.length),
    0,
    1,
  );

  const trimmed = text.trim();
  const firstSentence = sentenceFragments[0] || trimmed;
  const startsWithQuestion = /^\s*(?:qui|quoi|comment|pourquoi|quand|où|ou|est-ce|avez-vous|as-tu|pensez-vous|tu penses)/iu.test(trimmed)
    || trimmed.startsWith('?');
  const startsWithNumber = /^\s*[\d①-⑳]/u.test(trimmed);
  const hookStrength = clamp(
    (startsWithQuestion ? 28 : 0)
      + (startsWithNumber ? 16 : 0)
      + (questionCount > 0 ? 12 : 0)
      + (callToActionCount > 0 ? 14 : 0)
      + (firstSentence.length > 0 && firstSentence.length <= 90 ? 18 : 0)
      + (secondPersonCount > 0 ? 12 : 0),
    0,
    100,
  );

  const hour = when.getHours();
  const dayOfWeek = when.getDay();
  const length = text.length;
  const words = normalizedWords.length;
  const uppercaseRatio = uppercase.length / Math.max(1, letters.length);

  return {
    length,
    words,
    uniqueWords: uniqueWords.size,
    lexicalDiversity: words ? uniqueWords.size / words : 0,
    averageWordLength: words ? normalizedWords.reduce((sum, word) => sum + word.length, 0) / words : 0,
    sentenceCount,
    averageSentenceLength: words / Math.max(1, sentenceCount),
    readabilityScore: round(frenchReadability(normalizedWords, sentenceCount), 1),
    hashtagCount: hashtags.length,
    mentionCount: mentions.length,
    urlCount: urls.length,
    emojiCount: emojis.length,
    questionCount,
    exclamationCount,
    lineBreakCount,
    punctuationDensity: punctuation.length / Math.max(1, length),
    uppercaseRatio,
    digitRatio: digits.length / Math.max(1, length),
    repeatedPunctuationCount,
    repeatedCharacterRuns,
    callToActionCount,
    firstPersonCount,
    secondPersonCount,
    positiveWords,
    negativeWords,
    sentimentScore: round(sentimentScore, 3),
    emotionalIntensity: round(emotionalIntensity, 3),
    hookStrength: round(hookStrength),
    startsWithQuestion,
    startsWithNumber,
    mediaCount: Math.max(0, finite(mediaCount)),
    hasMedia: finite(mediaCount) > 0,
    hasQuestion: questionCount > 0,
    hasEmoji: emojis.length > 0,
    hasLink: urls.length > 0,
    hasLineBreaks: lineBreakCount > 0,
    isUppercaseHeavy: length > 20 && uppercaseRatio > 0.3,
    hour,
    dayOfWeek,
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    hourSin: Math.sin((2 * Math.PI * hour) / 24),
    hourCos: Math.cos((2 * Math.PI * hour) / 24),
    daySin: Math.sin((2 * Math.PI * dayOfWeek) / 7),
    dayCos: Math.cos((2 * Math.PI * dayOfWeek) / 7),
    hoursSinceLastPost: clamp(finite(hoursSinceLastPost, 24), 0, 24 * 90),
    topicTokens,
  };
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = clamp(q, 0, 1) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const fraction = position - lower;
  const upper = sortedValues[lower + 1];
  return upper === undefined
    ? sortedValues[lower]
    : sortedValues[lower] + fraction * (upper - sortedValues[lower]);
}

function describe(values) {
  const sorted = values.map((value) => finite(value)).sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const mean = sorted.length ? sum / sorted.length : 0;
  const variance = sorted.length
    ? sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / sorted.length
    : 0;
  return {
    count: sorted.length,
    mean,
    standardDeviation: Math.sqrt(variance),
    median: quantile(sorted, 0.5),
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

function weightedQuantile(values, weights, q) {
  if (!values.length) return 0;
  const entries = values
    .map((value, index) => ({ value: finite(value), weight: Math.max(0, finite(weights[index], 1)) }))
    .sort((a, b) => a.value - b.value);
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= EPSILON) return quantile(entries.map((entry) => entry.value), q);
  const target = clamp(q, 0, 1) * total;
  let cumulative = 0;
  for (const entry of entries) {
    cumulative += entry.weight;
    if (cumulative >= target) return entry.value;
  }
  return entries[entries.length - 1].value;
}

function effectiveSampleSize(weights) {
  const sum = weights.reduce((total, weight) => total + Math.max(0, finite(weight)), 0);
  const squares = weights.reduce((total, weight) => total + Math.max(0, finite(weight)) ** 2, 0);
  return squares > EPSILON ? (sum ** 2) / squares : 0;
}

function maturityForAge(ageHours) {
  if (ageHours <= 0) return 0.2;
  return clamp(1 - Math.exp(-ageHours / ENGAGEMENT_MATURITY_HOURS), 0.2, 1);
}

function prepareHistory(history, now = new Date()) {
  const nowMs = now.getTime();
  const sorted = [...history]
    .filter((tweet) => tweet && tweet.createdAt)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-MAX_HISTORY_ROWS);

  return sorted.map((tweet, index) => {
    const createdAt = new Date(tweet.createdAt);
    const previous = sorted[index - 1];
    const ageHours = Math.max(0, (nowMs - createdAt.getTime()) / 3600000);
    const ageDays = ageHours / 24;
    const maturity = maturityForAge(ageHours);
    const hoursSinceLastPost = previous
      ? Math.max(0, (createdAt - new Date(previous.createdAt)) / 3600000)
      : 72;
    const recencyWeight = 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
    const maturityWeight = ageHours >= MIN_MATURE_AGE_HOURS ? 0.55 + 0.45 * maturity : 0.15;
    const behaviorReliability = finite(tweet.trackedViews) > 0 ? 1 : 0.88;
    const weight = clamp(recencyWeight * maturityWeight * behaviorReliability, 0.03, 1);
    const adjustment = 1 / clamp(maturity, 0.35, 1);
    const adjustedEngagement = finite(tweet.engagement) * adjustment;
    const adjustedViews = finite(tweet.views) * adjustment;
    const features = extractFeatures(tweet.content, {
      mediaCount: tweet.mediaCount,
      publishAt: createdAt,
      hoursSinceLastPost,
    });

    return {
      ...tweet,
      createdAt,
      ageHours,
      ageDays,
      maturity,
      weight,
      features,
      adjustedEngagement,
      adjustedViews,
      engagementPerThousandViews: adjustedViews > 0
        ? (adjustedEngagement / adjustedViews) * 1000
        : null,
      adjustedClicks: finite(tweet.clicks) * adjustment,
      adjustedLikes: finite(tweet.likes) * adjustment,
      adjustedRetweets: finite(tweet.retweets) * adjustment,
      adjustedReplies: finite(tweet.replies) * adjustment,
      adjustedBookmarks: finite(tweet.bookmarks) * adjustment,
      adjustedShares: finite(tweet.shares) * adjustment,
    };
  });
}

function vectorFromFeatures(features) {
  return FEATURE_DEFINITIONS.map(([, getter]) => finite(getter(features)));
}

function buildScaler(rows) {
  const vectors = rows.map((row) => vectorFromFeatures(row.features));
  const weights = rows.map((row) => row.weight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const means = FEATURE_DEFINITIONS.map((_, column) => (
    vectors.reduce((sum, vector, index) => sum + vector[column] * weights[index], 0) / totalWeight
  ));
  const deviations = FEATURE_DEFINITIONS.map((_, column) => {
    const variance = vectors.reduce(
      (sum, vector, index) => sum + weights[index] * (vector[column] - means[column]) ** 2,
      0,
    ) / totalWeight;
    return Math.sqrt(variance) > 1e-6 ? Math.sqrt(variance) : 1;
  });
  return { means, deviations };
}

function standardizeVector(features, scaler) {
  return vectorFromFeatures(features).map(
    (value, index) => (value - scaler.means[index]) / scaler.deviations[index],
  );
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];

    const divisor = augmented[column][column];
    for (let j = column; j <= size; j += 1) augmented[column][j] /= divisor;

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (Math.abs(factor) < 1e-14) continue;
      for (let j = column; j <= size; j += 1) {
        augmented[row][j] -= factor * augmented[column][j];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function fitRidge(rows, targetKey, providedScaler = null) {
  if (rows.length < MIN_TRAINING_ROWS) return null;
  const scaler = providedScaler || buildScaler(rows);
  const columns = FEATURE_DEFINITIONS.length + 1;
  const normal = Array.from({ length: columns }, () => Array(columns).fill(0));
  const right = Array(columns).fill(0);
  const lambda = clamp((FEATURE_DEFINITIONS.length / rows.length) * 4.5, 0.8, 18);

  rows.forEach((row) => {
    const x = [1, ...standardizeVector(row.features, scaler)];
    const y = Math.log1p(Math.max(0, finite(row[targetKey])));
    const weight = Math.max(0.01, row.weight);
    for (let i = 0; i < columns; i += 1) {
      right[i] += weight * x[i] * y;
      for (let j = 0; j < columns; j += 1) normal[i][j] += weight * x[i] * x[j];
    }
  });
  for (let i = 1; i < columns; i += 1) normal[i][i] += lambda;
  normal[0][0] += 1e-8;

  const coefficients = solveLinearSystem(normal, right);
  if (!coefficients) return null;

  return {
    targetKey,
    scaler,
    coefficients,
    lambda,
    predict(features) {
      const standardized = standardizeVector(features, scaler);
      let logPrediction = coefficients[0];
      const contributions = {};
      standardized.forEach((value, index) => {
        const contribution = coefficients[index + 1] * value;
        logPrediction += contribution;
        contributions[FEATURE_DEFINITIONS[index][0]] = contribution;
      });
      return { logPrediction: clamp(logPrediction, 0, 20), contributions };
    },
  };
}

function cosineSimilarity(leftTokens, rightTokens, documentFrequency, documentCount) {
  if (!leftTokens.length || !rightTokens.length) return 0;
  const leftCounts = new Map();
  const rightCounts = new Map();
  leftTokens.forEach((token) => leftCounts.set(token, (leftCounts.get(token) || 0) + 1));
  rightTokens.forEach((token) => rightCounts.set(token, (rightCounts.get(token) || 0) + 1));
  const vocabulary = new Set([...leftCounts.keys(), ...rightCounts.keys()]);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  vocabulary.forEach((token) => {
    const idf = Math.log((documentCount + 1) / ((documentFrequency.get(token) || 0) + 1)) + 1;
    const left = (leftCounts.get(token) || 0) * idf;
    const right = (rightCounts.get(token) || 0) * idf;
    dot += left * right;
    leftNorm += left ** 2;
    rightNorm += right ** 2;
  });
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function buildDocumentFrequency(rows) {
  const frequency = new Map();
  rows.forEach((row) => {
    new Set(row.features.topicTokens).forEach((token) => {
      frequency.set(token, (frequency.get(token) || 0) + 1);
    });
  });
  return frequency;
}

function nearestNeighbors(rows, features, targetKey, scaler, limit, context = null) {
  if (!rows.length) return { logPrediction: 0, neighbors: [] };
  const targetVector = standardizeVector(features, scaler);
  const documentFrequency = context?.documentFrequency || buildDocumentFrequency(rows);
  const documentCount = context?.documentCount || rows.length;
  const k = limit || clamp(Math.round(Math.sqrt(rows.length) + 2), 4, 15);

  const neighbors = rows.map((row) => {
    const vector = standardizeVector(row.features, scaler);
    const numericDistance = Math.sqrt(
      vector.reduce((sum, value, index) => sum + (value - targetVector[index]) ** 2, 0)
        / Math.max(1, vector.length),
    );
    const lexicalSimilarity = cosineSimilarity(
      features.topicTokens,
      row.features.topicTokens,
      documentFrequency,
      documentCount,
    );
    // Le texte pèse davantage quand il partage réellement du vocabulaire ; à
    // défaut, les caractéristiques de forme gardent des voisins utilisables.
    const distance = numericDistance * (lexicalSimilarity > 0 ? 0.68 : 0.88)
      + (1 - lexicalSimilarity) * (lexicalSimilarity > 0 ? 0.32 : 0.12);
    const similarityWeight = Math.exp(-2.2 * distance) * (0.35 + 0.65 * row.weight);
    return { row, numericDistance, lexicalSimilarity, distance, similarityWeight };
  }).sort((a, b) => a.distance - b.distance).slice(0, k);

  const denominator = neighbors.reduce((sum, item) => sum + item.similarityWeight, 0);
  const fallback = weightedQuantile(
    rows.map((row) => Math.log1p(Math.max(0, finite(row[targetKey])))),
    rows.map((row) => row.weight),
    0.5,
  );
  const logPrediction = denominator > EPSILON
    ? neighbors.reduce(
      (sum, item) => sum + item.similarityWeight * Math.log1p(Math.max(0, finite(item.row[targetKey]))),
      0,
    ) / denominator
    : fallback;

  return { logPrediction, neighbors };
}

function rmse(actual, predicted) {
  if (!actual.length) return null;
  return Math.sqrt(actual.reduce((sum, value, index) => sum + (value - predicted[index]) ** 2, 0) / actual.length);
}

function maeOnOriginalScale(actualLogs, predictedLogs) {
  if (!actualLogs.length) return null;
  return actualLogs.reduce(
    (sum, value, index) => sum + Math.abs(Math.expm1(value) - Math.expm1(predictedLogs[index])),
    0,
  ) / actualLogs.length;
}

function normalizedInverseErrorWeights(errors) {
  const defaults = { baseline: 0.34, ridge: 0.38, neighbors: 0.28 };
  const valid = Object.entries(errors).filter(([, error]) => Number.isFinite(error));
  if (valid.length < 2) return defaults;
  const raw = Object.fromEntries(valid.map(([key, error]) => [key, 1 / Math.max(0.08, error) ** 2]));
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0) || 1;
  const normalized = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value / total]));

  // Un petit holdout ne doit jamais donner 99 % du pouvoir à une seule méthode.
  const bounded = {
    baseline: clamp(normalized.baseline ?? defaults.baseline, 0.15, 0.55),
    ridge: clamp(normalized.ridge ?? defaults.ridge, 0.2, 0.6),
    neighbors: clamp(normalized.neighbors ?? defaults.neighbors, 0.15, 0.5),
  };
  const boundedTotal = bounded.baseline + bounded.ridge + bounded.neighbors;
  return Object.fromEntries(Object.entries(bounded).map(([key, value]) => [key, value / boundedTotal]));
}

function fitTargetEnsemble(rows, targetKey, sharedContext = null) {
  const allWeights = rows.map((row) => row.weight);
  const targetLogs = rows.map((row) => Math.log1p(Math.max(0, finite(row[targetKey]))));
  const baselineLog = weightedQuantile(targetLogs, allWeights, 0.5);
  const scaler = sharedContext?.scaler || buildScaler(rows);
  const ridge = fitRidge(rows, targetKey, scaler);
  const neighborContext = sharedContext?.neighborContext || {
    documentFrequency: buildDocumentFrequency(rows),
    documentCount: rows.length,
  };

  let validation = {
    holdoutSize: 0,
    errors: { baseline: null, ridge: null, neighbors: null },
    residuals: [],
    mae: null,
  };

  if (rows.length >= MIN_BACKTEST_ROWS) {
    const holdoutSize = clamp(Math.ceil(rows.length * 0.2), 3, 25);
    const training = rows.slice(0, rows.length - holdoutSize);
    const holdout = rows.slice(-holdoutSize);
    const validationScaler = buildScaler(training);
    const validationRidge = fitRidge(training, targetKey, validationScaler);
    const validationNeighborContext = {
      documentFrequency: buildDocumentFrequency(training),
      documentCount: training.length,
    };
    const trainingBaseline = weightedQuantile(
      training.map((row) => Math.log1p(Math.max(0, finite(row[targetKey])))),
      training.map((row) => row.weight),
      0.5,
    );

    const actual = [];
    const baselinePredictions = [];
    const ridgePredictions = [];
    const neighborPredictions = [];
    holdout.forEach((row) => {
      actual.push(Math.log1p(Math.max(0, finite(row[targetKey]))));
      baselinePredictions.push(trainingBaseline);
      ridgePredictions.push(validationRidge?.predict(row.features).logPrediction ?? trainingBaseline);
      neighborPredictions.push(
        nearestNeighbors(
          training,
          row.features,
          targetKey,
          validationScaler,
          undefined,
          validationNeighborContext,
        ).logPrediction,
      );
    });
    const errors = {
      baseline: rmse(actual, baselinePredictions),
      ridge: rmse(actual, ridgePredictions),
      neighbors: rmse(actual, neighborPredictions),
    };
    const weights = normalizedInverseErrorWeights(errors);
    const ensemblePredictions = actual.map((_, index) => (
      weights.baseline * baselinePredictions[index]
        + weights.ridge * ridgePredictions[index]
        + weights.neighbors * neighborPredictions[index]
    ));
    validation = {
      holdoutSize,
      errors,
      residuals: actual.map((value, index) => value - ensemblePredictions[index]),
      mae: maeOnOriginalScale(actual, ensemblePredictions),
    };
  }

  const weights = normalizedInverseErrorWeights(validation.errors);
  // 80 résidus bien répartis suffisent à calibrer des quantiles. Au-delà, le
  // leave-one-out n'améliore pratiquement plus la fourchette mais son coût est
  // quadratique sur les grands comptes.
  const residualStride = Math.max(1, Math.ceil(rows.length / 60));
  const calibrationRows = rows.filter((_, index) => index % residualStride === 0);
  const inSampleResiduals = calibrationRows.map((row) => {
    const actual = Math.log1p(Math.max(0, finite(row[targetKey])));
    const ridgePrediction = ridge?.predict(row.features).logPrediction ?? baselineLog;
    const neighborPrediction = nearestNeighbors(
      rows.filter((candidate) => candidate !== row),
      row.features,
      targetKey,
      scaler,
      7,
      neighborContext,
    ).logPrediction;
    const prediction = weights.baseline * baselineLog
      + weights.ridge * ridgePrediction
      + weights.neighbors * neighborPrediction;
    return actual - prediction;
  });
  const residuals = validation.residuals.length >= 3 ? validation.residuals : inSampleResiduals;

  return {
    targetKey,
    rows,
    baselineLog,
    ridge,
    scaler,
    weights,
    validation,
    residuals,
    predict(features) {
      const ridgeResult = ridge?.predict(features) || { logPrediction: baselineLog, contributions: {} };
      const neighborResult = nearestNeighbors(
        rows,
        features,
        targetKey,
        scaler,
        undefined,
        neighborContext,
      );
      const logPrediction = weights.baseline * baselineLog
        + weights.ridge * ridgeResult.logPrediction
        + weights.neighbors * neighborResult.logPrediction;
      return {
        logPrediction: clamp(logPrediction, 0, 20),
        expected: Math.max(0, Math.expm1(clamp(logPrediction, 0, 20))),
        contributions: ridgeResult.contributions,
        neighbors: neighborResult.neighbors,
        components: {
          baseline: Math.max(0, Math.expm1(baselineLog)),
          ridge: Math.max(0, Math.expm1(ridgeResult.logPrediction)),
          neighbors: Math.max(0, Math.expm1(neighborResult.logPrediction)),
        },
      };
    },
  };
}

function residualRange(predictionLog, residuals, lowQ, highQ) {
  const sorted = [...residuals].sort((a, b) => a - b);
  const spread = describe(sorted).standardDeviation;
  const fallbackSpread = Math.max(0.35, spread || 0.65);
  const lowResidual = sorted.length >= 3 ? quantile(sorted, lowQ) : -1.28 * fallbackSpread;
  const highResidual = sorted.length >= 3 ? quantile(sorted, highQ) : 1.28 * fallbackSpread;
  return {
    low: Math.max(0, Math.expm1(Math.max(0, predictionLog + lowResidual))),
    high: Math.max(0, Math.expm1(Math.max(0, predictionLog + highResidual))),
  };
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.sqrt(2)));
}

function probabilityAbove(predictionLog, threshold, residuals) {
  if (threshold <= 0) return 1;
  const targetResidual = Math.log1p(threshold) - predictionLog;
  if (residuals.length >= 8) {
    const above = residuals.filter((residual) => residual > targetResidual).length;
    // Lissage de Laplace : jamais 0 % ou 100 % sur un petit historique.
    return (above + 1) / (residuals.length + 2);
  }
  const stats = describe(residuals);
  const deviation = Math.max(0.35, stats.standardDeviation || 0.65);
  return 1 - normalCdf((targetResidual - stats.mean) / deviation);
}

function audienceActivityMultiplier(audienceActivity, features) {
  if (!Array.isArray(audienceActivity) || !audienceActivity.length) {
    return { multiplier: 1, confidence: 0, sampleSize: 0 };
  }
  const activityValue = (slot) => {
    const interactions = finite(slot.weightedInteractions, finite(slot.interactions));
    const uniqueUsers = finite(slot.uniqueUsers);
    const quality = slot.averageQuality == null ? 0.65 : clamp(finite(slot.averageQuality), 0, 1);
    // Les utilisateurs distincts dominent les répétitions d'une même session ;
    // la qualité enregistrée réduit encore le poids des rafales peu crédibles.
    return (uniqueUsers * 0.65 + interactions * 0.35) * (0.55 + quality * 0.45);
  };
  const total = audienceActivity.reduce((sum, slot) => sum + activityValue(slot), 0);
  const target = audienceActivity.filter((slot) => {
    const hourDifference = Math.min(
      Math.abs(finite(slot.hour) - features.hour),
      24 - Math.abs(finite(slot.hour) - features.hour),
    );
    return hourDifference <= 1 && finite(slot.dayOfWeek) === features.dayOfWeek;
  });
  const targetInteractions = target.reduce((sum, slot) => sum + activityValue(slot), 0);
  const targetSlots = Math.max(1, target.length);
  const globalPerSlot = total / Math.max(1, audienceActivity.length);
  const targetPerSlot = targetInteractions / targetSlots;
  if (globalPerSlot <= 0) return { multiplier: 1, confidence: 0, sampleSize: total };
  const raw = targetPerSlot / globalPerSlot;
  const confidence = total / (total + 100);
  return {
    multiplier: clamp(1 + (raw - 1) * confidence * 0.35, 0.72, 1.35),
    confidence,
    sampleSize: audienceActivity.reduce((sum, slot) => sum + finite(slot.interactions), 0),
  };
}

function aggregateDrivers(contributions, audienceSignal, neighborResult, baselineExpected) {
  const grouped = new Map();
  Object.entries(contributions || {}).forEach(([key, contribution]) => {
    const label = FEATURE_LABELS[key] || key;
    const existing = grouped.get(label) || 0;
    grouped.set(label, existing + contribution);
  });
  if (audienceSignal && Math.abs(audienceSignal.multiplier - 1) > 0.01) {
    grouped.set('Activité réelle de ton audience', Math.log(audienceSignal.multiplier));
  }
  if (neighborResult && baselineExpected > 0) {
    const neighborRatio = Math.max(0.05, neighborResult.components.neighbors / baselineExpected);
    grouped.set('Performance de tweets similaires', Math.log(neighborRatio));
  }
  return [...grouped.entries()]
    .map(([label, logImpact]) => ({
      label,
      impactPercent: round((Math.exp(logImpact) - 1) * 100),
      direction: logImpact >= 0 ? 'positive' : 'negative',
      strength: round(Math.abs(logImpact), 3),
    }))
    .filter((driver) => Math.abs(driver.impactPercent) >= 1)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 12);
}

function allocateEngagementComponents(expected, low, high, neighbors, rows) {
  const weighted = { likes: 2, retweets: 1, replies: 1 };
  let totalWeight = 4;
  const source = neighbors.length ? neighbors.map((neighbor) => ({
    row: neighbor.row,
    weight: neighbor.similarityWeight,
  })) : rows.map((row) => ({ row, weight: row.weight }));
  source.forEach(({ row, weight }) => {
    const engagement = Math.max(1, finite(row.adjustedEngagement));
    weighted.likes += weight * finite(row.adjustedLikes) / engagement;
    weighted.retweets += weight * finite(row.adjustedRetweets) / engagement;
    weighted.replies += weight * finite(row.adjustedReplies) / engagement;
    totalWeight += weight;
  });
  const rawShares = {
    likes: weighted.likes / totalWeight,
    retweets: weighted.retweets / totalWeight,
    replies: weighted.replies / totalWeight,
  };
  const shareTotal = rawShares.likes + rawShares.retweets + rawShares.replies || 1;
  return Object.fromEntries(Object.entries(rawShares).map(([key, value]) => {
    const share = value / shareTotal;
    return [key, {
      low: Math.max(0, Math.round(low * share)),
      expected: Math.max(0, Math.round(expected * share)),
      high: Math.max(0, Math.round(high * share)),
      sharePercent: round(share * 100, 1),
    }];
  }));
}

function dataQuality(rows) {
  const engagementValues = rows.map((row) => row.adjustedEngagement);
  const stats = describe(engagementValues);
  const iqr = stats.p75 - stats.p25;
  const outlierThreshold = stats.p75 + Math.max(1, 3 * iqr);
  const weights = rows.map((row) => row.weight);
  const matureRows = rows.filter((row) => row.ageHours >= 24);
  const viewRows = rows.filter((row) => row.views > 0);
  const behaviorRows = rows.filter((row) => finite(row.trackedViews) > 0);
  const completeRows = rows.filter((row) => (
    row.content != null && row.createdAt && row.engagement != null && row.views != null
  ));
  return {
    rawSampleSize: rows.length,
    matureSampleSize: matureRows.length,
    effectiveSampleSize: round(effectiveSampleSize(weights), 1),
    viewCoveragePercent: round((viewRows.length / Math.max(1, rows.length)) * 100),
    behaviorCoveragePercent: round((behaviorRows.length / Math.max(1, rows.length)) * 100),
    completenessPercent: round((completeRows.length / Math.max(1, rows.length)) * 100),
    zeroEngagementPercent: round((rows.filter((row) => row.engagement <= 0).length / Math.max(1, rows.length)) * 100),
    outlierPercent: round((rows.filter((row) => row.adjustedEngagement > outlierThreshold).length / Math.max(1, rows.length)) * 100),
    medianTweetAgeHours: round(describe(rows.map((row) => row.ageHours)).median),
  };
}

function confidenceFor({ rows, quality, engagementModel, prediction, viewPrediction }) {
  const sampleScore = clamp(Math.sqrt(quality.effectiveSampleSize / 45), 0, 1);
  const matureScore = clamp(quality.matureSampleSize / 25, 0, 1);
  const viewScore = quality.viewCoveragePercent / 100;
  const validationError = engagementModel.validation.errors.ridge;
  const validationScore = validationError == null ? 0.35 : clamp(1 - validationError / 1.5, 0, 1);
  const disagreement = Math.abs(Math.log1p(prediction.components.ridge) - Math.log1p(prediction.components.neighbors));
  const agreementScore = clamp(1 - disagreement / 1.5, 0, 1);
  const viewDisagreement = Math.abs(Math.log1p(viewPrediction.components.ridge) - Math.log1p(viewPrediction.components.neighbors));
  const viewAgreementScore = clamp(1 - viewDisagreement / 1.5, 0, 1);
  const numeric = round(100 * (
    sampleScore * 0.25
      + matureScore * 0.16
      + viewScore * 0.12
      + validationScore * 0.22
      + agreementScore * 0.17
      + viewAgreementScore * 0.08
  ));
  return {
    numeric,
    label: numeric >= 76 ? 'high' : numeric >= 52 ? 'medium' : 'low',
    components: {
      sample: round(sampleScore * 100),
      maturity: round(matureScore * 100),
      viewCoverage: round(viewScore * 100),
      backtest: round(validationScore * 100),
      modelAgreement: round(agreementScore * 100),
    },
    caveats: [
      rows.length < 12 ? 'Historique court : la base robuste pèse davantage.' : null,
      quality.viewCoveragePercent < 50 ? 'Les vues sont incomplètes sur une partie de l’historique.' : null,
      quality.behaviorCoveragePercent < 25 ? 'Peu de signaux comportementaux détaillés sont disponibles.' : null,
      engagementModel.validation.holdoutSize === 0 ? 'Pas encore assez de lignes pour un backtest temporel.' : null,
    ].filter(Boolean),
  };
}

function percentileRank(values, target) {
  if (!values.length) return 50;
  const below = values.filter((value) => value < target).length;
  const equal = values.filter((value) => value === target).length;
  return 100 * (below + equal * 0.5) / values.length;
}

function predictWithModels({
  features,
  engagementModel,
  viewModel,
  audienceActivity,
}) {
  const engagement = engagementModel.predict(features);
  const views = viewModel.predict(features);
  const audienceSignal = audienceActivityMultiplier(audienceActivity, features);
  const audienceLogAdjustment = Math.log(audienceSignal.multiplier);
  const adjustedEngagementLog = engagement.logPrediction + audienceLogAdjustment;
  const adjustedViewLog = views.logPrediction + audienceLogAdjustment;
  return {
    engagement: { ...engagement, logPrediction: adjustedEngagementLog, expected: Math.expm1(adjustedEngagementLog) },
    views: { ...views, logPrediction: adjustedViewLog, expected: Math.expm1(adjustedViewLog) },
    audienceSignal,
  };
}

function buildTimingForecast({
  baseFeatures,
  engagementModel,
  viewModel,
  audienceActivity,
  publishAt,
  baselineExpected,
}) {
  const start = new Date(publishAt);
  const candidates = [];
  for (let offsetHours = 0; offsetHours <= 7 * 24; offsetHours += 1) {
    const candidate = new Date(start.getTime() + offsetHours * 3600000);
    const features = {
      ...baseFeatures,
      hour: candidate.getHours(),
      dayOfWeek: candidate.getDay(),
      isWeekend: candidate.getDay() === 0 || candidate.getDay() === 6,
      hourSin: Math.sin((2 * Math.PI * candidate.getHours()) / 24),
      hourCos: Math.cos((2 * Math.PI * candidate.getHours()) / 24),
      daySin: Math.sin((2 * Math.PI * candidate.getDay()) / 7),
      dayCos: Math.cos((2 * Math.PI * candidate.getDay()) / 7),
      hoursSinceLastPost: baseFeatures.hoursSinceLastPost + offsetHours,
    };
    const result = predictWithModels({ features, engagementModel, viewModel, audienceActivity });
    candidates.push({
      publishAt: candidate.toISOString(),
      hour: features.hour,
      dayOfWeek: features.dayOfWeek,
      expectedEngagement: Math.max(0, round(result.engagement.expected)),
      expectedViews: Math.max(0, round(result.views.expected)),
      upliftPercent: baselineExpected > 0
        ? round(((result.engagement.expected / baselineExpected) - 1) * 100)
        : 0,
      audienceActivityIndex: round(result.audienceSignal.multiplier * 100),
    });
  }
  return candidates
    .sort((a, b) => b.expectedEngagement - a.expectedEngagement)
    .filter((candidate, index, list) => (
      list.findIndex((other) => other.dayOfWeek === candidate.dayOfWeek && other.hour === candidate.hour) === index
    ))
    .slice(0, 5);
}

function publicFeatures(features) {
  const { topicTokens, ...safe } = features;
  return safe;
}

function buildPrediction({
  history,
  content,
  mediaCount = 0,
  publishAt = new Date(),
  audienceActivity = [],
  authorContext = {},
}) {
  const now = new Date();
  const preparedAll = prepareHistory(history, now);
  const mature = preparedAll.filter((row) => row.ageHours >= MIN_MATURE_AGE_HOURS);
  const rows = (mature.length >= MIN_TRAINING_ROWS ? mature : preparedAll).slice(-MAX_HISTORY_ROWS);
  const lastPublished = preparedAll.length ? preparedAll[preparedAll.length - 1].createdAt : null;
  const when = publishAt instanceof Date ? publishAt : new Date(publishAt);
  const hoursSinceLastPost = lastPublished
    ? Math.max(0, (when - lastPublished) / 3600000)
    : 72;
  const features = extractFeatures(content, { mediaCount, publishAt: when, hoursSinceLastPost });

  if (rows.length < MIN_TRAINING_ROWS) {
    return {
      hasEnoughData: false,
      sampleSize: rows.length,
      minimumRequired: MIN_TRAINING_ROWS,
      features: publicFeatures(features),
      modelVersion: MODEL_VERSION,
    };
  }

  const sharedModelContext = {
    scaler: buildScaler(rows),
    neighborContext: {
      documentFrequency: buildDocumentFrequency(rows),
      documentCount: rows.length,
    },
  };
  const engagementModel = fitTargetEnsemble(rows, 'adjustedEngagement', sharedModelContext);
  const viewModel = fitTargetEnsemble(rows, 'adjustedViews', sharedModelContext);
  const predicted = predictWithModels({ features, engagementModel, viewModel, audienceActivity });
  const rateRows = rows.filter((row) => row.engagementPerThousandViews != null);
  let rateModel = null;
  let ratePrediction = null;
  let rateBlendWeight = 0;
  if (rateRows.length >= MIN_TRAINING_ROWS) {
    const rateContext = rateRows.length === rows.length
      ? sharedModelContext
      : {
        scaler: buildScaler(rateRows),
        neighborContext: {
          documentFrequency: buildDocumentFrequency(rateRows),
          documentCount: rateRows.length,
        },
      };
    rateModel = fitTargetEnsemble(rateRows, 'engagementPerThousandViews', rateContext);
    ratePrediction = rateModel.predict(features);
    rateBlendWeight = clamp((rateRows.length / rows.length) * 0.32, 0.08, 0.32);
    const engagementFromReach = predicted.views.expected * ratePrediction.expected / 1000;
    const blendedLog = predicted.engagement.logPrediction * (1 - rateBlendWeight)
      + Math.log1p(Math.max(0, engagementFromReach)) * rateBlendWeight;
    predicted.engagement.logPrediction = blendedLog;
    predicted.engagement.expected = Math.expm1(blendedLog);
  }
  const engagement80 = residualRange(predicted.engagement.logPrediction, engagementModel.residuals, 0.1, 0.9);
  const engagement95 = residualRange(predicted.engagement.logPrediction, engagementModel.residuals, 0.025, 0.975);
  const views80 = residualRange(predicted.views.logPrediction, viewModel.residuals, 0.1, 0.9);
  const views95 = residualRange(predicted.views.logPrediction, viewModel.residuals, 0.025, 0.975);
  const expectedEngagement = Math.max(0, predicted.engagement.expected);
  const expectedViews = Math.max(0, predicted.views.expected);
  const engagementBaseline = describe(rows.map((row) => row.adjustedEngagement));
  const viewBaseline = describe(rows.map((row) => row.adjustedViews));
  const quality = dataQuality(rows);
  const confidence = confidenceFor({
    rows,
    quality,
    engagementModel,
    prediction: predicted.engagement,
    viewPrediction: predicted.views,
  });
  const components = allocateEngagementComponents(
    expectedEngagement,
    engagement80.low,
    engagement80.high,
    predicted.engagement.neighbors,
    rows,
  );
  const engagementRate = expectedViews > 0 ? expectedEngagement / expectedViews : null;
  // Les clics n'existent que pour les contenus avec lien. Les apprendre comme
  // un troisième compte brut ferait surtout apprendre « pas de lien = zéro ».
  // On estime donc un CTR local sur les voisins possédant eux aussi un lien,
  // avec un prior global pour éviter qu'un seul tweet ne décide de tout.
  const linkedRows = rows.filter((row) => row.features.hasLink && row.adjustedViews > 0);
  const globalClickRate = linkedRows.length
    ? weightedQuantile(
      linkedRows.map((row) => row.adjustedClicks / Math.max(1, row.adjustedViews)),
      linkedRows.map((row) => row.weight),
      0.5,
    )
    : 0;
  const linkedNeighbors = predicted.engagement.neighbors.filter(
    (neighbor) => neighbor.row.features.hasLink && neighbor.row.adjustedViews > 0,
  );
  const neighborWeight = linkedNeighbors.reduce(
    (sum, neighbor) => sum + neighbor.similarityWeight,
    0,
  );
  const neighborClickRate = neighborWeight > EPSILON
    ? linkedNeighbors.reduce(
      (sum, neighbor) => sum + neighbor.similarityWeight
        * (neighbor.row.adjustedClicks / Math.max(1, neighbor.row.adjustedViews)),
      0,
    ) / neighborWeight
    : globalClickRate;
  const clickRateConfidence = linkedNeighbors.length / (linkedNeighbors.length + 5);
  const expectedClickRate = features.hasLink
    ? clamp(
      globalClickRate * (1 - clickRateConfidence) + neighborClickRate * clickRateConfidence,
      0,
      1,
    )
    : 0;
  const expectedClicks = expectedViews * expectedClickRate;
  const baselineExpected = Math.max(EPSILON, engagementBaseline.median);
  const drivers = aggregateDrivers(
    predicted.engagement.contributions,
    predicted.audienceSignal,
    predicted.engagement,
    baselineExpected,
  );
  const historyOutcomes = rows.map((row) => row.adjustedEngagement);
  const bestThreshold = engagementBaseline.p90;
  const probabilityAboveMedian = probabilityAbove(
    predicted.engagement.logPrediction,
    engagementBaseline.median,
    engagementModel.residuals,
  );
  const probabilityTop10 = probabilityAbove(
    predicted.engagement.logPrediction,
    bestThreshold,
    engagementModel.residuals,
  );
  const timingForecast = buildTimingForecast({
    baseFeatures: features,
    engagementModel,
    viewModel,
    audienceActivity,
    publishAt: when,
    baselineExpected: expectedEngagement,
  });
  const comparableTweets = predicted.engagement.neighbors.slice(0, 5).map((neighbor) => ({
    id: neighbor.row.id,
    content: String(neighbor.row.content || '').slice(0, 180),
    similarity: round(clamp(1 - neighbor.distance, 0, 1) * 100),
    lexicalSimilarity: round(neighbor.lexicalSimilarity * 100),
    engagement: round(neighbor.row.engagement),
    adjustedEngagement: round(neighbor.row.adjustedEngagement),
    views: round(neighbor.row.views),
    createdAt: neighbor.row.createdAt.toISOString(),
  }));

  return {
    hasEnoughData: true,
    sampleSize: rows.length,
    modelVersion: MODEL_VERSION,
    method: 'temporal-calibrated-ensemble',
    features: publicFeatures(features),
    score: round(percentileRank(historyOutcomes, expectedEngagement)),
    confidence: confidence.label,
    confidenceScore: confidence.numeric,
    confidenceDetails: confidence,
    prediction: {
      engagement: {
        low: Math.max(0, round(engagement80.low)),
        expected: Math.max(0, round(expectedEngagement)),
        high: Math.max(0, round(engagement80.high)),
        interval95: {
          low: Math.max(0, round(engagement95.low)),
          high: Math.max(0, round(engagement95.high)),
        },
      },
      views: {
        low: Math.max(0, round(views80.low)),
        expected: Math.max(0, round(expectedViews)),
        high: Math.max(0, round(views80.high)),
        interval95: {
          low: Math.max(0, round(views95.low)),
          high: Math.max(0, round(views95.high)),
        },
      },
      components,
      clicks: {
        expected: Math.max(0, round(expectedClicks)),
        clickThroughRatePercent: expectedViews > 0 ? round((expectedClicks / expectedViews) * 100, 2) : null,
      },
      engagementRatePercent: engagementRate == null ? null : round(engagementRate * 100, 2),
      reachVsFollowersPercent: finite(authorContext.followers) > 0
        ? round((expectedViews / finite(authorContext.followers)) * 100, 1)
        : null,
      multiplier: round(expectedEngagement / baselineExpected, 2),
    },
    probabilities: {
      aboveUsualPercent: round(probabilityAboveMedian * 100),
      top10Percent: round(probabilityTop10 * 100),
      belowUsualPercent: round((1 - probabilityAboveMedian) * 100),
    },
    baseline: {
      medianEngagement: round(engagementBaseline.median, 1),
      averageEngagement: round(engagementBaseline.mean, 1),
      p90Engagement: round(engagementBaseline.p90, 1),
      bestEverEngagement: round(engagementBaseline.max),
      medianViews: round(viewBaseline.median),
      medianEngagementRatePercent: round(weightedQuantile(
        rows.filter((row) => row.adjustedViews > 0).map((row) => row.adjustedEngagement / row.adjustedViews),
        rows.filter((row) => row.adjustedViews > 0).map((row) => row.weight),
        0.5,
      ) * 100, 2),
    },
    model: {
      featuresConsidered: FEATURE_DEFINITIONS.length,
      ensembleWeights: Object.fromEntries(
        Object.entries(engagementModel.weights).map(([key, value]) => [key, round(value * 100)]),
      ),
      backtest: {
        holdoutSize: engagementModel.validation.holdoutSize,
        meanAbsoluteError: engagementModel.validation.mae == null
          ? null
          : round(engagementModel.validation.mae, 1),
        logRmse: Object.fromEntries(Object.entries(engagementModel.validation.errors).map(
          ([key, value]) => [key, value == null ? null : round(value, 3)],
        )),
      },
      reachRateCrossCheck: rateModel ? {
        available: true,
        sampleSize: rateRows.length,
        blendWeightPercent: round(rateBlendWeight * 100),
        predictedEngagementRatePercent: round((ratePrediction.expected / 1000) * 100, 2),
      } : { available: false, sampleSize: rateRows.length },
      dataQuality: quality,
      recencyHalfLifeDays: RECENCY_HALF_LIFE_DAYS,
      maturityModelHours: ENGAGEMENT_MATURITY_HOURS,
      authorContext: {
        followers: finite(authorContext.followers),
        following: finite(authorContext.following),
        verified: Boolean(authorContext.verified),
        accountAgeDays: finite(authorContext.accountAgeDays),
        algorithmicVisibilityMultiplier: finite(authorContext.algorithmicVisibilityMultiplier, 1),
      },
    },
    drivers,
    audienceSignal: {
      activityIndex: round(predicted.audienceSignal.multiplier * 100),
      confidencePercent: round(predicted.audienceSignal.confidence * 100),
      interactionsAnalyzed: round(predicted.audienceSignal.sampleSize),
    },
    timingForecast,
    comparableTweets,
  };
}

function findComparableTweets(history, content, {
  mediaCount = 0,
  publishAt = new Date(),
  limit = 5,
} = {}) {
  const rows = prepareHistory(history);
  if (!rows.length) return [];
  const last = rows[rows.length - 1];
  const features = extractFeatures(content, {
    mediaCount,
    publishAt,
    hoursSinceLastPost: last ? Math.max(0, (new Date(publishAt) - last.createdAt) / 3600000) : 72,
  });
  const scaler = buildScaler(rows);
  return nearestNeighbors(rows, features, 'adjustedEngagement', scaler, limit).neighbors.map((neighbor) => ({
    id: neighbor.row.id,
    content: String(neighbor.row.content || '').slice(0, 180),
    similarity: round(clamp(1 - neighbor.distance, 0, 1) * 100),
    lexicalSimilarity: round(neighbor.lexicalSimilarity * 100),
    engagement: round(neighbor.row.engagement),
    views: round(neighbor.row.views),
    createdAt: neighbor.row.createdAt.toISOString(),
  }));
}

module.exports = {
  MODEL_VERSION,
  FEATURE_DEFINITIONS,
  extractFeatures,
  tokenizeContent,
  describe,
  weightedQuantile,
  prepareHistory,
  fitRidge,
  fitTargetEnsemble,
  buildPrediction,
  findComparableTweets,
  audienceActivityMultiplier,
  MIN_TRAINING_ROWS,
};
