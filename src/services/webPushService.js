const webpush = require('web-push');
const logger = require('../utils/logger');

/**
 * Envoi de notifications Web Push depuis NOTRE serveur.
 *
 * ── Pourquoi ça existe ──────────────────────────────────────────────────
 * L'app mobile pousse via Expo/APNs, ce qui suppose un compte développeur
 * Apple payant. Le Web Push, lui, est un standard du navigateur : le serveur
 * signe ses envois avec une paire de clés VAPID qu'il génère lui-même, et
 * aucune plateforme n'a à donner son accord. C'est le seul chemin gratuit
 * pour notifier un utilisateur iOS — à condition qu'il ait ajouté le site à
 * son écran d'accueil (Safari ne pousse rien depuis un simple onglet).
 *
 * ── Ce que le serveur ne peut pas faire ─────────────────────────────────
 * La charge utile est chiffrée avec les clés du navigateur (`p256dh`/`auth`) :
 * ni nous ni le service de poussée ne pouvons relire une notification déjà
 * envoyée. Il n'y a donc pas d'historique récupérable ici.
 */

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
// `mailto:` est exigé par la spécification VAPID : c'est le contact que le
// service de poussée utilise s'il doit signaler un abus.
const CONTACT = process.env.VAPID_SUBJECT || 'mailto:contact@twitninf.fr';

const configured = Boolean(PUBLIC_KEY && PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(CONTACT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  logger.warn('[webpush] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY absents : Web Push désactivé.');
}

function isConfigured() {
  return configured;
}

function publicKey() {
  return PUBLIC_KEY;
}

/**
 * Envoie une notification à TOUS les navigateurs enregistrés d'un compte.
 *
 * Les abonnements morts sont supprimés au fil de l'eau : un `404`/`410` du
 * service de poussée signifie « ce navigateur ne reviendra pas » (site
 * désinstallé, permission retirée). Les garder ferait grossir la table et
 * ralentirait chaque envoi suivant pour rien.
 */
async function sendToUser(userId, payload) {
  if (!configured) return { sent: 0, removed: 0 };

  // Requis ici et non en tête de fichier : `models/index.js` charge des
  // services, un `require` croisé au chargement rendrait un objet vide.
  const { WebPushSubscription } = require('../models');

  const subscriptions = await WebPushSubscription.findAll({ where: { user_id: userId } });
  if (subscriptions.length === 0) return { sent: 0, removed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;

  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 60 * 60 * 24 },
      );
      sent += 1;
      await sub.update({ failure_count: 0, last_success_at: new Date() });
    } catch (error) {
      const status = error?.statusCode;
      if (status === 404 || status === 410) {
        await sub.destroy();
        removed += 1;
        return;
      }
      const failures = (sub.failure_count || 0) + 1;
      if (failures >= 5) {
        await sub.destroy();
        removed += 1;
      } else {
        await sub.update({ failure_count: failures });
      }
      logger.warn(`[webpush] Échec vers ${String(sub.endpoint).slice(0, 60)}… (${status || error.message})`);
    }
  }));

  return { sent, removed };
}

module.exports = { isConfigured, publicKey, sendToUser };
