/**
 * La place, vue par son porteur : `https://<domaine>/i/<jeton>`.
 *
 * ── Pourquoi à la racine et pas sous /api ─────────────────────────────────
 * Cette URL est celle qui est INSCRITE DANS LE CODE QR. Chaque caractère de
 * plus densifie le motif : `/api/event-passes/i/` au lieu de `/i/` coûte une
 * version entière de code QR, donc des modules plus petits et un scan plus
 * laborieux. C'est aussi une URL qu'on lit à voix haute, qu'on colle dans un
 * message, qu'on tape à la main quand plus rien ne marche.
 *
 * ── Pourquoi sans authentification ────────────────────────────────────────
 * Le jeton EST le titre d'accès, comme un billet papier : qui l'a, l'a. Il
 * n'ouvre rien d'autre que l'affichage de cette place-là — ni la liste des
 * invités, ni l'événement, ni le moindre compte. Et il ne VALIDE rien : voir
 * sa place ne la consomme pas, seul un poste de contrôle authentifié peut la
 * faire passer.
 */

const express = require('express');

const router = express.Router();

const eventPassService = require('../services/eventPassService');
const { renderPassSvg, renderQrOnlySvg } = require('../services/eventPass/passArt');
const { passPageHtml, passNotFoundHtml } = require('../services/eventPass/pages');
const logger = require('../utils/logger');

/** Découpe `JETON.svg` en { jeton, format }. */
function splitFormat(raw) {
  const value = String(raw || '');
  const match = value.match(/^(.+?)\.(svg|png)$/i);
  if (!match) return { token: value, format: 'html' };
  return { token: match[1], format: match[2].toLowerCase() };
}

/** L'état affiché à l'invité, dans ses mots à lui. */
function statusKey(pass) {
  if (pass.status === 'revoked') return 'revoked';
  if (pass.expires_at && new Date(pass.expires_at) < new Date()) return 'expired';
  if (pass.status === 'used' || pass.scans_count >= pass.max_scans) return 'used';
  return 'valid';
}

router.get('/:token', async (req, res) => {
  const { token, format } = splitFormat(req.params.token);

  try {
    const result = await eventPassService.inspect(token);

    // Une place refusée (annulée, déjà passée) s'affiche quand même : son
    // porteur a le droit de comprendre POURQUOI il est refusé, plutôt que de
    // tomber sur une page vide devant l'entrée. Seul un jeton invalide ou
    // inconnu ne montre rien.
    if (!result.pass) {
      const message = result.reason === 'BAD_SIGNATURE'
        ? 'Ce code n’a pas été émis par TwitNinf.'
        : 'Le lien est incomplet, ou la place n’existe plus.';
      if (format === 'html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(404).send(passNotFoundHtml(message));
      }
      return res.status(404).json({ success: false, message });
    }

    const { pass } = result;
    const art = eventPassService.toArtModel(pass);
    const payload = eventPassService.buildQrPayload(pass.code);

    // Jamais de cache partagé : une place est nominative, et son état change
    // à la seconde où elle passe la porte.
    res.setHeader('Cache-Control', 'no-store, private');

    if (format === 'svg') {
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      return res.send(req.query.qr === 'seul'
        ? renderQrOnlySvg(payload)
        : renderPassSvg(art, payload));
    }

    if (format === 'png') {
      // `sharp` est déjà une dépendance de l'API (traitement des médias).
      const sharp = require('sharp');
      const width = Math.min(Math.max(Number.parseInt(req.query.w, 10) || 1080, 320), 2160);
      const png = await sharp(Buffer.from(renderPassSvg(art, payload)))
        .resize({ width })
        .png()
        .toBuffer();
      res.setHeader('Content-Type', 'image/png');
      return res.send(png);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(passPageHtml({
      svg: renderPassSvg(art, payload),
      pass,
      statusKey: statusKey(pass),
    }));
  } catch (error) {
    logger.error('[Places] page publique:', error);
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(500).send(passNotFoundHtml('Le service est momentanément indisponible.'));
    }
    return res.status(500).json({ success: false, message: 'Service indisponible.' });
  }
});

module.exports = router;
