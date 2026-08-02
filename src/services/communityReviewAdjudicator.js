'use strict';

/**
 * Arbitre de SANCTION de la revue communautaire.
 *
 * La communauté décide seule si le contenu respecte les règles. Quand son
 * verdict est « non conforme », ce module ne rejuge jamais le fond : il dose
 * uniquement la conséquence. Le minimum possible est donc la suppression du
 * tweet ; le modèle peut ensuite choisir une suspension d'une durée exacte ou
 * un bannissement définitif.
 *
 * La réponse du modèle n'est jamais appliquée directement. Sa structure, le
 * type de sanction, la durée et le motif sont validés avant exécution.
 */

const { REPORT_CATEGORIES, CATEGORY_KEYS } = require('../config/reportCategories');
const {
  SANCTION_KEYS,
  MIN_TEMPORARY_BAN_DAYS,
  MAX_TEMPORARY_BAN_DAYS,
  normalizeSanctionDecision,
} = require('../config/reviewSanctions');
const { generateWithCodex } = require('./policiercongo/codexClient');
const logger = require('../utils/logger');

const PRIMARY_MODEL = process.env.COMMUNITY_REVIEW_CODEX_MODEL || 'gpt-5.4-mini';
const FALLBACK_MODEL = process.env.COMMUNITY_REVIEW_CODEX_FALLBACK_MODEL || 'gpt-5.4';
const REASONING_EFFORT = process.env.COMMUNITY_REVIEW_CODEX_EFFORT || 'low';

/** Si tous les appels échouent, le verdict du jury reste appliqué sans punir le compte. */
const FALLBACK_DECISION = Object.freeze({
  sanction: 'delete',
  duration_days: null,
});

const MOTIF_LIST = CATEGORY_KEYS
  .filter((key) => REPORT_CATEGORIES[key].targets.includes('tweet'))
  .map((key) => `- ${key} : ${REPORT_CATEGORIES[key].label} — ${REPORT_CATEGORIES[key].description}`)
  .join('\n');

const PROMPT = `Tu es l'instance de SANCTION d'un réseau social francophone.

Un jury de 3 utilisateurs a déjà rendu son verdict final : le message est NON
CONFORME aux règles. Tu n'as pas le droit de rejuger ce verdict, de l'annuler,
ni de laisser le message en ligne. Ta seule tâche est de choisir la sanction
proportionnée.

Le message est ANONYMISÉ : [PERSONNE], [COMPTE], [LIEU], [CONTACT] et
[INFO PERSO] remplacent ce qui permettait d'identifier quelqu'un. Ces marqueurs
ne sont pas le fait de l'auteur ; juge uniquement ce qui est dit.

MOTIFS possibles :
${MOTIF_LIST}

SANCTIONS possibles :
- delete : suppression du message seulement ;
- suspend : suppression du message + suspension temporaire du compte. Choisis
  une durée PRÉCISE en jours entiers, de ${MIN_TEMPORARY_BAN_DAYS} à
  ${MAX_TEMPORARY_BAN_DAYS} ;
- ban_definitif : suppression du message + bannissement sans date de fin.

RÈGLES FERMES :
- Le minimum absolu est "delete". "none", "warning" ou laisser le message en
  ligne sont interdits, car cela contredirait le verdict final du jury.
- Un motif "child_safety" entraîne toujours "ban_definitif".
- Un motif "self_harm" ne suspend jamais la personne : choisis "delete". Le
  contenu dangereux est retiré sans punir une personne en détresse.
- Pour une insulte isolée, de la vulgarité, du spam léger ou du mauvais goût,
  choisis généralement "delete".
- Réserve une suspension temporaire au ciblage d'une personne, au harcèlement,
  à la haine, aux menaces ou aux violations sérieuses. Dose précisément sa
  durée selon la gravité.
- Réserve "ban_definitif" aux menaces crédibles extrêmes, au contenu impliquant
  un mineur, au terrorisme manifeste ou au contenu gravement illégal.
- En cas d'ambiguïté sur la gravité, choisis "delete" : le doute réduit la peine
  du compte, mais ne renverse jamais le verdict du jury.

N'utilise aucun outil, ne lis aucun fichier et ne cherche rien.

Réponds UNIQUEMENT en JSON brut, sans backticks ni markdown :
{"sanction":"delete|suspend|ban_definitif","duration_days":<entier ou null>,"motif":"<clé de motif>","raison":"<une phrase de 20 mots maximum>"}

Pour "suspend", duration_days est obligatoire. Pour "delete" et
"ban_definitif", duration_days doit être null.
`;

function parseDecision(raw) {
  const text = String(raw || '').replace(/```json|```/g, '').trim();
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Les garde-fous s'appliquent après lecture du motif, y compris si le modèle a
 * proposé une sanction trop faible ou trop forte.
 */
function applyHardRules(decision, motif) {
  if (motif === 'child_safety') {
    return normalizeSanctionDecision({ sanction: 'ban_definitif', duration_days: null });
  }
  if (motif === 'self_harm') {
    return normalizeSanctionDecision({ sanction: 'delete', duration_days: null });
  }
  return normalizeSanctionDecision(decision);
}

function fallbackResult(reason) {
  return {
    ...FALLBACK_DECISION,
    motif: null,
    raison: reason,
    model: null,
    fallback: true,
  };
}

/**
 * Dose la sanction d'un contenu déjà jugé non conforme par la communauté.
 *
 * @returns {Promise<{
 *   sanction: 'delete'|'suspend'|'ban_definitif',
 *   duration_days: number|null,
 *   motif: string|null,
 *   raison: string,
 *   model: string|null,
 *   fallback: boolean
 * }>}
 */
async function adjudicate({ content, hadMedia = false }) {
  const text = String(content || '').trim();
  if (!text) return fallbackResult('Texte indisponible');

  const prompt = `${PROMPT}${
    hadMedia
      ? '\nLe message portait aussi des médias non affichés. Ne les imagine pas et ne les utilise pas pour aggraver la peine.\n'
      : ''
  }
Message à sanctionner :
${JSON.stringify(text)}
`;

  for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
    const raw = await generateWithCodex(prompt, model, REASONING_EFFORT);
    if (!raw) {
      logger.warn(`[reviewAdjudicator] aucune réponse de ${model}`);
      continue;
    }

    const parsed = parseDecision(raw);
    if (!parsed) {
      logger.warn(`[reviewAdjudicator] réponse illisible de ${model}`);
      continue;
    }

    const motif = CATEGORY_KEYS.includes(parsed.motif) ? parsed.motif : null;
    if (!motif) {
      logger.warn(`[reviewAdjudicator] motif inconnu « ${parsed.motif} » de ${model}`);
      continue;
    }

    const normalized = applyHardRules(parsed, motif);
    if (!normalized) {
      logger.warn(
        `[reviewAdjudicator] sanction ou durée invalide de ${model}: `
        + `${parsed.sanction}/${parsed.duration_days}`,
      );
      continue;
    }

    return {
      sanction: normalized.sanction,
      duration_days: normalized.duration_days,
      motif,
      raison: String(parsed.raison || '').trim().slice(0, 200) || 'Sans justification',
      model,
      fallback: false,
    };
  }

  return fallbackResult('Arbitrage indisponible');
}

module.exports = {
  adjudicate,
  parseDecision,
  applyHardRules,
  PROMPT,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  SANCTION_KEYS,
};
