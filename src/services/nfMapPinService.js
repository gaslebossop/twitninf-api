'use strict';

/**
 * 📍 Épingles de la Carte NF, rendues en PNG côté serveur.
 *
 * ── Pourquoi le serveur dessine les épingles ──
 * Parce que l'app ne peut plus les dessiner. Un `<Marker>` de
 * `react-native-maps` dont le contenu est un arbre de vues React passe par la
 * couche d'interopérabilité de Fabric, et les mainteneurs de la bibliothèque
 * l'écrivent noir sur blanc : cette couche « ne fonctionne pas pour les
 * composants personnalisés ayant des composants enfants personnalisés »
 * (MapView → Marker → enfants). Le crash tombe dans `insertReactSubview:` /
 * `removeReactSubview:`, côté natif, sans une ligne de log JS — à chaque zoom,
 * à chaque arrivée de quelqu'un.
 *
 * La correction officielle — désactiver la Nouvelle Architecture — est fermée
 * à cette app : `react-native-reanimated@4` et les modules Nitro l'exigent.
 * Reste le seul chemin que la bibliothèque garantit : un marqueur SANS enfant,
 * avec une simple image. D'où ce fichier.
 *
 * ── Pourquoi ici, et pas dans l'app ──
 * Composer l'image sur l'appareil demanderait une dépendance native de capture
 * de vue, que le client Expo Go ne contient pas. Ici, `sharp` est déjà
 * installé, le résultat est mis en cache par le CDN, et une même épingle est
 * calculée une fois pour tous les téléphones qui la regardent.
 *
 * ── Ce que l'image contient, et ce qu'elle ne contient pas ──
 * L'avatar et le pseudo, tous deux déjà publics sur le profil. AUCUNE position :
 * l'image ne dit pas où se trouve la personne, seulement à quoi elle ressemble.
 * C'est ce qui permet de servir la route sans jeton — voir la route elle-même.
 */

const sharp = require('sharp');

const { getPublicMediaOrigin, rewriteMediaUrl } = require('../utils/publicMediaOrigin');
const logger = require('../utils/logger');

/**
 * Géométrie, en POINTS — l'unité de l'écran, pas du fichier.
 *
 * Le client demande l'épingle en `points × densité` : iOS charge l'image avec
 * `scale: RCTScreenScale()`, Android dessine le bitmap à sa taille en pixels.
 * Les deux plateformes veulent donc la même chose, et ces nombres décrivent ce
 * qu'on VOIT, quel que soit le téléphone.
 *
 * ⚠️ `ANCHOR_Y` est repris tel quel côté app. Un marqueur est ancré sur le
 * point exact qu'il désigne : ici la pointe, pas le bas de l'image — sous la
 * pointe il reste l'étiquette du pseudo. Ancrer en bas décalerait tout le monde
 * vers le nord de la hauteur de son étiquette.
 */
const PIN = {
  width: 96,
  ring: 46,
  ringStroke: 3,
  tip: 8,
  labelGap: 3,
  labelHeight: 17,
};
PIN.height = PIN.ring + PIN.tip + PIN.labelGap + PIN.labelHeight;
PIN.anchorY = (PIN.ring + PIN.tip) / PIN.height;

const CLUSTER = {
  width: 108,
  face: 40,
  faceStroke: 2.5,
  /** Chevauchement, comme une pile de jetons. */
  overlap: 0.42,
  labelGap: 3,
  labelHeight: 17,
  maxFaces: 3,
};
CLUSTER.height = CLUSTER.face + CLUSTER.labelGap + CLUSTER.labelHeight;
/** Un groupe n'a pas de pointe : il se centre sur le barycentre des siens. */
CLUSTER.anchorY = CLUSTER.face / CLUSTER.height;

/** Densités servies. Au-delà, on ne gagne plus rien de visible. */
const MIN_DENSITY = 1;
const MAX_DENSITY = 4;

const COLORS = {
  white: '#FFFFFF',
  accent: '#1D9BF0',
  approximate: '#E4E4E4',
  muted: '#7A7A7A',
  labelBg: '#0A0A0A',
  labelBorder: 'rgba(255,255,255,0.22)',
  labelText: '#FFFFFF',
  placeholderFrom: '#1D9BF0',
  placeholderTo: '#8B5CF6',
};

/**
 * Pile de polices, dans l'ordre des chances de la trouver.
 *
 * Le rendu SVG de `sharp` passe par fontconfig : une police absente ne lève
 * pas d'erreur, elle dessine du vide. DejaVu Sans est présente sur toutes les
 * images Debian, qui portent la quasi-totalité des déploiements Node.
 */
const FONT_STACK = 'DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif';

/** Le texte entre dans du XML : les chevrons et esperluettes doivent sortir. */
function escapeXml(value) {
  return String(value == null ? '' : value).replace(/[<>&'"]/g, (character) => {
    switch (character) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case "'": return '&apos;';
      default: return '&quot;';
    }
  });
}

/**
 * Est-ce une image que CE serveur a émise ?
 *
 * ── Pourquoi cette question se pose ──
 * La colonne `avatar` est une URL libre : le modèle `User` ne valide que sa
 * forme. Aller la chercher depuis le serveur, c'est offrir à n'importe quel
 * compte une requête sortante émise par notre infrastructure, vers l'adresse de
 * son choix — un service de métadonnées interne, par exemple. Le client, lui,
 * charge cette URL depuis le téléphone de son propriétaire : ça n'a jamais
 * engagé le serveur, et c'est cette différence-là qui compte.
 *
 * Une URL étrangère n'est donc pas chargée. L'épingle retombe sur l'initiale
 * sur fond dégradé, exactement ce que fait déjà le composant `Avatar` de l'app
 * quand elle n'a pas d'image.
 */
function isOwnMediaUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  try {
    const origin = new URL(getPublicMediaOrigin());
    return parsed.host === origin.host;
  } catch {
    return false;
  }
}

const AVATAR_FETCH_TIMEOUT_MS = 2500;
const AVATAR_MAX_BYTES = 4 * 1024 * 1024;

/** L'avatar, en octets — ou `null`, ce qui n'est jamais une erreur. */
async function fetchAvatarBytes(url) {
  // Normalise d'abord vers le domaine public COURANT. Les épingles chargent
  // l'avatar par SQL brut (pas via le toJSON du modèle), donc sans le
  // `rewriteMediaUrl` que celui-ci applique : un avatar stocké sous un ancien
  // domaine (`twitninf.duckdns.org/static/avatars/…`) gardait cet hôte, que
  // `isOwnMediaUrl` rejette depuis le passage à `api.twitninf.fr` — d'où des
  // épingles vides pour tous les comptes sauf ceux dont l'avatar venait d'être
  // réuploadé. Le fichier vit toujours au même chemin `/static/avatars/…` sur
  // le VPS A ; seul l'hôte devait être réécrit.
  const normalized = rewriteMediaUrl(url);
  if (!isOwnMediaUrl(normalized)) return null;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), AVATAR_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(normalized, { signal: abort.signal, redirect: 'error' });
    if (!response.ok) return null;

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > AVATAR_MAX_BYTES) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    // Un en-tête peut mentir : on revérifie sur ce qu'on a réellement reçu.
    return buffer.byteLength > AVATAR_MAX_BYTES ? null : buffer;
  } catch {
    // Réseau, délai, redirection : l'épingle se contentera de l'initiale.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Couleur de repli, tirée du pseudo — deux comptes voisins ne se confondent pas. */
function placeholderFor(username, size, initial) {
  const seed = String(username || '?')
    .split('')
    .reduce((total, character) => total + character.charCodeAt(0), 0);
  const hue = seed % 360;

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <defs>
         <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
           <stop offset="0%" stop-color="hsl(${hue},72%,58%)"/>
           <stop offset="100%" stop-color="hsl(${(hue + 40) % 360},72%,42%)"/>
         </linearGradient>
       </defs>
       <rect width="${size}" height="${size}" fill="url(#g)"/>
       <text x="${size / 2}" y="${size / 2}" font-family="${FONT_STACK}"
             font-size="${Math.round(size * 0.44)}" font-weight="700" fill="#FFFFFF"
             text-anchor="middle" dominant-baseline="central">${escapeXml(initial)}</text>
     </svg>`
  );
}

/**
 * Un avatar carré ramené à un disque plein de `size` pixels.
 *
 * Le masque est appliqué en `dest-in` : l'image garde ses couleurs et ne
 * conserve que l'opacité du disque. Découper au rognage laisserait les coins.
 */
async function renderRoundAvatar(bytes, username, size) {
  const initial = String(username || 'U').trim().charAt(0).toUpperCase() || 'U';
  const source = bytes || placeholderFor(username, size, initial);

  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#FFFFFF"/>
     </svg>`
  );

  try {
    return await sharp(source)
      .resize(size, size, { fit: 'cover', position: 'attention' })
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
  } catch (error) {
    // Fichier illisible ou format exotique : l'initiale plutôt qu'un trou.
    logger.warn(`[nfMapPin] avatar illisible (${error.message})`);
    return sharp(placeholderFor(username, size, initial))
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
  }
}

/** Pastille sombre du bas, qui porte le pseudo ou le décompte. */
function labelSvg(text, { canvasWidth, top, height, maxWidth }) {
  const clean = escapeXml(text);
  if (!clean) return '';

  // Largeur estimée : la police n'est mesurable qu'au rendu, mais 0,58 em par
  // caractère approche de près une graisse demi-grasse à cette taille.
  const fontSize = 10;
  const estimated = Math.min(maxWidth, Math.round(clean.length * fontSize * 0.58) + 16);
  const x = (canvasWidth - estimated) / 2;

  return `
    <rect x="${x}" y="${top}" width="${estimated}" height="${height}" rx="${height / 2}"
          fill="${COLORS.labelBg}" stroke="${COLORS.labelBorder}" stroke-width="0.5"/>
    <text x="${canvasWidth / 2}" y="${top + height / 2}" font-family="${FONT_STACK}"
          font-size="${fontSize}" font-weight="600" fill="${COLORS.labelText}"
          text-anchor="middle" dominant-baseline="central">${clean}</text>`;
}

function clampDensity(value) {
  const density = Number(value);
  if (!Number.isFinite(density)) return 2;
  return Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, Math.round(density)));
}

/**
 * Épingle d'une personne.
 *
 * `variant` reprend les signaux de l'ancienne épingle dessinée dans l'app :
 *   - `city`     : anneau discontinu. Sans lui, une position arrondie à
 *                  l'agglomération se lit comme une adresse ;
 *   - `selected` : anneau à la couleur d'accent, épingle en cours de lecture ;
 *   - `self`     : c'est moi ;
 *   - `ghost`    : c'est moi, et personne d'autre ne me voit.
 */
async function renderPersonPin({ username, avatar, label, variant = 'precise', density = 2 }) {
  const scale = clampDensity(density);
  const width = PIN.width;
  const { ring, ringStroke, tip, labelGap, labelHeight, height } = PIN;

  const centerX = width / 2;
  const ringRadius = (ring - ringStroke) / 2;
  const ringCenterY = ring / 2;

  const ghost = variant === 'ghost';
  let strokeColor = COLORS.white;
  if (variant === 'selected' || variant === 'self') strokeColor = COLORS.accent;
  else if (variant === 'city') strokeColor = COLORS.approximate;
  else if (ghost) strokeColor = COLORS.muted;

  const dashed = variant === 'city' || ghost;
  const tipColor = variant === 'selected' || variant === 'self' ? COLORS.accent : COLORS.white;

  const chrome = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.35"/>
        </filter>
      </defs>
      <g filter="url(#shadow)" opacity="${ghost ? 0.7 : 1}">
        <circle cx="${centerX}" cy="${ringCenterY}" r="${ringRadius}"
                fill="${COLORS.white}"/>
        <path d="M ${centerX - 5} ${ring - 1} L ${centerX + 5} ${ring - 1} L ${centerX} ${ring + tip - 1} Z"
              fill="${tipColor}"/>
      </g>
      <circle cx="${centerX}" cy="${ringCenterY}" r="${ringRadius}" fill="none"
              stroke="${strokeColor}" stroke-width="${ringStroke}"
              ${dashed ? 'stroke-dasharray="6 5"' : ''} opacity="${ghost ? 0.75 : 1}"/>
      ${labelSvg(label, {
        canvasWidth: width,
        top: ring + tip + labelGap,
        height: labelHeight,
        maxWidth: width,
      })}
    </svg>`;

  // L'avatar tient à l'intérieur de l'anneau, sans mordre dessus.
  const innerSize = Math.round(ring - ringStroke * 2);
  const avatarBytes = await fetchAvatarBytes(avatar);
  const face = await renderRoundAvatar(avatarBytes, username, innerSize * scale);

  return sharp(Buffer.from(chrome), { density: 72 * scale })
    .resize(width * scale, height * scale, { fit: 'fill' })
    .composite([
      {
        input: face,
        left: Math.round((width - innerSize) / 2) * scale,
        top: Math.round(ringStroke) * scale,
      },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Épingle d'un groupe : QUI est là, pas seulement combien.
 *
 * Une pastille chiffrée anonyme oblige à zoomer pour savoir si le groupe vaut
 * le détour. Trois visages empilés et un « +4 » répondent tout de suite, et
 * c'est la seule façon de reconnaître un ami dans une ville où l'on en a
 * plusieurs.
 */
async function renderClusterPin({ faces = [], count = 0, density = 2 }) {
  const scale = clampDensity(density);
  const { width, face: faceSize, faceStroke, labelGap, labelHeight, height, overlap, maxFaces } =
    CLUSTER;

  const shown = faces.slice(0, maxFaces);
  const rest = Math.max(0, count - shown.length);
  const badges = shown.length + (rest > 0 ? 1 : 0);

  const step = faceSize * (1 - overlap);
  const rowWidth = faceSize + step * (badges - 1);
  const startX = (width - rowWidth) / 2;
  const centerY = faceSize / 2;
  const radius = (faceSize - faceStroke) / 2;

  const circles = [];
  for (let index = 0; index < badges; index += 1) {
    const cx = startX + faceSize / 2 + step * index;
    const isRest = index === shown.length;
    circles.push(`
      <circle cx="${cx}" cy="${centerY}" r="${radius}"
              fill="${isRest ? COLORS.accent : COLORS.white}"
              stroke="${COLORS.white}" stroke-width="${faceStroke}"/>`);
    if (isRest) {
      circles.push(`
        <text x="${cx}" y="${centerY}" font-family="${FONT_STACK}" font-size="13"
              font-weight="700" fill="#FFFFFF" text-anchor="middle"
              dominant-baseline="central">+${rest > 99 ? 99 : rest}</text>`);
    }
  }

  const chrome = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity="0.3"/>
        </filter>
      </defs>
      <g filter="url(#shadow)">${circles.join('')}</g>
      ${labelSvg(`${count} personnes`, {
        canvasWidth: width,
        top: faceSize + labelGap,
        height: labelHeight,
        maxWidth: width,
      })}
    </svg>`;

  const innerSize = Math.round(faceSize - faceStroke * 2);
  const composites = [];
  for (let index = 0; index < shown.length; index += 1) {
    const person = shown[index];
    const bytes = await fetchAvatarBytes(person.avatar);
    composites.push({
      input: await renderRoundAvatar(bytes, person.username, innerSize * scale),
      left: Math.round(startX + step * index + faceStroke) * scale,
      top: Math.round(faceStroke) * scale,
    });
  }

  return sharp(Buffer.from(chrome), { density: 72 * scale })
    .resize(width * scale, height * scale, { fit: 'fill' })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

module.exports = {
  PIN,
  CLUSTER,
  MAX_DENSITY,
  renderPersonPin,
  renderClusterPin,
  // Exportés pour les tests : ce sont eux qui portent la règle de sécurité.
  isOwnMediaUrl,
  clampDensity,
  escapeXml,
};
