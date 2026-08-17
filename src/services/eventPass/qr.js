/**
 * Encodeur de code QR — modèle 2, versions 1 à 10, niveaux L/M/Q/H.
 *
 * ── Pourquoi pas une bibliothèque ─────────────────────────────────────────
 * Le rendu des places d'invitation ne dessine pas des carrés noirs : modules
 * arrondis, yeux de repérage colorés, trou pour le logo. Tout cela demande la
 * MATRICE de modules, pas une image. Les bibliothèques qui rendent une image
 * la cachent, celles qui exposent la matrice ajoutent une dépendance de
 * production pour cent lignes de tables. `deploy-vps.sh` fait bien un
 * `npm install` à chaque envoi, mais une dépendance de moins sur le chemin du
 * déploiement reste une panne de moins.
 *
 * ── Portée volontairement limitée aux versions 1 à 10 ─────────────────────
 * La table des blocs Reed-Solomon compte quatre lignes par version, chacune
 * recopiée à la main depuis la norme : quarante lignes se vérifient, cent
 * soixante se recopient mal. La version 10 en correction H porte déjà 174
 * caractères alphanumériques, très au-delà de l'URL d'une place (~55). Une
 * charge plus longue lève une erreur explicite plutôt que de produire un code
 * illisible.
 *
 * ── Vérification ──────────────────────────────────────────────────────────
 * `__specs__/eventPassQr.spec.js` fait un aller-retour complet à travers un
 * vrai décodeur (jsQR, dépendance de développement) sur chaque combinaison
 * version × niveau × mode. Un code QR faux ne se voit pas à l'œil nu : il ne
 * se voit qu'au moment où quelqu'un est bloqué à l'entrée.
 */

// ── Champ de Galois GF(256), polynôme primitif 0x11D ────────────────────────
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function buildGaloisTables() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * Polynôme générateur de degré `degree`, produit des (x - α^i), coefficients
 * en ordre DÉCROISSANT : `poly[0]` est celui du terme de plus haut degré, et
 * vaut toujours 1. C'est l'ordre qu'attend la division ci-dessous, qui saute
 * ce coefficient de tête.
 */
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];                        // × x
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);  // × α^i
    }
    poly = next;
  }
  return poly;
}

/** Mots de correction d'un bloc de données. */
function rsEncode(data, ecCount) {
  const generator = rsGeneratorPoly(ecCount);
  const remainder = new Array(ecCount).fill(0);

  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) {
        remainder[j] ^= gfMul(generator[j + 1], factor);
      }
    }
  }
  return remainder;
}

// ── Tables de la norme ──────────────────────────────────────────────────────

/** Nombre total de mots (données + correction) par version. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/**
 * Découpage en blocs : [mots de correction par bloc, blocs G1, données G1,
 * blocs G2, données G2]. Le groupe 2 porte un mot de données de plus que le
 * groupe 1 quand il existe.
 */
const BLOCK_TABLE = {
  L: [
    null,
    [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
  ],
  M: [
    null,
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
  Q: [
    null,
    [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
  ],
  H: [
    null,
    [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
  ],
};

/** Centres des motifs d'alignement, par version. */
const ALIGNMENT_CENTERS = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const EC_FORMAT_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const MAX_VERSION = 10;

// ── Écriture du flux binaire ────────────────────────────────────────────────

class BitBuffer {
  constructor() {
    this.bits = [];
  }

  put(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length() {
    return this.bits.length;
  }
}

/**
 * Le mode alphanumérique loge deux caractères dans onze bits, contre huit bits
 * par caractère en mode octet. Une URL entièrement en majuscules y tient
 * presque deux fois plus court — donc une version plus basse, donc des modules
 * plus gros et un code plus lisible de loin. C'est ce qui fait la différence
 * entre une place qui se scanne d'un geste et une place qu'on présente trois
 * fois.
 */
function canUseAlphanumeric(text) {
  for (const char of text) {
    if (!ALPHANUMERIC.includes(char)) return false;
  }
  return true;
}

function countIndicatorBits(mode, version) {
  if (mode === 'alphanumeric') return version <= 9 ? 9 : 11;
  return version <= 9 ? 8 : 16;
}

function dataCapacityBits(version, level) {
  const [ecPerBlock, blocksG1, dataG1, blocksG2, dataG2] = BLOCK_TABLE[level][version];
  void ecPerBlock;
  return (blocksG1 * dataG1 + blocksG2 * dataG2) * 8;
}

function encodedBits(text, mode, version) {
  const header = 4 + countIndicatorBits(mode, version);
  if (mode === 'alphanumeric') {
    const pairs = Math.floor(text.length / 2);
    return header + pairs * 11 + (text.length % 2 ? 6 : 0);
  }
  return header + Buffer.byteLength(text, 'utf8') * 8;
}

function pickVersion(text, mode, level, minVersion) {
  for (let version = Math.max(1, minVersion || 1); version <= MAX_VERSION; version += 1) {
    if (encodedBits(text, mode, version) <= dataCapacityBits(version, level)) {
      return version;
    }
  }
  return null;
}

function buildDataCodewords(text, mode, version, level) {
  const buffer = new BitBuffer();
  const capacity = dataCapacityBits(version, level);

  if (mode === 'alphanumeric') {
    buffer.put(0b0010, 4);
    buffer.put(text.length, countIndicatorBits(mode, version));
    for (let i = 0; i < text.length; i += 2) {
      const first = ALPHANUMERIC.indexOf(text[i]);
      if (i + 1 < text.length) {
        buffer.put(first * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
      } else {
        buffer.put(first, 6);
      }
    }
  } else {
    const bytes = Buffer.from(text, 'utf8');
    buffer.put(0b0100, 4);
    buffer.put(bytes.length, countIndicatorBits(mode, version));
    for (const byte of bytes) buffer.put(byte, 8);
  }

  // Terminaison : jusqu'à quatre zéros, puis alignement sur l'octet.
  const terminator = Math.min(4, capacity - buffer.length);
  if (terminator > 0) buffer.put(0, terminator);
  while (buffer.length % 8 !== 0) buffer.put(0, 1);

  const codewords = [];
  for (let i = 0; i < buffer.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | buffer.bits[i + j];
    codewords.push(byte);
  }

  // Remplissage jusqu'à la capacité : 0xEC et 0x11 en alternance.
  const target = capacity / 8;
  const padding = [0xec, 0x11];
  for (let i = 0; codewords.length < target; i += 1) {
    codewords.push(padding[i % 2]);
  }
  return codewords;
}

/**
 * Entrelacement des blocs. Les mots de données de tous les blocs sont émis
 * colonne par colonne, puis les mots de correction de la même façon : une
 * salissure locale sur le code abîme alors un peu de chaque bloc plutôt que
 * tout un bloc, et chaque bloc reste réparable.
 */
function interleave(dataCodewords, version, level) {
  const [ecPerBlock, blocksG1, dataG1, blocksG2, dataG2] = BLOCK_TABLE[level][version];

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < blocksG1; i += 1) {
    const data = dataCodewords.slice(offset, offset + dataG1);
    offset += dataG1;
    blocks.push({ data, ec: rsEncode(data, ecPerBlock) });
  }
  for (let i = 0; i < blocksG2; i += 1) {
    const data = dataCodewords.slice(offset, offset + dataG2);
    offset += dataG2;
    blocks.push({ data, ec: rsEncode(data, ecPerBlock) });
  }

  const result = [];
  const maxData = Math.max(dataG1, dataG2);
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) result.push(block.data[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) result.push(block.ec[i]);
  }
  return result;
}

// ── Construction de la matrice ──────────────────────────────────────────────

function createMatrix(size) {
  const modules = [];
  const reserved = [];
  for (let i = 0; i < size; i += 1) {
    modules.push(new Uint8Array(size));
    reserved.push(new Uint8Array(size));
  }
  return { modules, reserved, size };
}

function placeFinder(matrix, row, col) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= matrix.size || x < 0 || x >= matrix.size) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6))
        || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      matrix.modules[y][x] = inRing || inCore ? 1 : 0;
      matrix.reserved[y][x] = 1;
    }
  }
}

function placeAlignment(matrix, version) {
  const centers = ALIGNMENT_CENTERS[version];
  for (const row of centers) {
    for (const col of centers) {
      // Les trois coins portent déjà un motif de repérage.
      const isFinderCorner = (row === 6 && col === 6)
        || (row === 6 && col === matrix.size - 7)
        || (row === matrix.size - 7 && col === 6);
      if (isFinderCorner) continue;

      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          matrix.modules[row + r][col + c] = dark ? 1 : 0;
          matrix.reserved[row + r][col + c] = 1;
        }
      }
    }
  }
}

function placeTiming(matrix) {
  for (let i = 8; i < matrix.size - 8; i += 1) {
    const dark = i % 2 === 0 ? 1 : 0;
    matrix.modules[6][i] = dark;
    matrix.reserved[6][i] = 1;
    matrix.modules[i][6] = dark;
    matrix.reserved[i][6] = 1;
  }
}

function reserveFormatAreas(matrix, version) {
  for (let i = 0; i < 9; i += 1) {
    if (!matrix.reserved[8][i]) matrix.reserved[8][i] = 1;
    if (!matrix.reserved[i][8]) matrix.reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i += 1) {
    matrix.reserved[8][matrix.size - 1 - i] = 1;
    matrix.reserved[matrix.size - 1 - i][8] = 1;
  }
  // Module toujours sombre, juste au-dessus du motif inférieur gauche.
  matrix.modules[matrix.size - 8][8] = 1;
  matrix.reserved[matrix.size - 8][8] = 1;

  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        matrix.reserved[matrix.size - 11 + j][i] = 1;
        matrix.reserved[i][matrix.size - 11 + j] = 1;
      }
    }
  }
}

/** Parcours en zigzag, de droite à gauche, en sautant la colonne de timing. */
function placeData(matrix, codewords) {
  const bits = [];
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((codeword >>> i) & 1);
  }

  let bitIndex = 0;
  let upward = true;

  for (let right = matrix.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < matrix.size; step += 1) {
      const row = upward ? matrix.size - 1 - step : step;
      for (let c = 0; c < 2; c += 1) {
        const col = right - c;
        if (matrix.reserved[row][col]) continue;
        matrix.modules[row][col] = bitIndex < bits.length ? bits[bitIndex] : 0;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

const MASK_RULES = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
];

function applyMask(matrix, maskIndex) {
  const masked = matrix.modules.map((row) => Uint8Array.from(row));
  const rule = MASK_RULES[maskIndex];
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.reserved[row][col]) continue;
      if (rule(row, col)) masked[row][col] ^= 1;
    }
  }
  return masked;
}

/** Les quatre pénalités de la norme : le masque le moins pénalisé gagne. */
function maskPenalty(modules, size) {
  let penalty = 0;

  const runPenalty = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < size; i += 1) {
      if (line[i] === line[i - 1]) {
        run += 1;
      } else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };

  for (let row = 0; row < size; row += 1) {
    penalty += runPenalty(modules[row]);
    penalty += runPenalty(modules.map((line) => line[row]));
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = modules[row][col];
      if (value === modules[row][col + 1]
        && value === modules[row + 1][col]
        && value === modules[row + 1][col + 1]) {
        penalty += 3;
      }
    }
  }

  // Motif 1:1:3:1:1 entouré de quatre modules clairs — celui qui imite un
  // motif de repérage et fait chercher au décodeur un coin qui n'existe pas.
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const matchesAt = (line, start) => {
    for (let i = 0; i < 7; i += 1) {
      if (line[start + i] !== pattern[i]) return false;
    }
    const before = line.slice(Math.max(0, start - 4), start);
    const after = line.slice(start + 7, start + 11);
    const clearBefore = before.length === 4 && before.every((v) => v === 0);
    const clearAfter = after.length === 4 && after.every((v) => v === 0);
    return clearBefore || clearAfter;
  };

  for (let row = 0; row < size; row += 1) {
    const horizontal = Array.from(modules[row]);
    const vertical = modules.map((line) => line[row]);
    for (let col = 0; col + 7 <= size; col += 1) {
      if (matchesAt(horizontal, col)) penalty += 40;
      if (matchesAt(vertical, col)) penalty += 40;
    }
  }

  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) dark += modules[row][col];
  }
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return penalty;
}

/**
 * Reste de la division par le polynôme générateur, dans GF(2).
 * `degree` est le degré du générateur : 10 pour le format (BCH 15,5), 12 pour
 * la version (BCH 18,6).
 */
function bchRemainder(value, generator, degree) {
  let remainder = value;
  for (let i = 30 - degree; i >= 0; i -= 1) {
    const bit = i + degree;
    if (bit > 30) continue;
    if (remainder & (1 << bit)) remainder ^= generator << i;
  }
  return remainder;
}

function formatInfoBits(level, maskIndex) {
  const data = (EC_FORMAT_BITS[level] << 3) | maskIndex;
  // G(x) = x^10 + x^8 + x^5 + x^4 + x^2 + x + 1, puis masque anti-tout-blanc.
  const remainder = bchRemainder(data << 10, 0b10100110111, 10);
  return ((data << 10) | remainder) ^ 0b101010000010010;
}

function versionInfoBits(version) {
  // G(x) = x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1
  const remainder = bchRemainder(version << 12, 0b1111100100101, 12);
  return (version << 12) | remainder;
}

/**
 * Les quinze bits de format sont écrits deux fois, et l'ordre compte : le bit
 * de POIDS FORT va en (8,0), pas en (0,8). Une inversion produit un code
 * parfaitement dessiné qu'aucun lecteur ne décode — l'erreur ne se voit qu'au
 * scan, jamais à l'œil.
 */
function placeFormatInfo(modules, size, level, maskIndex) {
  const bits = formatInfoBits(level, maskIndex);
  const bitAt = (i) => (bits >> i) & 1;

  // Première copie : colonne 8 de haut en bas, puis ligne 8 de droite à gauche.
  for (let i = 0; i < 15; i += 1) {
    const bit = bitAt(i);
    if (i < 6) modules[i][8] = bit;
    else if (i < 8) modules[i + 1][8] = bit;
    else modules[size - 15 + i][8] = bit;
  }

  // Seconde copie, en miroir : ligne 8 à droite, colonne 8 en bas.
  for (let i = 0; i < 15; i += 1) {
    const bit = bitAt(i);
    if (i < 8) modules[8][size - 1 - i] = bit;
    else if (i === 8) modules[8][7] = bit;
    else modules[8][14 - i] = bit;
  }

  modules[size - 8][8] = 1;
}

function placeVersionInfo(modules, size, version) {
  if (version < 7) return;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1;
    const row = Math.floor(i / 3);
    const col = size - 11 + (i % 3);
    modules[row][col] = bit;
    modules[col][row] = bit;
  }
}

/**
 * Encode `text` et rend la matrice de modules.
 *
 * @param {string} text charge utile
 * @param {{ level?: 'L'|'M'|'Q'|'H', minVersion?: number }} [options]
 * @returns {{ size: number, version: number, level: string, mode: string,
 *             isDark: (row: number, col: number) => boolean, modules: Uint8Array[] }}
 */
function encodeQr(text, options = {}) {
  const level = options.level || 'H';
  if (!BLOCK_TABLE[level]) {
    throw new Error(`Niveau de correction inconnu : ${level}`);
  }
  const payload = String(text);
  if (!payload) throw new Error('Charge utile vide');

  const mode = canUseAlphanumeric(payload) ? 'alphanumeric' : 'byte';
  const version = pickVersion(payload, mode, level, options.minVersion);
  if (!version) {
    throw new Error(
      `Charge utile trop longue pour un code QR de version ${MAX_VERSION} en correction ${level}`
    );
  }

  const dataCodewords = buildDataCodewords(payload, mode, version, level);
  const codewords = interleave(dataCodewords, version, level);
  if (codewords.length !== TOTAL_CODEWORDS[version]) {
    throw new Error(
      `Incohérence de table : ${codewords.length} mots produits pour la version ${version}, `
      + `${TOTAL_CODEWORDS[version]} attendus`
    );
  }

  const size = version * 4 + 17;
  const matrix = createMatrix(size);
  placeFinder(matrix, 0, 0);
  placeFinder(matrix, 0, size - 7);
  placeFinder(matrix, size - 7, 0);
  placeAlignment(matrix, version);
  placeTiming(matrix);
  reserveFormatAreas(matrix, version);
  placeData(matrix, codewords);

  let best = null;
  const masks = Number.isInteger(options.mask) ? [options.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const maskIndex of masks) {
    const masked = applyMask(matrix, maskIndex);
    placeFormatInfo(masked, size, level, maskIndex);
    placeVersionInfo(masked, size, version);
    const penalty = maskPenalty(masked, size);
    if (!best || penalty < best.penalty) best = { penalty, modules: masked, maskIndex };
  }

  return {
    size,
    version,
    level,
    mode,
    mask: best.maskIndex,
    modules: best.modules,
    isDark: (row, col) => best.modules[row][col] === 1,
  };
}

module.exports = {
  encodeQr,
  MAX_VERSION,
  // Exportés pour les tests : ce sont eux qui se trompent en silence.
  canUseAlphanumeric,
  dataCapacityBits,
};
