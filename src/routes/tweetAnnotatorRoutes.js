'use strict';

const express = require('express');
const { sequelize } = require('../models');
const { authenticateToken, requireAdminRole } = require('../middleware/authMiddleware');
const { THEMES, VIOLATION_RULES } = require('../constants/tweetAnnotatorConstants');
const logger = require('../utils/logger');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Toutes les routes ci-dessous : réservées aux comptes admin / superadmin.
router.use(authenticateToken, requireAdminRole);

router.get('/config', (req, res) => {
  res.json({
    success: true,
    data: {
      themes: THEMES,
      rules: VIOLATION_RULES,
      annotator: { id: req.user.id, username: req.user.username },
    },
  });
});

router.get('/stats', async (req, res, next) => {
  try {
    const rows = await sequelize.query(
      `SELECT
        (SELECT count(*)::int FROM tweets WHERE deleted_at IS NULL AND length(trim(content)) > 0) AS total,
        (SELECT count(*)::int FROM tweet_human_labels) AS done`,
      { type: sequelize.QueryTypes.SELECT },
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/next', async (req, res, next) => {
  try {
    const rows = await sequelize.query(
      `SELECT t.id, t.content, u.username, t.created_at
       FROM tweets t
       JOIN users u ON u.id = t.user_id
       WHERE t.deleted_at IS NULL
         AND length(trim(t.content)) > 0
         AND NOT EXISTS (SELECT 1 FROM tweet_human_labels l WHERE l.tweet_id = t.id)
       ORDER BY random()
       LIMIT 1`,
      { type: sequelize.QueryTypes.SELECT },
    );
    if (!rows.length) return res.json({ success: true, data: { done: true } });
    res.json({ success: true, data: { tweet: rows[0] } });
  } catch (err) {
    next(err);
  }
});

function validateAnnotation(body) {
  const {
    tweetId, content, spamScore, qualityScore, theme,
    sentiment, compliant, violationRule, insultSpans,
  } = body || {};

  if (typeof tweetId !== 'string' || !UUID_RE.test(tweetId)) return 'tweetId invalide';
  if (typeof content !== 'string' || !content.trim()) return 'content invalide';
  if (!Number.isInteger(spamScore) || spamScore < 1 || spamScore > 10) return 'spamScore invalide';
  if (!Number.isInteger(qualityScore) || qualityScore < 1 || qualityScore > 10) return 'qualityScore invalide';
  if (!THEMES.some((t) => t.id === theme)) return 'theme invalide';
  if (sentiment !== 'positif' && sentiment !== 'negatif') return 'sentiment invalide';
  if (typeof compliant !== 'boolean') return 'compliant invalide';
  if (!compliant && !VIOLATION_RULES.some((r) => r.id === violationRule)) {
    return 'violationRule requis quand non-conforme';
  }
  if (insultSpans !== undefined) {
    if (!Array.isArray(insultSpans)) return 'insultSpans invalide';
    for (const s of insultSpans) {
      if (
        !s || !Number.isInteger(s.start) || !Number.isInteger(s.end)
        || s.start < 0 || s.end <= s.start || s.end > content.length
      ) {
        return 'insultSpans contient une plage invalide';
      }
    }
  }
  return null;
}

router.post('/annotate', async (req, res, next) => {
  try {
    const error = validateAnnotation(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const {
      tweetId, content, spamScore, qualityScore, theme,
      sentiment, compliant, violationRule, insultSpans,
    } = req.body;

    await sequelize.query(
      `INSERT INTO tweet_human_labels
        (tweet_id, content_snapshot, spam_score, quality_score, theme, sentiment,
         compliant, violation_rule, insult_spans, annotator_id, skipped, annotated_at)
       VALUES (:tweetId, :content, :spamScore, :qualityScore, :theme, :sentiment,
               :compliant, :violationRule, :insultSpans, :annotatorId, false, now())
       ON CONFLICT (tweet_id) DO UPDATE SET
         content_snapshot = EXCLUDED.content_snapshot,
         spam_score = EXCLUDED.spam_score,
         quality_score = EXCLUDED.quality_score,
         theme = EXCLUDED.theme,
         sentiment = EXCLUDED.sentiment,
         compliant = EXCLUDED.compliant,
         violation_rule = EXCLUDED.violation_rule,
         insult_spans = EXCLUDED.insult_spans,
         annotator_id = EXCLUDED.annotator_id,
         skipped = false,
         annotated_at = now()`,
      {
        replacements: {
          tweetId,
          content,
          spamScore,
          qualityScore,
          theme,
          sentiment,
          compliant,
          violationRule: compliant ? null : violationRule,
          insultSpans: JSON.stringify(insultSpans || []),
          annotatorId: req.user.id,
        },
      },
    );

    res.json({ success: true });
  } catch (err) {
    logger.error('Erreur annotate tweet_human_labels:', err);
    next(err);
  }
});

router.post('/skip', async (req, res, next) => {
  try {
    const { tweetId, content } = req.body || {};
    if (typeof tweetId !== 'string' || !UUID_RE.test(tweetId) || typeof content !== 'string') {
      return res.status(400).json({ success: false, message: 'tweetId et content requis' });
    }

    await sequelize.query(
      `INSERT INTO tweet_human_labels (tweet_id, content_snapshot, skipped, annotator_id, annotated_at)
       VALUES (:tweetId, :content, true, :annotatorId, now())
       ON CONFLICT (tweet_id) DO UPDATE SET
         skipped = true, annotator_id = EXCLUDED.annotator_id, annotated_at = now()`,
      { replacements: { tweetId, content, annotatorId: req.user.id } },
    );

    res.json({ success: true });
  } catch (err) {
    logger.error('Erreur skip tweet_human_labels:', err);
    next(err);
  }
});

router.get('/export', async (req, res, next) => {
  try {
    const rows = await sequelize.query(
      `SELECT tweet_id, content_snapshot AS content, spam_score, quality_score, theme,
              sentiment, compliant, violation_rule, insult_spans, annotator_id, annotated_at
       FROM tweet_human_labels
       WHERE skipped = false
       ORDER BY annotated_at`,
      { type: sequelize.QueryTypes.SELECT },
    );
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="tweet_human_labels.jsonl"');
    res.send(rows.map((r) => JSON.stringify(r)).join('\n'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
