/**
 * Prévenir ses abonnés d'une publication — avantage Ultra.
 *
 * L'auteur choisit, au moment d'écrire, si ses abonnés sont notifiés et avec
 * quel message. C'est le seul avantage Ultra qui se voit à l'usage plutôt que
 * de se deviner : les autres sont des comportements serveur (recherche
 * prioritaire, antifraude assoupli, immunité) que l'abonné ne peut pas
 * constater.
 *
 * ── Pourquoi ce service existe au lieu d'une boucle ──────────────────────
 *
 * `Notification.createNotification` fait un `await axios.post` vers Expo **par
 * destinataire**, dans le fil de l'appelant. Un commentaire d'audit du
 * 2026-08-19 le signale déjà pour la diffusion en série : un `exp.host` lent
 * occupe un contexte d'exécution sans borne. Appliqué à un fan-out sur des
 * milliers d'abonnés, ce n'est pas lent, c'est une panne — la requête de
 * publication n'aurait jamais rendu la main.
 *
 * Ici, donc : `bulkCreate` pour la base (une écriture), puis les DEUX
 * transports appelés hors du chemin de la réponse.
 *
 * ── Les deux transports, et celui qui compte vraiment ────────────────────
 *
 * Contourner `createNotification` fait perdre TOUT ce qu'elle faisait —
 * y compris le Web Push. Première version de ce service : seul Expo était
 * réimplémenté, donc la diffusion écrivait bien ses lignes en base et ne
 * réveillait personne.
 *
 * Or Expo est le transport MORT sur ce produit : 1 jeton pour 3 562 comptes
 * (mesuré le 2026-08-31). Les notifications passent par **Web Push**, servi
 * depuis notre propre serveur — c'est la seule voie gratuite vers un iPhone
 * et la seule qui marche sans installer l'app. Garder Expo et oublier Web
 * Push, c'est garder la branche vide et perdre la seule qui sert.
 *
 * Les deux sont donc envoyés, Web Push en premier dans le code parce que
 * c'est lui qui atteint les gens.
 *
 * ── Ce qui borne l'abus ──────────────────────────────────────────────────
 *
 * Notifier tous ses abonnés est un mégaphone. Sans limite, un compte Ultra
 * qui publie quinze fois par jour vide ses propres abonnés — ils coupent les
 * notifications, et l'avantage se détruit lui-même en même temps qu'il pourrit
 * l'app. Trois bornes :
 *
 *  1. `MAX_RECIPIENTS` — plafond dur par envoi.
 *  2. Réponses et tweets privés exclus en amont (voir l'appelant) : une
 *     réponse n'est pas une publication qu'on annonce.
 *  3. L'auteur decide, publication par publication : le mode « sans notif »
 *     est a un tap dans la compose.
 *
 * Il y avait une quatrieme borne — une seule diffusion par tranche de 6 h.
 * **Retiree le 2026-08-31, apres l'avoir vue casser le produit.** Depuis que
 * notifier est le comportement par DEFAUT, cette fenetre ne bridait plus un
 * abus, elle annulait le cas normal : un auteur publiait, l'interface disait
 * « NOTIF », et rien ne partait. Constate en base — deux posts a 18 minutes
 * d'intervalle, un seul lot de notifications.
 *
 * Une limite silencieuse qui contredit le reglage affiche est pire que pas de
 * limite : elle rend le produit imprevisible et impossible a deboguer de
 * l'exterieur. Si un plafond redevient necessaire, il devra se VOIR dans la
 * compose (le chip dirait « deja notifie »), pas se decider en silence.
 */

const { Op } = require('sequelize');
const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Plafond d'abonnés notifiés en une fois.
 *
 * Ce n'est pas une limite de produit mais de sûreté : au-delà, l'écriture et
 * le fan-out push doivent passer par une file, pas par la requête HTTP de
 * publication. Aucun compte n'en est proche aujourd'hui ; si un l'atteint, ce
 * plafond est le signal qu'il faut la file, pas qu'il faut monter le nombre.
 */
const MAX_RECIPIENTS = 5000;

/** Limite documentée d'un appel groupé Expo. */
const PUSH_CHUNK = 100;

/** Envois Web Push menés de front. Un chiffrement par appareil, donc borné. */
const WEB_PUSH_WAVE = 50;

/**
 * Longueur max du message personnalisé. Aligné sur la validation de la route.
 *
 * 280 : la longueur d'un tweet libre. Le message de diffusion est la seule
 * phrase que l'auteur écrit POUR la notification plutôt que pour le fil, et la
 * couper à 140 l'obligeait à résumer un résumé.
 */
const MESSAGE_MAX = 280;

/**
 * `type` réutilise `system` et se distingue par `metadata.kind`.
 *
 * `Notification.type` est un ENUM Postgres : y ajouter une valeur demande une
 * migration, et `migrate.js` n'est jamais joué au démarrage sur ce dépôt —
 * l'ENUM réel en production ne bougerait pas et toute insertion échouerait.
 * C'est déjà la solution retenue pour les demandes de suivi
 * (`createFollowRequestNotification`, qui réutilise `follow`), avec le même
 * commentaire. On suit la même voie.
 */
const KIND = 'author_post';

/**
 * Message par défaut si l'auteur n'en écrit pas.
 *
 * C'est le cas COURANT, pas le repli : notifier est le comportement par
 * défaut, et écrire son propre texte est l'écart. Il doit donc se suffire à
 * lui-même, lu seul sur un écran verrouillé.
 */
function defaultMessage(username) {
  return `@${username} a publié`;
}

/**
 * Nettoie le message de l'auteur.
 *
 * Il part en notification push, donc hors de tout rendu HTML : le risque n'est
 * pas l'injection mais le bruit — retours à la ligne qui cassent l'aperçu
 * système, espaces multiples, longueur.
 */
function sanitizeMessage(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MESSAGE_MAX);
}

/** Envoi Expo par lots, hors du chemin de la réponse HTTP. */
async function pushInChunks(tokens, title, body, data) {
  for (let i = 0; i < tokens.length; i += PUSH_CHUNK) {
    const chunk = tokens.slice(i, i + PUSH_CHUNK);
    const messages = chunk.map((to) => ({ to, sound: 'default', title, body, data }));
    try {
      await axios.post('https://exp.host/--/api/v2/push/send', messages, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
      });
    } catch (error) {
      // Un lot perdu ne doit pas emporter les suivants : les destinataires
      // d'un lot n'ont rien à voir avec ceux d'un autre.
      logger.warn(`[broadcast] lot push ${i / PUSH_CHUNK} échoué: ${error?.message}`);
    }
  }
}

/**
 * Web Push vers chaque destinataire, par vagues.
 *
 * `sendToUser` chiffre un message par appareil enregistré : lancer les 5 000
 * d'un coup ouvrirait autant de requêtes sortantes en parallèle. Les vagues
 * bornent ça sans file d'attente.
 */
async function fanOutWebPush(recipientIds, title, body, tweetId) {
  let webPushService;
  try {
    webPushService = require('./webPushService');
  } catch (error) {
    logger.warn(`[broadcast] webPush indisponible: ${error.message}`);
    return;
  }
  if (!webPushService.isConfigured()) return;

  const url = tweetId ? `/tweet/${tweetId}` : '/notifications';
  for (let i = 0; i < recipientIds.length; i += WEB_PUSH_WAVE) {
    const wave = recipientIds.slice(i, i + WEB_PUSH_WAVE);
    await Promise.allSettled(
      wave.map((id) =>
        webPushService.sendToUser(id, { title, body, url, tag: `author-post-${tweetId}` }),
      ),
    );
  }
}

/**
 * Notifie les abonnés d'un auteur qu'il vient de publier.
 *
 * Ne jette jamais : une notification ratée ne doit pas faire échouer une
 * publication déjà écrite en base. Renvoie de quoi journaliser et tester.
 */
async function broadcastNewTweet({ models, authorId, tweetId, message }) {
  const { User, UserFollow, Notification } = models;

  const author = await User.findByPk(authorId, {
    attributes: ['id', 'username', 'subscription_tier', 'subscription_expires_at'],
  });
  if (!author) return { sent: 0, reason: 'author_not_found' };

  // Le palier est revérifié ICI, jamais pris du client. Un abonnement échu
  // ferme l'avantage comme n'importe quel autre.
  const active =
    !author.subscription_expires_at || new Date(author.subscription_expires_at) > new Date();
  if (author.subscription_tier !== 'ultra' || !active) {
    return { sent: 0, reason: 'not_ultra' };
  }

  const followers = await UserFollow.findAll({
    where: { following_id: authorId, status: 'active' },
    attributes: ['follower_id'],
    limit: MAX_RECIPIENTS,
  });
  const recipientIds = followers.map((f) => f.follower_id).filter((id) => id && id !== authorId);
  if (!recipientIds.length) return { sent: 0, reason: 'no_followers' };

  const body = sanitizeMessage(message) || defaultMessage(author.username);
  const title = `@${author.username} a publié`;

  // Une seule écriture. `createNotification` ferait ici une requête HTTP par
  // destinataire — voir l'en-tête de ce fichier.
  const rows = recipientIds.map((recipientId) => ({
    recipient_id: recipientId,
    sender_id: authorId,
    tweet_id: tweetId,
    type: 'system',
    title,
    message: body,
    metadata: { kind: KIND },
  }));
  await Notification.bulkCreate(rows);

  // Le push part APRÈS, détaché : la publication n'attend pas Expo.
  const recipients = await User.findAll({
    where: { id: { [Op.in]: recipientIds }, id_notif: { [Op.ne]: null } },
    attributes: ['id_notif'],
  });
  const tokens = recipients.map((r) => r.id_notif).filter(Boolean);
  if (tokens.length) {
    void pushInChunks(tokens, title, body, {
      type: 'system',
      kind: KIND,
      tweet_id: tweetId,
      sender_id: authorId,
    });
  }

  // Web Push — le transport qui atteint réellement les gens. Un envoi chiffré
  // par appareil enregistré, donc jamais attendu : `sendToUser` traite déjà
  // ses propres erreurs et retire les abonnements périmés.
  void fanOutWebPush(recipientIds, title, body, tweetId);

  logger.info(`[broadcast] ${recipientIds.length} abonnés notifiés pour le tweet ${tweetId}`);
  return { sent: recipientIds.length, reason: null };
}

module.exports = {
  broadcastNewTweet,
  sanitizeMessage,
  defaultMessage,
  MAX_RECIPIENTS,
  MESSAGE_MAX,
  KIND,
};
