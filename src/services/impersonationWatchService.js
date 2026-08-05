const { User, ImpersonationAlert, Notification } = require('../models');
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

  const targetAvatar = canonicalAvatar(target.avatar);
  const suspectAvatar = canonicalAvatar(suspect.avatar);
  const avatarDistinctive = suspect._sharedAvatarDistinctive !== false
    && !isKnownDefaultAvatar(targetAvatar);
  const sameAvatar = Boolean(
    targetAvatar && suspectAvatar && targetAvatar === suspectAvatar && avatarDistinctive,
  );
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
  if ((exactDisplayName || similarDisplayName) && reasons.length > 0) {
    addReason(reasons, 'same_display_name');
    score += exactDisplayName ? 0.1 : 0.06;
  }

  // Synergies de profil : une copie exacte de la photo + du nom ou de la bio
  // doit remonter même si l'attaquant choisit un pseudo sans ressemblance.
  if (sameAvatar && exactBio && exactDisplayName) score = Math.max(score, 0.93);
  else if (sameAvatar && (exactBio || similarBio)) score = Math.max(score, 0.86);
  else if (sameAvatar && exactDisplayName) score = Math.max(score, 0.79);
  else if (exactBio && exactDisplayName) score = Math.max(score, 0.77);

  return {
    score: Math.round(clamp(score) * 1000) / 1000,
    reasons,
    metrics: {
      username,
      same_avatar: sameAvatar,
      bio_similarity: Math.round(bioSimilarity * 1000) / 1000,
      display_name_similarity: Math.round(displaySimilarity * 1000) / 1000,
    },
  };
}

/** Suspects plausibles pour un compte, sans balayer toute la table `users`. */
async function findSuspects(target) {
  const since = new Date(Date.now() - IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS * 86400000);
  const normalized = normalizeLookalike(target.username);
  if (!normalized) return [];

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
        ) AS username_skeleton
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

  const suspects = await findSuspects(target);
  let created = 0;

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
