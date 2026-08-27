const { OAuthToken, User, DeveloperApp } = require('../models');
const { maybeExpireSubscription } = require('../utils/subscriptionHelpers');
const logger = require('../utils/logger');

/**
 * Résout un access token OAuth (`oauth_tokens.access_token`, opaque — pas un
 * JWT) en utilisateur. Distinct d'`authenticateToken` : celui-ci sert les
 * clients first-party (JWT signé), celui-là sert les apps tierces
 * enregistrées dans `DeveloperApp`.
 *
 * Séparé de la vérification de scope (`requireOAuthScopes`) pour pouvoir
 * tourner tôt dans la chaîne — avant les limiteurs de débit par palier
 * d'abonnement dans `server.js`, qui ont besoin de `req.user.subscriptionTier`
 * avant même de savoir quel scope la route va exiger.
 */
async function resolveOAuthUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const accessToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!accessToken) {
      return res.status(401).json({ success: false, message: 'Token d\'accès requis' });
    }

    const token = await OAuthToken.findOne({ where: { access_token: accessToken } });
    if (!token) {
      return res.status(401).json({ success: false, message: 'Token invalide' });
    }
    if (new Date(token.expires_at) < new Date()) {
      return res.status(401).json({ success: false, message: 'Token expiré' });
    }

    const app = await DeveloperApp.findByPk(token.developer_app_id);
    if (!app || !app.is_active) {
      return res.status(401).json({ success: false, message: 'Application développeur désactivée' });
    }

    const user = await User.findOne({
      where: { id: token.user_id, is_active: true, is_suspended: false },
    });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Utilisateur introuvable ou suspendu' });
    }

    // Lu à chaque appel, pas seulement quand l'app first-party le déclenche :
    // un abonnement Ultra/Pro expiré doit retomber sur les limites Free
    // immédiatement, pas seulement à la prochaine visite dans l'app.
    await maybeExpireSubscription(user);

    req.user = {
      id: user.id,
      username: user.username,
      verified: user.verified,
      subscriptionTier: user.subscription_tier,
    };
    req.oauthApp = app;
    req.oauthScopes = Array.isArray(token.scopes) ? token.scopes : [];
    next();
  } catch (error) {
    logger.error('Erreur d\'authentification OAuth:', error);
    return res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
}

/**
 * Exige qu'au moins un des scopes listés soit présent sur le token déjà
 * résolu par `resolveOAuthUser` (dans cette même chaîne de middlewares).
 */
function requireOAuthScopes(requiredScopes = []) {
  return (req, res, next) => {
    if (!req.user || !req.oauthScopes) {
      return res.status(401).json({ success: false, message: 'Token d\'accès requis' });
    }
    if (requiredScopes.length > 0 && !requiredScopes.some((s) => req.oauthScopes.includes(s))) {
      return res.status(403).json({
        success: false,
        message: `Scope requis: ${requiredScopes.join(' ou ')}`,
      });
    }
    next();
  };
}

/** Compose les deux étapes — pratique hors de la chaîne app-level de `server.js`. */
const authenticateOAuthToken = (requiredScopes = []) => (req, res, next) =>
  resolveOAuthUser(req, res, () => requireOAuthScopes(requiredScopes)(req, res, next));

module.exports = { resolveOAuthUser, requireOAuthScopes, authenticateOAuthToken };
