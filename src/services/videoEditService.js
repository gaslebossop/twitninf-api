const fs = require('fs');
const path = require('path');

/**
 * Habillage vidéo — textes incrustés, étalonnage, coupure du son.
 *
 * Le rendu se fait ICI et non sur le téléphone. L'app enverrait sinon une
 * vidéo déjà réencodée, que `videoService` réencoderait une seconde fois :
 * deux générations de compression pour un résultat visiblement plus sale.
 * ffmpeg tourne déjà sur ce serveur pour le transcodage 720p — incruster
 * pendant cette passe ne coûte donc presque rien de plus.
 *
 * Conséquence : l'éditeur du téléphone est un APERÇU. Les coordonnées et
 * tailles voyagent en fractions du cadre (0..1), jamais en pixels, pour que
 * l'aperçu et le rendu coïncident quelle que soit la taille de l'écran.
 */

/** Cadre de sortie imposé par `videoService` (vertical 720p). */
const FRAME_WIDTH = 720;
const FRAME_HEIGHT = 1280;

/**
 * Police d'incrustation. DejaVu est présente sur toute Debian ; on vérifie
 * quand même son existence, car une `fontfile` absente fait échouer ffmpeg
 * avec une erreur qui ne mentionne pas la police.
 */
const FONT_CANDIDATES = [
  // Montserrat d'abord : géométrique et lourde, c'est la plus proche du texte
  // TikTok parmi les polices packagées Debian — et surtout, l'app embarque la
  // MÊME famille (@expo-google-fonts/montserrat), donc l'aperçu du téléphone
  // et le rendu du serveur dessinent les mêmes lettres. DejaVu, elle, est
  // large et neutre : le rendu ne ressemblait à rien de connu.
  //
  // Bold AVANT ExtraBold : l'app n'embarque que le poids 700 (voir
  // `displayNameFonts.geometric`), et React Native ne synthétise pas les
  // graisses d'une police custom. Rendre en ExtraBold élargissait les mots
  // d'environ 3 % par rapport à l'aperçu — assez pour qu'une ligne juste à
  // l'écran passe à deux dans la vidéo.
  '/usr/share/fonts/truetype/montserrat/Montserrat-Bold.ttf',
  '/usr/share/fonts/truetype/montserrat/Montserrat-ExtraBold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

let cachedFont;
function resolveFont() {
  if (cachedFont !== undefined) return cachedFont;
  cachedFont = FONT_CANDIDATES.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) || null;
  return cachedFont;
}

/**
 * Étalonnages disponibles.
 *
 * Chaque entrée a son équivalent d'aperçu côté app (voir `videoFilters.ts`) :
 * les deux listes doivent rester alignées, sinon l'utilisateur choisit un
 * rendu et en obtient un autre.
 */
const FILTERS = {
  none: null,
  // Les clés correspondent une à une aux CIFilter qu'`react-native-video`
  // applique en aperçu sur iOS (voir `videoFilters.ts` côté app). C'est ce qui
  // permet à l'utilisateur de voir avant de publier ce qu'il obtiendra :
  // choisir dans une liste et recevoir autre chose serait pire que de ne pas
  // proposer de filtre du tout.
  chrome: 'eq=saturation=1.45:contrast=1.12',
  fade: 'eq=saturation=0.72:contrast=0.9:brightness=0.06',
  instant: 'colorbalance=rs=.12:gs=.03:bs=-.08,eq=contrast=1.05:saturation=0.9',
  mono: 'hue=s=0',
  noir: 'hue=s=0,eq=contrast=1.35:brightness=-0.03',
  process: 'colortemperature=temperature=4200:mix=0.85',
  sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  tonal: 'hue=s=0,eq=contrast=0.92',
  transfer: 'colortemperature=temperature=8500:mix=0.85',
};

/**
 * Le texte n'est PAS passé en ligne à `drawtext`, mais écrit dans un fichier
 * lu via `textfile=`.
 *
 * L'échappement en ligne a été essayé sous trois formes, toutes vérifiées par
 * un rendu réel — aucune ne tient. ffmpeg analyse la chaîne de filtres à
 * plusieurs niveaux, et l'apostrophe est irrécupérable : échappée en `\'`,
 * elle est consommée par le premier analyseur puis OUVRE une section citée
 * au second, qui avale toutes les options suivantes. Le résultat s'encodait
 * sans la moindre erreur et affichait
 * « Cest: 100% fou, non?:fontcolor=0xFFCC00:fontsize=26… » incrusté dans la
 * vidéo. Un test qui ne regarde que le code de sortie ne voit rien.
 *
 * Avec `textfile`, ffmpeg lit le contenu verbatim : plus aucun caractère n'est
 * structurant, et la question disparaît au lieu d'être contournée.
 */
function overlayTextPath(workDir, videoId, index) {
  // Préfixé par la vidéo : deux encodages simultanés partageraient sinon le
  // même `ovl_0.txt`, et le second écraserait le texte du premier en pleine
  // lecture par ffmpeg.
  return path.join(workDir, `ovl_${videoId}_${index}.txt`);
}

/**
 * `#RRGGBB` → `0xRRGGBB`, refusé sinon (pas de couleur arbitraire).
 *
 * Accepte aussi la forme déjà normalisée : `parseEdit` assainit à l'entrée et
 * `buildVideoFilters` réassainit par sécurité. Sans ce cas, la seconde passe
 * ne reconnaissait plus `0xFFCC00` et repeignait tous les textes en blanc.
 *
 * L'alpha est admis dans les deux écritures — `#RRGGBBAA` côté app, `@0.53`
 * côté ffmpeg. L'app envoie son pavé translucide en `#00000088` : sans ce
 * cas, la chaîne était REJETÉE et retombait sur le noir opaque du repli, donc
 * un pavé plein là où l'aperçu en montrait un translucide.
 */
function normalizeColor(value, fallback) {
  const raw = String(value || '').trim();

  const already = /^0x([0-9a-f]{6})(?:@(0(?:\.\d+)?|1(?:\.0+)?))?$/i.exec(raw);
  if (already) {
    return already[2] ? `0x${already[1].toUpperCase()}@${already[2]}` : `0x${already[1].toUpperCase()}`;
  }

  const hex = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(raw);
  if (!hex) return fallback;
  const rgb = `0x${hex[1].toUpperCase()}`;
  if (!hex[2]) return rgb;
  return `${rgb}@${(parseInt(hex[2], 16) / 255).toFixed(2)}`;
}

/**
 * Largeur moyenne d'un caractère de DejaVu Sans Bold, en fraction de la
 * hauteur de police. Mesurée grossièrement — il ne s'agit pas de composer au
 * pixel près, seulement d'empêcher un texte de sortir du cadre.
 */
/**
 * Alignement des lignes ENTRE ELLES — pas la position du bloc, qui reste
 * donnée par `x`. Les valeurs sont celles attendues par `text_align`.
 */
const ALIGN_MAP = { left: 'L', center: 'C', right: 'R' };

const GLYPH_WIDTH_RATIO = 0.58;

/** Marge latérale conservée de chaque côté, en fraction de la largeur. */
const SIDE_MARGIN = 0.06;

/**
 * Marge du pavé de fond autour du texte, en fraction de la taille de police.
 * Doit rester égale à `BOX_PADDING_RATIO` côté app (`videoFilters.ts`).
 */
const BOX_PADDING_RATIO = 0.22;

/**
 * Taille de police demandée, en pixels du cadre de sortie.
 *
 * On ne rapetisse plus pour faire tenir : TikTok garde la taille choisie et
 * passe à la ligne. Rapetisser donnait un texte minuscule dès qu'il était un
 * peu long, alors que l'utilisateur avait justement choisi « gros ».
 */
function fitFontSize(text, sizeFraction) {
  return Math.max(16, Math.round(sizeFraction * FRAME_HEIGHT));
}

/**
 * Découpe le texte en lignes qui tiennent dans le cadre.
 *
 * `drawtext` respecte les sauts de ligne du fichier mais ne replie jamais de
 * lui-même : un texte long sortait simplement de l'image. On coupe donc aux
 * espaces, et seulement au milieu d'un mot s'il est à lui seul trop large.
 * La même fonction existe côté app pour que l'aperçu montre les mêmes
 * coupures.
 */
function wrapText(text, fontSize) {
  const usableWidth = FRAME_WIDTH * (1 - 2 * SIDE_MARGIN);
  const maxChars = Math.max(6, Math.floor(usableWidth / (fontSize * GLYPH_WIDTH_RATIO)));

  const lines = [];
  let current = '';

  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // Mot plus large que la ligne : on le tronçonne, sinon il déborderait.
    if (word.length > maxChars) {
      let rest = word;
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      current = rest;
    } else {
      current = word;
    }
  }
  if (current) lines.push(current);

  return lines.slice(0, 6).join('\n'); // au-delà, le texte mange la vidéo
}

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Normalise ce qui vient du client.
 *
 * Rien n'est repris tel quel : ces valeurs finissent dans une ligne de
 * commande ffmpeg. Une taille absurde ou une couleur inventée doit produire
 * un défaut, jamais une chaîne de filtres malformée.
 */
function sanitizeOverlays(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .slice(0, 10) // au-delà, c'est du bruit — et une ligne de commande énorme
    .map((item) => {
      const text = String(item?.text ?? '').trim().slice(0, 120);
      if (!text) return null;
      return {
        text,
        // Fractions du cadre : l'aperçu du téléphone parle le même langage.
        x: clamp(item?.x, 0, 1, 0.5),
        y: clamp(item?.y, 0, 1, 0.5),
        size: clamp(item?.size, 0.02, 0.2, 0.055),
        color: normalizeColor(item?.color, '0xFFFFFF'),
        background: item?.background ? normalizeColor(item.background, '0x000000') : null,
        align: ALIGN_MAP[item?.align] ? item.align : 'center',
      };
    })
    .filter(Boolean);
}

/**
 * Construit les filtres vidéo à ajouter APRÈS le redimensionnement.
 *
 * L'ordre compte : incruster avant le `crop` placerait le texte d'après un
 * cadre qui n'existe plus dans le fichier final.
 */
function buildVideoFilters(edit = {}, workDir = null, videoId = 'x') {
  const filters = [];

  const grade = FILTERS[edit.filter] || null;
  if (grade) filters.push(grade);

  const font = resolveFont();
  const overlays = sanitizeOverlays(edit.overlays);

  // Sans police ou sans dossier de travail, on publie la vidéo SANS les
  // textes plutôt que d'échouer : perdre l'habillage est moins grave que
  // perdre la vidéo.
  if (!overlays.length || !font || !workDir) return filters;

  overlays.forEach((overlay, index) => {
    const fontSize = fitFontSize(overlay.text, overlay.size);
    const target = overlayTextPath(workDir, videoId, index);
    try {
      // Sans saut de ligne final : ffmpeg le rendrait comme une ligne vide,
      // ce qui décale visiblement le texte vers le haut.
      fs.writeFileSync(target, wrapText(overlay.text, fontSize), 'utf8');
    } catch {
      return; // ce texte-là saute, les autres restent
    }

    const options = [
      `fontfile=${font}`,
      `textfile=${target}`,
      // `expansion=none` reste utile : le CONTENU du fichier serait sinon
      // parcouru pour y développer `%{...}` (date, métadonnées).
      'expansion=none',
      `fontcolor=${overlay.color}`,
      `fontsize=${fontSize}`,
      // Lignes centrées les unes sous les autres, comme sur TikTok — le défaut
      // de drawtext les aligne à gauche, ce qui fait « sous-titre » et non
      // « habillage ».
      `text_align=${ALIGN_MAP[overlay.align] || 'C'}`,
      `line_spacing=${Math.round(fontSize * 0.18)}`,
      // `(w-text_w)*x` centre le texte sur le point choisi au lieu de
      // l'ancrer par son coin : un texte long déborderait sinon à droite.
      `x=(w-text_w)*${overlay.x.toFixed(4)}`,
      `y=(h-text_h)*${overlay.y.toFixed(4)}`,
    ];

    /**
     * Lisibilité : soit un pavé de fond, soit un relief — jamais les deux.
     *
     * Le pavé (`box=1`) avait été abandonné pour une raison esthétique : ses
     * angles sont droits alors que ceux de TikTok sont arrondis, et drawtext
     * ne sait pas arrondir. Sauf que l'éditeur du téléphone, lui, propose le
     * pavé et va jusqu'à repeindre le texte en NOIR quand on choisit le pavé
     * blanc. Sans pavé au rendu, ce texte noir se retrouvait posé à nu sur une
     * vidéo souvent sombre : illisible. Un aperçu qui ment sur la couleur
     * finale est un défaut bien plus grave qu'un angle droit — le pavé revient
     * donc, et c'est l'app qui adoucit à peine ses angles pour coller.
     *
     * Sans pavé : ombre portée et contour volontairement FIN. Un contour épais
     * (7 % de la taille) avait été essayé : les traits des lettres voisines se
     * rejoignaient et le mot devenait une masse, tandis que le trait du
     * premier caractère se faisait rogner à plat — drawtext dessine le contour
     * à l'intérieur de la boîte de texte, sans marge. Le `j` de « jaune »
     * paraissait coupé.
     */
    if (overlay.background) {
      options.push(
        'box=1',
        `boxcolor=${overlay.background}`,
        `boxborderw=${Math.max(2, Math.round(fontSize * BOX_PADDING_RATIO))}`,
      );
    } else {
      options.push(
        `borderw=${Math.max(1, Math.round(fontSize * 0.025))}`,
        'bordercolor=0x000000@0.35',
        'shadowcolor=0x000000@0.5',
        `shadowx=${Math.max(1, Math.round(fontSize * 0.035))}`,
        `shadowy=${Math.max(2, Math.round(fontSize * 0.045))}`,
      );
    }

    filters.push(`drawtext=${options.join(':')}`);
  });

  return filters;
}

/** Efface les fichiers texte d'une incrustation une fois l'encodage fini. */
function cleanupOverlayFiles(workDir, videoId, count = 10) {
  if (!workDir) return;
  for (let index = 0; index < count; index += 1) {
    try { fs.unlinkSync(overlayTextPath(workDir, videoId, index)); } catch { /* déjà absent */ }
  }
}

/** Le son doit-il être supprimé de la sortie ? */
function isMuted(edit = {}) {
  return edit.muted === true || edit.muted === 'true' || edit.muted === 1 || edit.muted === '1';
}

/** Normalise le bloc d'édition reçu du client, pour journalisation et usage. */
function parseEdit(source = {}) {
  const filter = Object.prototype.hasOwnProperty.call(FILTERS, source.filter) ? source.filter : 'none';
  return {
    muted: isMuted(source),
    filter,
    overlays: sanitizeOverlays(source.overlays),
  };
}

module.exports = {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  FILTERS,
  buildVideoFilters,
  cleanupOverlayFiles,
  fitFontSize,
  wrapText,
  GLYPH_WIDTH_RATIO,
  SIDE_MARGIN,
  BOX_PADDING_RATIO,
  isMuted,
  parseEdit,
  sanitizeOverlays,
  resolveFont,
};
