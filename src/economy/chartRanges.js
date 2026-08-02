'use strict';

/**
 * Intervalles de graphique partagés entre les stats NF (`priceHistory`,
 * filtré par âge réel des entrées — voir metrics.js) et le détail des
 * monnaies communautaires (`priceSeries`, reconstruit depuis les échanges
 * avec un bucket adapté à la fenêtre — voir userCurrency.js).
 *
 * `truncUnit` est le paramètre de `date_trunc()` (Postgres) : plus la fenêtre
 * est courte, plus fine est la granularité, sinon "30 jours" donnerait 30
 * points de résolution horaire (illisible) et "1 heure" un seul point de
 * résolution journalière (vide).
 */
const CHART_RANGES = {
  '1h': { hours: 1, truncUnit: 'minute' },
  '24h': { hours: 24, truncUnit: 'hour' },
  '7d': { hours: 24 * 7, truncUnit: 'hour' },
  '30d': { hours: 24 * 30, truncUnit: 'day' }
};

const DEFAULT_RANGE = '30d';

function resolveChartRange(range) {
  return CHART_RANGES[range] ? range : DEFAULT_RANGE;
}

module.exports = { CHART_RANGES, DEFAULT_RANGE, resolveChartRange };
