const { Op } = require('sequelize');
const { User, ImpersonationAlert, Notification } = require('../models');
const { sequelize } = require('../database/index');
const {
  IMPERSONATION_SIMILARITY_THRESHOLD,
  IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS,
} = require('../constants/premiumMarket');
const logger = require('../utils/logger');

/**
 * Veille usurpation — avantage abonné.
 *
 * On surveille trois signaux : un pseudo très proche, une photo de profil
 * identique, une bio recopiée. Aucun ne suffit seul à accuser quelqu'un —
 * des milliers de comptes partagent un avatar par défaut, et deux personnes
 * peuvent porter le même prénom. C'est pour ça que le score combine les
 * signaux et qu'une alerte reste une INFORMATION adressée au compte copié :
 * elle ne masque rien, ne restreint rien, ne sanctionne personne. La décision
 * appartient à la personne concernée, qui signale en un tap si elle le juge
 * utile.
 *
 * Le scan ne regarde que les comptes récents : un compte ouvert il y a trois
 * ans avec un pseudo proche du vôtre n'est pas en train de vous usurper, il
 * était juste là avant.
 */

/**
 * Distance de Levenshtein, en O(n) mémoire.
 *
 * Écrite ici plutôt que tirée de `pg_trgm` : l'extension n'est pas garantie
 * présente sur l'instance, et une fonctionnalité de sécurité qui s'éteint
 * silencieusement parce qu'une extension manque est pire que pas de
 * fonctionnalité du tout.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      current[j + 1] = Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return 0;
  const max = Math.max(x.length, y.length);
  return 1 - levenshtein(x, y) / max;
}

/**
 * Variantes typographiques classiques d'un pseudo : le `l` remplacé par un
 * `1`, le `o` par un zéro, un underscore ajouté. La distance d'édition seule
 * les rate parfois sur les pseudos courts, alors que c'est exactement la
 * méthode la plus utilisée.
 */
function normalizeLookalike(username) {
  return String(username || '')
    .toLowerCase()
    .replace(/[1l|]/g, 'l')
    .replace(/[0o]/g, 'o')
    .replace(/[5s]/g, 's')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Évalue un suspect face à un compte protégé.
 * @returns {{score:number, reasons:string[]}}
 */
function evaluate(target, suspect) {
  const reasons = [];
  let score = 0;

  const nameScore = similarity(target.username, suspect.username);
  const targetNormalized = normalizeLookalike(target.username);
  const suspectNormalized = normalizeLookalike(suspect.username);
  const lookalike = targetNormalized === suspectNormalized;
  // Les suffixes comme "officiel", "support", "fan" ou "levrai" sont une
  // forme d'usurpation classique. La distance globale les pénalisait à tort
  // quand le pseudo copié était court, alors que son identifiant complet est
  // bien présent dans celui du suspect.
  const containsIdentity = targetNormalized.length >= 5
    && suspectNormalized.length !== targetNormalized.length
    && suspectNormalized.includes(targetNormalized);

  if (lookalike) {
    reasons.push('username_lookalike');
    score = Math.max(score, 0.9);
  } else if (nameScore >= IMPERSONATION_SIMILARITY_THRESHOLD) {
    reasons.push('username_similar');
    score = Math.max(score, nameScore);
  } else if (containsIdentity) {
    reasons.push('username_similar');
    score = Math.max(score, 0.82);
  }

  // L'avatar ne compte que s'il est réellement renseigné des deux côtés :
  // deux comptes sans photo ne se ressemblent pas, ils sont juste vides.
  if (target.avatar && suspect.avatar && target.avatar === suspect.avatar) {
    reasons.push('same_avatar');
    score += 0.25;
  }

  const targetBio = String(target.bio || '').trim();
  const suspectBio = String(suspect.bio || '').trim();
  if (targetBio.length >= 20 && targetBio === suspectBio) {
    reasons.push('same_bio');
    score += 0.2;
  }

  // Le nom affiché identique, seul, ne veut rien dire (les homonymes
  // existent) : il ne fait que renforcer un signal déjà présent.
  if (reasons.length && target.full_name && suspect.full_name
    && String(target.full_name).toLowerCase() === String(suspect.full_name).toLowerCase()) {
    reasons.push('same_display_name');
    score += 0.1;
  }

  return { score: Math.min(1, score), reasons };
}

/** Suspects plausibles pour un compte, sans balayer toute la table `users`. */
async function findSuspects(target) {
  const since = new Date(Date.now() - IMPERSONATION_SCAN_MAX_ACCOUNT_AGE_DAYS * 86400000);
  const normalized = normalizeLookalike(target.username);
  // Un fragment du pseudo suffit à ramener les candidats crédibles : une
  // usurpation garde toujours une partie du nom d'origine, sinon elle ne
  // trompe personne.
  const fragment = normalized.slice(0, Math.max(3, Math.floor(normalized.length * 0.6)));
  const where = {
    id: { [Op.ne]: target.id },
    is_active: true,
    is_suspended: false,
    is_data_test: false,
    // Pertinence dans le TEMPS, appliquée à TOUS les signaux.
    [Op.or]: [
      { created_at: { [Op.gte]: since } },
      { updated_at: { [Op.gte]: since } },
    ],
  };
  const attributes = ['id', 'username', 'full_name', 'avatar', 'bio', 'created_at', 'verified'];

  // Un avatar de défaut peut être partagé par des milliers de comptes. La
  // requête unique avec OR et LIMIT 60 était alors entièrement consommée
  // par ces comptes avant d'atteindre le vrai pseudo ressemblant.
  let avatarIsDistinctive = false;
  if (target.avatar) {
    const uses = await User.count({
      where: { avatar: target.avatar, is_active: true, is_data_test: false },
    });
    avatarIsDistinctive = uses <= 12;
  }

  const searches = [
    // Signal prioritaire : le pseudo, avec une enveloppe bien plus large que
    // l'ancien lot mélangé aux avatars.
    User.findAll({
      where: { ...where, username: { [Op.iLike]: `%${fragment}%` } },
      attributes,
      order: [['updated_at', 'DESC']],
      limit: 120,
    }),
    // Repli borné : capte les séparateurs et substitutions (1/l, 0/o) qui
    // cassent une recherche de fragment SQL, puis `evaluate` garde son seuil
    // strict. Les comptes de test étant exclus, ce lot reste utile.
    User.findAll({
      where,
      attributes,
      order: [['updated_at', 'DESC']],
      limit: 200,
    }),
  ];

  if (target.full_name) {
    searches.push(User.findAll({
      where: { ...where, full_name: { [Op.iLike]: String(target.full_name) } },
      attributes,
      order: [['updated_at', 'DESC']],
      limit: 40,
    }));
  }
  if (avatarIsDistinctive) {
    searches.push(User.findAll({
      where: { ...where, avatar: target.avatar },
      attributes,
      order: [['updated_at', 'DESC']],
      limit: 40,
    }));
  }

  const groups = await Promise.all(searches);
  const unique = new Map();
  groups.flat().forEach((candidate) => unique.set(String(candidate.id), candidate));
  return [...unique.values()];
}

/**
 * Scanne un compte et crée les alertes manquantes.
 * @returns {Promise<number>} nombre d'alertes nouvellement créées
 */
async function scanUser(userId) {
  const target = await User.findByPk(userId, {
    attributes: ['id', 'username', 'full_name', 'avatar', 'bio', 'verified', 'is_data_test'],
  });
  if (!target || target.is_data_test) return 0;

  const suspects = await findSuspects(target);
  let created = 0;

  for (const suspect of suspects) {
    const { score, reasons } = evaluate(target, suspect);
    if (!reasons.length || score < IMPERSONATION_SIMILARITY_THRESHOLD) continue;

    // Un compte certifié n'usurpe pas : il a passé une vérification
    // d'identité, et l'alerter dessus ne ferait que du bruit.
    if (suspect.verified) continue;

    const existing = await ImpersonationAlert.findOne({
      where: { user_id: target.id, suspect_id: suspect.id },
    });
    if (existing) {
      // Une alerte écartée ne revient jamais, même si le scan la retrouve :
      // c'est ce qui empêche la fonctionnalité de devenir harcelante.
      if (existing.status === 'dismissed') continue;
      if (Number(existing.score) < score) await existing.update({ score, reasons });
      continue;
    }

    const alert = await ImpersonationAlert.create({
      user_id: target.id,
      suspect_id: suspect.id,
      reasons,
      score,
      suspect_username_at_detection: suspect.username,
    });
    created += 1;

    try {
      await Notification.createNotification({
        recipient_id: target.id,
        type: 'system',
        title: 'Un compte te ressemble',
        message: `@${suspect.username} utilise des éléments proches de ton profil.`,
        priority: 'high',
        content: {
          kind: 'impersonation_alert',
          alert_id: alert.id,
          suspect_id: suspect.id,
          suspect_username: suspect.username,
        },
      });
      await alert.update({ notified_at: new Date() });
    } catch (e) {
      logger.warn('[impersonation] Notification non envoyée:', e.message);
    }
  }

  return created;
}

/**
 * Passage complet : uniquement les abonnés actifs, par lots.
 *
 * Le scan est lourd (une requête de candidats par compte protégé) : le
 * limiter aux abonnés n'est pas qu'une question d'offre, c'est ce qui le rend
 * exécutable.
 */
async function scanAllSubscribers({ limit = 200 } = {}) {
  const subscribers = await sequelize.query(`
    SELECT id FROM users
    WHERE subscription_tier <> 'free'
      AND premium = true
      AND (subscription_expires_at IS NULL OR subscription_expires_at > NOW())
      AND is_active = true
      AND is_suspended = false
      AND COALESCE(is_data_test, false) = false
    ORDER BY last_activity DESC NULLS LAST
    LIMIT :limit
  `, {
    replacements: { limit },
    type: sequelize.QueryTypes.SELECT,
  });

  let created = 0;
  for (const row of subscribers) {
    try {
      created += await scanUser(row.id);
    } catch (e) {
      logger.warn(`[impersonation] Scan de ${row.id} en échec: ${e.message}`);
    }
  }
  if (created) logger.info(`[impersonation] ${created} nouvelle(s) alerte(s)`);
  return created;
}

async function listFor(userId, { status = 'open' } = {}) {
  const where = { user_id: userId };
  if (status !== 'all') where.status = status;

  const rows = await ImpersonationAlert.findAll({
    where,
    include: [{
      model: User,
      as: 'suspect',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'created_at'],
    }],
    order: [['score', 'DESC'], ['created_at', 'DESC']],
    limit: 100,
  });

  return rows.map((r) => ({
    id: r.id,
    score: Number(r.score),
    reasons: r.reasons || [],
    status: r.status,
    detected_at: r.created_at,
    suspect: r.suspect
      ? {
        id: r.suspect.id,
        username: r.suspect.username,
        full_name: r.suspect.full_name,
        avatar: r.suspect.avatar,
        verified: r.suspect.verified,
        account_created_at: r.suspect.created_at,
        // Le pseudo peut avoir changé depuis : l'app affiche les deux, sinon
        // l'alerte devient incompréhensible.
        username_at_detection: r.suspect_username_at_detection,
      }
      : null,
  }));
}

async function dismiss({ userId, alertId }) {
  const alert = await ImpersonationAlert.findByPk(alertId);
  if (!alert) throw new Error('Alerte introuvable');
  if (String(alert.user_id) !== String(userId)) throw new Error('Cette alerte n\'est pas la tienne');
  await alert.update({ status: 'dismissed', dismissed_at: new Date() });
  return alert;
}

/** Marque l'alerte comme signalée ; le signalement lui-même passe par `Report`. */
async function markReported({ userId, alertId, reportId }) {
  const alert = await ImpersonationAlert.findByPk(alertId);
  if (!alert) throw new Error('Alerte introuvable');
  if (String(alert.user_id) !== String(userId)) throw new Error('Cette alerte n\'est pas la tienne');
  await alert.update({ status: 'reported', report_id: reportId || null });
  return alert;
}

module.exports = {
  scanUser,
  scanAllSubscribers,
  listFor,
  dismiss,
  markReported,
  evaluate,
  findSuspects,
  similarity,
  normalizeLookalike,
};
