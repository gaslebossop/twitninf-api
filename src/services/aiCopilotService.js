/**
 * Co-pilote IA de rédaction — avantage du palier Pro.
 *
 * Propose des reformulations, des accroches et des hashtags pendant l'écriture.
 * Il PROPOSE, il ne publie jamais : le texte retenu repasse par le composeur
 * normal, donc par la modération habituelle. Un tweet suggéré par le co-pilote
 * n'a aucun passe-droit.
 *
 * Passe par Codex (`services/codexTextClient.js`), pas par Gemini : Gemini sert
 * la modération, qui est prioritaire et fonctionne par rafales — lui prendre du
 * quota pour une aide à l'écriture ferait retomber des tweets en échec de
 * modération. Codex, lui, spawne un processus par appel : d'où le limiteur par
 * utilisateur ci-dessous, indispensable et pas seulement prudent.
 */

const codex = require('./codexTextClient');

/** Au-delà, ce n'est plus une aide à l'écriture mais un générateur de contenu. */
const MAX_CALLS_PER_WINDOW = 12;
const RATE_WINDOW_MS = 5 * 60 * 1000;
/** Le co-pilote travaille sur un brouillon, pas sur un roman. */
const MAX_INPUT_CHARS = 1200;

/** userId -> { count, resetAt }. En mémoire : un redémarrage remet à zéro, sans gravité. */
const rateState = new Map();

function checkRate(userId) {
  const now = Date.now();
  const entry = rateState.get(userId);
  if (!entry || now > entry.resetAt) {
    rateState.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, remaining: MAX_CALLS_PER_WINDOW - 1 };
  }
  if (entry.count >= MAX_CALLS_PER_WINDOW) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
    };
  }
  entry.count += 1;
  return { allowed: true, remaining: MAX_CALLS_PER_WINDOW - entry.count };
}

const { generateText, parseJsonLoose } = codex;

/** Message utilisateur correspondant à un échec du moteur, sans jargon technique. */
function failureMessage(error) {
  switch (error) {
    case 'codex_unavailable':
      return 'Le co-pilote n\'est pas disponible sur ce serveur.';
    case 'codex_busy':
      return 'Le co-pilote est très sollicité. Réessaie dans quelques secondes.';
    case 'generation_failed':
    case 'empty_response':
    default:
      return 'Le co-pilote n\'a rien pu proposer cette fois.';
  }
}

/**
 * Contexte commun à tous les prompts : sans ça, le modèle « corrige » le
 * vocabulaire de la plateforme et l'argot des utilisateurs, et rend des
 * suggestions qui ne ressemblent plus du tout à l'auteur.
 */
const PLATFORM_CONTEXT = `CONTEXTE DE LA PLATEFORME :
TwitNinf est un réseau social francophone. Son vocabulaire propre ("ninf",
"NF", "TWC", "wallet", "mining") et l'argot, le verlan, les abréviations et le
mélange français / lingala / anglais de ses utilisateurs sont NORMAUX. Ne les
corrige pas, ne les "traduis" pas en français soutenu : garder la voix de
l'auteur compte plus que la correction académique.`;

const MODES = {
  rewrite: {
    label: 'Reformuler',
    instruction: 'Réécris ce tweet de trois façons différentes, en gardant exactement le même sens et la même intention.',
  },
  punchy: {
    label: 'Plus percutant',
    instruction: 'Réécris ce tweet pour qu\'il accroche davantage : plus direct, plus rythmé. Sans exagérer ni inventer de fait.',
  },
  shorten: {
    label: 'Raccourcir',
    instruction: 'Condense ce tweet en gardant l\'essentiel. Chaque version doit être nettement plus courte que l\'originale.',
  },
  professional: {
    label: 'Ton pro',
    instruction: 'Réécris ce tweet sur un ton posé et professionnel, sans devenir rigide ni corporate.',
  },
  casual: {
    label: 'Ton détendu',
    instruction: 'Réécris ce tweet sur un ton familier et détendu, comme on parle à ses proches.',
  },
  hook: {
    label: 'Accroche',
    instruction: 'Propose trois premières phrases (accroches) qui donneraient envie de lire ce tweet en entier. Rends le tweet complet, accroche incluse.',
  },
  expand: {
    label: 'Développer',
    instruction: 'Développe ce tweet pour qu\'il aille au bout de son idée, sans le gonfler de remplissage. Reste sous 1000 caractères.',
  },
};

/**
 * Suggestions de réécriture.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.content   brouillon en cours
 * @param {string} params.mode      clé de MODES
 * @param {number} [params.maxChars] limite du palier de l'auteur
 */
async function suggest({ userId, content, mode = 'rewrite', maxChars = 1000 }) {
  const text = String(content || '').trim();
  if (!text) {
    return { success: false, error: 'empty_content', message: 'Écris quelque chose d\'abord.' };
  }
  if (text.length > MAX_INPUT_CHARS) {
    return { success: false, error: 'content_too_long', message: 'Brouillon trop long pour le co-pilote.' };
  }

  const modeSpec = MODES[mode];
  if (!modeSpec) {
    return { success: false, error: 'unknown_mode', message: 'Mode de suggestion inconnu.' };
  }

  const rate = checkRate(userId);
  if (!rate.allowed) {
    return {
      success: false,
      error: 'rate_limited',
      message: 'Le co-pilote a besoin de souffler. Réessaie dans un instant.',
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }

  const prompt = `Tu es un assistant de rédaction pour un réseau social francophone.

${PLATFORM_CONTEXT}

TÂCHE : ${modeSpec.instruction}

RÈGLES ABSOLUES :
- Chaque proposition doit tenir en ${maxChars} caractères maximum.
- N'invente aucun fait, aucun chiffre, aucune citation absents du texte d'origine.
- Garde la langue du texte d'origine.
- Pas de hashtags ajoutés d'office, sauf s'il y en avait déjà.
- Ne mets pas de guillemets autour des propositions.
- Trois propositions, réellement différentes les unes des autres.

Tweet d'origine : ${JSON.stringify(text)}

Réponds UNIQUEMENT avec ce JSON brut, sans backticks ni markdown :
{"suggestions":[{"text":"...","why":"raison courte en français"},{"text":"...","why":"..."},{"text":"...","why":"..."}]}`;

  const result = await generateText(prompt);
  if (!result.success) {
    return { success: false, error: result.error, message: failureMessage(result.error) };
  }

  const parsed = parseJsonLoose(result.text);
  const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const clean = suggestions
    .map((s) => ({
      text: String(s?.text || '').trim(),
      why: String(s?.why || '').trim(),
    }))
    // Une proposition qui dépasse la limite du palier serait refusée à la
    // publication : la filtrer ici évite de la proposer pour rien.
    .filter((s) => s.text && s.text.length <= maxChars)
    .slice(0, 3);

  if (clean.length === 0) {
    return { success: false, error: 'no_usable_suggestion', message: 'Le co-pilote n\'a rien pu proposer cette fois.' };
  }

  return {
    success: true,
    mode,
    modeLabel: modeSpec.label,
    suggestions: clean,
    remainingCalls: rate.remaining,
  };
}

/**
 * Relecture : ce qui accroche, ce qui coince, et des hashtags pertinents.
 * Complémentaire des analytics prédictifs — ceux-ci mesurent la FORME sur
 * l'historique, celui-ci lit le FOND.
 */
async function review({ userId, content }) {
  const text = String(content || '').trim();
  if (!text) {
    return { success: false, error: 'empty_content', message: 'Écris quelque chose d\'abord.' };
  }
  if (text.length > MAX_INPUT_CHARS) {
    return { success: false, error: 'content_too_long', message: 'Brouillon trop long pour le co-pilote.' };
  }

  const rate = checkRate(userId);
  if (!rate.allowed) {
    return {
      success: false,
      error: 'rate_limited',
      message: 'Le co-pilote a besoin de souffler. Réessaie dans un instant.',
      retryAfterSeconds: rate.retryAfterSeconds,
    };
  }

  const prompt = `Tu es un relecteur bienveillant pour un réseau social francophone.

${PLATFORM_CONTEXT}

TÂCHE : relis ce tweet et rends un avis court et utile.

RÈGLES :
- Sois concret, jamais moralisateur.
- Un vocabulaire que tu ne connais pas n'est PAS un défaut : ne le signale pas.
- Les hashtags proposés doivent être en rapport direct avec le contenu, 3 maximum.
- "clarity", "hook" et "tone" sont des notes sur 100.

Tweet : ${JSON.stringify(text)}

Réponds UNIQUEMENT avec ce JSON brut, sans backticks ni markdown :
{"tone":"un mot en français","clarity":75,"hook":60,"strengths":["..."],"improvements":["..."],"hashtags":["#..."]}`;

  // La relecture demande un peu plus de réflexion que la reformulation : c'est
  // un jugement, pas une variation de surface.
  const result = await generateText(prompt, { reasoningEffort: 'medium' });
  if (!result.success) {
    return { success: false, error: result.error, message: failureMessage(result.error) };
  }

  const parsed = parseJsonLoose(result.text);
  if (!parsed) {
    return { success: false, error: 'unparsable_response', message: 'Le co-pilote n\'a pas pu relire ce brouillon.' };
  }

  const clampScore = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  };
  const stringList = (v, max) => (Array.isArray(v) ? v : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, max);

  return {
    success: true,
    review: {
      tone: String(parsed.tone || '').trim() || null,
      clarity: clampScore(parsed.clarity),
      hook: clampScore(parsed.hook),
      strengths: stringList(parsed.strengths, 3),
      improvements: stringList(parsed.improvements, 3),
      hashtags: stringList(parsed.hashtags, 3).map((h) => (h.startsWith('#') ? h : `#${h}`)),
    },
    remainingCalls: rate.remaining,
  };
}

/** Modes proposables à l'app — évite de coder la liste en dur côté client. */
function availableModes() {
  return Object.entries(MODES).map(([key, spec]) => ({ key, label: spec.label }));
}

module.exports = {
  suggest,
  review,
  availableModes,
  // Partagé avec le radar de tendances.
  generateText,
  parseJsonLoose,
  PLATFORM_CONTEXT,
};
