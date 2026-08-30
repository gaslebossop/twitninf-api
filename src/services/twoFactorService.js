const crypto = require('crypto');
const redis = require('redis');
const otplib = require('otplib');
const logger = require('../utils/logger');
const mailService = require('./mailService');

/**
 * Double authentification : code par e-mail, application TOTP, codes de secours.
 *
 * ── Où vivent les états éphémères ───────────────────────────────────────
 * Les défis de connexion et les codes e-mail sont dans REDIS, pas en base :
 * ils vivent quelques minutes, et l'API tourne sur deux machines — un état
 * gardé en mémoire ferait échouer une connexion sur deux, selon le nœud qui
 * reçoit la seconde requête. C'est exactement le symptôme qu'a produit le
 * secret g-auth désynchronisé.
 *
 * ── Ce qui est stocké en clair, et ce qui ne l'est pas ──────────────────
 * Un code e-mail n'est JAMAIS stocké en clair : seul son condensé l'est, avec
 * un compteur de tentatives. Le secret TOTP, lui, doit rester lisible par le
 * serveur (c'est la nature de l'algorithme) — il n'est donc jamais exposé par
 * une route après la confirmation.
 */

const CHALLENGE_TTL = 10 * 60;     // 10 min pour finir une connexion
const EMAIL_CODE_TTL = 10 * 60;
const MAX_ATTEMPTS = 5;

/**
 * otplib **13** — API fonctionnelle, rien à voir avec la v12.
 *
 * La v12 exposait un singleton `authenticator` que l'on configurait par
 * `authenticator.options = …`. En v13 ce symbole n'existe plus : le faire
 * planter le chargement du module, donc l'API entière (constaté en
 * production). Les options se passent maintenant à chaque appel.
 *
 * `epochTolerance: 1` = une fenêtre de 30 s de part et d'autre. Les horloges
 * de téléphone dérivent, et refuser un code pour 20 secondes d'écart est le
 * motif n°1 de « l'application d'authentification ne marche pas ».
 */
const TOTP_OPTIONS = { strategy: 'totp', period: 30, digits: 6, epochTolerance: 1 };

let client = null;
let connecting = null;

async function getRedis() {
  if (client?.isOpen) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const next = redis.createClient({
      socket: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      },
      password: process.env.REDIS_PASSWORD || undefined,
    });
    next.on('error', (error) => logger.warn(`[2fa] Redis: ${error.message}`));
    await next.connect();
    client = next;
    connecting = null;
    return client;
  })();

  return connecting;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Code numérique à 6 chiffres, tiré d'une source cryptographique. */
function generateEmailCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// ─── Défi de connexion ──────────────────────────────────────────────────────

async function createChallenge(user) {
  const id = crypto.randomBytes(24).toString('base64url');
  const payload = {
    userId: String(user.id),
    methods: availableMethods(user),
    attempts: 0,
  };
  const r = await getRedis();
  await r.set(`2fa:challenge:${id}`, JSON.stringify(payload), { EX: CHALLENGE_TTL });
  return { id, methods: payload.methods };
}

async function readChallenge(id) {
  if (!id || typeof id !== 'string') return null;
  const r = await getRedis();
  const raw = await r.get(`2fa:challenge:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function dropChallenge(id) {
  const r = await getRedis();
  await r.del(`2fa:challenge:${id}`, `2fa:email:${id}`);
}

async function bumpAttempts(id, challenge) {
  const r = await getRedis();
  const next = { ...challenge, attempts: (challenge.attempts || 0) + 1 };
  if (next.attempts >= MAX_ATTEMPTS) {
    await dropChallenge(id);
    return null;
  }
  const ttl = await r.ttl(`2fa:challenge:${id}`);
  await r.set(`2fa:challenge:${id}`, JSON.stringify(next), { EX: ttl > 0 ? ttl : CHALLENGE_TTL });
  return next;
}

// ─── Code par e-mail ────────────────────────────────────────────────────────

/**
 * Envoie un code et mémorise son condensé sous la clé donnée.
 * `scope` sert aussi bien à une connexion (`challengeId`) qu'à l'activation
 * du réglage (`setup:<userId>`) : même mécanique, deux usages.
 */
async function sendEmailCode(scope, email, purpose = 'connexion') {
  const code = generateEmailCode();
  const r = await getRedis();
  await r.set(`2fa:email:${scope}`, hash(code), { EX: EMAIL_CODE_TTL });

  await mailService.send({
    to: email,
    subject: `TwitNinf — code de vérification ${code}`,
    text: `Ton code de ${purpose} est : ${code}\n\nIl expire dans 10 minutes.\n`
      + "Si tu n'es pas à l'origine de cette demande, ignore ce message et change ton mot de passe.",
    html: `<p>Ton code de ${purpose} est&nbsp;:</p>`
      + `<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0">${code}</p>`
      + '<p>Il expire dans 10 minutes.</p>'
      + "<p style=\"color:#666\">Si tu n'es pas à l'origine de cette demande, ignore ce message et change ton mot de passe.</p>",
  });

  return true;
}

async function verifyEmailCode(scope, code) {
  const r = await getRedis();
  const expected = await r.get(`2fa:email:${scope}`);
  if (!expected) return false;
  const provided = hash(String(code || '').trim());
  // Comparaison à temps constant : une comparaison naïve fuit la position du
  // premier caractère faux, ce qui suffit à deviner un code à 6 chiffres.
  const ok = expected.length === provided.length
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  if (ok) await r.del(`2fa:email:${scope}`);
  return ok;
}

// ─── TOTP ───────────────────────────────────────────────────────────────────

function generateTotpSecret() {
  return otplib.generateSecret();
}

function totpUri(username, secret) {
  return otplib.generateURI({ ...TOTP_OPTIONS, issuer: 'TwitNinf', label: username, secret });
}

function verifyTotp(secret, token) {
  if (!secret || !token) return false;
  try {
    // `verifySync` rend un OBJET (`{ valid, delta }`), pas un booléen : le
    // tester directement rendrait toujours vrai, y compris sur un code faux.
    const result = otplib.verifySync({
      ...TOTP_OPTIONS,
      secret,
      token: String(token).replace(/\s/g, ''),
    });
    return Boolean(result && result.valid);
  } catch {
    return false;
  }
}

// ─── Codes de secours ───────────────────────────────────────────────────────

/**
 * Sans eux, perdre son téléphone = perdre son compte. Ils sont rendus UNE
 * fois, à l'activation, et seuls leurs condensés sont conservés.
 */
function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

function availableMethods(user) {
  const methods = [];
  if (user.two_factor_email_enabled) methods.push('email');
  if (user.two_factor_totp_enabled) methods.push('totp');
  return methods;
}

function isEnabled(user) {
  return Boolean(user?.two_factor_email_enabled || user?.two_factor_totp_enabled);
}

module.exports = {
  createChallenge,
  readChallenge,
  dropChallenge,
  bumpAttempts,
  sendEmailCode,
  verifyEmailCode,
  generateTotpSecret,
  totpUri,
  verifyTotp,
  generateRecoveryCodes,
  availableMethods,
  isEnabled,
  hash,
  MAX_ATTEMPTS,
};
