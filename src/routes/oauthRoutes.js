const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { DeveloperApp, OAuthCode, OAuthToken } = require('../models');
const { authenticateToken } = require('../middleware/authMiddleware');
const { OAUTH_SCOPES, sanitizeScopes } = require('../constants/oauthScopes');
const logger = require('../utils/logger');

const router = express.Router();

const CODE_TTL_MS = 10 * 60 * 1000; // 10 min, à usage unique
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Comparaison à temps constant : `===` sur deux chaînes fuit leur longueur
 * de préfixe commun via le temps de réponse, ce qui permet de reconstruire
 * `client_secret` octet par octet. `timingSafeEqual` exige des buffers de
 * même taille — on égalise avec un buffer nul plutôt que de sortir tôt sur
 * une longueur différente, qui réintroduirait la même fuite.
 */
function secretsMatch(stored, presented) {
  const a = Buffer.from(String(stored || ''), 'utf8');
  const b = Buffer.from(String(presented || ''), 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

/**
 * POST /api/oauth/authorize
 * Étape "consentement" du flow OAuth authorization-code. Appelée par
 * l'utilisateur CONNECTÉ (JWT first-party) depuis l'écran de consentement du
 * site développeur — pas par l'app tierce elle-même, qui n'a jamais accès au
 * compte de l'utilisateur. Rend un `code` à usage unique que le site
 * redirige ensuite vers `redirect_uri`.
 */
router.post('/authorize', [
  authenticateToken,
  body('client_id').isString().notEmpty(),
  body('redirect_uri').isString().notEmpty(),
  body('scopes').isArray({ min: 1 }),
  handleValidationErrors,
], async (req, res) => {
  try {
    const { client_id, redirect_uri, scopes } = req.body;

    const app = await DeveloperApp.findOne({ where: { client_id, is_active: true } });
    if (!app) {
      return res.status(400).json({ success: false, message: 'Application développeur inconnue', code: 'invalid_client' });
    }

    if (!Array.isArray(app.redirect_uris) || !app.redirect_uris.includes(redirect_uri)) {
      return res.status(400).json({ success: false, message: 'redirect_uri non enregistrée pour cette application', code: 'invalid_redirect_uri' });
    }

    const requestedScopes = sanitizeScopes(scopes);
    if (requestedScopes.length === 0) {
      return res.status(400).json({ success: false, message: 'Aucun scope valide demandé', code: 'invalid_scope' });
    }

    const code = crypto.randomBytes(24).toString('hex');
    await OAuthCode.create({
      code,
      developer_app_id: app.id,
      user_id: req.user.id,
      redirect_uri,
      scopes: requestedScopes,
      expires_at: new Date(Date.now() + CODE_TTL_MS),
    });

    res.json({ success: true, data: { code, scopes: requestedScopes } });
  } catch (error) {
    logger.error('Erreur OAuth authorize:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * POST /api/oauth/token
 * Échange un `code` (grant_type=authorization_code) ou un `refresh_token`
 * (grant_type=refresh_token) contre un access token. Authentifié par
 * `client_id`+`client_secret` dans le corps — c'est l'app tierce qui appelle
 * cette route depuis son propre backend, jamais depuis le navigateur.
 */
router.post('/token', [
  body('grant_type').isIn(['authorization_code', 'refresh_token']),
  body('client_id').isString().notEmpty(),
  body('client_secret').isString().notEmpty(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const { grant_type, client_id, client_secret } = req.body;

    const app = await DeveloperApp.findOne({ where: { client_id, is_active: true } });
    if (!app || !secretsMatch(app.client_secret, client_secret)) {
      return res.status(401).json({ success: false, message: 'client_id/client_secret invalides', code: 'invalid_client' });
    }

    if (grant_type === 'authorization_code') {
      const { code, redirect_uri } = req.body;
      if (!code || !redirect_uri) {
        return res.status(400).json({ success: false, message: 'code et redirect_uri requis', code: 'invalid_request' });
      }

      const authCode = await OAuthCode.findOne({ where: { code, developer_app_id: app.id } });
      if (!authCode || authCode.redirect_uri !== redirect_uri || new Date(authCode.expires_at) < new Date()) {
        return res.status(400).json({ success: false, message: 'code invalide ou expiré', code: 'invalid_grant' });
      }

      // À usage unique : détruit avant l'émission du token pour qu'un rejeu
      // du même code (réseau qui double la requête, ou vol du code) échoue.
      await authCode.destroy();

      const token = await OAuthToken.create({
        developer_app_id: app.id,
        user_id: authCode.user_id,
        access_token: crypto.randomBytes(32).toString('hex'),
        refresh_token: crypto.randomBytes(32).toString('hex'),
        scopes: authCode.scopes,
        expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
      });

      return res.json({
        success: true,
        data: {
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL_MS / 1000,
          scopes: token.scopes,
        },
      });
    }

    // grant_type === 'refresh_token'
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ success: false, message: 'refresh_token requis', code: 'invalid_request' });
    }

    const existing = await OAuthToken.findOne({ where: { refresh_token, developer_app_id: app.id } });
    if (!existing) {
      return res.status(400).json({ success: false, message: 'refresh_token invalide', code: 'invalid_grant' });
    }

    existing.access_token = crypto.randomBytes(32).toString('hex');
    existing.expires_at = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
    await existing.save();

    res.json({
      success: true,
      data: {
        access_token: existing.access_token,
        refresh_token: existing.refresh_token,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_MS / 1000,
        scopes: existing.scopes,
      },
    });
  } catch (error) {
    logger.error('Erreur OAuth token:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * POST /api/oauth/revoke
 * Révocation par le développeur (connecté en first-party) d'un token émis
 * pour l'une de ses apps — ex: fuite d'un token de test.
 */
router.post('/revoke', [
  authenticateToken,
  body('token_id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const token = await OAuthToken.findByPk(req.body.token_id, {
      include: [{ model: DeveloperApp, as: 'app' }],
    });
    if (!token || !token.app || token.app.user_id !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Token introuvable' });
    }
    await token.destroy();
    res.json({ success: true, message: 'Token révoqué' });
  } catch (error) {
    logger.error('Erreur OAuth revoke:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

router.get('/scopes', (req, res) => {
  res.json({ success: true, data: { scopes: OAUTH_SCOPES } });
});

/**
 * GET /api/oauth/client/:client_id
 * Identité minimale d'une app, pour l'écran de consentement — jamais son
 * `client_secret` ni `user_id`. Public : l'écran doit pouvoir afficher « X
 * demande l'accès » avant même que le visiteur soit connecté.
 */
router.get('/client/:client_id', async (req, res) => {
  try {
    const app = await DeveloperApp.findOne({
      where: { client_id: req.params.client_id, is_active: true },
      attributes: ['name', 'description'],
    });
    if (!app) return res.status(404).json({ success: false, message: 'Application inconnue' });
    res.json({ success: true, data: { name: app.name, description: app.description } });
  } catch (error) {
    logger.error('Erreur OAuth client lookup:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

module.exports = router;
