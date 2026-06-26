const crypto = require('crypto');
const { Op } = require('sequelize');
const { VirtualCurrency, UserWallet, Transaction, User } = require('../models');
const { sequelize } = require('../database/index');
const logger = require('../utils/logger');
const NewEconomyService = require('./newEconomyService');
const EconomyLedger = require('../economy/ledger');
const { SYMBOL, REFERENCE_PRICE_EUR } = require('../economy/constants');
const { toAmount } = require('../economy/money');

/**
 * Façade legacy — délègue au système économique fermé (pas de minage gratuit).
 */
class VirtualCurrencyService {
  static async createCurrency(currencyData) {
    const currency = await VirtualCurrency.create(currencyData);
    logger.info(`Monnaie créée: ${currency.symbol}`);
    return currency;
  }

  static async getCurrency(symbol) {
    return VirtualCurrency.findOne({ where: { symbol, isActive: true } });
  }

  static async getUserWallet(userId, currencyId) {
    return EconomyLedger.findOrCreateWallet(userId, currencyId);
  }

  static async mineCurrency() {
    throw new Error(
      'Le minage gratuit est désactivé. Achetez des TwitCoins ou recevez des récompenses créateur financées par la plateforme.'
    );
  }

  static async transferCurrency(fromUserId, toUserId, currencyId, amount, description = '') {
    return NewEconomyService.transferCoins(fromUserId, toUserId, currencyId, amount, description);
  }

  static async createTransaction(transactionData) {
    const transactionHash = crypto.randomBytes(32).toString('hex');
    return Transaction.create({
      ...transactionData,
      transactionHash,
      confirmedAt: new Date()
    });
  }

  static async getUserTransactions(userId, currencyId = null, limit = 50, offset = 0) {
    const where = {
      [Op.or]: [{ fromUserId: userId }, { toUserId: userId }]
    };
    if (currencyId) where.currencyId = currencyId;

    return Transaction.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset,
      include: [
        { model: VirtualCurrency, as: 'currency', attributes: ['name', 'symbol', 'icon', 'color'] },
        { model: User, as: 'fromUser', attributes: ['username', 'avatar'] },
        { model: User, as: 'toUser', attributes: ['username', 'avatar'] }
      ]
    });
  }

  static async updatePrice(currencyId) {
    const currency = await VirtualCurrency.findByPk(currencyId);
    if (!currency) throw new Error('Monnaie introuvable');
    await currency.update({
      currentPrice: REFERENCE_PRICE_EUR,
      basePrice: REFERENCE_PRICE_EUR,
      currentMultiplier: 1.0,
      priceChange24h: 0
    });
    return currency;
  }

  static async getCurrencyStats(currencyId) {
    const currency = await VirtualCurrency.findByPk(currencyId);
    if (!currency) throw new Error('Monnaie introuvable');

    const stats = await NewEconomyService.getEconomicStats(currencyId);
    return {
      ...currency.toJSON(),
      ...stats.currency,
      volume24h: stats.currency.volume24h
    };
  }

  static async getMainCurrency() {
    return this.getCurrency(SYMBOL);
  }
}

module.exports = VirtualCurrencyService;
