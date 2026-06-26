/**
 * Monnaie virtuelle fermée (type Robux) : achats EUR → mint TWC,
 * dépenses → trésorerie plateforme, récompenses créateurs ← trésorerie uniquement.
 */

const TREASURY_USER_ID =
  process.env.TWITNINF_TREASURY_USER_ID || '01837802-c2ae-4de0-9471-7a9b642afde2';

/** Prix de référence affiché (1 TWC ≈ 0,01 €) — ne fluctue pas au quotidien */
const REFERENCE_PRICE_EUR = 0.01;

const SYMBOL = 'TWC';

/** Packages : prix EUR fixes, bonus intégré au volume (meilleur rapport sur gros packs) */
const PURCHASE_PACKAGES = [
  { id: 'small', name: 'Pack Starter', priceEur: 0.99, baseCoins: 100, bonusPercent: 0, popular: false },
  { id: 'medium', name: 'Pack Popular', priceEur: 4.99, baseCoins: 500, bonusPercent: 5, popular: true },
  { id: 'large', name: 'Pack Premium', priceEur: 9.99, baseCoins: 1050, bonusPercent: 10, popular: false },
  { id: 'mega', name: 'Pack Elite', priceEur: 19.99, baseCoins: 2200, bonusPercent: 12, popular: false },
  { id: 'ultimate', name: 'Pack Ultimate', priceEur: 49.99, baseCoins: 5750, bonusPercent: 15, popular: false },
  { id: 'vip_100', name: 'Pack VIP 100€', priceEur: 100, baseCoins: 12000, bonusPercent: 18, popular: false },
  { id: 'vip_500', name: 'Pack VIP 500€', priceEur: 500, baseCoins: 62000, bonusPercent: 20, popular: false },
  { id: 'vip_1000', name: 'Pack VIP 1000€', priceEur: 1000, baseCoins: 128000, bonusPercent: 22, popular: false },
  { id: 'vip_10000', name: 'Pack VIP 10000€', priceEur: 10000, baseCoins: 1300000, bonusPercent: 25, popular: false }
];

const MIN_TRANSFER_TWC = 0.01;
const MIN_SPEND_TWC = 0.01;
const MIN_REWARD_TWC = 0.01;

/** Frais sur transfert P2P (fraction vers la trésorerie) */
const P2P_TRANSFER_FEE_RATE = 0.02;

module.exports = {
  TREASURY_USER_ID,
  REFERENCE_PRICE_EUR,
  SYMBOL,
  PURCHASE_PACKAGES,
  MIN_TRANSFER_TWC,
  MIN_SPEND_TWC,
  MIN_REWARD_TWC,
  P2P_TRANSFER_FEE_RATE
};
