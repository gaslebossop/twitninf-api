const express = require('express');
const { Op } = require('sequelize');
const { body, param, query, validationResult } = require('express-validator');
const { authenticateToken, requireAdminRole } = require('../middleware/authMiddleware');
const { User, FeedHashtagRule } = require('../models');
const similarity = require('../services/similarity');
const logger = require('../utils/logger');

const router = express.Router();

router.use(authenticateToken);
router.use(requireAdminRole);

function normalizeTag(raw) {
  return String(raw || '')
    .trim()
    .replace(/^#+/u, '')
    .toLowerCase();
}

router.get('/overview', async (req, res) => {
  try {
    const [userCount, ruleCount] = await Promise.all([
      User.count({ where: { algorithmic_visibility_multiplier: { [Op.ne]: 1 } } }).catch(() => 0),
      FeedHashtagRule.count().catch(() => 0),
    ]);
    const engine = similarity.getEngine();
    const maps = engine
      ? {
          authorEntries: engine.authorVisibility?.size ?? 0,
          hashtagEntries: engine.hashtagRules?.size ?? 0,
        }
      : null;
    return res.json({
      success: true,
      data: {
        usersWithNonDefaultMultiplier: userCount,
        hashtagRuleRows: ruleCount,
        engineMaps: maps,
      },
    });
  } catch (e) {
    logger.error('shadowban overview:', e);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.get(
  '/lookup',
  [query('username').trim().isLength({ min: 1, max: 30 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const username = String(req.query.username).trim();
      const user = await User.findOne({
        where: { username },
        attributes: ['id', 'username', 'full_name', 'algorithmic_visibility_multiplier'],
      });
      if (!user) {
        return res.status(404).json({ success: false, message: 'Utilisateur introuvable' });
      }
      return res.json({
        success: true,
        data: {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          algorithmic_visibility_multiplier: Number(user.algorithmic_visibility_multiplier) ?? 1,
        },
      });
    } catch (e) {
      logger.error('shadowban lookup:', e);
      return res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
  }
);

router.put(
  '/users/:userId',
  [
    param('userId').isUUID(),
    body('algorithmic_visibility_multiplier').isFloat({ min: 0, max: 5 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const user = await User.findByPk(req.params.userId);
      if (!user) {
        return res.status(404).json({ success: false, message: 'Utilisateur introuvable' });
      }
      const v = Number(req.body.algorithmic_visibility_multiplier);
      await user.update({ algorithmic_visibility_multiplier: v });
      await similarity.reloadShadowbanMaps();
      return res.json({
        success: true,
        message: 'Visibilité algorithmique mise à jour',
        data: {
          id: user.id,
          username: user.username,
          algorithmic_visibility_multiplier: v,
        },
      });
    } catch (e) {
      logger.error('shadowban put user:', e);
      return res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
  }
);

router.get('/hashtags', async (req, res) => {
  try {
    const rows = await FeedHashtagRule.findAll({ order: [['tag_normalized', 'ASC']] });
    return res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        tag_normalized: r.tag_normalized,
        multiplier: Number(r.multiplier),
        note: r.note,
        updated_at: r.updated_at,
      })),
    });
  } catch (e) {
    logger.error('shadowban list hashtags:', e);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post(
  '/hashtags',
  [
    body('tag').trim().isLength({ min: 1, max: 200 }),
    body('multiplier').isFloat({ min: 0.01, max: 5 }),
    body('note').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const tag_normalized = normalizeTag(req.body.tag);
      if (!tag_normalized) {
        return res.status(400).json({ success: false, message: 'Hashtag invalide' });
      }
      const [row, created] = await FeedHashtagRule.findOrCreate({
        where: { tag_normalized },
        defaults: {
          multiplier: Number(req.body.multiplier),
          note: req.body.note || null,
        },
      });
      if (!created) {
        await row.update({
          multiplier: Number(req.body.multiplier),
          note: req.body.note != null ? String(req.body.note) : row.note,
        });
      }
      await similarity.reloadShadowbanMaps();
      return res.json({
        success: true,
        message: created ? 'Règle créée' : 'Règle mise à jour',
        data: {
          id: row.id,
          tag_normalized: row.tag_normalized,
          multiplier: Number(row.multiplier),
          note: row.note,
        },
      });
    } catch (e) {
      logger.error('shadowban post hashtag:', e);
      return res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
  }
);

router.put(
  '/hashtags/:id',
  [
    param('id').isUUID(),
    body('multiplier').optional().isFloat({ min: 0.01, max: 5 }),
    body('note').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const row = await FeedHashtagRule.findByPk(req.params.id);
      if (!row) {
        return res.status(404).json({ success: false, message: 'Règle introuvable' });
      }
      const patch = {};
      if (req.body.multiplier != null) patch.multiplier = Number(req.body.multiplier);
      if (req.body.note !== undefined) patch.note = req.body.note;
      await row.update(patch);
      await similarity.reloadShadowbanMaps();
      return res.json({
        success: true,
        data: {
          id: row.id,
          tag_normalized: row.tag_normalized,
          multiplier: Number(row.multiplier),
          note: row.note,
        },
      });
    } catch (e) {
      logger.error('shadowban put hashtag:', e);
      return res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
  }
);

router.delete('/hashtags/:id', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  try {
    const n = await FeedHashtagRule.destroy({ where: { id: req.params.id } });
    if (!n) {
      return res.status(404).json({ success: false, message: 'Règle introuvable' });
    }
    await similarity.reloadShadowbanMaps();
    return res.json({ success: true, message: 'Règle supprimée' });
  } catch (e) {
    logger.error('shadowban delete hashtag:', e);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/reload-maps', async (req, res) => {
  try {
    await similarity.reloadShadowbanMaps();
    return res.json({ success: true, message: 'Cartes rechargées' });
  } catch (e) {
    logger.error('shadowban reload:', e);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

module.exports = router;
