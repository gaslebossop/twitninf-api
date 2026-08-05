const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Op, QueryTypes } = require('sequelize');
const { VirtualCurrency, UserWallet, Transaction, User } = require('../models');
const { sequelize } = require('../database/index');
const logger = require('../utils/logger');
const {
  TREASURY_USER_ID,
  REFERENCE_PRICE_EUR,
  MIN_SPEND_TWC,
  MIN_REWARD_TWC,
  MIN_TRANSFER_TWC,
  P2P_TRANSFER_FEE_RATE,
  P2P_TRANSFER_FEE_RATE_SUBSCRIBER,
  MINING_BASE_REWARD_TWC,
  MINING_DAILY_WIN_LIMIT,
  MINING_DILUTION_PER_BASE_REWARD,
  MINING_MIN_MULTIPLIER,
  EXCHANGE_PRICE_IMPACT_FACTOR,
  EXCHANGE_PRICE_MIN_MULTIPLIER,
  EXCHANGE_PRICE_MAX_MULTIPLIER
} = require('./constants');
const { roundTWC, roundPrice, toAmount, assertPositive } = require('./money');
const { isSubscriptionActive } = require('../utils/subscriptionHelpers');
const transactionAuthorizationService = require('../services/transactionAuthorizationService');
const CASINO_RISK_EXEMPTION = Symbol('casino-risk-exemption');

/**
 * Dispense d'autorisation pour les conversions internes d'un paiement DÉJÀ
 * autorisé (voir `multiCurrencyPayment`).
 *
 * ⚠ Ce n'est pas un trou dans le contrôle anti-fraude, c'est la seule façon de
 * le faire fonctionner ici. Le moteur de risque écrit
 * `UPDATE user_wallets ... WHERE user_id = :userId` — TOUS les portefeuilles du
 * compte — sur une connexion distincte de la transaction appelante. Le grand
 * livre autorise donc toujours AVANT de poser le moindre verrou. Cette règle ne
 * tient que pour UNE opération : dès qu'on en enchaîne deux dans la même
 * transaction, l'autorisation de la seconde attend les verrous posés par la
 * première, qui attend elle-même cette autorisation. Blocage circulaire, mort
 * au bout de `retry.timeout` (3 s) sur un `TimeoutError` muet.
 *
 * Ce que le risque perd est nul : une conversion déplace de la valeur entre
 * deux portefeuilles DU MÊME compte, rien ne sort. L'événement qui engage
 * vraiment le compte est la dépense sortante, et elle reste autorisée — pour
 * son montant total, en amont de toute conversion.
 */
const INTERNAL_CONVERSION_EXEMPTION = Symbol('internal-conversion-exemption');

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

  /**
   * Cours en euros d'une monnaie, pour valoriser une écriture du ledger.
   *
   * `REFERENCE_PRICE_EUR` (10 €) est le prix de référence du NF, et il était
   * appliqué tel quel à N'IMPORTE QUELLE monnaie : sur une monnaie
   * communautaire à 0,08 €, un virement de 689 524 unités était enregistré à
   * 6 895 249 € au lieu de ~55 162 €. En plus d'être faux, ça dépassait la
   * capacité de `transactions.amount_in_eur` — l'INSERT partait en
   * « numeric field overflow », ce qui avortait toute la transaction et
   * faisait échouer le virement entier (« Erreur serveur interne » côté app).
   * On part donc du cours réel de la monnaie concernée, et on ne retombe sur
   * la constante que si ce cours est indisponible.
   */
  static async priceEurOf(currencyId, dbTransaction = null) {
    const currency = await this.getActiveCurrency(currencyId, dbTransaction);
    return toAmount(currency.currentPrice) || REFERENCE_PRICE_EUR;
  }

  static async findOrCreateWallet(userId, currencyId, dbTransaction = null) {
    // Sequelize.findOrCreate génère un piège fonction-temp + EXCEPTION WHEN
    // unique_violation dont le rattrapage laisse parfois la connexion dans un
    // état "transaction avortée" (Postgres 25P02) sous concurrence — observé
    // en prod sur le portefeuille trésorerie, très sollicité. Un upsert SQL
    // natif ON CONFLICT DO NOTHING est le pattern robuste standard ici.
    await sequelize.query(
      `INSERT INTO user_wallets
         (id, user_id, currency_id, balance, total_earned, total_spent, total_purchased, loyalty_points, is_locked, created_at, updated_at)
       VALUES (:id, :userId, :currencyId, 0, 0, 0, 0, 0, false, NOW(), NOW())
       ON CONFLICT (user_id, currency_id) DO NOTHING`,
      {
        replacements: { id: uuidv4(), userId, currencyId },
        transaction: dbTransaction,
        type: QueryTypes.INSERT
      }
    );

    const wallet = await UserWallet.findOne({
      where: { userId, currencyId },
      transaction: dbTransaction
    });
    if (!wallet) throw new Error('Portefeuille introuvable après création');
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

  static async attachAndConsumeRiskAuthorization(tx, authorization, dbTransaction) {
    const metadata = {
      ...(tx.metadata || {}),
      ...transactionAuthorizationService.riskMetadata(authorization)
    };
    await tx.update({ metadata }, { transaction: dbTransaction });
    await transactionAuthorizationService.consume(authorization, tx.id, dbTransaction);
  }

  /**
   * Achat EUR : création (mint) de TWC vers l'utilisateur.
   */
  static async mintFromPurchase(userId, currencyId, pkg, paymentMethod, dbTransaction) {
    const amount = assertPositive(pkg.totalCoins, 'Quantité de pièces');
    const priceEur = roundTWC(pkg.priceEur);
    const riskAuthorization = await transactionAuthorizationService.authorize({
      userId,
      transactionKind: 'wallet_topup',
      direction: 'inbound',
      amount,
      amountEur: priceEur,
      currencyId,
      merchantId: 'twitninf_wallet',
      paymentMethod,
      itemType: 'virtual_currency',
      itemId: pkg.id
    });

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

    await this.attachAndConsumeRiskAuthorization(tx, riskAuthorization, dbTransaction);

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

    const priceEur = await this.priceEurOf(currencyId, dbTransaction);
    const isCasino = String(meta?.itemType || '').toLowerCase() === 'casino'
      && meta?.riskExemption === CASINO_RISK_EXEMPTION;
    // Autorisation obtenue en amont, AVANT tout verrou, par un appelant qui
    // enchaîne plusieurs écritures dans la même transaction (paiement
    // multi-monnaies). La redemander ici la ferait attendre les verrous déjà
    // posés — voir `INTERNAL_CONVERSION_EXEMPTION`.
    const riskAuthorization = meta?.preAuthorization
      ? meta.preAuthorization
      : isCasino
        ? { exempt: true, reason: 'casino_explicitly_excluded' }
        : await transactionAuthorizationService.authorize({
        userId,
        transactionKind: 'purchase',
        direction: 'outbound',
        amount: spend,
        amountEur: roundTWC(spend * priceEur),
        currencyId,
        counterpartyUserId: TREASURY_USER_ID,
        merchantId: meta?.itemType || 'twitninf',
        itemType: meta?.itemType || 'purchase',
        itemId: meta?.itemId || null
      });

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
        amountInEur: roundTWC(spend * priceEur),
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

    await this.attachAndConsumeRiskAuthorization(tx, riskAuthorization, dbTransaction);

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
    const priceEur = await this.priceEurOf(currencyId, dbTransaction);

    const tx = await this.createTx(
      {
        fromUserId: TREASURY_USER_ID,
        toUserId: userId,
        currencyId,
        amount: reward,
        amountInEur: roundTWC(reward * priceEur),
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
   * Taux de commission applicable à l'expéditeur d'un virement.
   *
   * Un abonnement actif (Plus ou Pro) divise la commission par deux. Le taux
   * est résolu ICI, à l'écriture, et jamais lu depuis le client : c'est de
   * l'argent, la remise doit être prouvée côté serveur au moment du débit.
   *
   * L'abonnement expiré retombe sur le taux plein sans traitement particulier —
   * `isSubscriptionActive` compare la date d'expiration à maintenant.
   */
  static async p2pFeeRateFor(userId, dbTransaction = null) {
    try {
      const user = await User.findByPk(userId, {
        attributes: ['id', 'subscription_tier', 'subscription_expires_at'],
        transaction: dbTransaction
      });
      return isSubscriptionActive(user) ? P2P_TRANSFER_FEE_RATE_SUBSCRIBER : P2P_TRANSFER_FEE_RATE;
    } catch (error) {
      // Un palier illisible ne doit pas faire échouer le virement : on retombe
      // sur le taux plein, jamais sur la remise (personne ne doit obtenir
      // gratuitement un avantage payant à la faveur d'une erreur de lecture).
      logger.warn(`Palier d'abonnement illisible pour ${userId}, commission au taux plein: ${error.message}`);
      return P2P_TRANSFER_FEE_RATE;
    }
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

    const feeRate = await this.p2pFeeRateFor(fromUserId, dbTransaction);
    const fee = roundTWC(gross * feeRate);
    const net = roundTWC(gross - fee);
    const priceEur = await this.priceEurOf(currencyId, dbTransaction);
    const riskAuthorization = await transactionAuthorizationService.authorize({
      userId: fromUserId,
      transactionKind: 'p2p_transfer',
      direction: 'outbound',
      amount: gross,
      amountEur: roundTWC(gross * priceEur),
      currencyId,
      counterpartyUserId: toUserId,
      merchantId: 'p2p'
    });

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
        amountInEur: roundTWC(net * priceEur),
        type: 'TRANSFER',
        fee,
        description: description || 'Transfert TwitCoins',
        metadata: { ledger: 'P2P', grossAmount: gross, fee }
      },
      dbTransaction
    );

    await this.attachAndConsumeRiskAuthorization(tx, riskAuthorization, dbTransaction);

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

    let feeTx = null;
    if (fee > 0) {
      // La commission doit avoir sa propre ligne de transaction : sans ça elle
      // gonflait le solde trésorerie en silence, invisible dans l'historique.
      feeTx = await this.createTx(
        {
          fromUserId,
          toUserId: TREASURY_USER_ID,
          currencyId,
          amount: fee,
          amountInEur: roundTWC(fee * priceEur),
          type: 'SYSTEM',
          description: `Commission sur transfert (${(feeRate * 100).toFixed(0)}%)`,
          metadata: { ledger: 'P2P_FEE', relatedTransactionId: tx.id, grossAmount: gross, feeRate }
        },
        dbTransaction
      );

      await treasuryWallet.update(
        {
          balance: roundTWC(toAmount(treasuryWallet.balance) + fee),
          totalEarned: roundTWC(toAmount(treasuryWallet.totalEarned) + fee)
        },
        { transaction: dbTransaction }
      );
    }

    return { tx, feeTx, fee, feeRate, netAmount: net };
  }

  /**
   * Minage (app Windows) : un mineur vient de résoudre un round de preuve de
   * travail (premier arrivé, premier servi — validé en amont par le service).
   * Mint non backé, avec plafond quotidien anti-farming et dilution du cours
   * proportionnelle à la récompense (plus la difficulté était haute, plus la
   * dilution est forte).
   */
  static async awardMiningWin(userId, currencyId, reward, difficulty, verified, dbTransaction) {
    const wallet = await this.lockWallet(userId, currencyId, dbTransaction);
    const currency = await this.getActiveCurrency(currencyId, dbTransaction);

    const now = new Date();
    const last = wallet.lastMiningDate ? new Date(wallet.lastMiningDate) : null;
    const sameDay = last && last.toDateString() === now.toDateString();
    const dailyCount = sameDay ? wallet.dailyMiningCount : 0;

    // Minage illimité pour les comptes certifiés (avantage vérifié).
    if (!verified && dailyCount >= MINING_DAILY_WIN_LIMIT) {
      const error = new Error(`Limite de minage quotidienne atteinte (${MINING_DAILY_WIN_LIMIT} rounds gagnés/jour)`);
      error.code = 'MINING_DAILY_LIMIT';
      throw error;
    }

    const tx = await this.createTx(
      {
        fromUserId: null,
        toUserId: userId,
        currencyId,
        amount: reward,
        amountInEur: roundTWC(reward * (toAmount(currency.currentPrice) || REFERENCE_PRICE_EUR)),
        type: 'MINING',
        description: `Minage TwitCoins (app Windows) — difficulté ${difficulty}`,
        metadata: { ledger: 'MINING', difficulty, dailyCount: dailyCount + 1 }
      },
      dbTransaction
    );

    await wallet.update(
      {
        balance: roundTWC(toAmount(wallet.balance) + reward),
        totalEarned: roundTWC(toAmount(wallet.totalEarned) + reward),
        lastMiningDate: now,
        dailyMiningCount: dailyCount + 1
      },
      { transaction: dbTransaction }
    );

    // Le minage est la seule création monétaire non adossée à un achat réel :
    // on dilue le cours en conséquence (contrairement aux achats, neutres pour le prix).
    const dilution = MINING_DILUTION_PER_BASE_REWARD * (reward / MINING_BASE_REWARD_TWC);
    const currentMultiplier = toAmount(currency.currentMultiplier) || 1;
    const nextMultiplier = Math.max(
      MINING_MIN_MULTIPLIER,
      Math.round(currentMultiplier * (1 - dilution) * 1e6) / 1e6
    );
    const nextPrice = roundPrice(REFERENCE_PRICE_EUR * nextMultiplier);
    const nextSupply = roundTWC(toAmount(currency.circulatingSupply) + reward);

    await currency.update(
      {
        circulatingSupply: nextSupply,
        currentMultiplier: nextMultiplier,
        currentPrice: nextPrice,
        marketCap: roundTWC(nextSupply * nextPrice)
      },
      { transaction: dbTransaction }
    );

    return {
      tx,
      reward,
      newBalance: roundTWC(toAmount(wallet.balance) + reward),
      dailyMiningCount: dailyCount + 1,
      dailyLimit: verified ? null : MINING_DAILY_WIN_LIMIT,
      currentPrice: nextPrice,
      priceMultiplier: nextMultiplier
    };
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

  /**
   * Ajustement admin par DELTA relatif au solde actuel (positif = crédit,
   * négatif = débit) — PAS un solde absolu. Historiquement le panel admin
   * appelait adminSetBalance en lui passant directement la valeur saisie
   * ("négatif pour retirer"), mais adminSetBalance fixe un solde CIBLE : taper
   * "32000" pour "retirer 32000 NF" fixait le solde À 32000, ce qui CRÉDITAIT
   * le compte si son solde réel était plus bas — un admin a ainsi doublé un
   * solde frauduleux au lieu de le retirer. Cette méthode calcule elle-même
   * la cible (solde actuel + delta) pour que le champ se comporte comme promis.
   */
  static async adminAdjustBalance(userId, currencyId, delta, reason, dbTransaction) {
    const wallet = await this.lockWallet(userId, currencyId, dbTransaction);
    const current = toAmount(wallet.balance);
    const target = roundTWC(current + Number(delta));
    if (target < 0) {
      throw new Error('Le retrait dépasse le solde actuel du compte');
    }
    return this.adminSetBalance(userId, currencyId, target, reason, dbTransaction);
  }

  static async adminSetBalance(userId, currencyId, targetBalance, reason, dbTransaction) {
    if (userId === TREASURY_USER_ID) {
      // La branche débit ci-dessous verrouille ET met à jour le portefeuille
      // trésorerie une SECONDE fois en plus du portefeuille "utilisateur" — si
      // userId est déjà la trésorerie, c'est la MÊME ligne chargée deux fois,
      // et la deuxième écriture écrase silencieusement la première (perte de
      // mise à jour). Ne jamais cibler la trésorerie via cet outil.
      throw new Error('Impossible d\'ajuster le solde de la trésorerie via cet outil');
    }
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

  /**
   * Échange interne entre deux portefeuilles du MÊME utilisateur (ex: NF <->
   * EUR) : débite `fromCurrencyId`, crédite `toCurrencyId` selon `rate`
   * (nombre d'unités `to` obtenues pour 1 unité `from`). Aucune trésorerie
   * impliquée — ce n'est pas une dépense ni une récompense, juste un
   * changement d'unité sur la même valeur détenue par le même compte.
   */
  static async exchangeCurrency(userId, fromCurrencyId, toCurrencyId, amount, rate, dbTransaction, extraMetadata = {}) {
    const debit = assertPositive(amount, 'Montant');
    if (fromCurrencyId === toCurrencyId) {
      throw new Error('Impossible d\'échanger une monnaie contre elle-même');
    }
    if (!(Number(rate) > 0)) {
      throw new Error('Taux de change invalide');
    }
    const sourcePriceEur = await this.priceEurOf(fromCurrencyId, dbTransaction);
    // Conversion interne d'un paiement déjà autorisé : on ne redemande pas une
    // autorisation qui se bloquerait sur nos propres verrous (voir
    // `INTERNAL_CONVERSION_EXEMPTION`).
    const riskAuthorization = extraMetadata?.riskExemption === INTERNAL_CONVERSION_EXEMPTION
      ? { exempt: true, reason: 'internal_conversion_of_authorized_payment' }
      : await transactionAuthorizationService.authorize({
        userId,
        transactionKind: 'currency_exchange',
        direction: 'outbound',
        amount: debit,
        amountEur: roundTWC(debit * sourcePriceEur),
        currencyId: fromCurrencyId,
        merchantId: 'internal_exchange',
        itemType: 'currency_exchange',
        itemId: toCurrencyId
      });

    const fromWallet = await this.lockWallet(userId, fromCurrencyId, dbTransaction);
    const fromBalance = toAmount(fromWallet.balance);
    if (fromBalance < debit) {
      throw new Error('Solde insuffisant');
    }

    const toWallet = await this.lockWallet(userId, toCurrencyId, dbTransaction);
    const credit = roundTWC(debit * Number(rate));
    const newFromBalance = roundTWC(fromBalance - debit);
    const newToBalance = roundTWC(toAmount(toWallet.balance) + credit);

    await fromWallet.update(
      { balance: newFromBalance, totalSpent: roundTWC(toAmount(fromWallet.totalSpent) + debit) },
      { transaction: dbTransaction }
    );
    await toWallet.update(
      { balance: newToBalance, totalEarned: roundTWC(toAmount(toWallet.totalEarned) + credit) },
      { transaction: dbTransaction }
    );

    const txOut = await this.createTx(
      {
        fromUserId: userId,
        toUserId: userId,
        currencyId: fromCurrencyId,
        amount: debit,
        amountInEur: roundTWC(debit * sourcePriceEur),
        type: 'SYSTEM',
        description: 'Échange interne — conversion sortante',
        // `rate` est un ratio entre les DEUX monnaies de cet échange précis
        // (ex. KOSP-par-NF sur un achat contre NF, KOSP-par-EUR sur un achat
        // contre EUR) — pas un prix EUR absolu, et pas comparable d'un
        // échange à l'autre si le contrepartie change. `extraMetadata` (ex.
        // `priceEur` passé par convertUserCurrency) porte le prix EUR réel et
        // absolu de la monnaie communautaire au moment de CET échange — c'est
        // lui que la courbe de getCurrencyDetail doit lire, pas `rate`.
        metadata: { ledger: 'EXCHANGE', direction: 'out', rate: Number(rate), pairCurrencyId: toCurrencyId, ...extraMetadata }
      },
      dbTransaction
    );
    await this.attachAndConsumeRiskAuthorization(txOut, riskAuthorization, dbTransaction);
    const txIn = await this.createTx(
      {
        fromUserId: userId,
        toUserId: userId,
        currencyId: toCurrencyId,
        amount: credit,
        type: 'SYSTEM',
        description: 'Échange interne — conversion entrante',
        metadata: { ledger: 'EXCHANGE', direction: 'in', rate: Number(rate), pairCurrencyId: fromCurrencyId, pairTransactionId: txOut.id, ...extraMetadata }
      },
      dbTransaction
    );

    // Impact de marché : la monnaie ACHETÉE (to) monte, la monnaie VENDUE
    // (from) baisse. C'est le sens de n'importe quel marché — la demande fait
    // monter le prix — et celui d'un pool de liquidité : l'échange retire du
    // `to` du pool (il se raréfie, donc se renchérit) et y ajoute du `from`
    // (il devient plus abondant, donc se déprécie).
    //
    // Ce sens était INVERSÉ : acheter une monnaie faisait baisser son cours et
    // vendre le faisait monter. Le raisonnement d'origine (« la monnaie
    // achetée entre en circulation, donc se dilue ») confond l'offre émise
    // avec la demande : sur un marché, ce qui fixe le prix c'est la pression
    // d'achat, pas le nombre d'unités qui changent de main. Concrètement,
    // acheter massivement une monnaie communautaire la faisait s'effondrer,
    // et personne ne pouvait faire monter la sienne autrement qu'en la
    // vendant.
    await this._applyExchangePriceImpact(fromCurrencyId, debit, 'decrease', dbTransaction);
    await this._applyExchangePriceImpact(toCurrencyId, credit, 'increase', dbTransaction);

    return { txOut, txIn, debited: debit, credited: credit, fromBalance: newFromBalance, toBalance: newToBalance };
  }

  /**
   * Déplace currentMultiplier d'une monnaie suite à un échange, proportionnellement
   * à la part de son offre en circulation qui vient de bouger. `impactBase` est borné
   * à `max(offre, montant)` : sur une monnaie tout juste créée (offre nulle, ex. le
   * tout premier échange NF -> EUR), ça plafonne l'impact à EXCHANGE_PRICE_IMPACT_FACTOR
   * au lieu d'une division par (quasi) zéro qui enverrait le multiplicateur droit à sa borne.
   *
   * L'offre utilisée est la VRAIE circulation (somme des soldes), pas la colonne
   * `circulatingSupply` : cette colonne n'est mise à jour que par le minage et
   * par `EconomyMetrics.refresh()`, jamais par un échange (`exchangeCurrency`,
   * le seul chemin des monnaies communautaires) — elle reste donc figée à
   * l'offre initiale (1 000 000 unités) pour une monnaie qui ne vit que
   * d'échanges.
   *
   * L'impact suit sqrt(montant / offre), pas une simple proportion linéaire :
   * avec une offre initiale d'1 000 000 d'unités, un échange "normal" (ex.
   * quelques centaines à quelques milliers d'unités, soit <0.1 % de l'offre)
   * ne déplaçait le cours que d'une fraction de pourcent avec une formule
   * linéaire — invisible en pratique, d'où l'impression que convertir des
   * NF/EUR contre une monnaie communautaire n'affecte jamais son cours.
   * sqrt() donne un poids disproportionné aux petits échanges (ex. 1 % de
   * l'offre → 10 % de l'impact max au lieu de 1 %) sans changer le plafond :
   * un échange qui porte sur 100 % de l'offre déplace toujours le cours d'au
   * plus EXCHANGE_PRICE_IMPACT_FACTOR, comme avant.
   */
  static async _applyExchangePriceImpact(currencyId, amount, direction, dbTransaction) {
    if (!(amount > 0)) return;
    const currency = await this.getActiveCurrency(currencyId, dbTransaction);

    // L'EUR interne est un portefeuille de valeur STABLE : 1 unité = 1 €,
    // toujours, par construction (voir economy/eurCurrency.js). Il n'a pas de
    // marché, donc aucun échange ne doit déplacer son cours. Sans cette
    // garde, chaque conversion NF <-> EUR poussait son multiplicateur et son
    // prix s'est retrouvé à 0,85 € en production — tous les soldes EUR
    // affichés valaient alors 15 % de moins que les euros qu'ils
    // représentent, et `convertUserCurrency` (qui force à juste titre le taux
    // à 1) se retrouvait en contradiction avec le prix stocké.
    if (String(currency.symbol).toUpperCase() === 'EUR') return;

    const [{ total }] = await sequelize.query(
      `SELECT COALESCE(SUM(balance), 0)::float8 AS total FROM user_wallets WHERE currency_id = :currencyId`,
      { type: QueryTypes.SELECT, replacements: { currencyId }, transaction: dbTransaction }
    );
    const supply = toAmount(total);
    const impactBase = Math.max(supply, amount);
    const impact = EXCHANGE_PRICE_IMPACT_FACTOR * Math.sqrt(amount / impactBase);
    const currentMultiplier = toAmount(currency.currentMultiplier) || 1;
    const rawMultiplier = direction === 'increase'
      ? currentMultiplier * (1 + impact)
      : currentMultiplier * (1 - impact);
    const nextMultiplier = Math.min(
      EXCHANGE_PRICE_MAX_MULTIPLIER,
      Math.max(EXCHANGE_PRICE_MIN_MULTIPLIER, Math.round(rawMultiplier * 1e6) / 1e6)
    );
    const basePriceEur = toAmount(currency.basePrice) || REFERENCE_PRICE_EUR;
    await currency.update(
      { currentMultiplier: nextMultiplier, currentPrice: roundPrice(basePriceEur * nextMultiplier) },
      { transaction: dbTransaction }
    );
  }

  /**
   * Retrait de fonds jugés frauduleux : sort le montant frauduleux de la
   * circulation utilisateur vers la trésorerie (comme un débit admin, mais
   * tagué séparément pour l'audit) — le compte fraudeur ne peut plus le
   * dépenser, et il ne sort pas non plus par un mécanisme de récompense
   * ordinaire tant qu'un admin ne le redistribue pas explicitement.
   *
   * `amount` est le montant à retirer, PAS le solde entier du compte : cet
   * outil servait auparavant à vider tout le portefeuille quel que soit le
   * montant réellement identifié comme frauduleux par le scan (fraudScanService),
   * ce qui confisquait aussi les fonds légitimes d'un compte par ailleurs
   * flaggé pour un seul signal portant sur une petite somme. `amount` est
   * fourni par l'appelant (typiquement `suggestedBurnAmount` du scan,
   * éventuellement ajusté par l'admin) — jamais déduit du solde ici. On
   * plafonne quand même à ce qui est réellement disponible : si le compte a
   * déjà dépensé une partie des fonds visés, on ne peut retirer que ce qui
   * reste.
   */
  static async burnFraudulent(userId, currencyId, amount, reason, dbTransaction) {
    if (userId === TREASURY_USER_ID) {
      // Même piège que adminSetBalance : verrouiller + mettre à jour la même
      // ligne deux fois (une fois comme "compte", une fois comme "trésorerie")
      // écrase silencieusement la première écriture.
      throw new Error('Impossible de retirer les fonds de la trésorerie via cet outil');
    }
    const requested = assertPositive(amount, 'Montant à retirer');

    const wallet = await this.lockWallet(userId, currencyId, dbTransaction);
    const current = toAmount(wallet.balance);
    if (current <= 0) {
      return { tx: null, amount: 0 };
    }

    const toBurn = roundTWC(Math.min(requested, current));
    if (toBurn <= 0) {
      return { tx: null, amount: 0 };
    }

    const treasuryWallet = await this.lockWallet(TREASURY_USER_ID, currencyId, dbTransaction);
    await wallet.update({ balance: roundTWC(current - toBurn) }, { transaction: dbTransaction });
    await treasuryWallet.update(
      { balance: roundTWC(toAmount(treasuryWallet.balance) + toBurn) },
      { transaction: dbTransaction }
    );

    const tx = await this.createTx(
      {
        fromUserId: userId,
        toUserId: TREASURY_USER_ID,
        currencyId,
        amount: toBurn,
        type: 'SYSTEM',
        description: `[Anti-fraude] ${reason || 'Retrait de NF frauduleux'}`,
        metadata: { ledger: 'FRAUD_BURN', reason: reason || null, requestedAmount: requested }
      },
      dbTransaction
    );

    return { tx, amount: toBurn, remainingBalance: roundTWC(current - toBurn) };
  }
}

EconomyLedger.CASINO_RISK_EXEMPTION = CASINO_RISK_EXEMPTION;
module.exports = EconomyLedger;
module.exports.INTERNAL_CONVERSION_EXEMPTION = INTERNAL_CONVERSION_EXEMPTION;
