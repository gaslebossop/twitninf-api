/**
 * Monétisation des créateurs — conditions d'accès et façade du pot hebdomadaire.
 *
 * Ce service ne calcule PLUS de récompense. Le modèle linéaire par tweet
 * (`0,01 NF la vue, 0,05 le like`…) a été remplacé le 2026-08-20 par un
 * partage de pot : voir `economy/creatorPool/`. Ce qui reste ici, ce sont les
 * deux choses qui n'appartiennent pas au calcul :
 *
 *   - **qui a le droit d'être payé** (`isAuthorMonetizable` et compagnie),
 *     interrogé depuis plusieurs endroits de l'API ;
 *   - **une façade stable** (`previewEarnings`, `collectEarnings`) pour les
 *     appelants qui veulent « mes gains en attente » et « encaisse-les » sans
 *     connaître la mécanique des périodes.
 *
 * Ce qui a disparu, et pourquoi :
 *
 *   - `calculateTweetEligibility` / `calculateTweetReward` / les tables de
 *     taux : un tweet n'a plus de prix propre. Sa contribution dépend du
 *     vivier de la semaine, elle ne peut pas se calculer tweet par tweet.
 *   - `distributeReward` : le versement est devenu l'encaissement d'une part
 *     GELÉE à la clôture. Plus rien ne se recalcule au moment de payer, ce
 *     qui était la source des montants incohérents.
 *   - `resetTweetCounters` : il remettait `view_count` à zéro après paiement,
 *     ce qui détruisait les statistiques créateur et faussait le classement
 *     algorithmique. Il n'a plus de raison d'être : les périodes bornent les
 *     ÉVÉNEMENTS, aucun compteur n'est touché — et c'est aussi ce qui fait
 *     qu'un tweet continue de rapporter les semaines suivantes.
 */

const { sequelize } = require('../database/index');
const { UserWallet, User } = require('../models');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const { isSubscriptionActive } = require('../utils/subscriptionHelpers');
const creatorPool = require('../economy/creatorPool');
const logger = require('../utils/logger');

class TweetMonetizationService {
  /** Message unique — la raison affichée doit être la même partout. */
  static PREMIUM_REQUIRED_REASON =
    'La monétisation est réservée aux abonnements Plus et Pro';
  static PROGRAM_REQUIRED_REASON =
    'La monétisation nécessite d\'être accepté dans le programme de monétisation';

  /**
   * L'auteur a-t-il le droit d'être payé ?
   *
   * ⚠ On relit l'abonnement EN BASE plutôt que de croire un objet passé par
   * l'appelant : `isSubscriptionActive` a besoin de `subscription_tier` ET de
   * `subscription_expires_at`, et la plupart des `include` de l'app ne
   * chargent ni l'un ni l'autre. Un auteur partiellement chargé passerait
   * alors pour un compte gratuit — ou pire, un abonnement expiré passerait
   * pour actif.
   *
   * @param {string|object} author id ou instance utilisateur
   */
  static async isAuthorMonetizable(author) {
    const id = typeof author === 'object' && author ? author.id : author;
    if (!id) return false;
    const user = await User.findByPk(id, {
      attributes: ['id', 'subscription_tier', 'subscription_expires_at', 'monetization_program_status'],
    });
    return this.isUserRecordMonetizable(user);
  }

  /**
   * Même règle, à partir d'une instance déjà chargée — évite un aller-retour
   * DB quand l'appelant a déjà l'auteur en main. Abonnement actif ET programme
   * de monétisation accepté sont TOUS LES DEUX requis.
   */
  static isUserRecordMonetizable(user) {
    return isSubscriptionActive(user) && user?.monetization_program_status === 'approved';
  }

  /** Pourquoi ce compte ne touche rien, en priorisant l'abonnement (première marche). */
  static reasonForUserRecord(user) {
    if (!isSubscriptionActive(user)) return this.PREMIUM_REQUIRED_REASON;
    if (user?.monetization_program_status !== 'approved') return this.PROGRAM_REQUIRED_REASON;
    return null;
  }

  static async reasonForUserId(userId) {
    if (!userId) return this.PREMIUM_REQUIRED_REASON;
    const user = await User.findByPk(userId, {
      attributes: ['id', 'subscription_tier', 'subscription_expires_at', 'monetization_program_status'],
    });
    return this.reasonForUserRecord(user);
  }

  /**
   * Gains en attente d'un créateur.
   *
   * « En attente » a changé de sens et c'est volontaire : ce n'est plus une
   * estimation recalculée à chaque appel, mais la somme des parts DÉJÀ FIGÉES
   * par les clôtures passées. Deux appels successifs donnent le même chiffre,
   * et ce chiffre est exactement celui qui sera versé.
   *
   * `projection` porte, à part, ce que la semaine EN COURS rapporterait si
   * elle s'arrêtait maintenant — utile à afficher, jamais encaissable.
   */
  static async previewEarnings(userId) {
    const dashboard = await creatorPool.getDashboard(userId);
    const monetizable = await this.isAuthorMonetizable(userId);

    const currency = await getPlatformCurrency();
    const wallet = currency
      ? await UserWallet.findOne({ where: { userId, currencyId: currency.id } })
      : null;
    const currentBalance = wallet ? parseFloat(wallet.balance) : 0;

    return {
      claimableTotal: dashboard.claimable.total,
      claimablePeriods: dashboard.claimable.periods,
      currentBalance,
      newBalance: currentBalance + dashboard.claimable.total,
      projection: dashboard.currentPeriod.projection,
      currentPeriodKey: dashboard.currentPeriod.key,
      monetizable,
      lockedReason: monetizable ? null : await this.reasonForUserId(userId),
      currency: dashboard.currency,
    };
  }

  /**
   * Encaisse toutes les parts figées qui attendent.
   *
   * Idempotent par construction : chaque part passe de `claimable` à
   * `claimed` sous verrou de ligne, donc un double appel ne verse pas deux
   * fois — il renvoie simplement zéro la seconde fois.
   */
  static async collectEarnings(userId) {
    if (!(await this.isAuthorMonetizable(userId))) {
      const reason = await this.reasonForUserId(userId);
      logger.info(`🔒 Encaissement refusé pour ${userId} (${reason})`);
      return { totalCollected: 0, periodsCollected: 0, locked: true, reason };
    }

    const payouts = await creatorPool.listPayouts(userId, { limit: 52 });
    const claimable = payouts.filter((p) => p.status === 'claimable');

    let totalCollected = 0;
    let periodsCollected = 0;
    for (const payout of claimable) {
      const result = await creatorPool.claim(userId, payout.period_key);
      if (result.success) {
        totalCollected += result.amount;
        periodsCollected += 1;
      } else {
        logger.warn(`[creatorPool] ${userId}/${payout.period_key} non encaissé: ${result.reason}`);
      }
    }

    return { totalCollected, periodsCollected };
  }

  /**
   * Statistiques d'ensemble de l'économie créateur, pour les tableaux de bord
   * d'administration.
   */
  static async getMonetizationStats() {
    try {
      const currency = await getPlatformCurrency();
      if (!currency) throw new Error('Monnaie de plateforme introuvable');

      const wallets = await UserWallet.findAll({
        where: { currencyId: currency.id },
        attributes: ['totalEarned', 'totalPurchased', 'totalSpent', 'loyaltyPoints'],
      });

      const sum = (key) => wallets.reduce((acc, w) => acc + parseFloat(w[key] || 0), 0);

      const [payoutStats] = await sequelize.query(
        `SELECT COUNT(*) AS total_payouts,
                COALESCE(SUM(amount), 0) AS total_amount,
                COALESCE(AVG(amount), 0) AS avg_amount,
                COUNT(*) FILTER (WHERE status = 'claimable') AS pending_payouts
         FROM creator_payouts`,
        { type: sequelize.QueryTypes.SELECT }
      ).catch(() => [{}]);

      return {
        currency: {
          symbol: currency.symbol,
          name: currency.name,
          circulatingSupply: parseFloat(currency.circulatingSupply),
          currentPrice: parseFloat(currency.currentPrice),
        },
        wallets: {
          totalUsers: wallets.length,
          totalEarned: sum('totalEarned'),
          totalPurchased: sum('totalPurchased'),
          totalSpent: sum('totalSpent'),
          totalLoyaltyPoints: wallets.reduce((acc, w) => acc + (w.loyaltyPoints || 0), 0),
        },
        payouts: {
          total: parseInt(payoutStats?.total_payouts, 10) || 0,
          pending: parseInt(payoutStats?.pending_payouts, 10) || 0,
          totalAmount: parseFloat(payoutStats?.total_amount) || 0,
          averageAmount: parseFloat(payoutStats?.avg_amount) || 0,
        },
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques:', error);
      throw error;
    }
  }
}

module.exports = TweetMonetizationService;
