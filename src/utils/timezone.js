/**
 * Heures locales du lecteur.
 *
 * Le VPS est à l'heure UTC et la base aussi (`SHOW timezone` → `Etc/UTC`).
 * Tant qu'on manipule des INSTANTS, ça n'a aucune importance : un
 * `timestamptz` désigne le même moment partout. Ça en prend dès qu'on
 * manipule une HEURE DE LA JOURNÉE — « tes meilleurs créneaux sont 19 h et
 * 21 h », « publie à 8 h ». `EXTRACT(HOUR FROM created_at)` répondait alors en
 * heures UTC, soit deux de moins que l'horloge d'un créateur français l'été :
 * l'app affichait 19 h, la publication partait à 21 h, et les deux étaient
 * « justes » chacune dans son fuseau.
 *
 * Le fuseau vient donc du client (en-tête `X-Timezone`, un nom IANA), jamais
 * du serveur. C'est le seul endroit où il est connu, et il suit l'utilisateur
 * quand il voyage.
 */

const DEFAULT_TIME_ZONE = 'UTC';

/**
 * Valide un nom de fuseau en le soumettant à `Intl` : seule la base de
 * données ICU du système connaît la liste complète, et elle évolue.
 */
function isValidTimeZone(name) {
  if (!name || typeof name !== 'string' || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fuseau du client pour cette requête, ou UTC.
 *
 * Le repli sur UTC est délibéré : il reproduit exactement le comportement
 * d'avant pour un client qui n'envoie pas l'en-tête, sans jamais inventer un
 * fuseau à sa place (deviner « Europe/Paris » donnerait des heures fausses
 * mais crédibles à tous les autres, ce qui est pire qu'un décalage assumé).
 */
function resolveTimeZone(req) {
  const header = (typeof req?.get === 'function' ? req.get('X-Timezone') : null)
    || req?.headers?.['x-timezone']
    || null;
  const name = String(header || '').trim();
  return isValidTimeZone(name) ? name : DEFAULT_TIME_ZONE;
}

/**
 * Fragment SQL donnant l'heure locale (0-23) d'une colonne `timestamptz`.
 *
 * Le fuseau passe en paramètre lié (`:timeZone`), jamais interpolé.
 */
function hourInZoneSql(column, param = 'timeZone') {
  return `EXTRACT(HOUR FROM (${column} AT TIME ZONE :${param}))::int`;
}

const PART_KEYS = ['year', 'month', 'day', 'hour', 'minute', 'second'];

function zonedParts(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = {};
  for (const part of formatter.formatToParts(instant)) {
    if (PART_KEYS.includes(part.type)) parts[part.type] = parseInt(part.value, 10);
  }
  // `hour12: false` rend minuit tantôt « 00 » tantôt « 24 » selon les
  // versions d'ICU. Les deux désignent le même instant ; on normalise.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

/** Décalage du fuseau à cet instant précis, en millisecondes (heure d'été comprise). */
function zoneOffsetMs(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Les millisecondes ne sont pas rendues par `formatToParts` : on les
  // retire des deux côtés pour ne mesurer que le décalage.
  return asIfUtc - (instant.getTime() - instant.getMilliseconds());
}

/**
 * Instant correspondant à `hour:00` LOCALE dans `timeZone`, le jour local de
 * `from` décalé de `dayOffset` jours.
 *
 * Deux passes : le décalage à appliquer dépend de l'instant qu'on cherche
 * (heure d'été), donc la première estimation sert à trouver le bon décalage,
 * la seconde le confirme. Pendant l'heure sautée du changement d'heure, la
 * date visée n'existe pas localement — on rend alors l'instant obtenu, qui
 * tombe juste après le saut, plutôt que rien.
 */
function instantForZonedHour(from, hour, timeZone, dayOffset = 0) {
  const base = zonedParts(from instanceof Date ? from : new Date(from), timeZone);
  const wallClock = Date.UTC(base.year, base.month - 1, base.day + dayOffset, hour, 0, 0);

  const firstGuess = new Date(wallClock - zoneOffsetMs(new Date(wallClock), timeZone));
  const settled = new Date(wallClock - zoneOffsetMs(firstGuess, timeZone));
  return settled;
}

module.exports = {
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
  resolveTimeZone,
  hourInZoneSql,
  zoneOffsetMs,
  instantForZonedHour,
};
