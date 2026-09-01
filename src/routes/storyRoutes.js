const express = require('express');
const router = express.Router();
const { Op, literal } = require('sequelize');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const {
  sequelize,
  User,
  UserFollow,
  Story,
  StoryView,
  StoryHighlight,
  StoryHighlightItem,
  Notification
} = require('../models');
const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const { toDecodableBuffer } = require('../services/heifDecoder');
const { buildStaticMediaPublicUrl } = require('../utils/publicMediaOrigin');
const logger = require('../utils/logger');
const { isUltraRequest, ultraLimit } = require('../utils/ultraGate');

const STORY_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Stories d'un compte Ultra : 48 heures à l'affiche, et 30 secondes de vidéo
 * au lieu de 15.
 *
 * Les deux valeurs sont écrites SUR LA LIGNE au moment de la publication
 * (`expires_at`, `duration_ms`), jamais recalculées à la lecture : aucune
 * requête de fil n'a à connaître le palier de l'auteur, et une story publiée
 * sous Ultra garde ses 48 heures même si l'abonnement s'arrête entre-temps —
 * ce qui a été publié l'a été aux conditions du moment.
 */
const STORY_TTL_MS_ULTRA = 48 * 60 * 60 * 1000;
const VIDEO_DURATION_MS_ULTRA = 30000;
/** Durée de conservation après expiration : l'archive dans laquelle on pioche
 *  pour créer une « une ». Au-delà, une story non épinglée est purgée. */
const ARCHIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Ultra : un trimestre d'archive dans laquelle piocher pour ses « unes ». */
const ARCHIVE_WINDOW_MS_ULTRA = 90 * 24 * 60 * 60 * 1000;
/** Légende d'une story. Ultra en écrit près du double. */
const CAPTION_MAX = 280;
const CAPTION_MAX_ULTRA = 500;
const IMAGE_DURATION_MS = 5000;
const VIDEO_DURATION_MS = 15000;
const STORIES_DIR = path.join(__dirname, '../public/stories');

const AUTHOR_ATTRIBUTES = [
  'id',
  'username',
  'full_name',
  'avatar',
  'verified',
  'premium',
  'verification_style'
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^(image|video)\//.test(file.mimetype || '')) {
      return cb(new Error('Seules les images et vidéos sont autorisées'));
    }
    cb(null, true);
  }
});

/** Fenêtre d'activité d'une story : non expirée et non supprimée. */
function activeStoryWhere(extra = {}) {
  return { ...extra, expires_at: { [Op.gt]: new Date() } };
}

function serializeAuthor(user) {
  if (!user) return null;
  const plain = typeof user.toJSON === 'function' ? user.toJSON() : user;
  return {
    id: String(plain.id),
    username: plain.username,
    full_name: plain.full_name || plain.username,
    avatar: plain.avatar || null,
    verified: !!plain.verified,
    premium: !!plain.premium,
    verification_style: plain.verification_style || 'default'
  };
}

function serializeStory(story, { seen = false, liked = false } = {}) {
  const plain = typeof story.toJSON === 'function' ? story.toJSON() : story;
  return {
    id: String(plain.id),
    user_id: String(plain.user_id),
    media_url: plain.media_url,
    media_type: plain.media_type || 'image',
    thumbnail_url: plain.thumbnail_url || null,
    caption: plain.caption || null,
    duration_ms: Number(plain.duration_ms || IMAGE_DURATION_MS),
    views_count: Number(plain.views_count || 0),
    likes_count: Number(plain.likes_count || 0),
    created_at: plain.created_at || plain.createdAt,
    expires_at: plain.expires_at,
    seen: !!seen,
    liked: !!liked,
    author: plain.author ? serializeAuthor(plain.author) : undefined
  };
}

/**
 * Regroupe des stories par auteur, dans l'ordre d'affichage d'Instagram :
 * les groupes contenant au moins une story non vue d'abord, puis les groupes
 * entièrement vus, chaque bloc trié du plus récent au plus ancien.
 */
function groupStoriesByAuthor(stories, viewerStoryStates) {
  const groups = new Map();

  stories.forEach((story) => {
    const authorId = String(story.user_id);
    const state = viewerStoryStates.get(String(story.id));
    const seen = !!state;
    if (!groups.has(authorId)) {
      groups.set(authorId, {
        user: serializeAuthor(story.author),
        stories: [],
        has_unseen: false,
        latest_at: null
      });
    }
    const group = groups.get(authorId);
    group.stories.push(serializeStory(story, { seen, liked: state?.reaction === 'like' }));
    if (!seen) group.has_unseen = true;
    const createdAt = new Date(story.created_at || story.createdAt || 0).getTime();
    if (!group.latest_at || createdAt > new Date(group.latest_at).getTime()) {
      group.latest_at = story.created_at || story.createdAt;
    }
  });

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      // À l'intérieur d'un groupe, Instagram joue toujours du plus ancien au
      // plus récent : on force cet ordre ici pour que le viewer n'ait rien à trier.
      stories: group.stories.sort(
        (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
      )
    }))
    .sort((a, b) => {
      if (a.has_unseen !== b.has_unseen) return a.has_unseen ? -1 : 1;
      return new Date(b.latest_at || 0).getTime() - new Date(a.latest_at || 0).getTime();
    });
}

/** Restreint une sélection d'ids aux stories réellement possédées par l'appelant. */
async function ownedStories(userId, storyIds) {
  const ids = [...new Set((storyIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  const stories = await Story.findAll({
    where: { id: { [Op.in]: ids }, user_id: userId },
    order: [['created_at', 'ASC']]
  });
  return stories;
}

/** Charge une « une » en vérifiant qu'elle appartient bien à l'appelant. */
async function ownedHighlight(highlightId, userId) {
  const record = await StoryHighlight.findByPk(String(highlightId || ''));
  if (!record) return { ok: false, status: 404, message: 'Story à la une introuvable' };
  if (String(record.user_id) !== String(userId)) {
    return { ok: false, status: 403, message: 'Accès refusé' };
  }
  return { ok: true, record };
}

/**
 * Les « unes » d'un profil, stories incluses. Contrairement au fil, aucune
 * condition d'expiration : c'est tout l'intérêt de l'épinglage.
 */
async function loadHighlights(userId) {
  if (!userId) return [];
  const highlights = await StoryHighlight.findAll({
    where: { user_id: String(userId) },
    include: [{
      model: StoryHighlightItem,
      as: 'items',
      required: false,
      include: [{ model: Story, as: 'story', required: true }]
    }],
    order: [['position', 'ASC'], ['created_at', 'ASC']]
  });

  return highlights.map((highlight) => {
    const items = (highlight.items || [])
      .filter((item) => item.story)
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    return {
      id: String(highlight.id),
      title: highlight.title,
      cover_url: highlight.cover_url || items[0]?.story?.media_url || null,
      position: Number(highlight.position || 0),
      story_count: items.length,
      stories: items.map((item) => serializeStory(item.story, { seen: true }))
    };
  });
}

async function loadViewerStoryStates(viewerId, storyIds) {
  if (!storyIds.length) return new Map();
  const views = await StoryView.findAll({
    where: { viewer_id: viewerId, story_id: { [Op.in]: storyIds } },
    attributes: ['story_id', 'reaction']
  });
  return new Map(views.map((view) => [String(view.story_id), {
    reaction: view.reaction || null
  }]));
}

/**
 * GET /api/stories/feed
 * Barre de stories : les miennes + celles des comptes que je suis.
 */
router.get('/feed', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const follows = await UserFollow.findAll({
      where: { follower_id: userId, status: 'active' },
      attributes: ['following_id']
    });
    const followingIds = follows.map((follow) => String(follow.following_id));
    const authorIds = [...new Set([String(userId), ...followingIds])];

    const stories = await Story.findAll({
      where: activeStoryWhere({ user_id: { [Op.in]: authorIds } }),
      include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRIBUTES, required: true }],
      order: [['created_at', 'ASC']],
      limit: 500
    });

    const viewerStoryStates = await loadViewerStoryStates(userId, stories.map((story) => String(story.id)));

    const mine = stories.filter((story) => String(story.user_id) === String(userId));
    const others = stories.filter((story) => String(story.user_id) !== String(userId));

    const me = await User.findByPk(userId, { attributes: AUTHOR_ATTRIBUTES });
    const selfGroup = {
      user: serializeAuthor(me),
      stories: mine
        .map((story) => serializeStory(story, { seen: true, liked: false }))
        .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()),
      has_unseen: false,
      latest_at: mine.length ? mine[mine.length - 1].created_at : null
    };

    return res.json({
      success: true,
      data: {
        self: selfGroup,
        groups: groupStoriesByAuthor(others, viewerStoryStates)
      }
    });
  } catch (error) {
    logger.error('Erreur chargement du fil de stories:', error);
    return res.status(500).json({ success: false, message: 'Impossible de charger les stories' });
  }
});

/**
 * GET /api/stories/user/:userId
 * Stories actives d'un profil (utilisé par l'anneau de l'avatar de profil).
 */
router.get('/user/:userId', authenticateToken, async (req, res) => {
  try {
    const targetId = String(req.params.userId || '');
    if (!targetId) {
      return res.status(400).json({ success: false, message: 'Utilisateur invalide' });
    }

    if (String(targetId) !== String(req.user.id)) {
      const targetUser = await User.findByPk(targetId, { attributes: ['is_private_account'] });
      if (targetUser?.is_private_account) {
        const isFollower = await UserFollow.isFollowing(req.user.id, targetId);
        if (!isFollower) {
          return res.json({ success: true, data: { user: null, stories: [], has_unseen: false } });
        }
      }
    }

    const stories = await Story.findAll({
      where: activeStoryWhere({ user_id: targetId }),
      include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRIBUTES, required: true }],
      order: [['created_at', 'ASC']],
      limit: 100
    });

    const viewerStoryStates = await loadViewerStoryStates(req.user.id, stories.map((story) => String(story.id)));
    const isOwner = String(targetId) === String(req.user.id);
    const items = stories.map((story) => {
      const state = viewerStoryStates.get(String(story.id));
      return serializeStory(story, {
        seen: isOwner || !!state,
        liked: !isOwner && state?.reaction === 'like'
      });
    });

    return res.json({
      success: true,
      data: {
        user: stories.length ? serializeAuthor(stories[0].author) : null,
        stories: items,
        has_unseen: items.some((item) => !item.seen)
      }
    });
  } catch (error) {
    logger.error('Erreur chargement des stories utilisateur:', error);
    return res.status(500).json({ success: false, message: 'Impossible de charger les stories' });
  }
});

/**
 * GET /api/stories/archive
 * Mes stories récentes, expirées comprises : c'est la réserve dans laquelle
 * on pioche pour composer une « une ». 30 jours, 90 pour un Ultra.
 */
router.get('/archive', authenticateToken, async (req, res) => {
  try {
    const window = await ultraLimit(req.user, ARCHIVE_WINDOW_MS_ULTRA, ARCHIVE_WINDOW_MS);
    const since = new Date(Date.now() - window);
    const stories = await Story.findAll({
      where: { user_id: req.user.id, created_at: { [Op.gt]: since } },
      order: [['created_at', 'DESC']],
      limit: 200
    });
    return res.json({
      success: true,
      data: { stories: stories.map((story) => serializeStory(story, { seen: true })) }
    });
  } catch (error) {
    logger.error('Erreur chargement archive stories:', error);
    return res.status(500).json({ success: false, message: 'Impossible de charger l\'archive' });
  }
});

/**
 * GET /api/stories/highlights/user/:userId
 * Les « unes » épinglées sur un profil, avec leurs stories.
 */
router.get('/highlights/user/:userId', authenticateToken, async (req, res) => {
  try {
    const targetId = String(req.params.userId || '');

    if (String(targetId) !== String(req.user.id)) {
      const targetUser = await User.findByPk(targetId, { attributes: ['is_private_account'] });
      if (targetUser?.is_private_account) {
        const isFollower = await UserFollow.isFollowing(req.user.id, targetId);
        if (!isFollower) {
          return res.json({ success: true, data: { highlights: [] } });
        }
      }
    }

    const highlights = await loadHighlights(targetId);
    return res.json({ success: true, data: { highlights } });
  } catch (error) {
    logger.error('Erreur chargement des unes:', error);
    return res.status(500).json({ success: false, message: 'Impossible de charger les stories à la une' });
  }
});

/**
 * POST /api/stories/highlights
 * Crée une « une » à partir de stories m'appartenant.
 */
router.post('/highlights', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 40) || 'À la une';
    const storyIds = Array.isArray(req.body?.storyIds) ? req.body.storyIds.map(String) : [];
    if (!storyIds.length) {
      return res.status(400).json({ success: false, message: 'Sélectionne au moins une story' });
    }

    const owned = await ownedStories(req.user.id, storyIds);
    if (!owned.length) {
      return res.status(400).json({ success: false, message: 'Aucune story valide dans la sélection' });
    }

    const lastPosition = await StoryHighlight.max('position', { where: { user_id: req.user.id } });
    const coverStory = owned.find((story) => String(story.id) === String(req.body?.coverStoryId)) || owned[0];

    const highlight = await StoryHighlight.create({
      user_id: req.user.id,
      title,
      cover_url: coverStory.thumbnail_url || coverStory.media_url,
      position: Number.isFinite(lastPosition) ? lastPosition + 1 : 0
    });

    await StoryHighlightItem.bulkCreate(
      owned.map((story, index) => ({ highlight_id: highlight.id, story_id: story.id, position: index }))
    );

    const highlights = await loadHighlights(req.user.id);
    return res.status(201).json({
      success: true,
      message: 'Story à la une créée',
      data: { highlight: highlights.find((item) => item.id === String(highlight.id)) || null }
    });
  } catch (error) {
    logger.error('Erreur création d\'une une:', error);
    return res.status(500).json({ success: false, message: 'Impossible de créer la story à la une' });
  }
});

/**
 * PATCH|PUT /api/stories/highlights/:highlightId
 * Renomme une « une » ou change sa couverture. Les deux verbes sont acceptés :
 * le client mobile n'expose que PUT dans son wrapper HTTP.
 */
const updateHighlightHandler = async (req, res) => {
  try {
    const highlight = await ownedHighlight(req.params.highlightId, req.user.id);
    if (!highlight.ok) return res.status(highlight.status).json({ success: false, message: highlight.message });

    const updates = {};
    if (typeof req.body?.title === 'string') {
      const title = req.body.title.trim().slice(0, 40);
      if (!title) return res.status(400).json({ success: false, message: 'Le titre ne peut pas être vide' });
      updates.title = title;
    }
    if (req.body?.coverStoryId) {
      const [cover] = await ownedStories(req.user.id, [String(req.body.coverStoryId)]);
      if (!cover) return res.status(400).json({ success: false, message: 'Story de couverture introuvable' });
      updates.cover_url = cover.thumbnail_url || cover.media_url;
    }
    if (Object.keys(updates).length) await highlight.record.update(updates);

    const highlights = await loadHighlights(req.user.id);
    return res.json({
      success: true,
      data: { highlight: highlights.find((item) => item.id === String(highlight.record.id)) || null }
    });
  } catch (error) {
    logger.error('Erreur mise à jour d\'une une:', error);
    return res.status(500).json({ success: false, message: 'Impossible de modifier la story à la une' });
  }
};

router.patch('/highlights/:highlightId', [authenticateToken, denySuspended], updateHighlightHandler);
router.put('/highlights/:highlightId', [authenticateToken, denySuspended], updateHighlightHandler);

/**
 * POST /api/stories/highlights/:highlightId/items
 * Ajoute des stories à une « une » existante.
 */
router.post('/highlights/:highlightId/items', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const highlight = await ownedHighlight(req.params.highlightId, req.user.id);
    if (!highlight.ok) return res.status(highlight.status).json({ success: false, message: highlight.message });

    const storyIds = Array.isArray(req.body?.storyIds) ? req.body.storyIds.map(String) : [];
    const owned = await ownedStories(req.user.id, storyIds);
    if (!owned.length) return res.status(400).json({ success: false, message: 'Aucune story valide dans la sélection' });

    const lastPosition = await StoryHighlightItem.max('position', {
      where: { highlight_id: highlight.record.id }
    });
    const base = Number.isFinite(lastPosition) ? lastPosition + 1 : 0;

    // `ignoreDuplicates` s'appuie sur l'index unique (highlight_id, story_id) :
    // ré-ajouter une story déjà présente ne crée pas de doublon ni d'erreur.
    await StoryHighlightItem.bulkCreate(
      owned.map((story, index) => ({
        highlight_id: highlight.record.id,
        story_id: story.id,
        position: base + index
      })),
      { ignoreDuplicates: true }
    );

    const highlights = await loadHighlights(req.user.id);
    return res.json({
      success: true,
      data: { highlight: highlights.find((item) => item.id === String(highlight.record.id)) || null }
    });
  } catch (error) {
    logger.error('Erreur ajout à une une:', error);
    return res.status(500).json({ success: false, message: 'Impossible d\'ajouter la story' });
  }
});

/**
 * DELETE /api/stories/highlights/:highlightId/items/:storyId
 * Retire une story d'une « une » (la story elle-même n'est pas supprimée).
 */
router.delete('/highlights/:highlightId/items/:storyId', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const highlight = await ownedHighlight(req.params.highlightId, req.user.id);
    if (!highlight.ok) return res.status(highlight.status).json({ success: false, message: highlight.message });

    await StoryHighlightItem.destroy({
      where: { highlight_id: highlight.record.id, story_id: String(req.params.storyId || '') }
    });

    // Une « une » vide n'a plus de sens sur un profil : on la retire.
    const remaining = await StoryHighlightItem.count({ where: { highlight_id: highlight.record.id } });
    if (!remaining) await highlight.record.destroy();

    return res.json({ success: true, data: { highlights: await loadHighlights(req.user.id) } });
  } catch (error) {
    logger.error('Erreur retrait d\'une story d\'une une:', error);
    return res.status(500).json({ success: false, message: 'Impossible de retirer la story' });
  }
});

/**
 * DELETE /api/stories/highlights/:highlightId
 */
router.delete('/highlights/:highlightId', [authenticateToken, denySuspended], async (req, res) => {
  try {
    const highlight = await ownedHighlight(req.params.highlightId, req.user.id);
    if (!highlight.ok) return res.status(highlight.status).json({ success: false, message: highlight.message });

    await StoryHighlightItem.destroy({ where: { highlight_id: highlight.record.id } });
    await highlight.record.destroy();

    return res.json({ success: true, message: 'Story à la une supprimée' });
  } catch (error) {
    logger.error('Erreur suppression d\'une une:', error);
    return res.status(500).json({ success: false, message: 'Impossible de supprimer la story à la une' });
  }
});

/**
 * POST /api/stories
 * Publie une story (champ fichier `media`, légende optionnelle `caption`).
 */
router.post('/', [authenticateToken, denySuspended, upload.single('media')], async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Fichier manquant (champ "media")' });
    }

    const userId = req.user.id;
    fs.mkdirSync(STORIES_DIR, { recursive: true });

    const isVideo = String(req.file.mimetype || '').startsWith('video/');
    const extension = isVideo
      ? (path.extname(req.file.originalname || '').toLowerCase() || '.mp4')
      : '.jpg';
    const filename = `story-${userId}-${Date.now()}-${uuidv4().slice(0, 8)}${extension}`;
    const outputPath = path.join(STORIES_DIR, filename);

    if (isVideo) {
      fs.writeFileSync(outputPath, req.file.buffer);
    } else {
      // Une photo prise sur iPhone arrive en HEIC, que le libvips embarqué par
      // `sharp` ne sait pas décoder — voir `heifDecoder`. Sans cette
      // conversion, toute story photographiée sur iPhone échouait sur
      // « bad seek », y compris sur des fichiers parfaitement intacts.
      const decodable = await toDecodableBuffer(req.file.buffer);

      // Format story : 9:16 max 1080x1920, sans agrandir une petite image.
      await sharp(decodable)
        .rotate()
        .resize(1080, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(outputPath);
    }

    const mediaUrl = buildStaticMediaPublicUrl('stories', filename);
    const isUltra = await isUltraRequest(req.user);
    const captionMax = isUltra ? CAPTION_MAX_ULTRA : CAPTION_MAX;
    const caption = typeof req.body?.caption === 'string'
      ? req.body.caption.trim().slice(0, captionMax)
      : null;

    const story = await Story.create({
      user_id: userId,
      media_url: mediaUrl,
      media_type: isVideo ? 'video' : 'image',
      thumbnail_url: isVideo ? null : mediaUrl,
      caption: caption || null,
      duration_ms: isVideo
        ? (isUltra ? VIDEO_DURATION_MS_ULTRA : VIDEO_DURATION_MS)
        : IMAGE_DURATION_MS,
      expires_at: new Date(Date.now() + (isUltra ? STORY_TTL_MS_ULTRA : STORY_TTL_MS))
    });

    const author = await User.findByPk(userId, { attributes: AUTHOR_ATTRIBUTES });

    return res.status(201).json({
      success: true,
      message: 'Story publiée',
      data: { story: { ...serializeStory(story, { seen: true }), author: serializeAuthor(author) } }
    });
  } catch (error) {
    logger.error('Erreur publication story:', error);
    return res.status(500).json({ success: false, message: 'Impossible de publier la story' });
  }
});

/**
 * POST /api/stories/:storyId/view
 * Marque une story comme vue. Idempotent grâce à l'index unique.
 */
router.post('/:storyId/view', authenticateToken, async (req, res) => {
  try {
    const storyId = String(req.params.storyId || '');
    const viewerId = req.user.id;

    const story = await Story.findOne({ where: activeStoryWhere({ id: storyId }) });
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story introuvable ou expirée' });
    }

    if (String(story.user_id) === String(viewerId)) {
      return res.json({ success: true, data: { views_count: Number(story.views_count || 0) } });
    }

    const [, created] = await StoryView.findOrCreate({
      where: { story_id: storyId, viewer_id: viewerId },
      defaults: { story_id: storyId, viewer_id: viewerId }
    });

    if (created) {
      await story.increment('views_count', { by: 1 });
      await story.reload();
    }

    return res.json({ success: true, data: { views_count: Number(story.views_count || 0) } });
  } catch (error) {
    logger.error('Erreur enregistrement vue de story:', error);
    return res.status(500).json({ success: false, message: 'Impossible d\'enregistrer la vue' });
  }
});

/**
 * PUT /api/stories/:storyId/like
 * Pose ou retire un like. Le client envoie l'état final désiré (`liked`) :
 * l'appel reste donc idempotent même après un retry réseau.
 */
router.put('/:storyId/like', [authenticateToken, denySuspended], async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const storyId = String(req.params.storyId || '');
    const viewerId = req.user.id;
    const story = await Story.findOne({
      where: activeStoryWhere({ id: storyId }),
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    if (!story) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Story introuvable ou expirée' });
    }
    if (String(story.user_id) === String(viewerId)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: 'Tu ne peux pas liker ta propre story' });
    }

    const [view, created] = await StoryView.findOrCreate({
      where: { story_id: storyId, viewer_id: viewerId },
      defaults: { story_id: storyId, viewer_id: viewerId },
      transaction
    });
    const wasLiked = view.reaction === 'like';
    const liked = typeof req.body?.liked === 'boolean' ? req.body.liked : !wasLiked;
    const likesDelta = liked === wasLiked ? 0 : (liked ? 1 : -1);
    const viewsDelta = created ? 1 : 0;

    if (liked !== wasLiked) {
      await view.update({ reaction: liked ? 'like' : null }, { transaction });
    }
    if (likesDelta || viewsDelta) {
      await story.update({
        likes_count: Math.max(0, Number(story.likes_count || 0) + likesDelta),
        views_count: Math.max(0, Number(story.views_count || 0) + viewsDelta)
      }, { transaction });
    }

    await transaction.commit();
    if (likesDelta > 0) {
      setImmediate(async () => {
        try {
          const liker = await User.findByPk(viewerId, { attributes: ['username', 'full_name'] });
          const likerName = liker?.username ? `@${liker.username}` : liker?.full_name || 'Quelqu’un';
          await Notification.createNotification({
            recipient_id: story.user_id,
            sender_id: viewerId,
            type: 'like',
            title: `${likerName} a aimé votre story`,
            message: 'Nouveau like sur votre story',
            priority: 'normal',
            content: {
              entity_type: 'story_like',
              story_id: String(story.id),
              story_media_url: story.media_url || null,
              story_thumbnail_url: story.thumbnail_url || null,
              story_media_type: story.media_type || 'image',
              story_caption: story.caption || null
            },
            metadata: {
              source: 'stories',
              story_id: String(story.id)
            }
          });
        } catch (notificationError) {
          logger.warn('Notification de like de story non envoyée (non bloquant):', notificationError?.message || notificationError);
        }
      });
    }
    return res.json({
      success: true,
      data: {
        liked,
        likes_count: Number(story.likes_count || 0),
        views_count: Number(story.views_count || 0)
      }
    });
  } catch (error) {
    if (!transaction.finished) await transaction.rollback();
    logger.error('Erreur like de story:', error);
    return res.status(500).json({ success: false, message: 'Impossible de liker la story' });
  }
});

/**
 * GET /api/stories/:storyId/viewers
 * Liste des personnes ayant vu ma story (réservé à son auteur).
 */
router.get('/:storyId/viewers', authenticateToken, async (req, res) => {
  try {
    const storyId = String(req.params.storyId || '');
    const story = await Story.findByPk(storyId);
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story introuvable' });
    }
    if (String(story.user_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Accès refusé' });
    }

    const views = await StoryView.findAll({
      where: { story_id: storyId },
      include: [{ model: User, as: 'viewer', attributes: AUTHOR_ATTRIBUTES, required: true }],
      order: [['created_at', 'DESC']],
      limit: 200
    });

    return res.json({
      success: true,
      data: {
        views_count: Number(story.views_count || 0),
        likes_count: Number(story.likes_count || 0),
        viewers: views.map((view) => ({
          ...serializeAuthor(view.viewer),
          viewed_at: view.created_at || view.createdAt,
          liked: view.reaction === 'like'
        }))
      }
    });
  } catch (error) {
    logger.error('Erreur chargement des vues de story:', error);
    return res.status(500).json({ success: false, message: 'Impossible de charger les vues' });
  }
});

/**
 * DELETE /api/stories/:storyId
 */
router.delete('/:storyId', authenticateToken, async (req, res) => {
  try {
    const story = await Story.findByPk(String(req.params.storyId || ''));
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story introuvable' });
    }
    if (String(story.user_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Accès refusé' });
    }

    await story.destroy();
    return res.json({ success: true, message: 'Story supprimée' });
  } catch (error) {
    logger.error('Erreur suppression story:', error);
    return res.status(500).json({ success: false, message: 'Impossible de supprimer la story' });
  }
});

/**
 * Purge des stories sorties de la fenêtre d'archive (30 jours après
 * expiration). Deux garde-fous : une story épinglée dans une « une » n'est
 * JAMAIS supprimée — sinon la une se viderait toute seule — et le fichier
 * média part avant la ligne, pour ne pas laisser d'orphelin sur le disque.
 */
async function purgeExpiredStories() {
  try {
    // Deux échéances, parce que l'archive n'a pas la même profondeur selon le
    // palier de l'AUTEUR. Purger tout à 30 jours viderait la réserve qu'un
    // Ultra a le droit de relire pendant 90 — l'avantage n'aurait alors
    // aucune existence réelle, juste une ligne d'argumentaire.
    const cutoff = new Date(Date.now() - ARCHIVE_WINDOW_MS);
    const ultraCutoff = new Date(Date.now() - ARCHIVE_WINDOW_MS_ULTRA);

    // AUDIT R3-10 (2026-08-19) : la table des épinglages ne fait QUE croître
    // (une story épinglée n'est jamais supprimée) et était chargée en
    // entier, sans filtre, à chaque passage de la purge, pour bâtir un
    // littéral `NOT IN` — sur lequel aucun index ne peut aider. À terme, la
    // purge devient plus coûteuse que ce qu'elle purge, puis cesse de
    // pouvoir s'exécuter (littéral de plusieurs dizaines de Mo). `NOT
    // EXISTS` transforme ça en anti-jointure indexée, de taille constante.
    const expired = await Story.findAll({
      where: {
        id: {
          [Op.notIn]: literal('(SELECT story_id FROM story_highlight_items)')
        },
        [Op.or]: [
          // Au-delà de la fenêtre la plus longue, plus personne n'y a droit.
          { expires_at: { [Op.lt]: ultraCutoff } },
          // Entre les deux : on ne supprime que ce qui n'appartient pas à un
          // Ultra ENCORE abonné. Le sous-select rejoue `isUltraActive` en SQL
          // — la purge tourne sans requête HTTP, elle n'a pas de `req.user`.
          {
            expires_at: { [Op.lt]: cutoff },
            user_id: {
              [Op.notIn]: literal(
                `(SELECT id FROM users
                   WHERE subscription_tier = 'ultra'
                     AND (subscription_expires_at IS NULL OR subscription_expires_at > NOW()))`
              )
            }
          }
        ]
      },
      paranoid: false,
      limit: 500
    });
    if (!expired.length) return 0;

    for (const story of expired) {
      const filename = path.basename(String(story.media_url || ''));
      const filePath = path.join(STORIES_DIR, filename);
      try {
        if (filename && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (fileError) {
        logger.warn(`Purge story: fichier non supprimé (${filename}): ${fileError.message}`);
      }
    }

    const ids = expired.map((story) => story.id);
    await StoryView.destroy({ where: { story_id: { [Op.in]: ids } } });
    await Story.destroy({ where: { id: { [Op.in]: ids } }, force: true });
    logger.info(`Purge stories: ${ids.length} story(s) supprimée(s)`);
    return ids.length;
  } catch (error) {
    logger.error('Erreur purge des stories expirées:', error);
    return 0;
  }
}

module.exports = router;
module.exports.purgeExpiredStories = purgeExpiredStories;
