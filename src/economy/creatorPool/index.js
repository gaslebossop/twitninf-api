/**
 * Pot créateur hebdomadaire.
 *
 * Remplace le calcul linéaire par tweet (`0,01 NF la vue, 0,05 le like`…) par
 * un partage : la plateforme reverse une part de ce qui EST RÉELLEMENT ENTRÉ
 * en trésorerie pendant la semaine, et cette somme se répartit entre les
 * créateurs au prorata de `vues qualifiées × qualité`.
 *
 * Trois conséquences qui expliquent la forme du code :
 *
 * - **Le RPM devient une sortie, pas une entrée.** Personne ne fixe un taux :
 *   on constate ce qu'une part représente pour mille vues. C'est le modèle des
 *   fonds créateurs de TikTok et du partage YouTube, et c'est le seul qui ne
 *   puisse pas coûter plus que ce que la plateforme a encaissé.
 *
 * - **Le montant est GELÉ à la clôture.** Une ligne `creator_payouts` porte la
 *   somme et son détail. Encaisser ne recalcule rien — c'est un virement, et
 *   il est idempotent. L'ancien chemin recalculait tout au moment du clic, ce
 *   qui rendait le montant affiché et le montant versé structurellement
 *   différents.
 *
 * - **Un tweet ne s'épuise jamais.** La période ne filtre pas sur la date de
 *   publication mais sur la date des ÉVÉNEMENTS. Un tweet d'il y a un mois qui
 *   tourne encore cette semaine rapporte encore cette semaine. C'est pour ça
 *   que `resetTweetCounters` (qui remettait `view_count` à zéro après paiement)
 *   n'a plus lieu d'être : aucun compteur n'est touché, jamais.
 */

const { sequelize } = require('../../database/index');

const { TREASURY_USER_ID } = require('../constants');
const { getPlatformCurrency } = require('../platformCurrency');
const { roundTWC } = require('../money');
const NewEconomyService = require('../../services/newEconomyService');
const { isSubscriptionActive } = require('../../utils/subscriptionHelpers');
const logger = require('../../utils/logger');

const period = require('./period');
const { getSettings } = require('./settings');
const { collectPeriodSignals } = require('./signals');
const { evaluateBonuses, describeCatalog } = require('./bonuses');
const { percentileRanks, qualityScore, creatorWeight, shareOfPool, rpmFor } = require('./ranking');

/**
 * Taille du pot d'une période.
 *
 * `inflows` = tout ce qui a rejoint la trésorerie pendant la fenêtre : dépenses
 * publicitaires, achats d'abonnement Plus/Pro, commissions sur virements,
 * achats divers. Tous passent par `EconomyLedger.spendToTreasury`, donc tous
 * portent `metadata.ledger = 'SPEND_TO_TREASURY'` — une seule condition
 * suffit à les capter, y compris les sources qui n'existent pas encore.
 *
 * Deux plafonds indépendants, et le plus petit gagne : la part des entrées
 * (la promesse faite aux créateurs) et une fraction du solde réel (la garantie
 * que la trésorerie survit à la clôture).
 */
async function computePool({ start, end }, currencyId, settings) {
  const [inflowRow] = await sequelize.query(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
     FROM transactions
     WHERE to_user_id = :treasury
       AND currency_id = :currencyId
       AND status = 'COMPLETED'
       AND metadata->>'ledger' = 'SPEND_TO_TREASURY'
       AND created_at >= :start AND created_at < :end`,
    {
      replacements: { treasury: TREASURY_USER_ID, currencyId, start, end },
      type: sequelize.QueryTypes.SELECT,
    }
  );

  const [balanceRow] = await sequelize.query(
    `SELECT COALESCE(balance, 0) AS balance
     FROM user_wallets
     WHERE user_id = :treasury AND currency_id = :currencyId
     LIMIT 1`,
    {
      replacements: { treasury: TREASURY_USER_ID, currencyId },
      type: sequelize.QueryTypes.SELECT,
    }
  );

  const inflows = parseFloat(inflowRow?.total) || 0;
  const treasuryBalance = parseFloat(balanceRow?.balance) || 0;

  const fromInflows = inflows * settings.poolShareOfInflows;
  const fromBalance = treasuryBalance * settings.maxDrawOfTreasuryBalance;
  const pool = roundTWC(Math.max(0, Math.min(fromInflows, fromBalance)));

  return {
    pool,
    inflows: roundTWC(inflows),
    inflowTransactions: parseInt(inflowRow?.count, 10) || 0,
    treasuryBalance: roundTWC(treasuryBalance),
    cappedByTreasury: fromBalance < fromInflows,
    shareOfInflows: settings.poolShareOfInflows,
  };
}

/** Créateurs autorisés à toucher : abonnement actif ET programme accepté. */
async function loadEligibility(creatorIds) {
  if (creatorIds.length === 0) return new Map();
  const rows = await sequelize.query(
    `SELECT id, username, full_name, avatar, subscription_tier, subscription_expires_at,
            monetization_program_status
     FROM users
     WHERE id = ANY(CAST(:ids AS uuid[]))`,
    { replacements: { ids: `{${creatorIds.join(',')}}` }, type: sequelize.QueryTypes.SELECT }
  );

  const map = new Map();
  for (const r of rows) {
    const subscribed = isSubscriptionActive({
      subscription_tier: r.subscription_tier,
      subscription_expires_at: r.subscription_expires_at,
    });
    const approved = r.monetization_program_status === 'approved';
    map.set(String(r.id), {
      id: String(r.id),
      username: r.username,
      fullName: r.full_name,
      avatar: r.avatar,
      subscribed,
      approved,
      eligible: subscribed && approved,
      lockedReason: !subscribed
        ? 'La monétisation est réservée aux abonnements Plus et Pro'
        : !approved
          ? 'La monétisation nécessite d\'être accepté dans le programme de monétisation'
          : null,
    });
  }
  return map;
}

/**
 * Calcul complet d'une période, sans rien écrire.
 *
 * Sert autant à la clôture qu'à la projection en direct de la semaine en
 * cours : c'est le même code, donc ce que l'app annonce le mercredi et ce
 * qu'elle verse le lundi ne peuvent pas diverger par construction.
 */
async function computePeriodBreakdown(p, { settings: injected } = {}) {
  const settings = injected || (await getSettings());
  const currency = await getPlatformCurrency();
  if (!currency) throw new Error('Monnaie de plateforme introuvable');

  const [poolInfo, signals] = await Promise.all([
    computePool(p, currency.id, settings),
    collectPeriodSignals(p),
  ]);

  const withAudience = signals.filter((s) => s.qualifiedViews > 0);
  const eligibility = await loadEligibility(withAudience.map((s) => s.creatorId));

  // Le classement se fait sur TOUS les créateurs vus cette semaine, éligibles
  // ou non : un rang qui ne compare qu'aux abonnés payants ne veut rien dire,
  // et un créateur non éligible doit pouvoir situer son travail avant de
  // candidater.
  const pAttention = percentileRanks(withAudience.map((s) => s.attentionRate));
  const pRetention = percentileRanks(withAudience.map((s) => s.retentionRate));
  const pDau = percentileRanks(withAudience.map((s) => s.dauRate));
  const pPenalty = percentileRanks(withAudience.map((s) => s.penaltyRate));

  const totalDau = withAudience.reduce((sum, s) => sum + s.dauRate, 0);
  const cohort = {
    size: withAudience.length,
    averageDauRate: withAudience.length > 0 ? totalDau / withAudience.length : 0,
  };

  const w = settings.weights;
  const rows = withAudience.map((s, i) => {
    const percentiles = {
      attention: pAttention[i],
      retention: pRetention[i],
      dau: pDau[i],
      penalty: pPenalty[i],
    };

    const quality = qualityScore(percentiles, w, settings.qualityFloor);

    // Faute de dwell réel, l'attention est estimée — et décotée. Sans cette
    // décote, ne rien instrumenter deviendrait plus rentable que d'être mesuré.
    const attentionFactor = s.hasRealDwell ? 1 : settings.attentionProxyDiscount;

    const bonuses = evaluateBonuses({ creator: s, percentiles, cohort, settings });
    const person = eligibility.get(s.creatorId) || { eligible: false, lockedReason: null };

    const weight = creatorWeight({
      qualifiedViews: s.qualifiedViews,
      quality,
      attentionFactor,
      bonusMultiplier: bonuses.multiplier,
    });

    return {
      creatorId: s.creatorId,
      username: person.username || null,
      fullName: person.fullName || null,
      avatar: person.avatar || null,
      eligible: !!person.eligible,
      lockedReason: person.lockedReason || null,
      qualifiedViews: s.qualifiedViews,
      // Vues ayant servi de base au taux d'attention : égal à `qualifiedViews`
      // dès que la période entière est instrumentée, plus petit sur la période
      // de transition. Exposé pour que l'écran puisse expliquer une moyenne
      // calculée sur une partie seulement des vues.
      measurableViews: s.measurableViews,
      rawViews: s.rawViews,
      distinctViewers: s.distinctViewers,
      hasRealDwell: s.hasRealDwell,
      rates: {
        attention: s.attentionRate,
        retention: s.retentionRate,
        dau: s.dauRate,
        penalty: s.penaltyRate,
      },
      percentiles,
      raw: s.raw,
      quality,
      attentionFactor,
      bonuses,
      weight,
      // Complétés juste après, une fois la somme des poids connue.
      amount: 0,
      rpm: 0,
    };
  });

  // Seuls les éligibles se partagent le pot. Les autres gardent un poids
  // calculé — c'est ce qui permet de leur montrer, chiffres à l'appui, ce
  // qu'ils toucheraient.
  //
  // Le dénominateur ne compte QUE les poids éligibles : un non-éligible qui
  // apparaît dans la liste ne doit pas diluer la part de ceux qui sont payés.
  // Sa propre ligne est donc calculée avec le même dénominateur, ce qui
  // revient à lui montrer ce qu'il toucherait s'il rejoignait le partage.
  const payableWeights = rows.map((r) => (r.eligible ? r.weight : 0));
  const totalWeight = payableWeights.reduce((sum, x) => sum + x, 0);

  for (const r of rows) {
    const amount = roundTWC(shareOfPool(poolInfo.pool, r.weight, totalWeight));
    r.share = totalWeight > 0 ? r.weight / totalWeight : 0;
    // Un non-éligible voit ce que sa part VAUDRAIT ; `amount` reste sa
    // projection, `payableAmount` est ce qui sera réellement écrit.
    r.amount = amount;
    r.payableAmount = r.eligible ? amount : 0;
    r.rpm = roundTWC(rpmFor(amount, r.qualifiedViews));
  }

  rows.sort((a, b) => b.weight - a.weight);

  return {
    period: { key: p.key, start: p.start, end: p.end },
    currency: { id: currency.id, symbol: currency.symbol, name: currency.name },
    pool: poolInfo,
    cohort,
    settings: {
      weights: w,
      qualityFloor: settings.qualityFloor,
      attentionProxyDiscount: settings.attentionProxyDiscount,
      bonuses: describeCatalog(settings),
    },
    totalWeight,
    rows,
  };
}

/**
 * Clôture une période : fige une part par créateur éligible.
 *
 * Idempotente. Le garde-fou n'est pas un `if` mais l'index unique
 * `(user_id, period_key)` : deux workers lancés en même temps (le cas que
 * `NODE_ROLE` est censé empêcher, mais qu'une intervention manuelle peut
 * recréer) produisent au pire des conflits ignorés, jamais deux parts.
 */
async function closePeriod({ periodKey = null, now = new Date() } = {}) {
  const p = periodKey ? period.fromKey(periodKey) : period.lastClosedPeriod(now);
  if (!p) throw new Error(`Période invalide: ${periodKey}`);
  if (p.end > now) {
    throw new Error(`La période ${p.key} n'est pas terminée (fin ${p.end.toISOString()})`);
  }

  const breakdown = await computePeriodBreakdown(p);
  const settings = await getSettings();

  const payable = breakdown.rows.filter(
    (r) => r.eligible && r.payableAmount >= settings.minPayoutNf
  );

  if (payable.length === 0) {
    logger.info(`[creatorPool] ${p.key}: aucune part à écrire (pot=${breakdown.pool.pool} ${breakdown.currency.symbol})`);
    return { period: p.key, created: 0, pool: breakdown.pool.pool, total: 0 };
  }

  let created = 0;
  let total = 0;

  for (const row of payable) {
    try {
      const [result] = await sequelize.query(
        `INSERT INTO creator_payouts
           (id, user_id, period_key, period_start, period_end, currency_id,
            amount, qualified_views, quality, rpm, bonus_multiplier, breakdown, status, created_at, updated_at)
         VALUES
           (gen_random_uuid(), :userId, :periodKey, :start, :end, :currencyId,
            :amount, :qualifiedViews, :quality, :rpm, :bonusMultiplier, CAST(:breakdown AS jsonb), 'claimable', NOW(), NOW())
         ON CONFLICT (user_id, period_key) DO NOTHING
         RETURNING id`,
        {
          replacements: {
            userId: row.creatorId,
            periodKey: p.key,
            start: p.start,
            end: p.end,
            currencyId: breakdown.currency.id,
            amount: row.payableAmount,
            qualifiedViews: row.qualifiedViews,
            quality: row.quality,
            rpm: row.rpm,
            bonusMultiplier: row.bonuses.multiplier,
            breakdown: JSON.stringify({
              rates: row.rates,
              percentiles: row.percentiles,
              raw: row.raw,
              share: row.share,
              weight: row.weight,
              attentionFactor: row.attentionFactor,
              hasRealDwell: row.hasRealDwell,
              distinctViewers: row.distinctViewers,
              measurableViews: row.measurableViews,
              rawViews: row.rawViews,
              bonuses: row.bonuses.earned,
              cohortSize: breakdown.cohort.size,
              pool: breakdown.pool,
              weights: breakdown.settings.weights,
            }),
          },
          type: sequelize.QueryTypes.INSERT,
        }
      );
      if (Array.isArray(result) ? result.length > 0 : !!result) {
        created += 1;
        total += row.payableAmount;
      }
    } catch (e) {
      // Une part ratée ne doit pas emporter les autres : on la signale et on
      // continue. La clôture est rejouable, l'index unique protège du double.
      logger.error(`[creatorPool] part non écrite pour ${row.creatorId} (${p.key}): ${e.message}`);
    }
  }

  logger.info(
    `[creatorPool] ${p.key} clôturée: ${created} part(s), ${roundTWC(total)} / ${breakdown.pool.pool} ${breakdown.currency.symbol} ` +
    `(entrées ${breakdown.pool.inflows}, vivier ${breakdown.cohort.size})`
  );

  return { period: p.key, created, pool: breakdown.pool.pool, total: roundTWC(total) };
}

/**
 * Encaissement d'une part.
 *
 * Ne recalcule RIEN. Verrou de ligne + transition d'état conditionnelle : deux
 * appels simultanés (double tap, reprise réseau) ne peuvent pas verser deux
 * fois, et un échec du virement laisse la part réclamable au lieu de la
 * perdre.
 */
async function claim(userId, periodKey) {
  const dbTransaction = await sequelize.transaction();
  try {
    const rows = await sequelize.query(
      `SELECT id, amount, currency_id, status, period_key
       FROM creator_payouts
       WHERE user_id = :userId AND period_key = :periodKey
       FOR UPDATE`,
      {
        replacements: { userId, periodKey },
        type: sequelize.QueryTypes.SELECT,
        transaction: dbTransaction,
      }
    );

    const payout = rows[0];
    if (!payout) {
      await dbTransaction.rollback();
      return { success: false, reason: 'Aucune part à encaisser pour cette période' };
    }
    if (payout.status === 'claimed') {
      await dbTransaction.rollback();
      return { success: false, reason: 'Cette part a déjà été encaissée', alreadyClaimed: true };
    }
    if (payout.status !== 'claimable') {
      await dbTransaction.rollback();
      return { success: false, reason: `Part non encaissable (${payout.status})` };
    }

    const amount = parseFloat(payout.amount) || 0;
    if (amount <= 0) {
      await dbTransaction.rollback();
      return { success: false, reason: 'Montant nul' };
    }

    const result = await NewEconomyService.rewardUser(
      userId,
      payout.currency_id,
      amount,
      `Part créateur ${payout.period_key}`,
      dbTransaction
    );

    if (!result.success) {
      await dbTransaction.rollback();
      logger.warn(`[creatorPool] encaissement refusé ${userId}/${periodKey}: ${result.reason}`);
      return { success: false, reason: result.reason || 'Versement refusé' };
    }

    await sequelize.query(
      `UPDATE creator_payouts
       SET status = 'claimed', claimed_at = NOW(), updated_at = NOW(),
           transaction_id = :transactionId
       WHERE id = :id AND status = 'claimable'`,
      {
        replacements: {
          id: payout.id,
          transactionId: result.transaction?.id || null,
        },
        transaction: dbTransaction,
      }
    );

    await dbTransaction.commit();
    logger.info(`[creatorPool] ${userId} a encaissé ${amount} pour ${periodKey}`);
    return { success: true, amount, periodKey };
  } catch (error) {
    await dbTransaction.rollback();
    logger.error(`[creatorPool] encaissement impossible ${userId}/${periodKey}:`, error);
    throw error;
  }
}

/** Parts déjà figées d'un créateur, la plus récente d'abord. */
async function listPayouts(userId, { limit = 12 } = {}) {
  return sequelize.query(
    `SELECT period_key, period_start, period_end, amount, qualified_views,
            quality, rpm, bonus_multiplier, status, claimed_at, breakdown
     FROM creator_payouts
     WHERE user_id = :userId
     ORDER BY period_start DESC
     LIMIT :limit`,
    { replacements: { userId, limit }, type: sequelize.QueryTypes.SELECT }
  );
}

/**
 * Tout ce qu'il faut à l'écran de monétisation, en un appel.
 *
 * Un seul aller-retour parce que ces morceaux n'ont aucun sens séparés : un
 * montant sans sa période, ou une qualité sans son vivier, ne veut rien dire.
 */
async function getDashboard(userId, { now = new Date() } = {}) {
  const current = period.currentPeriod(now);
  const settings = await getSettings();

  const [live, payouts] = await Promise.all([
    computePeriodBreakdown(current, { settings }),
    listPayouts(userId),
  ]);

  const mine = live.rows.find((r) => r.creatorId === String(userId)) || null;
  const claimable = payouts.filter((p) => p.status === 'claimable');
  const claimableTotal = roundTWC(
    claimable.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0)
  );

  return {
    currency: live.currency,
    now,
    currentPeriod: {
      key: current.key,
      start: current.start,
      end: current.end,
      pool: live.pool,
      cohortSize: live.cohort.size,
      // Projection : ce que la part vaudrait si la semaine s'arrêtait là.
      projection: mine
        ? {
            amount: mine.amount,
            payableAmount: mine.payableAmount,
            rpm: mine.rpm,
            share: mine.share,
            quality: mine.quality,
            qualifiedViews: mine.qualifiedViews,
            measurableViews: mine.measurableViews,
            rawViews: mine.rawViews,
            distinctViewers: mine.distinctViewers,
            hasRealDwell: mine.hasRealDwell,
            attentionFactor: mine.attentionFactor,
            rates: mine.rates,
            percentiles: mine.percentiles,
            raw: mine.raw,
            bonuses: mine.bonuses,
            eligible: mine.eligible,
            lockedReason: mine.lockedReason,
          }
        : null,
    },
    claimable: {
      count: claimable.length,
      total: claimableTotal,
      periods: claimable.map((p) => ({
        periodKey: p.period_key,
        periodStart: p.period_start,
        periodEnd: p.period_end,
        amount: parseFloat(p.amount) || 0,
        rpm: parseFloat(p.rpm) || 0,
      })),
    },
    history: payouts.map((p) => ({
      periodKey: p.period_key,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      amount: parseFloat(p.amount) || 0,
      qualifiedViews: parseFloat(p.qualified_views) || 0,
      quality: parseFloat(p.quality) || 0,
      rpm: parseFloat(p.rpm) || 0,
      bonusMultiplier: parseFloat(p.bonus_multiplier) || 1,
      status: p.status,
      claimedAt: p.claimed_at,
      breakdown: p.breakdown || null,
    })),
    weights: settings.weights,
    bonusCatalog: describeCatalog(settings),
  };
}

module.exports = {
  period,
  percentileRanks,
  computePool,
  computePeriodBreakdown,
  closePeriod,
  claim,
  listPayouts,
  getDashboard,
};
