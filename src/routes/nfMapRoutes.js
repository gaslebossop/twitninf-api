'use strict';

/**
 * Routes de la Carte NF.
 *
 * Tout est derrière `requireFlag('fil.cartenf')` — y compris la lecture de ses
 * propres réglages. Tant que le palier n'est pas ouvert pour un compte, la
 * fonctionnalité n'existe pas pour lui, et l'API répond 404 plutôt que de
 * laisser deviner qu'une carte se prépare.
 */

const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { QueryTypes } = require('sequelize');
const router = express.Router();

const { sequelize, Notification } = require('../models');
const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const { requireFlag } = require('../middleware/featureFlagMiddleware');
const nfMap = require('../services/nfMapService');
const nfMapPin = require('../services/nfMapPinService');
const nfMapWebView = require('../services/nfMapWebView');
const { getPublicMediaOrigin } = require('../utils/publicMediaOrigin');
const logger = require('../utils/logger');

const guard = [authenticateToken, requireFlag('fil.cartenf')];

/**
 * Les routes d'épingle sont SANS JETON, et ce n'est pas un oubli.
 *
 * Un marqueur de `react-native-maps` charge son image par le chargeur natif de
 * la plateforme — `RCTImageLoader` sur iOS, Fresco sur Android. Ni l'un ni
 * l'autre ne porte l'en-tête `Authorization` de l'app : une route protégée
 * répondrait 401 à toutes les épingles, et la carte serait couverte de
 * marqueurs vides.
 *
 * Ce qu'on accepte de servir en clair est donc strictement ce qui est DÉJÀ
 * public : l'avatar et le pseudo, que `GET /api/users/profile/:username` rend
 * sans authentification. Aucune position n'entre dans l'image — le dessin ne
 * dit pas où quelqu'un se trouve, seulement à quoi il ressemble. C'est la
 * condition qui rend cette ouverture acceptable, et elle doit le rester.
 */
const pinLimiter = rateLimit({
  windowMs: 60 * 1000,
  // Large : une carte bien remplie demande jusqu'à deux cents épingles d'un
  // coup, et chacune n'est calculée qu'une fois grâce au cache ci-dessous.
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes' },
});

/**
 * Une journée de cache, et c'est délibérément long.
 *
 * L'image ne dépend que de l'avatar et du pseudo, deux choses qui ne changent
 * pas dans la journée. Un changement d'avatar produit une nouvelle URL de
 * fichier, donc une nouvelle empreinte dans l'URL de l'épingle : le cache se
 * périme de lui-même, sans qu'on ait à le raccourcir pour tout le monde.
 */
const PIN_CACHE_SECONDS = 24 * 60 * 60;

function sendPng(res, png) {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', `public, max-age=${PIN_CACHE_SECONDS}, immutable`);
  // Les épingles ne varient pas selon l'appelant : rien d'utile à négocier.
  res.set('Vary', 'Accept-Encoding');
  return res.send(png);
}

/** Les seuls comptes dessinables : ceux qui existent et sont actifs. */
async function loadPinSubjects(ids) {
  if (ids.length === 0) return [];
  return sequelize.query(
    `SELECT id, username, avatar FROM users WHERE id IN (:ids) AND is_active = TRUE`,
    { replacements: { ids }, type: QueryTypes.SELECT }
  );
}

/**
 * GET /api/nf-map/pin/:userId.png?v=precise|city|selected|self|ghost&d=3
 *
 * `d` est la densité de l'écran demandeur. iOS charge l'image avec
 * `scale: RCTScreenScale()` et Android dessine le bitmap à sa taille en
 * pixels : les deux veulent donc `points × densité`, et c'est l'app qui sait
 * laquelle elle a.
 */
router.get('/pin/:userId.png', pinLimiter, async (req, res) => {
  try {
    const [subject] = await loadPinSubjects([req.params.userId]);
    if (!subject) return res.status(404).end();

    const png = await nfMapPin.renderPersonPin({
      username: subject.username,
      avatar: subject.avatar,
      // Le libellé vient de l'appelant pour « Toi » et « Toi · invisible », qui
      // ne sont pas des pseudos. Tronqué : une étiquette est une étiquette.
      label: String(req.query.label || subject.username).slice(0, 24),
      variant: String(req.query.v || 'precise'),
      density: req.query.d,
    });

    return sendPng(res, png);
  } catch (error) {
    logger.error(`[nfMap] pin: ${error.message}`);
    return res.status(500).end();
  }
});

/**
 * GET /api/nf-map/cluster.png?ids=a,b,c&count=7&d=3
 *
 * `ids` ne porte QUE les visages montrés — trois au plus. Envoyer la
 * composition entière d'un groupe de quarante allongerait l'URL sans rien
 * ajouter à l'image, et ferait rater le cache à chaque fois qu'un membre
 * lointain bouge.
 */
router.get('/cluster.png', pinLimiter, async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, nfMapPin.CLUSTER.maxFaces);

    const count = Math.max(ids.length, Math.min(9999, Number(req.query.count) || 0));
    const subjects = await loadPinSubjects(ids);
    if (subjects.length === 0) return res.status(404).end();

    // L'ordre demandé fait foi : c'est lui qui décide quel visage est devant,
    // et il doit rester le même d'un rendu à l'autre pour que le cache serve.
    const byId = new Map(subjects.map((subject) => [String(subject.id), subject]));
    const faces = ids.map((id) => byId.get(String(id))).filter(Boolean);

    const png = await nfMapPin.renderClusterPin({ faces, count, density: req.query.d });
    return sendPng(res, png);
  } catch (error) {
    logger.error(`[nfMap] cluster: ${error.message}`);
    return res.status(500).end();
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Le fond de carte, servi comme une page.
 *
 * Ces routes sont SANS JETON, pour la même raison que les épingles ci-dessus :
 * une `WebView` ne porte l'en-tête `Authorization` que sur le document
 * principal, jamais sur ses sous-ressources (script, style, tuiles, glyphes).
 * Une route protégée répondrait 401 à tout ce que la page charge.
 *
 * Ce qu'on accepte de servir en clair ne contient AUCUNE donnée d'utilisateur :
 * un moteur de rendu vide et des tuiles cartographiques publiques. Les
 * positions, elles, continuent de passer par `/nearby`, authentifié — c'est
 * l'app qui les pousse dans la page. Cette séparation est la condition qui rend
 * l'ouverture acceptable, et elle doit le rester.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Racine des URLs que la page fabrique pour elle-même. */
const webViewBase = () => `${getPublicMediaOrigin()}/api/nf-map`;

/**
 * Limite propre au fond de carte, distincte de celle des épingles.
 *
 * Un premier affichage charge facilement cent tuiles, plus les glyphes et le
 * sprite. Partager le quota des épingles ferait échouer l'un à cause de
 * l'autre, et une carte à trous ne dit pas laquelle des deux a manqué.
 */
const tileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes' },
});

/** Un an : ces URLs portent la version de MapLibre, elles sont immuables. */
const ASSET_CACHE_SECONDS = 365 * 24 * 60 * 60;
/** Les tuiles changent, mais lentement. Une semaine sur l'appareil. */
const TILE_CACHE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Rapatrie une ressource du fournisseur et la renvoie telle quelle.
 *
 * L'URL amont n'arrive JAMAIS du client : elle est résolue par
 * `nfMapWebView` à partir du style, que seul le serveur connaît. Voir
 * l'en-tête de ce fichier — sans cette règle, la route serait un proxy ouvert.
 */
async function pipeUpstream(res, url, contentType) {
  const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!upstream.ok) return res.status(upstream.status === 404 ? 404 : 502).end();

  const body = Buffer.from(await upstream.arrayBuffer());
  res.set('Content-Type', contentType || upstream.headers.get('content-type') || 'application/octet-stream');
  res.set('Cache-Control', `public, max-age=${TILE_CACHE_SECONDS}`);
  return res.send(body);
}

/**
 * GET /api/nf-map/view — la page elle-même.
 *
 * Sa CSP est posée ici, par-dessus celle d'helmet, et elle est PLUS stricte que
 * ce que la page pourrait demander : un nonce plutôt que `unsafe-inline`, et
 * `worker-src 'self'` sans `blob:` — ce qui n'est possible que grâce au build
 * « CSP » de MapLibre (voir `MAPLIBRE_FILES`). `connect-src 'self'` verrouille
 * le reste : la page ne peut parler qu'à cette API, jamais au fournisseur de
 * tuiles en direct, donc jamais avec la clé.
 */
router.get('/view', tileLimiter, (req, res) => {
  const nonce = nfMapWebView.__nonce();

  res.set(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'self' 'nonce-${nonce}'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "worker-src 'self'",
      "child-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.set('Content-Type', 'text/html; charset=utf-8');
  // Courte : la page est minuscule et c'est le seul moyen d'y corriger quelque
  // chose sans attendre qu'un appareil veuille bien la relire. Tout ce qui pèse
  // (MapLibre, le pont) est derrière une URL versionnée, donc mis en cache pour
  // un an — la page ne fait que les désigner.
  res.set('Cache-Control', 'public, max-age=300');
  res.set('X-Content-Type-Options', 'nosniff');

  // Le thème vient de l'app, qui seule connaît le réglage de l'utilisateur.
  // Sans lui la carte restait sombre sur une app claire, et tout ce qui flotte
  // au-dessus devenait une dalle blanche posée sur du noir.
  return res.send(
    nfMapWebView.pageHtml({ base: webViewBase(), nonce, theme: req.query.theme })
  );
});

/** GET /api/nf-map/bridge.js — le moteur de rendu, côté page. */
router.get('/bridge.js', tileLimiter, (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', `public, max-age=${ASSET_CACHE_SECONDS}, immutable`);
  return res.sendFile(path.join(__dirname, '../web/nf-map/bridge.js'));
});

/** GET /api/nf-map/maplibre.js|maplibre-worker.js|maplibre.css */
router.get(/^\/(maplibre\.js|maplibre-worker\.js|maplibre\.css)$/, tileLimiter, (req, res) => {
  const file = nfMapWebView.maplibreFile(req.params[0]);
  if (!file) return res.status(404).end();

  res.set('Content-Type', file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8');
  res.set('Cache-Control', `public, max-age=${ASSET_CACHE_SECONDS}, immutable`);
  return res.sendFile(file);
});

/**
 * GET /api/nf-map/style.json — le style, débarrassé de la clé du fournisseur.
 *
 * Il n'est PAS mis en cache sur l'appareil : c'est le seul point par lequel un
 * changement de fond de carte peut arriver sans redéployer l'app, et il ne pèse
 * que quelques dizaines de kilo-octets.
 */
router.get('/style.json', tileLimiter, async (req, res) => {
  try {
    const style = await nfMapWebView.clientStyle(webViewBase(), req.query.theme);
    res.set('Cache-Control', 'public, max-age=600');
    // Deux réponses différentes pour la même URL sans `theme` : les caches
    // intermédiaires doivent le savoir, sinon un appareil clair reçoit la
    // carte sombre mise en cache par un appareil sombre.
    res.set('Vary', 'Accept-Encoding');
    return res.json(style);
  } catch (error) {
    logger.error(`[nfMap] style: ${error.message}`);
    return res.status(502).end();
  }
});

/** GET /api/nf-map/tiles/:source/:z/:x/:y — une tuile, sans la clé. */
router.get('/tiles/:source/:z/:x/:y', tileLimiter, async (req, res) => {
  try {
    const url = await nfMapWebView.tileUpstream(
      webViewBase(),
      req.params.source,
      Number(req.params.z),
      Number(req.params.x),
      // Le gabarit peut désigner l'extension (`{y}.pbf`) : on ne garde que le
      // nombre, et `tileUpstream` refuse tout ce qui n'est pas un entier.
      Number(String(req.params.y).replace(/\..*$/, ''))
    );
    if (!url) return res.status(404).end();
    return await pipeUpstream(res, url);
  } catch (error) {
    logger.error(`[nfMap] tuile: ${error.message}`);
    return res.status(502).end();
  }
});

/** GET /api/nf-map/glyphs/:fontstack/:range.pbf — les polices des étiquettes. */
router.get('/glyphs/:fontstack/:range.pbf', tileLimiter, async (req, res) => {
  try {
    const url = await nfMapWebView.glyphUpstream(
      webViewBase(),
      req.params.fontstack,
      req.params.range
    );
    if (!url) return res.status(404).end();
    return await pipeUpstream(res, url, 'application/x-protobuf');
  } catch (error) {
    logger.error(`[nfMap] glyphes: ${error.message}`);
    return res.status(502).end();
  }
});

/**
 * GET /api/nf-map/sprite.json|.png|@2x.json|@2x.png — les icônes du style.
 *
 * Une expression plutôt qu'un paramètre : `@2x.png` n'est pas un segment de
 * chemin ordinaire, et le laisser passer par un `:param` ferait dépendre le
 * découpage des règles de `path-to-regexp`.
 */
router.get(/^\/sprite(@2x)?\.(json|png)$/, tileLimiter, async (req, res) => {
  try {
    const variant = `${req.params[0] || ''}.${req.params[1]}`;
    const url = await nfMapWebView.spriteUpstream(webViewBase(), variant);
    if (!url) return res.status(404).end();
    return await pipeUpstream(res, url, req.params[1] === 'png' ? 'image/png' : 'application/json');
  } catch (error) {
    logger.error(`[nfMap] sprite: ${error.message}`);
    return res.status(502).end();
  }
});

/** GET /api/nf-map/me — mes réglages de partage. */
router.get('/me', guard, async (req, res) => {
  try {
    const settings = await nfMap.getSettings(sequelize, req.user.id);
    return res.json({
      success: true,
      data: {
        ...settings,
        // Servi par l'API pour que l'écran n'ait pas à redire les règles :
        // une explication dupliquée dans l'app devient fausse en silence.
        policy: {
          modes: nfMap.SHARING_MODES,
          audiences: nfMap.AUDIENCES,
          ttl_hours: nfMap.PRESENCE_TTL_HOURS,
          city_precision_km: Math.round(nfMap.CITY_GRID_DEGREES * 111),
        },
      },
    });
  } catch (error) {
    logger.error(`[nfMap] getSettings: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Réglages indisponibles' });
  }
});

/** PUT /api/nf-map/me — changer de mode ou de public. */
router.put('/me', [...guard, denySuspended], async (req, res) => {
  try {
    const settings = await nfMap.updateSettings(sequelize, req.user.id, req.body || {});
    logger.info(`[nfMap] ${req.user.username || req.user.id} → mode ${settings.sharing_mode}`);
    return res.json({ success: true, data: settings });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/nf-map/position — l'app pousse la position courante.
 *
 * Le mode est relu en base : le client ne décide pas de sa propre précision.
 */
router.post('/position', [...guard, denySuspended], async (req, res) => {
  try {
    const result = await nfMap.updatePosition(sequelize, req.user.id, req.body || {});
    if (!result.stored && result.reason === 'invalid_position') {
      return res.status(400).json({ success: false, message: 'Position invalide' });
    }
    return res.json({ success: true, data: result });
  } catch (error) {
    logger.error(`[nfMap] updatePosition: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Position non enregistrée' });
  }
});

/** DELETE /api/nf-map/position — disparaître tout de suite. */
router.delete('/position', guard, async (req, res) => {
  try {
    await nfMap.clearPresence(sequelize, req.user.id);
    return res.json({ success: true });
  } catch (error) {
    logger.error(`[nfMap] clearPresence: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Effacement impossible' });
  }
});

/** GET /api/nf-map/nearby?north=&south=&east=&west= */
router.get('/nearby', guard, async (req, res) => {
  try {
    const people = await nfMap.nearby(sequelize, req.user.id, req.query);
    return res.json({ success: true, data: { people } });
  } catch (error) {
    // Un rectangle refusé est une erreur d'appel, pas une panne.
    return res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/nf-map/friends — mes liens, et qui partage.
 *
 * Répond à « pourquoi ma carte est vide » en nommant les amis qui ne
 * partagent pas. Leur nom, jamais leur position : un compte qui n'a rien
 * activé n'a aucune position à montrer, et on ne va pas la chercher ailleurs.
 */
router.get('/friends', guard, async (req, res) => {
  try {
    const people = await nfMap.connections(sequelize, req.user.id);
    return res.json({
      success: true,
      data: {
        people,
        sharing_count: people.filter((person) => person.is_sharing).length,
      },
    });
  } catch (error) {
    logger.error(`[nfMap] connections: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Liste indisponible' });
  }
});

/** POST /api/nf-map/invite/:userId — « montre-toi sur la carte ». */
router.post('/invite/:userId', [...guard, denySuspended], async (req, res) => {
  try {
    const result = await nfMap.invite(sequelize, Notification, req.user, req.params.userId);
    if (!result.sent && result.reason === 'already_invited_today') {
      return res.json({ success: true, data: result, message: 'Déjà demandé aujourd\'hui' });
    }
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

module.exports = router;
