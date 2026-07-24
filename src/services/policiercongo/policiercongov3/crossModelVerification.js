'use strict';

/**
 * Second avis obligatoire avant toute action TOOL_RISK.DESTRUCTIVE.
 *
 * Principe : le modèle qui a pris la décision n'est jamais celui qui la
 * valide. Si l'agent tourne sur Codex, l'avis est demandé à Claude, et
 * inversement — jamais au même modèle que celui qui a produit l'appel.
 *
 * Exception : Codex n'a plus de crédits disponibles (juillet 2026). Tant que
 * seul Claude est opérationnel, on ne peut pas obtenir un second modèle
 * réellement distinct — demander l'avis à Codex échouerait systématiquement
 * et bloquerait toute action destructrice (fail-closed = plus rien ne passe
 * jamais). On dégrade donc vers Claude pour les deux rôles, mais chaque appel
 * `generateWith` reste un tour isolé et sans contexte partagé avec la
 * décision primaire (ClaudeProvider ne garde aucune session) : c'est une
 * nouvelle requête neutre, pas une relecture par le même fil de raisonnement.
 *
 * Fail-closed par construction : toute impossibilité d'obtenir un verdict
 * clair (provider indisponible, timeout, réponse illisible) refuse l'action.
 * Une destruction non vérifiable ne doit jamais s'exécuter par défaut.
 */

const { extractJson } = require('./protocol');
const { redact, clip, safeJson } = require('./utils');

function otherProviderName(primaryName) {
  if (primaryName === 'codex') return 'claude';
  if (primaryName === 'claude') return 'claude';
  return null;
}

function buildVerificationPrompt({ tool, call, event, decisionSummary }) {
  const moneyGuidance = tool.name === 'send_money' ? [
    '',
    "GUIDE SPÉCIFIQUE À send_money: un contrat n'a pas besoin d'être un document formel. Un tweet public officiel ou un message annonçant un accord/partenariat (ex: entrée dans une agence affiliée à TwitNinf comme la G Corp, cf. get_platform_rules scope=partners et get_agency_affiliation) constitue une preuve suffisante de l'engagement s'il énonce clairement qui paie, combien, et à quel moment (ex: à la signature/l'entrée, pas après un résultat futur).",
    "N'exige pas de preuve que la contrepartie a déjà livré un résultat si les termes cités montrent que le paiement est dû dès l'accord (ex: frais d'entrée, versement initial). Refuse seulement si les termes réels de l'accord sont absents, contradictoires, ou si le montant/destinataire ne correspond pas à ce que l'accord cité décrit.",
    "Le montant ou le calendrier exact (ex: paiement en plusieurs fois) peut avoir été précisé en message privé avec la même contrepartie plutôt que republié publiquement — c'est normal en négociation, pas une raison de refuser en soi. Accepte un échelonnement (ex: 25 NF/mois payés en 4 fois de 6,25 NF) si la justification l'explique clairement et que le total reste cohérent avec l'accord public de référence. Refuse seulement si l'échelonnement invoqué contredit l'accord public (montant total différent, autre destinataire) ou si aucun détail concret n'est donné sur qui a proposé ce découpage."
  ] : [];
  return [
    'Tu es un vérificateur indépendant et neutre pour une plateforme sociale (TwitNinf).',
    "Un autre modèle IA (l'agent \"PolicierCongo\") s'apprête à exécuter une action à fort impact et difficilement réversible. Ta seule tâche est de juger si la justification fournie est cohérente, proportionnée et suffisamment étayée pour exécuter CETTE action précise. Tu n'exécutes rien toi-même.",
    "Tu n'as pas accès à l'historique complet de la conversation ni aux preuves déjà observées par l'autre modèle. Si l'information donnée ici ne suffit pas à juger sereinement, réponds par la négative par prudence plutôt que d'approuver sur la foi d'une affirmation non vérifiable.",
    "Une justification vague, générique, ou qui ne cite aucun fait concret (contenu observé, règle enfreinte, historique) doit être refusée.",
    ...moneyGuidance,
    '',
    `ACTION PROPOSÉE: ${tool.name}`,
    `DESCRIPTION: ${tool.description || '(aucune)'}`,
    `NIVEAU DE RISQUE: ${tool.risk}`,
    `ARGUMENTS: ${safeJson(redact(call.args || {}), 3000)}`,
    `JUSTIFICATION DONNÉE PAR L'AGENT (call.purpose): ${clip(call.purpose || '(aucune)', 1500)}`,
    `RÉSUMÉ DE DÉCISION DU TOUR: ${clip(decisionSummary || '(aucun)', 1500)}`,
    `CONTEXTE DE L'ÉVÉNEMENT: trigger=${event.trigger}, déclenché par ${event.username || event.userId || '(système/autonome)'}`,
    '',
    'Réponds UNIQUEMENT avec ce JSON strict, sans aucun texte autour:',
    '{"approved": true ou false, "reasoning": "une ou deux phrases expliquant précisément pourquoi"}'
  ].join('\n');
}

function parseVerdict(text) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Réponse de vérification illisible');
  if (typeof parsed.approved !== 'boolean') throw new Error('Champ "approved" manquant ou invalide');
  return {
    approved: parsed.approved,
    reasoning: typeof parsed.reasoning === 'string' ? clip(parsed.reasoning.trim(), 1000) : ''
  };
}

/**
 * @returns {Promise<{approved:boolean, reasoning:string, verifier:string|null}>}
 * Ne lève jamais : toute erreur se traduit par approved=false.
 */
async function verifyDestructiveAction({ providerRouter, primaryProvider, tool, call, event, decisionSummary, signal }, config) {
  const verifierName = otherProviderName(primaryProvider);
  if (!verifierName) {
    return { approved: false, reasoning: `Provider principal "${primaryProvider || 'inconnu'}" non reconnu : impossible de désigner un second avis distinct.`, verifier: null };
  }

  const prompt = buildVerificationPrompt({ tool, call, event, decisionSummary });
  try {
    const timeoutMs = config.crossVerificationTimeoutMs || config.modelTimeoutMs;
    const result = await Promise.race([
      providerRouter.generateWith(verifierName, prompt, { signal }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout vérification croisée après ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
    const verdict = parseVerdict(result.text);
    return { ...verdict, verifier: verifierName };
  } catch (error) {
    return {
      approved: false,
      reasoning: `Vérification croisée indisponible (${verifierName}): ${error.message}`,
      verifier: verifierName
    };
  }
}

/**
 * Second avis en direct pour une demande de vérification que PolicierCongo
 * soumet pour SON PROPRE compte (badge vérifié). Même contrat fail-closed que
 * verifyDestructiveAction, mais jugé par l'autre modèle comme n'importe quel
 * autre compte — pas de complaisance parce que le demandeur est l'IA de la
 * plateforme elle-même.
 */
function buildSelfVerificationPrompt({ botProfile, formData }) {
  return [
    'Tu es un vérificateur indépendant et neutre pour une plateforme sociale (TwitNinf).',
    "Le compte automatisé \"PolicierCongo\" (agent de modération IA de la plateforme) demande le badge vérifié pour SON PROPRE compte. Juge cette demande exactement comme celle de n'importe quel autre compte, sans complaisance liée au fait qu'il s'agit de l'IA de la plateforme elle-même — et sans excès de sévérité pour la même raison.",
    "Un badge vérifié suppose normalement une identité confirmée et notable. Une justification vague, générique ou invérifiable (« je fais du bon travail », « je suis utile ») doit être refusée. Une justification concrète et cohérente avec le rôle réellement documenté du compte peut être acceptée.",
    '',
    `COMPTE: @${botProfile?.username || '(inconnu)'} (id ${botProfile?.id || '(inconnu)'})`,
    `BIO ACTUELLE: ${botProfile?.bio || '(vide)'}`,
    `TYPE DE DEMANDE: ${formData?.request_type || 'organization'}`,
    `JUSTIFICATION FOURNIE: ${clip(formData?.reason || '(aucune)', 2000)}`,
    `PREUVES / ÉLÉMENTS CITÉS: ${safeJson(formData?.evidence || [], 2000)}`,
    '',
    'Réponds UNIQUEMENT avec ce JSON strict, sans aucun texte autour:',
    '{"approved": true ou false, "reasoning": "une ou deux phrases expliquant précisément pourquoi"}'
  ].join('\n');
}

/**
 * @returns {Promise<{approved:boolean, reasoning:string, verifier:string|null}>}
 * Ne lève jamais : toute erreur se traduit par approved=false (fail-closed).
 */
async function reviewSelfVerificationRequest({ providerRouter, primaryProvider, botProfile, formData, signal }, config) {
  const verifierName = otherProviderName(primaryProvider);
  if (!verifierName) {
    return { approved: false, reasoning: `Provider principal "${primaryProvider || 'inconnu'}" non reconnu : impossible de désigner un vérificateur distinct.`, verifier: null };
  }

  const prompt = buildSelfVerificationPrompt({ botProfile, formData });
  try {
    const timeoutMs = config.crossVerificationTimeoutMs || config.modelTimeoutMs;
    const result = await Promise.race([
      providerRouter.generateWith(verifierName, prompt, { signal }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout vérification après ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
    const verdict = parseVerdict(result.text);
    return { ...verdict, verifier: verifierName };
  } catch (error) {
    return {
      approved: false,
      reasoning: `Vérification indisponible (${verifierName}): ${error.message}`,
      verifier: verifierName
    };
  }
}

module.exports = {
  verifyDestructiveAction, otherProviderName, buildVerificationPrompt, parseVerdict,
  reviewSelfVerificationRequest, buildSelfVerificationPrompt
};
