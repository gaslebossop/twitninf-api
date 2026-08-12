const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { sequelize } = require('../database/index');
const { User } = require('../models');
const config = require('../config/config');
const logger = require('../utils/logger');
const authService = require('./authService');
const NewEconomyService = require('./newEconomyService');
const { getPlatformCurrency } = require('../economy/platformCurrency');

/**
 * Connexion / association de compte via g-auth (fournisseur d'identité du
 * réseau G), pour l'app mobile. Le flux est piloté par ce serveur — pas de
 * PKCE ni de secret client côté app — exactement comme les apps `console` et
 * `demo` de g-auth lui-même s'authentifient auprès de lui.
 *
 * `code_verifier`/`state` transitent par Redis, pas par mémoire process : le
 * parc tourne sur plusieurs VPS (voir SCALING.md côté api), et rien ne
 * garantit que /start et /callback atterrissent sur le même process.
 */

const ISSUER = (process.env.G_AUTH_ISSUER || 'https://g.twitninf.duckdns.org').replace(/\/$/, '');
const CLIENT_ID = process.env.G_AUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.G_AUTH_CLIENT_SECRET;
const REDIRECT_URI = process.env.G_AUTH_REDIRECT_URI
  || 'https://twitninf.duckdns.org/api/auth/g-auth/callback';
const APP_SCHEME = process.env.TWITNINF_APP_SCHEME || 'twitninf';
const DEEP_LINK_HOST = 'g-auth-callback';

const LINK_BONUS_NF = 5;
const STATE_TTL_SECONDS = 10 * 60;
const LINK_TOKEN_TTL = '5m';
const LINK_TOKEN_PURPOSE = 'g_auth_link';

function assertConfigured() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('G_AUTH_CLIENT_ID / G_AUTH_CLIENT_SECRET manquants — voir api/CLAUDE.md');
  }
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── État OAuth (Redis, consommation unique) ────────────────────────────────

let redisClientPromise = null;
function getRedis() {
  if (!redisClientPromise) {
    const redis = require('redis');
    const client = redis.createClient({
      socket: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        reconnectStrategy: (retries) => Math.min(retries * 200, 2000),
      },
      password: process.env.REDIS_PASSWORD || undefined,
    });
    client.on('error', (error) => logger.error('[g-auth] Redis:', error.message));
    redisClientPromise = client.connect().then(() => client);
  }
  return redisClientPromise;
}

function stateKey(state) {
  return `gauth:oauth_state:${state}`;
}

async function saveState(state, payload) {
  const client = await getRedis();
  await client.set(stateKey(state), JSON.stringify(payload), { EX: STATE_TTL_SECONDS });
}

/** Lit puis supprime — un `state` ne doit jamais pouvoir être rejoué. */
async function consumeState(state) {
  const client = await getRedis();
  const key = stateKey(state);
  const raw = await client.get(key);
  if (!raw) return null;
  await client.del(key);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Lien URL de retour dans l'app ──────────────────────────────────────────
//
// Le schéma personnalisé `twitninf://` n'existe QUE dans un build natif : Expo
// Go possède déjà son propre schéma (`exp://…` / `exp+<slug>://…`) et ignore
// totalement celui déclaré dans app.config.js. L'app calcule donc sa propre
// URI de retour avec `Linking.createURL()` (juste avant d'appeler /start) et
// nous la transmet — on ne devine jamais un schéma fixe.
//
// Accepté seulement : `twitninf:` (build natif), `exp:` et `exp+<slug>:`
// (Expo Go / dev client), avec un chemin qui se termine par le segment
// attendu. Tout le reste est refusé — sans ça, `state` deviendrait un
// redirecteur ouvert capable de livrer un jeton de session à n'importe quelle
// URL fournie en paramètre.
const MOBILE_REDIRECT_SCHEME_RE = /^(twitninf|exp(\+[a-z0-9._-]+)?)$/i;

function isAllowedMobileRedirect(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 512) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (!MOBILE_REDIRECT_SCHEME_RE.test(scheme)) return false;
  return `${url.host}${url.pathname}`.includes(DEEP_LINK_HOST);
}

function buildDeepLink(baseRedirect, params) {
  const url = new URL(baseRedirect || `${APP_SCHEME}://${DEEP_LINK_HOST}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

// ─── Jeton d'intention de liaison ───────────────────────────────────────────
//
// Le navigateur système ouvert par /start est une navigation de premier
// niveau : il ne peut pas porter l'en-tête Authorization de l'app. Ce jeton,
// obtenu pendant que l'app est encore authentifiée, transporte l'intention
// « ce compte précis veut s'associer » à travers la redirection.

function issueLinkToken(userId) {
  return jwt.sign({ purpose: LINK_TOKEN_PURPOSE, userId }, config.jwt.secret, {
    expiresIn: LINK_TOKEN_TTL,
  });
}

function verifyLinkToken(token) {
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded?.purpose !== LINK_TOKEN_PURPOSE || !decoded.userId) return null;
    return decoded.userId;
  } catch {
    return null;
  }
}

// ─── Étape 1 : démarrer le flux ─────────────────────────────────────────────

async function startFlow({ intent, linkToken, mobileRedirect, forceAccountPicker }) {
  assertConfigured();

  if (!isAllowedMobileRedirect(mobileRedirect)) {
    const error = new Error('mobile_redirect manquant ou non autorisé');
    error.code = 'invalid_mobile_redirect';
    throw error;
  }

  let userId = null;
  if (intent === 'link') {
    userId = verifyLinkToken(linkToken);
    if (!userId) {
      const error = new Error('link_token invalide ou expiré');
      error.code = 'invalid_link_token';
      throw error;
    }
  }

  const state = base64url(crypto.randomBytes(24));
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

  await saveState(state, { intent, userId, codeVerifier, mobileRedirect });

  const authorizeUrl = new URL('/oauth/authorize', ISSUER);
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'openid profile email');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  // « Se connecter avec un autre compte G » : sans ça, g-auth reprend
  // silencieusement la session déjà active dans le navigateur système et
  // l'utilisateur n'a jamais l'occasion de saisir une autre identité.
  if (forceAccountPicker) authorizeUrl.searchParams.set('prompt', 'select_account');

  return authorizeUrl.toString();
}

// ─── Étape 2 : retour de g-auth ─────────────────────────────────────────────

async function exchangeCode(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const response = await fetch(new URL('/oauth/token', ISSUER), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`échange de code g-auth refusé (${response.status}): ${text.slice(0, 200)}`);
  }

  return response.json();
}

async function fetchUserinfo(accessToken) {
  const response = await fetch(new URL('/oauth/userinfo', ISSUER), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`userinfo g-auth refusé (${response.status})`);
  }
  return response.json();
}

// ─── Provisioning de compte (connexion) ─────────────────────────────────────

function slugifyUsernameBase(seed) {
  const localPart = String(seed || '').split('@')[0];
  const cleaned = localPart
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 20);
  return cleaned.length >= 3 ? cleaned : `user${cleaned}`;
}

async function generateUniqueUsername(seed, transaction) {
  const base = slugifyUsernameBase(seed);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = (attempt === 0 ? base : `${base}_${crypto.randomInt(1000, 9999)}`).slice(0, 30);
    // eslint-disable-next-line no-await-in-loop
    const exists = await User.findOne({
      where: { username: candidate },
      attributes: ['id'],
      transaction,
    });
    if (!exists) return candidate;
  }
  return `user_${Date.now().toString(36)}`.slice(0, 30);
}

async function findOrCreateAccount({ sub, email, name }, platform) {
  return sequelize.transaction(async (transaction) => {
    const existing = await User.findOne({ where: { g_auth_sub: sub }, transaction });
    if (existing) return { user: existing, isNewAccount: false };

    const username = await generateUniqueUsername(name || email, transaction);
    const user = await User.create(
      {
        username,
        full_name: (name && name.trim()) || username,
        // Mot de passe local aléatoire, jamais communiqué : ce compte
        // s'authentifie via G. `password` reste NOT NULL en base, donc pas de
        // cas particulier à ajouter au modèle pour ce chemin.
        password: crypto.randomBytes(32).toString('hex'),
        // NOT NULL sans défaut en base — authService.register() le sait déjà
        // et retombe sur 'android' quand le client ne le précise pas. Cette
        // requête vient d'un navigateur système, pas de l'app elle-même : pas
        // d'en-tête user-platform fiable, donc le même repli.
        platform: platform || 'android',
        email: email || undefined,
        g_auth_sub: sub,
        g_auth_linked_at: new Date(),
      },
      { transaction },
    );
    return { user, isNewAccount: true };
  });
}

async function loginOrRegister({ sub, email, name }, sessionContext = {}) {
  const { user, isNewAccount } = await findOrCreateAccount({ sub, email, name }, sessionContext.platform);

  try {
    await NewEconomyService.ensureWalletsForUser(user.id);
  } catch (error) {
    logger.warn(`[g-auth] Portefeuilles non assurés (${user.id}): ${error.message}`);
  }

  const token = authService.generateToken(user);
  const { token: refreshToken } = await authService.createSession(user.id, sessionContext);

  logger.info(`[g-auth] ${isNewAccount ? 'Compte créé' : 'Connexion'}: ${user.username}`);
  return { token, refreshToken, isNewAccount };
}

// ─── Association de compte (« associer mon compte à G ») ───────────────────

async function linkAccount(userId, { sub }) {
  return sequelize.transaction(async (transaction) => {
    const conflict = await User.findOne({ where: { g_auth_sub: sub }, transaction });
    if (conflict && conflict.id !== userId) {
      return { status: 'taken' };
    }

    // NO_KEY_UPDATE et pas le verrou par défaut : un appel au grand livre suit
    // dans cette même transaction, et FOR UPDATE se bloquerait sur son insert
    // de vérification de clé étrangère sur une autre connexion.
    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.NO_KEY_UPDATE });
    if (!user) return { status: 'error' };

    if (user.g_auth_sub === sub) {
      return { status: 'already_linked', bonus: 0 };
    }
    if (user.g_auth_sub) {
      return { status: 'account_already_linked_elsewhere' };
    }

    const bonusAlreadyClaimed = !!user.g_auth_bonus_claimed_at;
    user.g_auth_sub = sub;
    user.g_auth_linked_at = new Date();
    if (!bonusAlreadyClaimed) user.g_auth_bonus_claimed_at = new Date();

    try {
      await user.save({ transaction });
    } catch (error) {
      if (error?.name === 'SequelizeUniqueConstraintError') {
        // Couru par un autre lien vers le même sub entre notre lecture et
        // notre écriture — rare, géré proprement plutôt qu'en erreur 500.
        return { status: 'taken' };
      }
      throw error;
    }

    if (bonusAlreadyClaimed) {
      return { status: 'linked', bonus: 0 };
    }

    const currency = await getPlatformCurrency({ transaction });
    if (!currency) {
      throw new Error('monnaie NF indisponible — association annulée');
    }

    const reward = await NewEconomyService.rewardUser(
      userId,
      currency.id,
      LINK_BONUS_NF,
      'Bonus d’association de compte G',
      transaction,
    );
    if (!reward.success) {
      throw new Error(reward.reason || 'échec du crédit du bonus');
    }

    return { status: 'linked', bonus: LINK_BONUS_NF };
  });
}

/**
 * Retire le lien après que g-auth a signalé une révocation d'accès.
 *
 * Un compte CRÉÉ via G n'est jamais délié : son mot de passe local est
 * aléatoire et n'a jamais été communiqué, donc effacer `g_auth_sub` le rendrait
 * définitivement inaccessible. Retirer l'accès d'une application ne doit pas
 * pouvoir détruire un compte. Le discriminant est `g_auth_bonus_claimed_at`,
 * renseigné uniquement par l'association volontaire.
 */
async function unlinkBySub(sub) {
  const user = await User.findOne({ where: { g_auth_sub: sub } });
  if (!user) return { status: 'not_linked' };

  if (!user.g_auth_bonus_claimed_at) {
    logger.warn(
      `[g-auth] Révocation reçue pour ${user.username}, compte créé via G — lien conservé`,
    );
    return { status: 'kept_account_created_via_g', userId: user.id };
  }

  await user.update({ g_auth_sub: null, g_auth_linked_at: null });
  logger.info(`[g-auth] Lien retiré après révocation: ${user.username}`);
  return { status: 'unlinked', userId: user.id };
}

module.exports = {
  ISSUER,
  APP_SCHEME,
  unlinkBySub,
  DEEP_LINK_HOST,
  LINK_BONUS_NF,
  assertConfigured,
  startFlow,
  consumeState,
  buildDeepLink,
  exchangeCode,
  fetchUserinfo,
  loginOrRegister,
  linkAccount,
  issueLinkToken,
};
