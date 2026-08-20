'use strict';

/**
 * Les bornes de période décident de QUELS événements sont payés. Un lundi mal
 * placé fait compter deux fois un dimanche soir, ou le perd — dans les deux
 * cas silencieusement, puisque le montant reste plausible.
 *
 * Tout est calé sur UTC et jamais sur le fuseau du process : le worker qui
 * clôture peut redémarrer sur une machine réglée autrement.
 */

const period = require('../period');

const iso = (d) => d.toISOString();

describe('weekStart', () => {
  test('un jeudi recule au lundi de la même semaine', () => {
    // 2026-08-20 est un jeudi.
    expect(iso(period.weekStart(new Date('2026-08-20T12:00:00Z'))))
      .toBe('2026-08-17T00:00:00.000Z');
  });

  test('un lundi est son propre début de semaine', () => {
    expect(iso(period.weekStart(new Date('2026-08-17T00:00:00Z'))))
      .toBe('2026-08-17T00:00:00.000Z');
  });

  test('un dimanche appartient encore à la semaine qui s\'achève', () => {
    // Le piège classique : `getUTCDay()` vaut 0 le dimanche, donc un calcul
    // naïf le renverrait au lundi SUIVANT.
    expect(iso(period.weekStart(new Date('2026-08-23T23:59:59Z'))))
      .toBe('2026-08-17T00:00:00.000Z');
  });

  test('la dernière milliseconde du dimanche reste dans sa semaine', () => {
    expect(iso(period.weekStart(new Date('2026-08-23T23:59:59.999Z'))))
      .toBe('2026-08-17T00:00:00.000Z');
  });
});

describe('bornes de période', () => {
  test('la période est semi-ouverte et dure exactement sept jours', () => {
    const p = period.currentPeriod(new Date('2026-08-20T12:00:00Z'));
    expect(iso(p.start)).toBe('2026-08-17T00:00:00.000Z');
    expect(iso(p.end)).toBe('2026-08-24T00:00:00.000Z');
    expect(p.end - p.start).toBe(7 * 24 * 3600 * 1000);
  });

  test('deux périodes consécutives se touchent sans se recouvrir', () => {
    const now = new Date('2026-08-20T12:00:00Z');
    const courante = period.currentPeriod(now);
    const precedente = period.lastClosedPeriod(now);
    // Aucun trou, aucun recouvrement : un événement appartient à une seule
    // période, sans arbitrage à la milliseconde.
    expect(iso(precedente.end)).toBe(iso(courante.start));
  });

  test('la dernière période close est bien terminée', () => {
    const now = new Date('2026-08-20T12:00:00Z');
    expect(period.lastClosedPeriod(now).end.getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

describe('clés de période', () => {
  test('la clé est triable alphabétiquement dans l\'ordre chronologique', () => {
    const a = period.currentPeriod(new Date('2026-08-20T12:00:00Z')).key;
    const b = period.currentPeriod(new Date('2026-08-27T12:00:00Z')).key;
    expect(a < b).toBe(true);
  });

  test('la clé fait l\'aller-retour sans perte', () => {
    const p = period.currentPeriod(new Date('2026-08-20T12:00:00Z'));
    const retour = period.fromKey(p.key);
    expect(iso(retour.start)).toBe(iso(p.start));
    expect(iso(retour.end)).toBe(iso(p.end));
    expect(retour.key).toBe(p.key);
  });

  test('l\'aller-retour tient sur une année entière, semaine après semaine', () => {
    let d = new Date('2026-01-01T12:00:00Z');
    for (let i = 0; i < 60; i += 1) {
      const p = period.currentPeriod(d);
      expect(period.fromKey(p.key).start.getTime()).toBe(p.start.getTime());
      d = new Date(d.getTime() + 7 * 24 * 3600 * 1000);
    }
  });

  test('une clé mal formée est refusée plutôt que devinée', () => {
    expect(period.fromKey('n\'importe quoi')).toBeNull();
    expect(period.fromKey('2026-W00')).toBeNull();
    expect(period.fromKey('2026-W54')).toBeNull();
    expect(period.fromKey(null)).toBeNull();
  });
});
