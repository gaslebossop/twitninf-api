'use strict';

/**
 * Paiement multi-monnaies : compléter une dépense avec ce qu'on possède ailleurs.
 *
 * Le problème résolu : un prix est libellé dans UNE monnaie (le NF pour la
 * plupart des contenus), mais un compte détient souvent plusieurs monnaies —
 * du NF, de l'EUR interne, des monnaies communautaires. Avoir 50 NF et 100 KOSP
 * face à un contenu à 60 NF, c'est avoir de quoi payer sans pouvoir payer :
 * l'utilisateur devait aller convertir à la main, deviner combien, revenir, et
 * espérer que le cours n'avait pas bougé entre-temps.
 *
 * Ici, la conversion du complément et la dépense se font dans LA MÊME
 * transaction SQL. Soit tout passe, soit rien : on ne peut pas se retrouver
 * avec une monnaie communautaire vendue et l'achat échoué derrière.
 *
 * ── Ce que ce module ne fait PAS ──────────────────────────────────────────
 * Il ne convertit jamais de sa propre initiative. Vendre les avoirs de
 * quelqu'un est une décision qui lui appartient : `autoConvert` doit être
 * demandé explicitement, et `planPayment` permet d'afficher le détail exact
 * (quelles monnaies, quels montants, quels cours) AVANT de valider.
 */

const { UserWallet, VirtualCurrency } = require('../models');
const EconomyLedger = require('./ledger');
const { INTERNAL_CONVERSION_EXEMPTION } = require('./ledger');
const transactionAuthorizationService = require('../services/transactionAuthorizationService');
const { roundTWC, toAmount } = require('./money');
const { MIN_SPEND_TWC, TREASURY_USER_ID } = require('./constants');
const logger = require('../utils/logger');

/**
 * Erreur de fonds insuffisants, MÊME après conversion de tout le reste.
 *
 * Porte le détail du manque : sans lui, le client ne peut afficher que
 * « solde insuffisant », alors que l'utilisateur a besoin de savoir combien
 * il lui manque et ce qui a été pris en compte.
 */
class InsufficientFundsError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'InsufficientFundsError';
    this.httpStatus = 402;
    this.details = details;
  }
}

/**
 * Arrondi SUPÉRIEUR à 2 décimales — la précision des montants du grand livre.
 *
 * C'est le seul arrondi correct pour calculer un débit qui doit COUVRIR un
 * besoin. Avec `roundTWC` (au plus proche), convertir pour obtenir 10 NF
 * pouvait produire 9,99 NF après arrondi du crédit, et la dépense échouait sur
 * un centime — après avoir déjà vendu la monnaie source. On préfère convertir
 * un centime de trop, qui reste sur le portefeuille.
 *
 * `Number.EPSILON` amorti l'erreur de représentation binaire : sans lui,
 * `ceilTWC(0.07 * 100 / 100)` remonte au centime supérieur alors que la valeur
 * est déjà exacte à 2 décimales.
 */
function ceilTWC(amount) {
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.ceil((n * 100) - Number.EPSILON * 100) / 100;
}

/**
 * Ordre dans lequel puiser dans les autres monnaies.
 *
 * 1. L'EUR interne d'abord : son cours est fixe par construction, le convertir
 *    ne déplace aucun marché et ne coûte donc rien à personne.
 * 2. Ensuite les monnaies communautaires, de la plus grosse réserve (en euros)
 *    à la plus petite. Puiser dans la plus grosse d'abord minimise le NOMBRE
 *    de conversions, donc l'impact sur les cours : chaque échange bouge le
 *    cours de la monnaie vendue, alors régler l'appoint en une conversion vaut
 *    mieux qu'en cinq.
 * 3. À égalité, l'identifiant tranche — pour que deux appels identiques
 *    produisent exactement le même plan, et qu'un aperçu corresponde à ce qui
 *    sera réellement exécuté.
 */
function compareSources(a, b) {
  if (a.isStable !== b.isStable) return a.isStable ? -1 : 1;
  if (b.valueEur !== a.valueEur) return b.valueEur - a.valueEur;
  return String(a.currencyId).localeCompare(String(b.currencyId));
}

/**
 * Construit le plan de conversion couvrant `shortfall` unités de la monnaie cible.
 *
 * Fonction PURE : elle ne lit ni la base ni l'horloge, tout lui est passé. Ce
 * n'est pas un détail de style — c'est ce qui rend la partie délicate (les
 * arrondis, l'ordre, l'épuisement des sources) vérifiable par des tests, sans
 * base de données ni portefeuille réel.
 *
 * @param {number} shortfall        Ce qui manque, dans la monnaie cible.
 * @param {Array}  sources          `{ currencyId, symbol, balance, priceEur, isStable }`
 * @param {number} targetPriceEur   Cours en euros de la monnaie cible.
 * @returns {{ steps: Array, covered: number, missing: number }}
 */
function planConversions(shortfall, sources, targetPriceEur) {
  const steps = [];
  let remaining = roundTWC(shortfall);

  if (!(targetPriceEur > 0)) {
    throw new Error('Cours de la monnaie cible indisponible');
  }

  for (const source of [...sources].sort(compareSources)) {
    if (remaining <= 0) break;
    if (!(source.priceEur > 0) || !(source.balance > 0)) continue;

    // Combien d'unités de la cible vaut 1 unité de la source.
    const rate = source.priceEur / targetPriceEur;
    if (!(rate > 0)) continue;

    // Débit nécessaire pour couvrir le reste, arrondi au centime SUPÉRIEUR,
    // puis borné par ce que le portefeuille contient réellement.
    const wanted = ceilTWC(remaining / rate);
    const debit = roundTWC(Math.min(wanted, source.balance));

    // Un débit qui s'arrondit à zéro n'apporte rien et ferait échouer
    // `exchangeCurrency` sur son contrôle de montant positif. Ça arrive quand
    // la source vaut beaucoup plus cher que la cible et qu'il ne manque que
    // quelques centimes : on saute, une autre source paiera l'appoint.
    if (debit < MIN_SPEND_TWC) continue;

    const credit = roundTWC(debit * rate);
    if (credit <= 0) continue;

    steps.push({
      currencyId: source.currencyId,
      symbol: source.symbol,
      debit,
      credit,
      rate,
      priceEur: source.priceEur
    });
    remaining = roundTWC(remaining - credit);
  }

  const covered = roundTWC(shortfall - Math.max(0, remaining));
  return { steps, covered, missing: Math.max(0, roundTWC(remaining)) };
}

/**
 * Rassemble les monnaies mobilisables du compte, hors monnaie cible.
 *
 * Les cours sont relus DANS la transaction (`priceEurOf`), jamais depuis les
 * caches de `getPlatformCurrency`/`getOrCreateEurCurrency` : une conversion
 * déplace les cours, et les étapes suivantes du même paiement doivent voir ce
 * déplacement plutôt qu'un prix vieux d'une minute.
 */
async function collectSources(userId, targetCurrencyId, dbTransaction, { allowedCurrencyIds = null } = {}) {
  const wallets = await UserWallet.findAll({
    where: { userId },
    transaction: dbTransaction
  });

  const allowed = allowedCurrencyIds ? new Set(allowedCurrencyIds.map(String)) : null;
  const sources = [];

  for (const wallet of wallets) {
    const currencyId = String(wallet.currencyId);
    if (currencyId === String(targetCurrencyId)) continue;
    if (wallet.isLocked) continue;
    if (allowed && !allowed.has(currencyId)) continue;

    const balance = toAmount(wallet.balance);
    if (balance < MIN_SPEND_TWC) continue;

    const currency = await VirtualCurrency.findByPk(wallet.currencyId, { transaction: dbTransaction });
    if (!currency || !currency.isActive) continue;

    const priceEur = toAmount(currency.currentPrice);
    if (!(priceEur > 0)) continue;

    sources.push({
      currencyId,
      symbol: currency.symbol,
      balance,
      priceEur,
      isStable: currency.symbol === 'EUR',
      valueEur: roundTWC(balance * priceEur)
    });
  }

  return sources;
}

/**
 * Aperçu : ce que coûterait le paiement, sans rien écrire.
 *
 * Sert à afficher « il te manque 10 NF, on convertira 125 KOSP » AVANT que
 * l'utilisateur valide. Les cours pouvant bouger entre l'aperçu et l'exécution,
 * le plan réellement appliqué est recalculé au moment du paiement — cet aperçu
 * est une estimation honnête, pas un engagement de prix.
 */
async function planPayment({ userId, currencyId, amount, allowedCurrencyIds = null }, dbTransaction) {
  const total = roundTWC(amount);
  const wallet = await EconomyLedger.findOrCreateWallet(userId, currencyId, dbTransaction);
  const available = toAmount(wallet.balance);

  if (available >= total) {
    return { needsConversion: false, available, shortfall: 0, steps: [], missing: 0 };
  }

  const shortfall = roundTWC(total - available);
  const targetPriceEur = await EconomyLedger.priceEurOf(currencyId, dbTransaction);
  const sources = await collectSources(userId, currencyId, dbTransaction, { allowedCurrencyIds });
  const { steps, missing } = planConversions(shortfall, sources, targetPriceEur);

  return { needsConversion: true, available, shortfall, steps, missing };
}

/**
 * Dépense `amount` dans `currencyId`, en convertissant l'appoint si demandé.
 *
 * ⚠ `dbTransaction` est OBLIGATOIRE et doit être celle de l'opération métier
 * (achat de contenu, etc.). C'est toute la garantie du module : les
 * conversions et la dépense partagent le sort de l'achat qu'elles financent.
 *
 * @returns {{ spend, conversions, convertedFrom }} `spend` est le retour brut
 *   de `spendToTreasury`, pour que les appelants existants n'aient rien à
 *   changer à leur lecture du résultat.
 */
async function spendWithAutoConversion(
  { userId, currencyId, amount, meta, autoConvert = false, allowedCurrencyIds = null },
  dbTransaction
) {
  if (!dbTransaction) {
    throw new Error('spendWithAutoConversion requiert une transaction Sequelize');
  }

  const total = roundTWC(amount);

  // ⚠ LECTURE SANS VERROU, volontairement.
  //
  // Une première version prenait ici un `FOR UPDATE` sur le portefeuille cible,
  // puis sur chaque monnaie source, avant de lancer les conversions. Intention :
  // empêcher deux paiements simultanés de lire le même solde. Effet réel :
  // l'achat mourait en `TimeoutError: unknown timed out` (retry.timeout = 3000
  // dans `config/config.js`), un message qui ne dit rien du verrou.
  //
  // La raison : `exchangeCurrency` et `spendToTreasury` appellent tous deux
  // `transactionAuthorizationService.authorize`, qui interroge le moteur Rust
  // et écrit SUR UNE AUTRE CONNEXION. Garder des verrous de ligne pendant trois
  // allers-retours vers un service externe fait tenir ces verrous des secondes
  // entières, et bloque les requêtes concurrentes du même compte jusqu'au
  // délai fatal. Ce n'est pas un hasard si le grand livre autorise TOUJOURS
  // avant de verrouiller : c'est ce qui garde la durée de verrouillage courte.
  //
  // La sécurité ne repose donc pas sur un verrou tenu ici, mais sur ceux que
  // prennent `exchangeCurrency` et `spendToTreasury` juste après leur
  // autorisation — chacun relit et revérifie le solde sous verrou avant de
  // débiter. Le pire cas d'une course reste un refus « solde insuffisant »,
  // jamais un double débit.
  const targetWallet = await EconomyLedger.findOrCreateWallet(userId, currencyId, dbTransaction);
  const available = toAmount(targetWallet.balance);

  if (available >= total) {
    const spend = await EconomyLedger.spendToTreasury(userId, currencyId, total, meta, dbTransaction);
    return { spend, conversions: [], convertedFrom: [] };
  }

  const shortfall = roundTWC(total - available);

  if (!autoConvert) {
    // Le message reste celui attendu par les appelants historiques, pour ne
    // pas casser leur gestion d'erreur ; le détail part dans `details`.
    throw new InsufficientFundsError('Solde insuffisant', {
      required: total, available, shortfall, autoConvertAvailable: true
    });
  }

  const targetPriceEur = await EconomyLedger.priceEurOf(currencyId, dbTransaction);
  const sources = await collectSources(userId, currencyId, dbTransaction, { allowedCurrencyIds });
  const { steps, missing } = planConversions(shortfall, sources, targetPriceEur);

  if (missing > 0) {
    throw new InsufficientFundsError('Solde insuffisant, même en convertissant tes autres monnaies', {
      required: total, available, shortfall, missing,
      convertible: steps.map((s) => ({ symbol: s.symbol, amount: s.debit }))
    });
  }

  // ── L'UNIQUE autorisation du paiement, prise AVANT le premier verrou ───────
  //
  // Elle porte le montant TOTAL de la dépense, pas les conversions : c'est la
  // sortie de valeur qui engage le compte. Les conversions qui suivent sont
  // dispensées (`INTERNAL_CONVERSION_EXEMPTION`) — non par complaisance, mais
  // parce qu'une autorisation demandée après nos verrous attendrait ces verrous
  // pendant que nous attendons sa réponse. Voir le commentaire du symbole.
  const targetPriceEurNow = await EconomyLedger.priceEurOf(currencyId, dbTransaction);
  const preAuthorization = await transactionAuthorizationService.authorize({
    userId,
    transactionKind: 'purchase',
    direction: 'outbound',
    amount: total,
    amountEur: roundTWC(total * targetPriceEurNow),
    currencyId,
    counterpartyUserId: TREASURY_USER_ID,
    merchantId: meta?.itemType || 'twitninf',
    itemType: meta?.itemType || 'purchase',
    itemId: meta?.itemId || null
  });

  const conversions = [];
  for (const step of steps) {
    // Le cours est relu juste avant CHAQUE échange : l'échange précédent a pu
    // déplacer les deux cours concernés (`_applyExchangePriceImpact`). Utiliser
    // le taux calculé au moment du plan ferait diverger le crédit réel de celui
    // annoncé, d'autant plus que le paiement mobilise de monnaies.
    const freshSourcePrice = await EconomyLedger.priceEurOf(step.currencyId, dbTransaction);
    const freshTargetPrice = await EconomyLedger.priceEurOf(currencyId, dbTransaction);
    const rate = freshSourcePrice / freshTargetPrice;
    if (!(rate > 0)) continue;

    const result = await EconomyLedger.exchangeCurrency(
      userId, step.currencyId, currencyId, step.debit, rate, dbTransaction,
      {
        priceEur: freshSourcePrice,
        reason: 'auto_conversion_payment',
        riskExemption: INTERNAL_CONVERSION_EXEMPTION,
        forItemType: meta?.itemType || null,
        forItemId: meta?.itemId || null
      }
    );
    conversions.push({
      currencyId: step.currencyId,
      symbol: step.symbol,
      debited: result.debited,
      credited: result.credited,
      rate
    });
  }

  // Relecture du solde APRÈS conversions : c'est lui qui fait foi, pas la somme
  // des crédits annoncés. Les cours ayant pu bouger entre le plan et
  // l'exécution, on peut retomber quelques centimes en dessous.
  //
  // Sans verrou ici non plus, et pour la même raison : `spendToTreasury` va de
  // toute façon reverrouiller et revérifier ce solde juste après. Cette lecture
  // ne sert qu'à produire un message utile — « les cours ont bougé » plutôt
  // qu'un « solde insuffisant » incompréhensible après une conversion réussie.
  const refreshed = await EconomyLedger.findOrCreateWallet(userId, currencyId, dbTransaction);
  const afterConversion = toAmount(refreshed.balance);
  if (afterConversion < total) {
    throw new InsufficientFundsError(
      'Solde insuffisant après conversion — les cours ont bougé, réessaie',
      { required: total, available: afterConversion, missing: roundTWC(total - afterConversion) }
    );
  }

  logger.info(
    `[paiement multi-monnaies] ${userId} : ${conversions.length} conversion(s) pour couvrir ${shortfall}`
  );

  const spend = await EconomyLedger.spendToTreasury(userId, currencyId, total, {
    ...meta,
    // Consomme l'autorisation obtenue plus haut plutôt que d'en redemander une
    // — nous tenons désormais des verrous, elle ne pourrait plus aboutir.
    preAuthorization,
    metadata: {
      ...(meta?.metadata || {}),
      autoConverted: conversions.length > 0,
      autoConversionSources: conversions.map((c) => ({ symbol: c.symbol, debited: c.debited, credited: c.credited }))
    }
  }, dbTransaction);

  return { spend, conversions, convertedFrom: conversions.map((c) => c.symbol) };
}

module.exports = {
  InsufficientFundsError,
  ceilTWC,
  compareSources,
  planConversions,
  collectSources,
  planPayment,
  spendWithAutoConversion
};
