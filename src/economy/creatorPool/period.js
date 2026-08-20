/**
 * Découpage du temps pour le pot créateur : la semaine ISO, en UTC.
 *
 * Tout est calé sur UTC et jamais sur le fuseau du process. Le worker qui
 * clôture peut redémarrer sur une machine réglée autrement (voir SCALING.md,
 * deux VPS) ; une période dont les bornes dépendent de `TZ` produirait deux
 * clôtures qui ne couvrent pas la même semaine, donc des signaux comptés deux
 * fois ou jamais.
 *
 * Convention : la période `2026-W34` est l'intervalle **semi-ouvert**
 * `[lundi 00:00:00 UTC, lundi suivant 00:00:00 UTC)`. Semi-ouvert et pas
 * fermé : un événement à 23:59:59.500 le dimanche appartient à une seule
 * période, sans arbitrage à la milliseconde.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Lundi 00:00:00.000 UTC de la semaine contenant `date`. */
function weekStart(date = new Date()) {
  const d = new Date(date);
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // getUTCDay(): 0 = dimanche. On veut lundi comme premier jour, donc
  // dimanche recule de 6 jours et non de 0.
  const dayOfWeek = new Date(utc).getUTCDay();
  const backToMonday = (dayOfWeek + 6) % 7;
  return new Date(utc - backToMonday * DAY_MS);
}

/** Borne haute EXCLUE de la période commençant à `start`. */
function periodEnd(start) {
  return new Date(start.getTime() + WEEK_MS);
}

/**
 * Étiquette lisible et triable d'une période — `2026-W34`.
 *
 * Numérotation ISO 8601 : la semaine 1 est celle qui contient le premier
 * jeudi de l'année. C'est ce qui évite qu'un 1er janvier tombant un dimanche
 * fabrique une « semaine 1 » d'un seul jour.
 */
function periodKey(start) {
  const d = new Date(start.getTime());
  // Jeudi de la même semaine : son année EST l'année ISO de la semaine.
  d.setUTCDate(d.getUTCDate() + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekMonday = weekStart(firstThursday);
  const week = Math.round((start.getTime() - firstWeekMonday.getTime()) / WEEK_MS) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Période complète et close la plus récente à l'instant `now`. */
function lastClosedPeriod(now = new Date()) {
  const currentStart = weekStart(now);
  const start = new Date(currentStart.getTime() - WEEK_MS);
  return describe(start);
}

/** Période en cours à l'instant `now` — jamais versée, seulement projetée. */
function currentPeriod(now = new Date()) {
  return describe(weekStart(now));
}

function describe(start) {
  const end = periodEnd(start);
  return { key: periodKey(start), start, end };
}

/** Période dont `start` est le lundi, à partir d'une clé `2026-W34`. */
function fromKey(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const isoYear = parseInt(m[1], 10);
  const week = parseInt(m[2], 10);
  if (week < 1 || week > 53) return null;
  const firstWeekMonday = weekStart(new Date(Date.UTC(isoYear, 0, 4)));
  const start = new Date(firstWeekMonday.getTime() + (week - 1) * WEEK_MS);
  return describe(start);
}

module.exports = {
  DAY_MS,
  WEEK_MS,
  weekStart,
  periodEnd,
  periodKey,
  lastClosedPeriod,
  currentPeriod,
  fromKey,
};
