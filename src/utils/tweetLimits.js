const { User } = require('../models');
const { isSubscriptionActive } = require('./subscriptionHelpers');
const logger = require('./logger');

/**
 * Longueur maximale d'un tweet, par profil de compte.
 *
 * Trois régimes, du plus large au plus étroit :
 *  - compte certifié : aucune limite (comportement historique, inchangé) ;
 *  - abonné actif (Plus ou Pro) : 1 000 caractères — l'avantage payant ;
 *  - tout le reste : 600, le garde-fou serveur qui existait déjà.
 *
 * ⚠ Les 600 ne sont PAS la limite affichée aux comptes gratuits : l'app leur
 * impose 280 (voir `TWEET_MAX_CHARS` côté mobile). Le serveur est plus permissif
 * à dessein — son rôle ici est d'empêcher l'abus, pas de répliquer l'interface,
 * et resserrer ce plafond casserait les clients qui s'appuient dessus
 * aujourd'hui (dont l'app Windows).
 */
const TWEET_MAX_CHARS_SUBSCRIBER = 1000;
const TWEET_MAX_CHARS_DEFAULT = 600;

/**
 * Limite applicable à un utilisateur, résolue EN BASE.
 *
 * Le jeton d'authentification porte bien `subscription_tier`, mais pas
 * `subscription_expires_at` : s'y fier laisserait un abonné expiré publier des
 * tweets longs jusqu'au renouvellement de son jeton. On relit donc la date
 * d'expiration — un `findByPk` sur clé primaire, négligeable devant les
 * écritures que fait déjà la création d'un tweet.
 *
 * @returns {Promise<number>} `Infinity` pour un compte certifié.
 */
async function resolveTweetCharLimit(tokenUser) {
  if (!tokenUser) return TWEET_MAX_CHARS_DEFAULT;
  if (tokenUser.verified) return Infinity;

  try {
    const user = await User.findByPk(tokenUser.id, {
      attributes: ['id', 'subscription_tier', 'subscription_expires_at']
    });
    return isSubscriptionActive(user) ? TWEET_MAX_CHARS_SUBSCRIBER : TWEET_MAX_CHARS_DEFAULT;
  } catch (error) {
    // Un palier illisible ne doit pas offrir l'avantage payant : on retombe
    // sur la limite de base, jamais sur celle de l'abonnement.
    logger.warn(`Palier illisible pour ${tokenUser.id}, limite de tweet par défaut: ${error.message}`);
    return TWEET_MAX_CHARS_DEFAULT;
  }
}

/**
 * Validateur `express-validator` partagé entre la création et l'édition d'un
 * tweet : les deux routes portaient la même règle recopiée à l'identique.
 */
async function assertTweetLength(value, { req }) {
  const limit = await resolveTweetCharLimit(req.user);
  if (value.length > limit) {
    throw new Error(`Le contenu doit contenir entre 1 et ${limit} caractères`);
  }
  return true;
}

module.exports = {
  TWEET_MAX_CHARS_SUBSCRIBER,
  TWEET_MAX_CHARS_DEFAULT,
  resolveTweetCharLimit,
  assertTweetLength
};
