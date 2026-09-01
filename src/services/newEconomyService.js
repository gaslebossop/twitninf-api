const { VirtualCurrency, UserWallet, Transaction, User, MiningRound } = require('../models');
const { sequelize } = require('../database/index');
const logger = require('../utils/logger');
const {
  PURCHASE_PACKAGES,
  REFERENCE_PRICE_EUR,
  TREASURY_USER_ID,
  MINING_BASE_REWARD_TWC,
  MINING_GPU_DIFFICULTY_FACTOR,
  MINING_GPU_REWARD_FACTOR
} = require('../economy/constants');
const { roundTWC, toAmount, computePackageCoins } = require('../economy/money');
const EconomyLedger = require('../economy/ledger');
const EconomyMetrics = require('../economy/metrics');
const Pow = require('../economy/pow');
const { CHART_RANGES, resolveChartRange } = require('../economy/chartRanges');

/**
 * API économique TwitCoins — monnaie fermée plateforme.
 * Achat = mint | Dépense → trésorerie | Récompense ← trésorerie
 */
class NewEconomyService {
  static async _findOrCreateWallet(userId, currencyId, transaction = null) {
    return EconomyLedger.findOrCreateWallet(userId, currencyId, transaction);
  }

  static async ensureWalletsForUser(userId, externalTransaction = null) {
    if (!userId) return { ensured: 0 };

    // Appelé à chaque lecture de portefeuille : on vérifie d'abord ce qui
    // existe déjà (cas quasi systématique après la première visite) au lieu
    // de retenter un findOrCreate à chaque fois — ça évite l'essentiel des
    // courses concurrentes sur le portefeuille trésorerie partagé, et toute
    // écriture reste dans une vraie transaction pour ne jamais laisser une
    // connexion du pool dans un état "transaction avortée" (Postgres 25P02).
    const dbTransaction = externalTransaction || (await sequelize.transaction());
    const shouldCommit = !externalTransaction;

    try {
      const currencies = await VirtualCurrency.findAll({
        where: { isActive: true },
        attributes: ['id'],
        transaction: dbTransaction
      });

      if (currencies.length === 0) {
        if (shouldCommit) await dbTransaction.commit();
        return { ensured: 0 };
      }

      const currencyIds = currencies.map((c) => c.id);
      const existing = await UserWallet.findAll({
        where: {
          userId: [userId, TREASURY_USER_ID],
          currencyId: currencyIds
        },
        attributes: ['userId', 'currencyId'],
        transaction: dbTransaction
      });
      const existingKeys = new Set(existing.map((w) => `${w.userId}:${w.currencyId}`));

      let ensured = 0;
      for (const c of currencies) {
        if (!existingKeys.has(`${userId}:${c.id}`)) {
          await EconomyLedger.findOrCreateWallet(userId, c.id, dbTransaction);
          ensured++;
        }
      }
      const treasuryCurrencyId = currencies[0].id;
      if (!existingKeys.has(`${TREASURY_USER_ID}:${treasuryCurrencyId}`)) {
        await EconomyLedger.findOrCreateWallet(TREASURY_USER_ID, treasuryCurrencyId, dbTransaction);
      }

      if (shouldCommit) await dbTransaction.commit();
      return { ensured };
    } catch (error) {
      if (shouldCommit) await dbTransaction.rollback();
      throw error;
    }
  }

  static _resolvePackage(pkgDef, promoBonusFraction = 0) {
    const bonusCoins =
      computePackageCoins(pkgDef.baseCoins, pkgDef.bonusPercent, promoBonusFraction) -
      pkgDef.baseCoins;
    const totalCoins = pkgDef.baseCoins + bonusCoins;
    return {
      id: pkgDef.id,
      name: pkgDef.name,
      coins: pkgDef.baseCoins,
      price: pkgDef.priceEur,
      popular: pkgDef.popular,
      originalPrice: pkgDef.priceEur,
      currentPrice: pkgDef.priceEur.toFixed(2),
      priceEur: pkgDef.priceEur,
      bonusCoins,
      totalCoins,
      savings: pkgDef.bonusPercent,
      pricePerCoin: (pkgDef.priceEur / totalCoins).toFixed(4)
    };
  }

  static async getPurchasePackages(currencyId) {
    const currency = await EconomyLedger.getActiveCurrency(currencyId);
    const promo = Math.max(0, toAmount(currency.purchaseBonus));

    const packages = PURCHASE_PACKAGES.map((p) => this._resolvePackage(p, promo));

    return {
      packages,
      economicStatus: {
        trend: currency.economicTrend || 'stable',
        multiplier: 1.0,
        bonus: roundTWC(promo * 100),
        referencePriceEur: REFERENCE_PRICE_EUR,
        activePromotion: promo > 0
      }
    };
  }

  static async purchaseCoins(userId, currencyId, packageId, paymentMethod) {
    const dbTransaction = await sequelize.transaction();
    try {
      const currency = await EconomyLedger.getActiveCurrency(currencyId, dbTransaction);
      const promo = Math.max(0, toAmount(currency.purchaseBonus));
      const pkgDef = PURCHASE_PACKAGES.find((p) => p.id === packageId);
      if (!pkgDef) {
        throw new Error('Package non trouvé');
      }
      const selectedPackage = this._resolvePackage(pkgDef, promo);

      const { tx, wallet } = await EconomyLedger.mintFromPurchase(
        userId,
        currencyId,
        selectedPackage,
        paymentMethod,
        dbTransaction
      );

      await EconomyMetrics.refresh(currencyId, dbTransaction);
      await dbTransaction.commit();

      logger.info(
        `Achat: ${selectedPackage.totalCoins} TWC (${selectedPackage.currentPrice}€) user=${userId}`
      );

      return {
        transaction: tx,
        wallet,
        package: selectedPackage
      };
    } catch (error) {
      await dbTransaction.rollback();
      logger.error('Erreur achat TWC:', error);
      throw error;
    }
  }

  static async getUserWallet(currencyId, userId, dbTransaction = null) {
    const currency = await EconomyLedger.getActiveCurrency(currencyId, dbTransaction);
    const wallet = await EconomyLedger.findOrCreateWallet(userId, currencyId, dbTransaction);
    const treasury = await EconomyMetrics.getTreasuryBalance(currencyId, dbTransaction);

    return {
      wallet: {
        id: wallet.id,
        balance: toAmount(wallet.balance),
        totalEarned: toAmount(wallet.totalEarned),
        totalSpent: toAmount(wallet.totalSpent),
        totalPurchased: toAmount(wallet.totalPurchased),
        loyaltyPoints: wallet.loyaltyPoints || 0,
        lastPurchaseDate: wallet.lastPurchaseDate
      },
      currency: {
        id: currency.id,
        name: currency.name,
        symbol: currency.symbol,
        // Le prix RÉEL de la monnaie (currentPrice/basePrice/currentMultiplier
        // sont déjà chargés sur `currency`, via getActiveCurrency ci-dessus) —
        // avant ce correctif, ces trois champs étaient remplacés par la
        // constante REFERENCE_PRICE_EUR figée, donc le portefeuille affichait
        // un prix qui n'avait plus rien à voir avec le taux réel de la
        // monnaie une fois le minage l'ayant fait diverger de la référence.
        currentPrice: toAmount(currency.currentPrice),
        basePrice: toAmount(currency.basePrice),
        multiplier: toAmount(currency.currentMultiplier),
        trend: currency.economicTrend || 'stable',
        volume24h: toAmount(currency.volume24h),
        marketCap: toAmount(currency.marketCap),
        priceChange24h: toAmount(currency.priceChange24h),
        treasuryReserve: treasury
      }
    };
  }

  static async spendCoins(
    userId,
    currencyId,
    amount,
    itemType,
    itemId,
    description,
    externalTransaction = null
  ) {
    const dbTransaction = externalTransaction || (await sequelize.transaction());
    const shouldCommit = !externalTransaction;

    try {
      await EconomyLedger.getActiveCurrency(currencyId, dbTransaction);
      const result = await EconomyLedger.spendToTreasury(
        userId,
        currencyId,
        amount,
        {
          description,
          itemType,
          itemId,
          spendingCategory: this.getSpendingCategory(itemType),
          metadata: {}
        },
        dbTransaction
      );

      if (shouldCommit) {
        await EconomyMetrics.refresh(currencyId, dbTransaction);
        await dbTransaction.commit();
      }

      logger.info(`Dépense: ${amount} TWC user=${userId} — ${description}`);
      return {
        transaction: result.tx,
        transactionHash: result.tx.transactionHash,
        wallet: result.wallet,
        remainingBalance: result.remainingBalance
      };
    } catch (error) {
      if (shouldCommit) await dbTransaction.rollback();
      logger.caught('Erreur dépense TWC:', error);
      throw error;
    }
  }

  static async rewardUser(
    userId,
    currencyId,
    amount,
    description = 'Récompense créateur',
    externalTransaction = null
  ) {
    const dbTransaction = externalTransaction || (await sequelize.transaction());
    const shouldCommit = !externalTransaction;

    try {
      const result = await EconomyLedger.rewardFromTreasury(
        userId,
        currencyId,
        amount,
        description,
        dbTransaction
      );

      if (!result.success) {
        if (shouldCommit) await dbTransaction.rollback();
        logger.warn(`Récompense refusée: ${amount} → user=${userId} (${result.reason || 'raison inconnue'})`);
        return { success: false, reason: result.reason || 'Récompense refusée' };
      }

      if (shouldCommit) {
        await EconomyMetrics.refresh(currencyId, dbTransaction);
        await dbTransaction.commit();
      }

      logger.info(`Récompense: ${amount} → user=${userId}`);
      return { success: true, reward: amount, transaction: result.tx };
    } catch (error) {
      if (shouldCommit) await dbTransaction.rollback();
      logger.error('Erreur récompense TWC:', error);
      throw error;
    }
  }

  /** Portefeuilles de l'utilisateur pour TOUTES les monnaies actives (NF, EUR interne...), pas une seule. */
  static async getAllWallets(userId) {
    const currencies = await VirtualCurrency.findAll({ where: { isActive: true }, order: [['createdAt', 'ASC']] });
    return Promise.all(currencies.map((c) => this.getUserWallet(c.id, userId)));
  }

  static async exchangeCurrency(userId, fromCurrencyId, toCurrencyId, amount, rate) {
    const dbTransaction = await sequelize.transaction();
    try {
      const result = await EconomyLedger.exchangeCurrency(userId, fromCurrencyId, toCurrencyId, amount, rate, dbTransaction);
      // EUR interne : jamais de refresh() ici (voir metrics.js et eurCurrency.js)
      // sur la monnaie CIBLE si elle n'a pas de circulation à recalculer utile —
      // en pratique refresh() est maintenant sûr pour n'importe quelle monnaie
      // (basePrice propre à chaque ligne), donc on rafraîchit bien les deux.
      await EconomyMetrics.refresh(fromCurrencyId, dbTransaction);
      await EconomyMetrics.refresh(toCurrencyId, dbTransaction);
      await dbTransaction.commit();
      return result;
    } catch (error) {
      await dbTransaction.rollback();
      throw error;
    }
  }

  static async transferCoins(fromUserId, toUserId, currencyId, amount, description) {
    const dbTransaction = await sequelize.transaction();
    try {
      const result = await EconomyLedger.transferP2P(
        fromUserId,
        toUserId,
        currencyId,
        amount,
        description,
        dbTransaction
      );
      await EconomyMetrics.refresh(currencyId, dbTransaction);
      await dbTransaction.commit();
      return result;
    } catch (error) {
      await dbTransaction.rollback();
      throw error;
    }
  }

  /**
   * Renvoie le round de minage ouvert pour ce moteur (le crée s'il n'y en a
   * pas / s'il a expiré). CPU et GPU ont chacun leur propre pool : sinon le
   * GPU, bien plus rapide, raflerait systématiquement tous les blocs CPU.
   */
  static async getOrCreateMiningRound(currencyId, engineType = 'cpu') {
    const now = new Date();

    const existing = await MiningRound.findOne({
      where: { currencyId, engineType, status: 'open' },
      order: [['createdAt', 'DESC']]
    });

    if (existing && existing.expiresAt > now) {
      return existing;
    }

    if (existing && existing.expiresAt <= now) {
      await existing.update({ status: 'expired' });
    }

    const difficulty = Pow.randomDifficulty();
    const baseTarget = Pow.targetForDifficulty(difficulty);
    const baseReward = Pow.rewardForDifficulty(difficulty, MINING_BASE_REWARD_TWC);
    const isGpu = engineType === 'gpu';

    const round = await MiningRound.create({
      currencyId,
      challenge: Pow.randomChallenge(),
      difficulty,
      target: isGpu ? Pow.scaleTarget(baseTarget, MINING_GPU_DIFFICULTY_FACTOR) : baseTarget,
      reward: isGpu ? roundTWC(baseReward * MINING_GPU_REWARD_FACTOR) : baseReward,
      engineType,
      status: 'open',
      expiresAt: new Date(now.getTime() + Pow.ROUND_TTL_MS)
    });

    return round;
  }

  /**
   * Un mineur soumet un nonce candidat. Premier valide accepté = gagnant ;
   * les suivants sur le même round sont rejetés (round déjà résolu).
   */
  static async submitMiningProof(userId, currencyId, roundId, nonce) {
    const dbTransaction = await sequelize.transaction();
    try {
      const round = await MiningRound.findOne({
        where: { id: roundId, currencyId },
        lock: dbTransaction.LOCK.UPDATE,
        transaction: dbTransaction
      });

      if (!round) {
        const error = new Error('Round de minage introuvable');
        error.code = 'ROUND_NOT_FOUND';
        throw error;
      }

      if (round.status !== 'open' || round.expiresAt <= new Date()) {
        const error = new Error('Ce round a déjà été résolu par un autre mineur');
        error.code = 'ROUND_TAKEN';
        throw error;
      }

      const hash = Pow.sha256Hex(`${round.challenge}:${nonce}`);
      if (!Pow.hashMeetsTarget(hash, Number(round.target))) {
        const error = new Error('Preuve de travail invalide');
        error.code = 'INVALID_PROOF';
        throw error;
      }

      await round.update(
        { status: 'solved', winnerUserId: userId, winningNonce: String(nonce), solvedAt: new Date() },
        { transaction: dbTransaction }
      );

      const user = await User.findByPk(userId, { attributes: ['id', 'verified'], transaction: dbTransaction });
      const reward = toAmount(round.reward);
      const result = await EconomyLedger.awardMiningWin(userId, currencyId, reward, round.difficulty, Boolean(user?.verified), dbTransaction);
      await EconomyMetrics.refresh(currencyId, dbTransaction);
      await dbTransaction.commit();

      const nextRound = await this.getOrCreateMiningRound(currencyId, round.engineType);
      return { ...result, difficulty: round.difficulty, engineType: round.engineType, nextRound };
    } catch (error) {
      await dbTransaction.rollback();
      throw error;
    }
  }

  static async getEconomicStats(currencyId, { range } = {}) {
    const currency = await VirtualCurrency.findByPk(currencyId);
    if (!currency) {
      throw new Error('Monnaie introuvable');
    }
    const metrics = await EconomyMetrics.refresh(currencyId);
    await currency.reload();
    const rangeKey = resolveChartRange(range);
    return EconomyMetrics.buildPublicStats(currency, metrics, { rangeHours: CHART_RANGES[rangeKey].hours });
  }

  static getSpendingCategory(itemType) {
    const categories = {
      boost_visibility: 'Promotion',
      super_like: 'Interaction',
      badge: 'Cosmétique',
      premium_feature: 'Fonctionnalité',
      subscription_purchase: 'Abonnement',
      gift: 'Social',
      ad_campaign: 'Publicité'
    };
    return categories[itemType] || 'Autre';
  }

  static async getPurchaseLeaderboard(currencyId, limit = 50) {
    const leaderboard = await UserWallet.findAll({
      where: {
        currencyId,
        userId: { [require('sequelize').Op.ne]: TREASURY_USER_ID }
      },
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['username', 'avatar', 'verified']
        }
      ],
      order: [['totalPurchased', 'DESC']],
      limit
    });

    return leaderboard.map((wallet, index) => ({
      rank: index + 1,
      user: {
        id: wallet.userId,
        username: wallet.user?.username,
        profilePicture: wallet.user?.avatar,
        isVerified: wallet.user?.verified
      },
      totalPurchased: toAmount(wallet.totalPurchased),
      currentBalance: toAmount(wallet.balance),
      loyaltyPoints: wallet.loyaltyPoints,
      joinDate: wallet.createdAt
    }));
  }

  /** Compat : ancien hook post-achat — délégué aux métriques */
  static async updateEconomicMetrics(currencyId) {
    return EconomyMetrics.refresh(currencyId);
  }
}

module.exports = NewEconomyService;
