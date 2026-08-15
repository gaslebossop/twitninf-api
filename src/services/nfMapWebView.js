'use strict';

/**
 * 🗺️ Le fond de la Carte NF, servi comme une page.
 *
 * ── Pourquoi une page, et pas une carte native ──
 * `react-native-maps` est figé à 1.20.1 par Expo Go (voir `app.config.js` côté
 * app) : une version antérieure au support Fabric, alors que la Nouvelle
 * Architecture est obligatoire dans cette app. Monter ou démonter un `<Marker>`
 * y fait tomber le natif sur `insertReactSubview:` / `insertObject:atIndex:`,
 * sans une ligne de log JS. Tout `NfMapCanvas` était une architecture de
 * contournement autour de ça — pool de marqueurs jamais démontés, positions
 * accumulées à vie.
 *
 * La contrainte « Expo Go doit rester complet » interdit de changer de
 * bibliothèque native. Reste un moteur de carte qui ne demande aucun module
 * natif nouveau : MapLibre GL JS dans une `WebView`. `react-native-webview` est
 * déjà dans `package.json` en 13.15.0, **exactement** la version du binaire
 * d'Expo Go — donc rien à installer, et la classe de crash disparaît avec
 * `react-native-maps`.
 *
 * ── Ce que cette page N'EST PAS ──
 * Elle ne contient aucune donnée. Pas une position, pas un pseudo, pas un
 * jeton. C'est un moteur de rendu vide : l'app lui pousse les marqueurs par
 * `postMessage` après les avoir chargés elle-même, avec son propre jeton, comme
 * avant. Le modèle de confidentialité de la carte n'est donc pas touché — c'est
 * la condition qui permet de servir cette page sans authentification, comme les
 * épingles (voir le commentaire de `pinLimiter` dans `nfMapRoutes`).
 *
 * ── Pourquoi la clé du fournisseur de tuiles ne descend jamais ──
 * Le style d'origine porte la clé dans ses URLs. On le récupère ICI, on en
 * réécrit les sources vers nos propres routes, et l'appareil ne voit que
 * `https://<api>/api/nf-map/…`. Le proxy est FERMÉ : le client ne transmet
 * jamais une URL, seulement des coordonnées de tuile — sans quoi cette route
 * serait un proxy ouvert, donc une SSRF.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const logger = require('../utils/logger');

/**
 * Style d'origine, clé comprise.
 *
 * Un style sombre est attendu : l'app est noire, et le fond par défaut d'un
 * fournisseur est blanc cassé saturé de routes jaunes. Poser des avatars
 * dessus donnait une page qui ne ressemblait à aucune autre de l'app.
 *
 * Exemple : `https://api.maptiler.com/maps/dataviz-dark/style.json?key=…`
 *
 * Absent, la carte se rend en aplat sombre plutôt que de planter — voir
 * `resolveStyle`. Une carte vide est un défaut visible ; une exception au
 * milieu d'un écran ne l'est pas plus, et coûte un rapport de plantage.
 */
const STYLE_URL =
  process.env.NF_MAP_STYLE_URL ||
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

/**
 * ── Palette de la carte : celle de twitninf, pas celle du fournisseur ──
 *
 * Ces valeurs ne sont pas nouvelles. Elles viennent du `DARK_MAP_STYLE` de la
 * version native de `NfMapCanvas`, où elles ne s'appliquaient qu'à ANDROID :
 * Apple Maps ne lit aucune feuille de style, il suit `userInterfaceStyle`. Les
 * deux plateformes montraient donc deux cartes différentes. Ici c'est le même
 * moteur des deux côtés, et la palette vaut enfin partout.
 *
 * L'intention est inchangée : on garde les routes et l'eau lisibles, on éteint
 * tout le reste. Sur une carte de gens, le nom d'une pizzeria n'est que du
 * bruit derrière les visages.
 *
 * ⚠️ **Aucun magenta ici.** L'accent de la marque (`colors.accent`, #FE2C55)
 * est porté par les épingles, qui sont dessinées par `nfMapPinService`. En
 * mettre dans le fond ferait concurrence aux visages au lieu de les détacher :
 * le fond doit rester le plus muet possible.
 */
const PALETTES = {
  /**
   * Clair — pour quand l'app est en thème clair.
   *
   * Sans lui, la carte restait sombre quel que soit le thème, et tout ce qui
   * flotte au-dessus d'elle (barre de recherche, bouton de localisation, fiche
   * d'un groupe, feuille du bas) devenait une dalle blanche posée sur du noir.
   * Ce n'était pas la faute de ces éléments : c'était le fond qui ne suivait
   * personne.
   *
   * Terre légèrement grise et routes BLANCHES, à l'inverse du sombre : c'est ce
   * qui rend un réseau routier lisible sur fond clair, et c'est la convention
   * de toutes les cartes claires.
   */
  light: {
    land: '#EFEFF1',
    builtUp: '#E6E6EA',
    landcover: '#E9EFE7',
    park: '#DCE9DA',
    road: '#FFFFFF',
    highway: '#FFFFFF',
    water: '#C7DCEF',
    waterLabel: '#5B7C99',
    label: '#7A7A7E',
    labelHalo: '#FFFFFF',
    locality: '#3C3C40',
  },
  dark: {
  land: '#111111',
  builtUp: '#171717',
  park: '#141B14',
  /**
   * Le couvert végétal (bois, cultures, prairies) — PAS la couleur des parcs.
   *
   * Les deux ont partagé la même valeur, et ça ne se voyait pas à Paris : en
   * ville, `landcover` ne couvre presque rien. En pleine campagne il couvre
   * TOUT, et la carte devenait un damier de grandes taches vert foncé sur fond
   * noir — lu comme un défaut d'affichage, pas comme une forêt. Il lui faut
   * une teinte à peine détachée du sol.
   */
  landcover: '#131614',
  /**
   * Les routes se lisent plus clair qu'avant (#242424 / #2E2E2E).
   *
   * Ces valeurs venaient de la carte Google, dont le fond est plus clair que
   * le nôtre. Reprises telles quelles sur du #111111, les routes secondaires
   * disparaissaient purement et simplement — en zone rurale, où elles sont le
   * seul relief, l'écran paraissait vide.
   */
  road: '#333333',
  highway: '#454545',
  water: '#0C1420',
  waterLabel: '#3A4A5A',
  label: '#6B6B6B',
  labelHalo: '#0A0A0A',
  locality: '#9A9A9A',
  },
};

/** Le fond de chaque thème, aussi peint par la page avant tout rendu. */
const BACKGROUNDS = { light: '#FFFFFF', dark: '#0A0A0A' };

const themeOf = (value) => (value === 'light' ? 'light' : 'dark');

/**
 * Calques éteints, par identifiant exact.
 *
 * Trois familles, chacune pour une raison différente :
 *   • les points d'intérêt et les numéros de rue — du bruit sous les visages ;
 *   • les frontières et le transport (rail, pistes) — la carte ne sert pas à
 *     se déplacer, elle sert à situer quelqu'un ;
 *   • les noms de petites rues, illisibles à côté d'une épingle de 96 points.
 */
const HIDDEN_LAYERS = new Set([
  'boundary_county',
  'boundary_state',
  'boundary_country_outline',
  'boundary_country_inner',
  'aeroway-runway',
  'aeroway-taxiway',
  'rail',
  'rail_dash',
  'tunnel_rail',
  'tunnel_rail_dash',
  'poi_stadium',
  'poi_park',
  'housenumber',
  'roadname_minor',
  'place_continent',
]);

/**
 * Couleur d'un calque, d'après son rôle.
 *
 * `null` = on n'y touche pas. Le fournisseur peut ajouter des calques d'une
 * version à l'autre : ce qu'on ne reconnaît pas garde sa couleur d'origine
 * plutôt que de disparaître ou de virer au noir.
 */
function paletteFor(id, sourceLayer, PALETTE) {
  if (id === 'background') return PALETTE.land;

  // Les « case » sont les contours des routes. La palette d'origine les
  // éteignait (`geometry.stroke: visibility off`) : sur un fond aussi sombre
  // ils doublent chaque route d'un liseré qui la fait paraître floue.
  if (/_case(_|$)/.test(id)) return 'hidden';

  if (sourceLayer === 'water' || sourceLayer === 'waterway') return PALETTE.water;
  if (sourceLayer === 'water_name') return PALETTE.waterLabel;
  if (sourceLayer === 'park') return PALETTE.park;
  if (sourceLayer === 'landcover') return PALETTE.landcover;
  if (sourceLayer === 'landuse') return PALETTE.builtUp;
  if (sourceLayer === 'building') return PALETTE.builtUp;

  if (sourceLayer === 'transportation') {
    return /_(mot|trunk)_/.test(id) ? PALETTE.highway : PALETTE.road;
  }

  if (sourceLayer === 'place') {
    // Une ville se lit plus clair que le reste : c'est le seul repère textuel
    // qu'on garde vraiment, il doit se détacher.
    return /place_(city|town|capital)/.test(id) ? PALETTE.locality : PALETTE.label;
  }

  if (sourceLayer === 'transportation_name') return PALETTE.label;

  return null;
}

/**
 * Repeint un style aux couleurs de l'app.
 *
 * Écrase les couleurs plutôt que de les interpoler : les fournisseurs
 * expriment souvent la leur par une expression dépendant du zoom, et la
 * conserver ferait ressortir la palette d'origine à certains paliers — une
 * carte qui change de teinte en zoomant.
 */
function applyPalette(style, theme) {
  const PALETTE = PALETTES[theme];
  const layers = [];

  for (const layer of style.layers || []) {
    if (HIDDEN_LAYERS.has(layer.id)) continue;

    const color = paletteFor(layer.id, layer['source-layer'], PALETTE);
    if (color === 'hidden') continue;
    if (!color) {
      layers.push(layer);
      continue;
    }

    const paint = { ...(layer.paint || {}) };

    switch (layer.type) {
      case 'background':
        paint['background-color'] = color;
        break;
      case 'fill':
        paint['fill-color'] = color;
        // Une opacité venue du fournisseur laisserait transparaître le calque
        // du dessous, donc sa couleur à lui : la teinte obtenue ne serait plus
        // celle qu'on vient de poser.
        delete paint['fill-opacity'];
        /*
         * Le contour suit le remplissage.
         *
         * `building-top` arrive avec un `fill-outline-color` à #0e0e0e — pensé
         * pour détacher les toits sur un fond noir. Repeindre le remplissage
         * sans lui laissait donc un liseré quasi noir autour de CHAQUE
         * bâtiment : sur la carte claire, la ville entière se couvrait d'un
         * maillage sombre qu'on prenait pour un défaut de rendu.
         */
        if (paint['fill-outline-color'] !== undefined) paint['fill-outline-color'] = color;
        break;
      case 'line':
        paint['line-color'] = color;
        break;
      case 'symbol':
        paint['text-color'] = color;
        paint['text-halo-color'] = PALETTE.labelHalo;
        paint['text-halo-width'] = 1.2;
        // La pastille qui précède le nom d'une ville arrive en #666, figé pour
        // un fond sombre. Elle doit suivre le texte qu'elle accompagne.
        if (paint['icon-color'] !== undefined) paint['icon-color'] = color;
        break;
      default:
        break;
    }

    layers.push({ ...layer, paint });
  }

  return { ...style, layers };
}

/**
 * Durée de vie du style résolu, en mémoire.
 *
 * Un style ne bouge pas d'une heure à l'autre, et le relire à chaque ouverture
 * ajouterait un aller-retour vers le fournisseur devant chaque premier rendu.
 * Six heures laissent un changement de style arriver dans la journée sans
 * qu'on ait à redémarrer l'API.
 */
const STYLE_TTL_MS = 6 * 60 * 60 * 1000;

/** Au-delà, le fournisseur est considéré muet : on sert l'aplat sombre. */
const UPSTREAM_TIMEOUT_MS = 8000;

/** Le fond, quand aucun style n'est configuré ou que le fournisseur est muet. */
const BACKGROUND_COLOR = BACKGROUNDS.dark;

/**
 * Style minimal : un aplat de la couleur du thème.
 *
 * MapLibre exige un style valide pour s'initialiser. Sans lui, la carte ne se
 * construit pas du tout et l'app reçoit un écran noir sans savoir pourquoi ;
 * avec lui, les épingles s'affichent quand même — sur un fond nu, mais aux
 * bonnes coordonnées, et tout le reste de l'écran continue de fonctionner.
 */
const fallbackStyle = (theme) => ({
  version: 8,
  name: 'nf-map-fallback',
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': BACKGROUNDS[theme] },
    },
  ],
});

/**
 * Style résolu et cibles amont, en mémoire.
 *
 * `upstream` est la moitié qui ne descend JAMAIS au client : c'est la table de
 * correspondance qui permet au proxy de savoir vers quoi taper sans que le
 * client ait à le lui dire. Voir l'en-tête sur la SSRF.
 */
let cache = null;

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * Remplace `{z}/{x}/{y}` par des valeurs réelles.
 *
 * Les gabarits viennent du fournisseur, jamais du client : les valeurs, elles,
 * viennent du client et sont donc validées en entier par l'appelant.
 */
/**
 * Rend une URL absolue SANS abîmer ses variables de gabarit.
 *
 * `new URL()` normalise le chemin, et normaliser veut dire percent-encoder :
 * `{fontstack}` en ressort en `%7Bfontstack%7D`. Le gabarit stocké ne
 * contenait donc plus aucune accolade, et le `replace` qui devait y injecter
 * la police ne trouvait plus rien à remplacer — l'URL partait chez le
 * fournisseur avec ses variables littérales, qui répondait 404.
 *
 * La panne était invisible : MapLibre, faute de glyphes, retombe sur un rendu
 * local du texte. Les étiquettes s'affichaient, simplement pas dans la police
 * du style.
 */
function absolutizeTemplate(template) {
  return new URL(template, STYLE_URL)
    .toString()
    .replace(/%7B/gi, '{')
    .replace(/%7D/gi, '}');
}

function fillTileTemplate(template, z, x, y) {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * Récupère le style d'origine et le réécrit pour l'appareil.
 *
 * Deux transformations, et elles ont chacune leur raison :
 *
 *   1. **Les sources sont aplaties.** Une source peut arriver sous forme d'URL
 *      de TileJSON (`"url": "https://…/tiles.json?key=…"`), que le client
 *      devrait aller lire lui-même — un aller-retour de plus avant la première
 *      tuile, et une deuxième URL portant la clé. On la lit ici, une fois, et
 *      on inline `tiles: [notre proxy]` dans le style.
 *   2. **Tout ce qui pointe vers le fournisseur pointe vers nous.** Tuiles,
 *      glyphes (les polices des étiquettes) et sprite (les icônes). Un seul
 *      oubli suffirait à faire fuiter la clé dans le trafic de l'appareil.
 */
async function resolveStyle(base) {
  if (cache && Date.now() - cache.at < STYLE_TTL_MS) return cache;

  if (!STYLE_URL) {
    logger.warn(
      '[nfMap] NF_MAP_STYLE_URL absent — la Carte NF se rendra en aplat sombre, ' +
        'sans fond de carte.'
    );
    cache = { at: Date.now(), style: null, upstream: null };
    return cache;
  }

  try {
    const original = await fetchJson(STYLE_URL);
    const upstream = { tiles: {}, glyphs: null, sprite: null };
    const style = { ...original, sources: {} };

    /** Sources écartées : leurs calques doivent partir avec elles. */
    const dropped = new Set();

    for (const [name, source] of Object.entries(original.sources || {})) {
      // Une source qui ne se sert pas en tuiles (GeoJSON, image, vidéo) n'a
      // pas de clé à cacher TANT QUE ses données sont écrites dans le style.
      // Si elles vivent derrière une URL, en revanche, cette URL est celle du
      // fournisseur : la laisser passer ferait fuiter exactement ce que tout ce
      // fichier existe pour retenir. On écarte alors la source.
      if (!source.tiles && !source.url) {
        if (source.data && typeof source.data !== 'string') {
          style.sources[name] = source;
        } else {
          dropped.add(name);
        }
        continue;
      }

      // Une source peut décrire ses tuiles directement (`tiles: […]`) ou
      // renvoyer vers un TileJSON (`url: …`). Le second cas doit être résolu
      // ici : sinon le client va le lire lui-même, sur une URL qui porte la clé.
      let resolved = source;
      if (source.url && !source.tiles) {
        try {
          const tilejson = await fetchJson(new URL(source.url, STYLE_URL).toString());
          // ⚠️ Le TileJSON N'ÉCRASE PAS la source, il la complète.
          //
          // Les deux formats partagent des noms de champs qui ne veulent pas
          // dire la même chose. `type` en particulier : côté source MapLibre il
          // vaut « vector » ou « raster », côté TileJSON il décrit la nature du
          // calque (« baselayer », « overlay »). Une fusion naïve
          // `{ ...source, ...tilejson }` remplaçait donc « vector » par
          // « baselayer », et MapLibre rejetait le style entier sur
          // « expected one of [vector, raster, …] ».
          resolved = {
            ...source,
            tiles: tilejson.tiles,
            ...(tilejson.minzoom !== undefined ? { minzoom: tilejson.minzoom } : {}),
            ...(tilejson.maxzoom !== undefined ? { maxzoom: tilejson.maxzoom } : {}),
            ...(tilejson.bounds !== undefined ? { bounds: tilejson.bounds } : {}),
            // L'attribution vient souvent du TileJSON et pas du style. La
            // perdre ici, c'est afficher une carte sans sa mention légale.
            ...(tilejson.attribution ? { attribution: tilejson.attribution } : {}),
          };
        } catch (error) {
          logger.warn(`[nfMap] TileJSON « ${name} » illisible: ${error.message}`);
          dropped.add(name);
          continue;
        }
      }

      if (!Array.isArray(resolved.tiles) || resolved.tiles.length === 0) {
        dropped.add(name);
        continue;
      }

      // Le gabarit amont reste ICI. Le client ne reçoit que le nôtre, qui ne
      // porte que z/x/y — donc rien qu'il puisse détourner.
      upstream.tiles[name] = resolved.tiles;

      const { url, ...rest } = resolved;
      style.sources[name] = {
        ...rest,
        tiles: [`${base}/tiles/${encodeURIComponent(name)}/{z}/{x}/{y}`],
      };
    }

    // Un calque qui désigne une source absente invalide le STYLE ENTIER, pas
    // seulement lui-même : MapLibre refuse de se construire sur
    // « layers[7]: source "x" not found », et l'écran reste noir. Écarter une
    // source oblige donc à écarter ce qui la lit.
    if (dropped.size > 0) {
      style.layers = (original.layers || []).filter(
        (layer) => !layer.source || !dropped.has(layer.source)
      );
    }

    if (original.glyphs) {
      upstream.glyphs = absolutizeTemplate(original.glyphs);
      style.glyphs = `${base}/glyphs/{fontstack}/{range}.pbf`;
    }
    if (original.sprite) {
      // Le sprite peut être une chaîne ou, depuis le style v8 récent, une liste
      // de `{ id, url }`. On ne gère que la forme simple : c'est celle que
      // servent les fournisseurs visés, et une liste demanderait un préfixe par
      // identifiant dans le proxy pour un gain nul ici.
      const spriteUrl = typeof original.sprite === 'string' ? original.sprite : null;
      if (spriteUrl) {
        upstream.sprite = absolutizeTemplate(spriteUrl);
        style.sprite = `${base}/sprite`;
      } else {
        delete style.sprite;
      }
    }

    if (Object.keys(style.sources).length === 0) {
      throw new Error('aucune source exploitable dans le style');
    }

    // La palette s'applique EN DERNIER, une fois les sources réécrites et les
    // calques orphelins retirés : elle raisonne sur la liste définitive.
    cache = { at: Date.now(), style, upstream };
    return cache;
  } catch (error) {
    logger.error(`[nfMap] style de carte indisponible: ${error.message}`);
    // On met QUAND MÊME en cache, mais brièvement : sans ça, un fournisseur en
    // panne fait retenter la requête à chaque ouverture d'écran, et chaque
    // ouverture attend le délai d'expiration avant d'afficher quoi que ce soit.
    cache = { at: Date.now() - STYLE_TTL_MS + 60_000, style: null, upstream: null };
    return cache;
  }
}

/**
 * Le style tel qu'il descend à l'appareil — sans une URL du fournisseur, et
 * peint aux couleurs du thème que l'app utilise en ce moment.
 *
 * La peinture se fait ICI et pas dans le cache : le style résolu est le même
 * pour tout le monde, la palette non. Mettre en cache un style déjà peint
 * aurait servi la carte sombre à un appareil en thème clair, selon lequel des
 * deux a ouvert l'écran en premier.
 */
async function clientStyle(base, requestedTheme) {
  const theme = themeOf(requestedTheme);
  const { style } = await resolveStyle(base);
  return style ? applyPalette(style, theme) : fallbackStyle(theme);
}

/**
 * URL amont d'une tuile, ou `null`.
 *
 * `null` couvre aussi bien « source inconnue » que « coordonnées absurdes » :
 * dans les deux cas l'appelant répond 404, et rien ne part vers l'extérieur.
 * C'est ce qui referme le proxy — voir l'en-tête.
 */
async function tileUpstream(base, sourceName, z, x, y) {
  const { upstream } = await resolveStyle(base);
  if (!upstream) return null;

  const templates = upstream.tiles[sourceName];
  if (!templates) return null;

  // Bornes du schéma de tuilage : au zoom `z`, il existe `2^z` tuiles par côté.
  // Sans ce contrôle, n'importe quel entier partirait tel quel chez le
  // fournisseur, qui facturerait des requêtes vouées au 404.
  if (!Number.isInteger(z) || z < 0 || z > 24) return null;
  const side = 2 ** z;
  if (!Number.isInteger(x) || x < 0 || x >= side) return null;
  if (!Number.isInteger(y) || y < 0 || y >= side) return null;

  // Plusieurs gabarits = plusieurs domaines équivalents du fournisseur. On
  // répartit sur `x + y` plutôt qu'au hasard : la même tuile tape toujours le
  // même domaine, donc reste dans la même entrée de cache.
  const template = templates[(x + y) % templates.length];
  return fillTileTemplate(template, z, x, y);
}

/** URL amont d'une plage de glyphes, ou `null`. */
async function glyphUpstream(base, fontstack, range) {
  const { upstream } = await resolveStyle(base);
  if (!upstream || !upstream.glyphs) return null;

  // `range` est toujours de la forme `0-255`. Le valider ferme la porte à une
  // traversée de chemin dans l'URL amont.
  if (!/^\d{1,5}-\d{1,5}$/.test(range)) return null;
  // Une pile de polices est une liste de noms séparés par des virgules.
  if (!/^[\w .,'()-]{1,200}$/.test(fontstack)) return null;

  return upstream.glyphs
    .replace('{fontstack}', encodeURIComponent(fontstack))
    .replace('{range}', range);
}

/**
 * URL amont d'un fichier de sprite, ou `null`.
 *
 * MapLibre demande quatre variantes autour d'un même préfixe : `.json` et
 * `.png`, chacune en densité simple et double.
 */
const SPRITE_VARIANTS = new Set(['.json', '.png', '@2x.json', '@2x.png']);

async function spriteUpstream(base, variant) {
  const { upstream } = await resolveStyle(base);
  if (!upstream || !upstream.sprite) return null;
  if (!SPRITE_VARIANTS.has(variant)) return null;

  // Le préfixe amont n'a pas d'extension : `…/sprite` + `@2x.png`. Une URL avec
  // paramètres (la clé !) doit voir la variante s'insérer AVANT la requête.
  const url = new URL(upstream.sprite);
  url.pathname += variant;
  return url.toString();
}

/** Emplacement des fichiers de MapLibre, servis depuis nos propres routes. */
const MAPLIBRE_DIST = path.dirname(require.resolve('maplibre-gl/package.json'));

/**
 * Le build « CSP » de MapLibre, et pas le build ordinaire.
 *
 * Le bundle habituel fabrique son worker à partir d'un `Blob`, ce que la CSP de
 * l'API interdit (`worker-src` retombe sur `default-src 'self'`, qui exclut
 * `blob:`). Le build CSP charge le worker depuis une URL qu'on lui donne : la
 * page reste servie sous une politique stricte, sans `unsafe-inline` ni
 * `blob:`. Assouplir la CSP globale pour une seule page aurait été le mauvais
 * sens de la correction.
 */
const MAPLIBRE_FILES = {
  'maplibre.js': path.join(MAPLIBRE_DIST, 'dist', 'maplibre-gl-csp.js'),
  'maplibre-worker.js': path.join(MAPLIBRE_DIST, 'dist', 'maplibre-gl-csp-worker.js'),
  'maplibre.css': path.join(MAPLIBRE_DIST, 'dist', 'maplibre-gl.css'),
};

/**
 * Version des fichiers servis, pour l'URL.
 *
 * Elle rend les URLs de MapLibre et de la page immuables : on peut alors les
 * mettre en cache pour un an, et une mise à jour de la bibliothèque produit
 * d'elle-même de nouvelles URLs. Sans ça, il faudrait choisir entre un cache
 * court (donc un mégaoctet retéléchargé souvent) et une version figée sur les
 * appareils.
 */
const MAPLIBRE_VERSION = require('maplibre-gl/package.json').version;

/** Le pont, servi depuis le disque — voir `BRIDGE_VERSION`. */
const BRIDGE_FILE = path.join(__dirname, '../web/nf-map/bridge.js');

/**
 * Empreinte du CONTENU du pont, et surtout pas la version de MapLibre.
 *
 * ── La panne que ça corrige ──
 * `bridge.js` était servi sous `?v=<version de MapLibre>` avec un cache d'un an
 * en `immutable`. Or ce numéro ne bouge que quand MapLibre change : modifier le
 * pont ne changeait donc PAS son URL, et un appareil qui avait déjà ouvert la
 * carte gardait l'ancien script — pour un an. Les corrections apportées au pont
 * (le nom du lieu survolé, le premier cadrage instantané, le masquage d'une
 * épingle dont l'image échoue) ne pouvaient atteindre personne, sans le moindre
 * signe : la page se chargeait, la carte s'affichait, il manquait simplement
 * tout ce qui avait été ajouté depuis.
 *
 * Une empreinte du contenu rend l'URL vraiment immuable : elle change si et
 * seulement si le fichier change, ce qui est exactement la promesse que
 * `immutable` fait au cache.
 *
 * Lue une fois au démarrage : le fichier est livré avec le code, il ne change
 * pas en cours d'exécution.
 */
const BRIDGE_VERSION = (() => {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(BRIDGE_FILE)).digest('hex').slice(0, 12);
  } catch (error) {
    // Illisible : on retombe sur un cache court plutôt que de figer une URL
    // sur une empreinte qu'on n'a pas pu calculer.
    logger.warn(`[nfMap] empreinte du pont illisible: ${error.message}`);
    return String(Date.now());
  }
})();

function maplibreFile(name) {
  const file = MAPLIBRE_FILES[name];
  if (!file || !fs.existsSync(file)) return null;
  return file;
}

/**
 * La page.
 *
 * ── Ce qui, dans une WebView, trahit une page web ──
 * Quatre choses, et elles sont toutes neutralisées ci-dessous :
 *
 *   1. le rebond élastique en fin de geste (`overscroll-behavior`, plus
 *      `bounces={false}` côté app) ;
 *   2. la sélection de texte et le menu contextuel à l'appui long
 *      (`user-select`, `-webkit-touch-callout`) ;
 *   3. le flash blanc avant le premier rendu — le fond est peint en CSS ET sur
 *      la `WebView` côté app, parce que le blanc vient du compositeur natif
 *      avant que la moindre ligne de CSS ne soit lue ;
 *   4. le canvas qui s'assemble à vue. La carte est en `opacity: 0` jusqu'au
 *      premier `idle` de MapLibre — c'est-à-dire jusqu'à ce que les tuiles de
 *      la vue initiale soient posées — puis apparaît en fondu.
 *
 * L'attribution, elle, RESTE. Elle est exigée par la licence des données
 * (OpenStreetMap et le fournisseur), et ce n'est de toute façon pas ce qui
 * trahirait la page : Apple Maps et Google Maps affichent aussi leur logo dans
 * une app native. Elle est simplement réduite au « ⓘ » compact.
 */
function pageHtml({ base, nonce, theme: requestedTheme }) {
  const version = encodeURIComponent(MAPLIBRE_VERSION);
  const theme = themeOf(requestedTheme);
  const background = BACKGROUNDS[theme];

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="color-scheme" content="${theme}">
<title>​</title>
<link rel="stylesheet" href="${base}/maplibre.css?v=${version}">
<style nonce="${nonce}">
  /* Le fond est peint ici ET sur la WebView côté app : celui-ci arrive trop
     tard pour couvrir le premier compositing natif, qui est blanc par défaut. */
  html, body {
    margin: 0; padding: 0; height: 100%; width: 100%;
    background: ${background};
    overflow: hidden;
    /* Coupe le rebond élastique de fin de geste, la signature nº1 d'une page. */
    overscroll-behavior: none;
  }
  * {
    -webkit-user-select: none; user-select: none;
    /* Sans ça, un appui long sur la carte ouvre le menu « Copier / Rechercher »
       d'iOS par-dessus, ce qu'aucune carte native ne fait. */
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
  #map {
    position: absolute; inset: 0;
    /* Voir le point 4 de l'en-tête : rien n'est montré tant que la vue
       initiale n'est pas posée. */
    opacity: 0;
    transition: opacity 180ms ease-out;
  }
  #map.ready { opacity: 1; }

  /* Attribution : obligatoire, donc discrète plutôt qu'absente. */
  .maplibregl-ctrl-attrib {
    background: ${theme === "light" ? "rgba(255,255,255,0.6)" : "rgba(10,10,10,0.55)"} !important;
    border-radius: 10px 0 0 0;
  }
  .maplibregl-ctrl-attrib,
  .maplibregl-ctrl-attrib a {
    color: ${theme === "light" ? "#8A8A8E" : "#5A5A5A"} !important;
    font-size: 9px !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .maplibregl-ctrl-attrib-button { opacity: 0.35; }
  /* Le logo MapLibre n'est pas exigé par la licence, contrairement au texte. */
  .maplibregl-ctrl-logo { display: none !important; }

  /* Une épingle est une image posée par le serveur, pas une vue vivante : le
     rendu reste donc identique à celui de la carte native. */
  .nf-pin {
    position: absolute;
    will-change: transform;
    cursor: pointer;
  }
  /* Le retour au toucher.
     Sans lui, une épingle est indiscernable d'un élément du fond : on appuie,
     rien ne bouge, et le temps que l'app charge la fiche on croit avoir raté
     sa cible. L'enfoncement porte sur l'IMAGE et pas sur l'épingle : MapLibre
     écrit en permanence une transformation sur l'élément qu'il positionne, et
     la nôtre l'écraserait — l'épingle sauterait au coin de l'écran. */
  .nf-pin img {
    transition: transform 90ms ease-out;
  }
  .nf-pin:active img {
    transform: scale(0.92);
  }
  .nf-pin img {
    display: block;
    width: 100%; height: 100%;
    pointer-events: none;
    /* Une épingle à moitié chargée qui saute à sa taille finale se voit. */
    -webkit-user-drag: none;
  }
</style>
</head>
<body>
<!-- Un attribut plutôt qu'un script en ligne : le pont a besoin de cette
     racine pour déclarer le worker de MapLibre, et un attribut n'a rien à
     négocier avec la CSP. -->
<div id="map" data-base="${base}" data-version="${version}"></div>
<script nonce="${nonce}" src="${base}/maplibre.js?v=${version}"></script>
<script nonce="${nonce}" src="${base}/bridge.js?v=${BRIDGE_VERSION}"></script>
</body>
</html>`;
}

module.exports = {
  BACKGROUND_COLOR,
  MAPLIBRE_VERSION,
  BRIDGE_FILE,
  BRIDGE_VERSION,
  clientStyle,
  glyphUpstream,
  maplibreFile,
  pageHtml,
  spriteUpstream,
  tileUpstream,
  // Exporté pour les tests : ils doivent pouvoir repartir d'un cache vide.
  __resetCache: () => {
    cache = null;
  },
  __nonce: () => crypto.randomBytes(16).toString('base64'),
};
