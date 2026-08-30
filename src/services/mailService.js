const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

/**
 * Envoi d'e-mails transactionnels (codes de vérification, sécurité du compte).
 *
 * ── Pourquoi ce fichier n'existait pas avant ────────────────────────────
 * `nodemailer` était bien dans les dépendances, mais aucun envoi n'a jamais
 * été branché : « mot de passe oublié » répondait 200 sans rien envoyer. La
 * règle posée ici est l'inverse — sans configuration SMTP, `send()` échoue
 * franchement, et l'appelant décide quoi en dire. Un envoi silencieusement
 * perdu est pire qu'une erreur : personne ne le découvre.
 *
 * Réglages OVH (les valeurs vivent dans le `.env`, jamais ici) :
 *   SMTP_HOST=ssl0.ovh.net  SMTP_PORT=465  SMTP_SECURE=true
 */
let transporter = null;

function config() {
  return {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 465,
    secure: String(process.env.SMTP_SECURE ?? 'true') !== 'false',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.host && c.user && c.password);
}

function getTransporter() {
  if (transporter) return transporter;
  const c = config();
  if (!isConfigured()) return null;

  transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.password },
    // OVH ferme les connexions inactives : garder un pool ouvert produit des
    // « Connection closed » aléatoires sur un service qui envoie peu.
    pool: false,
  });
  return transporter;
}

async function send({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) {
    const error = new Error('SMTP non configuré sur ce serveur.');
    error.code = 'smtp_not_configured';
    throw error;
  }

  const info = await t.sendMail({ from: config().from, to, subject, text, html });
  logger.info(`[mail] « ${subject} » envoyé à ${String(to).replace(/(.{2}).*(@.*)/, '$1***$2')}`);
  return info;
}

/** Contrôle de la connexion SMTP, sans envoyer de message. */
async function verify() {
  const t = getTransporter();
  if (!t) return { ok: false, reason: 'SMTP non configuré' };
  try {
    await t.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

module.exports = { isConfigured, send, verify };
