'use strict';

/**
 * Portefeuille EUR interne : une VirtualCurrency à part entière (symbole
 * 'EUR'), séparée de la monnaie de la plateforme (NF/getPlatformCurrency).
 * Contrairement au NF, son prix ne bouge jamais : 1 EUR interne = 1 EUR,
 * toujours — c'est un simple portefeuille de valeur stable, alimenté
 * uniquement par échange depuis le NF (voir EconomyLedger.exchangeCurrency),
 * jamais par le minage ni un achat direct.
 *
 * IMPORTANT : ne JAMAIS appeler EconomyMetrics.refresh() sur cette monnaie —
 * cette fonction écrase currentPrice par REFERENCE_PRICE_EUR * multiplier
 * pour N'IMPORTE QUELLE monnaie qu'on lui passe (elle a été écrite en
 * supposant une plateforme mono-monnaie), ce qui casserait le prix fixe à 1.
 */

const { VirtualCurrency } = require('../models');

let cached = null;
let cachedAt = 0;
const TTL_MS = 60_000;

async function getOrCreateEurCurrency({ transaction, fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cachedAt < TTL_MS) return cached;

  let currency = await VirtualCurrency.findOne({ where: { symbol: 'EUR' }, transaction });
  if (!currency) {
    try {
      currency = await VirtualCurrency.create({
        name: 'Euro (interne)',
        symbol: 'EUR',
        currentPrice: 1,
        basePrice: 1,
        currentMultiplier: 1,
        isActive: true,
        color: '#2BC48A',
        description: 'Portefeuille EUR interne — alimenté uniquement par échange depuis le NF, valeur fixe 1:1.'
      }, { transaction });
    } catch (error) {
      // Course entre deux requêtes concurrentes au tout premier appel :
      // l'une des deux heurte la contrainte unique sur symbol, on relit.
      currency = await VirtualCurrency.findOne({ where: { symbol: 'EUR' }, transaction });
      if (!currency) throw error;
    }
  }

  cached = currency;
  cachedAt = Date.now();
  return currency;
}

module.exports = { getOrCreateEurCurrency };
