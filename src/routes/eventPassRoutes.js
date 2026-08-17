/**
 * Places d'invitation — émission, contrôle à l'entrée, suivi.
 *
 * Trois publics, trois niveaux d'accès :
 *   • l'ORGANISATEUR (rôle admin) émet, révoque, suit ;
 *   • le POSTE DE CONTRÔLE valide les entrées — soit un compte modérateur,
 *     soit un lien de porte à durée limitée (voir `doorAccess` plus bas) ;
 *   • l'INVITÉ voit ses propres places, et rien d'autre.
 *
 * La page publique d'une place (celle qu'ouvre l'appareil photo) n'est pas ici
 * mais dans `eventPassPageRoutes.js` : elle est montée à la racine, sur `/i`,
 * pour que l'URL inscrite dans le code QR reste courte — chaque caractère de
 * plus densifie le motif.
 */

const express = require('express');

const router = express.Router();

const eventPassService = require('../services/eventPassService');
const { renderPassSvg } = require('../services/eventPass/passArt');
const { scannerPageHtml, scannerScript } = require('../services/eventPass/pages');
const {
  authenticateToken,
  requireAdminRole,
  requireModeratorRole,
} = require('../middleware/authMiddleware');
const { EventPass, User } = require('../models');
const logger = require('../utils/logger');

const { EventPassError } = eventPassService;

function fail(res, error, fallback) {
  if (error instanceof EventPassError) {
    return res.status(error.status).json({
      success: false, message: error.message, code: error.code,
    });
  }
  logger.error(`[Places] ${fallback}:`, error);
  return res.status(500).json({ success: false, message: fallback });
}

// ── Poste de contrôle dans le navigateur ────────────────────────────────────
//
// Pas d'authentification sur la PAGE : elle ne montre rien. Ce qui autorise
// quoi que ce soit, c'est le jeton de porte, que la page lit dans le fragment
// de l'URL et renvoie sur chaque validation. Une page ouverte sans jeton
// affiche un avertissement et ne peut rien valider.

router.get('/scanner', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(scannerPageHtml());
});

router.get('/scanner.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(scannerScript());
});

// ── Contrôle à l'entrée ─────────────────────────────────────────────────────

/**
 * Deux façons d'être autorisé à valider une entrée :
 *   • un compte modérateur/admin connecté (l'équipe interne) ;
 *   • un jeton de porte, transmis par l'organisateur pour une soirée donnée.
 *
 * Le jeton de porte ne donne accès qu'à `verify` et `redeem`, et seulement sur
 * son événement : `req.doorEvent` est ensuite imposé au service, ce qui rend
 * impossible de valider avec lui une place d'un autre événement.
 */
async function doorAccess(req, res, next) {
  const rawToken = req.get('X-Door-Token') || req.body?.door_token;
  if (rawToken) {
    const door = eventPassService.verifyDoorToken(rawToken);
    if (!door) {
      return res.status(401).json({
        success: false,
        message: 'Lien de contrôle expiré ou invalide. Demande-en un nouveau.',
        code: 'DOOR_TOKEN_INVALID',
      });
    }
    req.doorEvent = door.event_slug;
    req.doorIssuer = door.issued_by;
    return next();
  }

  return authenticateToken(req, res, () => requireModeratorRole(req, res, next));
}

/** Regarde une place sans la consommer. */
router.post('/verify', doorAccess, async (req, res) => {
  try {
    const result = await eventPassService.inspect(req.body?.token, {
      eventSlug: req.doorEvent || req.body?.event_slug,
    });
    return res.json({
      success: true,
      data: {
        ok: result.ok,
        reason: result.reason || null,
        message: result.message || null,
        manual: result.manual || false,
        pass: result.pass ? result.pass.toPublicJSON() : null,
        guest: result.pass?.guest || null,
      },
    });
  } catch (error) {
    return fail(res, error, 'Vérification impossible.');
  }
});

/**
 * Valide une entrée. C'est le seul appel qui CONSOMME une place — d'où la
 * séparation avec `/verify` : une équipe qui veut d'abord lire le nom ne doit
 * pas brûler la place en la regardant.
 */
router.post('/redeem', doorAccess, async (req, res) => {
  try {
    const result = await eventPassService.redeem(req.body?.token, {
      scannedBy: req.user?.id || null,
      deviceLabel: req.body?.device_label,
      eventSlug: req.doorEvent || req.body?.event_slug,
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    return fail(res, error, 'Validation impossible.');
  }
});

// ── Invité ──────────────────────────────────────────────────────────────────

/**
 * Mes places. Le lien contient la signature : il vaut le billet.
 *
 * `qr` porte la MATRICE du code, pas seulement sa charge utile : l'app dessine
 * la place elle-même, depuis son cache, à l'entrée d'une salle où le réseau ne
 * passe pas. Voir `eventPassService.buildQrMatrix` pour pourquoi l'encodage
 * reste ici et ne se refait pas côté mobile.
 */
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const passes = await EventPass.findAll({
      where: { guest_user_id: req.user.id },
      order: [['createdAt', 'DESC']],
      limit: 50,
    });

    return res.json({
      success: true,
      data: passes.map((pass) => ({
        ...pass.toPublicJSON(),
        event_date_label: eventPassService.formatEventDate(pass.event_date),
        url: eventPassService.buildPassUrl(pass.code),
        qr_payload: eventPassService.buildQrPayload(pass.code),
        qr: eventPassService.buildQrMatrix(pass.code),
      })),
    });
  } catch (error) {
    return fail(res, error, 'Places indisponibles.');
  }
});

// ── Organisation ────────────────────────────────────────────────────────────

/** Émission d'un lot. */
router.post('/batch', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const created = await eventPassService.createBatch(req.body || {}, req.user.id);
    return res.status(201).json({
      success: true,
      data: {
        count: created.length,
        passes: created.map((pass) => ({
          ...pass.toAdminJSON(),
          url: eventPassService.buildPassUrl(pass.code),
        })),
      },
    });
  } catch (error) {
    return fail(res, error, 'Émission impossible.');
  }
});

/** Les événements qui ont des places, avec leur état. */
router.get('/events', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    return res.json({ success: true, data: await eventPassService.listEvents() });
  } catch (error) {
    return fail(res, error, 'Événements indisponibles.');
  }
});

router.get('/events/:slug/stats', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    return res.json({ success: true, data: await eventPassService.eventStats(req.params.slug) });
  } catch (error) {
    return fail(res, error, 'Statistiques indisponibles.');
  }
});

/**
 * Export CSV — c'est par là que passent les invitations : une colonne `lien`
 * prête à coller dans un publipostage, un message ou un courriel.
 */
router.get('/events/:slug/export.csv', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const { passes } = await eventPassService.listPasses({
      eventSlug: req.params.slug,
      limit: 500,
    });

    const escape = (value) => {
      const text = String(value == null ? '' : value);
      return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    // Point-virgule : c'est le séparateur qu'attend un tableur en français.
    const lines = [['numero', 'code', 'invite', 'palier', 'statut', 'lien'].join(';')];
    for (const pass of passes) {
      lines.push([
        pass.serial,
        pass.code,
        pass.guest_name || '',
        pass.tier,
        pass.status,
        eventPassService.buildPassUrl(pass.code),
      ].map(escape).join(';'));
    }

    const slug = eventPassService.normalizeSlug(req.params.slug) || 'places';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="places-${slug}.csv"`);
    // BOM : sans lui, Excel ouvre les accents en mojibake.
    return res.send(`﻿${lines.join('\n')}`);
  } catch (error) {
    return fail(res, error, 'Export impossible.');
  }
});

/** Lien de contrôle à durée limitée, à envoyer à l'équipe qui tient la porte. */
router.post('/events/:slug/door-link', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const door = eventPassService.createDoorToken(
      req.params.slug,
      req.body?.hours,
      req.user.id
    );
    return res.json({
      success: true,
      data: {
        ...door,
        // Le jeton passe dans le FRAGMENT : un fragment n'est jamais envoyé au
        // serveur, donc il ne finit ni dans les journaux d'accès, ni dans le
        // référent d'une page ouverte depuis celle-ci.
        url: `${eventPassService.passOrigin()}/api/event-passes/scanner#t=${door.token}`,
      },
    });
  } catch (error) {
    return fail(res, error, 'Lien de contrôle impossible.');
  }
});

/** Liste filtrable des places d'un événement. */
router.get('/', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const { total, passes } = await eventPassService.listPasses({
      eventSlug: req.query.event_slug,
      status: req.query.status,
      search: req.query.q,
      limit: req.query.limit,
      offset: req.query.offset,
    });

    return res.json({
      success: true,
      data: {
        total,
        passes: passes.map((pass) => ({
          ...pass.toAdminJSON(),
          guest: pass.guest || null,
          url: eventPassService.buildPassUrl(pass.code),
        })),
      },
    });
  } catch (error) {
    return fail(res, error, 'Places indisponibles.');
  }
});

router.post('/:id/revoke', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const pass = await eventPassService.revoke(req.params.id, {
      reason: req.body?.reason,
      actorId: req.user.id,
    });
    return res.json({ success: true, data: pass.toAdminJSON() });
  } catch (error) {
    return fail(res, error, 'Révocation impossible.');
  }
});

router.post('/:id/restore', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const pass = await eventPassService.restore(req.params.id);
    return res.json({ success: true, data: pass.toAdminJSON() });
  } catch (error) {
    return fail(res, error, 'Restauration impossible.');
  }
});

/** Aperçu du dessin d'une place, pour l'écran d'émission. */
router.get('/:id/preview.svg', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const pass = await EventPass.findByPk(req.params.id, {
      include: [{ model: User, as: 'guest', attributes: ['id', 'username', 'full_name'] }],
    });
    if (!pass) {
      return res.status(404).json({ success: false, message: 'Place introuvable.' });
    }

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.send(renderPassSvg(
      eventPassService.toArtModel(pass),
      eventPassService.buildQrPayload(pass.code)
    ));
  } catch (error) {
    return fail(res, error, 'Aperçu impossible.');
  }
});

module.exports = router;
