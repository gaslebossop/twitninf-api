'use strict';

/**
 * Routes de la Carte NF.
 *
 * Tout est derrière `requireFlag('fil.cartenf')` — y compris la lecture de ses
 * propres réglages. Tant que le palier n'est pas ouvert pour un compte, la
 * fonctionnalité n'existe pas pour lui, et l'API répond 404 plutôt que de
 * laisser deviner qu'une carte se prépare.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { QueryTypes } = require('sequelize');
const router = express.Router();

const { sequelize, Notification } = require('../models');
const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const { requireFlag } = require('../middleware/featureFlagMiddleware');
const nfMap = require('../services/nfMapService');
const nfMapPin = require('../services/nfMapPinService');
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
