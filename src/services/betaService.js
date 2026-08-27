'use strict';

/**
 * 🧪 Programme beta — logique métier.
 *
 * Une seule porte : on est sur la version beta de l'app, ou on ne l'est pas.
 * On y entre par liste d'attente et validation d'un admin ; l'appartenance
 * commande ensuite l'attribut de ciblage `is_beta`, donc les drapeaux qui
 * s'appuient dessus (aujourd'hui `fil.refonte2b`).
 *
 * ── La règle qu'aucune méthode ne doit contourner ──
 * TOUT changement de `status` passe par `writeStatus`, qui purge le cache
 * d'attributs de l'utilisateur. Écrire `BetaMember` en direct depuis un
 * contrôleur laisserait le compte jusqu'à cinq minutes sur l'ancien
 * comportement — sans erreur, sans log, avec une interface qui lui promet
 * déjà la nouveauté. C'est le seul défaut vraiment silencieux du système.
 *
 * ── Ce que ce module NE fait pas ──
 * Aucune décision d'affichage, aucune vérification de rôle : le contrôleur
 * garde les routes, le service dit oui ou non et pourquoi. Les erreurs
 * métier sortent en `BetaError` avec un statut HTTP, pour que le contrôleur
 * n'ait pas à réinterpréter des messages.
 */

const { Op, fn, col, literal, QueryTypes } = require('sequelize');
const { BetaMember, BetaSettings, User, sequelize } = require('../models');
const featureFlags = require('./featureFlagService');
const logger = require('../utils/logger');

/** Statut pour lequel `is_beta` vaut vrai. Un seul, et il est nommé ici. */
const MEMBER_STATUS = 'approved';

/** Statuts depuis lesquels une nouvelle candidature est acceptée. */
const CAN_REAPPLY_FROM = ['rejected', 'revoked', 'left'];

class BetaError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'BetaError';
    this.status = status;
    this.extra = extra;
  }
}

// ───────────────────────────── Écriture ─────────────────────────────

/**
 * LE point d'écriture. Applique les champs, puis purge le cache d'attributs.
 *
 * La purge est volontairement en `warn` et non en `error` si elle échoue :
 * l'écriture SQL a réussi, le TTL de cinq minutes fera converger, et le
 * journal de cette API a déjà souffert de fausses erreurs qui masquaient les
 * vraies.
 */
async function writeStatus(member, fields) {
  await member.update(fields);
  try {
    await featureFlags.invalidateUserContext(member.user_id);
  } catch (error) {
    logger.warn(`[beta] Purge du cache d'attributs impossible pour ${member.user_id} : ${error.message}`);
  }
  return member;
}

// ───────────────────────────── Lecture ─────────────────────────────

async function getSettings() {
  return BetaSettings.load();
}

/** Nombre de membres actifs. Sert à la vitrine et au contrôle de capacité. */
async function countMembers() {
  return BetaMember.count({ where: { status: MEMBER_STATUS } });
}

/**
 * Place dans la file, 1 pour le prochain servi.
 *
 * Comptée sur `applied_at` et non sur `created_at` : re-candidater après un
 * refus remet `applied_at` à maintenant et renvoie donc en fin de file, ce
 * qui est le comportement voulu — sans quoi une candidature refusée en
 * janvier reprendrait la tête de file en août.
 */
async function queuePosition(member) {
  if (!member || member.status !== 'pending') return null;
  const ahead = await BetaMember.count({
    where: { status: 'pending', applied_at: { [Op.lt]: member.applied_at } },
  });
  return ahead + 1;
}

/** Vue publique du programme. Ne contient AUCUNE donnée nominative. */
async function publicProgram() {
  const [settings, members] = await Promise.all([getSettings(), countMembers()]);
  const capacity = settings.capacity ?? null;
  return {
    is_open: settings.is_open,
    capacity,
    members,
    seats_left: capacity === null ? null : Math.max(0, capacity - members),
    headline: settings.headline,
    pitch: settings.pitch ?? null,
  };
}

/** Statut d'un compte + l'état du programme, en un aller-retour pour l'app. */
async function statusFor(userId) {
  const [member, program] = await Promise.all([
    BetaMember.findByPk(userId),
    publicProgram(),
  ]);

  const status = member ? member.status : null;
  const isMember = status === MEMBER_STATUS;

  return {
    status,
    is_member: isMember,
    position: await queuePosition(member),
    motivation: member ? member.motivation ?? null : null,
    applied_at: member?.applied_at ? new Date(member.applied_at).toISOString() : null,
    approved_at: member?.approved_at ? new Date(member.approved_at).toISOString() : null,
    reviewed_at: member?.reviewed_at ? new Date(member.reviewed_at).toISOString() : null,
    can_apply: program.is_open && !isMember && status !== 'pending',
    program,
  };
}

// ─────────────────────── Actions de l'utilisateur ───────────────────────

/**
 * Candidater. Idempotent sur `pending` : renvoyer une erreur à qui rappuie
 * sur le bouton n'apprend rien, et perdre sa place dans la file serait pire.
 */
async function apply(userId, { motivation = null, source = null, platform = null, app_version = null } = {}) {
  const settings = await getSettings();
  if (!settings.is_open) {
    throw new BetaError(409, 'Les candidatures à la beta sont fermées pour le moment.');
  }

  const existing = await BetaMember.findByPk(userId);

  if (existing?.status === MEMBER_STATUS) {
    throw new BetaError(409, 'Tu es déjà membre de la beta.');
  }
  if (existing?.status === 'pending') {
    return existing; // Idempotent : `applied_at` n'est pas touché.
  }

  const fields = {
    status: 'pending',
    motivation: motivation ? String(motivation).slice(0, 2000) : null,
    source,
    platform,
    app_version,
    applied_at: new Date(),
    reviewed_at: null,
    reviewed_by: null,
    review_note: null,
    approved_at: null,
    revoked_at: null,
  };

  if (!existing) {
    const created = await BetaMember.create({ user_id: userId, ...fields });
    await featureFlags.invalidateUserContext(userId);
    return created;
  }

  if (!CAN_REAPPLY_FROM.includes(existing.status)) {
    throw new BetaError(409, 'Candidature impossible depuis ce statut.');
  }
  return writeStatus(existing, fields);
}

/** Quitter la beta de son propre chef. Réservé aux membres. */
async function leave(userId) {
  const member = await BetaMember.findByPk(userId);
  if (!member || member.status !== MEMBER_STATUS) {
    throw new BetaError(409, 'Tu n\'es pas membre de la beta.');
  }
  return writeStatus(member, {
    status: 'left',
    revoked_at: new Date(),
  });
}

// ─────────────────────────── Actions admin ───────────────────────────

/**
 * Admettre un compte.
 *
 * La capacité borne l'approbation, jamais la candidature : une file qui
 * continue d'accepter du monde quand les places sont prises est normale.
 * `force` existe parce qu'un admin qui voit le message doit pouvoir passer
 * outre sans aller changer un réglage global.
 */
async function approve(userId, adminId, { force = false, note = null } = {}) {
  const member = await BetaMember.findByPk(userId);
  if (!member) throw new BetaError(404, 'Aucune candidature pour ce compte.');
  if (member.status === MEMBER_STATUS) return member;

  const settings = await getSettings();
  if (settings.capacity !== null && !force) {
    const members = await countMembers();
    if (members >= settings.capacity) {
      throw new BetaError(
        409,
        `Capacité atteinte (${members}/${settings.capacity}). Relance avec « forcer » pour passer outre.`,
        { members, capacity: settings.capacity }
      );
    }
  }

  return writeStatus(member, {
    status: MEMBER_STATUS,
    approved_at: new Date(),
    revoked_at: null,
    reviewed_at: new Date(),
    reviewed_by: adminId,
    review_note: note,
  });
}

/** Refuser une candidature en attente. */
async function reject(userId, adminId, { note = null } = {}) {
  const member = await BetaMember.findByPk(userId);
  if (!member) throw new BetaError(404, 'Aucune candidature pour ce compte.');
  if (member.status !== 'pending') {
    throw new BetaError(409, 'Seule une candidature en attente peut être refusée.');
  }
  return writeStatus(member, {
    status: 'rejected',
    reviewed_at: new Date(),
    reviewed_by: adminId,
    review_note: note,
  });
}

/** Retirer un membre déjà admis. */
async function revoke(userId, adminId, { note = null } = {}) {
  const member = await BetaMember.findByPk(userId);
  if (!member) throw new BetaError(404, 'Aucune candidature pour ce compte.');
  if (member.status !== MEMBER_STATUS) {
    throw new BetaError(409, 'Ce compte n\'est pas membre de la beta.');
  }
  return writeStatus(member, {
    status: 'revoked',
    revoked_at: new Date(),
    reviewed_at: new Date(),
    reviewed_by: adminId,
    review_note: note,
  });
}

/**
 * Ajouter un compte directement, sans passer par la file.
 *
 * Accepte un identifiant OU un pseudo : depuis la console, on connaît le
 * pseudo, jamais l'UUID.
 */
async function invite({ user_id: userId = null, username = null }, adminId, { note = null } = {}) {
  let target = null;
  if (userId) {
    target = await User.findByPk(userId, { attributes: ['id'] });
  } else if (username) {
    target = await User.findOne({
      where: { username: String(username).replace(/^@/, '') },
      attributes: ['id'],
    });
  }
  if (!target) throw new BetaError(404, 'Compte introuvable.');

  const existing = await BetaMember.findByPk(target.id);
  if (existing) return approve(target.id, adminId, { force: true, note });

  const created = await BetaMember.create({
    user_id: target.id,
    status: MEMBER_STATUS,
    source: 'web',
    applied_at: new Date(),
    approved_at: new Date(),
    reviewed_at: new Date(),
    reviewed_by: adminId,
    review_note: note,
  });
  await featureFlags.invalidateUserContext(target.id);
  return created;
}

/**
 * Liste pour la console. Les `pending` d'abord et par ancienneté — c'est
 * l'écran de travail quotidien, il montre ce qu'il y a à traiter.
 */
async function listMembers({ status = null, q = null, limit = 50, offset = 0 } = {}) {
  const where = {};
  if (status) where.status = status;

  const include = [
    {
      model: User,
      as: 'user',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'created_at'],
      required: true,
      ...(q
        ? {
            where: {
              [Op.or]: [
                { username: { [Op.iLike]: `%${String(q).replace(/^@/, '')}%` } },
                { full_name: { [Op.iLike]: `%${q}%` } },
              ],
            },
          }
        : {}),
    },
  ];

  const { rows, count } = await BetaMember.findAndCountAll({
    where,
    include,
    order: [
      [literal("CASE WHEN \"BetaMember\".\"status\" = 'pending' THEN 0 ELSE 1 END"), 'ASC'],
      ['applied_at', 'ASC'],
    ],
    limit: Math.min(Number(limit) || 50, 200),
    offset: Math.max(Number(offset) || 0, 0),
  });

  return { total: count, members: rows };
}

/** Compteurs par statut + candidatures par jour sur 30 jours. */
async function stats() {
  const byStatus = await BetaMember.findAll({
    attributes: ['status', [fn('COUNT', col('user_id')), 'count']],
    group: ['status'],
    raw: true,
  });

  const counts = { pending: 0, approved: 0, rejected: 0, revoked: 0, left: 0 };
  for (const row of byStatus) counts[row.status] = Number(row.count);

  const daily = await sequelize.query(
    `SELECT DATE(applied_at) AS day, COUNT(*)::int AS count
       FROM beta_members
      WHERE applied_at >= NOW() - INTERVAL '30 days'
      GROUP BY day
      ORDER BY day ASC`,
    { type: QueryTypes.SELECT }
  );

  return { counts, daily };
}

async function updateSettings(patch, adminId) {
  const settings = await getSettings();
  const fields = { updated_by: adminId };

  if (patch.is_open !== undefined) fields.is_open = Boolean(patch.is_open);
  if (patch.capacity !== undefined) {
    fields.capacity =
      patch.capacity === null || patch.capacity === '' ? null : Math.max(0, Number(patch.capacity) || 0);
  }
  if (patch.headline !== undefined) fields.headline = String(patch.headline).slice(0, 160);
  if (patch.pitch !== undefined) fields.pitch = patch.pitch ? String(patch.pitch).slice(0, 4000) : null;

  await settings.update(fields);
  return settings;
}

module.exports = {
  BetaError,
  MEMBER_STATUS,
  apply,
  leave,
  approve,
  reject,
  revoke,
  invite,
  listMembers,
  stats,
  statusFor,
  publicProgram,
  getSettings,
  updateSettings,
  countMembers,
  queuePosition,
};
