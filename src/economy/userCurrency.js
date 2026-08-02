'use strict';

/**
 * Monnaies communautaires : n'importe quel utilisateur peut émettre la sienne
 * contre 10 000 NF. Elle vit dans la même table `virtual_currencies` que le NF
 * et l'EUR interne, et se manipule avec les mêmes portefeuilles `user_wallets`
 * — donc rien de neuf côté ledger, seulement des règles d'émission.
 *
 * Prix : fixé à la création à partir de ce que le créateur a payé, puis il
 * dérive via `currentMultiplier` que `EconomyLedger` déplace à chaque échange.
 *
 * ⚠️ Ne JAMAIS appeler `EconomyMetrics.refresh()` sur une monnaie
 * communautaire : cette fonction écrase `currentPrice` par
 * `REFERENCE_PRICE_EUR * multiplier` pour n'importe quelle monnaie (elle a été
 * écrite en supposant une plateforme mono-monnaie), ce qui replacerait une
 * monnaie communautaire au prix du NF. Même piège que pour l'EUR interne.
 */

const { Op, QueryTypes } = require('sequelize');
const { VirtualCurrency, UserWallet, User } = require('../models');
const { sequelize } = require('../database/index');
const EconomyLedger = require('./ledger');
const { getPlatformCurrency } = require('./platformCurrency');
const { getOrCreateEurCurrency } = require('./eurCurrency');
const { roundTWC, roundPrice, toAmount } = require('./money');
const { CHART_RANGES, resolveChartRange } = require('./chartRanges');
const logger = require('../utils/logger');

/** Coût d'émission, payé en NF et versé à la trésorerie. */
const CREATION_COST_NF = 10000;

/**
 * Unités créditées au créateur au moment de l'émission — valeur par défaut
 * utilisée seulement si `basePriceEur` n'est pas fourni (rétrocompatibilité).
 * Le chemin normal laisse maintenant le créateur choisir son PRIX de départ
 * en EUR, et c'est l'offre qui est dérivée de ce prix (`totalValueEur / prix`)
 * — avant, l'offre était toujours figée à 1 000 000, quel que soit ce que ça
 * donnait comme prix résultant, ce qui ne permettait aucun contrôle réel sur
 * le positionnement de la monnaie (centime symbolique vs monnaie "chère").
 */
const INITIAL_SUPPLY = 1000000;

// Bornes alignées sur la précision réelle de la colonne DB `basePrice`/
// `currentPrice` (DECIMAL(10,4)) : en-dessous de 0.0001 le prix serait
// tronqué à 0 en base (division par zéro plus tard sur toute la monnaie),
// au-dessus de la borne haute on protège juste contre une saisie absurde.
const MIN_BASE_PRICE_EUR = 0.0001;
const MAX_BASE_PRICE_EUR = 1000;

/** Symboles que personne ne peut réutiliser. */
const RESERVED_SYMBOLS = new Set(['NF', 'EUR', 'TWC', 'USD', 'GBP', 'BTC', 'ETH']);

const NAME_PATTERN = /^[\p{L}\p{N} .'-]{3,32}$/u;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,10}$/;

class UserCurrencyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserCurrencyError';
    this.status = status;
  }
}

function normalizeSymbol(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

function validateIdentity(name, symbol) {
  if (!NAME_PATTERN.test(name)) {
    throw new UserCurrencyError('Le nom doit faire 3 à 32 caractères (lettres, chiffres, espaces, . \' -).');
  }
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new UserCurrencyError('Le symbole doit faire 2 à 10 caractères en majuscules ou chiffres.');
  }
  if (RESERVED_SYMBOLS.has(symbol)) {
    throw new UserCurrencyError(`Le symbole ${symbol} est réservé par la plateforme.`);
  }
}

/**
 * Crée une monnaie communautaire. Tout se passe dans une seule transaction :
 * si le débit des 10 000 NF échoue, aucune monnaie n'est laissée derrière.
 */
async function createUserCurrency(userId, { name, symbol, description, color, basePriceEur }) {
  const cleanName = normalizeName(name);
  const cleanSymbol = normalizeSymbol(symbol);
  validateIdentity(cleanName, cleanSymbol);

  let requestedPriceEur = null;
  if (basePriceEur != null) {
    requestedPriceEur = Number(basePriceEur);
    if (!Number.isFinite(requestedPriceEur) || requestedPriceEur < MIN_BASE_PRICE_EUR || requestedPriceEur > MAX_BASE_PRICE_EUR) {
      throw new UserCurrencyError(
        `Prix de départ invalide : entre ${MIN_BASE_PRICE_EUR} € et ${MAX_BASE_PRICE_EUR} €.`
      );
    }
  }

  const nfCurrency = await getPlatformCurrency({ fresh: true });
  if (!nfCurrency) {
    throw new UserCurrencyError('Monnaie de plateforme indisponible.', 503);
  }
  const nfPriceEur = Number(nfCurrency.currentPrice);
  if (!(nfPriceEur > 0)) {
    throw new UserCurrencyError('Taux de change indisponible.', 503);
  }

  // Le doublon est aussi garanti par les contraintes UNIQUE sur name/symbol ;
  // ce pré-contrôle sert seulement à rendre le message d'erreur lisible.
  const existing = await VirtualCurrency.findOne({
    where: { [Op.or]: [{ symbol: cleanSymbol }, { name: cleanName }] }
  });
  if (existing) {
    throw new UserCurrencyError(
      existing.symbol === cleanSymbol
        ? `Le symbole ${cleanSymbol} est déjà pris.`
        : `Le nom « ${cleanName} » est déjà pris.`
    );
  }

  return sequelize.transaction(async (dbTransaction) => {
    // Débit centralisé : analyse Rust, preuve anti-rejeu et consommation
    // atomique sont désormais obligatoires avant l'émission de la monnaie.
    await EconomyLedger.spendToTreasury(
      userId,
      nfCurrency.id,
      CREATION_COST_NF,
      {
        description: `Émission de la monnaie ${cleanSymbol}`,
        itemType: 'currency_creation',
        itemId: cleanSymbol,
        spendingCategory: 'service',
        metadata: { symbol: cleanSymbol }
      },
      dbTransaction
    );

    // Valeur totale payée par le créateur, à répartir entre prix et offre.
    const totalValueEur = CREATION_COST_NF * nfPriceEur;

    // Si un prix de départ est choisi, c'est l'OFFRE qui est dérivée pour que
    // la capitalisation de départ égale exactement ce qui a été payé (sinon,
    // comportement historique : offre figée, prix dérivé).
    let initialPriceEur;
    let initialSupply;
    if (requestedPriceEur != null) {
      initialPriceEur = roundPrice(requestedPriceEur);
      initialSupply = Math.max(1, Math.round(totalValueEur / initialPriceEur));
    } else {
      initialSupply = INITIAL_SUPPLY;
      initialPriceEur = roundPrice(totalValueEur / initialSupply);
    }

    const currency = await VirtualCurrency.create({
      name: cleanName,
      symbol: cleanSymbol,
      description: description ? String(description).trim().slice(0, 500) : null,
      color: /^#[0-9a-fA-F]{6}$/.test(String(color ?? '')) ? color : '#FE2C55',
      creatorId: userId,
      isUserCreated: true,
      isActive: true,
      basePrice: initialPriceEur,
      currentPrice: initialPriceEur,
      currentMultiplier: 1,
      totalSupply: initialSupply,
      circulatingSupply: initialSupply,
      marketCap: roundTWC(initialSupply * initialPriceEur)
    }, { transaction: dbTransaction });

    // L'offre initiale va au créateur : c'est lui qui la met en circulation.
    const creatorWallet = await EconomyLedger.lockWallet(userId, currency.id, dbTransaction);
    await creatorWallet.update(
      {
        balance: roundTWC(toAmount(creatorWallet.balance) + initialSupply),
        totalEarned: roundTWC(toAmount(creatorWallet.totalEarned) + initialSupply)
      },
      { transaction: dbTransaction }
    );

    await EconomyLedger.createTx(
      {
        fromUserId: userId,
        toUserId: userId,
        currencyId: currency.id,
        amount: initialSupply,
        type: 'SYSTEM',
        description: `Offre initiale de ${cleanSymbol}`,
        metadata: { ledger: 'CURRENCY_GENESIS', symbol: cleanSymbol }
      },
      dbTransaction
    );

    logger.info(`[monnaie] ${cleanSymbol} émise par ${userId} — ${initialSupply} unités à ${initialPriceEur} € pièce`);
    return { currency, initialPriceEur, initialSupply, costNf: CREATION_COST_NF };
  });
}

/**
 * Convertit une monnaie communautaire vers NF ou EUR, dans les deux sens.
 * Le taux part toujours des prix en euros des deux monnaies concernées, donc
 * une seule formule couvre les quatre combinaisons.
 */
async function convertUserCurrency(userId, currencyId, target, amount, { reverse = false } = {}) {
  if (!['NF', 'EUR'].includes(target)) {
    throw new UserCurrencyError('Cible de conversion invalide (NF ou EUR).');
  }
  const parsedAmount = Number(amount);
  if (!(parsedAmount > 0)) {
    throw new UserCurrencyError('Montant invalide.');
  }

  const currency = await VirtualCurrency.findByPk(currencyId);
  if (!currency || !currency.isUserCreated) {
    throw new UserCurrencyError('Monnaie communautaire introuvable.', 404);
  }
  if (!currency.isActive) {
    throw new UserCurrencyError('Cette monnaie est désactivée.');
  }

  const currencyPriceEur = Number(currency.currentPrice);
  if (!(currencyPriceEur > 0)) {
    throw new UserCurrencyError('Prix indisponible pour cette monnaie.', 503);
  }

  let counterpart;
  let counterpartPriceEur;
  if (target === 'EUR') {
    counterpart = await getOrCreateEurCurrency();
    counterpartPriceEur = 1; // l'EUR interne vaut toujours 1 € par construction
  } else {
    counterpart = await getPlatformCurrency({ fresh: true });
    counterpartPriceEur = Number(counterpart?.currentPrice);
    if (!(counterpartPriceEur > 0)) {
      throw new UserCurrencyError('Taux de change NF indisponible.', 503);
    }
  }

  // Sens normal : on vend la monnaie communautaire contre la contrepartie.
  const fromCurrencyId = reverse ? counterpart.id : currency.id;
  const toCurrencyId = reverse ? currency.id : counterpart.id;
  const rate = reverse
    ? counterpartPriceEur / currencyPriceEur
    : currencyPriceEur / counterpartPriceEur;

  const result = await sequelize.transaction((dbTransaction) =>
    // `priceEur` (prix EUR réel et absolu de la monnaie communautaire à cet
    // instant, déjà résolu ci-dessus) part en métadonnée : c'est ce que
    // getCurrencyDetail lit pour tracer la courbe — jamais `rate`, qui n'est
    // qu'un ratio KOSP/NF ou KOSP/EUR selon la contrepartie de CET échange et
    // n'est donc pas comparable d'un échange à l'autre.
    EconomyLedger.exchangeCurrency(userId, fromCurrencyId, toCurrencyId, parsedAmount, rate, dbTransaction, { priceEur: currencyPriceEur })
  );

  return {
    symbol: currency.symbol,
    target,
    reverse,
    rate,
    debited: result.debited,
    credited: result.credited,
    fromBalance: result.fromBalance,
    toBalance: result.toBalance
  };
}

/** Liste publique des monnaies communautaires, la plus capitalisée d'abord. */
async function listUserCurrencies({ creatorId } = {}) {
  const where = { isUserCreated: true };
  if (creatorId) where.creatorId = creatorId;

  return VirtualCurrency.findAll({
    where,
    include: [{ model: User, as: 'creator', attributes: ['id', 'username', 'full_name', 'avatar'], required: false }],
    order: [['marketCap', 'DESC'], ['createdAt', 'DESC']],
    limit: 200
  });
}

/** Solde du demandeur sur une monnaie donnée, sans créer le portefeuille. */
async function getHolding(userId, currencyId) {
  const wallet = await UserWallet.findOne({ where: { userId, currencyId } });
  return wallet ? toAmount(wallet.balance) : 0;
}

/**
 * Fiche détaillée d'une monnaie : cours, courbe, détenteurs, activité.
 * Le prix n'est historisé nulle part pour les monnaies communautaires, donc
 * la courbe est reconstruite depuis les taux archivés sur chaque échange
 * (`metadata.rate` des transactions du ledger) — c'est la seule trace fidèle
 * de ce que valait la monnaie à un instant donné.
 *
 * `range` ('1h'|'24h'|'7d'|'30d', défaut 30d) fixe à la fois la fenêtre et le
 * bucket de regroupement (minute/heure/jour) — une fenêtre courte avec un
 * bucket "jour" donnerait un seul point, une fenêtre longue avec un bucket
 * "minute" donnerait un nombre de points illisible. Voir chartRanges.js.
 */
async function getCurrencyDetail(userId, currencyId, { range } = {}) {
  const currency = await VirtualCurrency.findByPk(currencyId, {
    include: [{ model: User, as: 'creator', attributes: ['id', 'username', 'full_name', 'avatar'], required: false }]
  });
  if (!currency || !currency.isUserCreated) {
    throw new UserCurrencyError('Monnaie communautaire introuvable.', 404);
  }

  const [nfCurrency, eurCurrency] = await Promise.all([
    getPlatformCurrency({ fresh: true }),
    getOrCreateEurCurrency()
  ]);
  const nfPriceEur = Number(nfCurrency?.currentPrice) || 0;
  const priceEur = Number(currency.currentPrice);

  const rangeKey = resolveChartRange(range);
  const { hours: rangeHours, truncUnit } = CHART_RANGES[rangeKey];

  const [holders, activity, series, supplyRow] = await Promise.all([
    // Répartition : qui détient quoi, et quelle part de l'offre.
    sequelize.query(
      `SELECT u.id AS "userId", u.username, u.avatar, w.balance::float8 AS balance
       FROM user_wallets w
       JOIN users u ON u.id = w.user_id
       WHERE w.currency_id = :currencyId AND w.balance > 0
       ORDER BY w.balance DESC
       LIMIT 25`,
      { type: QueryTypes.SELECT, replacements: { currencyId } }
    ),
    // Volume et nombre d'opérations sur 30 jours.
    sequelize.query(
      `SELECT
         COUNT(*)::int                                   AS "operations",
         COALESCE(SUM(amount), 0)::float8                AS "volume",
         COUNT(DISTINCT COALESCE(from_user_id, to_user_id))::int AS "activeAccounts"
       FROM transactions
       WHERE currency_id = :currencyId
         AND created_at >= NOW() - INTERVAL '30 days'`,
      { type: QueryTypes.SELECT, replacements: { currencyId } }
    ),
    // Courbe : prix EUR réel par bucket (minute/heure/jour selon `range`), sur la fenêtre demandée.
    //
    // `priceEur` (prix EUR absolu, écrit depuis ce correctif) est la source
    // exacte quand elle existe. Les échanges ANTÉRIEURS n'ont que `rate`, un
    // ratio entre les deux monnaies de CET échange — et dont le SENS s'inverse
    // selon la direction, ce qui est le piège :
    //   direction='out' (cette monnaie est vendue) : rate = prix(cette) / prix(contrepartie)
    //                                                => prix = rate × prix(contrepartie)
    //   direction='in'  (cette monnaie est achetée) : rate = prix(contrepartie) / prix(cette)
    //                                                => prix = prix(contrepartie) / rate
    // Appliquer la même formule aux deux sens produisait des points ~1400 €
    // pour une monnaie à 0,10 € (rate 112 × 12,44 au lieu de 12,44 / 112),
    // donc une moyenne de bucket absurde qui écrasait toute la courbe.
    //
    // Prix de la contrepartie : 1 € si c'est l'EUR interne (exact, il vaut
    // 1 € par construction), sinon le prix NF actuel — approximatif pour les
    // lignes anciennes, mais un ordre de grandeur juste vaut mieux qu'un
    // point manquant.
    //
    // Pas de filtre sur `direction` : pour CETTE monnaie (`currency_id =
    // :currencyId`), un échange ne produit qu'UNE seule ligne quel que soit
    // le sens, donc aucun doublon. Filtrer sur direction='out' comme avant
    // excluait purement et simplement tous les achats de la courbe.
    sequelize.query(
      `SELECT
         to_char(date_trunc(:truncUnit, created_at), 'YYYY-MM-DD"T"HH24:MI:SS') AS date,
         AVG(
           CASE
             WHEN (metadata->>'priceEur') IS NOT NULL THEN (metadata->>'priceEur')::float8
             WHEN metadata->>'direction' = 'in'
               THEN (CASE WHEN metadata->>'pairCurrencyId' = :eurCurrencyId THEN 1 ELSE :nfPriceEur END)
                    / NULLIF((metadata->>'rate')::float8, 0)
             ELSE (metadata->>'rate')::float8
                    * (CASE WHEN metadata->>'pairCurrencyId' = :eurCurrencyId THEN 1 ELSE :nfPriceEur END)
           END
         )::float8                                                             AS price,
         COUNT(*)::int                                                         AS trades
       FROM transactions
       WHERE currency_id = :currencyId
         AND metadata->>'ledger' = 'EXCHANGE'
         AND (metadata->>'priceEur' IS NOT NULL OR (metadata->>'rate') IS NOT NULL)
         AND created_at >= NOW() - (:rangeHours || ' hours')::interval
       GROUP BY date_trunc(:truncUnit, created_at)
       ORDER BY date_trunc(:truncUnit, created_at) ASC`,
      { type: QueryTypes.SELECT, replacements: { currencyId, truncUnit, rangeHours, eurCurrencyId: eurCurrency.id, nfPriceEur } }
    ),
    // Offre réellement en circulation. On ne se fie PAS à la colonne
    // `total_supply`, figée à l'émission : acheter la monnaie en crée de
    // nouvelles unités via le ledger sans toucher cette colonne, donc elle
    // sous-estime la circulation dès le premier achat.
    sequelize.query(
      `SELECT COALESCE(SUM(balance), 0)::float8 AS circulating,
              COUNT(*)::int AS wallets
       FROM user_wallets WHERE currency_id = :currencyId AND balance > 0`,
      { type: QueryTypes.SELECT, replacements: { currencyId } }
    )
  ]);

  const [stats] = activity;
  const circulating = Number(supplyRow?.[0]?.circulating) || 0;
  const issuedAtLaunch = Number(currency.totalSupply) || 0;
  // Base des parts : la circulation réelle, sinon les pourcentages dépassent 100 %.
  const supply = circulating > 0 ? circulating : issuedAtLaunch;

  /**
   * La courbe ne contient que des ÉCHANGES : sans trade récent, elle s'arrête
   * au dernier (« dernier point 14h ») alors que le prix affiché juste
   * au-dessus, lui, est à jour — deux chiffres incohérents sur le même écran.
   * Le NF n'a pas ce problème : son cron horaire lui pose un point par heure
   * quoi qu'il arrive.
   *
   * On ferme donc toujours la série sur le prix courant à maintenant. Ce n'est
   * pas un point inventé : `currency.currentPrice` EST le prix en vigueur à cet
   * instant, celui auquel un échange se ferait. Si le dernier bucket est déjà
   * celui en cours, on le remplace au lieu d'ajouter un doublon.
   */
  const nowBucket = (() => {
    const now = new Date();
    if (truncUnit === 'minute') now.setSeconds(0, 0);
    else if (truncUnit === 'hour') now.setMinutes(0, 0, 0);
    else now.setHours(0, 0, 0, 0);
    // Même format que to_char côté SQL, en heure locale du serveur.
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  })();

  const priceSeries = series
    .filter(p => Number.isFinite(Number(p.price)) && Number(p.price) > 0)
    .map(p => ({ date: p.date, priceEur: roundPrice(Number(p.price)), trades: p.trades }));

  if (priceEur > 0) {
    if (priceSeries.length && priceSeries[priceSeries.length - 1].date === nowBucket) {
      priceSeries[priceSeries.length - 1] = { date: nowBucket, priceEur, trades: priceSeries[priceSeries.length - 1].trades };
    } else {
      priceSeries.push({ date: nowBucket, priceEur, trades: 0 });
    }
    // Une courbe a besoin d'au moins deux points pour se tracer : une monnaie
    // sans aucun échange sur la fenêtre affichait « pas assez d'échanges »
    // alors qu'elle a bel et bien un prix. On ouvre alors sur le prix
    // d'émission, qui est sa vraie valeur de départ.
    if (priceSeries.length === 1) {
      const basePrice = Number(currency.basePrice);
      if (basePrice > 0) priceSeries.unshift({ date: priceSeries[0].date, priceEur: roundPrice(basePrice), trades: 0 });
    }
  }

  return {
    id: currency.id,
    name: currency.name,
    symbol: currency.symbol,
    description: currency.description,
    color: currency.color,
    isActive: currency.isActive,
    createdAt: currency.createdAt,
    creator: currency.creator
      ? {
        id: currency.creator.id,
        username: currency.creator.username,
        full_name: currency.creator.full_name,
        avatar: currency.creator.avatar
      }
      : null,
    priceEur,
    // Ce que vaut une unité en NF, pour éviter au client de refaire le calcul.
    priceNf: nfPriceEur > 0 ? roundPrice(priceEur / nfPriceEur) : null,
    basePriceEur: Number(currency.basePrice),
    // Variation depuis l'émission : la seule référence stable dont on dispose.
    changeSinceLaunch: Number(currency.basePrice) > 0
      ? roundTWC(((priceEur - Number(currency.basePrice)) / Number(currency.basePrice)) * 100)
      : 0,
    /** Unités créditées au créateur au moment de l'émission. */
    issuedAtLaunch,
    /** Somme réelle des soldes : c'est elle qui fait foi. */
    circulatingSupply: roundTWC(circulating),
    /** Part émise après coup par les achats, au-delà de l'offre initiale. */
    mintedByTrading: roundTWC(Math.max(0, circulating - issuedAtLaunch)),
    marketCapEur: roundTWC(supply * priceEur),
    holding: await getHolding(userId, currencyId),
    holders: holders.map(h => ({
      ...h,
      share: supply > 0 ? roundTWC((h.balance / supply) * 100) : 0
    })),
    holderCount: Number(supplyRow?.[0]?.wallets) || holders.length,
    activity: {
      operations: stats?.operations ?? 0,
      volume: stats?.volume ?? 0,
      activeAccounts: stats?.activeAccounts ?? 0
    },
    priceSeries,
    priceSeriesRange: rangeKey
  };
}

module.exports = {
  CREATION_COST_NF,
  INITIAL_SUPPLY,
  MIN_BASE_PRICE_EUR,
  MAX_BASE_PRICE_EUR,
  UserCurrencyError,
  createUserCurrency,
  convertUserCurrency,
  listUserCurrencies,
  getCurrencyDetail,
  getHolding
};
