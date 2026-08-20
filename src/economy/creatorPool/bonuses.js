/**
 * Récompenses supplémentaires du pot créateur.
 *
 * Une récompense est un **multiplicateur de poids**, appliqué avant le
 * partage — jamais un versement en plus. La différence est tout sauf
 * cosmétique : le pot reste exactement ce qu'il était, donc une récompense ne
 * peut jamais coûter un NF de trésorerie ni faire passer la plateforme dans le
 * rouge. Ce qu'elle fait, c'est déplacer une part du gâteau vers les
 * créateurs qui remplissent la condition.
 *
 * Corollaire à garder en tête avant d'en ajouter : une récompense que tout le
 * monde obtient ne récompense personne. Les seuils sont donc relatifs au
 * vivier de la période (moyenne, centile), pas absolus.
 */

/**
 * Catalogue. Chaque entrée décide seule, à partir des mesures du créateur et
 * des statistiques du vivier.
 *
 * @property {(ctx) => boolean} earned
 * @property {(settings) => object} config
 */
const CATALOG = [
  {
    key: 'audience_revealer',
    label: 'Révélateur d\'audience',
    description: 'Ton contenu ramène nettement plus de monde sur la plateforme que la moyenne.',
    config: (s) => s.bonuses.audienceRevealer,
    earned: ({ creator, cohort, config }) => {
      if (!config.enabled) return false;
      if (cohort.averageDauRate <= 0) return false;
      return creator.dauRate >= cohort.averageDauRate * config.minRatioToAverage;
    },
    detail: ({ creator, cohort, config }) => ({
      dauRate: creator.dauRate,
      cohortAverage: cohort.averageDauRate,
      ratio: cohort.averageDauRate > 0 ? creator.dauRate / cohort.averageDauRate : 0,
      requiredRatio: config.minRatioToAverage,
    }),
  },
  {
    key: 'deep_attention',
    label: 'Attention profonde',
    description: 'Le temps réellement passé sur tes publications te place dans le haut du panier.',
    config: (s) => s.bonuses.deepAttention,
    earned: ({ percentiles, config }) => {
      if (!config.enabled) return false;
      return percentiles.attention >= config.minPercentile;
    },
    detail: ({ percentiles, config }) => ({
      percentile: percentiles.attention,
      requiredPercentile: config.minPercentile,
    }),
  },
];

/**
 * Évalue le catalogue pour un créateur.
 *
 * Les multiplicateurs se composent (deux récompenses à +10 % et +5 % donnent
 * ×1,155). Un plafond dur les borne malgré tout : une composition
 * involontaire de futures récompenses ne doit pas pouvoir faire d'un seul
 * compte le destinataire de la moitié du pot.
 */
const MAX_TOTAL_MULTIPLIER = 1.5;

function evaluateBonuses({ creator, percentiles, cohort, settings }) {
  const earned = [];
  let multiplier = 1;

  for (const bonus of CATALOG) {
    const config = bonus.config(settings);
    if (!config) continue;
    const ctx = { creator, percentiles, cohort, config };
    if (!bonus.earned(ctx)) continue;

    multiplier *= config.multiplier;
    earned.push({
      key: bonus.key,
      label: bonus.label,
      description: bonus.description,
      multiplier: config.multiplier,
      detail: bonus.detail ? bonus.detail(ctx) : null,
    });
  }

  return {
    multiplier: Math.min(MAX_TOTAL_MULTIPLIER, multiplier),
    capped: multiplier > MAX_TOTAL_MULTIPLIER,
    earned,
  };
}

/** Catalogue lisible par l'app, pour montrer ce qui reste à décrocher. */
function describeCatalog(settings) {
  return CATALOG.map((b) => {
    const config = b.config(settings) || {};
    return {
      key: b.key,
      label: b.label,
      description: b.description,
      multiplier: config.multiplier ?? 1,
      enabled: config.enabled !== false,
    };
  });
}

module.exports = { CATALOG, MAX_TOTAL_MULTIPLIER, evaluateBonuses, describeCatalog };
