const { User, ImpersonationAlert, Notification, UserAvatarFingerprint } = require('../models');
const { sequelize } = require('../database/index');
// Veille horaire : elle balaie toute la table `users` pour chaque abonné, et
// n'écrit rien. C'est exactement le type de requête à sortir du primaire —
// une donnée vieille d'une seconde ne change strictement rien à une alerte
// d'usurpation. Repli automatique sur le primaire s'il n'y a pas de réplique.
const { queryRead } = require('../database/readReplica');
const {
  IMPERSONATION_SIMILARITY_THRESHOLD,
  IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS,
} = require('../constants/premiumMarket');
const avatarFingerprint = require('./avatarFingerprint');
const logger = require('../utils/logger');

const INVISIBLE_CHARACTERS = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
const COMBINING_MARKS = /\p{Mark}/gu;
const NON_TEXT_CHARACTERS = /[^\p{Letter}\p{Number}]+/gu;
const NON_ASCII_IDENTIFIER = /[^a-z0-9]/g;

/**
 * Squelette visuel des caractères les plus souvent utilisés pour copier un
 * identifiant latin. La liste couvre le leetspeak, les lettres grecques et
 * cyrilliques, les petites capitales et les formes pleine largeur.
 *
 * Ce n'est volontairement pas une translittération linguistique : le but est
 * de réunir ce qu'un humain CONFOND visuellement, pas ce qui se prononce de la
 * même façon. Une translittération générale créerait beaucoup d'homonymes.
 */
const CONFUSABLE_CHARACTERS = Object.freeze({
  '0': 'o', '1': 'l', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'l',
  'ɑ': 'a', 'α': 'a', 'а': 'a', 'ӕ': 'a', 'ａ': 'a',
  'Ƅ': 'b', 'ƅ': 'b', 'в': 'b', 'Ꮟ': 'b', 'ᗷ': 'b', 'ｂ': 'b',
  'ϲ': 'c', 'с': 'c', 'Ϲ': 'c', 'Ⅽ': 'c', 'ｃ': 'c',
  'ԁ': 'd', 'ⅾ': 'd', 'ｄ': 'd',
  'е': 'e', 'ҽ': 'e', 'є': 'e', 'ε': 'e', '℮': 'e', 'ｅ': 'e',
  'ϝ': 'f', 'ք': 'f', 'ꞙ': 'f', 'ｆ': 'f',
  'ɡ': 'g', 'ց': 'g', 'ｇ': 'g',
  'һ': 'h', 'հ': 'h', 'Ꮒ': 'h', 'ｈ': 'h',
  'і': 'i', 'ι': 'i', 'ɩ': 'i', 'ⅰ': 'i', 'ｉ': 'i',
  'ϳ': 'j', 'ј': 'j', 'ｊ': 'j',
  'κ': 'k', 'к': 'k', 'K': 'k', 'Ꮶ': 'k', 'ｋ': 'k',
  'ӏ': 'l', 'ⅼ': 'l', 'ǀ': 'l', 'ｌ': 'l',
  'м': 'm', 'μ': 'm', 'ⅿ': 'm', 'ｍ': 'm',
  'ո': 'n', 'ռ': 'n', 'п': 'n', 'ｎ': 'n',
  'ο': 'o', 'о': 'o', 'օ': 'o', 'ഠ': 'o', '०': 'o', 'ｏ': 'o',
  'ρ': 'p', 'р': 'p', '⍴': 'p', 'ｐ': 'p',
  'ԛ': 'q', 'զ': 'q', 'ｑ': 'q',
  'г': 'r', 'ɽ': 'r', 'Ꭱ': 'r', 'ｒ': 'r',
  'ѕ': 's', 'Ꮥ': 's', 'ｓ': 's',
  'т': 't', 'τ': 't', 'Ꭲ': 't', 'ｔ': 't',
  'ս': 'u', 'υ': 'u', 'ｕ': 'u',
  'ѵ': 'v', 'ⅴ': 'v', 'ｖ': 'v',
  'ԝ': 'w', 'ѡ': 'w', 'ｗ': 'w',
  'х': 'x', 'χ': 'x', 'ⅹ': 'x', 'ｘ': 'x',
  'у': 'y', 'υ': 'y', 'ү': 'y', 'ｙ': 'y',
  'ᴢ': 'z', 'ʐ': 'z', 'ｚ': 'z',
});

const SQL_CONFUSABLE_ENTRIES = Object.entries(CONFUSABLE_CHARACTERS)
  .filter(([from, to]) => Array.from(from).length === 1 && /^[a-z]$/.test(to));
const SQL_CONFUSABLE_FROM = SQL_CONFUSABLE_ENTRIES.map(([from]) => from).join('');
const SQL_CONFUSABLE_TO = SQL_CONFUSABLE_ENTRIES.map(([, to]) => to).join('');

const IMPERSONATION_AFFIXES = new Set([
  'admin', 'aide', 'alt', 'authentic', 'authentique', 'backup', 'bis', 'compte',
  'equipe', 'fan', 'fr', 'france', 'help', 'info', 'levrai', 'off', 'officiel',
  'official', 'original', 'real', 'sav', 'secours', 'second', 'secondaire',
  'service', 'support', 'team', 'vrai', 'verified', 'verification',
]);

const DEFAULT_AVATAR_MARKERS = [
  'default-avatar', 'default_avatar', '/avatar/default', '/avatars/default',
  'anonymous-user', 'blank-profile', 'no-avatar', 'placeholder-avatar',
  'ui-avatars.com', 'gravatar.com/avatar/00000000000000000000000000000000',
];

/**
 * Veille usurpation — avantage abonné.
 *
 * On surveille trois signaux : un pseudo très proche, une photo de profil
 * identique, une bio recopiée. Aucun ne suffit seul à accuser quelqu'un —
 * des milliers de comptes partagent un avatar par défaut, et deux personnes
 * peuvent porter le même prénom. C'est pour ça que le score combine les
 * signaux et qu'une alerte reste une INFORMATION adressée au compte copié :
 * elle ne masque rien, ne restreint rien, ne sanctionne personne. La décision
 * appartient à la personne concernée, qui signale en un tap si elle le juge
 * utile.
 *
 * Le scan ne regarde que les comptes récents : un compte ouvert il y a trois
 * ans avec un pseudo proche du vôtre n'est pas en train de vous usurper, il
 * était juste là avant.
 */

/**
 * Distance de Levenshtein, en O(n) mémoire.
 *
 * Écrite ici plutôt que tirée de `pg_trgm` : l'extension n'est pas garantie
 * présente sur l'instance, et une fonctionnalité de sécurité qui s'éteint
 * silencieusement parce qu'une extension manque est pire que pas de
 * fonctionnalité du tout.
 */
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

function similarity(a, b) {
  const x = foldUnicode(a);
  const y = foldUnicode(b);
  if (!x || !y) return 0;
  const max = Math.max(x.length, y.length);
  return 1 - levenshtein(x, y) / max;
}

function foldUnicode(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim();
}

function confusableSkeleton(value) {
  const folded = foldUnicode(value);
  let skeleton = '';
  for (const character of folded) {
    if (character >= 'a' && character <= 'z') skeleton += character;
    else if (character >= '0' && character <= '9') {
      skeleton += CONFUSABLE_CHARACTERS[character] || character;
    } else if (CONFUSABLE_CHARACTERS[character]) {
      skeleton += CONFUSABLE_CHARACTERS[character];
    }
  }
  return skeleton.replace(NON_ASCII_IDENTIFIER, '');
}

function normalizeProfileText(value) {
  return foldUnicode(value)
    .split('')
    .map((character) => CONFUSABLE_CHARACTERS[character] || character)
    .join('')
    .replace(NON_TEXT_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Distance Damerau-Levenshtein bornée aux transpositions adjacentes. */
function damerauLevenshtein(a, b) {
  const x = Array.from(String(a || ''));
  const y = Array.from(String(b || ''));
  if (!x.length) return y.length;
  if (!y.length) return x.length;

  const matrix = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = 0; i <= x.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= y.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  return matrix[x.length][y.length];
}

/** Jaro-Winkler : utile quand le début du pseudo est conservé. */
function jaroWinkler(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y) return 0;
  if (x === y) return 1;

  const range = Math.max(0, Math.floor(Math.max(x.length, y.length) / 2) - 1);
  const xMatches = new Array(x.length).fill(false);
  const yMatches = new Array(y.length).fill(false);
  let matches = 0;

  for (let i = 0; i < x.length; i += 1) {
    const start = Math.max(0, i - range);
    const end = Math.min(i + range + 1, y.length);
    for (let j = start; j < end; j += 1) {
      if (yMatches[j] || x[i] !== y[j]) continue;
      xMatches[i] = true;
      yMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (!matches) return 0;

  const xSequence = [];
  const ySequence = [];
  xMatches.forEach((matched, index) => { if (matched) xSequence.push(x[index]); });
  yMatches.forEach((matched, index) => { if (matched) ySequence.push(y[index]); });
  let transpositions = 0;
  for (let i = 0; i < xSequence.length; i += 1) {
    if (xSequence[i] !== ySequence[i]) transpositions += 1;
  }

  const jaro = (
    matches / x.length
    + matches / y.length
    + (matches - transpositions / 2) / matches
  ) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) {
    prefix += 1;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function ngrams(value, size = 2) {
  const text = String(value || '');
  if (!text) return [];
  if (text.length <= size) return [text];
  const result = [];
  for (let i = 0; i <= text.length - size; i += 1) result.push(text.slice(i, i + size));
  return result;
}

function diceCoefficient(a, b) {
  const left = ngrams(a);
  const right = ngrams(b);
  if (!left.length || !right.length) return 0;
  const counts = new Map();
  left.forEach((gram) => counts.set(gram, (counts.get(gram) || 0) + 1));
  let overlap = 0;
  right.forEach((gram) => {
    const remaining = counts.get(gram) || 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(gram, remaining - 1);
    }
  });
  return (2 * overlap) / (left.length + right.length);
}

function tokenSet(value) {
  return new Set(normalizeProfileText(value).split(' ').filter((token) => token.length >= 2));
}

function tokenJaccard(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  left.forEach((token) => { if (right.has(token)) intersection += 1; });
  return intersection / (left.size + right.size - intersection);
}

function canonicalAvatar(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      parsed.hash = '';
      parsed.search = '';
      parsed.hostname = parsed.hostname.toLowerCase();
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    // Une URL historique mal formée reste comparable sous sa forme nettoyée.
  }
  return raw.split(/[?#]/, 1)[0].replace(/\/+$/, '');
}

function isKnownDefaultAvatar(value) {
  const normalized = canonicalAvatar(value).toLowerCase();
  return DEFAULT_AVATAR_MARKERS.some((marker) => normalized.includes(marker));
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function stripKnownImpersonationAffixes(value) {
  let core = String(value || '');
  const removed = [];
  const affixes = [...IMPERSONATION_AFFIXES].sort((a, b) => b.length - a.length);
  let changed = true;
  while (changed && core.length >= 5) {
    changed = false;
    for (const affix of affixes) {
      if (core.startsWith(affix) && core.length - affix.length >= 5) {
        core = core.slice(affix.length);
        removed.push(affix);
        changed = true;
        break;
      }
      if (core.endsWith(affix) && core.length - affix.length >= 5) {
        core = core.slice(0, -affix.length);
        removed.push(affix);
        changed = true;
        break;
      }
    }
  }
  return { core, removed };
}

/**
 * Variantes typographiques classiques d'un pseudo : le `l` remplacé par un
 * `1`, le `o` par un zéro, un underscore ajouté. La distance d'édition seule
 * les rate parfois sur les pseudos courts, alors que c'est exactement la
 * méthode la plus utilisée.
 */
function normalizeLookalike(username) {
  return confusableSkeleton(username);
}

function usernameAnalysis(targetUsername, suspectUsername) {
  const target = normalizeLookalike(targetUsername);
  const suspect = normalizeLookalike(suspectUsername);
  if (!target || !suspect) {
    return { score: 0, reason: null, exactSkeleton: false, distance: Infinity };
  }

  const distance = damerauLevenshtein(target, suspect);
  const maxLength = Math.max(target.length, suspect.length);
  const editSimilarity = 1 - distance / maxLength;
  const jaro = jaroWinkler(target, suspect);
  const dice = diceCoefficient(target, suspect);
  const exactSkeleton = target === suspect;
  const containsTarget = target.length >= 5 && suspect.includes(target) && suspect !== target;
  const affix = containsTarget ? suspect.replace(target, '') : '';
  const knownAffix = affix && (
    IMPERSONATION_AFFIXES.has(affix)
    || [...IMPERSONATION_AFFIXES].some((token) => affix === `le${token}` || affix === `mon${token}`)
  );
  const allowedEdits = target.length >= 11 ? 2 : 1;
  const stripped = stripKnownImpersonationAffixes(suspect);
  const strippedDistance = stripped.removed.length
    ? damerauLevenshtein(target, stripped.core)
    : Infinity;
  const blended = editSimilarity * 0.5 + jaro * 0.3 + dice * 0.2;

  let score = 0;
  let reason = null;
  if (exactSkeleton && foldUnicode(targetUsername) !== foldUnicode(suspectUsername)) {
    score = 0.96;
    reason = 'username_lookalike';
  } else if (stripped.removed.length && strippedDistance <= allowedEdits) {
    score = 0.9;
    reason = 'username_similar';
  } else if (distance <= allowedEdits && target.length >= 4) {
    score = clamp(0.78 + (editSimilarity - 0.7) * 0.6, 0.78, 0.93);
    reason = 'username_similar';
  } else if (knownAffix) {
    score = 0.87;
    reason = 'username_similar';
  } else if (containsTarget && target.length >= 7 && affix.length <= 4) {
    score = 0.79;
    reason = 'username_similar';
  } else if (blended >= 0.82 && jaro >= 0.86 && target.length >= 5) {
    score = clamp(0.72 + (blended - 0.82) * 0.8, 0.72, 0.86);
    reason = 'username_similar';
  }

  return {
    score,
    reason,
    exactSkeleton,
    distance,
    editSimilarity,
    jaro,
    dice,
    containsTarget,
    knownAffix: Boolean(knownAffix),
    strippedAffixes: stripped.removed,
    strippedDistance,
  };
}

/**
 * Évalue un suspect face à un compte protégé.
 * @returns {{score:number, reasons:string[]}}
 */
function evaluate(target, suspect) {
  const reasons = [];
  const username = usernameAnalysis(target.username, suspect.username);
  let score = username.score;
  if (username.reason) addReason(reasons, username.reason);

  /*
   * ── La photo, comparée par son CONTENU ────────────────────────────────
   *
   * L'égalité d'URL qui servait ici ne pouvait structurellement jamais se
   * déclencher entre deux comptes : un upload produit un nom de fichier de la
   * forme `<uuid-de-l-uploadeur>-<horodatage>-<aléa>.jpg`, donc l'identifiant
   * du compte est DANS l'URL. Deux personnes téléversant la même image
   * obtenaient toujours deux URL différentes. Le signal le plus fort des trois
   * était mort depuis l'origine — c'est ce qui laissait passer les comptes
   * usurpés créés pour le test.
   *
   * On compare désormais des empreintes perceptuelles (voir
   * `avatarFingerprint`) : reprendre la photo, la retailler et la recompresser
   * ne change presque aucun bit.
   */
  const targetAvatar = canonicalAvatar(target.avatar);
  const suspectAvatar = canonicalAvatar(suspect.avatar);
  const avatarDistinctive = suspect._sharedAvatarDistinctive !== false
    && !isKnownDefaultAvatar(targetAvatar);

  const sameUrl = Boolean(targetAvatar && suspectAvatar && targetAvatar === suspectAvatar);
  const samePixels = avatarFingerprint.sameImage(target._fingerprint, suspect._fingerprint);
  const sameAvatar = Boolean((sameUrl || samePixels) && avatarDistinctive);

  // Recadrage : la dHash décroche (la grille se décale), la signature couleur
  // tient. Mais elle sépare mal — deux avatars sans rapport atteignent 0,943 —
  // donc ce signal ne vaut QUE s'il vient renforcer autre chose. Seul, il
  // désignerait des inconnus.
  const croppedAvatar = !sameAvatar
    && avatarDistinctive
    && avatarFingerprint.likelyCroppedCopy(target._fingerprint, suspect._fingerprint);

  /*
   * La MEME SCENE, reprise dans un autre cadre.
   *
   * Cas reel : `@levraicongo` reprend la peluche, le decor et le fond de
   * `@policiercongo`, mais le sujet a bouge dans le cadre. Ce n'est pas un
   * recadrage — une dHash ne suit pas une translation, et meme en cherchant le
   * meilleur decoupage sur 9 echelles et 25 positions la distance ne descend
   * pas sous 12. C'est la conjonction distance + couleur qui l'attrape.
   *
   * Remonter sa photo dans un autre cadre demande d'AVOIR la photo, ou d'avoir
   * refait la mise en scene. Aucune des deux n'arrive par hasard : le signal
   * pese donc lourd, meme sans autre indice.
   */
  const reframedAvatar = !sameAvatar
    && avatarDistinctive
    && avatarFingerprint.sameSubject(target._fingerprint, suspect._fingerprint);
  if (reframedAvatar) {
    addReason(reasons, 'same_photo_reframed');
    score += 0.62;
  }

  if (sameAvatar) {
    addReason(reasons, 'same_avatar');
    score += username.score > 0 ? 0.14 : 0.32;
  }

  const targetBio = normalizeProfileText(target.bio);
  const suspectBio = normalizeProfileText(suspect.bio);
  const comparableBio = targetBio.length >= 20 && suspectBio.length >= 20;
  const exactBio = comparableBio && targetBio === suspectBio;
  const bioSimilarity = comparableBio
    ? Math.max(tokenJaccard(targetBio, suspectBio), diceCoefficient(targetBio, suspectBio))
    : 0;
  const similarBio = !exactBio && comparableBio && bioSimilarity >= 0.82;
  if (exactBio || similarBio) {
    addReason(reasons, 'same_bio');
    score += exactBio
      ? (username.score > 0 ? 0.14 : 0.28)
      : (username.score > 0 ? 0.09 : 0.17);
  }

  const targetDisplayName = normalizeProfileText(target.full_name);
  const suspectDisplayName = normalizeProfileText(suspect.full_name);
  const comparableDisplayName = targetDisplayName.length >= 3 && suspectDisplayName.length >= 3;
  const exactDisplayName = comparableDisplayName && targetDisplayName === suspectDisplayName;
  const displaySimilarity = comparableDisplayName
    ? Math.max(
      jaroWinkler(targetDisplayName, suspectDisplayName),
      diceCoefficient(targetDisplayName, suspectDisplayName),
    )
    : 0;
  const similarDisplayName = !exactDisplayName && comparableDisplayName && displaySimilarity >= 0.9;

  /*
   * Le nom affiché comptait UNIQUEMENT s'il accompagnait déjà un autre signal
   * (`reasons.length > 0`). Un compte qui reprend « Kospor et Caramel » à
   * l'identique sous un pseudo sans ressemblance marquait donc zéro — alors
   * que c'est le nom affiché, pas le pseudo, que lisent les gens dans le fil.
   *
   * Il pèse maintenant seul, mais deux fois moins : un nom courant est
   * légitimement partagé, un pseudo bien moins.
   */
  const corroborated = reasons.length > 0;
  // Un nom court est porte legitimement par des milliers de gens : « Gas »,
  // « Leo », « Marie ». Il ne devient une PREUVE que s'il est distinctif, ou
  // s'il vient confirmer un autre signal. Le seuil porte sur le nom normalise,
  // donc sur des lettres reelles, pas sur des espaces ou des emojis.
  const distinctiveDisplayName = targetDisplayName.replace(/\s+/g, '').length >= 8;
  if ((exactDisplayName || similarDisplayName) && (corroborated || distinctiveDisplayName)) {
    addReason(reasons, 'same_display_name');
    if (exactDisplayName) score += corroborated ? 0.1 : 0.34;
    else score += corroborated ? 0.06 : 0.18;
  }

  /*
   * ── Le contenu publié ─────────────────────────────────────────────────
   *
   * Un usurpateur recopie les tweets de sa cible pour rendre le compte
   * crédible. Aucun signal ne regardait ce qui était PUBLIÉ : un compte
   * pouvait republier mot pour mot et passer inaperçu.
   *
   * Mesuré sur les tweets récents des deux comptes (voir `contentOverlap`).
   * Reprendre le texte de quelqu'un est un geste beaucoup plus délibéré que
   * porter le même prénom — d'où un poids élevé même sans autre signal.
   */
  /*
   * ── Le croisement des champs ──────────────────────────────────────────
   *
   * Tout etait compare champ a champ : pseudo contre pseudo, nom contre nom,
   * bio contre bio. Or un usurpateur MELANGE les champs — c'est meme le
   * schema le plus courant, parce qu'il rend le compte credible sans copier
   * le pseudo, qui est la seule chose que la plateforme empeche de dupliquer.
   *
   * Cas reel manque par l'ancienne version : un compte nomme `fanfanpolicier`
   * portait « policiercong » comme NOM AFFICHE — a une lettre du PSEUDO de sa
   * cible, `policiercongo`. Aucun signal ne pouvait le voir : son pseudo ne
   * ressemble pas au pseudo, et son nom ne ressemble pas au nom.
   *
   * On compare donc aussi en diagonale. Le nom affiche est ce que les gens
   * lisent dans le fil ; y mettre le pseudo de quelqu'un d'autre n'a qu'une
   * seule raison d'etre.
   */
  const targetHandle = normalizeLookalike(target.username);
  const suspectHandle = normalizeLookalike(suspect.username);
  const targetNameSkeleton = confusableSkeleton(target.full_name);
  const suspectNameSkeleton = confusableSkeleton(suspect.full_name);

  const crossPairs = [
    [suspectNameSkeleton, targetHandle],   // son NOM copie ton PSEUDO
    [suspectHandle, targetNameSkeleton],   // son PSEUDO copie ton NOM
  ];
  let crossSimilarity = 0;
  let crossContainmentOnly = false;
  for (const [a, b] of crossPairs) {
    // Sous 6 caracteres, la ressemblance ne prouve rien : trop de mots courts
    // se ressemblent une fois reduits a leur squelette.
    if (a.length < 6 || b.length < 6) continue;
    const edit = similarity(a, b);
    if (edit > crossSimilarity) { crossSimilarity = edit; crossContainmentOnly = false; }
    // La CONTENANCE est un signal bien plus faible que la quasi-egalite :
    // « policiercongo fan club » contient le pseudo sans se faire passer pour
    // lui. On la retient, mais separement et pour beaucoup moins.
    if (edit < 0.6 && (a.includes(b) || b.includes(a)) && crossSimilarity < 0.6) {
      crossSimilarity = 0.6;
      crossContainmentOnly = true;
    }
  }

  if (crossSimilarity >= 0.6) {
    addReason(reasons, 'cross_field_copy');
    if (crossContainmentOnly) {
      // Contenance seule : ne doit jamais suffire.
      score += 0.2;
    } else if (crossSimilarity >= 0.92) {
      // Un nom affiche a une lettre du pseudo de la cible. Il n'existe pas de
      // raison innocente de s'appeler « policiercong » quand « policiercongo »
      // existe deja — c'est le cas reel que l'ancienne version laissait
      // passer. Suffisant seul pour PREVENIR la personne visee : l'alerte
      // l'informe, elle ne sanctionne personne, et elle s'ecarte d'un geste.
      score += 0.75;
    } else if (crossSimilarity >= 0.85) {
      score += 0.42;
    } else {
      score += 0.22;
    }
  }

  /*
   * Une bio qui REVENDIQUE d'etre le compte de la cible.
   *
   * « officiel compte de policiercongolevrai », « le vrai <pseudo> » : le
   * texte lui-meme dit l'intention. C'est le seul signal du lot ou l'auteur
   * ecrit noir sur blanc ce qu'il fait, et il ne coutait rien a lire.
   */
  const claimWords = /(officiel|official|le ?vrai|real|authentique|compte de|page de)/i;
  const bioClaimsTarget = Boolean(
    targetHandle.length >= 6
    && suspectBio
    && claimWords.test(suspect.bio || '')
    && confusableSkeleton(suspect.bio).includes(targetHandle),
  );
  if (bioClaimsTarget) {
    addReason(reasons, 'bio_claims_identity');
    score += 0.3;
  }

  const contentSimilarity = Number(suspect._contentSimilarity) || 0;
  const copiedContent = contentSimilarity >= 0.6;
  if (copiedContent) {
    addReason(reasons, 'copied_tweets');
    score += contentSimilarity >= 0.85 ? 0.4 : 0.24;
  }

  if (croppedAvatar && reasons.length > 0) {
    addReason(reasons, 'cropped_avatar');
    score += 0.12;
  }

  // Synergies de profil : une copie exacte de la photo + du nom ou de la bio
  // doit remonter même si l'attaquant choisit un pseudo sans ressemblance.
  if (sameAvatar && exactBio && exactDisplayName) score = Math.max(score, 0.93);
  else if (sameAvatar && (exactBio || similarBio)) score = Math.max(score, 0.86);
  else if (sameAvatar && exactDisplayName) score = Math.max(score, 0.79);
  else if (exactBio && exactDisplayName) score = Math.max(score, 0.77);

  // Reprendre la photo ET les publications ne laisse plus de lecture
  // innocente : ce sont deux gestes deliberes qui visent la meme personne.
  // Reprendre la mise en scene de quelqu'un ET un fragment de son identite ne
  // laisse plus de lecture innocente.
  if (reframedAvatar && (username.score > 0 || crossSimilarity >= 0.6 || exactDisplayName)) {
    score = Math.max(score, 0.88);
  }

  if (sameAvatar && copiedContent) score = Math.max(score, 0.95);
  else if (copiedContent && (exactDisplayName || username.score > 0)) score = Math.max(score, 0.88);

  return {
    score: Math.round(clamp(score) * 1000) / 1000,
    reasons,
    metrics: {
      username,
      same_avatar: sameAvatar,
      same_avatar_by: sameAvatar ? (samePixels ? 'pixels' : 'url') : null,
      cropped_avatar: croppedAvatar,
      same_photo_reframed: reframedAvatar,
      bio_similarity: Math.round(bioSimilarity * 1000) / 1000,
      display_name_similarity: Math.round(displaySimilarity * 1000) / 1000,
      content_similarity: Math.round(contentSimilarity * 1000) / 1000,
      cross_field_similarity: Math.round(crossSimilarity * 1000) / 1000,
      bio_claims_identity: bioClaimsTarget,
    },
  };
}


/* ══════════════════════════════════════════════════════════════════════════
   Empreintes de photo et contenu publié
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Empreinte perceptuelle d'un compte, calculée à la demande puis mémorisée.
 *
 * Le calcul lit un fichier et le décode : le refaire à chaque balayage horaire
 * pour chaque compte coûterait des milliers de décodages par heure pour un
 * résultat identique. La ligne est donc conservée et n'est recalculée que
 * lorsque l'URL de la photo change — c'est-à-dire quand la personne en change.
 *
 * `unreadable` est mémorisé aussi : une image corrompue échouerait sinon à
 * chaque passage, indéfiniment, pour un résultat connu d'avance.
 */
async function ensureFingerprint(user) {
  const avatarUrl = String(user?.avatar || '').trim();
  if (!avatarUrl || isKnownDefaultAvatar(avatarUrl)) return null;

  const existing = await UserAvatarFingerprint.findByPk(user.id);
  if (existing && existing.avatar_url === avatarUrl) {
    return existing.unreadable
      ? null
      : {
        dhash: existing.dhash,
        ahash: existing.ahash,
        pyramid: existing.pyramid || (existing.dhash ? [existing.dhash] : []),
        color: existing.color,
      };
  }

  const computed = await avatarFingerprint.fingerprintAvatar(avatarUrl);
  const row = {
    user_id: user.id,
    avatar_url: avatarUrl,
    dhash: computed?.dhash || null,
    ahash: computed?.ahash || null,
    pyramid: computed?.pyramid || null,
    bands: computed?.bands || null,
    color: computed?.color || null,
    unreadable: !computed,
    computed_at: new Date(),
  };
  try {
    await UserAvatarFingerprint.upsert(row);
  } catch (error) {
    // Une empreinte qu'on n'a pas pu écrire ne doit pas interrompre la veille :
    // on s'en sert quand même pour ce passage-ci.
    logger.warn(`[usurpation] empreinte non enregistrée pour ${user.id} : ${error.message}`);
  }
  return computed;
}

/**
 * Calcule les empreintes manquantes des comptes a vraie photo.
 *
 * ── Pourquoi c'est indispensable, et pas une optimisation ────────────────
 *
 * La preselection par la photo interroge `user_avatar_fingerprints`. Mais les
 * empreintes des suspects n'etaient calculees QU'APRES qu'ils soient devenus
 * candidats — donc un compte trouvable uniquement par sa photo ne pouvait
 * jamais l'etre : son empreinte n'existait pas encore au moment ou on la
 * cherchait. Poule et oeuf, et le symptome est un silence complet.
 *
 * Les comptes a l'avatar par defaut sont ecartes : ils sont des milliers a
 * partager la meme image, leur empreinte ne distingue rien et remplirait la
 * table pour rien.
 */
async function backfillFingerprints({ limit = 300 } = {}) {
  const rows = await queryRead(`
    SELECT u.id::text AS id, u.avatar
    FROM users u
    LEFT JOIN user_avatar_fingerprints f
      ON f.user_id = u.id AND f.avatar_url = u.avatar
    WHERE u.is_active = true
      AND COALESCE(u.is_data_test, false) = false
      AND u.avatar LIKE '%/static/avatars/%'
      AND f.user_id IS NULL
    ORDER BY u.updated_at DESC
    LIMIT :limit
  `, { replacements: { limit }, type: sequelize.QueryTypes.SELECT });

  let computed = 0;
  // En serie : chaque calcul decode une image, et les lancer de front ferait
  // tomber la latence de toutes les autres requetes du processus.
  for (const row of rows) {
    const print = await ensureFingerprint({ id: row.id, avatar: row.avatar });
    if (print) computed += 1;
  }
  if (rows.length) logger.info(`[usurpation] ${computed}/${rows.length} empreintes calculees`);
  return computed;
}

/**
 * Comptes dont la photo ressemble à celle de la cible.
 *
 * ── Pourquoi des bandes et pas une égalité ───────────────────────────────
 *
 * Un réupload identique donne la même dHash, mais un redimensionnement ou une
 * recompression en décale 1 à 3 bits (mesuré sur de vrais avatars) : l'égalité
 * exacte les manquerait, et ce sont précisément les cas courants.
 *
 * La dHash est donc découpée en quatre bandes de 16 bits. Par le principe des
 * tiroirs, deux empreintes distantes de 3 bits ou moins partagent forcément au
 * moins une bande à l'identique. On récupère ce vivier, puis la distance de
 * Hamming tranche en mémoire — sur quelques dizaines de lignes, pas sur la
 * table entière.
 */
async function avatarCandidateIds(targetId, fingerprint) {
  if (!fingerprint?.dhash) return [];

  /*
   * ── Pourquoi on charge, au lieu de filtrer en SQL ──────────────────────
   *
   * La preselection par tranches (« bandes ») ne garantit un recouvrement que
   * pour des empreintes distantes de 3 bits ou moins — c'est le principe des
   * tiroirs sur 64 bits en 4 tranches. Elle attrape donc le reupload et le
   * redimensionnement, mais PAS une photo reprise dans un autre cadre, ou la
   * distance monte a 11 (cas reel mesure : @levraicongo face a
   * @policiercongo).
   *
   * Or ce cas-la est justement celui qu'on veut voir. Comme seuls les comptes
   * a VRAIE photo portent une empreinte — l'avatar par defaut est ecarte, et
   * il couvre l'immense majorite de la base — le vivier reel se compte en
   * dizaines. On le charge et on applique les vrais predicats en memoire,
   * plutot que d'approximer en SQL.
   *
   * `MAX_FINGERPRINTS` est la borne de securite : au-dela, il faudra une
   * vraie recherche par voisinage (index LSH sur les bandes), pas un plafond
   * plus haut.
   */
  const MAX_FINGERPRINTS = 5000;
  const rows = await queryRead(`
    SELECT f.user_id::text AS user_id, f.pyramid, f.dhash, f.ahash, f.color
    FROM user_avatar_fingerprints f
    JOIN users u ON u.id = f.user_id
    WHERE f.user_id <> :targetId
      AND f.unreadable = false
      AND f.dhash IS NOT NULL
      AND u.is_active = true
      AND u.is_suspended = false
    LIMIT :max
  `, {
    replacements: { targetId: String(targetId), max: MAX_FINGERPRINTS },
    type: sequelize.QueryTypes.SELECT,
  });

  const matches = [];
  for (const row of rows) {
    const other = {
      dhash: row.dhash,
      ahash: row.ahash,
      pyramid: row.pyramid || (row.dhash ? [row.dhash] : []),
      color: row.color,
    };
    if (avatarFingerprint.sameImage(fingerprint, other)
      || avatarFingerprint.sameSubject(fingerprint, other)) {
      matches.push(String(row.user_id));
    }
  }
  return matches;
}

/** Normalise un tweet pour la comparaison : on compare des MOTS, pas des pixels. */
function normalizeTweetText(value) {
  return normalizeProfileText(value);
}

/**
 * Part des publications récentes du suspect qui reprennent celles de la cible.
 *
 * ── Pourquoi ce signal manquait, et pourquoi il pèse lourd ───────────────
 *
 * Aucun signal ne regardait ce qui est PUBLIÉ. Un compte pouvait recopier mot
 * pour mot les tweets de sa cible — le moyen le plus efficace de rendre une
 * usurpation crédible — sans que rien ne le remarque.
 *
 * On mesure la proportion des tweets du suspect qui ont un jumeau proche chez
 * la cible, et non l'inverse : c'est le suspect qui copie. Prendre la moyenne
 * des deux diluerait le signal dès que la cible publie beaucoup.
 *
 * Les textes très courts sont écartés : « merci », « lol » et « bonjour » sont
 * écrits par tout le monde et ne prouvent rien.
 */
const MIN_TWEET_CHARS = 25;
const TWEET_SAMPLE = 30;

async function contentOverlap(targetId, suspectIds) {
  const ids = [...new Set(suspectIds.map(String))].filter(Boolean);
  if (!ids.length) return new Map();

  const rows = await queryRead(`
    SELECT user_id::text AS user_id, content
    FROM (
      SELECT user_id, content,
             row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rank
      FROM tweets
      WHERE user_id = ANY(ARRAY[:ids]::uuid[])
        AND COALESCE(is_data_test, false) = false
        AND deleted_at IS NULL
        AND content IS NOT NULL
    ) ranked
    WHERE rank <= :sample
  `, {
    replacements: { ids: [targetId, ...ids].map(String), sample: TWEET_SAMPLE },
    type: sequelize.QueryTypes.SELECT,
  });

  const byUser = new Map();
  for (const row of rows) {
    const text = normalizeTweetText(row.content);
    if (text.length < MIN_TWEET_CHARS) continue;
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(text);
  }

  const targetTexts = byUser.get(String(targetId)) || [];
  const result = new Map();
  if (!targetTexts.length) return result;

  const targetSet = new Set(targetTexts);
  for (const id of ids) {
    const texts = byUser.get(id) || [];
    if (!texts.length) continue;
    let matched = 0;
    for (const text of texts) {
      if (targetSet.has(text)) { matched += 1; continue; }
      // Une reprise avec un mot changé reste une reprise.
      if (targetTexts.some((other) => diceCoefficient(text, other) >= 0.88)) matched += 1;
    }
    result.set(id, matched / texts.length);
  }
  return result;
}

/** Suspects plausibles pour un compte, sans balayer toute la table `users`. */
async function findSuspects(target, targetFingerprint) {
  const since = new Date(Date.now() - IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS * 86400000);
  const normalized = normalizeLookalike(target.username);
  if (!normalized) return [];

  // Comptes dont la PHOTO ressemble a celle de la cible. Sans eux, un suspect
  // au pseudo sans rapport et a la photo reuploadee n'etait jamais candidat :
  // le score ne tournait meme pas sur lui, quelle que soit sa qualite.
  const avatarIds = await avatarCandidateIds(target.id, targetFingerprint);

  // Un avatar de défaut peut être partagé par des milliers de comptes. Il
  // n'entre dans la présélection que s'il est rare dans les comptes réels.
  let avatarIsDistinctive = false;
  if (target.avatar && !isKnownDefaultAvatar(target.avatar)) {
    const uses = await User.count({
      where: { avatar: target.avatar, is_active: true, is_data_test: false },
    });
    avatarIsDistinctive = uses <= 12;
  }

  // Trois fragments répartis dans le pseudo. En exiger deux permet une faute
  // locale sans ouvrir un LIMIT arbitraire sur les derniers comptes créés.
  const fragmentSize = normalized.length >= 9 ? 3 : 2;
  const lastStart = Math.max(0, normalized.length - fragmentSize);
  const middleStart = Math.max(0, Math.floor((normalized.length - fragmentSize) / 2));
  const fragmentValues = [...new Set([
    normalized.slice(0, fragmentSize),
    normalized.slice(middleStart, middleStart + fragmentSize),
    normalized.slice(lastStart),
  ])];
  while (fragmentValues.length < 3) {
    fragmentValues.push(`__twitninf_impossible_fragment_${fragmentValues.length}__`);
  }
  const fragments = fragmentValues.map((fragment) => `%${fragment}%`);

  const rows = await queryRead(`
    WITH recent_accounts AS (
      SELECT
        id, username, full_name, avatar, bio, created_at, updated_at, verified,
        regexp_replace(
          translate(lower(COALESCE(username, '')), :confusableFrom, :confusableTo),
          '[^a-z0-9]', '', 'g'
        ) AS username_skeleton,
        -- Meme reduction appliquee au NOM AFFICHE. Sans elle, un compte qui
        -- met le pseudo de sa cible dans son nom n'etait jamais candidat : le
        -- score, aussi bon soit-il, ne tournait jamais sur lui.
        regexp_replace(
          translate(lower(COALESCE(full_name, '')), :confusableFrom, :confusableTo),
          '[^a-z0-9]', '', 'g'
        ) AS name_skeleton
      FROM users
      WHERE id <> :targetId
        AND is_active = true
        AND is_suspended = false
        AND COALESCE(is_data_test, false) = false
        AND (created_at >= :since OR updated_at >= :since)
    ),
    plausible AS (
      SELECT *,
        CASE
          WHEN username_skeleton = :targetSkeleton THEN 100
          WHEN username_skeleton LIKE :containedSkeleton THEN 92
          WHEN (
            (username_skeleton LIKE :fragmentA)::int
            + (username_skeleton LIKE :fragmentB)::int
            + (username_skeleton LIKE :fragmentC)::int
          ) >= 2 THEN 82
          WHEN name_skeleton = :targetSkeleton THEN 96
          WHEN (
            (name_skeleton LIKE :fragmentA)::int
            + (name_skeleton LIKE :fragmentB)::int
            + (name_skeleton LIKE :fragmentC)::int
          ) >= 2 THEN 90
          WHEN id = ANY(ARRAY[:avatarIds]::uuid[]) THEN 88
          WHEN :avatarDistinctive = true AND avatar = :targetAvatar THEN 70
          WHEN :targetFullName <> '' AND lower(trim(COALESCE(full_name, ''))) = :targetFullName THEN 60
          WHEN :targetBio <> '' AND lower(trim(COALESCE(bio, ''))) = :targetBio THEN 55
          ELSE 0
        END AS candidate_priority
      FROM recent_accounts
      WHERE username_skeleton = :targetSkeleton
        OR username_skeleton LIKE :containedSkeleton
        OR (
          (username_skeleton LIKE :fragmentA)::int
          + (username_skeleton LIKE :fragmentB)::int
          + (username_skeleton LIKE :fragmentC)::int
        ) >= 2
        OR name_skeleton = :targetSkeleton
        OR (
          (name_skeleton LIKE :fragmentA)::int
          + (name_skeleton LIKE :fragmentB)::int
          + (name_skeleton LIKE :fragmentC)::int
        ) >= 2
        OR id = ANY(ARRAY[:avatarIds]::uuid[])
        OR (:avatarDistinctive = true AND avatar = :targetAvatar)
        OR (:targetFullName <> '' AND lower(trim(COALESCE(full_name, ''))) = :targetFullName)
        OR (:targetBio <> '' AND lower(trim(COALESCE(bio, ''))) = :targetBio)
    )
    SELECT id, username, full_name, avatar, bio, created_at, verified
    FROM plausible
    ORDER BY candidate_priority DESC, updated_at DESC
    LIMIT 400
  `, {
    replacements: {
      targetId: String(target.id),
      since,
      confusableFrom: SQL_CONFUSABLE_FROM,
      confusableTo: SQL_CONFUSABLE_TO,
      targetSkeleton: normalized,
      containedSkeleton: `%${normalized}%`,
      fragmentA: fragments[0],
      fragmentB: fragments[1],
      fragmentC: fragments[2],
      avatarDistinctive: avatarIsDistinctive,
      // Tableau jamais vide : `ARRAY[]::uuid[]` sans element fait echouer
      // l'inference de type de Postgres.
      avatarIds: avatarIds.length ? avatarIds : ['00000000-0000-0000-0000-000000000000'],
      targetAvatar: String(target.avatar || ''),
      targetFullName: String(target.full_name || '').trim().toLowerCase(),
      targetBio: String(target.bio || '').trim().toLowerCase().slice(0, 1000),
    },
    type: sequelize.QueryTypes.SELECT,
  });

  rows.forEach((candidate) => {
    // Information interne au score, jamais exposée par `listFor`.
    candidate._sharedAvatarDistinctive = avatarIsDistinctive;
  });
  return rows;
}

/**
 * Scanne un compte et crée les alertes manquantes.
 * @returns {Promise<number>} nombre d'alertes nouvellement créées
 */
async function scanUser(userId) {
  const target = await User.findByPk(userId, {
    attributes: ['id', 'username', 'full_name', 'avatar', 'bio', 'verified', 'is_data_test'],
  });
  if (!target || target.is_data_test) return 0;

  // Sans ce rattrapage, la preselection par la photo ne trouve rien : elle
  // cherche dans une table que seul le scan remplit.
  await backfillFingerprints({ limit: 150 });

  const targetFingerprint = await ensureFingerprint(target);
  target._fingerprint = targetFingerprint;

  const suspects = await findSuspects(target, targetFingerprint);
  let created = 0;

  // Les empreintes des suspects sont calculees en serie et non en parallele :
  // chaque calcul decode une image, et lancer 400 decodages de front sur le
  // meme processus ferait tomber la latence de toutes les autres requetes.
  for (const suspect of suspects) {
    suspect._fingerprint = await ensureFingerprint(suspect);
  }

  const overlap = await contentOverlap(target.id, suspects.map((s) => s.id));
  for (const suspect of suspects) {
    suspect._contentSimilarity = overlap.get(String(suspect.id)) || 0;
  }

  for (const suspect of suspects) {
    const { score, reasons } = evaluate(target, suspect);
    if (!reasons.length || score < IMPERSONATION_SIMILARITY_THRESHOLD) continue;

    // Un compte certifié n'usurpe pas : il a passé une vérification
    // d'identité, et l'alerter dessus ne ferait que du bruit.
    if (suspect.verified) continue;

    const existing = await ImpersonationAlert.findOne({
      where: { user_id: target.id, suspect_id: suspect.id },
    });
    if (existing) {
      // Une alerte écartée ne revient jamais, même si le scan la retrouve :
      // c'est ce qui empêche la fonctionnalité de devenir harcelante.
      if (existing.status === 'dismissed') continue;
      const previousReasons = new Set(existing.reasons || []);
      const reasonsChanged = reasons.length !== previousReasons.size
        || reasons.some((reason) => !previousReasons.has(reason));
      if (Number(existing.score) < score || reasonsChanged) {
        await existing.update({ score: Math.max(Number(existing.score) || 0, score), reasons });
      }
      continue;
    }

    const alert = await ImpersonationAlert.create({
      user_id: target.id,
      suspect_id: suspect.id,
      reasons,
      score,
      suspect_username_at_detection: suspect.username,
    });
    created += 1;

    try {
      await Notification.createNotification({
        recipient_id: target.id,
        type: 'system',
        title: 'Un compte te ressemble',
        message: `@${suspect.username} utilise des éléments proches de ton profil.`,
        priority: 'high',
        content: {
          kind: 'impersonation_alert',
          alert_id: alert.id,
          suspect_id: suspect.id,
          suspect_username: suspect.username,
        },
      });
      await alert.update({ notified_at: new Date() });
    } catch (e) {
      logger.warn('[impersonation] Notification non envoyée:', e.message);
    }
  }

  return created;
}

/**
 * Passage complet : uniquement les abonnés actifs, par lots.
 *
 * Le scan est lourd (une requête de candidats par compte protégé) : le
 * limiter aux abonnés n'est pas qu'une question d'offre, c'est ce qui le rend
 * exécutable.
 */
async function scanAllSubscribers({ limit = 200 } = {}) {
  const subscribers = await queryRead(`
    SELECT id FROM users
    WHERE subscription_tier <> 'free'
      AND premium = true
      AND (subscription_expires_at IS NULL OR subscription_expires_at > NOW())
      AND is_active = true
      AND is_suspended = false
      AND COALESCE(is_data_test, false) = false
    ORDER BY last_activity DESC NULLS LAST
    LIMIT :limit
  `, {
    replacements: { limit },
    type: sequelize.QueryTypes.SELECT,
  });

  let created = 0;
  for (const row of subscribers) {
    try {
      created += await scanUser(row.id);
    } catch (e) {
      logger.warn(`[impersonation] Scan de ${row.id} en échec: ${e.message}`);
    }
  }
  if (created) logger.info(`[impersonation] ${created} nouvelle(s) alerte(s)`);
  return created;
}

async function listFor(userId, { status = 'open' } = {}) {
  const where = { user_id: userId };
  if (status !== 'all') where.status = status;

  const rows = await ImpersonationAlert.findAll({
    where,
    include: [{
      model: User,
      as: 'suspect',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'created_at'],
    }],
    order: [['score', 'DESC'], ['created_at', 'DESC']],
    limit: 100,
  });

  return rows.map((r) => ({
    id: r.id,
    score: Number(r.score),
    reasons: r.reasons || [],
    status: r.status,
    detected_at: r.created_at,
    suspect: r.suspect
      ? {
        id: r.suspect.id,
        username: r.suspect.username,
        full_name: r.suspect.full_name,
        avatar: r.suspect.avatar,
        verified: r.suspect.verified,
        account_created_at: r.suspect.created_at,
        // Le pseudo peut avoir changé depuis : l'app affiche les deux, sinon
        // l'alerte devient incompréhensible.
        username_at_detection: r.suspect_username_at_detection,
      }
      : null,
  }));
}

async function dismiss({ userId, alertId }) {
  const alert = await ImpersonationAlert.findByPk(alertId);
  if (!alert) throw new Error('Alerte introuvable');
  if (String(alert.user_id) !== String(userId)) throw new Error('Cette alerte n\'est pas la tienne');
  await alert.update({ status: 'dismissed', dismissed_at: new Date() });
  return alert;
}

/** Marque l'alerte comme signalée ; le signalement lui-même passe par `Report`. */
async function markReported({ userId, alertId, reportId }) {
  const alert = await ImpersonationAlert.findByPk(alertId);
  if (!alert) throw new Error('Alerte introuvable');
  if (String(alert.user_id) !== String(userId)) throw new Error('Cette alerte n\'est pas la tienne');
  await alert.update({ status: 'reported', report_id: reportId || null });
  return alert;
}

module.exports = {
  backfillFingerprints,
  scanUser,
  scanAllSubscribers,
  listFor,
  dismiss,
  markReported,
  evaluate,
  findSuspects,
  similarity,
  normalizeLookalike,
  usernameAnalysis,
  damerauLevenshtein,
  jaroWinkler,
  diceCoefficient,
  SQL_CONFUSABLE_FROM,
  SQL_CONFUSABLE_TO,
};
