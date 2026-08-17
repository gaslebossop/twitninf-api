/**
 * Dessin d'une place d'invitation TwitNinf, en SVG.
 *
 * ── Direction artistique ──────────────────────────────────────────────────
 * « Pulse » : noir plat `#0A0A0A`, accent magenta `#FE2C55`, surfaces PLEINES.
 * Pas de verre dépoli, pas de dégradé par élément, pas une couleur différente
 * par bloc — c'est exactement le look « généré par IA » rejeté ailleurs dans
 * le projet. Ce qui distingue les paliers (or pour VIP, blanc pour l'équipe)
 * est UNE teinte d'accent, jamais un habillage différent.
 *
 * ── Pourquoi le code QR est dessiné à la main ─────────────────────────────
 * Modules arrondis, yeux de repérage à pupille magenta, trou central pour le
 * logo : il faut la matrice, pas une image. Les contraintes de lisibilité
 * restent prioritaires sur l'esthétique —
 *   • les modules restent SOMBRES sur fond CLAIR (l'inverse fait échouer une
 *     bonne partie des lecteurs) ;
 *   • la zone de silence de quatre modules est intégrale ;
 *   • le trou du logo est calculé pour rester sous ce que la correction de
 *     niveau H (30 %) sait réparer.
 *
 * ── SVG et pas PNG ────────────────────────────────────────────────────────
 * Le SVG s'affiche dans un navigateur, dans l'app mobile (react-native-svg) et
 * s'imprime sans perte. La conversion en PNG existe côté route pour le partage
 * (voir `eventPassRoutes`), mais la source reste ce fichier.
 */

const { encodeQr } = require('./qr');

const PULSE = {
  bg: '#0A0A0A',
  surface: '#141416',
  line: 'rgba(255,255,255,0.10)',
  ink: '#0E0E10',
  paper: '#FFFFFF',
  white: '#FFFFFF',
  muted: 'rgba(255,255,255,0.58)',
  magenta: '#FE2C55',
  gold: '#FFD24D',
  cyan: '#25F4EE',
};

/** Un palier = une teinte d'accent et un mot. Rien d'autre ne change. */
const TIERS = {
  standard: { label: 'Place', accent: PULSE.magenta, onAccent: '#FFFFFF' },
  vip: { label: 'VIP', accent: PULSE.gold, onAccent: '#0A0A0A' },
  staff: { label: 'Équipe', accent: PULSE.white, onAccent: '#0A0A0A' },
  presse: { label: 'Presse', accent: PULSE.cyan, onAccent: '#0A0A0A' },
};

/**
 * Silhouette de la marque (le chat), reprise telle quelle de
 * `twitninf-da/public/da/assets/twit-logo.svg`. Boîte d'origine :
 * x 207, y 56, largeur 1189.15, hauteur 1415.99.
 */
const LOGO_PATH = 'M 208.00 793.00 C 207.39 801.91 207.79 811.79 207.00 820.00 C 207.00 835.90 207.00 852.11 207.00 868.00 C 207.80 876.27 207.29 886.12 208.00 895.00 C 211.15 934.73 219.90 980.86 230.02 1017.98 C 240.15 1055.10 253.68 1090.16 269.68 1123.32 C 285.68 1156.48 301.27 1185.79 322.08 1214.92 C 342.90 1244.05 362.25 1268.81 387.75 1294.25 C 413.25 1319.69 436.30 1340.51 465.77 1361.23 C 495.24 1381.95 522.68 1398.91 556.31 1414.70 C 589.93 1430.48 625.07 1444.06 662.98 1453.02 C 700.88 1461.99 747.97 1470.01 789.00 1471.00 C 830.03 1471.99 882.24 1465.27 920.78 1457.78 C 959.31 1450.29 995.76 1436.55 1029.93 1421.93 C 1064.09 1407.30 1092.73 1390.67 1122.77 1370.77 C 1152.81 1350.87 1176.46 1330.48 1202.75 1305.75 C 1229.04 1281.03 1249.06 1256.77 1270.25 1228.25 C 1291.44 1199.73 1309.02 1171.66 1325.22 1139.22 C 1341.43 1106.79 1356.48 1072.13 1367.07 1036.07 C 1377.67 1000.01 1388.94 955.60 1392.00 917.00 C 1392.38 912.25 1392.26 907.11 1393.00 903.00 C 1395.70 863.29 1396.15 825.66 1393.00 786.00 C 1392.19 781.81 1392.33 776.79 1392.00 772.00 C 1389.67 737.83 1381.46 702.18 1372.33 669.67 C 1363.19 637.17 1355.60 611.41 1340.32 580.68 C 1325.04 549.95 1325.70 511.25 1325.00 475.00 C 1324.30 438.75 1321.47 403.15 1321.00 366.00 C 1320.53 328.85 1317.28 291.19 1317.00 253.00 C 1316.72 214.81 1313.00 177.75 1313.00 140.00 C 1312.07 130.38 1312.00 119.33 1312.00 109.00 C 1310.63 92.27 1310.72 76.18 1309.00 60.00 C 1294.12 80.81 1279.96 103.18 1266.30 124.30 C 1252.65 145.43 1237.09 166.03 1222.77 186.77 C 1208.45 207.51 1194.65 230.44 1178.77 249.77 C 1162.89 269.10 1155.65 298.98 1129.02 306.02 C 1102.40 313.07 1079.70 287.81 1055.23 277.77 C 1030.76 267.74 1006.52 254.12 979.67 246.33 C 952.83 238.54 924.36 229.16 895.00 225.00 C 865.64 220.84 827.92 217.00 797.00 217.00 C 792.97 217.39 787.68 217.82 783.00 218.00 C 751.55 218.02 716.73 224.01 687.02 229.02 C 657.32 234.04 632.66 244.29 605.01 253.01 C 577.36 261.72 557.71 276.59 529.22 283.22 C 500.73 289.85 486.80 255.09 471.25 236.75 C 455.70 218.40 440.63 195.82 425.75 176.25 C 410.87 156.68 395.04 135.88 379.77 116.23 C 364.50 96.58 350.72 74.59 334.00 56.00 C 334.69 87.30 334.38 115.86 335.02 144.98 C 335.67 174.09 336.97 203.13 337.00 233.00 C 337.03 262.87 335.69 293.88 336.93 323.93 C 338.17 353.97 335.43 387.55 337.93 416.92 C 340.43 446.30 326.77 467.74 310.77 489.77 C 294.77 511.80 286.58 530.81 274.30 554.30 C 262.03 577.80 252.84 600.37 243.78 625.78 C 234.71 651.18 226.47 677.72 220.99 704.99 C 215.51 732.27 209.93 764.59 208.00 793.00 Z';

const LOGO_BOX = { x: 207, y: 56, width: 1189.15, height: 1415.99 };

const FONT_STACK = "'Plus Jakarta Sans','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO_STACK = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

/**
 * Échappement XML. La place porte des textes saisis par un humain (nom de
 * l'invité, nom de l'événement) et le SVG est servi tel quel : sans cet
 * échappement, un nom contenant `<` casse le document — et un nom bien choisi
 * y injecte du balisage.
 */
function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Largeur approchée d'un texte, faute de pouvoir mesurer une police ici. */
function approximateWidth(text, fontSize, weight = 400) {
  const ratio = weight >= 700 ? 0.58 : 0.53;
  return String(text).length * fontSize * ratio;
}

function truncate(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Découpe un titre en au plus `maxLines` lignes tenant dans `maxWidth`. */
function wrapTitle(text, fontSize, maxWidth, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (approximateWidth(candidate, fontSize, 800) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);

  if (lines.length === maxLines) {
    const consumed = lines.join(' ').split(/\s+/).length;
    if (consumed < words.length) {
      lines[maxLines - 1] = truncate(`${lines[maxLines - 1]} ${words.slice(consumed).join(' ')}`,
        Math.floor(maxWidth / (fontSize * 0.58)));
    }
  }
  return lines.length ? lines : [''];
}

// ── Code QR ─────────────────────────────────────────────────────────────────

/**
 * Rayons des quatre coins d'un module, selon ses voisins : un module isolé est
 * une pastille, deux modules côte à côte se soudent. C'est ce qui donne l'aspect
 * « gouttes » sans jamais séparer deux modules qui doivent se toucher.
 */
function moduleCorners(isDark, row, col, radius) {
  const dark = (r, c) => isDark(r, c);
  const top = dark(row - 1, col);
  const bottom = dark(row + 1, col);
  const left = dark(row, col - 1);
  const right = dark(row, col + 1);
  return {
    tl: !top && !left ? radius : 0,
    tr: !top && !right ? radius : 0,
    br: !bottom && !right ? radius : 0,
    bl: !bottom && !left ? radius : 0,
  };
}

function roundedRectPath(x, y, w, h, corners) {
  const { tl, tr, br, bl } = corners;
  return [
    `M${x + tl},${y}`,
    `H${x + w - tr}`,
    tr ? `A${tr},${tr} 0 0 1 ${x + w},${y + tr}` : '',
    `V${y + h - br}`,
    br ? `A${br},${br} 0 0 1 ${x + w - br},${y + h}` : '',
    `H${x + bl}`,
    bl ? `A${bl},${bl} 0 0 1 ${x},${y + h - bl}` : '',
    `V${y + tl}`,
    tl ? `A${tl},${tl} 0 0 1 ${x + tl},${y}` : '',
    'Z',
  ].filter(Boolean).join(' ');
}

/** Anneau de repérage : un carré arrondi évidé, dessiné en une seule passe. */
function finderRing(x, y, unit) {
  const outer = unit * 7;
  const r = unit * 2.1;
  const inset = unit;
  const innerSize = outer - inset * 2;
  const innerR = Math.max(0, r - inset * 0.8);
  return [
    `M${x + r},${y}`,
    `H${x + outer - r}`,
    `A${r},${r} 0 0 1 ${x + outer},${y + r}`,
    `V${y + outer - r}`,
    `A${r},${r} 0 0 1 ${x + outer - r},${y + outer}`,
    `H${x + r}`,
    `A${r},${r} 0 0 1 ${x},${y + outer - r}`,
    `V${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    'Z',
    `M${x + inset + innerR},${y + inset}`,
    `A${innerR},${innerR} 0 0 0 ${x + inset},${y + inset + innerR}`,
    `V${y + inset + innerSize - innerR}`,
    `A${innerR},${innerR} 0 0 0 ${x + inset + innerR},${y + inset + innerSize}`,
    `H${x + inset + innerSize - innerR}`,
    `A${innerR},${innerR} 0 0 0 ${x + inset + innerSize},${y + inset + innerSize - innerR}`,
    `V${y + inset + innerR}`,
    `A${innerR},${innerR} 0 0 0 ${x + inset + innerSize - innerR},${y + inset}`,
    'Z',
  ].join(' ');
}

/** Luminance relative (WCAG) d'une couleur `#rrggbb`. */
function relativeLuminance(hex) {
  const value = String(hex).replace('#', '');
  if (value.length !== 6) return 0;
  const channel = (part) => {
    const c = Number.parseInt(part, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(value.slice(0, 2))
    + 0.7152 * channel(value.slice(2, 4))
    + 0.0722 * channel(value.slice(4, 6));
}

/**
 * Une couleur ne rentre dans le code QR que si un lecteur la lit encore comme
 * « sombre ». L'or et le cyan de la palette sont clairs : posés sur les
 * pupilles des motifs de repérage, ils effacent le repère que le lecteur
 * cherche en premier, et le code cesse d'être détectable — sans que rien ne se
 * voie à l'œil. Le palier colore la carte, jamais le code.
 */
function safeCodeColor(color, fallback) {
  return relativeLuminance(color) <= 0.22 ? color : fallback;
}

function isFinderZone(row, col, size) {
  const inBox = (r0, c0) => row >= r0 && row < r0 + 7 && col >= c0 && col < c0 + 7;
  return inBox(0, 0) || inBox(0, size - 7) || inBox(size - 7, 0);
}

/**
 * Dessine le code QR dans un carré de `size` unités utilisateur, zone de
 * silence comprise.
 *
 * @param {string} payload contenu encodé
 * @param {object} [options]
 * @param {number} [options.size=520] côté du bloc, zone de silence incluse
 * @param {number} [options.x=0]
 * @param {number} [options.y=0]
 * @param {boolean} [options.logo=true] réserve le centre pour la marque
 * @param {string} [options.level='H']
 */
function renderQrBlock(payload, options = {}) {
  const size = options.size || 520;
  const x0 = options.x || 0;
  const y0 = options.y || 0;
  const level = options.level || 'H';
  const withLogo = options.logo !== false;
  const dark = safeCodeColor(options.dark || PULSE.ink, PULSE.ink);
  const accent = safeCodeColor(options.accent || PULSE.magenta, PULSE.magenta);

  const qr = encodeQr(payload, { level });
  const quiet = 4;
  const unit = size / (qr.size + quiet * 2);
  const origin = { x: x0 + unit * quiet, y: y0 + unit * quiet };

  // Fenêtre du logo, en modules : impaire pour rester centrée sur la grille.
  let hole = null;
  if (withLogo) {
    let span = Math.round(qr.size * 0.19);
    if (span % 2 !== qr.size % 2) span += 1;
    const start = Math.floor((qr.size - span) / 2);
    hole = { start, end: start + span - 1, span };
  }

  const inHole = (row, col) => hole
    && row >= hole.start && row <= hole.end
    && col >= hole.start && col <= hole.end;

  const isDark = (row, col) => (
    row >= 0 && col >= 0 && row < qr.size && col < qr.size && qr.isDark(row, col)
  );

  const paths = [];
  const radius = unit * 0.46;
  for (let row = 0; row < qr.size; row += 1) {
    for (let col = 0; col < qr.size; col += 1) {
      if (!qr.isDark(row, col)) continue;
      if (isFinderZone(row, col, qr.size)) continue;
      if (inHole(row, col)) continue;
      paths.push(roundedRectPath(
        origin.x + col * unit,
        origin.y + row * unit,
        unit,
        unit,
        moduleCorners((r, c) => isDark(r, c) && !isFinderZone(r, c, qr.size) && !inHole(r, c),
          row, col, radius)
      ));
    }
  }

  const finders = [
    { row: 0, col: 0 },
    { row: 0, col: qr.size - 7 },
    { row: qr.size - 7, col: 0 },
  ];

  const rings = finders.map((f) => finderRing(
    origin.x + f.col * unit,
    origin.y + f.row * unit,
    unit
  )).join(' ');

  const pupils = finders.map((f) => roundedRectPath(
    origin.x + (f.col + 2) * unit,
    origin.y + (f.row + 2) * unit,
    unit * 3,
    unit * 3,
    { tl: unit * 0.9, tr: unit * 0.9, br: unit * 0.9, bl: unit * 0.9 }
  )).join(' ');

  let logo = '';
  if (hole) {
    const holeX = origin.x + hole.start * unit;
    const holeY = origin.y + hole.start * unit;
    const holeSize = hole.span * unit;
    const pad = holeSize * 0.16;
    logo = [
      `<rect x="${round(holeX - pad)}" y="${round(holeY - pad)}"`,
      ` width="${round(holeSize + pad * 2)}" height="${round(holeSize + pad * 2)}"`,
      ` rx="${round(holeSize * 0.3)}" fill="${PULSE.paper}"/>`,
      logoMark(holeX, holeY, holeSize, accent),
    ].join('');
  }

  return [
    `<path d="${paths.join(' ')}" fill="${dark}"/>`,
    `<path d="${rings}" fill="${dark}" fill-rule="evenodd"/>`,
    `<path d="${pupils}" fill="${accent}"/>`,
    logo,
  ].join('');
}

// ── Marque ──────────────────────────────────────────────────────────────────

function logoMark(x, y, size, fill) {
  const scale = Math.min(size / LOGO_BOX.width, size / LOGO_BOX.height);
  const width = LOGO_BOX.width * scale;
  const height = LOGO_BOX.height * scale;
  const dx = x + (size - width) / 2 - LOGO_BOX.x * scale;
  const dy = y + (size - height) / 2 - LOGO_BOX.y * scale;
  return `<g transform="translate(${round(dx)},${round(dy)}) scale(${round(scale, 5)})">`
    + `<path d="${LOGO_PATH}" fill="${fill}"/></g>`;
}

function round(value, digits = 2) {
  return Number.parseFloat(Number(value).toFixed(digits));
}

// ── Contour de la place ─────────────────────────────────────────────────────

/**
 * Contour du billet : rectangle arrondi entaillé de deux demi-cercles à la
 * hauteur de la perforation. Les entailles sont dans le CONTOUR, pas deux
 * disques posés par-dessus : la place reste correcte sur n'importe quel fond,
 * y compris transparent.
 */
function ticketOutline(width, height, radius, notchY, notchR) {
  return [
    `M${radius},0`,
    `H${width - radius}`,
    `A${radius},${radius} 0 0 1 ${width},${radius}`,
    `V${notchY - notchR}`,
    `A${notchR},${notchR} 0 0 0 ${width},${notchY + notchR}`,
    `V${height - radius}`,
    `A${radius},${radius} 0 0 1 ${width - radius},${height}`,
    `H${radius}`,
    `A${radius},${radius} 0 0 1 0,${height - radius}`,
    `V${notchY + notchR}`,
    // Les deux entailles se creusent VERS L'INTÉRIEUR : même sens de balayage
    // des deux côtés, puisqu'on descend à droite et qu'on remonte à gauche.
    `A${notchR},${notchR} 0 0 0 0,${notchY - notchR}`,
    `V${radius}`,
    `A${radius},${radius} 0 0 1 ${radius},0`,
    'Z',
  ].join(' ');
}

// ── Place complète ──────────────────────────────────────────────────────────

const WIDTH = 720;
const HEIGHT = 1240;

/**
 * Repères verticaux. Le bas de la place est ancré à la perforation et au bas
 * de la carte, pas au bloc de titre : un nom d'événement sur deux lignes ne
 * doit pas pousser la souche hors du billet.
 */
const LAYOUT = {
  titleTop: 228,
  titleLead: 60,
  qrPanel: { size: 468, top: 396 },
  hint: 906,
  perforation: 952,
  notchRadius: 26,
};

/**
 * Rend la place complète.
 *
 * @param {object} pass
 * @param {string} pass.code code lisible (NINF-XXXX-XXXX)
 * @param {number} pass.serial numéro de la place dans l'événement
 * @param {string} [pass.guest_name] invité
 * @param {string} [pass.tier] standard | vip | staff | presse
 * @param {string} pass.event_name
 * @param {string} [pass.event_date] déjà formatée pour l'affichage
 * @param {string} [pass.event_place]
 * @param {string} payloadUrl contenu du code QR
 */
function renderPassSvg(pass, payloadUrl) {
  const tier = TIERS[pass.tier] || TIERS.standard;
  const accent = tier.accent;

  const notchY = LAYOUT.perforation;
  const outline = ticketOutline(WIDTH, HEIGHT, 40, notchY, LAYOUT.notchRadius);

  const titleLines = wrapTitle(pass.event_name, 52, WIDTH - 112, 2);
  const titleY = LAYOUT.titleTop;

  const qrPanel = {
    x: (WIDTH - LAYOUT.qrPanel.size) / 2,
    y: LAYOUT.qrPanel.top,
    size: LAYOUT.qrPanel.size,
  };
  const qrSize = qrPanel.size - 24;

  const serial = String(pass.serial ?? 0).padStart(3, '0');

  // Le nom et le numéro partagent la même ligne : le nom est coupé sur la
  // largeur qui reste, pas sur un nombre de caractères fixe. Sinon un nom
  // composé passe par-dessus le numéro de place.
  const serialWidth = approximateWidth(`Nº ${serial}`, 30, 700);
  const guestRoom = WIDTH - 112 - serialWidth - 24;
  const guest = truncate(pass.guest_name || 'Invité·e', Math.floor(guestRoom / (34 * 0.58)));

  const meta = [pass.event_date, pass.event_place].filter(Boolean).join('  ·  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="Place pour ${escapeXml(pass.event_name)}">
  <path d="${outline}" fill="${PULSE.bg}"/>
  <path d="${outline}" fill="none" stroke="${PULSE.line}" stroke-width="2"/>

  <!-- En-tête : marque à gauche, palier à droite -->
  ${logoMark(56, 56, 52, accent)}
  <text x="122" y="97" font-family="${FONT_STACK}" font-size="30" font-weight="800" fill="${PULSE.white}" letter-spacing="-0.5">twitninf</text>
  <rect x="${WIDTH - 56 - tierWidth(tier.label)}" y="60" width="${tierWidth(tier.label)}" height="44" rx="22" fill="${accent}"/>
  <text x="${WIDTH - 56 - tierWidth(tier.label) / 2}" y="89" text-anchor="middle" font-family="${FONT_STACK}" font-size="19" font-weight="800" fill="${tier.onAccent}" letter-spacing="1.6">${escapeXml(tier.label.toUpperCase())}</text>

  <!-- Nature du document, avant même le nom de l'événement -->
  <text x="56" y="168" font-family="${FONT_STACK}" font-size="18" font-weight="700" fill="${accent}" letter-spacing="3.4">INVITATION</text>

  ${titleLines.map((line, index) => (
    `<text x="56" y="${titleY + index * LAYOUT.titleLead}" font-family="${FONT_STACK}" font-size="52" font-weight="800" fill="${PULSE.white}" letter-spacing="-1">${escapeXml(line)}</text>`
  )).join('\n  ')}

  ${meta ? `<text x="56" y="${titleY + titleLines.length * LAYOUT.titleLead + 4}" font-family="${FONT_STACK}" font-size="22" font-weight="600" fill="${PULSE.muted}">${escapeXml(meta)}</text>` : ''}

  <!-- Panneau clair : les modules sombres sur fond clair, jamais l'inverse -->
  <rect x="${qrPanel.x}" y="${qrPanel.y}" width="${qrPanel.size}" height="${qrPanel.size}" rx="32" fill="${PULSE.paper}"/>
  ${renderQrBlock(payloadUrl, {
    size: qrSize,
    x: qrPanel.x + (qrPanel.size - qrSize) / 2,
    y: qrPanel.y + (qrPanel.size - qrSize) / 2,
    accent,
  })}

  <text x="${WIDTH / 2}" y="${LAYOUT.hint}" text-anchor="middle" font-family="${FONT_STACK}" font-size="20" font-weight="600" fill="${PULSE.muted}">À présenter à l’entrée</text>

  <!-- Perforation -->
  <line x1="34" y1="${notchY}" x2="${WIDTH - 34}" y2="${notchY}" stroke="rgba(255,255,255,0.22)" stroke-width="2" stroke-dasharray="2 12" stroke-linecap="round"/>

  <!-- Souche : deux colonnes, l'invité à gauche, le numéro à droite -->
  <text x="56" y="${notchY + 60}" font-family="${FONT_STACK}" font-size="16" font-weight="700" fill="${PULSE.muted}" letter-spacing="2.6">INVITÉ·E</text>
  <text x="56" y="${notchY + 104}" font-family="${FONT_STACK}" font-size="34" font-weight="800" fill="${PULSE.white}">${escapeXml(guest)}</text>

  <text x="${WIDTH - 56}" y="${notchY + 60}" text-anchor="end" font-family="${FONT_STACK}" font-size="16" font-weight="700" fill="${PULSE.muted}" letter-spacing="2.6">PLACE</text>
  <text x="${WIDTH - 56}" y="${notchY + 104}" text-anchor="end" font-family="${MONO_STACK}" font-size="30" font-weight="700" fill="${accent}">Nº ${escapeXml(serial)}</text>

  <text x="56" y="${notchY + 152}" font-family="${FONT_STACK}" font-size="16" font-weight="700" fill="${PULSE.muted}" letter-spacing="2.6">CODE</text>
  <text x="56" y="${notchY + 190}" font-family="${MONO_STACK}" font-size="26" font-weight="700" fill="${PULSE.white}" letter-spacing="2">${escapeXml(pass.code)}</text>

  <rect x="56" y="${HEIGHT - 84}" width="${WIDTH - 112}" height="2" fill="${PULSE.line}"/>
  <text x="56" y="${HEIGHT - 42}" font-family="${FONT_STACK}" font-size="17" font-weight="600" fill="${PULSE.muted}">Une place, une entrée. Le code est unique et vérifié.</text>
</svg>`;
}

function tierWidth(label) {
  return Math.max(96, Math.round(approximateWidth(label.toUpperCase(), 19, 800) + label.length * 1.6 + 44));
}

/**
 * Code QR seul, sur fond clair — pour l'affichage plein écran dans l'app au
 * moment de passer l'entrée, quand la place entière n'apporte plus rien.
 */
function renderQrOnlySvg(payloadUrl, options = {}) {
  const size = options.size || 560;
  const accent = options.accent || PULSE.magenta;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" rx="${round(size * 0.06)}" fill="${PULSE.paper}"/>
  ${renderQrBlock(payloadUrl, { size, accent, logo: options.logo !== false })}
</svg>`;
}

module.exports = {
  renderPassSvg,
  renderQrOnlySvg,
  renderQrBlock,
  logoMark,
  escapeXml,
  PULSE,
  TIERS,
  WIDTH,
  HEIGHT,
};
