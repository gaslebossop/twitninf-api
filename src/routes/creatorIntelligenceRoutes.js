const express = require('express');
const router = express.Router();
const { authenticateToken, requirePremium, requirePro } = require('../middleware/authMiddleware');
const predictive = require('../services/predictiveAnalyticsService');
const copilot = require('../services/aiCopilotService');
const trendRadar = require('../services/trendRadarService');
const tweetGenerator = require('../services/customTweetGenerationService');
const codex = require('../services/codexTextClient');
const { resolveTweetCharLimit, TWEET_MAX_CHARS_SUBSCRIBER } = require('../utils/tweetLimits');
const logger = require('../utils/logger');

/**
 * Analytics prédictifs, co-pilote IA et radar de tendances — palier Pro.
 * Le générateur libre placé en tête de fichier est, lui, commun à Plus et Pro.
 *
 * Chaque route payante passe par `requirePremium` ou `requirePro`, qui revalide
 * le palier ET l'expiration en base à chaque appel : se fier au jeton laisserait
 * un abonné expiré consommer l'avantage jusqu'à son prochain rafraîchissement.
 *
 * Ces routes ne lisent JAMAIS l'identifiant d'auteur depuis le corps de la
 * requête. Prédire sur `req.body.userId` reviendrait à offrir les statistiques
 * détaillées de n'importe quel compte à quiconque paie 30 € — c'est
 * l'historique privé d'un tiers.
 */

/** Le co-pilote est plus lent qu'une route normale : on l'annonce à l'app. */
const COPILOT_HINT_SECONDS = 15;

/**
 * GET /api/creator-intelligence/generator
 * Solde et disponibilité du générateur libre. Plus et Pro y ont accès : le
 * crédit vient de l'achat de l'abonnement, pas du palier choisi.
 */
router.get('/generator', authenticateToken, requirePremium, async (req, res) => {
  try {
    const status = await tweetGenerator.getStatus(req.user.id);
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('[CreatorIntel] Statut générateur en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible de charger tes crédits.' });
  }
});

/**
 * POST /api/creator-intelligence/generator
 * Génère un seul brouillon depuis une consigne libre et l'historique d'écriture
 * du compte. Le service sérialise le débit et rembourse tout échec IA.
 */
router.post('/generator', authenticateToken, requirePremium, async (req, res) => {
  try {
    const result = await tweetGenerator.generateForUser(req.user.id, req.body?.request);
    if (!result.success) {
      const status = ['request_too_short', 'request_too_long'].includes(result.error) ? 400
        : result.error === 'no_credits' ? 409
          : result.error === 'subscription_required' ? 403
            : result.error === 'no_style_profile' ? 409
              : result.error === 'user_not_found' ? 404
                : 503;
      return res.status(status).json({
        success: false,
        message: result.message,
        code: result.error,
        data: Number.isFinite(result.creditsRemaining)
          ? { creditsRemaining: result.creditsRemaining }
          : undefined,
      });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[CreatorIntel] Génération libre en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible de générer ce tweet.' });
  }
});

/**
 * GET /api/creator-intelligence/profile
 * Tableau de bord prédictif du compte : base, tendance, facteurs, créneaux.
 */
router.get('/profile', authenticateToken, requirePro, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 120, 30), 365);
    const profile = await predictive.getCreatorProfile(req.user.id, { historyDays: days });
    res.json({ success: true, data: profile });
  } catch (error) {
    logger.error('[CreatorIntel] Profil en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible de calculer ton profil créateur.' });
  }
});

/**
 * POST /api/creator-intelligence/predict
 * Estime la performance d'un brouillon avant publication.
 *
 * En POST et non en GET : le brouillon est du contenu non publié, il n'a rien
 * à faire dans une URL (journaux d'accès, historique, référents).
 */
router.post('/predict', authenticateToken, requirePro, async (req, res) => {
  try {
    const content = String(req.body?.content || '');
    if (!content.trim()) {
      return res.status(400).json({ success: false, message: 'Aucun texte à analyser.' });
    }
    if (content.length > 4000) {
      return res.status(400).json({ success: false, message: 'Texte trop long.' });
    }

    const mediaCount = Math.max(0, Math.min(parseInt(req.body?.mediaCount, 10) || 0, 4));
    // Une date de publication passée fausserait le facteur horaire sans rien
    // apporter : on retombe sur « maintenant ».
    const rawPublishAt = req.body?.publishAt ? new Date(req.body.publishAt) : null;
    const publishAt = rawPublishAt && !Number.isNaN(rawPublishAt.getTime()) && rawPublishAt > new Date()
      ? rawPublishAt
      : new Date();

    const prediction = await predictive.predictTweetPerformance({
      userId: req.user.id,
      content,
      mediaCount,
      publishAt,
    });

    // Le modèle calcule déjà ses voisins pour l'ensemble k-NN. Les réutiliser
    // évite une seconde lecture complète de l'historique à chaque analyse.
    res.json({
      success: true,
      data: {
        ...prediction,
        comparables: prediction.comparableTweets || [],
      },
    });
  } catch (error) {
    logger.error('[CreatorIntel] Prédiction en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible d\'analyser ce brouillon.' });
  }
});

/**
 * GET /api/creator-intelligence/radar
 * Sujets qui percent en ce moment ET proches des thèmes de l'auteur.
 */
router.get('/radar', authenticateToken, requirePro, async (req, res) => {
  try {
    const radar = await trendRadar.getRadarForUser(req.user.id);
    res.json({ success: true, data: radar });
  } catch (error) {
    logger.error('[CreatorIntel] Radar en échec:', error);
    res.status(500).json({ success: false, message: 'Le radar de tendances est indisponible.' });
  }
});

/**
 * POST /api/creator-intelligence/radar/idea
 * Rédige une idée de tweet sur un sujet du radar, à la demande.
 *
 * Le sujet est revalidé contre le radar réel : sans ça, la route deviendrait un
 * générateur de texte libre sur n'importe quel mot envoyé par le client.
 */
router.post('/radar/idea', authenticateToken, requirePro, async (req, res) => {
  try {
    const term = String(req.body?.term || '').trim().toLowerCase();
    if (!term) {
      return res.status(400).json({ success: false, message: 'Sujet manquant.' });
    }

    const [topics, profile] = await Promise.all([
      trendRadar.detectRisingTopics(),
      trendRadar.buildUserTopicProfile(req.user.id),
    ]);

    const topic = topics.find((t) => t.term === term);
    if (!topic) {
      return res.status(404).json({
        success: false,
        message: 'Ce sujet ne fait plus partie des tendances du moment.',
        code: 'topic_expired',
      });
    }
    if (!profile) {
      return res.status(409).json({
        success: false,
        message: 'Publie quelques tweets de plus pour que le radar apprenne tes sujets.',
        code: 'no_profile',
      });
    }

    const idea = await trendRadar.generateTweetIdea(topic, profile);
    if (!idea) {
      return res.status(503).json({
        success: false,
        message: 'Le moteur n\'a rien pu proposer cette fois.',
        code: 'generation_failed',
      });
    }

    res.json({ success: true, data: { topic: topic.term, ...idea } });
  } catch (error) {
    logger.error('[CreatorIntel] Idée de tweet en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible de générer une idée.' });
  }
});

/**
 * GET /api/creator-intelligence/copilot/modes
 * Modes disponibles + disponibilité réelle du moteur.
 *
 * L'app s'en sert pour ne pas proposer un bouton qui échouera : sur un serveur
 * où `codex login` n'a pas été fait, le co-pilote est simplement absent.
 */
router.get('/copilot/modes', authenticateToken, requirePro, async (req, res) => {
  try {
    const available = await codex.isAvailable();
    res.json({
      success: true,
      data: {
        available,
        modes: copilot.availableModes(),
        expectedLatencySeconds: COPILOT_HINT_SECONDS,
      },
    });
  } catch (error) {
    logger.error('[CreatorIntel] Modes co-pilote en échec:', error);
    res.status(500).json({ success: false, message: 'Co-pilote indisponible.' });
  }
});

/**
 * POST /api/creator-intelligence/copilot/suggest
 * Reformulations, accroches, versions courtes.
 */
router.post('/copilot/suggest', authenticateToken, requirePro, async (req, res) => {
  try {
    const content = String(req.body?.content || '');
    const mode = String(req.body?.mode || 'rewrite');

    // La limite du palier de l'auteur, pour ne pas proposer un texte que la
    // publication refusera derrière. Un compte certifié n'a pas de limite
    // serveur (`Infinity`) : on plafonne quand même la consigne donnée au
    // modèle, sans quoi il n'a plus aucun cadre de longueur.
    const resolved = await resolveTweetCharLimit(req.user).catch(() => TWEET_MAX_CHARS_SUBSCRIBER);
    const maxChars = Number.isFinite(resolved) ? resolved : TWEET_MAX_CHARS_SUBSCRIBER;

    const result = await copilot.suggest({
      userId: req.user.id,
      content,
      mode,
      maxChars,
    });

    if (!result.success) {
      const status = result.error === 'rate_limited' ? 429
        : ['empty_content', 'content_too_long', 'unknown_mode'].includes(result.error) ? 400
          : 503;
      return res.status(status).json({
        success: false,
        message: result.message,
        code: result.error,
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[CreatorIntel] Suggestion co-pilote en échec:', error);
    res.status(500).json({ success: false, message: 'Le co-pilote est indisponible.' });
  }
});

/**
 * POST /api/creator-intelligence/copilot/review
 * Relecture : ton, clarté, accroche, points forts, hashtags.
 */
router.post('/copilot/review', authenticateToken, requirePro, async (req, res) => {
  try {
    const result = await copilot.review({
      userId: req.user.id,
      content: String(req.body?.content || ''),
    });

    if (!result.success) {
      const status = result.error === 'rate_limited' ? 429
        : ['empty_content', 'content_too_long'].includes(result.error) ? 400
          : 503;
      return res.status(status).json({
        success: false,
        message: result.message,
        code: result.error,
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[CreatorIntel] Relecture co-pilote en échec:', error);
    res.status(500).json({ success: false, message: 'Le co-pilote est indisponible.' });
  }
});

module.exports = router;
