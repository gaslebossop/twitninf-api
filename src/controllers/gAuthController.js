const crypto = require('crypto');
const gAuthService = require('../services/gAuthService');
const logger = require('../utils/logger');

function sessionContextFrom(req) {
  return {
    deviceId: req.headers['x-device-id'] || req.headers['x-fingerprint'] || null,
    platform: req.headers['user-platform'] || 'android',
    appVersion: req.headers['x-app-version'] || null,
    userAgent: req.headers['user-agent'] || null,
    ip: req.ip || null,
  };
}

class GAuthController {
  // Ouvre le navigateur système sur l'écran de connexion g-auth.
  async start(req, res) {
    try {
      const intent = req.query.intent === 'link' ? 'link' : 'login';
      const authorizeUrl = await gAuthService.startFlow({
        intent,
        linkToken: req.query.link_token || null,
        mobileRedirect: req.query.mobile_redirect || null,
        // « Se connecter avec un autre compte G » — voir AccountManagerScreen.
        forceAccountPicker: req.query.prompt === 'select_account',
      });
      return res.redirect(authorizeUrl);
    } catch (error) {
      logger.error('[g-auth] start:', error);
      const clientError = error.code === 'invalid_mobile_redirect' || error.code === 'invalid_link_token';
      return res.status(clientError ? 400 : 500).json({
        success: false,
        message: clientError ? error.message : 'Impossible de démarrer la connexion G.',
      });
    }
  }

  // g-auth revient ici avec ?code&state (ou ?error=...). Se termine toujours
  // par une redirection vers l'app — jamais par une réponse JSON — puisque
  // c'est un navigateur, pas l'app elle-même, qui est de l'autre côté.
  async callback(req, res) {
    const { code, state, error: oauthError, error_description: oauthErrorDescription } = req.query;

    let flow = null;
    if (state) {
      try {
        flow = await gAuthService.consumeState(String(state));
      } catch (error) {
        logger.error('[g-auth] callback état:', error);
      }
    }

    // Sans état retrouvé, impossible de savoir où renvoyer l'utilisateur —
    // rediriger quand même serait rediriger au hasard. Page d'erreur simple.
    if (!flow) {
      return res.status(400).send('Connexion expirée ou invalide. Retourne dans l’app et réessaie.');
    }

    const finish = (params) => res.redirect(gAuthService.buildDeepLink(flow.mobileRedirect, params));

    if (oauthError) {
      logger.warn(`[g-auth] callback refusé par g-auth: ${oauthError} ${oauthErrorDescription || ''}`);
      return finish({ intent: flow.intent, error: String(oauthError) });
    }
    if (!code) {
      return finish({ intent: flow.intent, error: 'missing_code' });
    }

    try {
      const tokens = await gAuthService.exchangeCode(String(code), flow.codeVerifier);
      const profile = await gAuthService.fetchUserinfo(tokens.access_token);

      if (flow.intent === 'link') {
        const result = await gAuthService.linkAccount(flow.userId, { sub: profile.sub });
        return finish({
          intent: 'link',
          status: result.status,
          bonus: result.bonus ?? 0,
          trialDays: result.trialDays ?? 0,
        });
      }

      const session = await gAuthService.loginOrRegister(
        { sub: profile.sub, email: profile.email, name: profile.name },
        sessionContextFrom(req),
      );
      return finish({
        intent: 'login',
        token: session.token,
        refreshToken: session.refreshToken,
        isNewAccount: session.isNewAccount ? 1 : 0,
      });
    } catch (error) {
      logger.error('[g-auth] callback:', error);
      return finish({ intent: flow.intent, error: 'server_error' });
    }
  }

  // Jeton court transportant « ce compte veut s'associer » à travers la
  // navigation de premier niveau vers le navigateur système.
  async linkToken(req, res) {
    try {
      const linkToken = gAuthService.issueLinkToken(req.user.id);
      return res.json({ success: true, data: { linkToken } });
    } catch (error) {
      logger.error('[g-auth] linkToken:', error);
      return res.status(500).json({ success: false, message: 'Impossible de préparer l’association.' });
    }
  }

  /**
   * Canal retour : g-auth signale que l'utilisateur a retiré l'accès de
   * l'application depuis son panel. Sans ça, la révocation coupait bien les
   * jetons mais laissait les deux comptes associés.
   */
  async backchannel(req, res) {
    try {
      const expected = process.env.G_AUTH_BACKCHANNEL_SECRET;
      if (!expected) {
        logger.error('[g-auth] G_AUTH_BACKCHANNEL_SECRET absent — appel refusé');
        return res.status(503).json({ success: false });
      }

      const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      // Comparaison à temps constant : une comparaison naïve laisse deviner le
      // secret octet par octet.
      const a = Buffer.from(presented);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ success: false });
      }

      const { event, sub } = req.body || {};
      if (event !== 'consent.revoked' || !sub) {
        return res.status(400).json({ success: false, message: 'Charge utile invalide' });
      }

      const result = await gAuthService.unlinkBySub(sub);
      return res.json({ success: true, status: result.status });
    } catch (error) {
      logger.error('[g-auth] backchannel:', error);
      return res.status(500).json({ success: false });
    }
  }
}

module.exports = new GAuthController();
