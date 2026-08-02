/**
 * Taxonomie des signalements — source de vérité partagée API / mobile / Windows.
 *
 * Pourquoi une taxonomie plutôt que du texte libre : avec `reason` en TEXT,
 * deux signalements du même abus sont deux chaînes différentes. Impossible
 * d'agréger, de router vers le bon modérateur, ou de déclencher quoi que ce
 * soit automatiquement. Une catégorie ferme rend tout ça calculable.
 *
 * `severity` n'est PLUS choisie par le signaleur (il pouvait s'auto-attribuer
 * « critical »). Elle découle de la catégorie, puis est ajustée côté serveur
 * par la fiabilité du signaleur et le nombre de signaleurs distincts.
 */

const REPORT_CATEGORIES = {
  spam: {
    label: 'Spam ou arnaque',
    description: 'Publicité répétée, faux concours, lien frauduleux',
    baseSeverity: 'low',
    basePriority: 1,
    weight: 0.6,
    targets: ['tweet', 'user', 'comment'],
  },
  harassment: {
    label: 'Harcèlement ou intimidation',
    description: 'Attaques répétées, menaces visant une personne',
    baseSeverity: 'high',
    basePriority: 3,
    weight: 1.4,
    targets: ['tweet', 'user', 'comment'],
  },
  hate_speech: {
    label: 'Haine ou discrimination',
    description: 'Propos visant une origine, une religion, une orientation, un handicap',
    baseSeverity: 'high',
    basePriority: 4,
    weight: 1.6,
    targets: ['tweet', 'user', 'comment'],
  },
  violence: {
    label: 'Violence ou menaces',
    description: 'Menace de violence, apologie ou incitation',
    baseSeverity: 'critical',
    basePriority: 5,
    weight: 2.0,
    targets: ['tweet', 'user', 'comment'],
  },
  sexual_content: {
    label: 'Contenu sexuel non sollicité',
    description: 'Nudité ou contenu sexuel non signalé comme sensible',
    baseSeverity: 'high',
    basePriority: 4,
    weight: 1.5,
    targets: ['tweet', 'user', 'comment'],
  },
  child_safety: {
    label: 'Mise en danger d\'un mineur',
    description: 'Contenu impliquant ou visant un mineur',
    baseSeverity: 'critical',
    basePriority: 5,
    weight: 3.0,
    alwaysEscalate: true, // un seul signalement suffit à passer en revue
    targets: ['tweet', 'user', 'comment'],
  },
  self_harm: {
    label: 'Automutilation ou suicide',
    description: 'Détresse, incitation ou apologie',
    baseSeverity: 'critical',
    basePriority: 5,
    weight: 2.0,
    alwaysEscalate: true,
    // Le signaleur reçoit des ressources d'aide plutôt qu'un simple « merci ».
    supportResources: true,
    targets: ['tweet', 'user', 'comment'],
  },
  impersonation: {
    label: 'Usurpation d\'identité',
    description: 'Se fait passer pour quelqu\'un d\'autre',
    baseSeverity: 'medium',
    basePriority: 2,
    weight: 1.1,
    targets: ['tweet', 'user'],
  },
  privacy: {
    label: 'Données personnelles exposées',
    description: 'Adresse, téléphone, documents privés publiés sans accord',
    baseSeverity: 'high',
    basePriority: 3,
    weight: 1.5,
    targets: ['tweet', 'user', 'comment'],
  },
  misinformation: {
    label: 'Fausse information',
    description: 'Information trompeuse présentée comme un fait',
    baseSeverity: 'low',
    basePriority: 1,
    weight: 0.7,
    targets: ['tweet', 'comment'],
  },
  illegal: {
    label: 'Contenu illégal',
    description: 'Vente de produits interdits, contrefaçon, piratage',
    baseSeverity: 'critical',
    basePriority: 5,
    weight: 1.8,
    targets: ['tweet', 'user', 'comment'],
  },
  other: {
    label: 'Autre',
    description: 'Ne correspond à aucune catégorie ci-dessus',
    baseSeverity: 'low',
    basePriority: 1,
    weight: 0.5,
    requiresDetails: true, // seul cas où le texte libre est obligatoire
    targets: ['tweet', 'user', 'comment'],
  },
};

const CATEGORY_KEYS = Object.keys(REPORT_CATEGORIES);

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

/** Catégories proposables pour un type de cible donné, prêtes pour un client. */
function categoriesFor(targetType) {
  return CATEGORY_KEYS
    .filter((k) => REPORT_CATEGORIES[k].targets.includes(targetType))
    .map((k) => ({
      key: k,
      label: REPORT_CATEGORIES[k].label,
      description: REPORT_CATEGORIES[k].description,
      requiresDetails: !!REPORT_CATEGORIES[k].requiresDetails,
      supportResources: !!REPORT_CATEGORIES[k].supportResources,
    }));
}

const isValidCategory = (k) => Object.prototype.hasOwnProperty.call(REPORT_CATEGORIES, k);

/** Monte d'un cran dans l'échelle de sévérité, sans dépasser `critical`. */
function bumpSeverity(severity, steps = 1) {
  const i = SEVERITY_ORDER.indexOf(severity);
  if (i < 0) return severity;
  return SEVERITY_ORDER[Math.min(SEVERITY_ORDER.length - 1, i + steps)];
}

const maxSeverity = (a, b) =>
  (SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b);

module.exports = {
  REPORT_CATEGORIES,
  CATEGORY_KEYS,
  SEVERITY_ORDER,
  categoriesFor,
  isValidCategory,
  bumpSeverity,
  maxSeverity,
};
