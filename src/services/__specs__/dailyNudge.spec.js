const { slotIsDue, excerpt, parisNow } = require('../dailyNudgeService');

describe('slotIsDue', () => {
  const slots = { weekday: [14, 21], weekend: [16, 23] };

  it('déclenche sur l heure de semaine', () => {
    expect(slotIsDue(slots, { hour: 14, minute: 0, isWeekend: false })).toBe(true);
    expect(slotIsDue(slots, { hour: 21, minute: 45, isWeekend: false })).toBe(true);
  });

  it('ne déclenche pas hors créneau', () => {
    expect(slotIsDue(slots, { hour: 15, minute: 0, isWeekend: false })).toBe(false);
  });

  it('choisit le bon régime', () => {
    // 16 h est un créneau de week-end : en semaine il ne doit rien déclencher,
    // et inversement pour 14 h.
    expect(slotIsDue(slots, { hour: 16, minute: 0, isWeekend: false })).toBe(false);
    expect(slotIsDue(slots, { hour: 16, minute: 0, isWeekend: true })).toBe(true);
    expect(slotIsDue(slots, { hour: 14, minute: 0, isWeekend: true })).toBe(false);
  });

  it('tolère un tour de cron manqué dans l heure', () => {
    // Le planificateur passe au quart d heure ; un worker redémarré à 14h02
    // doit encore pouvoir relancer à 14h45.
    expect(slotIsDue(slots, { hour: 14, minute: 59, isWeekend: false })).toBe(true);
  });

  it('ne casse pas sur des créneaux absents', () => {
    expect(slotIsDue(null, { hour: 14, minute: 0, isWeekend: false })).toBe(false);
    expect(slotIsDue({}, { hour: 14, minute: 0, isWeekend: false })).toBe(false);
    expect(slotIsDue({ weekday: [] }, { hour: 14, minute: 0, isWeekend: false })).toBe(false);
  });
});

describe('excerpt', () => {
  it('laisse un texte court intact, sans ellipse', () => {
    expect(excerpt('Un tweet court')).toBe('Un tweet court');
  });

  it('écrase les espaces et les retours à la ligne', () => {
    expect(excerpt('deux   lignes\n\nrecollées')).toBe('deux lignes recollées');
  });

  it('coupe sur un mot et ajoute l ellipse', () => {
    const long = `${'mot '.repeat(60)}fin`;
    const out = excerpt(long, 40);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
    // La coupure ne doit pas laisser un mot tronqué au milieu.
    expect(out).not.toMatch(/\s$/);
  });

  it('rend une chaîne vide sur un contenu absent', () => {
    // C est ce cas qui fait renoncer à l envoi : un tweet sans texte ne
    // donne aucune accroche lisible.
    expect(excerpt(null)).toBe('');
    expect(excerpt('   ')).toBe('');
  });
});

describe('parisNow', () => {
  it('lit l heure dans le fuseau des utilisateurs, pas celui du process', () => {
    // 2026-08-30 est en heure d été : Paris est à UTC+2.
    const clock = parisNow(new Date('2026-08-30T22:30:00Z'));
    expect(clock.hour).toBe(0);
    expect(clock.day).toBe('2026-08-31');
  });

  it('reconnaît le week-end', () => {
    // 2026-08-30 est un dimanche, le 31 un lundi.
    expect(parisNow(new Date('2026-08-30T12:00:00Z')).isWeekend).toBe(true);
    expect(parisNow(new Date('2026-08-31T12:00:00Z')).isWeekend).toBe(false);
  });

  it('reste juste en heure d hiver', () => {
    // Décembre : Paris repasse à UTC+1, l heure lue doit suivre.
    const clock = parisNow(new Date('2026-12-15T22:30:00Z'));
    expect(clock.hour).toBe(23);
    expect(clock.day).toBe('2026-12-15');
  });
});
