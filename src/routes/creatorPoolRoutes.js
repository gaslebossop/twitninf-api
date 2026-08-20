/**
 * Pot créateur hebdomadaire — API de l'écran de monétisation.
 *
 * Un seul point d'entrée pour l'app (`/dashboard`) : la part à encaisser, la
 * projection de la semaine en cours, le détail de qualité et l'historique
 * n'ont aucun sens séparés, et les servir en quatre appels garantissait qu'un
 * écran affiche un montant issu d'une réponse et un RPM issu d'une autre.
 *
 * Voir `economy/creatorPool/` pour le modèle lui-même.
 */

const express = require('express');
const { body, param } = require('express-validator');
const router = express.Router();

const CreatorPoolController = require('../controllers/creatorPoolController');
const { authenticateToken, requireAdmin } = require('../middleware/authMiddleware');

// ---- Créateur -------------------------------------------------------------

/** Tout ce dont l'écran de monétisation a besoin, en un appel. */
router.get('/dashboard', authenticateToken, CreatorPoolController.getDashboard);

/** Encaisse une période close, ou toutes celles qui attendent. */
router.post(
  '/claim',
  authenticateToken,
  body('periodKey').optional().isString().matches(/^\d{4}-W\d{2}$/),
  CreatorPoolController.claim
);

/** État du compte : restrictions en cours, faits qualité, prochaine marche. */
router.get('/account-status', authenticateToken, CreatorPoolController.getAccountStatus);

// ---- Administration -------------------------------------------------------

/** Détail complet d'une période, tous créateurs — sert à vérifier un partage. */
router.get(
  '/admin/period/:key',
  authenticateToken,
  requireAdmin,
  param('key').matches(/^\d{4}-W\d{2}$/),
  CreatorPoolController.getPeriodBreakdown
);

/** Clôture manuelle. Idempotente : l'index unique absorbe un second passage. */
router.post(
  '/admin/close',
  authenticateToken,
  requireAdmin,
  body('periodKey').optional().isString().matches(/^\d{4}-W\d{2}$/),
  CreatorPoolController.closePeriod
);

router.get('/admin/settings', authenticateToken, requireAdmin, CreatorPoolController.getSettings);
router.put('/admin/settings', authenticateToken, requireAdmin, CreatorPoolController.updateSettings);

module.exports = router;
