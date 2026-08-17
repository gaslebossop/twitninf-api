/**
 * Aller-retour de l'encodeur QR à travers un vrai décodeur.
 *
 * Un code QR faux se dessine exactement comme un code QR juste. La seule
 * vérification qui vaille est donc de le relire avec un décodeur indépendant
 * (jsQR, dépendance de développement) : c'est ce que fera le téléphone à
 * l'entrée de l'événement.
 */

const jsQR = require('jsqr');
const { encodeQr, dataCapacityBits } = require('../qr');

const LEVELS = ['L', 'M', 'Q', 'H'];

/** Rend la matrice en pixels RGBA, avec la zone de silence de 4 modules. */
function rasterize(qr, scale = 4, quiet = 4) {
  const side = (qr.size + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);

  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      if (!qr.isDark(row, col)) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const px = ((row + quiet) * scale + y) * side + ((col + quiet) * scale + x);
          pixels[px * 4] = 0;
          pixels[px * 4 + 1] = 0;
          pixels[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { pixels, side };
}

function decode(qr) {
  const { pixels, side } = rasterize(qr);
  const result = jsQR(pixels, side, side);
  return result ? result.data : null;
}

/** Charge utile en majuscules de longueur voulue, valide en alphanumérique. */
function alphanumericPayload(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  while (out.length < length) out += alphabet[out.length % alphabet.length];
  return out.slice(0, length);
}

describe('encodeQr', () => {
  it('relit une URL de place identique à ce qui a été encodé', () => {
    const url = 'HTTPS://TWITNINF.DUCKDNS.ORG/I/NINF7K3D9QW2X4M8P2R6T';
    const qr = encodeQr(url, { level: 'H' });

    expect(qr.mode).toBe('alphanumeric');
    expect(decode(qr)).toBe(url);
  });

  it('relit une charge utile en mode octet (minuscules et accents)', () => {
    const payload = 'Place n°42 — invité : Théo';
    const qr = encodeQr(payload, { level: 'Q' });

    expect(qr.mode).toBe('byte');
    expect(decode(qr)).toBe(payload);
  });

  test.each(LEVELS)('remplit une version 1 en correction %s', (level) => {
    const capacity = Math.floor(dataCapacityBits(1, level) / 8) - 2;
    const payload = alphanumericPayload(Math.max(1, capacity));
    const qr = encodeQr(payload, { level });

    expect(qr.version).toBe(1);
    expect(decode(qr)).toBe(payload);
  });

  /**
   * Chaque version a sa propre ligne dans la table des blocs Reed-Solomon et
   * ses propres motifs d'alignement ; à partir de la 7 s'ajoute l'information
   * de version. Une seule ligne recopiée de travers ne casse que sa version :
   * il faut donc les parcourir toutes.
   */
  describe('chaque version, chaque niveau', () => {
    const cases = [];
    for (let version = 1; version <= 10; version += 1) {
      for (const level of LEVELS) cases.push([version, level]);
    }

    test.each(cases)('version %i, correction %s', (version, level) => {
      const payload = alphanumericPayload(
        Math.max(1, Math.floor((dataCapacityBits(version, level) - 20) / 5.5) - 1)
      );
      const qr = encodeQr(payload, { level, minVersion: version });

      expect(qr.version).toBe(version);
      expect(qr.level).toBe(level);
      expect(decode(qr)).toBe(payload);
    });
  });

  it('refuse une charge utile trop longue plutôt que de rendre un code illisible', () => {
    expect(() => encodeQr(alphanumericPayload(400), { level: 'H' }))
      .toThrow(/trop longue/);
  });

  it('rend une matrice carrée de la taille attendue', () => {
    const qr = encodeQr('TWITNINF', { level: 'M' });
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.modules).toHaveLength(qr.size);
    expect(qr.modules[0]).toHaveLength(qr.size);
  });
});
