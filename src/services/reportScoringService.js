/**
 * Notation des signalements.
 *
 * Le système précédent traitait tous les signalements comme équivalents et
 * laissait le signaleur choisir lui-même la gravité de son propre signalement.
 * Résultat : `priority` valait 1 pour 51 lignes sur 53 en prod, et rien ne
 * distinguait un signalement fondé d'un règlement de comptes.
 *
 * Ici trois grandeurs se combinent :
 *   1. la CATÉGORIE      — gravité intrinsèque de ce qui est reproché
 *   2. la FIABILITÉ      — historique du signaleur (ses signalements sont-ils
 *                          habituellement confirmés par les modérateurs ?)
 *   3. la CONVERGENCE    — combien de signaleurs DISTINCTS et indépendants
 *
 * Ce sont les signaleurs distincts qui comptent, pas le nombre de lignes :
 * une personne seule ne peut pas fabriquer une escalade à elle toute seule.
 */

const { Op } = require('sequelize');
const { Report, User, Notification } = require('../models');
const {
  REPORT_CATEGORIES, bumpSeverity, maxSeverity,
} = require('../config/reportCategories');
const logger = require('../utils/logger');

// ── Réglages ─────────────────────────────────────────────────────────
const CFG = {
  // Lissage bayésien de la fiabilité : un nouveau signaleur part neutre
  // plutôt qu'à zéro (sinon personne ne pourrait jamais démarrer).
  credibilityPrior: 0.5,
  credibilityM: 4,
  weightFloor: 0.3,
  weightSpan: 1.2,        // poids ∈ [0.3 … 1.5]

  // Faux signaleur en série : au-delà de ce volume de rejets avec un taux
  // de confirmation très bas, le poids s'effondre au lieu de décroître.
  serialAbuseMinDismissed: 5,
  serialAbuseMaxRate: 0.25,
  serialAbusePenalty: 0.4,

  // Compte tout juste créé : limite le brigading par comptes jetables.
  freshAccountHours: 24,
  freshAccountPenalty: 0.5,

  // Seuils d'escalade sur le score agrégé pondéré.
  escalateInvestigating: 2.5,
  escalateUrgent: 5.0,

  // Quotas anti-spam de signalement.
  maxReportsPerHour: 10,
  maxReportsPerDay: 30,
};

/**
 * Fiabilité d'un signaleur, dans [0.3 … 1.5].
 * Fondée sur le sort de ses signalements passés : confirmés (une sanction a
 * suivi) contre écartés.
 */
async function getReporterWeight(userId) {
  try {
    const [user, upheld, dismissed] = await Promise.all([
      // ⚠ `createdAt`, pas `created_at`. Le modèle User est en
      // `underscored: true` : la COLONNE est `created_at`, mais l'ATTRIBUT
      // Sequelize reste `createdAt`. Demander `created_at` ne lève aucune
      // erreur — la valeur arrive bien dans `dataValues` — mais l'instance
      // n'expose pas de getter pour un nom qui n'est pas un attribut, donc
      // `user.created_at` vaut `undefined` et la pénalité « compte neuf »
      // plus bas ne s'appliquait à personne.
      User.findByPk(userId, { attributes: ['id', 'createdAt', 'verified', 'role'] }),
      Report.count({
        where: {
          reporter_id: userId,
          status: 'resolved',
          resolution_action: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: 'none' }] },
        },
      }),
      Report.count({ where: { reporter_id: userId, status: 'dismissed' } }),
    ]);

    const n = upheld + dismissed;
    const rate = (upheld + CFG.credibilityM * CFG.credibilityPrior) / (n + CFG.credibilityM);
    let weight = CFG.weightFloor + CFG.weightSpan * rate;

    // Faux signaleur en série.
    if (dismissed >= CFG.serialAbuseMinDismissed && rate < CFG.serialAbuseMaxRate) {
      weight *= CFG.serialAbusePenalty;
    }

    // Compte jetable.
    if (user?.createdAt) {
      const ageH = (Date.now() - new Date(user.createdAt).getTime()) / 3600000;
      if (ageH < CFG.freshAccountHours) weight *= CFG.freshAccountPenalty;
    }

    // Un modérateur qui signale sait de quoi il parle.
    if (user && ['moderateur', 'admin', 'superadmin'].includes(user.role)) {
      weight = Math.max(weight, 1.5);
    } else if (user?.verified) {
      weight *= 1.1;
    }

    return Math.max(0.1, Math.min(1.5, Number(weight.toFixed(3))));
  } catch (e) {
    logger.warn(`[reportScoring] getReporterWeight: ${e.message}`);
    return 0.6; // repli neutre : on ne bloque jamais un signalement sur une erreur de scoring
  }
}

/** Poids d'un signalement isolé = gravité de la catégorie × fiabilité. */
function scoreSingleReport(category, reporterWeight) {
  const cat = REPORT_CATEGORIES[category] || REPORT_CATEGORIES.other;
  return Number((cat.weight * reporterWeight).toFixed(3));
}

/**
 * Agrégat des signalements ouverts sur une cible.
 * Ne compte qu'une contribution par signaleur — la plus lourde : signaler
 * cinq fois la même cible ne pèse pas cinq fois.
 */
async function aggregateTarget(targetId, targetType) {
  const open = await Report.findAll({
    where: {
      target_id: targetId,
      target_type: targetType,
      status: { [Op.in]: ['pending', 'investigating'] },
    },
    attributes: ['id', 'reporter_id', 'category', 'weighted_score', 'severity'],
    raw: true,
  });

  const bestByReporter = new Map();
  for (const r of open) {
    const s = Number(r.weighted_score) || 0;
    const prev = bestByReporter.get(r.reporter_id);
    if (!prev || s > prev.score) {
      bestByReporter.set(r.reporter_id, { score: s, category: r.category, severity: r.severity });
    }
  }

  let total = 0;
  let topSeverity = 'low';
  const categoryCount = {};
  for (const v of bestByReporter.values()) {
    total += v.score;
    topSeverity = maxSeverity(topSeverity, v.severity || 'low');
    if (v.category) categoryCount[v.category] = (categoryCount[v.category] || 0) + 1;
  }

  const topCategory = Object.entries(categoryCount)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    totalScore: Number(total.toFixed(3)),
    distinctReporters: bestByReporter.size,
    reportCount: open.length,
    topSeverity,
    topCategory,
    reportIds: open.map((r) => r.id),
  };
}

/**
 * Décide de la gravité, de la priorité et du statut d'un signalement à la
 * lumière de tout ce qui a déjà été signalé sur la même cible.
 *
 * Renvoie aussi `escalated` : c'est ce qui déclenche l'alerte modérateurs.
 */
function evaluateEscalation({ category, aggregate }) {
  const cat = REPORT_CATEGORIES[category] || REPORT_CATEGORIES.other;

  let severity = cat.baseSeverity;
  let priority = cat.basePriority;
  let status = 'pending';
  let escalated = false;
  const reasons = [];

  // Catégories où un seul signalement suffit à ouvrir une revue.
  if (cat.alwaysEscalate) {
    severity = 'critical';
    priority = 5;
    status = 'investigating';
    escalated = true;
    reasons.push(`catégorie « ${cat.label} » — revue immédiate`);
  }

  const { totalScore, distinctReporters } = aggregate;

  // Convergence simple : plusieurs signaleurs indépendants sur la même cible.
  // Ouvre une revue et remonte dans la file, mais NE change PAS la gravité —
  // deux personnes qui signalent ne transforment pas un abus « élevé » en
  // « critique ». Faire monter la gravité ici produisait des signalements
  // classés `critical` avec une priorité 3, incohérence visible en file.
  if (distinctReporters >= 2 && totalScore >= CFG.escalateInvestigating) {
    status = 'investigating';
    priority = Math.max(priority, 3);
    escalated = true;
    reasons.push(`${distinctReporters} signaleurs distincts (score ${totalScore})`);
  }

  // Convergence forte : là seulement la gravité monte d'un cran, et la
  // priorité suit au maximum. Les deux restent alignées.
  if (distinctReporters >= 3 && totalScore >= CFG.escalateUrgent) {
    status = 'investigating';
    priority = 5;
    severity = maxSeverity(severity, bumpSeverity(cat.baseSeverity));
    escalated = true;
    reasons.push(`convergence forte : score ${totalScore} sur ${distinctReporters} signaleurs`);
  }

  // Garde-fou : la priorité ne doit jamais contredire la gravité affichée.
  const floorBySeverity = { low: 1, medium: 2, high: 3, critical: 5 };
  priority = Math.max(priority, floorBySeverity[severity] || 1);

  return { severity, priority, status, escalated, escalationReasons: reasons };
}

/** Quotas : empêche un compte d'ensevelir la file de modération. */
async function checkRateLimit(userId) {
  const now = Date.now();
  const [lastHour, lastDay] = await Promise.all([
    Report.count({
      where: { reporter_id: userId, created_at: { [Op.gt]: new Date(now - 3600000) } },
    }),
    Report.count({
      where: { reporter_id: userId, created_at: { [Op.gt]: new Date(now - 86400000) } },
    }),
  ]);

  if (lastHour >= CFG.maxReportsPerHour) {
    return { allowed: false, retryAfterMin: 60, message: 'Trop de signalements envoyés cette heure-ci. Réessayez plus tard.' };
  }
  if (lastDay >= CFG.maxReportsPerDay) {
    return { allowed: false, retryAfterMin: 1440, message: 'Limite quotidienne de signalements atteinte.' };
  }
  return { allowed: true };
}

/**
 * Informe le signaleur du sort de son signalement.
 * Sans ce retour, signaler ressemble à parler dans le vide — c'est la
 * première raison pour laquelle les gens arrêtent de le faire.
 */
async function notifyReporterOfResolution(report, { action, upheld }) {
  try {
    if (!report?.reporter_id) return;

    const title = upheld ? 'Votre signalement a abouti' : 'Votre signalement a été examiné';
    const message = upheld
      ? 'Merci — nous avons examiné votre signalement et pris une mesure sur le contenu concerné.'
      : 'Merci — après examen, ce contenu ne contrevient pas à nos règles. Votre signalement reste utile.';

    await Notification.create({
      recipient_id: report.reporter_id,
      sender_id: null,
      tweet_id: report.target_type === 'tweet' ? report.target_id : null,
      type: 'system',
      title,
      message,
      // Volontairement sans détail sur la sanction ni sur le compte visé :
      // le signaleur n'a pas à savoir ce qui a été infligé à qui.
      content: { kind: 'report_resolution', report_id: report.id, upheld: !!upheld },
      priority: 'low',
      metadata: { resolution_action: action || null },
    });
  } catch (e) {
    logger.warn(`[reportScoring] notifyReporterOfResolution: ${e.message}`);
  }
}

module.exports = {
  CFG,
  getReporterWeight,
  scoreSingleReport,
  aggregateTarget,
  evaluateEscalation,
  checkRateLimit,
  notifyReporterOfResolution,
};
