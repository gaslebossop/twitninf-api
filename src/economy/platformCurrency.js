/**
 * Résout la cryptomonnaie unique de la plateforme sans dépendre d'un symbole
 * codé en dur ('TWC') qui a divergé du symbole réellement en base ('NF').
 * Toute la stack monétisation/admin-économie doit passer par ici.
 */
const { VirtualCurrency } = require('../models');

let cached = null;
let cachedAt = 0;
const TTL_MS = 60_000;

async function getPlatformCurrency({ transaction, fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < TTL_MS) return cached;

  const currency = (await VirtualCurrency.findOne({ where: { isActive: true }, order: [['createdAt', 'ASC']], transaction }))
    || (await VirtualCurrency.findOne({ order: [['createdAt', 'ASC']], transaction }));

  cached = currency;
  cachedAt = Date.now();
  return currency;
}

module.exports = { getPlatformCurrency };
