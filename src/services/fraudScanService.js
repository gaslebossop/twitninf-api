'use strict';

/**
 * Scan rétrospectif de l'historique économique (transferts, minage, casino)
 * pour repérer des comptes/transactions suspects. Complète le middleware
 * temps réel (fraudMiddleware.js + service Rust) qui juge chaque requête
 * isolément : ici on regarde des PATTERNS sur plusieurs événements dans le
 * temps, ce que le temps réel ne peut pas voir.
 *
 * Important : il n'existe aucune table d'audit IP/device par utilisateur en
 * base (le service Rust garde une réputation IP en mémoire, non persistée,
 * non liée à un compte). Le signal "comptes liés" ci-dessous est donc déduit
 * du GRAPHE DE TRANSACTIONS (qui échange avec qui, à quelle fréquence), pas
 * d'une corrélation d'identité — c'est une limite réelle, pas un oubli.
 */

const { QueryTypes, Op } = require('sequelize');
const { sequelize } = require('../database/index');
const { User, UserWallet, VirtualCurrency } = require('../models');
const { MINING_DAILY_WIN_LIMIT, TREASURY_USER_ID } = require('../economy/constants');
const { toAmount, roundTWC } = require('../economy/money');
const { POLICE_ACCOUNT_ID } = require('./policiercongo/config');

// Comptes système : leur activité automatisée (minage/paris/transferts à
// cadence non-humaine) est par construction, pas un signal de fraude — les
// exclure évite qu'ils noient les vrais comptes suspects en tête de liste.
const SYSTEM_ACCOUNT_IDS = new Set([TREASURY_USER_ID, POLICE_ACCOUNT_ID].filter(Boolean));

// Seuils de scan — volontairement ici (pas dans economy/constants.js) : ce
// sont des réglages de détection, pas des règles du jeu économique. Sauf
// mention contraire, ce sont des seuils RELATIFS à la population ou à
// l'historique propre du compte, pas des montants NF fixes — un montant fixe
// se contourne trivialement en restant juste en-dessous une fois connu.
const LARGE_TRANSFER_PERCENTILE = 0.99; // flag au-delà du 99e centile réel des transferts de la fenêtre
const PERSONAL_BASELINE_MIN_SAMPLE = 3; // sous ce nombre de transferts, pas d'historique propre fiable
const PERSONAL_BASELINE_DEVIATION = 4; // écarts-types au-dessus de SA PROPRE moyenne
const FRESH_ACCOUNT_HOURS = 48;
const WASH_TRADE_WINDOW_HOURS = 24;
const LAUNDER_CYCLE_WINDOW_HOURS = 48;
const CONCENTRATION_MIN_TRANSFERS = 3;
const CONCENTRATION_RATIO = 0.85;
const MINING_CAP_STREAK_DAYS = 3;
const MINING_MIN_GAP_SECONDS = 4;
const MINING_MIN_GAP_SAMPLES = 8;
const CASINO_MIN_SAMPLE = 20;
const CASINO_BURST_WINDOW_SECONDS = 60;
const CASINO_BURST_MIN_BETS = 12;

// Typologies "comportementales" (au sens AML européen — cf. AMLD, approche par
// risque) : ces signaux ne regardent PAS le montant d'une transaction isolée,
// mais la FORME du comportement dans le temps et le graphe des comptes. Un
// fraudeur qui apprend les seuils ci-dessus peut rester sous chaque seuil
// individuellement — ces signaux visent justement ce contournement.
const STRUCTURING_MIN_SPLITS = 3; // nb mini de transferts fractionnés le même jour pour suspecter un fractionnement
const STRUCTURING_SINGLE_CAP_RATIO = 0.6; // chaque transfert individuel reste sous 60% du 99e centile...
const STRUCTURING_TOTAL_RATIO = 1.0; // ...mais leur somme dépasse le 99e centile — évitement délibéré du seuil "hors norme"
const MULE_MIN_SENDERS = 4; // reçoit d'au moins 4 comptes distincts...
const MULE_PASSTHROUGH_RATIO = 0.7; // ...puis en fait ressortir au moins 70% — profil "compte relais"
const DORMANT_DAYS_MIN = 30; // compte inactif depuis au moins 30 jours avant de se réveiller
const SYNC_MIN_ACCOUNTS = 3; // nb mini de comptes distincts agissant à la même minute
const SYNC_FRESH_WINDOW_HOURS = FRESH_ACCOUNT_HOURS * 3; // comptes créés dans une fenêtre plus large que le signal "compte récent" isolé
const ROUND_NUMBER_MIN_SAMPLE = 5;
const ROUND_NUMBER_RATIO = 0.9; // ≥90% des transferts sont des montants ronds (structuration typique)
const MINE_CASHOUT_WINDOW_HOURS = 1;
const MINE_CASHOUT_MIN_OCCURRENCES = 5; // minage → sortie quasi immédiate, répété — pas un seul montant, un PATTERN répété
const PURCHASE_BURST_MIN_COUNT = 5; // achats EUR→NF répétés en 1h — signature de "card testing" (test d'une carte volée par petits montants)
const PURCHASE_CASHOUT_WINDOW_HOURS = 6;
const PURCHASE_CASHOUT_MIN_OCCURRENCES = 3; // achat EUR→NF puis revente/transfert quasi immédiat, répété — blanchiment via monnaie virtuelle
const PURCHASE_CASHOUT_RATIO = 0.7;

function scoreOf(entries) {
  const base = entries.reduce((sum, e) => sum + e.score, 0);
  // Bonus de diversité : être suspect sur PLUSIEURS domaines indépendants
  // (transferts + minage + casino) est bien plus significatif que plusieurs
  // signaux dans un seul domaine — un compte peut avoir un profil de transfert
  // atypique sans être frauduleux, mais l'être aussi sur le minage ET le
  // casino en même temps est beaucoup moins probable par hasard.
  const categories = new Set(entries.map(e => e.category));
  const diversityMultiplier = categories.size >= 3 ? 1.5 : categories.size === 2 ? 1.2 : 1;
  return Math.round(base * diversityMultiplier * 10) / 10;
}

class FraudScanService {
  /**
   * Scan MULTI-MONNAIE : le scan portait auparavant sur une seule monnaie
   * (`getPlatformCurrency()`, la plus ancienne active — en pratique le NF),
   * ce qui rendait invisibles toute fraude sur les monnaies communautaires
   * créées ensuite (échangées via `exchangeCurrency`, minées, transférées en
   * P2P comme le NF). On boucle maintenant sur TOUTES les monnaies actives et
   * chaque signal est tagué `currencyId`/`currencySymbol` — le score et la
   * sévérité restent globaux par utilisateur (le comportement compte,
   * peu importe la monnaie sur laquelle il porte), mais le montant à retirer
   * (`fraudByCurrency`) est calculé et plafonné séparément par monnaie,
   * puisque chaque monnaie a son propre portefeuille et sa propre valeur.
   */
  static async scan({ lookbackDays = 14, limit = 100 } = {}) {
    const scannedAt = new Date().toISOString();
    const currencies = await VirtualCurrency.findAll({ where: { isActive: true } });
    if (!currencies.length) {
      return { scannedAt, lookbackDays, stats: { usersFlagged: 0, signalsRaised: 0 }, flaggedUsers: [] };
    }

    const since = new Date(Date.now() - lookbackDays * 86400000);

    const perCurrencyResults = await Promise.all(
      currencies.map((currency) => this._scanCurrency(currency, since))
    );
    const casinoSignals = await this._scanCasino(since, currencies);

    const allSignals = [...casinoSignals];
    let signalsRaised = casinoSignals.length;
    for (const r of perCurrencyResults) {
      allSignals.push(...r.signals);
      signalsRaised += r.signals.length;
    }

    const byUser = new Map();
    for (const s of allSignals) {
      if (!s.userId || SYSTEM_ACCOUNT_IDS.has(s.userId)) continue;
      if (!byUser.has(s.userId)) byUser.set(s.userId, []);
      byUser.get(s.userId).push(s);
    }

    const userIds = [...byUser.keys()];
    const users = userIds.length
      ? await User.findAll({ where: { id: userIds }, attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'createdAt'] })
      : [];
    const userMap = new Map(users.map(u => [u.id, u]));

    // Soldes réels par (utilisateur, monnaie) — nécessaires pour plafonner le
    // montant suggéré au retrait à ce qui est RÉELLEMENT disponible dans
    // chaque portefeuille concerné (jamais déduit d'un simple total de signaux).
    const involvedCurrencyIds = [...new Set(allSignals.map(s => s.currencyId).filter(Boolean))];
    const wallets = userIds.length && involvedCurrencyIds.length
      ? await UserWallet.findAll({
          where: { userId: { [Op.in]: userIds }, currencyId: { [Op.in]: involvedCurrencyIds } },
          attributes: ['userId', 'currencyId', 'balance']
        })
      : [];
    const balanceMap = new Map(wallets.map(w => [`${w.userId}:${w.currencyId}`, toAmount(w.balance)]));
    const currencyMap = new Map(currencies.map(c => [c.id, c]));

    const flaggedUsers = userIds
      .map(userId => {
        const entries = byUser.get(userId);
        const score = scoreOf(entries);
        const user = userMap.get(userId);

        // Regroupe les montants imputables par monnaie (les signaux sans
        // montant, `amount: null`, correspondent à de l'argent déjà sorti du
        // compte au moment du signal — voir chaque scanner pour le détail).
        const byCurrency = new Map();
        for (const e of entries) {
          if (!e.currencyId) continue;
          if (!byCurrency.has(e.currencyId)) byCurrency.set(e.currencyId, 0);
          if (e.amount != null && e.amount > 0) {
            byCurrency.set(e.currencyId, byCurrency.get(e.currencyId) + Number(e.amount));
          } else if (!byCurrency.has(e.currencyId)) {
            byCurrency.set(e.currencyId, 0);
          }
        }
        const fraudByCurrency = [...byCurrency.entries()].map(([currencyId, estimatedFraudAmount]) => {
          const currentBalance = balanceMap.get(`${userId}:${currencyId}`) || 0;
          return {
            currencyId,
            symbol: currencyMap.get(currencyId)?.symbol || '?',
            estimatedFraudAmount: roundTWC(estimatedFraudAmount),
            suggestedBurnAmount: roundTWC(Math.min(estimatedFraudAmount, currentBalance)),
            currentBalance: roundTWC(currentBalance)
          };
        }).filter(c => c.currentBalance > 0 || c.estimatedFraudAmount > 0);

        return {
          userId,
          username: user?.username || null,
          fullName: user?.full_name || null,
          avatar: user?.avatar || null,
          verified: user?.verified || false,
          accountCreatedAt: user?.createdAt || null,
          score,
          severity: score >= 8 ? 'high' : score >= 4 ? 'medium' : 'low',
          reasons: entries.map(({ reason, score: s, detail, currencySymbol }) => ({ reason, score: s, detail, currencySymbol: currencySymbol || null })),
          fraudByCurrency
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return {
      scannedAt,
      lookbackDays,
      stats: {
        usersFlagged: flaggedUsers.length,
        highSeverity: flaggedUsers.filter(u => u.severity === 'high').length,
        mediumSeverity: flaggedUsers.filter(u => u.severity === 'medium').length,
        lowSeverity: flaggedUsers.filter(u => u.severity === 'low').length,
        signalsRaised,
        currenciesScanned: currencies.length
      },
      flaggedUsers
    };
  }

  /** Lance les 4 scanners currency-scoped pour UNE monnaie et tague chaque signal. */
  static async _scanCurrency(currency, since) {
    const [transferSignals, miningSignals, patternSignals, purchaseSignals] = await Promise.all([
      this._scanTransfers(currency.id, since),
      this._scanMining(currency.id, since),
      this._scanPatterns(currency.id, since),
      this._scanPurchases(currency.id, since)
    ]);
    const tagged = [...transferSignals, ...miningSignals, ...patternSignals, ...purchaseSignals]
      .map(s => ({ ...s, currencyId: currency.id, currencySymbol: currency.symbol }));
    return { signals: tagged };
  }

  /**
   * Achats EUR→NF : seul point de contact entre argent réel et la monnaie
   * virtuelle, donc seul endroit où un test de carte volée ("card testing")
   * ou un blanchiment via achat-puis-revente peuvent apparaître. Signal
   * indépendant du reste : ne regarde ni le minage, ni le casino, ni les
   * transferts seuls, mais la RELATION entre un achat et ce qui en sort.
   */
  static async _scanPurchases(currencyId, since) {
    const out = [];

    // Rafale d'achats en peu de temps : un humain qui recharge son compte le
    // fait rarement plusieurs fois par heure — une carte volée testée par
    // petits montants successifs jusqu'à ce qu'elle soit refusée le fait.
    const bursts = await sequelize.query(
      `WITH buckets AS (
         SELECT to_user_id AS "userId", date_trunc('hour', created_at) AS hour, COUNT(*) AS cnt, SUM(amount_in_eur) AS eur
         FROM transactions
         WHERE currency_id = :currencyId AND type = 'PURCHASE' AND created_at >= :since
         GROUP BY to_user_id, date_trunc('hour', created_at)
       )
       SELECT "userId", MAX(cnt) AS "maxPerHour", SUM(eur) AS "totalEur"
       FROM buckets
       GROUP BY "userId"
       HAVING MAX(cnt) >= :minCount
       LIMIT 200`,
      { replacements: { currencyId, since, minCount: PURCHASE_BURST_MIN_COUNT }, type: QueryTypes.SELECT }
    );
    for (const b of bursts) {
      out.push({
        userId: b.userId, category: 'purchase', reason: 'rafale_achats_eur', score: 4,
        detail: `jusqu'à ${b.maxPerHour} achats en une heure (${Number(b.totalEur).toFixed(2)} € cumulés) — cadence évoquant un test de moyen de paiement`,
        amount: null // signal comportemental (cadence), pas un montant NF directement imputable
      });
    }

    // Achat EUR→NF suivi d'une sortie quasi immédiate vers un autre compte,
    // RÉPÉTÉE : convertir de l'argent en NF pour le faire ressortir aussitôt
    // n'a aucun intérêt d'usage normal — c'est le schéma type du blanchiment
    // via monnaie virtuelle (l'origine de l'argent devient un simple compte NF).
    const cashout = await sequelize.query(
      `WITH purchases AS (
         SELECT to_user_id AS "userId", amount, created_at
         FROM transactions
         WHERE currency_id = :currencyId AND type = 'PURCHASE' AND created_at >= :since
       )
       SELECT p."userId", COUNT(*) AS occurrences, SUM(t.amount) AS "cashedOut"
       FROM purchases p
       JOIN transactions t
         ON t.from_user_id = p."userId" AND t.type = 'TRANSFER' AND (t.metadata->>'ledger') = 'P2P'
        AND t.currency_id = :currencyId
        AND t.created_at > p.created_at AND t.created_at <= p.created_at + (:windowHours || ' hours')::interval
        AND t.amount >= p.amount * :ratio
       GROUP BY p."userId"
       HAVING COUNT(*) >= :minOccurrences
       LIMIT 200`,
      { replacements: { currencyId, since, windowHours: PURCHASE_CASHOUT_WINDOW_HOURS, ratio: PURCHASE_CASHOUT_RATIO, minOccurrences: PURCHASE_CASHOUT_MIN_OCCURRENCES }, type: QueryTypes.SELECT }
    );
    for (const c of cashout) {
      out.push({
        userId: c.userId, category: 'purchase', reason: 'achat_puis_revente_immediate', score: 5,
        detail: `${c.occurrences} fois où un achat EUR→NF a été retransféré à ≥${Math.round(PURCHASE_CASHOUT_RATIO * 100)}% vers un autre compte en moins de ${PURCHASE_CASHOUT_WINDOW_HOURS}h (${Number(c.cashedOut).toFixed(2)} NF au total)`,
        amount: null // le montant a déjà quitté ce compte (transféré ailleurs) : rien à retirer ICI
      });
    }

    return out;
  }

  /**
   * Trace la circulation des fonds issus d'un compte suspect : marche avant
   * dans le graphe des transferts P2P, saut par saut, jusqu'à `maxHops`. Ce
   * n'est PAS un traçage comptable exact (une monnaie virtuelle est fongible
   * — on ne peut pas prouver que "cette unité précise" est celle qui a
   * circulé, une fois mélangée dans un portefeuille avec d'autres fonds) :
   * c'est une carte de "qui a reçu de l'argent de ce compte, et ensuite de
   * qui" pour guider l'admin, pas une preuve comptable au NF près.
   *
   * Parcourt TOUTES les monnaies actives (pas seulement le NF) : un compte
   * peut tout aussi bien blanchir via une monnaie communautaire, et les
   * amounts de deux monnaies différentes n'étant pas comparables, chaque
   * arête et chaque compte exposé garde son `currencyId`/`currencySymbol`
   * plutôt que d'être sommés ensemble.
   */
  static async traceFlow({ userId, lookbackDays = 30, maxHops = 4 } = {}) {
    if (!userId) {
      return { userId, edges: [], exposedAccounts: [] };
    }
    const currencies = await VirtualCurrency.findAll({ where: { isActive: true } });
    if (!currencies.length) {
      return { userId, edges: [], exposedAccounts: [] };
    }
    const since = new Date(Date.now() - lookbackDays * 86400000);
    const hops = Math.max(1, Math.min(6, parseInt(maxHops, 10) || 4));

    const perCurrencyEdges = await Promise.all(currencies.map(async (currency) => {
      const rows = await sequelize.query(
        `WITH RECURSIVE flow AS (
           SELECT t.id AS "txId", t.from_user_id AS "fromUserId", t.to_user_id AS "toUserId",
                  t.amount, t.created_at AS "createdAt", 1 AS hop
           FROM transactions t
           WHERE t.currency_id = :currencyId AND t.type = 'TRANSFER' AND (t.metadata->>'ledger') = 'P2P'
             AND t.from_user_id = :userId AND t.created_at >= :since
           UNION ALL
           SELECT t.id, t.from_user_id, t.to_user_id, t.amount, t.created_at, flow.hop + 1
           FROM transactions t
           JOIN flow ON t.from_user_id = flow."toUserId" AND t.created_at > flow."createdAt"
           WHERE t.currency_id = :currencyId AND t.type = 'TRANSFER' AND (t.metadata->>'ledger') = 'P2P'
             AND flow.hop < :hops AND t.created_at >= :since
         )
         SELECT DISTINCT "txId", "fromUserId", "toUserId", amount, "createdAt", hop
         FROM flow
         ORDER BY hop ASC, "createdAt" ASC
         LIMIT 500`,
        { replacements: { currencyId: currency.id, userId, since, hops }, type: QueryTypes.SELECT }
      );
      return rows.map(r => ({ ...r, currencyId: currency.id, currencySymbol: currency.symbol }));
    }));
    const edges = perCurrencyEdges.flat();

    // Exposition regroupée par (compte, monnaie) : recevoir 100 NF et 100
    // d'une monnaie communautaire de deux compte différents ne doit jamais
    // se sommer en "200" d'une unité qui n'existe pas.
    const exposureByUserCurrency = new Map();
    for (const e of edges) {
      if (e.toUserId === userId) continue;
      const key = `${e.toUserId}:${e.currencyId}`;
      const prev = exposureByUserCurrency.get(key) || { userId: e.toUserId, currencyId: e.currencyId, currencySymbol: e.currencySymbol, received: 0, hops: new Set() };
      prev.received += Number(e.amount);
      prev.hops.add(e.hop);
      exposureByUserCurrency.set(key, prev);
    }

    const involvedIds = [...new Set([userId, ...edges.map(e => e.toUserId), ...edges.map(e => e.fromUserId)])];
    const users = involvedIds.length
      ? await User.findAll({ where: { id: involvedIds }, attributes: ['id', 'username', 'avatar'] })
      : [];
    const userMap = new Map(users.map(u => [u.id, u]));

    const exposedAccounts = [...exposureByUserCurrency.values()]
      .map((v) => ({
        userId: v.userId,
        username: userMap.get(v.userId)?.username || null,
        avatar: userMap.get(v.userId)?.avatar || null,
        currencyId: v.currencyId,
        currencySymbol: v.currencySymbol,
        receivedTotal: Math.round(v.received * 100) / 100,
        minHop: Math.min(...v.hops)
      }))
      .sort((a, b) => a.minHop - b.minHop || b.receivedTotal - a.receivedTotal);

    return {
      userId,
      lookbackDays,
      maxHops: hops,
      edges: edges.map(e => ({
        transactionId: e.txId, fromUserId: e.fromUserId, toUserId: e.toUserId,
        fromUsername: userMap.get(e.fromUserId)?.username || null,
        toUsername: userMap.get(e.toUserId)?.username || null,
        amount: Number(e.amount), createdAt: e.createdAt, hop: e.hop,
        currencyId: e.currencyId, currencySymbol: e.currencySymbol
      })),
      exposedAccounts
    };
  }

  /**
   * Typologies comportementales façon régulation AML européenne : on ne
   * regarde plus "combien" mais "comment" — fractionnement pour rester sous
   * un seuil, compte relais (fan-in puis fan-out rapide), réveil d'un compte
   * dormant, plusieurs comptes tout frais qui agissent à la même seconde
   * (signe d'un même opérateur derrière plusieurs identités), montants
   * anormalement ronds, et minage suivi d'une sortie quasi instantanée
   * répétée. Chacun de ces signaux resterait invisible à un simple seuil de
   * montant — c'est justement le point.
   */
  static async _scanPatterns(currencyId, since) {
    const out = [];
    const systemIds = [...SYSTEM_ACCOUNT_IDS];
    const sysExcl = (alias) => `${alias ? `${alias}.` : ''}from_user_id NOT IN (:systemIds) AND ${alias ? `${alias}.` : ''}to_user_id NOT IN (:systemIds)`;

    const [{ p99 } = {}] = await sequelize.query(
      `SELECT percentile_cont(:pct) WITHIN GROUP (ORDER BY amount) AS p99
       FROM transactions
       WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at >= :since AND (metadata->>'ledger') = 'P2P' AND ${sysExcl()}`,
      { replacements: { currencyId, since, pct: LARGE_TRANSFER_PERCENTILE, systemIds }, type: QueryTypes.SELECT }
    );
    const populationP99 = Number(p99) || 0;

    // Fractionnement (structuring/smurfing) : plusieurs petits transferts le
    // même jour dont AUCUN ne franchit individuellement le seuil "hors norme",
    // mais dont la somme le dépasse — la signature classique de quelqu'un qui
    // connaît le seuil et le contourne en le saucissonnant.
    if (populationP99 > 0) {
      const structuring = await sequelize.query(
        `SELECT from_user_id AS "userId", date_trunc('day', created_at) AS day,
                COUNT(*) AS cnt, SUM(amount) AS total, MAX(amount) AS "maxSingle"
         FROM transactions
         WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at >= :since
           AND (metadata->>'ledger') = 'P2P' AND ${sysExcl()}
         GROUP BY from_user_id, date_trunc('day', created_at)
         HAVING COUNT(*) >= :minSplits AND SUM(amount) >= :p99 * :totalRatio AND MAX(amount) < :p99 * :capRatio
         LIMIT 200`,
        {
          replacements: {
            currencyId, since, systemIds, p99: populationP99,
            minSplits: STRUCTURING_MIN_SPLITS, totalRatio: STRUCTURING_TOTAL_RATIO, capRatio: STRUCTURING_SINGLE_CAP_RATIO
          },
          type: QueryTypes.SELECT
        }
      );
      for (const s of structuring) {
        out.push({
          userId: s.userId, category: 'transfer', reason: 'transferts_fractionnes_sous_le_seuil', score: 5,
          detail: `${s.cnt} transferts le même jour totalisant ${Number(s.total).toFixed(2)} NF, aucun ne dépassant individuellement ${(STRUCTURING_SINGLE_CAP_RATIO * 100).toFixed(0)}% du seuil — fractionnement probable`,
          amount: null // montant déjà sorti du compte (envoyé), rien à retirer ICI
        });
      }
    }

    // Compte relais (money mule) : reçoit de plusieurs comptes distincts puis
    // fait ressortir l'essentiel de ce volume — un pattern de "pass-through",
    // indépendant du montant en jeu.
    const mules = await sequelize.query(
      `WITH inflow AS (
         SELECT to_user_id AS "userId", COUNT(DISTINCT from_user_id) AS senders, SUM(amount) AS received, COUNT(*) AS "inCount"
         FROM transactions
         WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at >= :since AND (metadata->>'ledger') = 'P2P' AND ${sysExcl()}
         GROUP BY to_user_id
       ), outflow AS (
         SELECT from_user_id AS "userId", SUM(amount) AS sent, COUNT(*) AS "outCount"
         FROM transactions
         WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at >= :since AND (metadata->>'ledger') = 'P2P' AND ${sysExcl()}
         GROUP BY from_user_id
       )
       SELECT i."userId", i.senders, i.received, i."inCount", o.sent, o."outCount"
       FROM inflow i
       JOIN outflow o ON o."userId" = i."userId"
       WHERE i.senders >= :minSenders AND i.received > 0 AND o.sent >= i.received * :passRatio
       LIMIT 200`,
      { replacements: { currencyId, since, systemIds, minSenders: MULE_MIN_SENDERS, passRatio: MULE_PASSTHROUGH_RATIO }, type: QueryTypes.SELECT }
    );
    for (const m of mules) {
      const passedThrough = Number(m.received) - Number(m.sent);
      out.push({
        userId: m.userId, category: 'transfer', reason: 'compte_relais_entonnoir', score: 5,
        detail: `reçu de ${m.senders} comptes distincts (${Number(m.received).toFixed(2)} NF) puis reversé ${Number(m.sent).toFixed(2)} NF — profil de compte relais/entonnoir`,
        // Ce qui n'a pas encore été reversé est ce qui peut encore être retiré ;
        // le reste a déjà quitté le compte (plafonné à 0 si tout a été reversé).
        amount: Math.max(0, passedThrough)
      });
    }

    // Réveil d'un compte dormant : un compte ANCIEN, inactif depuis longtemps,
    // qui se remet soudain à bouger un volume important — un compte qui
    // dormait légitimement n'a aucune raison de repartir brutalement fort.
    const dormant = await sequelize.query(
      `WITH prior_activity AS (
         SELECT from_user_id AS "userId", MAX(created_at) AS "lastBefore"
         FROM transactions
         WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at < :since AND (metadata->>'ledger') = 'P2P'
         GROUP BY from_user_id
       ), recent AS (
         SELECT from_user_id AS "userId", COUNT(*) AS cnt, SUM(amount) AS total, MIN(created_at) AS "firstRecent"
         FROM transactions
         WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at >= :since AND (metadata->>'ledger') = 'P2P' AND ${sysExcl()}
         GROUP BY from_user_id
       )
       SELECT r."userId", r.total, r.cnt,
              EXTRACT(EPOCH FROM (r."firstRecent" - p."lastBefore")) / 86400.0 AS "dormantDays"
       FROM recent r
       JOIN prior_activity p ON p."userId" = r."userId"
       JOIN users u ON u.id = r."userId"
       WHERE u.created_at < p."lastBefore"
         AND EXTRACT(EPOCH FROM (r."firstRecent" - p."lastBefore")) / 86400.0 >= :dormantDaysMin
         AND r.total >= :p99 * 0.5
       LIMIT 200`,
      { replacements: { currencyId, since, systemIds, dormantDaysMin: DORMANT_DAYS_MIN, p99: Math.max(populationP99, 1) }, type: QueryTypes.SELECT }
    );
    for (const d of dormant) {
      out.push({
        userId: d.userId, category: 'transfer', reason: 'reactivation_apres_dormance', score: 4,
        detail: `réactivé après ${Math.round(Number(d.dormantDays))} jours d'inactivité pour envoyer ${Number(d.total).toFixed(2)} NF sur ${d.cnt} transfert(s)`,
        amount: null // montant envoyé, déjà sorti du compte
      });
    }

    // Comptes tout frais qui agissent à la même minute : plusieurs identités
    // distinctes créées récemment mais synchronisées à la seconde près sur
    // leurs transferts sortants — plus vraisemblablement UN opérateur derrière
    // plusieurs comptes (sybil) qu'une coïncidence entre inconnus.
    const synced = await sequelize.query(
      `WITH bucketed AS (
         SELECT t.from_user_id AS "userId", date_trunc('minute', t.created_at) AS minute
         FROM transactions t
         JOIN users u ON u.id = t.from_user_id
         WHERE t.currency_id = :currencyId AND t.type = 'TRANSFER' AND t.created_at >= :since AND (t.metadata->>'ledger') = 'P2P'
           AND ${sysExcl('t')} AND u.created_at >= :since::timestamptz - (:freshHours || ' hours')::interval
         GROUP BY t.from_user_id, date_trunc('minute', t.created_at)
       )
       SELECT minute, COUNT(DISTINCT "userId") AS accounts, array_agg(DISTINCT "userId") AS "userIds"
       FROM bucketed
       GROUP BY minute
       HAVING COUNT(DISTINCT "userId") >= :minAccounts
       LIMIT 100`,
      { replacements: { currencyId, since, systemIds, freshHours: SYNC_FRESH_WINDOW_HOURS, minAccounts: SYNC_MIN_ACCOUNTS }, type: QueryTypes.SELECT }
    );
    for (const row of synced) {
      const ids = Array.isArray(row.userIds) ? row.userIds : [];
      const detail = `${ids.length} comptes créés récemment ont transféré à la même minute (${new Date(row.minute).toISOString()}) — coordination probable`;
      for (const uid of ids) out.push({ userId: uid, category: 'transfer', reason: 'activite_synchronisee_multi_comptes', score: 4, detail, amount: null });
    }

    // Montants systématiquement ronds : la structuration/le blanchiment
    // artisanal utilise souvent des sommes rondes pour "faire compte rond",
    // contrairement à un usage organique qui produit des montants variés.
    const roundNumbers = await sequelize.query(
      `SELECT from_user_id AS "userId", COUNT(*) AS cnt,
              SUM(CASE WHEN amount >= 100 AND MOD(amount::numeric, 100) = 0 THEN 1 ELSE 0 END)::float / COUNT(*) AS "roundRatio",
              SUM(amount) AS total
       FROM transactions
       WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at >= :since AND (metadata->>'ledger') = 'P2P' AND ${sysExcl()}
       GROUP BY from_user_id
       HAVING COUNT(*) >= :minSample
         AND SUM(CASE WHEN amount >= 100 AND MOD(amount::numeric, 100) = 0 THEN 1 ELSE 0 END)::float / COUNT(*) >= :ratio
       LIMIT 200`,
      { replacements: { currencyId, since, systemIds, minSample: ROUND_NUMBER_MIN_SAMPLE, ratio: ROUND_NUMBER_RATIO }, type: QueryTypes.SELECT }
    );
    for (const r of roundNumbers) {
      out.push({
        userId: r.userId, category: 'transfer', reason: 'montants_ronds_systematiques', score: 2,
        detail: `${(Number(r.roundRatio) * 100).toFixed(0)}% de ses ${r.cnt} transferts sont des montants ronds (multiples de 100 NF)`,
        amount: null // montant envoyé, déjà sorti du compte
      });
    }

    // Minage puis sortie quasi immédiate, RÉPÉTÉE : l'argent gagné au minage
    // repart vers un autre compte en moins d'une heure, plusieurs fois — un
    // schéma de layering (dissocier vite l'origine des fonds), pas un simple
    // montant de transfert isolé.
    const mineCashout = await sequelize.query(
      `WITH mining_wins AS (
         SELECT winner_user_id AS "userId", solved_at
         FROM mining_rounds
         WHERE currency_id = :currencyId AND status = 'solved' AND solved_at >= :since AND winner_user_id IS NOT NULL
       )
       SELECT m."userId", COUNT(*) AS occurrences
       FROM mining_wins m
       JOIN transactions t
         ON t.from_user_id = m."userId" AND t.type = 'TRANSFER' AND (t.metadata->>'ledger') = 'P2P'
        AND t.currency_id = :currencyId AND t.to_user_id NOT IN (:systemIds)
        AND t.created_at > m.solved_at AND t.created_at <= m.solved_at + (:windowHours || ' hours')::interval
       GROUP BY m."userId"
       HAVING COUNT(*) >= :minOccurrences
       LIMIT 200`,
      { replacements: { currencyId, since, systemIds, windowHours: MINE_CASHOUT_WINDOW_HOURS, minOccurrences: MINE_CASHOUT_MIN_OCCURRENCES }, type: QueryTypes.SELECT }
    );
    for (const mc of mineCashout) {
      out.push({
        userId: mc.userId, category: 'mining', reason: 'minage_puis_transfert_immediat', score: 3,
        detail: `${mc.occurrences} fois où un gain de minage a été retransféré à un autre compte en moins de ${MINE_CASHOUT_WINDOW_HOURS}h — dissociation rapide de l'origine des fonds`,
        amount: null // montant déjà retransféré ailleurs
      });
    }

    return out;
  }

  /**
   * Transferts P2P : grosses sommes RELATIVES à la population et à l'historique
   * propre du compte (pas de montant fixe), aller-retours rapprochés,
   * concentration, cycles de blanchiment à 3 comptes, compte tout frais.
   */
  static async _scanTransfers(currencyId, since) {
    const out = [];
    const systemIds = [...SYSTEM_ACCOUNT_IDS];
    // Tous les comptes système (trésorerie, PolicierCongo) sont exclus de la
    // POPULATION analysée, pas seulement des résultats finaux : sinon leurs
    // flux massifs/automatisés faussent le centile et la moyenne "normale",
    // et un utilisateur qui interagit beaucoup avec le bot (paiement de
    // frais, récompense) ressort à tort comme concentré/suspect.
    const sysExcl = (alias) => `${alias ? `${alias}.` : ''}from_user_id NOT IN (:systemIds) AND ${alias ? `${alias}.` : ''}to_user_id NOT IN (:systemIds)`;

    // Centile réel de la population de transferts sur la fenêtre — s'adapte
    // automatiquement à l'usage réel au lieu d'un montant NF codé en dur que
    // n'importe qui peut apprendre à éviter.
    const [{ p99 } = {}] = await sequelize.query(
      `SELECT percentile_cont(:pct) WITHIN GROUP (ORDER BY amount) AS p99
       FROM transactions
       WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at >= :since AND (metadata->>'ledger') = 'P2P' AND ${sysExcl()}`,
      { replacements: { currencyId, since, pct: LARGE_TRANSFER_PERCENTILE, systemIds }, type: QueryTypes.SELECT }
    );
    const populationP99 = Number(p99) || 0;

    if (populationP99 > 0) {
      const large = await sequelize.query(
        `SELECT id, from_user_id AS "fromUserId", to_user_id AS "toUserId", amount
         FROM transactions
         WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at >= :since
           AND (metadata->>'ledger') = 'P2P' AND amount >= :p99 AND ${sysExcl()}
         ORDER BY amount DESC LIMIT 200`,
        { replacements: { currencyId, since, p99: populationP99, systemIds }, type: QueryTypes.SELECT }
      );
      for (const t of large) {
        const ratio = Number(t.amount) / populationP99;
        out.push({
          userId: t.fromUserId, category: 'transfer', reason: 'transfert_hors_norme_population', score: Math.min(5, 2 + Math.floor(ratio)),
          detail: `${Number(t.amount).toFixed(2)} NF envoyés — ${ratio.toFixed(1)}x le 99e centile de tous les transferts de la période (tx ${t.id})`,
          amount: null // montant envoyé, déjà sorti du compte de l'expéditeur
        });
        // L'argent envoyé est probablement encore chez le DESTINATAIRE (sauf
        // s'il l'a déjà dépensé/retransféré) — c'est là qu'il y a réellement
        // quelque chose à retirer, pas chez l'expéditeur dont le compte est
        // déjà vide de cette somme. Score plus bas : recevoir un gros virement
        // est moins suspect en soi qu'en envoyer un (le destinataire peut être
        // totalement innocent), mais le montant reste identifié pour l'admin.
        out.push({
          userId: t.toUserId, category: 'transfer', reason: 'reception_transfert_hors_norme', score: 2,
          detail: `A reçu ${Number(t.amount).toFixed(2)} NF — ${ratio.toFixed(1)}x le 99e centile de tous les transferts de la période (tx ${t.id})`,
          amount: Number(t.amount)
        });
      }
    }

    // Déviation par rapport à SA PROPRE moyenne : un compte qui envoie
    // habituellement 10 NF et en envoie soudain 5000 est bien plus anormal
    // qu'un compte qui brasse déjà de grosses sommes en routine — un seuil
    // global ne peut pas voir cette différence, l'historique personnel oui.
    const personalOutliers = await sequelize.query(
      `WITH per_user AS (
         SELECT from_user_id AS "userId", AVG(amount) AS mean, STDDEV_POP(amount) AS sd, COUNT(*) AS cnt
         FROM transactions
         WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at >= :since AND (metadata->>'ledger') = 'P2P' AND ${sysExcl()}
         GROUP BY from_user_id HAVING COUNT(*) >= :minSample
       )
       SELECT t.id, t.from_user_id AS "fromUserId", t.to_user_id AS "toUserId", t.amount, u.mean, u.sd
       FROM transactions t
       JOIN per_user u ON u."userId" = t.from_user_id
       WHERE t.currency_id = :currencyId AND t.type = 'TRANSFER' AND t.created_at >= :since AND (t.metadata->>'ledger') = 'P2P'
         AND t.amount > u.mean + :dev * GREATEST(u.sd, u.mean * 0.1) AND t.to_user_id NOT IN (:systemIds)
       ORDER BY t.amount DESC LIMIT 200`,
      { replacements: { currencyId, since, minSample: PERSONAL_BASELINE_MIN_SAMPLE, dev: PERSONAL_BASELINE_DEVIATION, systemIds }, type: QueryTypes.SELECT }
    );
    for (const o of personalOutliers) {
      const sd = Math.max(Number(o.sd) || 0, Number(o.mean) * 0.1);
      const devs = sd > 0 ? (Number(o.amount) - Number(o.mean)) / sd : 0;
      out.push({
        userId: o.fromUserId, category: 'transfer', reason: 'ecart_a_son_propre_historique', score: Math.min(6, 3 + Math.floor(devs - PERSONAL_BASELINE_DEVIATION)),
        detail: `${Number(o.amount).toFixed(2)} NF vs sa moyenne habituelle de ${Number(o.mean).toFixed(2)} NF (≈${devs.toFixed(1)} écarts-types au-dessus)`,
        amount: null // montant envoyé, déjà sorti du compte de l'expéditeur
      });
      // Même logique que pour le signal de population : l'argent est
      // probablement encore chez le destinataire.
      out.push({
        userId: o.toUserId, category: 'transfer', reason: 'reception_ecart_historique_expediteur', score: 2,
        detail: `A reçu ${Number(o.amount).toFixed(2)} NF d'un compte dont c'est ${devs.toFixed(1)} écarts-types au-dessus de sa moyenne habituelle`,
        amount: Number(o.amount)
      });
    }

    // Aller-retour rapproché entre deux comptes (A→B puis B→A dans la fenêtre) :
    // self-join sur les transferts P2P, une paire ordonnée = un aller-retour.
    const washTrades = await sequelize.query(
      `SELECT a.from_user_id AS "userA", a.to_user_id AS "userB", COUNT(*) AS pairs,
              SUM(a.amount) AS "volumeOut"
       FROM transactions a
       JOIN transactions b
         ON b.from_user_id = a.to_user_id AND b.to_user_id = a.from_user_id
        AND b.currency_id = a.currency_id
        AND (b.metadata->>'ledger') = 'P2P'
        AND b.created_at > a.created_at
        AND b.created_at <= a.created_at + (:windowHours || ' hours')::interval
       WHERE a.currency_id = :currencyId AND a.type = 'TRANSFER' AND a.created_at >= :since
         AND (a.metadata->>'ledger') = 'P2P' AND ${sysExcl('a')}
       GROUP BY a.from_user_id, a.to_user_id
       HAVING COUNT(*) >= 1
       LIMIT 200`,
      { replacements: { currencyId, since, windowHours: WASH_TRADE_WINDOW_HOURS, systemIds }, type: QueryTypes.SELECT }
    );
    for (const w of washTrades) {
      const detail = `${w.pairs} aller-retour(s) avec un même compte en moins de ${WASH_TRADE_WINDOW_HOURS}h (${Number(w.volumeOut).toFixed(2)} NF)`;
      // Aller-retour : chaque compte a autant envoyé que reçu, effet net quasi
      // nul sur le solde de chacun — rien de spécifique à retirer ici.
      out.push({ userId: w.userA, category: 'transfer', reason: 'aller_retour_rapide', score: 3, detail, amount: null });
      out.push({ userId: w.userB, category: 'transfer', reason: 'aller_retour_rapide', score: 3, detail, amount: null });
    }

    // Cycle de blanchiment à 3 comptes (A→B→C→A) : plus dur à repérer qu'un
    // simple aller-retour puisque l'argent ne revient jamais directement à
    // l'expéditeur, il transite par un intermédiaire — signal indépendant du
    // aller-retour ci-dessus, qui ne voit que les paires directes.
    const cycles = await sequelize.query(
      `SELECT DISTINCT a.from_user_id AS "userA", a.to_user_id AS "userB", b.to_user_id AS "userC", c.amount AS "returnAmount"
       FROM transactions a
       JOIN transactions b
         ON b.from_user_id = a.to_user_id AND b.to_user_id != a.from_user_id
        AND b.currency_id = a.currency_id AND (b.metadata->>'ledger') = 'P2P'
        AND b.to_user_id NOT IN (:systemIds)
        AND b.created_at > a.created_at AND b.created_at <= a.created_at + (:windowHours || ' hours')::interval
       JOIN transactions c
         ON c.from_user_id = b.to_user_id AND c.to_user_id = a.from_user_id
        AND c.currency_id = a.currency_id AND (c.metadata->>'ledger') = 'P2P'
        AND c.created_at > b.created_at AND c.created_at <= a.created_at + (:windowHours || ' hours')::interval
       WHERE a.currency_id = :currencyId AND a.type = 'TRANSFER' AND a.created_at >= :since AND (a.metadata->>'ledger') = 'P2P'
         AND a.to_user_id NOT IN (:systemIds)
       LIMIT 200`,
      { replacements: { currencyId, since, windowHours: LAUNDER_CYCLE_WINDOW_HOURS, systemIds: [...SYSTEM_ACCOUNT_IDS] }, type: QueryTypes.SELECT }
    );
    for (const c of cycles) {
      const detail = `Cycle de transferts ${c.userA} → ${c.userB} → ${c.userC} → retour en moins de ${LAUNDER_CYCLE_WINDOW_HOURS}h — argent qui revient par un intermédiaire`;
      out.push({ userId: c.userB, category: 'transfer', reason: 'cycle_de_transferts', score: 4, detail, amount: null });
      out.push({ userId: c.userC, category: 'transfer', reason: 'cycle_de_transferts', score: 4, detail, amount: null });
      // userA reçoit le DERNIER segment du cycle (C→A) : cet argent vient tout
      // juste de revenir dans son portefeuille, contrairement aux deux autres
      // comptes qui n'ont fait que faire transiter les fonds.
      out.push({
        userId: c.userA, category: 'transfer', reason: 'cycle_de_transferts', score: 4,
        detail: `${detail} — ${Number(c.returnAmount).toFixed(2)} NF reçus au retour du cycle`,
        amount: Number(c.returnAmount)
      });
    }

    // Concentration : un compte dont l'essentiel du volume sortant va vers UN seul destinataire.
    const concentration = await sequelize.query(
      `WITH per_pair AS (
         SELECT from_user_id AS "userId", to_user_id AS "counterpart", SUM(amount) AS volume, COUNT(*) AS cnt
         FROM transactions
         WHERE currency_id = :currencyId AND type = 'TRANSFER' AND created_at >= :since AND (metadata->>'ledger') = 'P2P' AND ${sysExcl()}
         GROUP BY from_user_id, to_user_id
       ), per_user AS (
         SELECT "userId", SUM(volume) AS total, SUM(cnt) AS "totalCount"
         FROM per_pair GROUP BY "userId"
       )
       SELECT p."userId", p.counterpart, p.volume, u.total, u."totalCount"
       FROM per_pair p
       JOIN per_user u ON u."userId" = p."userId"
       WHERE u."totalCount" >= :minTransfers AND p.volume >= u.total * :ratio
       LIMIT 200`,
      { replacements: { currencyId, since, minTransfers: CONCENTRATION_MIN_TRANSFERS, ratio: CONCENTRATION_RATIO, systemIds }, type: QueryTypes.SELECT }
    );
    for (const c of concentration) {
      out.push({
        userId: c.userId, category: 'transfer', reason: 'flux_concentre_sur_un_compte', score: 3,
        detail: `${(100 * c.volume / c.total).toFixed(0)}% du volume sortant (${c.totalCount} transferts) va vers un seul compte`,
        amount: null // montant envoyé, déjà sorti du compte
      });
    }

    // Compte créé depuis peu qui bouge déjà une somme dans le haut de la
    // distribution réelle (même centile relatif que le signal "hors norme"
    // ci-dessus, pas un montant fixe distinct à retenir).
    if (populationP99 > 0) {
      const fresh = await sequelize.query(
        `SELECT t.from_user_id AS "fromUserId", t.amount
         FROM transactions t
         JOIN users u ON u.id = t.from_user_id
         WHERE t.currency_id = :currencyId AND t.type = 'TRANSFER' AND t.created_at >= :since
           AND (t.metadata->>'ledger') = 'P2P' AND t.amount >= :p99 * 0.5 AND ${sysExcl('t')}
           AND t.created_at <= u.created_at + (:hours || ' hours')::interval
         LIMIT 200`,
        { replacements: { currencyId, since, p99: populationP99, hours: FRESH_ACCOUNT_HOURS, systemIds }, type: QueryTypes.SELECT }
      );
      for (const f of fresh) {
        out.push({ userId: f.fromUserId, category: 'transfer', reason: 'compte_recent_grosse_somme', score: 4, detail: `${Number(f.amount).toFixed(2)} NF envoyés dans les ${FRESH_ACCOUNT_HOURS}h suivant la création du compte` });
      }
    }

    return out;
  }

  /** Minage : plafond quotidien tapé plusieurs jours de suite, victoires trop rapprochées pour être manuelles. */
  static async _scanMining(currencyId, since) {
    const out = [];

    const cappedStreak = await sequelize.query(
      `WITH daily AS (
         SELECT winner_user_id AS "userId", date_trunc('day', solved_at) AS day, COUNT(*) AS wins
         FROM mining_rounds
         WHERE currency_id = :currencyId AND status = 'solved' AND solved_at >= :since AND winner_user_id IS NOT NULL
         GROUP BY winner_user_id, date_trunc('day', solved_at)
       )
       SELECT "userId", COUNT(*) AS "daysAtCap"
       FROM daily WHERE wins >= :cap
       GROUP BY "userId" HAVING COUNT(*) >= :minDays
       LIMIT 200`,
      { replacements: { currencyId, since, cap: MINING_DAILY_WIN_LIMIT, minDays: MINING_CAP_STREAK_DAYS }, type: QueryTypes.SELECT }
    );
    for (const c of cappedStreak) {
      out.push({ userId: c.userId, category: 'mining', reason: 'minage_au_plafond_repete', score: 3, detail: `${MINING_DAILY_WIN_LIMIT} rounds gagnés (le plafond quotidien) sur ${c.daysAtCap} jours différents`, amount: null });
    }

    // Écart médian entre victoires consécutives trop court pour un client humain.
    const fastGaps = await sequelize.query(
      `WITH ordered AS (
         SELECT winner_user_id AS "userId", solved_at,
                LAG(solved_at) OVER (PARTITION BY winner_user_id ORDER BY solved_at) AS prev_solved_at
         FROM mining_rounds
         WHERE currency_id = :currencyId AND status = 'solved' AND solved_at >= :since AND winner_user_id IS NOT NULL
       ), gaps AS (
         SELECT "userId", EXTRACT(EPOCH FROM (solved_at - prev_solved_at)) AS gap_seconds
         FROM ordered WHERE prev_solved_at IS NOT NULL
       )
       SELECT "userId", COUNT(*) AS samples, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_seconds) AS median_gap
       FROM gaps
       GROUP BY "userId"
       HAVING COUNT(*) >= :minSamples AND PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_seconds) < :minGap
       LIMIT 200`,
      { replacements: { currencyId, since, minSamples: MINING_MIN_GAP_SAMPLES, minGap: MINING_MIN_GAP_SECONDS }, type: QueryTypes.SELECT }
    );
    for (const g of fastGaps) {
      out.push({ userId: g.userId, category: 'mining', reason: 'minage_cadence_suspecte', score: 5, detail: `écart médian de ${Number(g.median_gap).toFixed(1)}s entre victoires sur ${g.samples} rounds — rythme peu plausible pour un client manuel`, amount: null });
    }

    return out;
  }

  /**
   * Casino : taux de gain trop élevé par rapport à la chance annoncée, profit
   * cumulé anormal, rafales de paris. `casino_bets` porte un `currency_id`
   * (le casino existe sur n'importe quelle monnaie active, pas seulement le
   * NF) : le taux de gain (ratio, indépendant de l'unité) peut se calculer
   * toutes monnaies confondues par utilisateur, mais le PROFIT (`netProfit`)
   * est une somme en unités monétaires — mélanger plusieurs monnaies dans un
   * seul total n'aurait aucun sens (10 NF + 10 d'une monnaie communautaire à
   * 0,08 € ne fait pas "20" de quoi que ce soit), donc ce signal est groupé
   * par (utilisateur, monnaie).
   */
  static async _scanCasino(since, currencies = []) {
    const out = [];
    const currencyMap = new Map(currencies.map(c => [c.id, c]));

    const winRate = await sequelize.query(
      `SELECT user_id AS "userId", currency_id AS "currencyId", COUNT(*) AS bets, AVG(win_chance) / 100.0 AS "avgChance",
              SUM(CASE WHEN won THEN 1 ELSE 0 END)::float / COUNT(*) AS "actualRate",
              SUM(payout - bet_amount) AS "netProfit"
       FROM casino_bets
       WHERE created_at >= :since
       GROUP BY user_id, currency_id
       HAVING COUNT(*) >= :minSample
       LIMIT 500`,
      { replacements: { since, minSample: CASINO_MIN_SAMPLE }, type: QueryTypes.SELECT }
    );
    for (const w of winRate) {
      const n = Number(w.bets);
      const symbol = currencyMap.get(w.currencyId)?.symbol || '?';
      const p = Math.max(0.001, Math.min(0.999, Number(w.avgChance)));
      const stddev = Math.sqrt(n * p * (1 - p)) / n;
      const z = stddev > 0 ? (Number(w.actualRate) - p) / stddev : 0;
      if (z >= 3) {
        out.push({
          userId: w.userId, category: 'casino', reason: 'taux_de_gain_casino_anormal', score: Math.min(6, 3 + Math.floor(z - 3)),
          detail: `taux de gain ${(w.actualRate * 100).toFixed(1)}% observé sur ${n} paris (${symbol}) vs ${(p * 100).toFixed(1)}% attendu (z≈${z.toFixed(1)})`,
          amount: null, // le solde gagné reste dans le portefeuille : voir profit_casino_cumule_positif ci-dessous pour le montant
          currencyId: w.currencyId, currencySymbol: symbol
        });
      }
      if (Number(w.netProfit) > 0 && n >= CASINO_MIN_SAMPLE * 2) {
        out.push({
          userId: w.userId, category: 'casino', reason: 'profit_casino_cumule_positif', score: 2,
          detail: `profit net cumulé de +${Number(w.netProfit).toFixed(2)} ${symbol} sur ${n} paris malgré l'avantage maison`,
          amount: Number(w.netProfit), // gains excédentaires encore dans le portefeuille (plafonné au solde réel par le scan)
          currencyId: w.currencyId, currencySymbol: symbol
        });
      }
    }

    // Rafales de paris quasi simultanés (comportement automatisé).
    const bursts = await sequelize.query(
      `WITH buckets AS (
         SELECT user_id AS "userId", date_trunc('minute', created_at) AS minute, COUNT(*) AS bets
         FROM casino_bets
         WHERE created_at >= :since
         GROUP BY user_id, date_trunc('minute', created_at)
       )
       SELECT "userId", MAX(bets) AS "maxBetsPerMinute"
       FROM buckets
       GROUP BY "userId"
       HAVING MAX(bets) >= :minBets
       LIMIT 200`,
      { replacements: { since, minBets: Math.floor(CASINO_BURST_MIN_BETS * 60 / CASINO_BURST_WINDOW_SECONDS) }, type: QueryTypes.SELECT }
    );
    for (const b of bursts) {
      out.push({ userId: b.userId, category: 'casino', reason: 'rafale_de_paris', score: 2, detail: `jusqu'à ${b.maxBetsPerMinute} paris en une minute — cadence bot probable`, amount: null });
    }

    return out;
  }
}

module.exports = FraudScanService;
