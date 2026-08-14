'use strict';

/**
 * Épingles de la Carte NF.
 *
 * Ce qui est testé ici n'est pas « le dessin est joli », mais les deux règles
 * dont dépend le reste :
 *
 *   1. le serveur ne va chercher une image QUE chez lui. La colonne `avatar`
 *      est une URL libre — le modèle `User` ne valide que sa forme. La suivre
 *      depuis le serveur offrirait à n'importe quel compte une requête sortante
 *      émise par notre infrastructure, vers l'adresse de son choix ;
 *   2. la géométrie ne dérive pas. Les ancrages sont recopiés dans l'app
 *      (`src/utils/mapPinUrl.ts`) : un marqueur ancré au mauvais endroit
 *      désigne quelqu'un à côté de là où il est.
 */

jest.mock('../../utils/publicMediaOrigin', () => ({
  getPublicMediaOrigin: () => 'https://media.twitninf.test',
}));
jest.mock('../../utils/logger', () => ({ warn: jest.fn(), error: jest.fn() }));

const { PIN, CLUSTER, isOwnMediaUrl, clampDensity, escapeXml } = require('../nfMapPinService');

describe('nfMapPinService — quelles images le serveur accepte d’aller chercher', () => {
  test('une image servie par cette API est chargée', () => {
    expect(isOwnMediaUrl('https://media.twitninf.test/static/avatars/a.jpg')).toBe(true);
  });

  test('une image hébergée ailleurs ne l’est pas', () => {
    // Le cas ordinaire : l'avatar par défaut, hébergé chez un tiers.
    expect(isOwnMediaUrl('https://static.vecteezy.com/system/resources/x.jpg')).toBe(false);
  });

  test('une adresse interne n’est jamais suivie', () => {
    // Le cas qui compte : un compte qui pointerait son avatar sur le service
    // de métadonnées de l'hébergeur pour le faire lire par le serveur.
    expect(isOwnMediaUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isOwnMediaUrl('http://localhost:5432/')).toBe(false);
    expect(isOwnMediaUrl('http://10.0.0.5/interne')).toBe(false);
  });

  test('un schéma qui n’est pas HTTP est refusé', () => {
    expect(isOwnMediaUrl('file:///etc/passwd')).toBe(false);
    expect(isOwnMediaUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isOwnMediaUrl('ftp://media.twitninf.test/a.jpg')).toBe(false);
  });

  test('une valeur vide ou illisible ne fait pas d’exception', () => {
    for (const value of [null, undefined, '', 'pas une url', 42, {}]) {
      expect(isOwnMediaUrl(value)).toBe(false);
    }
  });
});

describe('nfMapPinService — géométrie', () => {
  test('l’épingle pointe par sa POINTE, pas par le bas de l’image', () => {
    // Sous la pointe il reste l'étiquette du pseudo : ancrer en bas décalerait
    // tout le monde vers le nord de la hauteur de son étiquette.
    expect(PIN.anchorY).toBeLessThan(1);
    expect(PIN.anchorY).toBeCloseTo((PIN.ring + PIN.tip) / PIN.height, 6);
  });

  test('les ancrages restent ceux que l’app recopie', () => {
    // ⚠️ Doivent rester égaux à PIN_ANCHOR_Y / CLUSTER_ANCHOR_Y dans
    // `src/utils/mapPinUrl.ts`. Ce test est le garde-fou de cette copie.
    expect(Number(PIN.anchorY.toFixed(4))).toBe(0.7297);
    expect(Number(CLUSTER.anchorY.toFixed(4))).toBe(0.6667);
  });

  test('un groupe se centre sur les siens, il n’a pas de pointe', () => {
    expect(CLUSTER.anchorY).toBeCloseTo(CLUSTER.face / CLUSTER.height, 6);
  });
});

describe('nfMapPinService — densité demandée par l’app', () => {
  test('une densité plausible est respectée', () => {
    expect(clampDensity(3)).toBe(3);
    expect(clampDensity('2')).toBe(2);
  });

  test('une densité absurde ne fabrique pas une image démesurée', () => {
    // Sans plafond, `?d=9999` demanderait une image de plusieurs gigapixels :
    // la route est publique, ce serait une panne à une requête.
    expect(clampDensity(9999)).toBe(4);
    expect(clampDensity(0)).toBe(1);
    expect(clampDensity(-5)).toBe(1);
    expect(clampDensity('abc')).toBe(2);
    expect(clampDensity(undefined)).toBe(2);
  });
});

describe('nfMapPinService — le pseudo entre dans du XML', () => {
  test('les caractères qui casseraient le SVG sont échappés', () => {
    // Un pseudo n'est pas du balisage : sans ça, il romprait le document — et
    // le rendu échouerait, ou pire, il l'étendrait.
    expect(escapeXml('<script>')).toBe('&lt;script&gt;');
    expect(escapeXml('a & b')).toBe('a &amp; b');
    expect(escapeXml('"x"')).toBe('&quot;x&quot;');
    expect(escapeXml(null)).toBe('');
  });
});
