const { Op } = require('sequelize');
const { ultraLimit } = require('../utils/ultraGate');
const EconomyLedger = require('../economy/ledger');
const { getPlatformCurrency } = require('../economy/platformCurrency');
const logger = require('../utils/logger');

/**
 * La Forge : les fonctionnalités proposées par les utilisateurs, et leur
 * récompense en NF si elles sont construites.
 *
 * ── Ce que ce fichier protège ─────────────────────────────────────────────
 * Une seule chose compte vraiment ici : **on ne paie jamais deux fois.** Tout
 * le reste est du CRUD. La décision du staff et le versement au grand livre
 * sont deux évènements distincts qui peuvent échouer séparément, et c'est
 * `reward_paid_at` — écrit dans la MÊME transaction que le mouvement de
 * grand livre — qui les réconcilie.
 */

/** Statuts atteignables par une décision du staff. */
const DECISION_STATUSES = ['reviewing', 'accepted', 'built', 'declined'];

/** Zones de l'app proposées au choix. Doit rester alignée sur l'ENUM du modèle. */
const AREAS = ['feed', 'profil', 'messages', 'economie', 'carte', 'video', 'autre'];

/**
 * Nombre d'idées encore en cours qu'un compte peut avoir.
 *
 * Ce n'est pas un anti-spam — le débit est déjà limité ailleurs. C'est une
 * contrainte d'ATTENTION : quelqu'un qui dépose quinze idées d'un coup n'en a
 * réfléchi aucune, et le staff les lit toutes. Trois oblige à choisir, et la
 * limite se libère à chaque décision.
 */
const MAX_OPEN_PER_AUTHOR = 3;
/**
 * Ultra en tient 10.
 *
 * La contrainte d'attention reste : dix idées ouvertes, c'est encore un
 * nombre qu'un humain relit. Ce qui change, c'est qu'un gros compte qui
 * remonte réellement des manques de produit n'a plus à en fermer une pour en
 * ouvrir une autre.
 */
const MAX_OPEN_PER_AUTHOR_ULTRA = 10;

const OPEN_STATUSES = ['received', 'reviewing', 'accepted'];

/** Ce que l'auteur a le droit de voir de sa propre idée. */
function toAuthorView(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    area: row.area,
    status: row.status,
    // Le montant n'est montré QUE lorsqu'il a été décidé. Afficher `null`
    // comme « 0 NF » ferait croire à une décision qui n'a pas eu lieu.
    reward_nf: row.reward_nf === null ? null : Number(row.reward_nf),
    reward_paid: !!row.reward_paid_at,
    staff_note: row.staff_note,
    created_at: row.created_at,
    decided_at: row.decided_at
  };
}

/** Ce que TOUT LE MONDE peut voir d'une idée construite. */
function toPublicView(row) {
  return {
    id: row.id,
    title: row.title,
    area: row.area,
    built_at: row.decided_at,
    reward_nf: row.reward_nf === null ? null : Number(row.reward_nf),
    author: row.author
      ? { username: row.author.username, avatar: row.author.avatar }
      : null
  };
}

/**
 * Dépose une idée.
 *
 * La validation de longueur vit sur le MODÈLE, pas ici : elle doit tenir même
 * si un autre appelant arrive un jour par un autre chemin.
 */
async function create(models, authorId, { title, body, area }) {
  const { FeatureProposal } = models;

  const open = await FeatureProposal.count({
    where: { author_id: authorId, status: { [Op.in]: OPEN_STATUSES } }
  });

  const maxOpen = await ultraLimit({ id: authorId }, MAX_OPEN_PER_AUTHOR_ULTRA, MAX_OPEN_PER_AUTHOR);
  if (open >= maxOpen) {
    return {
      success: false,
      reason: 'too_many_open',
      message: `Tu as déjà ${maxOpen} idées en cours. Attends une réponse avant d'en proposer une autre.`
    };
  }

  const row = await FeatureProposal.create({
    author_id: authorId,
    title: String(title || '').trim(),
    body: String(body || '').trim(),
    area: AREAS.includes(area) ? area : 'autre'
  });

  return { success: true, proposal: toAuthorView(row) };
}

/** Les idées d'un compte, la plus récente d'abord. */
async function listMine(models, authorId) {
  const { FeatureProposal } = models;
  const rows = await FeatureProposal.findAll({
    where: { author_id: authorId },
    order: [['created_at', 'DESC']],
    limit: 50
  });
  return rows.map(toAuthorView);
}

/**
 * Les idées CONSTRUITES, pour la vitrine.
 *
 * C'est la seule preuve que la Forge n'est pas une boîte à lettres morte :
 * sans elle, on demande aux gens d'écrire sans jamais leur montrer que ça
 * aboutit. Le montant y est public — c'est le sujet.
 */
async function listBuilt(models, limit = 20) {
  const { FeatureProposal, User } = models;
  const rows = await FeatureProposal.findAll({
    where: { status: 'built' },
    order: [['decided_at', 'DESC']],
    limit: Math.min(Math.max(Number(limit) || 20, 1), 50),
    include: [{ model: User, as: 'author', attributes: ['username', 'avatar'] }]
  });
  return rows.map(toPublicView);
}

/**
 * L'état de la forge, en chiffres réels.
 *
 * C'est la seule réponse honnête à la question que se pose vraiment quelqu'un
 * devant cet écran : « est-ce que ça paie, ou est-ce que j'écris dans le
 * vide ? » Une grille tarifaire serait un engagement que personne n'a pris ;
 * ce qui a DÉJÀ été versé, lui, ne promet rien et prouve tout.
 *
 * Les compteurs sont volontairement globaux et non par période : « 12 idées
 * construites » se lit ; « 2 ce mois-ci » invite à comparer les mois, ce qui
 * n'a aucun sens pour un flux de cette taille et rend un mois creux
 * décourageant.
 */
async function stats(models) {
  const { FeatureProposal } = models;

  const [counts] = await FeatureProposal.sequelize.query(
    `SELECT
       COUNT(*)::int                                             AS total,
       COUNT(*) FILTER (WHERE status = 'built')::int             AS built,
       COUNT(*) FILTER (WHERE status IN ('reviewing','accepted'))::int AS in_progress,
       COALESCE(SUM(reward_nf) FILTER (WHERE reward_paid_at IS NOT NULL), 0) AS paid_nf
     FROM feature_proposals`
  );

  const row = counts?.[0] || {};
  return {
    total: Number(row.total || 0),
    built: Number(row.built || 0),
    in_progress: Number(row.in_progress || 0),
    // Ce qui a été VERSÉ, pas ce qui a été décidé : promettre un montant
    // décidé mais bloqué par une trésorerie vide serait mentir.
    paid_nf: Number(row.paid_nf || 0),
  };
}

/** La file du staff. */
async function listQueue(models, status = 'received') {
  const { FeatureProposal, User } = models;
  const rows = await FeatureProposal.findAll({
    where: DECISION_STATUSES.includes(status) || status === 'received'
      ? { status }
      : { status: { [Op.in]: OPEN_STATUSES } },
    order: [['created_at', 'ASC']],
    limit: 100,
    include: [{ model: User, as: 'author', attributes: ['id', 'username', 'avatar'] }]
  });
  return rows.map((row) => ({
    ...toAuthorView(row),
    author: row.author
      ? { id: row.author.id, username: row.author.username, avatar: row.author.avatar }
      : null
  }));
}

/**
 * La décision du staff, et le versement s'il y a lieu.
 *
 * ── Pourquoi tout tient dans une transaction ──────────────────────────────
 * Le mouvement de grand livre et l'horodatage `reward_paid_at` doivent vivre
 * ou mourir ensemble. Écrire le statut d'abord, puis payer, laisserait une
 * fenêtre où un plantage donne une idée « construite et récompensée » que
 * personne n'a payée — et un second appel la paierait, sans moyen de savoir
 * que c'est la deuxième fois.
 *
 * ── Pourquoi on relit la ligne avec un verrou ─────────────────────────────
 * Deux membres du staff qui valident la même idée en même temps paieraient
 * deux fois. `SELECT … FOR UPDATE` sérialise les deux appels, et le second
 * voit `reward_paid_at` déjà posé.
 */
async function decide(models, sequelize, staffId, proposalId, { status, rewardNf, note }) {
  const { FeatureProposal } = models;

  if (!DECISION_STATUSES.includes(status)) {
    return { success: false, reason: 'bad_status', message: 'Statut inconnu.' };
  }
  // Un refus sans motif est la façon la plus sûre de ne plus jamais recevoir
  // d'idée de quelqu'un. Le staff doit écrire pourquoi.
  if (status === 'declined' && !String(note || '').trim()) {
    return { success: false, reason: 'note_required', message: 'Un refus doit être motivé.' };
  }

  const amount = rewardNf === undefined || rewardNf === null ? null : Number(rewardNf);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
    return { success: false, reason: 'bad_amount', message: 'Montant invalide.' };
  }

  return sequelize.transaction(async (tx) => {
    const row = await FeatureProposal.findByPk(proposalId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!row) return { success: false, reason: 'not_found', message: 'Idée introuvable.' };

    row.status = status;
    row.staff_note = note === undefined ? row.staff_note : String(note || '').trim() || null;
    row.decided_by = staffId;
    row.decided_at = new Date();
    if (amount !== null) row.reward_nf = amount;

    const payable =
      status === 'built' && !row.reward_paid_at && Number(row.reward_nf) > 0;

    if (payable) {
      const currency = await getPlatformCurrency({ transaction: tx });
      const paid = await EconomyLedger.rewardFromTreasury(
        row.author_id,
        currency.id,
        Number(row.reward_nf),
        `La Forge — « ${row.title} »`,
        tx
      );

      // `rewardFromTreasury` LÈVE si la trésorerie est vide, mais rend un
      // objet `{ success: false }` pour un montant sous le plancher. Les deux
      // doivent empêcher l'horodatage, sinon on marquerait payé sans l'avoir
      // fait — et plus rien ne rattraperait la ligne.
      if (paid && paid.success === false) {
        return { success: false, reason: 'payout_refused', message: paid.reason || 'Versement refusé.' };
      }
      row.reward_paid_at = new Date();
      logger.info(
        `[forge] recompense versee: ${row.reward_nf} NF -> ${row.author_id} (idee ${row.id})`
      );
    }

    await row.save({ transaction: tx });
    return { success: true, proposal: toAuthorView(row) };
  });
}

module.exports = {
  AREAS,
  MAX_OPEN_PER_AUTHOR,
  MAX_OPEN_PER_AUTHOR_ULTRA,
  create,
  stats,
  listMine,
  listBuilt,
  listQueue,
  decide
};
