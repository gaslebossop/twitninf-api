/**
 * Routes de la modération communautaire — BÊTA.
 *
 * Montage dans server.js :
 *   app.use('/api/community-moderation', require('./routes/communityModerationRoutes'))
 *
 * Seule l'app Windows consomme ces routes pour l'instant (fonctionnalité en
 * bêta, volontairement limitée à une plateforme le temps d'observer comment
 * les gens votent).
 *
 * ⚠ Principe qui gouverne les réponses de ce routeur : le juré n'apprend RIEN
 * de ce que pensent les autres, ni de ce qui découle de son vote. Pas de
 * décompte de voix, pas de motifs de signalement, pas de sanction renvoyée.
 * Tout ça influencerait le jugement suivant, et la revue ne vaudrait plus rien.
 */

const express = require('express');
const router = express.Router();
const { param, body, validationResult } = require('express-validator');
const { authenticateToken, denySuspended, requireAdminRole } = require('../middleware/authMiddleware');
const service = require('../services/communityModerationService');
const logger = require('../utils/logger');

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: 'Requête invalide', errors: errors.array() });
  }
  next();
}

/**
 * GET /api/community-moderation/next
 * Le contenu confié à cette personne, ou `null` si rien ne lui est attribuable.
 *
 * Idempotent : tant qu'elle n'a pas voté, le même appel renvoie le même
 * contenu. Rafraîchir la page ne consomme donc pas un item de plus, et ne
 * permet pas de « passer » un contenu gênant en rechargeant.
 *
 * `ineligible` porte la raison quand le compte n'a pas le droit de siéger
 * (trop récent, inactif) — l'app doit l'expliquer plutôt que d'afficher une
 * file vide qui ressemblerait à une panne.
 *
 * La file est réalimentée à la volée quand elle se vide : ça évite d'ajouter
 * un travailleur de fond pour une fonctionnalité en bêta, au prix d'une
 * requête plus lente de temps en temps.
 */
router.get('/next', authenticateToken, denySuspended, async (req, res) => {
  try {
    let next = await service.nextItemFor(req.user.id);

    if (!next.item && !next.ineligible) {
      await service.enqueueReportedTweets(5);
      next = await service.nextItemFor(req.user.id);
    }

    res.json({
      success: true,
      data: {
        item: next.item,
        ineligible: next.ineligible,
        stats: await service.stats(req.user.id),
      },
    });
  } catch (error) {
    logger.error('[communityModeration] GET /next:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * POST /api/community-moderation/:itemId/vote
 * Body : { verdict: 'compliant' | 'violation' }
 *
 * Le corps ne porte plus que le verdict : le questionnaire de gravité a été
 * supprimé. Le verdict du jury est final ; un modèle arbitre choisit ensuite
 * uniquement la sanction et, en cas de suspension, sa durée exacte
 * (voir `communityReviewAdjudicator`).
 *
 * La réponse est volontairement vide de tout résultat — ni le décompte du
 * jury, ni la sanction. Un juré qui apprend qu'il vient de faire bannir
 * quelqu'un ne vote plus pareil au contenu suivant.
 */
router.post('/:itemId/vote', [
  authenticateToken,
  denySuspended,
  param('itemId').isUUID().withMessage('Identifiant invalide'),
  body('verdict').isIn(['compliant', 'violation']).withMessage('Verdict invalide'),
  handleValidationErrors,
], async (req, res) => {
  try {
    const result = await service.castVote(req.user.id, req.params.itemId, req.body.verdict);
    if (!result.ok) {
      return res.status(409).json({ success: false, message: result.reason });
    }
    res.json({ success: true, data: { recorded: true } });
  } catch (error) {
    logger.error('[communityModeration] POST /vote:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * GET /api/community-moderation/admin/jurors?limit=50
 * Classement des jurés — ADMIN UNIQUEMENT.
 *
 * ⚠ Cette route est la seule de ce routeur à exposer QUI a voté et comment.
 * Elle est donc derrière `requireAdminRole`, et son contenu ne doit jamais
 * redescendre vers les jurés : un classement visible transformerait la revue en
 * concours, et un concours se gagne en votant vite et comme les autres.
 */
router.get('/admin/jurors', authenticateToken, requireAdminRole, async (req, res) => {
  try {
    const [jurors, overview] = await Promise.all([
      service.jurorLeaderboard(req.query.limit),
      service.reviewOverview(),
    ]);
    res.json({ success: true, data: { jurors, overview } });
  } catch (error) {
    logger.error('[communityModeration] GET /admin/jurors:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/** GET /api/community-moderation/stats */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    res.json({ success: true, data: await service.stats(req.user.id) });
  } catch (error) {
    logger.error('[communityModeration] GET /stats:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

module.exports = router;
