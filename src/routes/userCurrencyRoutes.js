'use strict';

/**
 * Monnaies communautaires : émission payante (10 000 NF) et conversion
 * vers/depuis le NF et l'EUR interne. Toute la logique vit dans
 * `economy/userCurrency` — ici, seulement le contrat HTTP.
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const {
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
} = require('../economy/userCurrency');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const {
  authenticateToken,
  logAuthenticatedRequest,
  updateLastActivity
} = require('../middleware/authMiddleware');
const { checkUserBanStrict } = require('../middleware/banMiddleware');
const logger = require('../utils/logger');
const transactionAuthorizationService = require('../services/transactionAuthorizationService');

const router = express.Router();

router.use(authenticateToken, logAuthenticatedRequest, updateLastActivity);

function handleError(res, error, fallback) {
  if (transactionAuthorizationService.constructor.isRiskError(error)) {
    return res.status(error.httpStatus || 403).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
  if (error instanceof UserCurrencyError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  // Le ledger remonte ces messages en clair : ils sont utiles à l'utilisateur.
  if (error instanceof Error && /Solde insuffisant|Taux de change invalide|Impossible d'échanger/.test(error.message)) {
    return res.status(400).json({ success: false, message: error.message });
  }
  logger.error(fallback, error);
  return res.status(500).json({ success: false, message: 'Erreur serveur interne' });
}

function reject(res, errors) {
  return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
}

/**
 * Tarif d'émission, pour que le client puisse l'afficher sans le coder en
 * dur — inclut `totalValueEur` (valeur réellement payée, au taux NF actuel)
 * pour que l'UI calcule en direct l'offre résultante d'un prix de départ
 * choisi (offre = totalValueEur / prix), sans aller-retour serveur à chaque
 * frappe. C'est une ESTIMATION : le taux NF au moment de la création réelle
 * peut avoir légèrement bougé, le calcul final fait foi côté serveur.
 */
router.get('/pricing', async (req, res) => {
  const nfCurrency = await getPlatformCurrency().catch(() => null);
  const nfPriceEur = Number(nfCurrency?.currentPrice) || 0;
  res.json({
    success: true,
    data: {
      creationCostNf: CREATION_COST_NF,
      initialSupply: INITIAL_SUPPLY,
      minBasePriceEur: MIN_BASE_PRICE_EUR,
      maxBasePriceEur: MAX_BASE_PRICE_EUR,
      totalValueEur: nfPriceEur > 0 ? CREATION_COST_NF * nfPriceEur : null
    }
  });
});

/** Liste des monnaies communautaires (toutes, ou celles d'un créateur). */
router.get('/',
  [query('creatorId').optional().isUUID()],
  async (req, res) => {
    try {
      const currencies = await listUserCurrencies({ creatorId: req.query.creatorId });
      const data = await Promise.all(currencies.map(async (c) => ({
        id: c.id,
        name: c.name,
        symbol: c.symbol,
        description: c.description,
        color: c.color,
        priceEur: Number(c.currentPrice),
        totalSupply: Number(c.totalSupply),
        marketCap: Number(c.marketCap),
        isActive: c.isActive,
        createdAt: c.createdAt,
        creator: c.creator
          ? { id: c.creator.id, username: c.creator.username, full_name: c.creator.full_name, avatar: c.creator.avatar }
          : null,
        holding: await getHolding(req.user.id, c.id)
      })));
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error, 'Erreur lors du listing des monnaies communautaires:');
    }
  }
);

/** Fiche détaillée : cours, courbe, détenteurs, activité. */
router.get('/:currencyId',
  [
    param('currencyId').isUUID(),
    query('range').optional().isIn(['1h', '24h', '7d', '30d'])
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return reject(res, errors);
    try {
      const detail = await getCurrencyDetail(req.user.id, req.params.currencyId, { range: req.query.range });
      res.json({ success: true, data: detail });
    } catch (error) {
      handleError(res, error, 'Erreur lors du chargement d\'une monnaie communautaire:');
    }
  }
);

/** Émettre sa propre monnaie — débite 10 000 NF. */
router.post('/',
  checkUserBanStrict,
  [
    body('name').isString().trim().isLength({ min: 3, max: 32 }),
    body('symbol').isString().trim().isLength({ min: 2, max: 10 }),
    body('description').optional().isString().isLength({ max: 500 }),
    body('color').optional().matches(/^#[0-9a-fA-F]{6}$/),
    body('basePriceEur').optional().isFloat({ min: MIN_BASE_PRICE_EUR, max: MAX_BASE_PRICE_EUR })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return reject(res, errors);
    try {
      const { currency, initialPriceEur, initialSupply, costNf } = await createUserCurrency(req.user.id, req.body);
      res.status(201).json({
        success: true,
        data: {
          id: currency.id,
          name: currency.name,
          symbol: currency.symbol,
          color: currency.color,
          priceEur: initialPriceEur,
          totalSupply: initialSupply
        },
        message: `${currency.symbol} émise : ${initialSupply} unités créditées pour ${costNf} NF.`
      });
    } catch (error) {
      handleError(res, error, 'Erreur lors de la création d\'une monnaie communautaire:');
    }
  }
);

/**
 * Convertir. `target` dit contre quoi, `reverse` dit dans quel sens :
 * false = on vend la monnaie communautaire, true = on l'achète.
 */
router.post('/:currencyId/convert',
  checkUserBanStrict,
  [
    param('currencyId').isUUID(),
    body('target').isIn(['NF', 'EUR']),
    body('amount').isFloat({ gt: 0 }),
    body('reverse').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return reject(res, errors);
    try {
      const result = await convertUserCurrency(
        req.user.id,
        req.params.currencyId,
        req.body.target,
        req.body.amount,
        { reverse: Boolean(req.body.reverse) }
      );
      const fromLabel = result.reverse ? result.target : result.symbol;
      const toLabel = result.reverse ? result.symbol : result.target;
      res.json({
        success: true,
        data: result,
        message: `Converti ${result.debited} ${fromLabel} en ${result.credited} ${toLabel}.`
      });
    } catch (error) {
      handleError(res, error, 'Erreur lors de la conversion d\'une monnaie communautaire:');
    }
  }
);

module.exports = router;
