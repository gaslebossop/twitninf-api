const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { Tweet, TweetStrike, User, Notification } = require('../models');
const { authenticateToken, denySuspended, requireUltra } = require('../middleware/authMiddleware');
const { evaluateStrikeDispute } = require('../services/geminiService');
const rustClient = require('../services/rustRecommenderClient');
const { STRIKE_POLICIES } = require('../config/strikePolicies');
const logger = require('../utils/logger');

const router = express.Router();

// Un abonné Ultra peut bloquer la diffusion d'un nombre borné de tweets par
// jour — le strike a un vrai effet immédiat sans revue, donc il lui faut un
// plafond, même généreux, plutôt qu'un levier sans limite.
const MAX_ACTIVE_STRIKES_PER_DAY = 10;

// Domaine d'avertissement retenu quand le client n'en qualifie aucun. Le
// motif du strike est du texte libre : il n'y a rien à mapper dessus. On suit
// la convention déjà posée par `CATEGORY_TO_STRIKE_POLICY` pour un
// signalement non classé (`other` → `spam`), plutôt que d'inventer un
// neuvième domaine côté Rust.
const DEFAULT_STRIKE_POLICY = 'spam';

// Un strike déjà porté au registre du compte l'a été POUR CE TWEET : la
// révocation d'un recours gagné se fait par `tweet_id` (voir
// `shadowban_revoke_strikes_for_tweet` côté Rust), donc un tweet ne porte
// qu'un seul avertissement, même si plusieurs abonnés Ultra le strikent. Ces
// statuts sont ceux pour lesquels l'avertissement tient toujours.
const STANDING_STRIKE_STATUSES = ['active', 'contested', 'upheld'];

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

/**
 * POST /api/strikes
 * Bloque IMMÉDIATEMENT la diffusion d'un tweet (recommandations, recherche,
 * fils publics) — jamais sa suppression, jamais sa monétisation. Réservé aux
 * abonnés Ultra. Contestable par l'auteur : voir POST /:id/contest.
 */
router.post('/', [
  authenticateToken,
  denySuspended,
  requireUltra,
  body('tweet_id').isUUID(),
  body('reason').trim().isLength({ min: 10, max: 500 }).withMessage('Motif requis (10 à 500 caractères)'),
  body('policy').optional({ nullable: true }).isIn(STRIKE_POLICIES),
  handleValidationErrors,
], async (req, res) => {
  try {
    const strikerId = req.user.id;
    const { tweet_id: tweetId, reason, policy } = req.body;

    const tweet = await Tweet.findByPk(tweetId);
    if (!tweet) {
      return res.status(404).json({ success: false, message: 'Tweet non trouvé' });
    }
    if (tweet.user_id === strikerId) {
      return res.status(400).json({ success: false, message: 'Impossible de striker son propre tweet' });
    }

    const existingActive = await TweetStrike.findOne({
      where: { tweet_id: tweetId, striker_id: strikerId, status: 'active' },
    });
    if (existingActive) {
      return res.status(409).json({ success: false, message: 'Ce tweet est déjà strické par vous' });
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await TweetStrike.count({
      where: { striker_id: strikerId, created_at: { [Op.gte]: since } },
    });
    if (recentCount >= MAX_ACTIVE_STRIKES_PER_DAY) {
      return res.status(429).json({
        success: false,
        message: `Limite de ${MAX_ACTIVE_STRIKES_PER_DAY} strikes/24h atteinte`,
      });
    }

    const previousModerationStatus = tweet.moderation_status;

    const strike = await TweetStrike.create({
      tweet_id: tweetId,
      striker_id: strikerId,
      author_id: tweet.user_id,
      reason,
      status: 'active',
      previous_moderation_status: previousModerationStatus,
    });

    // Même mécanisme que le filtre qualité automatique : `not_eligible`
    // retire le tweet des recommandations/recherche sans le supprimer ni
    // toucher à sa monétisation déjà acquise. Voir [[filtre-qualite-tweets]].
    await tweet.update({
      moderation_status: 'not_eligible',
      moderation_reason: `Strike Ultra : ${reason}`,
    });

    // Le strike ne pèse plus seulement sur le tweet : il pèse sur le COMPTE.
    // Il entre au registre d'avertissements du moteur Rust — celui que lit
    // l'écran « État du compte » — où il s'AJOUTE aux avertissements déjà
    // actifs (le compteur du domaine monte de un) et expire seul au bout de
    // 90 jours. Rattaché au `tweet_id` pour qu'une contestation gagnée puisse
    // le retirer précisément, et lui seul.
    //
    // Sauté si le tweet en porte déjà un : la révocation se fait par tweet,
    // donc deux abonnés Ultra strikant le même tweet ne doivent pas coûter
    // deux avertissements à l'auteur — un seul recours les effacerait tous.
    const alreadyStanding = await TweetStrike.count({
      where: {
        tweet_id: tweetId,
        id: { [Op.ne]: strike.id },
        status: { [Op.in]: STANDING_STRIKE_STATUSES },
      },
    });
    if (alreadyStanding === 0) {
      try {
        await rustClient.issueStrike(
          tweet.user_id,
          policy || DEFAULT_STRIKE_POLICY,
          tweetId,
          `Strike Ultra : ${reason}`
        );
      } catch (strikeError) {
        // Moteur injoignable : le blocage de diffusion, lui, est déjà posé.
        // On ne fait pas échouer l'action pour autant, mais la perte doit se
        // voir — sans cette ligne l'état du compte reste muet, sans erreur.
        logger.warn(`[strikes] avertissement non porté au compte ${tweet.user_id} (strike ${strike.id}): ${strikeError.message}`);
      }
    }

    const striker = await User.findByPk(strikerId, { attributes: ['username'] });
    await Notification.createNotification({
      recipient_id: tweet.user_id,
      sender_id: strikerId,
      tweet_id: tweetId,
      type: 'system',
      title: 'Un de vos tweets a été strické',
      message: `@${striker?.username || 'un abonné Ultra'} a bloqué la diffusion de ce tweet. `
        + 'Cet avertissement compte dans l\'état de votre compte. '
        + 'Vous pouvez contester ce strike pour une revue indépendante.',
      content: { domain: 'strike', strike_id: strike.id, reason },
      priority: 'high',
    }).catch((e) => logger.warn(`[strikes] notification non envoyée: ${e.message}`));

    logger.info(`[strikes] ${strikerId} a strické le tweet ${tweetId} (raison: ${reason})`);

    res.status(201).json({ success: true, data: { strike } });
  } catch (error) {
    logger.error('[strikes] POST / :', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * POST /api/strikes/:id/contest
 * Réservé à l'auteur du tweet strické. Ne restaure PAS aveuglément l'ancien
 * statut : relance une revue indépendante et applique son verdict.
 *
 * ⚠ N'utilise PAS `processPendingTweet` — corrigé après coup : ce pipeline
 * juge la conformité générale du contenu et est délibérément permissif
 * (« privilégie l'inclusion »). Un tweet déjà approuvé une fois le repasse
 * presque toujours, donc TOUT strike contesté finissait annulé, sans jamais
 * évaluer si le motif du strike avait un fondement. `evaluateStrikeDispute`
 * juge spécifiquement CE motif face au contenu.
 */
router.post('/:id/contest', [
  authenticateToken,
  denySuspended,
  param('id').isUUID(),
  handleValidationErrors,
], async (req, res) => {
  try {
    const strike = await TweetStrike.findByPk(req.params.id, {
      include: [{ model: Tweet, as: 'tweet' }],
    });
    if (!strike) {
      return res.status(404).json({ success: false, message: 'Strike non trouvé' });
    }
    if (strike.author_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Seul l\'auteur du tweet peut contester ce strike' });
    }
    if (strike.status !== 'active') {
      return res.status(409).json({ success: false, message: 'Ce strike a déjà été traité' });
    }
    if (!strike.tweet) {
      return res.status(404).json({ success: false, message: 'Le tweet n\'existe plus' });
    }

    await strike.update({ status: 'contested' });

    const author = await User.findByPk(strike.author_id, { attributes: ['username'] });
    let verdict;
    try {
      verdict = await evaluateStrikeDispute({
        content: strike.tweet.content,
        authorUsername: author?.username || '',
        strikeReason: strike.reason,
      });
    } catch (e) {
      logger.warn(`[strikes] revue de contestation impossible pour ${strike.id}: ${e.message}`);
      // Une revue qui plante ne doit pas laisser le tweet bloqué indéfiniment
      // sans verdict : par précaution, ça compte comme annulé (voir la règle
      // du doute dans `evaluateStrikeDispute`).
      verdict = { upheld: false, reason: 'Revue indisponible : strike annulé par précaution.' };
    }

    const upheld = verdict.upheld;
    // Confirmé : la diffusion reste bloquée. Annulé : on retombe sur le
    // statut d'avant-strike (quasi toujours 'approved'), jamais sur
    // 'approved' en dur qui effacerait un rejet antérieur légitime — et le
    // motif du strike, devenu obsolète, est effacé avec.
    const finalStatus = upheld ? 'not_eligible' : (strike.previous_moderation_status || 'approved');

    await strike.tweet.update({
      moderation_status: finalStatus,
      moderation_reason: upheld ? `Strike confirmé : ${verdict.reason}` : null,
    });
    await strike.update({ status: upheld ? 'upheld' : 'reversed' });

    // Recours gagné : on remet le COMPTE comme avant, pas seulement le tweet.
    // L'avertissement porté au registre à la pose du strike est retiré, donc
    // le compteur de l'état du compte redescend de un et le niveau de
    // restriction se recalcule tout seul. Confirmé : il reste, c'est
    // précisément ce que la revue vient de valider.
    if (!upheld) {
      try {
        await rustClient.revokeStrike(strike.author_id, strike.tweet_id);
      } catch (revokeError) {
        // À signaler fort : contrairement à la pose, un échec ici laisse un
        // avertissement injustifié sur un compte pendant 90 jours.
        logger.error(`[strikes] avertissement NON révoqué pour ${strike.author_id} après annulation du strike ${strike.id}: ${revokeError.message}`);
      }
    }

    await Promise.all([
      Notification.createNotification({
        recipient_id: strike.author_id,
        sender_id: strike.author_id,
        tweet_id: strike.tweet_id,
        type: 'system',
        title: upheld ? 'Strike confirmé' : 'Strike annulé',
        message: upheld
          ? `La revue indépendante a confirmé le retrait de la diffusion : ${verdict.reason}`
          : `La revue indépendante a rétabli la diffusion de ce tweet : ${verdict.reason}`,
        content: { domain: 'strike', strike_id: strike.id, outcome: strike.status },
        priority: 'normal',
      }).catch(() => {}),
      Notification.createNotification({
        recipient_id: strike.striker_id,
        sender_id: strike.author_id,
        tweet_id: strike.tweet_id,
        type: 'system',
        title: upheld ? 'Votre strike a été confirmé' : 'Votre strike a été annulé',
        message: `@${author?.username || 'l\'auteur'} a contesté votre strike — la revue indépendante l'a ${upheld ? 'confirmé' : 'annulé'} : ${verdict.reason}`,
        content: { domain: 'strike', strike_id: strike.id, outcome: strike.status },
        priority: 'normal',
      }).catch(() => {}),
    ]);

    logger.info(`[strikes] ${strike.id} contesté par ${req.user.id} — verdict: ${strike.status}`);

    res.json({ success: true, data: { strike, moderation_status: finalStatus } });
  } catch (error) {
    logger.error('[strikes] POST /:id/contest :', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

module.exports = router;
