const express = require('express');
const { body, validationResult } = require('express-validator');
const { WebPushSubscription } = require('../models');
const webPushService = require('../services/webPushService');
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');

const router = express.Router();

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: 'Abonnement invalide', errors: errors.array() });
  }
  return next();
}

/**
 * Clé publique VAPID.
 *
 * Publique au sens propre : le navigateur en a besoin AVANT de créer
 * l'abonnement, et elle ne permet que de vérifier une signature. Route ouverte
 * (pas de jeton) — la page peut préparer l'abonnement avant la connexion.
 */
router.get('/public-key', (req, res) => {
  if (!webPushService.isConfigured()) {
    return res.status(503).json({ success: false, message: 'Web Push non configuré sur ce serveur.' });
  }
  return res.json({ success: true, data: { publicKey: webPushService.publicKey() } });
});

/**
 * Enregistre (ou réaffecte) un abonnement.
 *
 * `endpoint` est unique : un navigateur qui se réabonne rend le MÊME endpoint.
 * On met donc la ligne à jour au lieu d'en insérer une seconde — sinon le même
 * appareil recevrait deux fois chaque notification. La réaffectation compte
 * aussi : deux comptes qui se succèdent dans le même navigateur partagent cet
 * endpoint, et il doit suivre le dernier connecté.
 */
router.post('/subscribe', [
  authenticateToken,
  body('endpoint').isString().isLength({ min: 20, max: 2000 }),
  body('keys.p256dh').isString().isLength({ min: 10, max: 500 }),
  body('keys.auth').isString().isLength({ min: 5, max: 500 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    const [subscription, created] = await WebPushSubscription.findOrCreate({
      where: { endpoint },
      defaults: {
        user_id: req.user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: String(req.headers['user-agent'] || '').slice(0, 500),
      },
    });

    if (!created) {
      await subscription.update({
        user_id: req.user.id,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: String(req.headers['user-agent'] || '').slice(0, 500),
        failure_count: 0,
      });
    }

    // Ouvre le droit à la relance quotidienne dès l'abonnement, avec les
    // créneaux globaux. Sans cette ligne, un nouvel abonné n'existerait pour
    // le planificateur qu'après le recalcul de la nuit suivante — il pourrait
    // donc s'abonner le matin et ne rien recevoir de la journée, ce qui est
    // le pire moment pour ne rien recevoir.
    //
    // Volontairement non bloquant : l'abonnement lui-même a réussi, et
    // l'échouer parce que l'état de relance n'a pas pu être écrit priverait
    // l'utilisateur de TOUTES ses notifications, y compris les likes.
    try {
      const { UserNudgeState } = require('../models');
      const existing = await UserNudgeState.findByPk(req.user.id);
      if (!existing) {
        const { computeGlobalSlots } = require('../services/activityProfileService');
        await UserNudgeState.create({
          user_id: req.user.id,
          slots: await computeGlobalSlots(),
          slots_source: 'global',
        });
      }
    } catch (stateError) {
      logger.warn(`[webpush] état de relance non initialisé: ${stateError.message}`);
    }

    return res.json({ success: true, message: 'Notifications activées', data: { created } });
  } catch (error) {
    logger.error('[webpush] subscribe:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

router.post('/unsubscribe', [
  authenticateToken,
  body('endpoint').isString().isLength({ min: 20, max: 2000 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const removed = await WebPushSubscription.destroy({
      where: { endpoint: req.body.endpoint, user_id: req.user.id },
    });
    return res.json({ success: true, message: 'Notifications désactivées', data: { removed } });
  } catch (error) {
    logger.error('[webpush] unsubscribe:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * Le compte est-il joignable par Web Push ?
 *
 * Sert à l'app mobile, et à une seule décision : poser ou non ses rappels
 * LOCAUX. Depuis que le serveur relance à l'heure apprise de chacun, laisser
 * l'app poser en plus ses propres rappels ferait deux notifications pour la
 * même intention, à des heures différentes.
 *
 * On rend le compte d'abonnements plutôt qu'un booléen : l'app n'a besoin que
 * de `> 0`, mais un écran de réglages ou un diagnostic veut savoir combien
 * d'appareils sont enregistrés, et ça ne coûte pas une requête de plus.
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const subscriptions = await WebPushSubscription.count({ where: { user_id: req.user.id } });
    return res.json({
      success: true,
      data: {
        subscriptions,
        // `configured` faux veut dire que le serveur n'a pas de clés VAPID :
        // l'app doit alors garder ses rappels locaux même sans abonnement,
        // sinon elle n'aurait plus aucune notification du tout.
        configured: webPushService.isConfigured(),
      },
    });
  } catch (error) {
    logger.error('[webpush] status:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/** Envoi de contrôle vers ses propres appareils — sert à vérifier la chaîne. */
router.post('/test', authenticateToken, async (req, res) => {
  try {
    const result = await webPushService.sendToUser(req.user.id, {
      title: 'TwitNinf',
      body: 'Les notifications fonctionnent.',
      url: '/notifications',
    });
    return res.json({ success: true, message: `Envoyé à ${result.sent} appareil(s)`, data: result });
  } catch (error) {
    logger.error('[webpush] test:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

module.exports = router;
