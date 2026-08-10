'use strict';

/**
 * Garde de route adossée à un drapeau de fonctionnalité.
 *
 * Permet de livrer une route neuve derrière un drapeau éteint : le code part
 * en production, personne ne l'atteint, et on l'ouvre progressivement depuis
 * l'écran d'administration sans redéployer.
 *
 *   router.post('/tweets/:id/boost', authenticateToken, requireFlag('tweets.boost'), controller.boost);
 *
 * Réponse 404 et non 403 quand le drapeau est éteint : pour l'appelant, la
 * fonctionnalité n'existe pas encore. Un 403 révélerait qu'une route cachée
 * attend derrière, ce qui invite à la chercher.
 */

const featureFlags = require('../services/featureFlagService');

function requireFlag(key, { status = 404, message = 'Ressource introuvable' } = {}) {
  return async function featureFlagGuard(req, res, next) {
    try {
      const context = await featureFlags.contextFromRequest(req);
      const decision = await featureFlags.evaluateFlag(key, context);

      if (!decision.enabled) {
        return res.status(status).json({ success: false, message });
      }

      // La décision est posée sur la requête : le contrôleur peut lire la
      // variante servie sans réévaluer le drapeau.
      req.featureFlag = decision;
      return next();
    } catch (error) {
      // Un drapeau qui ne s'évalue pas ferme la porte. Voir la règle de
      // dégradation de featureFlagService : en cas de doute, l'ancien
      // comportement, jamais le neuf.
      return res.status(status).json({ success: false, message });
    }
  };
}

/**
 * Variante non bloquante : pose la décision sur `req.featureFlag` et laisse
 * passer. Pour les routes qui doivent servir les deux comportements.
 */
function attachFlag(key) {
  return async function featureFlagAttach(req, res, next) {
    try {
      const context = await featureFlags.contextFromRequest(req);
      req.featureFlag = await featureFlags.evaluateFlag(key, context);
    } catch (error) {
      req.featureFlag = { enabled: false, variant: null, payload: null, reason: 'error' };
    }
    return next();
  };
}

module.exports = { requireFlag, attachFlag };
