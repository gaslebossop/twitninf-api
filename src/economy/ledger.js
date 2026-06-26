const crypto = require('crypto');
const { Op } = require('sequelize');
const { VirtualCurrency, UserWallet, Transaction } = require('../models');
const logger = require('../utils/logger');
const {
  TREASURY_USER_ID,
  REFERENCE_PRICE_EUR,
  MIN_SPEND_TWC,
  MIN_REWARD_TWC,
  MIN_TRANSFER_TWC,
  P2P_TRANSFER_FEE_RATE
} = require('./constants');
const { roundTWC, toAmount, assertPositive } = require('./money');

/**
 * Grand livre : toutes les écritures passent ici (verrous pessimistes sur portefeuilles).
 */
class EconomyLedger {
  static async getActiveCurrency(currencyId, dbTransaction = null) {
    const currency = await VirtualCurrency.findByPk(currencyId, { transaction: dbTransaction });
    if (!currency || !currency.isActive) {
      throw new Error('Monnaie virtuelle indisponible');
    }
    return currency;
  }

  static async findOrCreateWallet(userId, currencyId, dbTransaction = null) {
    const [wallet] = await UserWallet.findOrCreate({
      where: { userId, currencyId },
      defaults: {
        balance: 0,
        totalEarned: 0,
        totalSpent: 0,
        totalPurchased: 0,
        loyaltyPoints: 0
      },
      transaction: dbTransaction
    });
    return wallet;
  }

  static async lockWallet(userId, currencyId, dbTransaction) {
    if (!dbTransaction) {
      throw new Error('lockWallet requiert une transaction Sequelize');
    }
    await this.findOrCreateWallet(userId, currencyId, dbTransaction);
    const wallet = await UserWallet.findOne({
      where: { userId, currencyId },
      lock: dbTransaction.LOCK.UPDATE,
      transaction: dbTransaction
    });
    if (!wallet) {
      throw new Error('Portefeuille introuvable');
    }
    if (wallet.isLocked) {
      throw new Error('Portefeuille verrouillé — opération refusée');
    }
    return wallet;
  }

  static async createTx(row, dbTransaction) {
    const transactionHash = crypto.randomBytes(32).toString('hex');
    return Transaction.create(
      {
        transactionHash,
        status: 'COMPLETED',
        fee: 0,
        confirmedAt: new Date(),
        amountInEur: 0,
        metadata: {},
        ...row
      },
      { transaction: dbTransaction }
    );
  }

  /**
   * Achat EUR : création (mint) de TWC vers l'utilisateur.
   */
  static async mintFromPurchase(userId, currencyId, pkg, paymentMethod, dbTransaction) {
    const amount = assertPositive(pkg.totalCoins, 'Quantité de pièces');
    const priceEur = roundTWC(pkg.priceEur);

    const wallet = await this.lockWallet(userId, currencyId, dbTransaction);

    const tx = await this.createTx(
      {
        fromUserId: null,
        toUserId: userId,
        currencyId,
        amount,
        amountInEur: priceEur,
        type: 'PURCHASE',
        description: `Achat ${pkg.name} — ${amount} TWC`,
        metadata: {
          packageId: pkg.id,
          packageName: pkg.name,
          baseCoins: pkg.baseCoins,
          bonusCoins: pkg.bonusCoins,
          paymentMethod,
          referencePriceEur: REFERENCE_PRICE_EUR
        }
      },
      dbTransaction
    );

    const newBalance = roundTWC(toAmount(wallet.balance) + amount);
    await wallet.update(
      {
        balance: newBalance,
        totalEarned: roundTWC(toAmount(wallet.totalEarned) + amount),
        totalPurchased: roundTWC(toAmount(wallet.totalPurchased) + amount),
        loyaltyPoints: wallet.loyaltyPoints + Math.floor(amount / 100),
        lastPurchaseDate: new Date()
      },
      { transaction: dbTransaction }
    );

    return { tx, wallet, amount, priceEur };
  }

  /**
   * Dépense in-app : utilisateur → trésorerie (masse monétaire inchangée).
   */
  static async spendToTreasury(userId, currencyId, amount, meta, dbTransaction) {
    const spend = assertPositive(amount, 'Montant');
    if (spend < MIN_SPEND_TWC) {
      throw new Error(`Dépense minimale : ${MIN_SPEND_TWC} TWC`);
    }

    const userWallet = await this.lockWallet(userId, currencyId, dbTransaction);
    const balance = toAmount(userWallet.balance);
    if (balance < spend) {
      throw new Error('Solde insuffisant');
    }

    const treasuryWallet = await this.lockWallet(TREASURY_USER_ID, currencyId, dbTransaction);

    const tx = await this.createTx(
      {
        fromUserId: userId,
        toUserId: TREASURY_USER_ID,
        currencyId,
        amount: spend,
        amountInEur: roundTWC(spend * REFERENCE_PRICE_EUR),
        type: 'TRANSFER',
        description: meta.description || 'Dépense TwitCoins',
        metadata: {
          ...meta.metadata,
          itemType: meta.itemType,
          itemId: meta.itemId,
          spendingCategory: meta.spendingCategory,
          ledger: 'SPEND_TO_TREASURY'
        }
      },
      dbTransaction
    );

    await userWallet.update(
      {
        balance: roundTWC(balance - spend),
        totalSpent: roundTWC(toAmount(userWallet.totalSpent) + spend)
      },
      { transaction: dbTransaction }
    );

    await treasuryWallet.update(
      {
        balance: roundTWC(toAmount(treasuryWallet.balance) + spend),
        totalEarned: roundTWC(toAmount(treasuryWallet.totalEarned) + spend)
      },
      { transaction: dbTransaction }
    );

    return {
      tx,
      wallet: userWallet,
      remainingBalance: roundTWC(balance - spend),
      treasuryBalance: roundTWC(toAmount(treasuryWallet.balance) + spend)
    };
  }

  /**
   * Récompense créateur : trésorerie → utilisateur (fonds préalablement collectés).
   */
  static async rewardFromTreasury(userId, currencyId, amount, description, dbTransaction) {
    const reward = assertPositive(amount, 'Récompense');
    if (reward < MIN_REWARD_TWC) {
      return { success: false, reason: 'Montant trop faible' };
    }

    const treasuryWallet = await this.lockWallet(TREASURY_USER_ID, currencyId, dbTransaction);
    const treasuryBalance = toAmount(treasuryWallet.balance);

    if (treasuryBalance < reward) {
      logger.warn(
        `[economy] Trésorerie insuffisante (${treasuryBalance} TWC) pour récompense ${reward} TWC → ${userId}`
      );
      throw new Error(
        'Fonds plateforme insuffisants pour cette récompense. Les récompenses sont financées par les dépenses des utilisateurs.'
      );
    }

    const userWallet = await this.lockWallet(userId, currencyId, dbTransaction);

    const tx = await this.createTx(
      {
        fromUserId: TREASURY_USER_ID,
        toUserId: userId,
        currencyId,
        amount: reward,
        amountInEur: roundTWC(reward * REFERENCE_PRICE_EUR),
        type: 'REWARD',
        description: description || 'Récompense créateur',
        metadata: { ledger: 'REWARD_FROM_TREASURY' }
      },
      dbTransaction
    );

    await treasuryWallet.update(
      {
        balance: roundTWC(treasuryBalance - reward),
        totalSpent: roundTWC(toAmount(treasuryWallet.totalSpent) + reward)
      },
      { transaction: dbTransaction }
    );

    await userWallet.update(
      {
        balance: roundTWC(toAmount(userWallet.balance) + reward),
        totalEarned: roundTWC(toAmount(userWallet.totalEarned) + reward),
        loyaltyPoints: userWallet.loyaltyPoints + Math.floor(reward)
      },
      { transaction: dbTransaction }
    );

    return { success: true, tx, reward, wallet: userWallet };
  }

  /**
   * Transfert P2P avec frais vers la trésorerie.
   */
  static async transferP2P(fromUserId, toUserId, currencyId, amount, description, dbTransaction) {
    const gross = assertPositive(amount, 'Montant');
    if (gross < MIN_TRANSFER_TWC) {
      throw new Error(`Transfert minimal : ${MIN_TRANSFER_TWC} TWC`);
    }
    if (fromUserId === toUserId) {
      throw new Error('Transfert vers soi-même interdit');
    }

    const fee = roundTWC(gross * P2P_TRANSFER_FEE_RATE);
    const net = roundTWC(gross - fee);

    const fromWallet = await this.lockWallet(fromUserId, currencyId, dbTransaction);
    if (toAmount(fromWallet.balance) < gross) {
      throw new Error('Solde insuffisant');
    }

    const toWallet = await this.lockWallet(toUserId, currencyId, dbTransaction);
    const treasuryWallet = await this.lockWallet(TREASURY_USER_ID, currencyId, dbTransaction);

    const tx = await this.createTx(
      {
        fromUserId,
        toUserId,
        currencyId,
        amount: net,
        amountInEur: roundTWC(net * REFERENCE_PRICE_EUR),
        type: 'TRANSFER',
        fee,
        description: description || 'Transfert TwitCoins',
        metadata: { ledger: 'P2P', grossAmount: gross, fee }
      },
      dbTransaction
    );

    await fromWallet.update(
      {
        balance: roundTWC(toAmount(fromWallet.balance) - gross),
        totalSpent: roundTWC(toAmount(fromWallet.totalSpent) + gross)
      },
      { transaction: dbTransaction }
    );

    await toWallet.update(
      {
        balance: roundTWC(toAmount(toWallet.balance) + net),
        totalEarned: roundTWC(toAmount(toWallet.totalEarned) + net)
      },
      { transaction: dbTransaction }
    );

    if (fee > 0) {
      await treasuryWallet.update(
        {
          balance: roundTWC(toAmount(treasuryWallet.balance) + fee),
          totalEarned: roundTWC(toAmount(treasuryWallet.totalEarned) + fee)
        },
        { transaction: dbTransaction }
      );
    }

    return { tx, fee, netAmount: net };
  }

  /**
   * Ajustement admin : crédit depuis la trésorerie ou mint si trésorerie vide et politique mint.
   * Par défaut : mint (augmente l'offre) si fromUserId null, sinon débit trésorerie.
   */
  static async adminCredit(userId, currencyId, amount, reason, dbTransaction) {
    const credit = assertPositive(amount, 'Crédit');
    const wallet = await this.lockWallet(userId, currencyId, dbTransaction);

    const tx = await this.createTx(
      {
        fromUserId: null,
        toUserId: userId,
        currencyId,
        amount: credit,
        type: 'SYSTEM',
        description: `[Admin] ${reason || 'Ajustement'}`,
        metadata: { ledger: 'ADMIN_MINT' }
      },
      dbTransaction
    );

    await wallet.update(
      {
        balance: roundTWC(toAmount(wallet.balance) + credit),
        totalEarned: roundTWC(toAmount(wallet.totalEarned) + credit)
      },
      { transaction: dbTransaction }
    );

    return { tx, wallet };
  }

  static async adminSetBalance(userId, currencyId, targetBalance, reason, dbTransaction) {
    const target = roundTWC(targetBalance);
    if (target < 0) {
      throw new Error('Solde cible invalide');
    }

    const wallet = await this.lockWallet(userId, currencyId, dbTransaction);
    const current = toAmount(wallet.balance);
    const diff = roundTWC(target - current);

    if (diff === 0) {
      return { wallet, diff: 0 };
    }

    if (diff > 0) {
      await this.adminCredit(userId, currencyId, diff, reason, dbTransaction);
    } else {
      const treasuryWallet = await this.lockWallet(TREASURY_USER_ID, currencyId, dbTransaction);
      const debit = Math.abs(diff);
      if (current < debit) {
        throw new Error('Impossible de réduire le solde en dessous de zéro');
      }
      await wallet.update({ balance: target }, { transaction: dbTransaction });
      await treasuryWallet.update(
        {
          balance: roundTWC(toAmount(treasuryWallet.balance) + debit)
        },
        { transaction: dbTransaction }
      );
      await this.createTx(
        {
          fromUserId: userId,
          toUserId: TREASURY_USER_ID,
          currencyId,
          amount: debit,
          type: 'SYSTEM',
          description: `[Admin] ${reason || 'Réduction solde'}`,
          metadata: { ledger: 'ADMIN_DEBIT' }
        },
        dbTransaction
      );
    }

    const updated = await UserWallet.findOne({
      where: { userId, currencyId },
      transaction: dbTransaction
    });
    return { wallet: updated, diff };
  }
}

module.exports = EconomyLedger;
