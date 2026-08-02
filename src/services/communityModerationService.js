/**
 * Modération communautaire — BÊTA.
 *
 * Chaîne complète : un tweet signalé (ou déjà écarté par la modération
 * automatique) → anonymisé par un LLM → confié à un JURY de `PANEL_SIZE`
 * personnes désignées → dès que `MAJORITY` d'entre elles tranchent du même
 * côté, l'item se ferme.
 *
 * Trois choses ont changé par rapport à la version précédente, dans le même
 * sens : rendre le geste rapide et le jugement non influencé.
 *
 * 1. JURY DÉSIGNÉ plutôt que file ouverte. Avant, tout le monde recevait le
 *    même item dans le même ordre : les trois personnes les plus rapides
 *    tranchaient l'essentiel de la file, et les votes suivants se prenaient un
 *    « revue déjà close ». Chaque item réserve maintenant `PANEL_SIZE` places
 *    (voir `CommunityReviewAssignment`), et l'unicité `(item, relecteur)`
 *    garantit qu'un contenu n'est JAMAIS proposé deux fois à la même personne.
 *
 * 2. PLUS DE QUESTIONNAIRE. Le votant tranche conforme / non conforme, point.
 *    Ce verdict est définitif. En cas de violation, le modèle arbitre ne peut
 *    pas la rejuger : il choisit seulement entre suppression, suspension d'une
 *    durée exacte, ou bannissement définitif.
 *
 * 3. RIEN NE REMONTE AU VOTANT. Ni le nombre de voix déjà tombées, ni les
 *    motifs de signalement, ni la sanction qui a suivi. Savoir que deux
 *    personnes ont déjà dit « non conforme », ou qu'un compte risque le
 *    bannissement, déplace un vote — c'est exactement ce qu'on cherche à
 *    éviter. La seule information affichée est le texte lui-même.
 *
 * Le risque assumé — un jury qui se trompe sur un texte hors contexte — est
 * atténué par : le texte reste ANONYMISÉ (aucun biais d'identité) et le jury est
 * tiré au sort parmi des comptes éligibles (pas d'auto-sélection des plus
 * zélés).
 */

const { Op, QueryTypes } = require('sequelize');
const {
  sequelize,
  Tweet,
  User,
  Report,
  Notification,
  CommunityReviewItem,
  CommunityReviewVote,
  CommunityReviewAssignment,
} = require('../models');
const {
  normalizeSanctionDecision,
  resolutionActionFor,
} = require('../config/reviewSanctions');
const { generateWithCodex } = require('./policiercongo/codexClient');
const { adjudicate } = require('./communityReviewAdjudicator');
const logger = require('../utils/logger');

/* ══════════════════════════════════════════════════════════════════════════
   LE JURY
   ══════════════════════════════════════════════════════════════════════════ */

/** Nombre de places réservées par item — la taille du jury. */
const PANEL_SIZE = 3;

/**
 * Voix du même côté qui closent l'item. 2 sur 3 : dès que la majorité est
 * atteinte, la troisième voix ne peut plus rien changer, l'attendre ne ferait
 * que retarder la décision et immobiliser une place.
 */
const MAJORITY = 2;

/**
 * Au-delà, la place réservée est rendue aux autres. 45 minutes : assez pour
 * réfléchir, aller boire un café et revenir ; trop court pour qu'une app
 * laissée ouverte bloque un item une journée entière.
 */
const ASSIGNMENT_TTL_MS = 45 * 60 * 1000;

/**
 * Ancienneté minimale du compte, en jours. **À 0 : personne n'est écarté.**
 *
 * Ça a valu 3 jours pendant un temps, pour écarter le jetable ouvert dans le
 * seul but de peser sur un vote. À l'échelle réelle de la plateforme — une
 * dizaine d'utilisateurs actifs — cette barrière n'écartait aucun attaquant et
 * retirait des jurés dont on a besoin. Le levier reste là pour le jour où le
 * vivier sera assez grand pour se le permettre ; le remonter doit être une
 * décision, pas un défaut hérité.
 */
const MIN_ACCOUNT_AGE_DAYS = 0;

/**
 * Nombre de votes tombés du côté du verdict final à partir duquel on considère
 * que quelqu'un a fait ses preuves. Sert UNIQUEMENT à l'ordre de proposition
 * (voir `findCandidates`) : personne n'est privé de la revue faute d'y arriver.
 *
 * Trois, parce qu'un accord isolé peut être de la chance — trois de suite avec
 * des jurys différents, beaucoup moins.
 */
const TRUSTED_AGREEMENTS = 3;

/**
 * Nombre de candidats parmi lesquels tirer au sort. Prendre systématiquement le
 * meilleur candidat ferait converger tout le monde vers le même item, et les
 * mêmes trios se reformeraient item après item — un noyau de votants finirait
 * par décider seul de la modération. Tirer dans un vivier casse ces trios sans
 * perdre l'ordre de priorité (le tirage reste biaisé vers la tête).
 */
const CANDIDATE_POOL = 12;

/** Tentatives d'attribution avant d'abandonner : un candidat peut se remplir entre la lecture et l'écriture. */
const ASSIGN_ATTEMPTS = 3;

/** Au-delà, on arrête d'alimenter la file : inutile d'anonymiser d'avance. */
const MAX_OPEN_ITEMS = 200;

/**
 * Sous ce seuil, la qualité estimée par l'annotateur (0..1) suffit à faire
 * entrer un tweet en revue — même sans signalement humain.
 *
 * Le score vient de `tweet_llm_labels.quality_score`, écrit par
 * `annotator-worker.js` (process pm2 `twitninf-annotator`) : un worker HORS du
 * chemin de publication qui note chaque tweet via codex, en tâche de fond, sur
 * un sondage de 20s. Un tweet tout juste publié peut donc mettre quelques
 * secondes à obtenir son label — c'est voulu (voir le commentaire du worker) —
 * et rester invisible de la revue jusque-là.
 */
const LOW_QUALITY_THRESHOLD = 0.10;

/** Nombre de candidats "auto-détectés" examinés par passage : borne le coût
    de la requête, pas la taille de la file elle-même (voir MAX_OPEN_ITEMS). */
const AUTO_FLAG_SCAN_LIMIT = 100;

/* ══════════════════════════════════════════════════════════════════════════
   ANONYMISATION
   ══════════════════════════════════════════════════════════════════════════
   Passe par `codex exec` (même chemin que l'arbitre et que PolicierCongo), et
   plus par l'API Gemini.

   Gemini était appelé UNE FOIS PAR TWEET, sur une clé du palier gratuit limitée
   par minute. Une rafale de signalements — c'est-à-dire le cas normal — saturait
   le quota, chaque 429 marquait l'item `failed`, et comme rien ne réessayait le
   contenu quittait la revue définitivement. En prod le 2026-07-28, les 47 items
   ouverts étaient tous dans cet état : file pleine, page vide.

   Le lot répond aux deux problèmes à la fois : dix tweets à anonymiser coûtent
   UNE requête au lieu de dix, donc dix fois moins d'occasions de se faire jeter,
   et dix fois moins d'attente avant qu'ils soient jugeables. En dessous de deux
   textes il n'y a évidemment rien à grouper — le prompt simple est plus court et
   plus fiable, on le garde pour ce cas. */

const ANONYMIZE_MODEL = process.env.COMMUNITY_ANONYMIZE_CODEX_MODEL || 'gpt-5.4-mini';

/**
 * Effort bas : remplacer des noms par des étiquettes est une réécriture
 * mécanique. Le seul risque est d'en oublier, pas de mal raisonner — et un
 * effort élevé ferait attendre les jurés sans rien y changer.
 */
const ANONYMIZE_EFFORT = process.env.COMMUNITY_ANONYMIZE_CODEX_EFFORT || 'low';

/**
 * Taille maximale d'un lot. Au-delà, deux ennuis se cumulent : la réponse peut
 * dépasser ce que le modèle rend proprement en un bloc, et un lot qui échoue
 * emmène TOUS ses textes avec lui. Dix est le compromis — assez pour amortir
 * l'appel, assez peu pour qu'un raté ne coûte pas la file entière.
 */
const ANONYMIZE_MAX_BATCH = 10;

/** Les consignes, identiques au texte seul et au lot — une seule source. */
const ANONYMIZE_RULES = `Tu prépares des messages pour une revue de modération ANONYME.

Ta seule tâche : réécrire chaque message en supprimant tout ce qui permettrait
d'identifier quelqu'un, SANS rien changer d'autre.

À REMPLACER systématiquement :
- prénoms, noms, surnoms → [PERSONNE], [PERSONNE 2]… (la même personne garde le même numéro)
- pseudos et @mentions → [COMPTE]
- villes, quartiers, pays, établissements, rues → [LIEU]
- numéros de téléphone, e-mails, liens, identifiants → [CONTACT]
- âges précis, dates de naissance, employeurs, écoles → [INFO PERSO]

À NE SURTOUT PAS TOUCHER :
- le ton, les insultes, la vulgarité, les menaces : ils DOIVENT rester intacts,
  c'est exactement ce que la personne qui juge doit pouvoir évaluer
- la langue, l'orthographe, l'argot, les emojis, la ponctuation
- la structure et la longueur des phrases

Tu n'as rien à juger et rien à refuser : tu ne fais que masquer des identités.
N'ajoute aucun commentaire, aucune explication, aucun avertissement.
N'utilise aucun outil, ne lis aucun fichier, ne cherche rien.`;

const singlePrompt = (text) => `${ANONYMIZE_RULES}

Réponds UNIQUEMENT en JSON brut, sans backticks et sans markdown :
{"text":"le message réécrit","redactions":<nombre de passages remplacés>}

Message à traiter :
${JSON.stringify(text)}
`;

const batchPrompt = (texts) => `${ANONYMIZE_RULES}

On te donne ${texts.length} messages numérotés. Traite-les TOUS, indépendamment
les uns des autres : deux messages ne parlent pas forcément des mêmes personnes,
la numérotation de [PERSONNE] repart de 1 à chaque message.

Réponds UNIQUEMENT en JSON brut, sans backticks et sans markdown, avec autant
d'entrées que de messages et le même "id" que celui donné :
{"results":[{"id":1,"text":"le message réécrit","redactions":<nombre>}]}

Messages à traiter :
${texts.map((text, i) => `#${i + 1} ${JSON.stringify(text)}`).join('\n')}
`;

/**
 * Extrait l'objet JSON d'une réponse de modèle, en tolérant les backticks et
 * une phrase d'introduction — un modèle qui écrit « Voici le résultat : » ne
 * doit pas coûter un lot entier.
 */
function parseJsonBlock(raw) {
  const text = String(raw || '').replace(/```json|```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Met en forme une entrée du modèle, ou `null` si elle est inexploitable. */
function shapeResult(entry) {
  const text = String(entry?.text || '').trim();
  if (!text) return null;
  return { text, redactions: Number(entry?.redactions) || 0 };
}

/**
 * Réécrit UN texte. Signature conservée : c'est l'entrée utilisée pour un
 * signalement isolé, où il n'y a rien à grouper.
 *
 * @returns {Promise<{ text: string, redactions: number } | null>} null si le
 *   modèle n'a pas répondu exploitablement — l'appelant NE DOIT PAS retomber
 *   sur le texte d'origine, qui est justement celui qu'on refuse de montrer.
 */
async function anonymizeText(content) {
  const source = String(content || '').trim();
  if (!source) return { text: '', redactions: 0 };

  const raw = await generateWithCodex(singlePrompt(source), ANONYMIZE_MODEL, ANONYMIZE_EFFORT);
  if (!raw) {
    logger.warn('[communityModeration] anonymisation : aucune réponse du modèle');
    return null;
  }

  const result = shapeResult(parseJsonBlock(raw));
  if (!result) logger.warn('[communityModeration] anonymisation : réponse illisible');
  return result;
}

/**
 * Réécrit PLUSIEURS textes en une requête, dans l'ordre reçu.
 *
 * Le résultat est toujours aligné sur l'entrée, `null` compris : l'appelant
 * associe par INDICE, et un décalage silencieux collerait le texte de quelqu'un
 * d'autre sur un item. C'est aussi pourquoi l'`id` renvoyé par le modèle est
 * relu explicitement au lieu de faire confiance à l'ordre de sa liste.
 *
 * @param {string[]} contents
 * @returns {Promise<Array<{ text: string, redactions: number } | null>>}
 */
async function anonymizeMany(contents) {
  const sources = contents.map((c) => String(c || '').trim());
  const out = new Array(sources.length).fill(null);

  // Les textes vides n'ont rien à masquer et ne doivent pas occuper une place
  // dans le lot — ils fausseraient la numérotation pour rien.
  const todo = [];
  sources.forEach((text, index) => {
    if (!text) out[index] = { text: '', redactions: 0 };
    else todo.push({ index, text });
  });

  if (todo.length === 0) return out;

  // Un seul texte : pas de lot. Le prompt simple est plus court, sa réponse
  // plus courte, et il n'y a rien à amortir.
  if (todo.length === 1) {
    out[todo[0].index] = await anonymizeText(todo[0].text);
    return out;
  }

  for (let start = 0; start < todo.length; start += ANONYMIZE_MAX_BATCH) {
    const chunk = todo.slice(start, start + ANONYMIZE_MAX_BATCH);

    // Un reliquat d'un seul texte retombe sur le chemin simple plutôt que de
    // demander une liste d'un élément.
    if (chunk.length === 1) {
      out[chunk[0].index] = await anonymizeText(chunk[0].text);
      continue;
    }

    const raw = await generateWithCodex(
      batchPrompt(chunk.map((c) => c.text)),
      ANONYMIZE_MODEL,
      ANONYMIZE_EFFORT,
    );
    const parsed = raw ? parseJsonBlock(raw) : null;
    const results = Array.isArray(parsed?.results) ? parsed.results : null;

    if (!results) {
      // Tout le lot repart en `failed` et sera repris à l'entretien suivant —
      // jamais avec le texte d'origine, qui est justement celui qu'on cache.
      logger.warn(`[communityModeration] lot d'anonymisation illisible (${chunk.length} textes)`);
      continue;
    }

    const byId = new Map(results.map((entry) => [Number(entry?.id), entry]));
    chunk.forEach((item, position) => {
      out[item.index] = shapeResult(byId.get(position + 1));
    });
  }

  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   EXÉCUTION DE LA SANCTION
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Exécute la sanction dosée par l'arbitre : soft-delete du tweet, et suspension
 * du compte selon la durée exacte choisie. Appelée DANS la transaction qui écrit la
 * décision — une sanction inscrite mais jamais appliquée (crash entre les deux)
 * serait pire qu'une absence de sanction : le verdict existerait sans que rien
 * n'ait suivi, et personne ne le remarquerait.
 */
async function executeSanction(item, decision, tx) {
  const sanction = normalizeSanctionDecision(decision)
    || normalizeSanctionDecision({ sanction: 'delete' });

  const tweet = await Tweet.findByPk(item.tweet_id, {
    transaction: tx,
    lock: tx.LOCK.UPDATE,
    paranoid: false,
  });
  if (tweet) {
    await tweet.update({
      deleted_at: new Date(),
      moderation_status: 'rejected',
      moderation_reason: 'Verdict final de la revue communautaire : non conforme',
      metadata: {
        ...(tweet.metadata || {}),
        community_review: {
          final: true,
          verdict: 'violation',
          item_id: item.id,
          sanction: sanction.sanction,
          duration_days: sanction.duration_days,
          sanction_pending: false,
          at: new Date().toISOString(),
        },
      },
    }, { transaction: tx });
  }

  const { days } = sanction;
  const author = await User.findByPk(item.author_id, {
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!author) return;

  const suspensionMeta = author.suspension_meta || {};
  const autoBanMatchesTweet = (
    suspensionMeta.auto_ban === true
    && String(suspensionMeta.tweet_id || '') === String(item.tweet_id)
  );

  if (days === 0) {
    // Le LLM a choisi la suppression seule : une suspension automatique
    // préalable causée par CE tweet doit disparaître, sinon l'ancienne IA
    // garderait de fait le dernier mot. Toute autre suspension est préservée.
    if (author.is_suspended && autoBanMatchesTweet) {
      await author.update({
        is_suspended: false,
        suspended_at: null,
        suspended_until: null,
        suspension_reason: null,
        suspension_meta: {
          ...suspensionMeta,
          auto_ban: false,
          replaced_by_community_sanction: 'delete',
          community_review_item_id: item.id,
          replaced_at: new Date().toISOString(),
        },
      }, { transaction: tx });
    }
    return;
  }

  await author.update({
    is_suspended: true,
    suspended_at: new Date(),
    // null = sans terme, même convention que ban_user (adminModerationTools).
    // Une date passée est relevée automatiquement au premier appel suivant
    // (voir checkUserBan, banMiddleware) — pas de tâche de fond à prévoir.
    suspended_until: days === null ? null : new Date(Date.now() + days * 86400000),
    suspension_reason: days === null
      ? 'Bannissement décidé par la revue communautaire'
      : `Suspension de ${days} jours décidée par la revue communautaire`,
    suspension_meta: {
      ...suspensionMeta,
      auto_ban: false,
      community_review: true,
      community_review_item_id: item.id,
      community_review_tweet_id: item.tweet_id,
      duration_days: sanction.duration_days,
      permanent: days === null,
      sanctioned_at: new Date().toISOString(),
    },
  }, { transaction: tx });
}

/**
 * Classe les signalements humains qui visaient ce tweet, avec l'issue réelle
 * de la revue. Sans ça, le tableau de bord modérateur (`/api/moderation/reports`)
 * continuerait d'afficher ces signalements comme "en attente" indéfiniment,
 * sans jamais savoir qu'un verdict communautaire est tombé.
 */
async function resolveLinkedReports(tweetId, { status, resolutionAction, note }, tx) {
  await Report.update(
    {
      status,
      resolution_action: resolutionAction,
      resolved_at: new Date(),
      moderator_notes: note,
    },
    {
      where: {
        target_type: 'tweet',
        target_id: tweetId,
        status: { [Op.in]: ['pending', 'investigating'] },
      },
      transaction: tx,
    },
  );
}

/**
 * Dès que la majorité vote « non conforme », le minimum non négociable est
 * appliqué dans la transaction du vote : le tweet disparaît immédiatement.
 * Le LLM ne fait ensuite que décider si le compte est aussi sanctionné.
 */
async function applyViolationMinimum(item, tx) {
  const tweet = await Tweet.findByPk(item.tweet_id, {
    transaction: tx,
    lock: tx.LOCK.UPDATE,
    paranoid: false,
  });
  if (!tweet) return;

  await tweet.update({
    deleted_at: new Date(),
    moderation_status: 'rejected',
    moderation_reason: 'Verdict final de la revue communautaire : non conforme',
    metadata: {
      ...(tweet.metadata || {}),
      community_review: {
        final: true,
        verdict: 'violation',
        item_id: item.id,
        sanction_pending: true,
        at: new Date().toISOString(),
      },
    },
  }, { transaction: tx });
}

/**
 * Applique le verdict communautaire « conforme » au contenu lui-même.
 *
 * Un tweet peut être arrivé en revue parce qu'une IA l'avait marqué `rejected`
 * ou `not_eligible`. Le classer seulement dans la table de revue laisserait
 * alors cette ancienne décision active, ce qui donnerait en pratique le dernier
 * mot à l'IA. On rétablit donc explicitement le tweet.
 *
 * Une suspension automatique est levée uniquement si sa trace désigne
 * précisément ce tweet. Une autre sanction du compte n'est jamais effacée par
 * accident.
 */
async function applyCompliantVerdict(item, tx) {
  const tweet = await Tweet.findByPk(item.tweet_id, {
    transaction: tx,
    lock: tx.LOCK.UPDATE,
    paranoid: false,
  });

  if (tweet && !tweet.deleted_at) {
    await tweet.update({
      moderation_status: 'approved',
      moderation_reason: null,
      recommendation_group: 'initial',
      metadata: {
        ...(tweet.metadata || {}),
        community_review: {
          final: true,
          verdict: 'compliant',
          item_id: item.id,
          at: new Date().toISOString(),
        },
      },
    }, { transaction: tx });
  }

  const author = await User.findByPk(item.author_id, {
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  const suspensionMeta = author?.suspension_meta || {};
  const autoBanMatchesTweet = (
    suspensionMeta.auto_ban === true
    && String(suspensionMeta.tweet_id || '') === String(item.tweet_id)
  );

  if (!author || !author.is_suspended || !autoBanMatchesTweet) {
    return { tweetId: tweet ? String(tweet.id) : null, unsuspendedAuthorId: null };
  }

  await author.update({
    is_suspended: false,
    suspended_at: null,
    suspended_until: null,
    suspension_reason: null,
    suspension_meta: {
      ...suspensionMeta,
      auto_ban: false,
      overturned_by_community_review: true,
      community_review_item_id: item.id,
      overturned_at: new Date().toISOString(),
    },
  }, { transaction: tx });

  return {
    tweetId: tweet ? String(tweet.id) : null,
    unsuspendedAuthorId: String(author.id),
  };
}

function invalidateBanCache(userId) {
  if (!userId) return;
  try {
    require('../middleware/globalBanMiddleware').invalidateUser(String(userId));
  } catch (error) {
    logger.debug('[communityModeration] cache de ban non invalidé:', error.message);
  }
}

async function restoreRecommendationEligibility(tweetId) {
  if (!tweetId) return;
  try {
    const ProgressiveRecommendationEngine = require('./progressiveRecommendationEngine');
    await new ProgressiveRecommendationEngine().addNewTweet(tweetId);
  } catch (error) {
    logger.error(
      `[communityModeration] réintégration du tweet ${tweetId} aux recommandations:`,
      error.message,
    );
  }
}

/** Notifie l'auteur de la sanction — après coup, hors transaction : un échec d'envoi ne doit pas annuler la sanction déjà actée. */
async function notifySanction(item, sanction) {
  try {
    const normalized = normalizeSanctionDecision(sanction)
      || normalizeSanctionDecision({ sanction: 'delete' });

    const { days } = normalized;
    const touchesAccount = days !== 0;

    let title;
    let message;
    if (days === null) {
      title = 'Compte suspendu définitivement';
      message = 'Votre compte a été suspendu définitivement après examen par la revue communautaire.';
    } else if (days > 0) {
      title = `Compte suspendu ${days} jours`;
      message = `Votre tweet a été jugé non conforme par la revue communautaire et supprimé. `
        + `Votre compte est suspendu ${days} jours.`;
    } else {
      title = 'Tweet supprimé par la revue communautaire';
      message = 'Votre tweet a été jugé non conforme aux règles par la revue communautaire et a été supprimé.';
    }

    await Notification.createNotification({
      recipient_id: item.author_id,
      sender_id: item.author_id,
      // Renvoyer vers un tweet supprimé n'a de sens que si le compte reste
      // utilisable pour aller le consulter.
      tweet_id: touchesAccount ? null : item.tweet_id,
      type: 'system',
      title,
      message,
      content: {
        source: 'community_review',
        item_id: item.id,
        sanction: normalized.sanction,
        duration_days: normalized.duration_days,
      },
      priority: touchesAccount ? 'urgent' : 'high',
    });
  } catch (error) {
    logger.error('[communityModeration] notification de sanction impossible:', error.message);
  }
}

/**
 * Fait trancher le palier par l'arbitre, puis l'applique.
 *
 * Appelée APRÈS le commit du vote qui a fermé l'item, jamais pendant : l'appel
 * au modèle prend des secondes, et les tenir avec la ligne `item` verrouillée
 * bloquerait tous les votes concurrents pour rien.
 *
 * Idempotente : elle relit `adjudication_status` sous verrou avant d'exécuter
 * quoi que ce soit. Deux passages simultanés (le vote + le balayage de
 * rattrapage) ne peuvent pas sanctionner deux fois.
 */
async function runAdjudication(itemId) {
  const item = await CommunityReviewItem.findByPk(itemId);
  if (
    !item
    || item.verdict !== 'violation'
    || ['done', 'failed'].includes(item.adjudication_status)
  ) return null;

  const tally = {
    violation: item.votes_violation || 0,
    compliant: item.votes_compliant || 0,
  };
  const decision = await adjudicate({
    content: item.anonymized_content,
    hadMedia: item.had_media,
    tally,
  });

  const applied = await sequelize.transaction(async (tx) => {
    const fresh = await CommunityReviewItem.findByPk(itemId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!fresh || ['done', 'failed'].includes(fresh.adjudication_status)) return null;

    const sanction = normalizeSanctionDecision(decision)
      || normalizeSanctionDecision({ sanction: 'delete' });
    await executeSanction(fresh, sanction, tx);

    // Le détail de la décision part dans la note du signalement : c'est la
    // seule trace qu'un modérateur aura de POURQUOI ce palier-là, s'il rouvre
    // le dossier plus tard.
    await resolveLinkedReports(fresh.tweet_id, {
      status: 'resolved',
      resolutionAction: resolutionActionFor(sanction),
      note: `Revue communautaire — jury « non conforme » (${tally.violation}/${tally.violation + tally.compliant} voix), `
        + `arbitrage ${decision.model || 'indisponible'} : motif « ${decision.motif || 'non retenu'} », `
        + `${sanction.label}. ${decision.raison}`,
    }, tx);

    await fresh.update({
      sanction: sanction.sanction,
      adjudication_status: decision.fallback ? 'failed' : 'done',
      adjudication: {
        model: decision.model,
        sanction: sanction.sanction,
        duration_days: sanction.duration_days,
        motif: decision.motif,
        raison: decision.raison,
        fallback: decision.fallback,
        at: new Date().toISOString(),
      },
    }, { transaction: tx });

    return fresh;
  });

  if (applied) {
    // Même `delete` peut avoir levé un auto-ban antérieur lié à ce tweet.
    invalidateBanCache(applied.author_id);
    await notifySanction(applied, decision);
  }
  return decision.sanction;
}

/* ══════════════════════════════════════════════════════════════════════════
   ALIMENTATION DE LA FILE
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Tweets que la modération AUTOMATIQUE a déjà écartés — sans qu'un humain
 * ait rien signalé. Trois signaux, qui peuvent se cumuler sur un même tweet :
 *   - `rejected`     : banni par Gemini à la publication (contenu grave)
 *   - `not_eligible` : jamais recommandé (insultes, spam léger…)
 *   - score qualité sous le seuil (`tweet_llm_labels.quality_score`, noté par
 *     l'annotateur codex — voir `LOW_QUALITY_THRESHOLD` plus haut)
 *
 * Amener ces tweets en revue sert de second regard sur la modération
 * automatique elle-même : la communauté peut confirmer ou contredire ce que
 * l'IA a décidé seule.
 *
 * @param {string[]} excludeIds tweets déjà en file, à ne pas reproposer
 * @returns {Promise<Map<string, string[]>>} tweetId → motifs synthétiques
 */
async function findAutoFlaggedCandidates(excludeIds) {
  const rows = await sequelize.query(`
    SELECT t.id, t.moderation_status, labels.quality_score
    FROM tweets t
    LEFT JOIN tweet_llm_labels labels ON labels.tweet_id = t.id
    WHERE t.deleted_at IS NULL
      AND t.parent_tweet_id IS NULL
      -- Un retweet PUR (is_retweet sans is_quote) n'a pas de contenu propre —
      -- les retweets purs ont un content vide par convention (voir
      -- utils/engagementTarget.js). Rien à anonymiser, rien à juger : le
      -- signal (moderation_status/qualité) appartient à l'ORIGINAL, jamais à
      -- ce pointeur. Découvert en prod : un retweet vide s'est retrouvé en
      -- file et un compte a été banni sur un texte qui n'existait pas.
      AND NOT (t.is_retweet = true AND t.is_quote = false)
      AND (
        t.moderation_status IN ('rejected', 'not_eligible')
        OR (labels.quality_score IS NOT NULL AND labels.quality_score < :threshold)
      )
      ${excludeIds.length ? 'AND t.id NOT IN (:excludeIds)' : ''}
    ORDER BY t.created_at DESC
    LIMIT :limit
  `, {
    replacements: {
      threshold: LOW_QUALITY_THRESHOLD,
      excludeIds: excludeIds.length ? excludeIds : [''],
      limit: AUTO_FLAG_SCAN_LIMIT,
    },
    type: QueryTypes.SELECT,
  });

  const byTweet = new Map();
  for (const row of rows) {
    const reasons = [];
    if (row.moderation_status === 'rejected') reasons.push('Banni automatiquement (contenu jugé grave)');
    if (row.moderation_status === 'not_eligible') reasons.push('Exclu des recommandations automatiquement');
    if (row.quality_score !== null && row.quality_score < LOW_QUALITY_THRESHOLD) {
      reasons.push(`Qualité estimée à ${Math.round(row.quality_score * 100)} %`);
    }
    if (reasons.length > 0) byTweet.set(String(row.id), reasons);
  }
  return byTweet;
}

/**
 * Alimente la file : prend les tweets signalés OU déjà écartés par la
 * modération automatique, les anonymise, et crée les items.
 *
 * @param {number} batch nombre de tweets à traiter au maximum
 */
async function enqueueReportedTweets(batch = 10) {
  const openCount = await CommunityReviewItem.count({ where: { status: 'open' } });
  if (openCount >= MAX_OPEN_ITEMS) return { created: 0, skipped: 'file_pleine' };

  const existing = await CommunityReviewItem.findAll({ attributes: ['tweet_id'], raw: true });
  const alreadyQueued = existing.map((row) => row.tweet_id);

  // Les signalements encore ouverts, groupés par tweet visé.
  const reports = await Report.findAll({
    where: {
      target_type: 'tweet',
      status: { [Op.in]: ['pending', 'investigating'] },
      ...(alreadyQueued.length ? { target_id: { [Op.notIn]: alreadyQueued } } : {}),
    },
    attributes: ['target_id', 'reason'],
    raw: true,
  });

  // `humanReports` est suivi à part des motifs conservés : les deux familles se
  // mélangent dans `reasons`, mais seul le décompte humain sert à ordonner la
  // file (voir `createItemForTweet`).
  const byTweet = new Map();
  const entryFor = (key) => {
    if (!byTweet.has(key)) byTweet.set(key, { reasons: [], humanReports: 0 });
    return byTweet.get(key);
  };

  for (const report of reports) {
    const entry = entryFor(String(report.target_id));
    entry.reasons.push(String(report.reason || '').slice(0, 120));
    entry.humanReports += 1;
  }

  // Fusionnés dans la MÊME map que les signalements humains : un tweet qui a
  // été à la fois signalé ET banni automatiquement n'entre en file qu'une
  // fois, avec les deux familles de motifs.
  const autoFlagged = await findAutoFlaggedCandidates(alreadyQueued);
  for (const [tweetId, reasons] of autoFlagged) {
    entryFor(tweetId).reasons.push(...reasons);
  }

  if (byTweet.size === 0) return { created: 0 };

  // Les tweets sont TOUS chargés et filtrés avant d'appeler le modèle : c'est
  // ce qui permet de n'envoyer qu'une requête pour le lot entier au lieu d'une
  // par tweet. Un lot de dix, c'est dix fois moins d'occasions de se faire
  // jeter, et dix fois moins d'attente avant qu'ils deviennent jugeables.
  const prepared = [];
  for (const [tweetId, entry] of [...byTweet.entries()].slice(0, batch)) {
    const tweet = await loadJudgeableTweet(tweetId);
    if (tweet) prepared.push({ tweet, entry });
  }
  if (prepared.length === 0) return { created: 0 };

  const anonymized = await anonymizeMany(prepared.map((p) => p.tweet.content));

  let created = 0;
  for (let i = 0; i < prepared.length; i += 1) {
    if (await persistItem(prepared[i].tweet, prepared[i].entry, anonymized[i])) created += 1;
  }

  return { created };
}

/**
 * Crée l'item de revue d'un tweet. Anonymise au passage — c'est l'appel lent
 * de toute la chaîne (un aller-retour Gemini), d'où l'appel en tâche de fond
 * chez les appelants.
 *
 * ⚠ `report_reasons` est conservé pour la MODÉRATION (traçabilité du dossier),
 * jamais renvoyé au jury : « banni automatiquement, contenu jugé grave » lu
 * avant de voter est une consigne déguisée, pas une information.
 *
 * @param {string} tweetId
 * @param {{ reasons: string[], humanReports: number }} entry
 * @returns {Promise<boolean>} true si un item a bien été créé
 */
async function createItemForTweet(tweetId, entry) {
  const tweet = await loadJudgeableTweet(tweetId);
  if (!tweet) return false;
  return persistItem(tweet, entry, await anonymizeText(tweet.content));
}

/**
 * Charge un tweet et vérifie qu'il a lieu d'être jugé.
 *
 * Séparé de la création pour que les appelants puissent réunir TOUS leurs
 * tweets avant d'appeler le modèle une seule fois : c'est cette séparation qui
 * rend le lot possible.
 *
 * @returns {Promise<Tweet|null>} null quand il n'y a rien à juger
 */
async function loadJudgeableTweet(tweetId) {
  const tweet = await Tweet.findByPk(tweetId, {
    attributes: ['id', 'user_id', 'content', 'media_urls', 'deleted_at', 'is_retweet', 'is_quote'],
  });
  // Un tweet supprimé entre le signalement et le traitement n'a plus à
  // être jugé : le sujet a disparu.
  if (!tweet || tweet.deleted_at) return null;
  // Un signalement peut viser la ligne d'un retweet pur plutôt que
  // l'original — cette ligne n'a pas de contenu propre (`content = ''`),
  // rien à anonymiser ni à juger. Voir le commentaire équivalent dans
  // `findAutoFlaggedCandidates`.
  if (tweet.is_retweet && !tweet.is_quote) return null;
  return tweet;
}

/**
 * Écrit l'item, avec le texte anonymisé déjà obtenu.
 *
 * @param {{ reasons: string[], humanReports: number }} entry
 * @param {{ text: string, redactions: number }|null} anonymized `null` = échec :
 *   l'item entre en `failed` et sera repris, jamais avec le texte d'origine.
 * @returns {Promise<boolean>} true si un item a bien été créé
 */
async function persistItem(tweet, { reasons, humanReports }, anonymized) {
  try {
    await CommunityReviewItem.create({
      tweet_id: String(tweet.id),
      author_id: String(tweet.user_id),
      anonymized_content: anonymized ? anonymized.text : null,
      anonymization_status: anonymized ? 'done' : 'failed',
      redactions: anonymized ? anonymized.redactions : 0,
      had_media: Array.isArray(tweet.media_urls) && tweet.media_urls.length > 0,
      report_reasons: [...new Set(reasons)].slice(0, 5),
      // Compte les signalements HUMAINS uniquement, pas les motifs affichés.
      // La priorité de la file trie là-dessus : compter aussi les motifs
      // automatiques ferait passer un tweet auto-détecté sur trois critères
      // devant un tweet réellement signalé par quelqu'un, ce qui est
      // exactement l'inverse de l'ordre voulu.
      report_count: humanReports,
    });
    return true;
  } catch (error) {
    // Une collision d'unicité veut dire qu'un autre passage a pris le tweet
    // entre-temps : ce n'est pas une erreur.
    if (error?.name !== 'SequelizeUniqueConstraintError') {
      logger.error(`[communityModeration] mise en file de ${tweet.id} impossible:`, error.message);
    }
    return false;
  }
}

/**
 * Met UN tweet en file, immédiatement — appelé au moment où un signalement est
 * créé (voir `moderationController.createReport`).
 *
 * Sans ça, un signalement n'entrait en revue que le jour où la file se vidait
 * pour un votant donné (`GET /next` ne réalimente que sur file vide). Avec un
 * arriéré de contenus auto-détectés en permanence, ce jour n'arrivait jamais :
 * les signalements humains partaient côté modération, et nulle part ailleurs.
 *
 * Tolère d'être appelé plusieurs fois sur le même tweet : l'index unique sur
 * `tweet_id` tranche, et une collision n'est pas traitée comme une erreur.
 */
async function enqueueTweet(tweetId) {
  const id = String(tweetId);

  const already = await CommunityReviewItem.count({ where: { tweet_id: id } });
  if (already > 0) return { created: 0, skipped: 'deja_en_file' };

  const openCount = await CommunityReviewItem.count({ where: { status: 'open' } });
  if (openCount >= MAX_OPEN_ITEMS) return { created: 0, skipped: 'file_pleine' };

  const reports = await Report.findAll({
    where: {
      target_type: 'tweet',
      target_id: id,
      status: { [Op.in]: ['pending', 'investigating'] },
    },
    attributes: ['reason'],
    raw: true,
  });
  if (reports.length === 0) return { created: 0, skipped: 'aucun_signalement' };

  const created = await createItemForTweet(id, {
    reasons: reports.map((r) => String(r.reason || '').slice(0, 120)).filter(Boolean),
    humanReports: reports.length,
  });
  return { created: created ? 1 : 0 };
}

/* ══════════════════════════════════════════════════════════════════════════
   ENTRETIEN
   ══════════════════════════════════════════════════════════════════════════ */

/** Dernier passage d'entretien — throttle en mémoire, voir `maintenance()`. */
let lastMaintenanceAt = 0;
const MAINTENANCE_EVERY_MS = 60 * 1000;

/** Un arbitrage plus vieux que ça n'est plus « en cours », il est perdu. */
const ADJUDICATION_STUCK_MS = 3 * 60 * 1000;

/**
 * Au-delà, un item ouvert n'a plus aucune chance de réunir un jury : on cesse
 * de le proposer. Sept jours, parce que la file se remplit plus vite qu'elle ne
 * se vide et qu'un contenu vieux d'une semaine n'a plus d'intérêt à être jugé
 * par la communauté — il en a encore un pour un modérateur, à qui le
 * signalement reste adressé (voir `abandonStaleItems`).
 */
const ABANDON_AFTER_MS = 7 * 86400000;

/**
 * Délai avant de re-tenter l'anonymisation d'un item échoué, et nombre d'items
 * repris par passage.
 *
 * Le délai fait office de compteur de tentatives sans colonne dédiée : chaque
 * échec bumpe `updated_at`, donc un item qui échoue systématiquement (contenu
 * que Gemini refuse vraiment) n'est réessayé qu'une fois par quart d'heure au
 * lieu d'une fois par minute. Un item qui a juste croisé un hoquet réseau, lui,
 * repart au premier passage utile.
 */
const ANONYMIZE_RETRY_AFTER_MS = 15 * 60 * 1000;
const ANONYMIZE_RETRY_BATCH = 5;

/**
 * Reprend les items dont l'anonymisation a échoué.
 *
 * ⚠ C'est la réparation la plus importante des trois, parce que sans elle un
 * échec était DÉFINITIF et silencieux : `createItemForTweet` écrivait `failed`,
 * rien ne réessayait, et le tweet ne pouvait pas non plus revenir en file
 * (la mise en file exclut les tweets déjà présents, quel que soit leur état).
 * Un hoquet réseau de deux secondes suffisait donc à retirer un signalement de
 * la revue pour toujours. Constaté en prod le 2026-07-28 : les 47 items ouverts
 * étaient TOUS en `failed`, la page affichait « rien à juger » en permanence
 * alors que la file était pleine — et rejouer l'anonymisation sur ces mêmes
 * textes passait sans problème.
 *
 * Un tweet supprimé entre-temps n'a plus à être jugé : l'item est clos sans
 * verdict, sinon il serait repris indéfiniment pour un sujet qui n'existe plus.
 */
async function retryFailedAnonymizations() {
  const items = await CommunityReviewItem.findAll({
    where: {
      status: 'open',
      anonymization_status: 'failed',
      updated_at: { [Op.lt]: new Date(Date.now() - ANONYMIZE_RETRY_AFTER_MS) },
    },
    limit: ANONYMIZE_RETRY_BATCH,
  });

  // Même logique que la mise en file : on réunit les textes d'abord, on
  // n'appelle le modèle qu'une fois. Une reprise de cinq items coûte donc une
  // requête, pas cinq.
  const pending = [];
  for (const item of items) {
    const tweet = await Tweet.findByPk(item.tweet_id, { attributes: ['id', 'content', 'deleted_at'] });

    if (!tweet || tweet.deleted_at) {
      await item.update({ status: 'closed', closed_at: new Date() });
      continue;
    }
    pending.push({ item, content: tweet.content });
  }

  if (pending.length === 0) return items.length;

  const anonymized = await anonymizeMany(pending.map((p) => p.content));

  for (let i = 0; i < pending.length; i += 1) {
    const { item } = pending[i];
    const result = anonymized[i];

    if (!result) {
      // `updated_at` est poussé EXPLICITEMENT : réécrire `failed` par-dessus
      // `failed` ne change aucun champ, Sequelize sauterait la requête, et
      // l'item reviendrait dans le lot à chaque minute au lieu d'attendre son
      // quart d'heure — un contenu que le modèle refuse vraiment monopoliserait
      // alors les cinq places de reprise indéfiniment.
      await item.update({ anonymization_status: 'failed', updated_at: new Date() });
      continue;
    }

    await item.update({
      anonymized_content: result.text,
      anonymization_status: 'done',
      redactions: result.redactions,
    });
  }

  return items.length;
}

/**
 * Trois réparations, groupées parce qu'elles partagent le même déclencheur (une
 * demande de contenu à juger) et le même throttle :
 *
 *   1. Rendre les places dont le délai a expiré, sinon un item confié à trois
 *      personnes qui n'ouvrent jamais l'app resterait bloqué pour toujours.
 *   2. Reprendre les arbitrages perdus. Si le process meurt entre la fermeture
 *      de l'item et la réponse du modèle, l'item reste `pending` — jugé mais
 *      sans suite. Personne ne le verrait jamais : ni le jury (il a fini), ni
 *      l'auteur (rien ne lui est arrivé), ni la modération (le signalement est
 *      encore listé comme en attente).
 *   3. Reprendre les anonymisations échouées — voir
 *      `retryFailedAnonymizations`, c'est ce qui empêche la file de mourir.
 *   4. Abandonner les items qui ne trouveront jamais de jury — voir
 *      `abandonStaleItems`.
 *
 * Throttlée en mémoire plutôt que par une tâche de fond : la fonctionnalité est
 * en bêta sur une seule plateforme, ajouter un worker pm2 pour deux UPDATE
 * serait disproportionné. Sur plusieurs process, chacun a son throttle et le
 * travail est simplement fait un peu plus souvent — jamais deux fois, les deux
 * opérations sont idempotentes.
 */
/**
 * Ferme les items qui traînent sans avoir réuni de jury.
 *
 * Le cas : une place non honorée est rendue au bout de `ASSIGNMENT_TTL_MS`, et
 * l'item repart vers quelqu'un d'autre — mais il n'est JAMAIS reproposé à qui
 * l'a déjà eu (c'est le prix de « pas deux fois le même contenu »). Sur une base
 * d'utilisateurs actifs réduite, le vivier d'éligibles finit par s'épuiser :
 * plus personne ne peut recevoir cet item, et il reste ouvert indéfiniment,
 * à gonfler le compteur « en attente » sans que rien ne puisse le trancher.
 *
 * ⚠ On ne classe SURTOUT PAS les signalements liés en passant. Ils restent
 * `pending` et continuent d'apparaître dans le tableau de bord modérateur : la
 * revue communautaire n'a pas su répondre, un humain doit prendre le relais.
 * Les résoudre ici ferait disparaître un abus signalé sans que personne ne
 * l'ait jamais regardé — exactement l'inverse du but.
 */
async function abandonStaleItems() {
  const [, rows] = await CommunityReviewItem.update(
    { status: 'closed', closed_at: new Date() },
    {
      where: {
        status: 'open',
        verdict: null,
        created_at: { [Op.lt]: new Date(Date.now() - ABANDON_AFTER_MS) },
      },
      returning: ['id'],
    },
  );

  const count = Array.isArray(rows) ? rows.length : 0;
  if (count > 0) {
    logger.warn(
      `[communityModeration] ${count} item(s) fermé(s) sans jury après ${ABANDON_AFTER_MS / 86400000} jours — `
      + 'les signalements liés restent en attente côté modération humaine',
    );
  }
  return count;
}

async function maintenance() {
  const now = Date.now();
  if (now - lastMaintenanceAt < MAINTENANCE_EVERY_MS) return;
  lastMaintenanceAt = now;

  try {
    await CommunityReviewAssignment.update(
      { status: 'expired' },
      { where: { status: 'pending', expires_at: { [Op.lt]: new Date() } } },
    );
  } catch (error) {
    logger.error('[communityModeration] libération des places expirées:', error.message);
  }

  try {
    await abandonStaleItems();
  } catch (error) {
    logger.error('[communityModeration] abandon des items sans jury:', error.message);
  }

  try {
    const stuck = await CommunityReviewItem.findAll({
      where: {
        verdict: 'violation',
        adjudication_status: 'pending',
        closed_at: { [Op.lt]: new Date(now - ADJUDICATION_STUCK_MS) },
      },
      attributes: ['id'],
      limit: 5,
      raw: true,
    });
    // Lancées SANS `await` : chaque arbitrage est un aller-retour de plusieurs
    // secondes vers le modèle, et `maintenance()` est attendue par la requête
    // qui demande un contenu à juger. Les attendre ferait patienter un juré
    // pendant qu'on rattrape des dossiers qui ne le concernent pas.
    // `runAdjudication` relit son état sous verrou : deux reprises concurrentes
    // ne peuvent pas sanctionner deux fois.
    for (const row of stuck) {
      runAdjudication(row.id).catch((error) => {
        logger.error(`[communityModeration] reprise d'arbitrage ${row.id}:`, error.message);
      });
    }
  } catch (error) {
    logger.error('[communityModeration] reprise des arbitrages:', error.message);
  }

  // Sans `await`, comme les arbitrages : chaque reprise est un aller-retour
  // Gemini, et la requête qui a déclenché l'entretien n'a pas à l'attendre.
  retryFailedAnonymizations().catch((error) => {
    logger.error('[communityModeration] reprise des anonymisations:', error.message);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   ATTRIBUTION — QUI JUGE QUOI
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Le compte a-t-il le droit de siéger ?
 *
 * ⚠ La règle est « tout le monde peut juger », et ce n'est pas un relâchement :
 * la plateforme compte une dizaine d'utilisateurs réels. Chaque condition
 * ajoutée ici ne protège de rien à cette échelle, elle vide simplement le jury.
 * Il ne reste donc que ce qui est structurel — un compte suspendu ou désactivé
 * ne juge pas les autres. Tout le reste (ancienneté, contribution) sert à
 * PRIORISER, jamais à exclure : voir `reviewerStanding`.
 *
 * Requête SQL brute volontairement : lire `created_at` sur une instance
 * Sequelize renvoie `undefined` (l'attribut s'appelle `createdAt` côté modèle).
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function checkReviewerEligibility(userId) {
  const [row] = await sequelize.query(
    `SELECT is_active, is_suspended, created_at FROM users WHERE id = :id`,
    { replacements: { id: userId }, type: QueryTypes.SELECT },
  );

  if (!row) return { ok: false, reason: 'compte_introuvable' };
  if (row.is_suspended || row.is_active === false) return { ok: false, reason: 'compte_inactif' };

  // Levier gardé pour le jour où la plateforme grandira : à 0, il ne bloque
  // personne. Le remonter est un choix à faire quand le vivier le permet, pas
  // une valeur par défaut à subir.
  if (MIN_ACCOUNT_AGE_DAYS > 0) {
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs < MIN_ACCOUNT_AGE_DAYS * 86400000) return { ok: false, reason: 'compte_trop_recent' };
  }

  return { ok: true };
}

/**
 * Cette personne a-t-elle signalé ce tweet ?
 *
 * Sert de garde-fou au moment de servir un contenu déjà attribué : la sélection
 * l'exclut déjà en amont, mais un signalement peut tomber APRÈS l'attribution.
 *
 * Tous statuts confondus, y compris les signalements classés : un signalement
 * rejeté par la modération n'efface pas l'opinion de celui qui l'a déposé.
 */
async function hasReportedTweet(userId, tweetId, tx = null) {
  const [row] = await sequelize.query(
    `SELECT 1 AS found
     FROM reports
     WHERE target_type = 'tweet' AND target_id = :tweetId AND reporter_id = :userId
     LIMIT 1`,
    // La transaction est transmise quand il y en a une : lancer la lecture sur
    // le pool depuis l'intérieur d'une transaction la ferait porter sur un
    // autre instantané que la ligne verrouillée juste au-dessus.
    { replacements: { userId, tweetId }, type: QueryTypes.SELECT, transaction: tx },
  );
  return !!row;
}

/**
 * Ce que cette personne a déjà apporté à la revue.
 *
 * `accords` = ses votes qui se sont retrouvés du côté du verdict finalement
 * retenu. C'est la mesure la moins manipulable dont on dispose sans nouvelle
 * table : voter au hasard ou expédier les contenus ne la fait pas monter, parce
 * qu'il faut tomber juste avec deux autres personnes qui ne se connaissent pas.
 *
 * Elle ne donne AUCUN droit supplémentaire et n'en retire aucun — elle décide
 * seulement de l'ordre dans lequel les contenus sont proposés.
 */
async function reviewerStanding(userId) {
  // ⚠ `::text` des deux côtés, obligatoire : le verdict de l'item et celui du
  // vote sont deux ENUM Postgres DISTINCTS (`enum_community_review_items_verdict`
  // et `enum_community_review_votes_verdict`), et Postgres refuse de comparer
  // deux types enum différents — « operator does not exist ». Les valeurs sont
  // pourtant les mêmes chaînes ; c'est la déclaration qui diffère.
  const [row] = await sequelize.query(`
    SELECT COUNT(*)::int AS votes,
           COUNT(*) FILTER (WHERE i.verdict IS NOT NULL AND i.verdict::text = v.verdict::text)::int AS accords
    FROM community_review_votes v
    JOIN community_review_items i ON i.id = v.item_id
    WHERE v.voter_id = :userId
  `, { replacements: { userId }, type: QueryTypes.SELECT });

  const accords = Number(row?.accords) || 0;
  return { votes: Number(row?.votes) || 0, accords, trusted: accords >= TRUSTED_AGREEMENTS };
}

/**
 * Items que cette personne pourrait juger, du plus prioritaire au moins.
 *
 * Quatre exclusions, et elles seules :
 *   - ses propres tweets (on ne se juge pas soi-même) ;
 *   - les tweets qu'elle a elle-même SIGNALÉS. Signaler, c'est avoir déjà rendu
 *     son verdict : la personne a dit que ce contenu enfreignait les règles
 *     avant même d'entrer dans le jury. Lui redonner le même tweet à juger ne
 *     recueille pas un avis, ça compte deux fois le sien — et sur un jury de
 *     trois où la majorité est à deux voix, une seule de ces places suffit à
 *     faire basculer le verdict ;
 *   - tout item qu'elle a DÉJÀ reçu, même expiré, même voté — c'est la clause
 *     qui garantit qu'un contenu n'est jamais présenté deux fois à la même
 *     personne ;
 *   - les items dont le jury est déjà complet.
 *
 * ⚠ Le filtre sur le graphe de suivi (ne pas juger quelqu'un qu'on suit, ou qui
 * nous suit) n'est PLUS une exclusion : c'est une préférence. Sur une petite
 * communauté, tout le monde se suit — l'appliquer durement ne protégeait pas
 * l'anonymat, il supprimait purement et simplement la revue. Il reste en tête
 * de tri : tant qu'il existe des contenus d'inconnus, ce sont ceux-là qui
 * partent en premier, et on ne retombe sur les autres que faute de mieux.
 *
 * L'ordre, du plus fort au plus faible :
 *   1. contenus d'auteurs hors du cercle de la personne (anonymat le mieux tenu) ;
 *   2. selon la contribution : les jurys les plus AVANCÉS pour qui a déjà fait
 *      ses preuves — c'est leur voix qui va trancher — et les jurys les plus
 *      FRAIS pour les autres, dont l'avis sera confronté à deux autres avant de
 *      compter. Personne n'est écarté, l'ordre change, c'est tout ;
 *   3. les plus signalés, puis les plus anciens.
 */
async function findCandidates(userId, { trusted = false } = {}) {
  return sequelize.query(`
    SELECT i.id,
           COALESCE(a.taken, 0) AS taken
    FROM community_review_items i
    LEFT JOIN (
      SELECT item_id, COUNT(*)::int AS taken
      FROM community_review_assignments
      WHERE status IN ('pending', 'voted')
      GROUP BY item_id
    ) a ON a.item_id = i.id
    WHERE i.status = 'open'
      AND i.anonymization_status = 'done'
      AND i.author_id <> :userId
      AND COALESCE(a.taken, 0) < :panelSize
      AND NOT EXISTS (
        SELECT 1 FROM community_review_assignments x
        WHERE x.item_id = i.id AND x.reviewer_id = :userId
      )
      AND NOT EXISTS (
        SELECT 1 FROM community_review_votes v
        WHERE v.item_id = i.id AND v.voter_id = :userId
      )
      -- Signaleur du tweet : son avis est déjà donné, le recueillir une
      -- seconde fois via le jury reviendrait à le compter double.
      -- target_type est un ENUM Postgres : le littéral est coercé tout seul, on
      -- ne le caste pas pour ne pas perdre l'index (target_id, target_type).
      AND NOT EXISTS (
        SELECT 1 FROM reports r
        WHERE r.target_type = 'tweet'
          AND r.target_id = i.tweet_id
          AND r.reporter_id = :userId
      )
    ORDER BY EXISTS (
               SELECT 1 FROM user_follows f
               WHERE f.status = 'active'
                 AND ((f.follower_id = :userId  AND f.following_id = i.author_id)
                   OR (f.follower_id = i.author_id AND f.following_id = :userId))
             ) ASC,
             CASE WHEN :trusted THEN COALESCE(a.taken, 0) ELSE -COALESCE(a.taken, 0) END DESC,
             i.report_count DESC,
             i.created_at ASC
    LIMIT :pool
  `, {
    replacements: { userId, panelSize: PANEL_SIZE, pool: CANDIDATE_POOL, trusted },
    type: QueryTypes.SELECT,
  });
}

/**
 * Tire un candidat du vivier, biaisé vers la tête.
 *
 * Le carré d'un tirage uniforme concentre les tirages sur les premiers indices
 * tout en laissant une vraie chance aux suivants : l'ordre de priorité est
 * respecté, sans que tout le monde converge sur le même item — c'est ce qui
 * empêche les mêmes trios de se reformer indéfiniment.
 */
function pickCandidate(candidates) {
  const r = Math.random() ** 2;
  return candidates[Math.floor(r * candidates.length)];
}

/**
 * Réserve une place du jury, sous verrou de la ligne `item`.
 *
 * Le verrou n'est pas cosmétique : deux personnes qui demandent un contenu en
 * même temps liraient le même décompte de places et s'attribueraient toutes
 * les deux la dernière — un jury à 4 sur un seuil pensé pour 3.
 *
 * @returns {Promise<CommunityReviewItem|null>} null si la place est partie entre-temps
 */
async function reserveSlot(userId, itemId) {
  try {
    return await sequelize.transaction(async (tx) => {
      const item = await CommunityReviewItem.findByPk(itemId, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!item || item.status !== 'open' || item.anonymization_status !== 'done') return null;

      const taken = await CommunityReviewAssignment.count({
        where: { item_id: itemId, status: { [Op.in]: ['pending', 'voted'] } },
        transaction: tx,
      });
      if (taken >= PANEL_SIZE) return null;

      await CommunityReviewAssignment.create({
        item_id: itemId,
        reviewer_id: userId,
        status: 'pending',
        expires_at: new Date(Date.now() + ASSIGNMENT_TTL_MS),
      }, { transaction: tx });

      return item;
    });
  } catch (error) {
    // La même personne a demandé deux contenus en parallèle et l'index unique
    // a tranché : ce n'est pas une panne, on essaiera un autre item.
    if (error?.name === 'SequelizeUniqueConstraintError') return null;
    throw error;
  }
}

/**
 * Le contenu confié à cette personne — celui qu'elle a déjà en main, ou un
 * nouveau si elle n'en a pas.
 *
 * Renvoyer d'abord la place en cours rend l'appel idempotent : rafraîchir la
 * page, relancer l'app ou perdre le réseau ne change pas le texte affiché, et
 * ne consomme pas un item de plus.
 *
 * @returns {Promise<{ item: object|null, ineligible: string|null }>}
 */
async function nextItemFor(userId) {
  await maintenance();

  const held = await CommunityReviewAssignment.findOne({
    where: { reviewer_id: userId, status: 'pending' },
    order: [['created_at', 'ASC']],
  });
  if (held) {
    const item = await CommunityReviewItem.findByPk(held.item_id);
    // Le signalement peut arriver APRÈS l'attribution : la personne reçoit le
    // tweet anonymisé, puis tombe sur l'original dans son fil et le signale.
    // Elle ne peut pas faire le rapprochement (c'est tout l'objet de
    // l'anonymisation), mais le biais est le même — son verdict serait déjà
    // rendu. On revérifie donc à chaque service, pas seulement à l'attribution.
    const biased = item ? await hasReportedTweet(userId, item.tweet_id) : false;

    if (item && item.status === 'open' && !biased) {
      return { item: publicShape(item), ineligible: null };
    }
    // L'item s'est fermé pendant qu'elle l'avait en main (le jury a conclu sans
    // elle), ou elle vient de le signaler : la place n'a plus d'objet, on la
    // solde et on en cherche une autre.
    await held.update({ status: 'expired' });
  }

  const eligibility = await checkReviewerEligibility(userId);
  if (!eligibility.ok) return { item: null, ineligible: eligibility.reason };

  // La contribution ne conditionne pas l'accès, seulement l'ordre : qui a déjà
  // fait ses preuves reçoit les jurys sur le point de trancher, les autres des
  // jurys tout frais où leur avis sera confronté à deux autres avant de peser.
  const standing = await reviewerStanding(userId);
  const candidates = await findCandidates(userId, { trusted: standing.trusted });
  const pool = [...candidates];

  for (let attempt = 0; attempt < ASSIGN_ATTEMPTS && pool.length > 0; attempt += 1) {
    const chosen = pickCandidate(pool);
    pool.splice(pool.indexOf(chosen), 1);

    const item = await reserveSlot(userId, chosen.id);
    if (item) return { item: publicShape(item), ineligible: null };
  }

  return { item: null, ineligible: null };
}

/**
 * Forme renvoyée au jury — liste blanche explicite, et volontairement pauvre.
 *
 * Ce qui n'y est PAS et pourquoi :
 *   - `tweet_id` / `author_id` : de quoi désanonymiser en une requête ;
 *   - `report_reasons` : « banni automatiquement, contenu jugé grave » n'est
 *     pas un contexte, c'est une consigne de vote ;
 *   - `report_count`, `votes_compliant`, `votes_violation` : savoir que
 *     d'autres ont déjà tranché, et dans quel sens, déplace un vote. C'est
 *     l'effet de conformité, et il est mesuré ;
 *   - le seuil et la sanction encourue : personne ne juge pareil un texte quand
 *     on lui a dit qu'un bannissement est au bout.
 */
function publicShape(item) {
  return {
    id: item.id,
    content: item.anonymized_content,
    redactions: item.redactions,
    had_media: item.had_media,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   VOTE
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Enregistre un vote et, si un camp atteint la majorité, ferme l'item.
 *
 * Le vote n'est accepté que si la personne a REÇU ce contenu : sans cette
 * vérification, un client modifié pourrait voter sur n'importe quel item ouvert
 * en devinant son identifiant, et faire tomber un verdict à lui seul en
 * bouclant sur la file.
 *
 * Sur `violation` majoritaire, l'item se ferme et le tweet est supprimé
 * immédiatement : c'est le minimum imposé par le verdict final. La sanction du
 * COMPTE n'est pas décidée ici, car elle demande un aller-retour vers le modèle
 * arbitre, bien trop lent pour tenir la ligne `item` verrouillée.
 * `runAdjudication` prend le relais après le commit, et le balayage d'entretien
 * rattrape si le process meurt entre les deux.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>} rien de plus :
 *   le votant n'apprend ni où en est le jury, ni ce qui a été décidé.
 */
async function castVote(userId, itemId, verdict) {
  if (!['compliant', 'violation'].includes(verdict)) {
    return { ok: false, reason: 'Verdict invalide' };
  }

  const result = await sequelize.transaction(async (tx) => {
    const item = await CommunityReviewItem.findByPk(itemId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!item) return { ok: false, reason: 'Contenu introuvable' };
    if (item.status !== 'open') return { ok: false, reason: 'Ce contenu a déjà été tranché' };
    if (String(item.author_id) === String(userId)) {
      return { ok: false, reason: 'Vous ne pouvez pas juger votre propre publication' };
    }

    const assignment = await CommunityReviewAssignment.findOne({
      where: { item_id: itemId, reviewer_id: userId },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!assignment) return { ok: false, reason: 'Ce contenu ne vous a pas été confié' };
    // Une place expirée reste votable tant que l'item est ouvert : refuser le
    // vote de quelqu'un qui a pris 46 minutes pour lire attentivement serait
    // punir exactement le comportement qu'on cherche.
    if (assignment.status === 'voted') return { ok: false, reason: 'Vous avez déjà jugé ce contenu' };

    // Dernier verrou anti-biais : l'app garde le contenu à l'écran, la personne
    // peut donc voter sans repasser par `/next` — et donc sans que la
    // revérification faite là-bas ait eu lieu. Si elle a signalé ce tweet
    // entre-temps, son verdict est déjà rendu et ce vote le compterait deux
    // fois. La place est soldée plutôt que gardée : elle repartira sur un autre
    // contenu au prochain appel.
    if (await hasReportedTweet(userId, item.tweet_id, tx)) {
      await assignment.update({ status: 'expired' }, { transaction: tx });
      return { ok: false, reason: 'Vous avez signalé ce contenu, vous ne pouvez pas le juger' };
    }

    try {
      await CommunityReviewVote.create(
        { item_id: item.id, voter_id: userId, verdict },
        { transaction: tx },
      );
    } catch (error) {
      // C'est l'index UNIQUE qui tranche le double vote, pas une lecture
      // préalable : deux requêtes simultanées passeraient toutes les deux un
      // test applicatif avant que l'une n'ait écrit.
      if (error?.name === 'SequelizeUniqueConstraintError') {
        return { ok: false, reason: 'Vous avez déjà jugé ce contenu' };
      }
      throw error;
    }

    await assignment.update({ status: 'voted' }, { transaction: tx });

    const compliant = (item.votes_compliant || 0) + (verdict === 'compliant' ? 1 : 0);
    const violation = (item.votes_violation || 0) + (verdict === 'violation' ? 1 : 0);

    // Un vote n'incrémente qu'un seul compteur : un seul des deux camps peut
    // franchir la majorité sur CE vote.
    const patch = { votes_compliant: compliant, votes_violation: violation };
    let needsAdjudication = false;
    let compliantOutcome = { tweetId: null, unsuspendedAuthorId: null };

    if (violation >= MAJORITY) {
      patch.status = 'closed';
      patch.closed_at = new Date();
      patch.verdict = 'violation';
      patch.adjudication_status = 'pending';
      await applyViolationMinimum(item, tx);
      needsAdjudication = true;
    } else if (compliant >= MAJORITY) {
      patch.status = 'closed';
      patch.closed_at = new Date();
      patch.verdict = 'compliant';

      compliantOutcome = await applyCompliantVerdict(item, tx);
      await resolveLinkedReports(item.tweet_id, {
        status: 'dismissed',
        resolutionAction: 'none',
        note: `Classé par la revue communautaire (verdict "conforme", ${compliant} voix sur ${PANEL_SIZE}).`,
      }, tx);
    }

    if (patch.status === 'closed') {
      // Les places encore ouvertes n'ont plus d'objet : les solder évite qu'un
      // troisième juré ouvre l'app pour un contenu déjà tranché.
      await CommunityReviewAssignment.update(
        { status: 'expired' },
        { where: { item_id: item.id, status: 'pending' }, transaction: tx },
      );
    }

    await item.update(patch, { transaction: tx });

    return {
      ok: true,
      needsAdjudication,
      itemId: item.id,
      restoredTweetId: compliantOutcome.tweetId,
      unsuspendedAuthorId: compliantOutcome.unsuspendedAuthorId,
    };
  });

  if (result.ok && result.unsuspendedAuthorId) {
    invalidateBanCache(result.unsuspendedAuthorId);
  }
  if (result.ok && result.restoredTweetId) {
    restoreRecommendationEligibility(result.restoredTweetId);
  }

  // Hors transaction, volontairement : l'arbitrage prend des secondes, et son
  // échec ne doit pas annuler un vote déjà valide.
  if (result.ok && result.needsAdjudication) {
    runAdjudication(result.itemId).catch((error) => {
      logger.error('[communityModeration] arbitrage impossible:', error.message);
    });
  }

  return result.ok ? { ok: true } : result;
}

/* ══════════════════════════════════════════════════════════════════════════
   CLASSEMENT DES JURÉS — RÉSERVÉ À L'ADMINISTRATION
   ══════════════════════════════════════════════════════════════════════════
   ⚠ Rien de ce qui suit ne doit jamais être renvoyé à un juré. Savoir que
   quelqu'un est « fiable à 92 % » ou qu'il a fait tomber douze sanctions
   transformerait la revue en concours, et un concours se gagne en votant vite
   et comme les autres — exactement les deux comportements que la revue essaie
   d'empêcher. Ces chiffres servent à SURVEILLER l'outil, pas à animer une
   communauté. */

/**
 * Poids de l'accord face à la fiabilité dans le score de confiance.
 *
 * L'accord domine (0.7) parce qu'il mesure le jugement lui-même ; la fiabilité
 * (0.3) ne mesure que l'assiduité — répondre à ce qu'on reçoit. Quelqu'un de
 * très assidu mais systématiquement à contre-courant ne doit pas remonter dans
 * le classement à force de cliquer.
 */
const TRUST_WEIGHT_AGREEMENT = 0.7;
const TRUST_WEIGHT_RELIABILITY = 0.3;

/**
 * Lissage bayésien : deux votes fictifs à 50 % ajoutés à tout le monde.
 *
 * Sans lui, quelqu'un qui a voté une seule fois et est tombé juste afficherait
 * 100 % d'accord et écraserait le classement devant un juré à 40 votes et 90 %.
 * Deux votes fictifs suffisent à écarter ce cas sans effacer les écarts réels
 * dès qu'il y a du volume.
 */
const TRUST_PRIOR_VOTES = 2;

/**
 * Nombre de dossiers tranchés en dessous duquel on refuse d'annoncer une
 * confiance « élevée » ou « correcte ».
 *
 * Le lissage empêche un 100 % sur un vote d'écraser le classement, mais il ne
 * suffit pas à rendre l'étiquette honnête : quelqu'un ayant voté une seule fois
 * ressortait quand même en « élevée ». Or l'admin lit l'étiquette avant le
 * nombre — et « confiance élevée » sur un vote est une affirmation qu'on n'a pas
 * les moyens de faire.
 */
const TRUST_MIN_SETTLED = 5;

/**
 * Paliers de lecture du score — l'admin lit une étiquette, pas un nombre nu.
 * Sous `TRUST_MIN_SETTLED` dossiers tranchés, l'étiquette est plafonnée à
 * « à confirmer » quel que soit le score : ce n'est pas un mauvais juré, c'est
 * un juré sur lequel on ne sait pas encore.
 */
function trustLabel(score, tranches) {
  if (tranches < TRUST_MIN_SETTLED) return score >= 35 ? 'a_confirmer' : 'faible';
  if (score >= 75) return 'elevee';
  if (score >= 55) return 'correcte';
  if (score >= 35) return 'a_confirmer';
  return 'faible';
}

/**
 * Classement des jurés, du plus utile au moins.
 *
 * Une seule requête : les compteurs de votes et ceux d'attributions sont deux
 * agrégats distincts, joints en CTE plutôt qu'en N+1 sur chaque juré.
 *
 * @param {number} limit
 * @returns {Promise<Array<object>>}
 */
async function jurorLeaderboard(limit = 50) {
  const rows = await sequelize.query(`
    WITH votes AS (
      SELECT v.voter_id,
             COUNT(*)::int                                                          AS votes,
             COUNT(*) FILTER (WHERE i.verdict IS NOT NULL)::int                     AS tranches,
             -- ::text des deux côtés : ce sont deux ENUM Postgres DISTINCTS,
             -- les comparer directement lève « operator does not exist ».
             COUNT(*) FILTER (WHERE i.verdict IS NOT NULL
                              AND i.verdict::text = v.verdict::text)::int           AS accords,
             COUNT(*) FILTER (WHERE v.verdict::text = 'violation')::int             AS votes_violation,
             COUNT(*) FILTER (WHERE v.verdict::text = 'compliant')::int             AS votes_conforme,
             COUNT(*) FILTER (WHERE i.sanction IS NOT NULL
                              AND i.sanction <> 'none')::int                        AS sanctions,
             MIN(v.created_at)                                                      AS premier_vote,
             MAX(v.created_at)                                                      AS dernier_vote
      FROM community_review_votes v
      LEFT JOIN community_review_items i ON i.id = v.item_id
      GROUP BY v.voter_id
    ),
    places AS (
      SELECT reviewer_id,
             COUNT(*)::int                                          AS attributions,
             COUNT(*) FILTER (WHERE status = 'voted')::int          AS honorees,
             COUNT(*) FILTER (WHERE status = 'expired')::int        AS abandonnees,
             COUNT(*) FILTER (WHERE status = 'pending')::int        AS en_cours
      FROM community_review_assignments
      GROUP BY reviewer_id
    )
    SELECT u.id, u.username, u.full_name, u.avatar, u.verified,
           u.is_suspended, u.is_active,
           COALESCE(vo.votes, 0)            AS votes,
           COALESCE(vo.tranches, 0)         AS tranches,
           COALESCE(vo.accords, 0)          AS accords,
           COALESCE(vo.votes_violation, 0)  AS votes_violation,
           COALESCE(vo.votes_conforme, 0)   AS votes_conforme,
           COALESCE(vo.sanctions, 0)        AS sanctions,
           vo.premier_vote,
           vo.dernier_vote,
           COALESCE(pl.attributions, 0)     AS attributions,
           COALESCE(pl.honorees, 0)         AS honorees,
           COALESCE(pl.abandonnees, 0)      AS abandonnees,
           COALESCE(pl.en_cours, 0)         AS en_cours
    FROM users u
    LEFT JOIN votes  vo ON vo.voter_id    = u.id
    LEFT JOIN places pl ON pl.reviewer_id = u.id
    -- Seuls les comptes qui ont réellement touché à la revue : lister les 3450
    -- lignes de la table users à zéro partout n'apprendrait rien.
    WHERE vo.voter_id IS NOT NULL OR pl.reviewer_id IS NOT NULL
    LIMIT :limit
  `, { replacements: { limit: Math.min(Number(limit) || 50, 200) }, type: QueryTypes.SELECT });

  return rows
    .map((r) => {
      const tranches = Number(r.tranches) || 0;
      const accords = Number(r.accords) || 0;
      const attributions = Number(r.attributions) || 0;
      const honorees = Number(r.honorees) || 0;
      const abandonnees = Number(r.abandonnees) || 0;

      // Taux bruts : `null` quand il n'y a rien à diviser, jamais 0 — « aucun
      // dossier tranché » et « toujours à côté » ne se ressemblent pas.
      const tauxAccord = tranches > 0 ? accords / tranches : null;

      // ⚠ Le dénominateur exclut les places EN COURS. Une place encore ouverte
      // n'est ni honorée ni abandonnée : la compter contre la personne affichait
      // 0 % de fiabilité à quelqu'un qui venait tout juste de recevoir un
      // contenu et n'avait simplement pas encore eu le temps de le lire.
      const reglees = honorees + abandonnees;
      const tauxReponse = reglees > 0 ? honorees / reglees : null;

      const accordLisse = (accords + TRUST_PRIOR_VOTES * 0.5) / (tranches + TRUST_PRIOR_VOTES);
      const fiabilite = tauxReponse === null ? 0.5 : tauxReponse;
      const confiance = Math.round(
        100 * (TRUST_WEIGHT_AGREEMENT * accordLisse + TRUST_WEIGHT_RELIABILITY * fiabilite),
      );

      return {
        id: r.id,
        username: r.username,
        full_name: r.full_name,
        avatar: r.avatar,
        verified: !!r.verified,
        suspendu: !!r.is_suspended || r.is_active === false,
        votes: Number(r.votes) || 0,
        tranches,
        accords,
        desaccords: Math.max(0, tranches - accords),
        votes_violation: Number(r.votes_violation) || 0,
        votes_conforme: Number(r.votes_conforme) || 0,
        sanctions: Number(r.sanctions) || 0,
        attributions,
        honorees,
        abandonnees,
        en_cours: Number(r.en_cours) || 0,
        taux_accord: tauxAccord === null ? null : Math.round(tauxAccord * 100),
        taux_reponse: tauxReponse === null ? null : Math.round(tauxReponse * 100),
        confiance,
        niveau: trustLabel(confiance, tranches),
        /** Vrai tant que le score repose sur trop peu de dossiers pour être lu. */
        provisoire: tranches < TRUST_MIN_SETTLED,
        // Le drapeau réellement utilisé par l'attribution — affiché tel quel
        // pour que l'admin voie qui reçoit vraiment les jurys sur le point de
        // trancher, et pas seulement un score décoratif.
        prioritaire: accords >= TRUSTED_AGREEMENTS,
        premier_vote: r.premier_vote,
        dernier_vote: r.dernier_vote,
      };
    })
    // Tri final en JS : le score dépend du lissage, que SQL ne calcule pas.
    // À confiance égale, le volume tranche — c'est lui qui a fait avancer la file.
    .sort((a, b) => b.confiance - a.confiance || b.accords - a.accords || b.votes - a.votes);
}

/** Vue d'ensemble de la revue, pour l'en-tête du classement admin. */
async function reviewOverview() {
  const [row] = await sequelize.query(`
    SELECT
      (SELECT COUNT(*) FROM community_review_items WHERE status = 'open')::int                       AS ouverts,
      (SELECT COUNT(*) FROM community_review_items WHERE status = 'closed')::int                     AS clos,
      (SELECT COUNT(*) FROM community_review_items WHERE verdict::text = 'violation')::int           AS verdicts_violation,
      (SELECT COUNT(*) FROM community_review_items WHERE verdict::text = 'compliant')::int           AS verdicts_conforme,
      (SELECT COUNT(*) FROM community_review_items
        WHERE sanction IS NOT NULL AND sanction <> 'none')::int                                      AS sanctions,
      (SELECT COUNT(*) FROM community_review_items WHERE adjudication_status = 'failed')::int        AS arbitrages_repli,
      (SELECT COUNT(*) FROM community_review_votes)::int                                             AS votes,
      (SELECT COUNT(DISTINCT voter_id) FROM community_review_votes)::int                             AS jures,
      (SELECT COUNT(*) FROM community_review_assignments WHERE status = 'pending')::int              AS places_en_cours,
      (SELECT COUNT(*) FROM community_review_assignments WHERE status = 'expired')::int              AS places_abandonnees
  `, { type: QueryTypes.SELECT });
  return row || {};
}

/**
 * Compteurs de l'en-tête. Volontairement réduits à ce qui ne dit rien du
 * contenu en cours : la taille de la file et la contribution de la personne.
 * Le nombre de dossiers jugés et le seuil de décision ont disparu — ils
 * n'aidaient pas à juger, ils renseignaient sur la mécanique.
 */
async function stats(userId) {
  const [open, mine] = await Promise.all([
    CommunityReviewItem.count({ where: { status: 'open', anonymization_status: 'done' } }),
    CommunityReviewVote.count({ where: { voter_id: userId } }),
  ]);
  return { open, my_votes: mine };
}

module.exports = {
  PANEL_SIZE,
  MAJORITY,
  anonymizeText,
  anonymizeMany,
  enqueueReportedTweets,
  enqueueTweet,
  nextItemFor,
  castVote,
  stats,
  runAdjudication,
  maintenance,
  retryFailedAnonymizations,
  abandonStaleItems,
  reviewerStanding,
  jurorLeaderboard,
  reviewOverview,
};
