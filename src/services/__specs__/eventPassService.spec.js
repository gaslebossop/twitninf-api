/**
 * Signature, jeton et forme des codes de place.
 *
 * Rien ici ne touche la base : ce sont les fonctions pures du service, celles
 * qui décident si une place est authentique et si son code QR tiendra dans une
 * petite version. Le reste (émission par lot, consommation sous verrou) se
 * vérifie contre une vraie base.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'clé-de-test-uniquement';

const jsQR = require('jsqr');

const service = require('../eventPassService');
const { encodeQr, canUseAlphanumeric } = require('../eventPass/qr');

describe('signature des places', () => {
  const code = 'NINF-7K3D-9QW2';

  it('signe de façon déterministe, en dix caractères', () => {
    const signature = service.signCode(code);
    expect(signature).toHaveLength(10);
    expect(signature).toMatch(/^[A-Z2-7]{10}$/);
    expect(service.signCode(code)).toBe(signature);
  });

  it('ignore les tirets et la casse', () => {
    expect(service.signCode('ninf7k3d9qw2')).toBe(service.signCode(code));
  });

  it('donne une signature différente pour un code différent', () => {
    expect(service.signCode('NINF-7K3D-9QW3')).not.toBe(service.signCode(code));
  });

  it('refuse une signature trafiquée', () => {
    const signature = service.signCode(code);
    expect(service.signatureMatches(code, signature)).toBe(true);
    expect(service.signatureMatches(code, `${signature.slice(0, 9)}A`)).toBe(false);
    expect(service.signatureMatches(code, signature.slice(0, 9))).toBe(false);
    expect(service.signatureMatches('NINF-0000-0000', signature)).toBe(false);
  });
});

describe('lecture de ce qui est présenté à l’entrée', () => {
  const code = 'NINF-7K3D-9QW2';
  const token = service.buildToken(code);

  it('lit l’URL du code QR, en majuscules', () => {
    const parsed = service.parseToken(`HTTPS://TWITNINF.DUCKDNS.ORG/I/${token}`);
    expect(parsed).toMatchObject({ code: 'NINF7K3D9QW2', manual: false });
    expect(service.signatureMatches(parsed.code, parsed.signature)).toBe(true);
  });

  it('lit la même URL en minuscules', () => {
    const parsed = service.parseToken(`https://twitninf.duckdns.org/i/${token.toLowerCase()}`);
    expect(parsed.code).toBe('NINF7K3D9QW2');
    expect(service.signatureMatches(parsed.code, parsed.signature)).toBe(true);
  });

  it('lit le jeton seul', () => {
    expect(service.parseToken(token)).toMatchObject({ code: 'NINF7K3D9QW2', manual: false });
  });

  /** Écran cassé, batterie vide : l'équipe tape le code imprimé. */
  it('accepte le code imprimé seul, et le signale comme saisie manuelle', () => {
    const parsed = service.parseToken(code);
    expect(parsed).toMatchObject({ code: 'NINF7K3D9QW2', signature: null, manual: true });
  });

  it('rejette ce qui n’est pas une place', () => {
    expect(service.parseToken('')).toBeNull();
    expect(service.parseToken('https://exemple.test/i/BONJOUR')).toBeNull();
    expect(service.parseToken('NINF-7K3D')).toBeNull();
    expect(service.parseToken(`${token}XXXX`)).toBeNull();
  });
});

describe('forme des codes', () => {
  /**
   * Seule la partie tirée au sort est contrainte : le préfixe `NINF` est un
   * mot fixe, il ne se transcrit pas caractère par caractère.
   */
  it('n’émet que des caractères non ambigus', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = service.generateCode();
      expect(code).toMatch(/^NINF-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
      expect(code.slice(5)).not.toMatch(/[01ILOU]/);
    }
  });

  it('passe de la forme compacte à la forme lisible', () => {
    expect(service.formatCode('NINF7K3D9QW2')).toBe('NINF-7K3D-9QW2');
    expect(service.normalizeCode('ninf-7k3d-9qw2')).toBe('NINF7K3D9QW2');
  });
});

describe('charge utile du code QR', () => {
  const payload = service.buildQrPayload('NINF-7K3D-9QW2');

  /**
   * Tout est en majuscules pour que le code QR passe en mode alphanumérique :
   * une minuscule suffit à basculer en mode octet, ce qui coûte une à deux
   * versions — donc des modules plus petits, donc un scan plus laborieux.
   */
  it('reste encodable en mode alphanumérique', () => {
    expect(payload).toBe(payload.toUpperCase());
    expect(canUseAlphanumeric(payload)).toBe(true);
  });

  it('tient dans une version basse, même en correction maximale', () => {
    const qr = encodeQr(payload, { level: 'H' });
    expect(qr.mode).toBe('alphanumeric');
    expect(qr.version).toBeLessThanOrEqual(6);
  });

  it('pointe vers la place, signature comprise', () => {
    const parsed = service.parseToken(payload);
    expect(parsed.code).toBe('NINF7K3D9QW2');
    expect(service.signatureMatches(parsed.code, parsed.signature)).toBe(true);
  });
});

/**
 * La matrice envoyée à l'app mobile.
 *
 * C'est elle que l'app dessine à l'entrée, depuis son cache. Elle sort donc du
 * même encodeur que la place imprimée — mais rien ne garantit que le passage
 * par des chaînes de « 0 » et de « 1 » n'inverse pas une ligne et une colonne,
 * et une matrice transposée se dessine exactement comme une matrice juste.
 * D'où la relecture par un vrai décodeur, comme pour l'encodeur lui-même.
 */
describe('matrice envoyée à l’app', () => {
  const code = 'NINF-7K3D-9QW2';
  const matrix = service.buildQrMatrix(code);

  /** Rend les lignes en pixels RGBA, zone de silence de 4 modules comprise. */
  function rasterize({ size, rows }, scale = 4, quiet = 4) {
    const side = (size + quiet * 2) * scale;
    const pixels = new Uint8ClampedArray(side * side * 4).fill(255);

    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (rows[row][col] !== '1') continue;
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

  it('est carrée, et ne contient que des modules', () => {
    expect(matrix.rows).toHaveLength(matrix.size);
    for (const row of matrix.rows) {
      expect(row).toHaveLength(matrix.size);
      expect(row).toMatch(/^[01]+$/);
    }
  });

  it('est en correction H, comme la place imprimée', () => {
    expect(matrix.level).toBe('H');
  });

  it('se relit, et rend exactement l’URL de la place', () => {
    const { pixels, side } = rasterize(matrix);
    const read = jsQR(pixels, side, side);
    expect(read).not.toBeNull();
    expect(read.data).toBe(service.buildQrPayload(code));
  });
});
