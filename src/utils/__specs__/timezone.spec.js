'use strict';

/**
 * Le calcul d'heure locale est la seule pièce du code où une erreur de deux
 * heures passe totalement inaperçue en développement : la machine du
 * développeur est à Paris, le VPS à UTC, et les deux donnent des résultats
 * « cohérents » chacun de leur côté. D'où ces tests, tous ancrés sur des
 * instants réels et sur les deux régimes horaires de l'année.
 */

const {
  isValidTimeZone,
  resolveTimeZone,
  hourInZoneSql,
  zoneOffsetMs,
  instantForZonedHour,
  DEFAULT_TIME_ZONE,
} = require('../timezone');

const PARIS = 'Europe/Paris';

describe('resolveTimeZone', () => {
  test('lit l\'en-tête X-Timezone', () => {
    const req = { get: (name) => (name === 'X-Timezone' ? PARIS : null) };
    expect(resolveTimeZone(req)).toBe(PARIS);
  });

  test('accepte aussi req.headers en minuscules', () => {
    expect(resolveTimeZone({ headers: { 'x-timezone': 'Asia/Tokyo' } })).toBe('Asia/Tokyo');
  });

  test('retombe sur UTC quand l\'en-tête manque', () => {
    expect(resolveTimeZone({ headers: {} })).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
  });

  test('retombe sur UTC sur un fuseau inventé plutôt que de casser la requête', () => {
    expect(resolveTimeZone({ headers: { 'x-timezone': 'Europe/Gotham' } })).toBe(DEFAULT_TIME_ZONE);
    expect(isValidTimeZone('Europe/Gotham')).toBe(false);
  });
});

describe('hourInZoneSql', () => {
  test('passe le fuseau en paramètre lié, jamais interpolé', () => {
    expect(hourInZoneSql('t.created_at')).toBe(
      'EXTRACT(HOUR FROM (t.created_at AT TIME ZONE :timeZone))::int',
    );
  });
});

describe('zoneOffsetMs', () => {
  test('Paris est à UTC+2 en été', () => {
    expect(zoneOffsetMs(new Date('2026-08-03T12:00:00Z'), PARIS)).toBe(2 * 3600 * 1000);
  });

  test('Paris est à UTC+1 en hiver', () => {
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), PARIS)).toBe(3600 * 1000);
  });

  test('UTC n\'a aucun décalage', () => {
    expect(zoneOffsetMs(new Date('2026-08-03T12:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('instantForZonedHour', () => {
  test('21 h à Paris en été, c\'est 19 h UTC', () => {
    const from = new Date('2026-08-03T10:00:00Z');
    expect(instantForZonedHour(from, 21, PARIS).toISOString()).toBe('2026-08-03T19:00:00.000Z');
  });

  test('21 h à Paris en hiver, c\'est 20 h UTC', () => {
    const from = new Date('2026-01-15T10:00:00Z');
    expect(instantForZonedHour(from, 21, PARIS).toISOString()).toBe('2026-01-15T20:00:00.000Z');
  });

  test('le jour retenu est le jour LOCAL, pas le jour UTC', () => {
    // 23 h UTC le 3 août = 1 h du matin le 4 août à Paris : viser 9 h doit
    // donner le 4 au matin, pas le 3.
    const from = new Date('2026-08-03T23:00:00Z');
    expect(instantForZonedHour(from, 9, PARIS).toISOString()).toBe('2026-08-04T07:00:00.000Z');
  });

  test('le décalage de jours s\'applique au calendrier local', () => {
    const from = new Date('2026-08-03T10:00:00Z');
    expect(instantForZonedHour(from, 8, PARIS, 1).toISOString()).toBe('2026-08-04T06:00:00.000Z');
  });

  test('traverse le passage à l\'heure d\'hiver sans dériver', () => {
    // Le 25 octobre 2026, Paris repasse à UTC+1 à 3 h locales.
    const from = new Date('2026-10-25T10:00:00Z');
    expect(instantForZonedHour(from, 20, PARIS).toISOString()).toBe('2026-10-25T19:00:00.000Z');
  });

  test('en UTC, l\'heure demandée est l\'heure rendue', () => {
    const from = new Date('2026-08-03T10:00:00Z');
    expect(instantForZonedHour(from, 7, 'UTC').toISOString()).toBe('2026-08-03T07:00:00.000Z');
  });
});
