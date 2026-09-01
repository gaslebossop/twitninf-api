const { User } = require('../models');
const { isUltraActive } = require('./subscriptionHelpers');
const logger = require('./logger');

/**
 * « Celui qui parle est-il un Ultra encore abonné ? », relu EN BASE.
 *
 * Le jeton d'authentification porte `subscription_tier` mais PAS
 * `subscription_expires_at` : s'y fier laisserait un Ultra expiré garder ses
 * plafonds relevés jusqu'au renouvellement de son jeton. Même raisonnement, et
 * même coût, que `resolveTweetCharLimit` — un `findByPk` sur clé primaire,
 * négligeable devant le reste de la requête.
 *
 * Un seul endroit pour ce test parce qu'il commande maintenant une dizaine de
 * plafonds : la règle « on relit la date, on ne croit pas le jeton » doit
 * valoir partout, pas seulement là où quelqu'un y a pensé.
 *
 * @param {{id: string, subscription_tier?: string}|null} tokenUser `req.user`
 * @returns {Promise<boolean>} false si la lecture échoue — un palier illisible
 *   ne doit JAMAIS offrir l'avantage payant.
 */
async function isUltraRequest(tokenUser, dbTransaction = null) {
  if (!tokenUser?.id) return false;
  try {
    const user = await User.findByPk(tokenUser.id, {
      attributes: ['id', 'subscription_tier', 'subscription_expires_at'],
      transaction: dbTransaction,
    });
    return isUltraActive(user);
  } catch (error) {
    logger.warn(`[ultraGate] Palier illisible pour ${tokenUser.id}, avantage Ultra refusé: ${error.message}`);
    return false;
  }
}

/**
 * Sucre pour le motif qui revient partout : « la valeur Ultra si Ultra, sinon
 * la valeur commune ». Évite d'écrire dix fois le ternaire à côté d'un `await`.
 */
async function ultraLimit(tokenUser, ultraValue, defaultValue, dbTransaction = null) {
  return (await isUltraRequest(tokenUser, dbTransaction)) ? ultraValue : defaultValue;
}

module.exports = { isUltraRequest, ultraLimit };
