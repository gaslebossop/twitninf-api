const {
  pickSlots,
  foldRows,
  buildSlots,
  hourDistance,
  MIN_EVENTS_FOR_PERSONAL,
} = require('../activityProfileService');

describe('hourDistance', () => {
  it('mesure la distance en passant par minuit', () => {
    // Le piège de tout histogramme horaire : 23 h et 1 h sont voisines, pas
    // à 22 heures l'une de l'autre.
    expect(hourDistance(23, 1)).toBe(2);
    expect(hourDistance(1, 23)).toBe(2);
    expect(hourDistance(0, 12)).toBe(12);
    expect(hourDistance(9, 9)).toBe(0);
  });
});

describe('pickSlots', () => {
  it('retient les deux heures les plus fortes', () => {
    const slots = pickSlots({ 9: 5, 14: 40, 20: 30, 23: 2 });
    expect(slots).toEqual([14, 20]);
  });

  it('écarte une seconde heure trop proche de la première', () => {
    // 15 h est le deuxième poids, mais coller deux relances à une heure
    // d'intervalle les ferait tomber dans la même session.
    const slots = pickSlots({ 14: 40, 15: 38, 21: 20 });
    expect(slots).toEqual([14, 21]);
  });

  it('applique l écart en tenant compte de minuit', () => {
    const slots = pickSlots({ 23: 40, 1: 38, 13: 30 });
    expect(slots).toEqual([23, 13]);
  });

  it('rend une seule heure quand rien d autre n est assez loin', () => {
    expect(pickSlots({ 12: 10, 13: 9, 14: 8 })).toEqual([12]);
  });

  it('rend une liste vide sur un histogramme vide', () => {
    expect(pickSlots({})).toEqual([]);
    expect(pickSlots(null)).toEqual([]);
  });

  it('ignore les heures de poids nul', () => {
    expect(pickSlots({ 3: 0, 17: 12 })).toEqual([17]);
  });
});

describe('foldRows', () => {
  it('range les lignes par utilisateur et par régime', () => {
    const folded = foldRows([
      { user_id: 'a', regime: 'weekday', hour: 14, events: 10 },
      { user_id: 'a', regime: 'weekend', hour: 2, events: 4 },
      { user_id: 'b', regime: 'weekday', hour: 9, events: 7 },
    ]);

    expect(folded.get('a')).toEqual({ weekday: { 14: 10 }, weekend: { 2: 4 }, total: 14 });
    expect(folded.get('b').total).toBe(7);
  });

  it('traite un régime inconnu comme de la semaine', () => {
    const folded = foldRows([{ user_id: 'a', regime: 'nimporte', hour: 8, events: 3 }]);
    expect(folded.get('a').weekday).toEqual({ 8: 3 });
  });

  it('accepte une entrée vide', () => {
    expect(foldRows([]).size).toBe(0);
    expect(foldRows(null).size).toBe(0);
  });
});

describe('buildSlots', () => {
  const globalSlots = { weekday: [19, 13], weekend: [16, 23] };

  it('sert le global quand la personne n a pas assez d événements', () => {
    const built = buildSlots({ weekday: { 14: 5 }, weekend: {}, total: 5 }, globalSlots);
    expect(built.source).toBe('global');
    expect(built.slots).toEqual(globalSlots);
    expect(built.sampleEvents).toBe(5);
  });

  it('sert le global quand la personne est inconnue', () => {
    const built = buildSlots(undefined, globalSlots);
    expect(built.source).toBe('global');
    expect(built.sampleEvents).toBe(0);
  });

  it('apprend dès le seuil atteint', () => {
    const personal = {
      weekday: { 14: MIN_EVENTS_FOR_PERSONAL, 21: 10 },
      weekend: { 2: 8 },
      total: MIN_EVENTS_FOR_PERSONAL + 18,
    };
    const built = buildSlots(personal, globalSlots);
    expect(built.source).toBe('personal');
    expect(built.slots.weekday).toEqual([14, 21]);
    expect(built.slots.weekend).toEqual([2]);
  });

  it('complète un régime vide par le global sans perdre l autre', () => {
    // Quelqu'un qui n ouvre l app qu en semaine garde ses créneaux appris de
    // semaine, et reçoit les créneaux globaux le week-end.
    const personal = { weekday: { 14: 60 }, weekend: {}, total: 60 };
    const built = buildSlots(personal, globalSlots);
    expect(built.slots.weekday).toEqual([14]);
    expect(built.slots.weekend).toEqual(globalSlots.weekend);
    expect(built.source).toBe('personal');
  });
});
