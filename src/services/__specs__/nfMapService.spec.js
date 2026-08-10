'use strict';

/**
 * Une carte de gens est une base de données de déplacements. Ce qui est testé
 * ici n'est donc pas « la carte marche », mais « la carte ne dit pas plus que
 * ce que son propriétaire a accepté de dire ».
 */

const { positionForMode, CITY_GRID_DEGREES } = require('../nfMapService');

// Un point précis quelque part dans Paris.
const LAT = 48.856614;
const LON = 2.352222;

describe('nfMapService — ce qui est réellement stocké', () => {
  test('le mode fantôme ne stocke rien du tout', () => {
    expect(positionForMode('ghost', LAT, LON)).toBeNull();
  });

  test('le mode précis garde le point tel quel', () => {
    expect(positionForMode('precise', LAT, LON)).toEqual({
      latitude: 48.856614,
      longitude: 2.352222,
    });
  });

  test('le mode ville arrondit AVANT écriture : le point exact n’entre pas en base', () => {
    const stored = positionForMode('city', LAT, LON);

    // Multiple de la maille, testé par division : un modulo en virgule
    // flottante rend 0,0499… au lieu de 0 et ne prouverait rien.
    const isOnGrid = (value) => {
      const steps = value / CITY_GRID_DEGREES;
      return Math.abs(steps - Math.round(steps)) < 1e-6;
    };

    expect(stored.latitude).not.toBe(LAT);
    expect(stored.longitude).not.toBe(LON);
    expect(isOnGrid(stored.latitude)).toBe(true);
    expect(isOnGrid(stored.longitude)).toBe(true);
  });

  test('l’arrondi reste dans un rayon d’agglomération, pas d’une rue', () => {
    const stored = positionForMode('city', LAT, LON);
    // Une demi-maille au maximum, soit ~2,8 km en latitude.
    expect(Math.abs(stored.latitude - LAT)).toBeLessThanOrEqual(CITY_GRID_DEGREES / 2);
    expect(Math.abs(stored.longitude - LON)).toBeLessThanOrEqual(CITY_GRID_DEGREES / 2);
    expect(Math.abs(stored.latitude - LAT)).toBeGreaterThan(0);
  });

  /**
   * Le point le plus important du mode ville. Un bruit aléatoire se moyenne :
   * en recoupant quelques envois successifs depuis le même endroit, on
   * retrouverait le point exact. Un arrondi déterministe, non.
   */
  test('deux envois depuis le même endroit donnent EXACTEMENT le même point', () => {
    const first = positionForMode('city', LAT, LON);
    const second = positionForMode('city', LAT, LON);
    expect(second).toEqual(first);
  });

  test('un déplacement de quelques rues ne bouge pas le point affiché', () => {
    const here = positionForMode('city', 48.8566, 2.3522);
    const twoStreetsAway = positionForMode('city', 48.8571, 2.3529);
    expect(twoStreetsAway).toEqual(here);
  });

  test('une coordonnée hors bornes ou absente ne stocke rien', () => {
    expect(positionForMode('precise', 91, 0)).toBeNull();
    expect(positionForMode('precise', 0, 181)).toBeNull();
    expect(positionForMode('precise', NaN, 2)).toBeNull();
    expect(positionForMode('city', undefined, undefined)).toBeNull();
  });
});
