const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const logger = require('../utils/logger');
const { mirrorDwell } = require('../services/dwellMirror');
const { coalesceAuthorId } = require('../services/interactionAuthor');

const DWELL_MEDIA = ['text', 'image', 'video'];

/**
 * POST /track
 * Envoie les interactions utilisateur au recommandeur Rust pour CTR tracking
 *
 * Body :
 *   tweet_id   {string}  — UUID
 *   action     {string}  — voir `validActions`
 *   dwell_ms   {number?} — temps passe sur le contenu
 *   author_id  {string?} — auteur du tweet. Facultatif : resolu en base a
 *     defaut (voir `services/interactionAuthor`), sans quoi le filtrage
 *     collaboratif, le boost temps reel et le bandit restent inertes.
 *   dwell_media / content_chars / video_duration_ms {?} — nature du contenu,
 *     pour que `dwell_ms` soit rapporte au temps que CE contenu demandait
 *     plutot que juge sur sa valeur brute (voir `algorithm/dwell.rs`).
 *   experiment_id / variant_id {string?} — version A/B reellement affichee.
 */
router.post('/', [authenticateToken], async (req, res) => {
  try {
    const {
      tweet_id, action, dwell_ms, experiment_id, variant_id,
      author_id, dwell_media, content_chars, video_duration_ms,
    } = req.body;
    const userId = req.user.id;

    if (!tweet_id || !action) {
      return res.status(400).json({
        success: false,
        message: 'tweet_id et action sont requis'
      });
    }

    // Valider l'action
    const validActions = ['like', 'unlike', 'retweet', 'unretweet', 'comment', 'view', 'bookmark', 'share', 'skip', 'report', 'block', 'profile_view'];
    if (!validActions.includes(action)) {
      return res.status(400).json({
        success: false,
        message: `Action invalide. Doit être l'une de: ${validActions.join(', ')}`
      });
    }

    // Envoyer le tracking au recommandeur Rust
    const rustRecommenderUrl = process.env.RUST_RECOMMENDER_URL || 'http://localhost:3002';
    const internalSecret = process.env.INTERNAL_SECRET || 'changeme-internal-secret';

    // L'auteur decide de trois mecanismes cote moteur (co-occurrence, boost
    // temps reel, bandit) et aucun client ne le joignait. Resolu ici quand il
    // manque : le parc deja installe en profite sans mise a jour.
    const resolvedAuthorId = await coalesceAuthorId(author_id, tweet_id);

    // Contexte de lecture : `dwell_ms` seul se confond avec la LONGUEUR du
    // contenu. On ne transmet que des valeurs reconnues, un media inconnu
    // valant mieux absent (le moteur retombe alors sur son ancien calcul) que
    // faux (il raisonnerait en taux de completion sur une nature erronee).
    const media = DWELL_MEDIA.includes(dwell_media) ? dwell_media : null;
    const chars = Number.isFinite(Number(content_chars))
      ? Math.max(0, Math.trunc(Number(content_chars)))
      : null;
    const videoMs = Number.isFinite(Number(video_duration_ms))
      ? Math.max(0, Math.trunc(Number(video_duration_ms)))
      : null;

    try {
      const response = await fetch(`${rustRecommenderUrl}/track`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': internalSecret,
        },
        body: JSON.stringify({
          user_id: userId,
          tweet_id: tweet_id,
          interaction_type: action,
          dwell_ms: dwell_ms || null,
          author_id: resolvedAuthorId,
          dwell_media: media,
          content_chars: chars,
          video_duration_ms: videoMs,
          experiment_id: experiment_id || null,
          variant_id: variant_id || null,
        }),
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        logger.warn(`⚠️ Rust recommender tracking failed: ${response.status}`);
        // Non-blocking: continue même si le Rust recommender échoue
      }

      logger.debug(`📊 Tracking: ${action} sur tweet ${tweet_id} par user ${userId}`);
    } catch (rustError) {
      logger.warn(`⚠️ Erreur connection au Rust recommender: ${rustError.message}`);
      // Non-blocking: on continue même si Rust n'est pas disponible
    }

    // Le temps de lecture doit aussi atterrir dans `user_behavior_data` :
    // c'est la seule table que lit le pot créateur pour son signal Attention.
    // Sans ce miroir, la mesure existe mais reste enfermée côté Rust.
    mirrorDwell({
      userId,
      tweetId: tweet_id,
      action,
      dwellMs: dwell_ms,
      // Meme contexte que celui envoye au moteur : le pot createur en a besoin
      // pour les memes raisons, et deux sources qui divergent finiraient par
      // payer sur une mesure differente de celle qui classe.
      context: media
        ? { media, contentChars: chars ?? 0, videoDurationMs: videoMs }
        : null,
      ip: req.ip,
    }).catch(() => {});

    res.json({
      success: true,
      message: 'Interaction trackée',
      data: {
        tweet_id,
        action,
        user_id: userId,
      }
    });
  } catch (error) {
    logger.error('Erreur lors du tracking:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du tracking'
    });
  }
});

module.exports = router;
