const { QueryTypes } = require('sequelize');
const { sequelize } = require('../database/index');
const logger = require('../utils/logger');
const {
  P2P_VELOCITY_WINDOW_MIN,
  P2P_VELOCITY_REVIEW_COUNT,
  P2P_VELOCITY_BLOCK_COUNT,
  P2P_SAME_RECIPIENT_WINDOW_MIN,
  P2P_SAME_RECIPIENT_MAX_COUNT,
  P2P_FANIN_WINDOW_MIN,
  P2P_FANIN_MAX_SENDERS,
  P2P_CIRCULAR_WINDOW_HOURS,
  P2P_CIRCULAR_AMOUNT_TOLERANCE,
  P2P_NEW_RECIPIENT_BALANCE_RATIO,
  P2P_DRAIN_BALANCE_RATIO,
  P2P_DRAIN_HISTORICAL_MULTIPLE,
  P2P_BLOCK_SCORE,
  P2P_REVIEW_SCORE
} = require('./constants');

/**
 * Détecteur de fraude dédié aux transferts P2P (utilisateur → utilisateur).
 *
 * `checkTransaction` (middleware/fraudMiddleware.js → service Rust) a été
 * conçu pour les PAIEMENTS PAR CARTE (merchantId, cardToken, billingZip...) :
 * appliqué tel quel sur `/new-economy/transfer`, il recevait des champs
 * bidons (currencyId recyclé en merchantId, pas de carte) et un `body.amount`
 * BRUT — faux quand le virement est saisi en EUR, puisque la conversion en
 * NF n'a lieu qu'ensuite dans le contrôleur. Le détecteur Rust ne voyait donc
 * jamais le vrai montant ni un signal de paiement pertinent.
 *
 * Ici on regarde le vrai graphe des transferts internes (table `transactions`,
 * lignes `type='TRANSFER'` + `metadata.ledger='P2P'`, déjà indexées sur
 * from_user_id/to_user_id/created_at) pour détecter les patterns classiques
 * d'abus P2P : rafale de virements, drain de solde soudain, aller-retour
 * circulaire (wash trading / collusion), et compte collecteur ("mule") qui
 * reçoit de nombreux expéditeurs distincts en peu de temps.
 *
 * Chaque signal ajoute un poids à un score 0-100 ; le verdict final est
 * allow / review / block selon des seuils configurables (constants.js).
 * Aucune dépendance à Rust/Redis : requêtes SQL directes, donc disponible
 * même si le service Rust est down (contrairement à `checkTransaction`, qui
 * fail-open silencieusement dans ce cas).
 */
class P2PFraudDetector {
  static async _fetchSignals(fromUserId, toUserId) {
    const [senderStats] = await sequelize.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${P2P_VELOCITY_WINDOW_MIN} minutes') AS velocity_count,
         COUNT(*) FILTER (
           WHERE to_user_id = :toUserId
             AND created_at > NOW() - INTERVAL '${P2P_SAME_RECIPIENT_WINDOW_MIN} minutes'
         ) AS same_recipient_count,
         COUNT(*) FILTER (WHERE to_user_id = :toUserId) AS ever_sent_to_recipient,
         COALESCE(MAX(amount), 0) AS historical_max_amount
       FROM transactions
       WHERE from_user_id = :fromUserId
         AND type = 'TRANSFER'
         AND status = 'COMPLETED'
         AND metadata->>'ledger' = 'P2P'`,
      { type: QueryTypes.SELECT, replacements: { fromUserId, toUserId } }
    );

    const [fanIn] = await sequelize.query(
      `SELECT COUNT(DISTINCT from_user_id) AS distinct_senders
       FROM transactions
       WHERE to_user_id = :toUserId
         AND type = 'TRANSFER'
         AND status = 'COMPLETED'
         AND metadata->>'ledger' = 'P2P'
         AND created_at > NOW() - INTERVAL '${P2P_FANIN_WINDOW_MIN} minutes'`,
      { type: QueryTypes.SELECT, replacements: { toUserId } }
    );

    const [reverseFlow] = await sequelize.query(
      `SELECT amount
       FROM transactions
       WHERE from_user_id = :toUserId
         AND to_user_id = :fromUserId
         AND type = 'TRANSFER'
         AND status = 'COMPLETED'
         AND metadata->>'ledger' = 'P2P'
         AND created_at > NOW() - INTERVAL '${P2P_CIRCULAR_WINDOW_HOURS} hours'
       ORDER BY created_at DESC
       LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { fromUserId, toUserId } }
    );

    return {
      velocityCount: Number(senderStats?.velocity_count || 0),
      sameRecipientCount: Number(senderStats?.same_recipient_count || 0),
      everSentToRecipient: Number(senderStats?.ever_sent_to_recipient || 0) > 0,
      historicalMaxAmount: Number(senderStats?.historical_max_amount || 0),
      distinctSendersToRecipient: Number(fanIn?.distinct_senders || 0),
      reverseAmount: reverseFlow ? Number(reverseFlow.amount) : null
    };
  }

  /**
   * @param {object} opts
   * @param {string} opts.fromUserId
   * @param {string} opts.toUserId
   * @param {number} opts.amountNf - montant réel en NF (déjà converti si saisi en EUR)
   * @param {number} opts.senderBalanceBefore - solde NF de l'expéditeur avant le virement
   * @returns {Promise<{blocked: boolean, verdict: 'allow'|'review'|'block', score: number, reasons: Array<{code: string, detail: string, weight: number}>}>}
   */
  static async assessTransfer({ fromUserId, toUserId, amountNf, senderBalanceBefore }) {
    const reasons = [];
    let score = 0;

    let signals;
    try {
      signals = await this._fetchSignals(fromUserId, toUserId);
    } catch (e) {
      // Fail open : une panne de la requête d'analyse ne doit jamais bloquer
      // un virement légitime. Les autres protections (solde insuffisant,
      // verrous de portefeuille) restent en place indépendamment.
      logger.warn('[p2p-fraud] signal fetch error (fail open):', e.message);
      return { blocked: false, verdict: 'allow', score: 0, reasons: [] };
    }

    // ── Vélocité : rafale de virements sortants ────────────────────────────
    if (signals.velocityCount >= P2P_VELOCITY_BLOCK_COUNT) {
      score += 60;
      reasons.push({
        code: 'VELOCITY_CRITICAL',
        detail: `${signals.velocityCount} virements en ${P2P_VELOCITY_WINDOW_MIN} min`,
        weight: 60
      });
    } else if (signals.velocityCount >= P2P_VELOCITY_REVIEW_COUNT) {
      score += 25;
      reasons.push({
        code: 'VELOCITY_HIGH',
        detail: `${signals.velocityCount} virements en ${P2P_VELOCITY_WINDOW_MIN} min`,
        weight: 25
      });
    }

    // ── Répétition vers le même destinataire (test de limites / abus de promo) ─
    if (signals.sameRecipientCount >= P2P_SAME_RECIPIENT_MAX_COUNT) {
      score += 20;
      reasons.push({
        code: 'REPEAT_RECIPIENT',
        detail: `${signals.sameRecipientCount} virements vers le même destinataire en ${P2P_SAME_RECIPIENT_WINDOW_MIN} min`,
        weight: 20
      });
    }

    // ── Nouveau destinataire + montant conséquent vs solde ─────────────────
    if (!signals.everSentToRecipient && senderBalanceBefore > 0 &&
        amountNf >= senderBalanceBefore * P2P_NEW_RECIPIENT_BALANCE_RATIO) {
      score += 30;
      reasons.push({
        code: 'NEW_RECIPIENT_LARGE_AMOUNT',
        detail: `Premier virement à ce destinataire, ${Math.round((amountNf / senderBalanceBefore) * 100)}% du solde`,
        weight: 30
      });
    }

    // ── Drain de solde soudain : signature typique d'un compte compromis ───
    const balanceRatio = senderBalanceBefore > 0 ? amountNf / senderBalanceBefore : 0;
    const isAnomalousVsHistory = signals.historicalMaxAmount > 0
      ? amountNf >= signals.historicalMaxAmount * P2P_DRAIN_HISTORICAL_MULTIPLE
      : amountNf > 0; // pas d'historique du tout : premier gros virement = signal en soi
    if (balanceRatio >= P2P_DRAIN_BALANCE_RATIO && isAnomalousVsHistory) {
      score += 35;
      reasons.push({
        code: 'BALANCE_DRAIN',
        detail: `Vide ${Math.round(balanceRatio * 100)}% du solde, ${signals.historicalMaxAmount > 0 ? `${(amountNf / signals.historicalMaxAmount).toFixed(1)}x le virement le plus élevé jusqu'ici` : 'premier gros virement du compte'}`,
        weight: 35
      });
    }

    // ── Flux circulaire : B a renvoyé à A un montant comparable récemment ──
    // (wash trading / collusion entre deux comptes, ou tentative de recyclage
    // de fonds volés vers le compte d'origine).
    if (signals.reverseAmount !== null) {
      const diffRatio = Math.abs(signals.reverseAmount - amountNf) / Math.max(signals.reverseAmount, amountNf);
      if (diffRatio <= P2P_CIRCULAR_AMOUNT_TOLERANCE) {
        score += 40;
        reasons.push({
          code: 'CIRCULAR_FLOW',
          detail: `Flux aller-retour avec ce destinataire dans les ${P2P_CIRCULAR_WINDOW_HOURS}h (montants comparables)`,
          weight: 40
        });
      }
    }

    // ── Fan-in : le destinataire collecte depuis de nombreux comptes ───────
    // (compte "mule" agrégeant des fonds avant retrait/blanchiment).
    if (signals.distinctSendersToRecipient >= P2P_FANIN_MAX_SENDERS) {
      score += 30;
      reasons.push({
        code: 'RECIPIENT_FAN_IN',
        detail: `Destinataire reçu de ${signals.distinctSendersToRecipient} expéditeurs distincts en ${P2P_FANIN_WINDOW_MIN} min`,
        weight: 30
      });
    }

    score = Math.min(100, score);
    const verdict = score >= P2P_BLOCK_SCORE ? 'block' : score >= P2P_REVIEW_SCORE ? 'review' : 'allow';

    if (verdict !== 'allow') {
      logger.warn(`[p2p-fraud] ${verdict.toUpperCase()} fromUser=${fromUserId} toUser=${toUserId} amount=${amountNf} score=${score} reasons=${reasons.map((r) => r.code).join(',')}`);
    }

    return { blocked: verdict === 'block', verdict, score, reasons };
  }
}

module.exports = P2PFraudDetector;
