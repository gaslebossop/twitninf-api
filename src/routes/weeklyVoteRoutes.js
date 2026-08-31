const express = require('express');
const { param, validationResult } = require('express-validator');
const router = express.Router();

const { Tweet, TweetLike, TweetRetweet, WeeklyTweetVote, User } = require('../models');
const { Op } = require('sequelize');
const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const { checkUserBanReadOnly } = require('../middleware/banMiddleware');
const { stripInternalTweetFields } = require('../utils/stripInternalTweetFields');
const paidContentService = require('../services/paidContentService');
const logger = require('../utils/logger');

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, message: 'Données invalides', errors: errors.array() });
  }
  next();
};

// Nombre de tweets de la semaine soumis au vote — assez pour représenter la
// semaine, assez peu pour rester lisible dans le widget mobile.
const MAX_CANDIDATES = 10;

/**
 * Un candidat au « tweet de la semaine » : original (pas une réponse, pas un
 * retweet), publié cette semaine ISO, visible publiquement. Même filtre que
 * la clause `whereClause` du fil classique (`GET /api/tweets`) pour rester
 * cohérent avec ce qui est réellement affichable.
 */
function candidateWhereClause(weekStart, weekEnd) {
  return {
    is_private: false,
    is_data_test: false,
    deleted_at: null,
    moderation_status: 'approved',
    parent_tweet_id: null,
    is_retweet: false,
    created_at: { [Op.gte]: weekStart, [Op.lt]: weekEnd },
  };
}

/**
 * GET /api/weekly-vote/candidates
 * Classement des tweets de la semaine en cours + état du vote du lecteur.
 */
router.get('/candidates', [authenticateToken, checkUserBanReadOnly], async (req, res) => {
  try {
    const userId = req.user.id;
    const weekStart = WeeklyTweetVote.currentWeekStart();
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    // Vivier large de la semaine (pas encore trié par like) : on tranche sur
    // les like counts ensuite, un COUNT en base ne peut pas encore les
    // ordonner ici sans jointure lourde sur une table dont le volume reste
    // modeste (~20 utilisateurs).
    const weekTweets = await Tweet.findAll({
      where: candidateWhereClause(weekStart, weekEnd),
      include: [{
        model: User,
        as: 'author',
        attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium', 'subscription_tier', 'profile_customization'],
        where: { is_active: true },
      }],
      order: [['created_at', 'DESC']],
      limit: 200,
    });

    if (weekTweets.length === 0) {
      return res.json({
        success: true,
        message: 'Aucun tweet éligible cette semaine',
        data: {
          week_start: weekStart.toISOString().slice(0, 10),
          week_end: weekEnd.toISOString().slice(0, 10),
          candidates: [],
          total_votes: 0,
          my_vote: null,
        },
      });
    }

    const tweetIds = weekTweets.map((t) => String(t.id));
    const [likeCounts, retweetCounts, replyCounts, voteCounts, myVote] = await Promise.all([
      TweetLike.countLikesForTweets(tweetIds),
      TweetRetweet.countRetweetsForTweets(tweetIds),
      Tweet.countRepliesForTweets(tweetIds),
      WeeklyTweetVote.countVotesForWeek(weekStart),
      WeeklyTweetVote.voteForUser(userId, weekStart),
    ]);

    const ranked = weekTweets
      .map((tweet) => ({ tweet, likes: likeCounts.get(String(tweet.id)) || 0 }))
      .sort((a, b) => b.likes - a.likes)
      .slice(0, MAX_CANDIDATES);

    const candidates = ranked.map(({ tweet, likes }) => {
      const tid = String(tweet.id);
      return {
        ...stripInternalTweetFields(tweet.toJSON()),
        stats: {
          likes,
          retweets: retweetCounts.get(tid) || 0,
          replies: replyCounts.get(tid) || 0,
          views: tweet.view_count || 0,
        },
        weekly_vote: {
          count: voteCounts.get(tid) || 0,
          is_my_vote: myVote === tweet.id,
        },
      };
    });

    await paidContentService.maskTweets(candidates, userId);

    const totalVotes = candidates.reduce((sum, c) => sum + c.weekly_vote.count, 0);

    res.json({
      success: true,
      message: 'Classement du vote hebdomadaire récupéré avec succès',
      data: {
        week_start: weekStart.toISOString().slice(0, 10),
        week_end: weekEnd.toISOString().slice(0, 10),
        candidates,
        total_votes: totalVotes,
        my_vote: myVote,
      },
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération du vote hebdomadaire:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

/**
 * POST /api/weekly-vote/:tweetId
 * Vote (ou change son vote) pour le tweet de la semaine en cours. Un seul
 * vote actif par utilisateur et par semaine — revoter remplace le précédent.
 */
router.post('/:tweetId', [
  authenticateToken,
  denySuspended,
  param('tweetId').isUUID().withMessage('ID de tweet invalide'),
  handleValidationErrors,
], async (req, res) => {
  try {
    const userId = req.user.id;
    const { tweetId } = req.params;
    const weekStart = WeeklyTweetVote.currentWeekStart();
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    const tweet = await Tweet.findOne({
      where: { id: tweetId, ...candidateWhereClause(weekStart, weekEnd) },
    });
    if (!tweet) {
      return res.status(400).json({
        success: false,
        message: "Ce tweet n'est pas éligible au vote de la semaine en cours",
      });
    }

    await WeeklyTweetVote.castVote(userId, tweetId, weekStart);
    const voteCounts = await WeeklyTweetVote.countVotesForWeek(weekStart);
    const totalVotes = [...voteCounts.values()].reduce((sum, n) => sum + n, 0);

    res.json({
      success: true,
      message: 'Vote enregistré',
      data: {
        week_start: weekStart.toISOString().slice(0, 10),
        my_vote: tweetId,
        vote_count: voteCounts.get(String(tweetId)) || 0,
        total_votes: totalVotes,
      },
    });
  } catch (error) {
    logger.error('Erreur lors du vote hebdomadaire:', error);
    res.status(500).json({ success: false, message: 'Erreur interne du serveur' });
  }
});

module.exports = router;
