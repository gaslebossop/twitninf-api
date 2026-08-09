/**
 * Finalites de traitement soumises a l'accord de la personne, et socle
 * contractuel qu'elle doit accepter pour ouvrir un compte.
 *
 * Source de verite UNIQUE : les clients (mobile, Windows) recuperent cette
 * liste par l'API et n'en gardent aucune copie codee en dur. Un texte qui
 * change ici, ou une finalite ajoutee, se propage donc partout sans nouvelle
 * version d'application.
 *
 * Deux categories, et la distinction n'est pas cosmetique :
 *
 * - `required` : base legale contractuelle (art. 6.1.b RGPD) et verification
 *   de l'age. Sans cela le service ne peut pas etre fourni, donc le refus
 *   ferme l'acces — c'est le seul cas ou un refus bloque.
 * - `optional` : base legale du consentement (art. 6.1.a). Chaque finalite a
 *   sa propre case, refusable separement, et l'application fonctionne
 *   entierement sans. Un consentement groupe « tout ou rien » ne serait pas
 *   valide (art. 7.4 et considerant 43) : c'est exactement ce que la CNIL
 *   sanctionne sous le nom de consentement force.
 *
 * Le retrait doit etre aussi simple que l'accord (art. 7.3) : les finalites
 * optionnelles sont donc modifiables a tout moment dans les reglages, par le
 * meme endpoint que l'acceptation initiale.
 */

/**
 * Version du socle. A INCREMENTER des qu'une finalite est ajoutee, retiree, ou
 * que la portee d'un traitement change : les comptes ayant accepte une version
 * anterieure sont alors reinterroges automatiquement, ce qui est l'unique
 * facon de garder un consentement a jour et prouvable.
 *
 * Ne PAS l'incrementer pour une correction de formulation sans effet sur la
 * portee : cela relancerait la popup a tout le monde pour rien.
 */
const CONSENT_VERSION = '2026-08-09';

// Les documents contractuels portent leur propre version. Les deux doivent
// coincider : un accord enregistre doit designer un texte precis, sinon la
// preuve ne vaut rien. Un test verrouille cette egalite.
const { DOCUMENT_VERSION } = require('../legal/documents');

/**
 * Age minimum. 15 ans est l'age du consentement numerique en France
 * (art. 45 loi Informatique et Libertes, plancher ouvert aux Etats membres par
 * l'art. 8 RGPD, qui laisse le choix entre 13 et 16 ans).
 */
const MINIMUM_AGE = 15;

const REQUIRED_PURPOSES = [
  {
    key: 'terms',
    title: "Conditions generales d'utilisation",
    summary:
      "Les regles d'usage du service : ce que tu peux publier, ce qui est interdit, et comment un compte peut etre restreint.",
    legalBasis: 'contract',
    // Chemin RELATIF : chaque client le resout contre sa propre URL d'API. Une
    // URL absolue codee ici casserait le developpement local et un eventuel
    // changement de domaine.
    documentPath: '/legal/cgu',
  },
  {
    key: 'privacy',
    title: 'Politique de confidentialite',
    summary:
      "Quelles donnees TwitNinf traite, pourquoi, combien de temps il les garde, avec qui il les partage, et comment exercer tes droits d'acces, de rectification, d'effacement, de portabilite et d'opposition.",
    legalBasis: 'contract',
    documentPath: '/legal/confidentialite',
  },
  {
    key: 'age',
    title: `J'ai au moins ${MINIMUM_AGE} ans`,
    summary:
      `En dessous de ${MINIMUM_AGE} ans, l'accord d'un titulaire de l'autorite parentale est necessaire et le compte ne peut pas etre ouvert seul.`,
    legalBasis: 'legal_obligation',
  },
];

const OPTIONAL_PURPOSES = [
  {
    key: 'personalization',
    title: 'Personnalisation du fil',
    summary:
      "Utiliser ce que tu lis, aimes et ignores pour ordonner ton fil. Si tu refuses, le fil reste chronologique et recent.",
    legalBasis: 'consent',
  },
  {
    key: 'audience_analytics',
    title: "Statistiques d'audience pour les createurs",
    summary:
      "Compter ta vue dans les statistiques agregees des comptes que tu consultes. Les createurs ne voient jamais que des groupes d'au moins 5 personnes, jamais toi individuellement.",
    legalBasis: 'consent',
  },
  {
    key: 'marketing_push',
    title: 'Notifications de decouverte',
    summary:
      "Recevoir des notifications de suggestions et de nouveautes. Les notifications liees a ton compte (reponses, mentions, securite, paiements) arrivent de toute facon.",
    legalBasis: 'consent',
  },
];

/**
 * Traitements qui ne dependent PAS d'un accord et qui ne doivent donc jamais
 * apparaitre comme une case a cocher : le presenter comme un choix serait
 * mensonger, puisque le refus est impossible. Ils sont affiches comme une
 * information, ce que l'obligation de transparence exige (art. 13 RGPD).
 */
const MANDATORY_PROCESSING_NOTICES = [
  {
    key: 'moderation',
    title: 'Moderation des publications',
    summary:
      "Les contenus publies sont analyses automatiquement, puis par un humain en cas de signalement, pour appliquer la loi et les regles du service. Interet legitime et obligation legale : ce traitement ne se refuse pas, mais toute decision peut etre contestee.",
  },
  {
    key: 'private_messages',
    title: 'Messages prives',
    summary:
      "Le contenu de tes messages prives n'est PAS analyse automatiquement. La derogation europeenne en vigueur depuis le 3 aout 2026 autorise ce type d'analyse, mais elle ne l'impose pas et TwitNinf ne s'en sert pas. Un message n'est lu par une personne habilitee que s'il est signale par un participant, ou sur requisition judiciaire.",
  },
  {
    key: 'security',
    title: 'Securite et lutte contre la fraude',
    summary:
      "Les connexions et les paiements sont analyses pour detecter les intrusions et la fraude. Interet legitime : ce traitement ne se refuse pas.",
  },
  {
    key: 'legal_retention',
    title: 'Conservation legale',
    summary:
      "Certaines donnees techniques et comptables sont conservees pour la duree imposee par la loi, meme apres la suppression du compte.",
  },
];

const REQUIRED_KEYS = REQUIRED_PURPOSES.map((purpose) => purpose.key);
const OPTIONAL_KEYS = OPTIONAL_PURPOSES.map((purpose) => purpose.key);
const ALL_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];

/** Sources autorisees, pour savoir OU un accord a ete recueilli. */
const CONSENT_SOURCES = ['registration', 'startup_gate', 'settings'];

/**
 * Etat par defaut des finalites optionnelles avant toute reponse. `false` et
 * non `true` : le consentement doit resulter d'un acte positif, une case
 * precochee n'est pas un consentement (art. 4.11 et considerant 32).
 */
function defaultOptionalPreferences() {
  return OPTIONAL_KEYS.reduce((acc, key) => ({ ...acc, [key]: false }), {});
}

/**
 * Vrai si ce compte doit (re)passer par la demande d'accord : jamais repondu,
 * ou repondu sur une version anterieure du socle.
 */
function needsConsent(user) {
  if (!user) return false;
  return !user.consent_accepted_at || user.consent_version !== CONSENT_VERSION;
}

/** Descriptif complet envoye aux clients pour construire l'ecran. */
function consentManifest() {
  return {
    version: CONSENT_VERSION,
    minimum_age: MINIMUM_AGE,
    required: REQUIRED_PURPOSES,
    optional: OPTIONAL_PURPOSES,
    notices: MANDATORY_PROCESSING_NOTICES,
  };
}

module.exports = {
  CONSENT_VERSION,
  DOCUMENT_VERSION,
  MINIMUM_AGE,
  REQUIRED_PURPOSES,
  OPTIONAL_PURPOSES,
  MANDATORY_PROCESSING_NOTICES,
  REQUIRED_KEYS,
  OPTIONAL_KEYS,
  ALL_KEYS,
  CONSENT_SOURCES,
  defaultOptionalPreferences,
  needsConsent,
  consentManifest,
};
