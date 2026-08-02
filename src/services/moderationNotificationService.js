/**
 * Notification de la personne SANCTIONNÉE.
 *
 * Rien n'était envoyé : ni suppression de publication, ni suspension, ni
 * bannissement. `deleteTweet` acceptait pourtant un paramètre `notify_user`,
 * le rangeait dans les métadonnées et répondait `notified_user: true` — sans
 * qu'aucune notification n'existe. L'API affirmait avoir prévenu.
 *
 * Deux règles tenues ici :
 *  - **On ne divulgue jamais qui a signalé.** Symétrique de ce qui est fait
 *    pour le signaleur, à qui on ne dit pas quelle sanction a été prise.
 *  - **On ne nomme pas le modérateur** (`sender_id` reste nul) : une décision
 *    de modération engage la plateforme, pas une personne qu'on pourrait
 *    ensuite prendre à partie.
 *
 * Le contenu retiré est recopié dans la notification : la publication
 * disparaît du fil, sans extrait l'utilisateur ne sait pas laquelle est visée.
 */

const { Notification } = require('../models');
const logger = require('../utils/logger');

/** Coupe proprement un extrait de contenu pour l'afficher dans la notification. */
function preview(text, max = 140) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function formatUntil(date) {
  if (!date) return null;
  try {
    return new Date(date).toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return null;
  }
}

/**
 * Toute création de notification est enveloppée : une sanction ne doit
 * JAMAIS échouer parce que la notification n'a pas pu partir.
 */
async function safeCreate(payload, label) {
  try {
    await Notification.create(payload);
    return true;
  } catch (e) {
    logger.warn(`[modNotif] ${label} non envoyée: ${e.message}`);
    return false;
  }
}

/** Publication retirée par la modération. */
async function notifyContentRemoved(userId, { tweetId, content, reason } = {}) {
  if (!userId) return false;
  const extract = preview(content);

  return safeCreate({
    recipient_id: userId,
    sender_id: null,
    // `tweets` est en `paranoid: true` : la ligne survit à la suppression,
    // la clé étrangère tient donc encore.
    tweet_id: tweetId || null,
    type: 'system',
    title: 'Votre publication a été retirée',
    message: reason
      ? `Elle ne respectait pas nos règles : ${reason}`
      : 'Elle ne respectait pas nos règles de publication.',
    content: {
      kind: 'content_removed',
      tweet_id: tweetId || null,
      // Sans cet extrait, l'utilisateur ne peut pas savoir de quelle
      // publication on parle — elle n'est plus visible nulle part.
      excerpt: extract || null,
      reason: reason || null,
      appealable: true,
    },
    priority: 'high',
    metadata: { source: 'moderation', action: 'delete' },
  }, 'suppression de contenu');
}

/** Compte suspendu temporairement. */
async function notifyAccountSuspended(userId, { reason, until, durationHours } = {}) {
  if (!userId) return false;
  const untilLabel = formatUntil(until);

  return safeCreate({
    recipient_id: userId,
    sender_id: null,
    type: 'system',
    title: 'Votre compte est suspendu',
    message: [
      reason ? `Motif : ${reason}` : 'Votre compte a été suspendu.',
      untilLabel ? `Levée prévue le ${untilLabel}.` : null,
    ].filter(Boolean).join(' '),
    content: {
      kind: 'account_suspended',
      reason: reason || null,
      until: until || null,
      duration_hours: durationHours || null,
      appealable: true,
    },
    priority: 'urgent',
    metadata: { source: 'moderation', action: 'suspend' },
  }, 'suspension');
}

/** Compte banni. */
async function notifyAccountBanned(userId, { reason, permanent = true, until } = {}) {
  if (!userId) return false;
  const untilLabel = formatUntil(until);

  return safeCreate({
    recipient_id: userId,
    sender_id: null,
    type: 'system',
    title: permanent ? 'Votre compte a été banni' : 'Votre compte est banni temporairement',
    message: [
      reason ? `Motif : ${reason}` : 'Votre compte a été banni.',
      !permanent && untilLabel ? `Jusqu'au ${untilLabel}.` : null,
      'Vous pouvez demander un réexamen depuis l\'application.',
    ].filter(Boolean).join(' '),
    content: {
      kind: 'account_banned',
      reason: reason || null,
      permanent: !!permanent,
      until: until || null,
      // La table `unban_tickets` existe : le recours est un vrai parcours,
      // pas une formule de politesse.
      appealable: true,
    },
    priority: 'urgent',
    metadata: { source: 'moderation', action: 'ban' },
  }, 'bannissement');
}

/** Avertissement sans sanction immédiate. */
async function notifyWarning(userId, { reason, tweetId } = {}) {
  if (!userId) return false;

  return safeCreate({
    recipient_id: userId,
    sender_id: null,
    tweet_id: tweetId || null,
    type: 'system',
    title: 'Avertissement',
    message: reason
      ? `Un contenu publié depuis votre compte pose problème : ${reason}`
      : 'Un contenu publié depuis votre compte ne respecte pas nos règles.',
    content: { kind: 'warning', reason: reason || null, tweet_id: tweetId || null, appealable: false },
    priority: 'high',
    metadata: { source: 'moderation', action: 'warn' },
  }, 'avertissement');
}

/** Levée de sanction — la bonne nouvelle mérite le même traitement. */
async function notifySanctionLifted(userId, { kind = 'suspension' } = {}) {
  if (!userId) return false;

  return safeCreate({
    recipient_id: userId,
    sender_id: null,
    type: 'system',
    title: kind === 'ban' ? 'Votre compte a été rétabli' : 'Votre suspension est levée',
    message: 'Vous pouvez de nouveau publier et interagir normalement.',
    content: { kind: 'sanction_lifted', sanction: kind },
    priority: 'normal',
    metadata: { source: 'moderation', action: 'lift' },
  }, 'levée de sanction');
}

module.exports = {
  notifyContentRemoved,
  notifyAccountSuspended,
  notifyAccountBanned,
  notifyWarning,
  notifySanctionLifted,
};
