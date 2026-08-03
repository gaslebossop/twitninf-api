const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const { authenticateToken, requirePremium } = require('../middleware/authMiddleware');
const profileViews = require('../services/profileViewService');
const impersonation = require('../services/impersonationWatchService');
const radar = require('../services/creatorRadarService');
const earnings = require('../services/creatorEarningsService');
const { resolveTimeZone } = require('../utils/timezone');
const logger = require('../utils/logger');

/**
 * Renseignements réservés aux abonnés : visiteurs de profil, veille
 * usurpation, radar des comptes qui montent, alertes de décollage.
 *
 * Regroupés derrière un seul préfixe parce qu'ils répondent tous à la même
 * question — « que se passe-t-il autour de mon compte que je ne vois pas ? » —
 * et qu'un écran unique les présentera ensemble.
 *
 * Toutes les routes sont derrière `requirePremium`, qui revalide le palier et
 * l'expiration en base. Aucune ne prend d'identifiant d'utilisateur en
 * paramètre : elles ne parlent que du compte connecté. Accepter un `userId`
 * reviendrait à vendre les visiteurs et les alertes de n'importe qui.
 */

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0]?.msg || 'Requête invalide',
    });
  }
  next();
}

// ── Revenus ────────────────────────────────────────────────────────────────

/**
 * GET /api/insights/earnings — ce que le compte a encaissé, jour par jour.
 *
 * Le studio n'avait qu'un total. Sans courbe ni comparaison, impossible de
 * dire si ça monte — c'est pourtant la seule question que se pose un créateur
 * en ouvrant l'écran.
 */
router.get('/earnings', [
  authenticateToken,
  requirePremium,
  query('days').optional().isInt({ min: 7, max: 90 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await earnings.earningsFor(req.user.id, {
      days: req.query.days,
      // Les jours sont ceux du créateur : une vente de 1 h du matin ne doit
      // pas tomber la veille.
      timeZone: resolveTimeZone(req),
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[insights] Revenus:', error);
    res.status(500).json({ success: false, message: 'Revenus indisponibles.' });
  }
});

// ── Visiteurs de profil ────────────────────────────────────────────────────

/** GET /api/insights/visitors — qui est passé sur ton profil (7 jours). */
router.get('/visitors', [
  authenticateToken,
  requirePremium,
  query('days').optional().isInt({ min: 1, max: 30 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await profileViews.listFor(req.user.id, { days: req.query.days });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[insights] Visiteurs:', error);
    res.status(500).json({ success: false, message: 'Visiteurs indisponibles.' });
  }
});

/** GET /api/insights/visitors/count — pastille, sans charger la liste. */
router.get('/visitors/count', authenticateToken, requirePremium, async (req, res) => {
  try {
    const count = await profileViews.countFor(req.user.id);
    res.json({ success: true, data: { count, window_days: profileViews.PROFILE_VIEW_WINDOW_DAYS } });
  } catch (error) {
    logger.error('[insights] Compteur de visiteurs:', error);
    res.status(500).json({ success: false, message: 'Compteur indisponible.' });
  }
});

/**
 * PUT /api/insights/visitors/incognito
 * Navigation discrète : voir sans être vu.
 *
 * La contrepartie de la fonctionnalité, et pas une option secondaire — sans
 * elle, l'abonnement se vendrait sur une surveillance à sens unique.
 */
router.put('/visitors/incognito', [
  authenticateToken,
  requirePremium,
  body('enabled').isBoolean().withMessage('Valeur invalide'),
  handleValidationErrors,
], async (req, res) => {
  try {
    const enabled = await profileViews.setIncognito(req.user.id, req.body.enabled);
    res.json({ success: true, data: { enabled } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || 'Réglage impossible.' });
  }
});

/** GET /api/insights/visitors/incognito — état courant du mode discret. */
router.get('/visitors/incognito', authenticateToken, requirePremium, async (req, res) => {
  try {
    const enabled = await profileViews.isIncognito(req.user.id);
    res.json({ success: true, data: { enabled } });
  } catch (error) {
    logger.error('[insights] Mode discret:', error);
    res.status(500).json({ success: false, message: 'Réglage indisponible.' });
  }
});

// ── Veille usurpation ──────────────────────────────────────────────────────

/** GET /api/insights/impersonation — comptes qui te ressemblent. */
router.get('/impersonation', [
  authenticateToken,
  requirePremium,
  query('status').optional().isIn(['open', 'reported', 'dismissed', 'all']),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await impersonation.listFor(req.user.id, { status: req.query.status });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[insights] Usurpation:', error);
    res.status(500).json({ success: false, message: 'Alertes indisponibles.' });
  }
});

/**
 * POST /api/insights/impersonation/scan
 * Relance le scan pour son propre compte.
 *
 * Utile juste après un changement d'avatar ou de pseudo, sans attendre le
 * passage périodique. Limité au compte connecté : scanner à la demande le
 * compte d'un tiers serait un outil de reconnaissance offert à qui paie.
 */
router.post('/impersonation/scan', authenticateToken, requirePremium, async (req, res) => {
  try {
    const created = await impersonation.scanUser(req.user.id);
    const data = await impersonation.listFor(req.user.id, { status: 'open' });
    res.json({ success: true, data, meta: { created } });
  } catch (error) {
    logger.error('[insights] Scan usurpation:', error);
    res.status(500).json({ success: false, message: 'Scan impossible.' });
  }
});

/** POST /api/insights/impersonation/:id/dismiss — écarter définitivement. */
router.post('/impersonation/:id/dismiss', [
  authenticateToken,
  requirePremium,
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    await impersonation.dismiss({ userId: req.user.id, alertId: req.params.id });
    res.json({ success: true, message: 'Alerte écartée' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || 'Action impossible.' });
  }
});

/**
 * POST /api/insights/impersonation/:id/report
 * Signalement en un tap : crée le signalement et marque l'alerte.
 *
 * Passe par le circuit de signalement existant plutôt que d'en ouvrir un
 * second — un rapport d'usurpation doit atterrir dans la même file que les
 * autres, sinon il est traité par personne.
 */
router.post('/impersonation/:id/report', [
  authenticateToken,
  requirePremium,
  param('id').isUUID(),
  body('details').optional({ nullable: true }).isString().isLength({ max: 500 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const { ImpersonationAlert, Report } = require('../models');
    const { Op } = require('sequelize');
    const { REPORT_CATEGORIES } = require('../config/reportCategories');
    const reportScoring = require('../services/reportScoringService');

    const alert = await ImpersonationAlert.findByPk(req.params.id);
    if (!alert) return res.status(404).json({ success: false, message: 'Alerte introuvable' });
    if (String(alert.user_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Cette alerte n\'est pas la tienne' });
    }

    // Un signalement encore ouvert sur la même cible suffit : en créer un
    // second ne ferait que gonfler artificiellement la convergence, qui est
    // précisément ce qui déclenche l'escalade automatique.
    const existing = await Report.findOne({
      where: {
        reporter_id: req.user.id,
        target_id: alert.suspect_id,
        target_type: 'user',
        status: { [Op.in]: ['pending', 'investigating'] },
      },
    });
    if (existing) {
      await impersonation.markReported({
        userId: req.user.id,
        alertId: alert.id,
        reportId: existing.id,
      });
      return res.json({
        success: true,
        message: 'Ce compte est déjà signalé, notre équipe l\'examine.',
        data: { report_id: existing.id },
      });
    }

    // Même notation que le circuit de signalement ordinaire : gravité tirée
    // de la catégorie, pondérée par la fiabilité du signaleur. Écrire une
    // gravité en dur ici sortirait ces rapports de l'agrégation.
    const category = 'impersonation';
    const catDef = REPORT_CATEGORIES[category];
    const details = req.body?.details
      ? String(req.body.details).trim().slice(0, 1000)
      : `Détecté par la veille usurpation (score ${Number(alert.score).toFixed(2)}, motifs : ${(alert.reasons || []).join(', ') || 'n/a'}).`;
    const reporterWeight = await reportScoring.getReporterWeight(req.user.id);

    const report = await Report.create({
      reporter_id: req.user.id,
      target_id: alert.suspect_id,
      target_type: 'user',
      type: 'user',
      category,
      details,
      source: 'impersonation_watch',
      reason: `[${category}] ${details.slice(0, 900)}`,
      reporter_weight: reporterWeight,
      weighted_score: reportScoring.scoreSingleReport(category, reporterWeight),
      severity: catDef.baseSeverity,
      priority: catDef.basePriority,
      status: 'pending',
    });

    await impersonation.markReported({
      userId: req.user.id,
      alertId: alert.id,
      reportId: report.id,
    });

    res.json({ success: true, message: 'Signalement envoyé', data: { report_id: report.id } });
  } catch (error) {
    logger.error('[insights] Signalement usurpation:', error);
    res.status(500).json({ success: false, message: 'Signalement impossible.' });
  }
});

// ── Radar et décollage ─────────────────────────────────────────────────────

/** GET /api/insights/rising — comptes qui montent dans ton univers. */
router.get('/rising', [
  authenticateToken,
  requirePremium,
  query('days').optional().isInt({ min: 1, max: 30 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await radar.risingAccounts(req.user.id, {
      days: req.query.days,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[insights] Radar:', error);
    res.status(500).json({ success: false, message: 'Radar indisponible.' });
  }
});

/** GET /api/insights/niche-trending — tweets qui accélèrent dans ton univers. */
router.get('/niche-trending', [
  authenticateToken,
  requirePremium,
  query('days').optional().isInt({ min: 1, max: 30 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await radar.nicheTrendingTweets(req.user.id, {
      days: req.query.days,
      limit: req.query.limit,
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[insights] Tweets de niche:', error);
    res.status(500).json({ success: false, message: 'Tweets de ta niche indisponibles.' });
  }
});

/** GET /api/insights/velocity — historique de tes tweets qui ont décollé. */
router.get('/velocity', [
  authenticateToken,
  requirePremium,
  query('limit').optional().isInt({ min: 1, max: 100 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const data = await radar.velocityHistory(req.user.id, { limit: req.query.limit });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('[insights] Décollages:', error);
    res.status(500).json({ success: false, message: 'Historique indisponible.' });
  }
});

module.exports = router;
