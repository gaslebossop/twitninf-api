/**
 * 🗺️ Le moteur de la Carte NF, dans la page.
 *
 * ── Ce fichier ne tourne PAS sur le serveur ──
 * C'est du code de navigateur, servi tel quel par `GET /api/nf-map/bridge.js`
 * et exécuté dans la `WebView` de l'app. Il est écrit en ES5 volontairement :
 * il n'est pas transpilé, et il doit démarrer sur la WebView d'un Android
 * ancien comme sur celle d'iOS 15.
 *
 * ── Ce qu'il ne fait pas ──
 * Il ne parle à personne. Aucune requête vers l'API, aucun jeton, aucune
 * donnée en dur : les marqueurs ARRIVENT de l'app, qui les a chargés elle-même
 * avec son propre jeton. La page est un moteur de rendu vide, et c'est ce qui
 * permet de la servir sans authentification.
 *
 * ── Le contrat avec l'app ──
 * Descendant (l'app appelle `window.NFMAP.…` via `injectJavaScript`) :
 *   • `init(options)`      — style, centre et zoom de départ
 *   • `setMarkers(list)`   — la liste COMPLÈTE des épingles à afficher
 *   • `jumpTo(lat, lng, zoom)` — saut de caméra explicite
 *
 * Montant (`window.ReactNativeWebView.postMessage`) :
 *   • `{ type: 'ready' }`
 *   • `{ type: 'region', center, bounds }`  — après un déplacement, pas pendant
 *   • `{ type: 'marker', id }`
 *   • `{ type: 'map' }`                     — appui sur le fond
 *
 * ⚠️ Le zoom ne remonte JAMAIS dans les messages, et c'est délibéré : l'app le
 * recalcule depuis `bounds` avec sa propre formule (`zoomForDelta`). MapLibre
 * compte en tuiles de 512 px, l'écran comptait en « largeur de vue » — deux
 * conventions décalées de `log2(largeur / 512)`. Faire dériver le zoom des
 * bornes supprime la question au lieu de la convertir dans les deux sens.
 */
(function () {
  'use strict';

  var map = null;
  var container = document.getElementById('map');

  /** Épingles posées, par identifiant. Voir `setMarkers`. */
  var pins = Object.create(null);

  /** Ce qui arrive avant que la carte ne soit prête, et qu'on rejouera. */
  var pending = null;

  /** Densité de l'écran : le serveur dessine les épingles en points × densité. */
  var dpr = window.devicePixelRatio || 1;

  function post(payload) {
    if (!window.ReactNativeWebView) return;
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }

  /**
   * Conversion du zoom de l'écran vers celui de MapLibre.
   *
   * L'écran raisonne en « la vue fait 360 / 2^zoom degrés de large ». MapLibre
   * raisonne en tuiles de 512 px : à son zoom `z`, le monde fait `512 · 2^z` px.
   * Les deux coïncident quand `zMapLibre = zÉcran + log2(largeurVue / 512)`.
   *
   * Sans cette correction, « voir cet ami » cadrait systématiquement trop large
   * sur un téléphone (390 px de large, soit 0,4 niveau d'écart) — assez pour
   * qu'ouvrir un groupe ne sépare pas ses membres.
   */
  function toMapLibreZoom(screenZoom) {
    var width = container.clientWidth || 512;
    return screenZoom + Math.log(width / 512) / Math.LN2;
  }

  /**
   * ── Le lieu survolé, à la façon de Snap Map ──
   *
   * Il est lu dans les ÉTIQUETTES DÉJÀ DESSINÉES par la carte, pas demandé à un
   * service de géocodage inverse. Trois raisons, dans l'ordre d'importance :
   * c'est instantané (aucune requête, donc aucun décalage avec ce qu'on voit),
   * ça ne coûte rien, et surtout le nom affiché est exactement celui que la
   * carte montre — un géocodeur aurait sa propre idée du découpage et
   * annoncerait parfois une commune dont le nom n'apparaît nulle part à
   * l'écran.
   */

  /** Calques de lieux du style courant. Lus une fois, ils ne changent pas. */
  var placeLayers = null;

  function placeLayerIds() {
    if (placeLayers) return placeLayers;
    placeLayers = [];
    var layers = map.getStyle().layers || [];
    for (var i = 0; i < layers.length; i += 1) {
      if (layers[i]['source-layer'] === 'place') placeLayers.push(layers[i].id);
    }
    return placeLayers;
  }

  /**
   * Du plus précis au plus large.
   *
   * Un quartier l'emporte sur sa ville, qui l'emporte sur sa région : centré
   * sur Montmartre, annoncer « France » n'apprend rien. Ce qui n'est pas dans
   * cette liste (continent, océan) n'est jamais annoncé.
   */
  var PLACE_RANK = {
    neighbourhood: 0,
    quarter: 0,
    suburb: 1,
    hamlet: 2,
    village: 3,
    town: 4,
    city: 5,
    state: 6,
    province: 6,
    country: 7,
  };

  var lastPlace = null;

  function publishPlace() {
    if (!map) return;

    var ids = placeLayerIds();
    if (ids.length === 0) return;

    var center = map.project(map.getCenter());
    var found = null;
    var features;
    try {
      features = map.queryRenderedFeatures({ layers: ids });
    } catch (error) {
      // Un calque peut disparaître entre deux styles : ne pas faire tomber le
      // rendu pour une étiquette.
      return;
    }

    for (var i = 0; i < features.length; i += 1) {
      var props = features[i].properties || {};
      var name = props['name:fr'] || props.name || props.name_fr;
      if (!name) continue;

      var rank = PLACE_RANK[props.class];
      if (rank === undefined) continue;

      // Distance à l'écran entre l'étiquette et le centre de la vue : c'est
      // « ce qu'on survole », pas « ce qui est le plus gros à l'écran ».
      var point = map.project(features[i].geometry.coordinates);
      var distance = Math.hypot(point.x - center.x, point.y - center.y);

      /*
       * Le PLUS PROCHE gagne ; la précision ne sert qu'à départager.
       *
       * L'inverse — le plus précis d'abord — paraissait logique et donnait des
       * réponses fausses dès qu'on dézoomait : centré sur Paris au zoom 9, la
       * carte annonçait « Vaujours », un village de deux mille habitants à
       * vingt kilomètres, simplement parce qu'un hameau est plus « précis »
       * qu'une capitale. Au zoom 6 elle annonçait « Versailles ».
       *
       * Trier par distance rend le comportement juste à toutes les échelles
       * sans rien savoir du zoom : de près, l'étiquette la plus proche du
       * centre est celle du quartier ; de loin, les quartiers ne sont plus
       * dessinés et c'est celle de la ville. La carte a déjà décidé de ce qui
       * mérite d'être écrit à cette échelle — on ne fait que la lire.
       *
       * La marge d'un pixel évite qu'une différence invisible fasse osciller
       * le nom entre deux étiquettes superposées.
       */
      if (
        !found ||
        distance < found.distance - 1 ||
        (Math.abs(distance - found.distance) <= 1 && rank < found.rank)
      ) {
        found = { name: String(name), rank: rank, distance: distance };
      }
    }

    var next = found ? found.name : null;
    if (next === lastPlace) return;
    lastPlace = next;
    post({ type: 'place', name: next });
  }

  /**
   * Pendant le geste, pas seulement à la fin.
   *
   * C'est ce qui donne la sensation de Snap : le nom défile sous le doigt.
   * Limité à une lecture toutes les 120 ms — `queryRenderedFeatures` parcourt
   * les étiquettes de la vue, ce qu'on ne veut pas faire soixante fois par
   * seconde pendant qu'on déplace la carte.
   */
  var placeTimer = 0;

  function schedulePlace() {
    if (placeTimer) return;
    placeTimer = setTimeout(function () {
      placeTimer = 0;
      publishPlace();
    }, 120);
  }

  /** Ce que l'app attend après un déplacement : le centre et les bornes. */
  function publishRegion() {
    if (!map) return;
    var bounds = map.getBounds();
    var center = map.getCenter();
    post({
      type: 'region',
      center: { latitude: center.lat, longitude: center.lng },
      bounds: {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
      },
    });
  }

  /**
   * Taille d'affichage d'une épingle, en pixels CSS.
   *
   * L'image arrive en `points × densité` — c'est ce que le serveur dessine, et
   * c'est ce qu'il faut pour qu'elle soit nette. Elle doit donc être AFFICHÉE à
   * sa taille en points, sinon une épingle de 96 pt occupe 288 px sur un écran
   * à densité 3.
   */
  function sizePin(entry) {
    var image = entry.img;
    if (!image.naturalWidth || !image.naturalHeight) return;

    var width = image.naturalWidth / dpr;
    var height = image.naturalHeight / dpr;
    entry.el.style.width = width + 'px';
    entry.el.style.height = height + 'px';

    // L'épingle désigne un point qui n'est pas son centre : la pointe, sous
    // laquelle il reste encore l'étiquette du pseudo. `anchorY` dit où il est
    // (0 = haut, 1 = bas) ; l'écart au centre devient un décalage en pixels.
    entry.marker.setOffset([0, (0.5 - entry.anchorY) * height]);
  }

  /**
   * Pose la liste COMPLÈTE des épingles.
   *
   * Les nœuds sont réutilisés par identifiant : une épingle qui ne fait que
   * bouger ou changer d'apparence ne repart pas du DOM, elle est déplacée. Ce
   * n'est plus une question de survie comme sur la carte native — retirer un
   * nœud ici ne fait rien tomber — mais recréer une image relancerait son
   * chargement, et l'épingle clignoterait à chaque recalcul.
   */
  function setMarkers(list) {
    if (!map) {
      pending = { markers: list };
      return;
    }

    var seen = Object.create(null);

    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (!item || typeof item.id !== 'string') continue;
      if (!isFinite(item.latitude) || !isFinite(item.longitude)) continue;

      seen[item.id] = true;
      var entry = pins[item.id];

      if (!entry) {
        var el = document.createElement('div');
        el.className = 'nf-pin';

        var img = document.createElement('img');
        el.appendChild(img);

        entry = { el: el, img: img, image: null, anchorY: 0.5, marker: null };

        // `anchor: 'center'` puis un décalage calculé : c'est la seule façon
        // d'exprimer un ancrage fractionnaire, que MapLibre ne propose pas
        // autrement (il n'a que des préretenus « bottom », « top-left »…).
        entry.marker = new maplibregl.Marker({ element: el, anchor: 'center' })
          .setLngLat([item.longitude, item.latitude])
          .addTo(map);

        // Une image n'a pas de dimensions tant qu'elle n'est pas chargée : le
        // dimensionnement et l'ancrage se font donc à son arrivée, puis à
        // chaque changement d'image.
        img.addEventListener('load', function (entryRef) {
          return function () {
            entryRef.el.style.visibility = 'visible';
            sizePin(entryRef);
          };
        }(entry));

        /**
         * Une épingle dont l'image échoue doit DISPARAÎTRE, pas se signaler.
         *
         * Sans ça, iOS dessine son cadre de remplacement — un « ? » bleu dans
         * un rectangle — au milieu de la carte. Et comme `load` ne part jamais,
         * l'élément garde en plus sa taille par défaut : on obtient un cadre
         * blanc de la largeur du conteneur. Vu de l'utilisateur, c'est un
         * défaut d'affichage inexplicable là où il n'y a, en réalité, personne
         * à montrer.
         */
        img.addEventListener('error', function (entryRef) {
          return function () {
            entryRef.el.style.visibility = 'hidden';
          };
        }(entry));

        // L'appui est traité ici et remonté à l'app, qui décide quoi en faire
        // (ouvrir une fiche, dézoomer sur un groupe). `stopPropagation` évite
        // que l'appui atteigne aussi la carte, dont le `click` sert à refermer
        // ce qui est ouvert — sans lui, la fiche se ferme dans l'instant où le
        // marqueur vient de la remplir.
        el.addEventListener('click', function (id) {
          return function (event) {
            event.stopPropagation();
            post({ type: 'marker', id: id });
          };
        }(item.id));

        pins[item.id] = entry;
      } else {
        entry.marker.setLngLat([item.longitude, item.latitude]);
      }

      entry.anchorY = isFinite(item.anchorY) ? item.anchorY : 0.5;
      entry.el.style.zIndex = String(item.zIndex || 0);

      if (entry.image !== item.image) {
        entry.image = item.image;
        // Masquée le temps du chargement : une image pas encore arrivée n'a
        // pas de dimensions, et l'épingle s'afficherait une image durant à une
        // taille qui n'est pas la sienne, au mauvais endroit.
        entry.el.style.visibility = 'hidden';
        entry.img.src = item.image;
      } else {
        // Même image, mais l'ancrage a pu changer avec le rôle du marqueur
        // (une tête de groupe ne pointe pas comme une épingle isolée).
        sizePin(entry);
      }
    }

    for (var id in pins) {
      if (seen[id]) continue;
      pins[id].marker.remove();
      delete pins[id];
    }
  }

  /**
   * Saut de caméra explicite — « me localiser », « voir cet ami ».
   *
   * `instant` coupe l'animation. Il sert au TOUT PREMIER cadrage : la carte
   * s'ouvre sur une position de repli, puis l'app apprend où on est vraiment.
   * Animer ce passage-là donnait un survol de plusieurs centaines de
   * kilomètres à chaque ouverture — le « ça se téléporte ». Il n'y a rien à
   * suivre des yeux entre deux endroits qu'on n'a pas choisi de relier : seuls
   * les sauts DEMANDÉS méritent une animation.
   */
  function jumpTo(latitude, longitude, screenZoom, instant) {
    if (!map) {
      pending = pending || {};
      pending.camera = {
        latitude: latitude,
        longitude: longitude,
        zoom: screenZoom,
        instant: instant,
      };
      return;
    }
    if (!isFinite(latitude) || !isFinite(longitude)) return;

    var target = { center: [longitude, latitude], zoom: toMapLibreZoom(screenZoom) };
    if (instant) map.jumpTo(target);
    else map.easeTo({ center: target.center, zoom: target.zoom, duration: 350 });
  }

  function init(options) {
    if (map) return;

    /**
     * Déclarer le worker AVANT toute création de carte.
     *
     * On sert le build « CSP » de MapLibre, qui — contrairement au bundle
     * ordinaire — ne fabrique pas son worker à partir d'un `Blob` : il le
     * charge depuis une URL, qu'il faut donc lui donner. Sans cet appel il
     * tombe sur son chemin par défaut, qui n'existe pas ici : la requête est
     * servie par la page elle-même et le worker meurt sur
     * `SyntaxError: Unexpected token '<'` — du HTML interprété comme du script.
     *
     * C'est ce build qui permet à la page de tenir sous `worker-src 'self'`,
     * sans `blob:` ni `unsafe-inline`.
     */
    maplibregl.setWorkerUrl(
      container.dataset.base + '/maplibre-worker.js?v=' + container.dataset.version
    );

    map = new maplibregl.Map({
      container: 'map',
      style: options.style,
      center: [options.longitude, options.latitude],
      zoom: toMapLibreZoom(options.zoom),

      // Une carte de gens se lit à plat. La rotation et l'inclinaison sont
      // aussi ce qui rend un geste imprécis : deux doigts qui pincent tournent
      // toujours un peu, et la carte partait de travers.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,

      // Les étiquettes apparaissent en fondu par défaut. Sur une carte qu'on
      // déplace beaucoup, ça se lit comme un chargement permanent.
      fadeDuration: 0,

      attributionControl: { compact: true },

      // Rien à photographier ni à exporter : le contexte peut rester non
      // préservé, ce qui économise une copie de tampon à chaque image.
      preserveDrawingBuffer: false,
      refreshExpiredTiles: false,
    });

    map.on('click', function () {
      post({ type: 'map' });
    });

    // Après le déplacement, pas pendant : l'app relance une requête réseau à
    // chaque région reçue, et le geste en produirait une par image.
    map.on('moveend', publishRegion);

    // Le lieu, LUI, se met à jour pendant le geste — c'est tout l'intérêt.
    // Il ne déclenche aucune requête, seulement une lecture des étiquettes.
    map.on('move', schedulePlace);
    map.on('moveend', publishPlace);
    // Les étiquettes arrivent avec leurs tuiles : sans ça, le nom reste vide
    // tant qu'on n'a pas bougé après le premier affichage.
    map.on('idle', schedulePlace);

    /**
     * Le premier `idle` — donc les tuiles de la vue initiale posées.
     *
     * C'est là, et pas au `load`, que la carte cesse d'avoir l'air de
     * s'assembler : `load` arrive quand le style est prêt, avec un canvas
     * encore vide. Montrer à ce moment donne exactement le rendu « page web
     * qui se construit » qu'on cherche à cacher.
     */
    map.once('idle', function () {
      container.className = 'ready';
      post({ type: 'ready' });
      publishRegion();
    });

    if (pending) {
      if (pending.markers) setMarkers(pending.markers);
      if (pending.camera) {
        jumpTo(
          pending.camera.latitude,
          pending.camera.longitude,
          pending.camera.zoom,
          pending.camera.instant
        );
      }
      pending = null;
    }
  }

  window.NFMAP = { init: init, setMarkers: setMarkers, jumpTo: jumpTo };

  // L'app peut avoir injecté sa configuration avant que ce script ne soit
  // évalué — la course dépend de la vitesse du réseau, donc elle se produit.
  if (window.NFMAP_BOOT) init(window.NFMAP_BOOT);
})();
