const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');

const { Contest, ContestEntry, Tweet, User, sequelize } = require('../models');
const { authenticateToken } = require('../middleware/authMiddleware');
const contestService = require('../services/contestService');
const logger = require('../utils/logger');

const AUTHOR_ATTRIBUTES = [
  'id', 'username', 'full_name', 'avatar', 'verified',
  'verification_style', 'premium', 'subscription_tier', 'profile_customization'
];

/**
 * Un concours n'a de sens que rattaché à un tweet visible. La création publie
 * donc le tweet ET le concours dans la même transaction : un concours orphelin
 * (tweet manquant) ou un tweet promettant une cagnotte qui n'existe pas en
 * base sont deux états dont on ne saurait pas se remettre.
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    if (req.user.is_suspended) {
      return res.status(403).json({ success: false, message: 'Compte suspendu.' });
    }

    let payload;
    try {
      payload = contestService.normalizeCreatePayload(req.body);
    } catch (error) {
      if (error instanceof contestService.ContestValidationError) {
        return res.status(error.status).json({ success: false, message: error.message, code: error.code });
      }
      throw error;
    }

    const content = String(req.body.content || '').trim();
    if (!content) {
      return res.status(400).json({
        success: false,
        message: 'Écris le texte du concours (ce que les gens verront dans le fil).',
        code: 'CONTENT_REQUIRED'
      });
    }
    if (content.length > 500) {
      return res.status(400).json({ success: false, message: 'Texte trop long.', code: 'CONTENT_TOO_LONG' });
    }

    const result = await sequelize.transaction(async (transaction) => {
      const tweet = await Tweet.create({
        user_id: req.user.id,
        content,
        tweet_type: 'concours',
        media_urls: Array.isArray(req.body.media_urls) ? req.body.media_urls.slice(0, 4) : [],
        language: req.body.language || 'fr',
      }, { transaction });

      const contest = await Contest.create({
        ...payload,
        tweet_id: tweet.id,
        creator_id: req.user.id,
      }, { transaction });

      return { tweet, contest };
    });

    return res.status(201).json({
      success: true,
      data: {
        tweet: result.tweet,
        contest: result.contest.toPublicJSON(),
      },
    });
  } catch (error) {
    logger.error('[Concours] création impossible:', error);
    return res.status(500).json({ success: false, message: 'Création du concours impossible.' });
  }
});

/** Concours ouverts, le plus proche de sa fin en premier. */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const contests = await Contest.findAll({
      where: { status: 'open', ends_at: { [Op.gt]: new Date() } },
      include: [
        { model: User, as: 'creator', attributes: AUTHOR_ATTRIBUTES },
        { model: Tweet, as: 'tweet', attributes: ['id', 'content', 'media_urls', 'created_at'] },
      ],
      order: [['ends_at', 'ASC']],
      limit: Math.min(Number.parseInt(req.query.limit, 10) || 20, 50),
    });

    return res.json({
      success: true,
      data: contests.map((c) => ({
        ...c.toPublicJSON(),
        creator: c.creator,
        tweet: c.tweet,
      })),
    });
  } catch (error) {
    logger.error('[Concours] liste impossible:', error);
    return res.status(500).json({ success: false, message: 'Liste des concours indisponible.' });
  }
});

/**
 * Détail d'un concours, vu par l'utilisateur courant : l'état de sa
 * participation et, s'il ne remplit pas encore les conditions, la liste
 * exacte de ce qu'il lui reste à faire. C'est cette liste que l'écran de
 * participation affiche — un refus doit toujours dire quoi faire.
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const contest = await loadContest(req.params.id);
    if (!contest) {
      return res.status(404).json({ success: false, message: 'Concours introuvable.' });
    }
    return res.json({ success: true, data: await describeForUser(contest, req.user.id) });
  } catch (error) {
    logger.error('[Concours] détail impossible:', error);
    return res.status(500).json({ success: false, message: 'Concours indisponible.' });
  }
});

/**
 * Même vue, mais retrouvée depuis le tweet. C'est la route qu'appelle la
 * carte du fil : le fil est servi par plusieurs moteurs de recommandation
 * (Node et Rust), y greffer le concours obligerait à modifier chacun d'eux et
 * à espérer qu'aucun ne soit oublié.
 */
router.get('/by-tweet/:tweetId', authenticateToken, async (req, res) => {
  try {
    const contest = await loadContest(null, req.params.tweetId);
    if (!contest) {
      return res.status(404).json({ success: false, message: 'Ce tweet ne porte pas de concours.' });
    }
    return res.json({ success: true, data: await describeForUser(contest, req.user.id) });
  } catch (error) {
    logger.error('[Concours] détail par tweet impossible:', error);
    return res.status(500).json({ success: false, message: 'Concours indisponible.' });
  }
});

/**
 * Participer. Les conditions sont contrôlées ici pour pouvoir répondre tout
 * de suite « il te manque ceci », mais elles seront REVÉRIFIÉES au tirage :
 * participer puis se désabonner ne doit rien rapporter.
 */
router.post('/:id/participate', authenticateToken, async (req, res) => {
  try {
    const contest = await Contest.findByPk(req.params.id);
    if (!contest) {
      return res.status(404).json({ success: false, message: 'Concours introuvable.' });
    }
    if (contest.status !== 'open') {
      return res.status(409).json({
        success: false,
        message: 'Ce concours est terminé.',
        code: 'CONTEST_CLOSED'
      });
    }
    if (new Date(contest.ends_at).getTime() <= Date.now()) {
      return res.status(409).json({
        success: false,
        message: 'Les participations sont closes, le tirage va avoir lieu.',
        code: 'CONTEST_ENDED'
      });
    }
    if (contest.creator_id === req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Tu ne peux pas participer à ton propre concours.',
        code: 'CONTEST_OWNER'
      });
    }
    if (req.user.is_suspended) {
      return res.status(403).json({ success: false, message: 'Compte suspendu.' });
    }

    const check = await contestService.checkConditions(contest, req.user.id);
    if (!check.ok) {
      return res.status(412).json({
        success: false,
        message: 'Il te reste des conditions à remplir.',
        code: 'CONDITIONS_NOT_MET',
        missing: check.missing,
      });
    }

    // findOrCreate + index unique (contest_id, user_id) : deux appuis rapides
    // sur le bouton ne créent qu'une participation.
    const [entry, created] = await ContestEntry.findOrCreate({
      where: { contest_id: contest.id, user_id: req.user.id },
      defaults: { contest_id: contest.id, user_id: req.user.id, entered_at: new Date() },
    });

    if (created) {
      await contest.increment('entries_count');
      await contest.reload();
    }

    return res.status(created ? 201 : 200).json({
      success: true,
      already_participating: !created,
      data: { entry, entries_count: contest.entries_count },
    });
  } catch (error) {
    // Course perdue sur l'index unique : l'autre requête a créé la
    // participation, l'utilisateur est inscrit, ce n'est pas une erreur.
    if (error?.name === 'SequelizeUniqueConstraintError') {
      return res.json({ success: true, already_participating: true });
    }
    logger.error('[Concours] participation impossible:', error);
    return res.status(500).json({ success: false, message: 'Participation impossible.' });
  }
});

/** Se retirer d'un concours tant qu'il est ouvert. */
router.delete('/:id/participate', authenticateToken, async (req, res) => {
  try {
    const contest = await Contest.findByPk(req.params.id);
    if (!contest) {
      return res.status(404).json({ success: false, message: 'Concours introuvable.' });
    }
    if (contest.status !== 'open') {
      return res.status(409).json({ success: false, message: 'Ce concours est terminé.' });
    }
    const removed = await ContestEntry.destroy({
      where: { contest_id: contest.id, user_id: req.user.id },
    });
    if (removed > 0) {
      // decrement plutôt qu'un COUNT : le compteur ne doit pas passer sous 0
      // si deux retraits se croisent, d'où le garde-fou juste après.
      await contest.decrement('entries_count');
      await contest.reload();
      if (contest.entries_count < 0) await contest.update({ entries_count: 0 });
    }
    return res.json({ success: true, data: { entries_count: contest.entries_count } });
  } catch (error) {
    logger.error('[Concours] retrait impossible:', error);
    return res.status(500).json({ success: false, message: 'Retrait impossible.' });
  }
});

/** Participants (l'organisateur seul y a accès avant le tirage). */
router.get('/:id/participants', authenticateToken, async (req, res) => {
  try {
    const contest = await Contest.findByPk(req.params.id);
    if (!contest) {
      return res.status(404).json({ success: false, message: 'Concours introuvable.' });
    }
    // Avant le tirage, la liste complète est réservée à l'organisateur : la
    // rendre publique permettrait de savoir exactement combien de monde il
    // faut battre, et de repérer les comptes à cibler.
    if (contest.status !== 'closed' && contest.creator_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'La liste des participants sera publique après le tirage.',
      });
    }
    const entries = await ContestEntry.findAll({
      where: { contest_id: contest.id },
      include: [{ model: User, as: 'user', attributes: AUTHOR_ATTRIBUTES }],
      order: [['entered_at', 'ASC']],
      limit: 500,
    });
    return res.json({ success: true, data: entries });
  } catch (error) {
    logger.error('[Concours] participants indisponibles:', error);
    return res.status(500).json({ success: false, message: 'Participants indisponibles.' });
  }
});

/**
 * Gagnants + éléments de vérification du tirage. `draw_seed` n'est révélée
 * qu'ici, une fois le tirage fait : avec elle, n'importe qui peut recalculer
 * `sha256(graine + ':' + user_id)` pour chaque participant et vérifier que
 * les gagnants annoncés sont bien les premiers dans l'ordre croissant.
 */
router.get('/:id/winners', authenticateToken, async (req, res) => {
  try {
    const contest = await Contest.findByPk(req.params.id);
    if (!contest) {
      return res.status(404).json({ success: false, message: 'Concours introuvable.' });
    }
    if (contest.status !== 'closed') {
      return res.json({ success: true, data: { drawn: false, winners: [] } });
    }
    const winners = await ContestEntry.findAll({
      where: { contest_id: contest.id, is_winner: true },
      include: [{ model: User, as: 'user', attributes: AUTHOR_ATTRIBUTES }],
      order: [['rank', 'ASC']],
    });
    return res.json({
      success: true,
      data: {
        drawn: true,
        drawn_at: contest.drawn_at,
        winners,
        proof: {
          seed: contest.draw_seed,
          seed_commitment: contest.seed_commitment,
          algorithm: 'sha256(seed + ":" + user_id), tri croissant, N premiers',
        },
      },
    });
  } catch (error) {
    logger.error('[Concours] gagnants indisponibles:', error);
    return res.status(500).json({ success: false, message: 'Gagnants indisponibles.' });
  }
});

/**
 * Annulation par l'organisateur, tant que le tirage n'a pas eu lieu. Le tweet
 * reste en place — le supprimer effacerait la discussion qu'il a suscitée —
 * mais la carte affiche « annulé » et plus personne ne peut participer.
 */
router.post('/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const contest = await Contest.findByPk(req.params.id);
    if (!contest) {
      return res.status(404).json({ success: false, message: 'Concours introuvable.' });
    }
    if (contest.creator_id !== req.user.id) {
      return res.status(403).json({ success: false, message: "Seul l'organisateur peut annuler." });
    }
    if (contest.status !== 'open') {
      return res.status(409).json({ success: false, message: 'Le tirage a déjà eu lieu.' });
    }
    await contest.update({
      status: 'cancelled',
      cancelled_reason: String(req.body?.reason || '').trim().slice(0, 160) || null,
    });
    return res.json({ success: true, data: contest.toPublicJSON() });
  } catch (error) {
    logger.error('[Concours] annulation impossible:', error);
    return res.status(500).json({ success: false, message: 'Annulation impossible.' });
  }
});

// ---------------------------------------------------------------------------

async function loadContest(id, tweetId) {
  const where = id ? { id } : { tweet_id: tweetId };
  return Contest.findOne({
    where,
    include: [
      { model: User, as: 'creator', attributes: AUTHOR_ATTRIBUTES },
      { model: Tweet, as: 'tweet', attributes: ['id', 'content', 'media_urls', 'created_at'] },
    ],
  });
}

/**
 * Vue d'un concours pour un utilisateur donné : l'objet public, plus tout ce
 * dont l'écran a besoin pour décider quoi afficher sans deuxième appel.
 */
async function describeForUser(contest, userId) {
  const entry = await ContestEntry.findOne({
    where: { contest_id: contest.id, user_id: userId },
  });

  const isOwner = contest.creator_id === userId;
  const open = contest.status === 'open' && new Date(contest.ends_at).getTime() > Date.now();

  // Les conditions manquantes ne sont calculées que si elles servent à
  // quelque chose : inutile de faire quatre requêtes pour un concours clos
  // ou pour son propre organisateur.
  let missing = [];
  if (open && !isOwner && !entry) {
    const check = await contestService.checkConditions(contest, userId);
    missing = check.missing;
  }

  let winners = [];
  if (contest.status === 'closed') {
    winners = await ContestEntry.findAll({
      where: { contest_id: contest.id, is_winner: true },
      include: [{ model: User, as: 'user', attributes: AUTHOR_ATTRIBUTES }],
      order: [['rank', 'ASC']],
    });
  }

  return {
    ...contest.toPublicJSON(),
    creator: contest.creator,
    tweet: contest.tweet,
    viewer: {
      is_owner: isOwner,
      is_participating: !!entry,
      entry_status: entry ? entry.status : null,
      is_winner: entry ? entry.is_winner : false,
      rank: entry ? entry.rank : null,
      rejected_reason: entry ? entry.rejected_reason : null,
      can_participate: open && !isOwner && !entry && missing.length === 0,
      missing_conditions: missing,
    },
    winners,
  };
}

module.exports = router;
