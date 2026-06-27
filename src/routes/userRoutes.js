const express = require('express');
const { param, query, validationResult } = require('express-validator');
const router = express.Router();

// Import des modèles et services
const { User, UserFollow, Tweet, TweetLike, TweetRetweet, sequelize } = require('../models');
const { Op } = require('sequelize');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const { checkUserBanStrict, checkUserBanReadOnly } = require('../middleware/banMiddleware');
const BanService = require('../services/banService');
const logger = require('../utils/logger');
const ctrTracker = require('../services/ctrTracker');
const { TIER, TIER_PRICES_TWC, DEFAULT_DURATION_DAYS } = require('../constants/subscriptionTiers');
const {
  maybeExpireSubscription,
  isSubscriptionActive,
  computeNewExpiry,
  normalizePurchasableTier,
} = require('../utils/subscriptionHelpers');

const { buildStaticMediaPublicUrl } = require('../utils/publicMediaOrigin');

// Middleware de validation des erreurs
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Données invalides',
      errors: errors.array()
    });
  }
  next();
};

/**
 * Achat ou prolongation d'abonnement payant (Plus / Pro) en TWC.
 * @param {string|null} explicitTier — si défini (ex. 'plus'), ignore req.body.tier
 */
async function handleSubscriptionPurchase(req, res, explicitTier) {
  const transaction = await sequelize.transaction();

  try {
    const tier = explicitTier != null
      ? normalizePurchasableTier(explicitTier)
      : normalizePurchasableTier(req.body.tier);

    if (!tier) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Palier invalide. Utilisez « plus » ou « pro ».'
      });
    }

    const duration = req.body.duration;
    const userId = req.user.id;
    const currencyId = '077ae58c-7ba5-4da0-bb67-5829a83a2ea1';
    const NewEconomyService = require('../services/newEconomyService');

    const user = await User.findByPk(userId, { transaction, lock: true });
    if (!user) {
      await transaction.rollback();
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    await maybeExpireSubscription(user, transaction);
    await user.reload({ transaction, lock: true });

    const active = isSubscriptionActive(user);

    if (active && user.subscription_tier === TIER.PRO && tier === TIER.PLUS) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: 'Vous avez déjà un abonnement Pro. Le palier Plus n\'est pas disponible.'
      });
    }

    let price = TIER_PRICES_TWC[tier];
    let itemId = `subscription_${tier}_${DEFAULT_DURATION_DAYS}d`;
    const durationDays = Math.max(1, parseInt(duration, 10) || DEFAULT_DURATION_DAYS);
    let description = `Abonnement ${tier === TIER.PLUS ? 'Plus' : 'Pro'} (${durationDays} j.)`;

    if (active && user.subscription_tier === TIER.PLUS && tier === TIER.PRO) {
      price = TIER_PRICES_TWC[TIER.PRO] - TIER_PRICES_TWC[TIER.PLUS];
      itemId = 'subscription_upgrade_plus_to_pro';
      description = 'Mise à niveau Plus → Pro';
      if (price <= 0) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: 'Montant de mise à niveau invalide.'
        });
      }
    }

    await NewEconomyService.ensureWalletsForUser(userId, transaction);

    let userWallet;
    try {
      userWallet = await NewEconomyService.getUserWallet(currencyId, userId, transaction);
    } catch (walletError) {
      console.error('❌ [SUB] Erreur récupération wallet:', walletError);
      await transaction.rollback();
      return res.status(500).json({
        success: false,
        message: 'Impossible de vérifier votre solde'
      });
    }

    if (userWallet.wallet.balance < price) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: `Solde insuffisant. Vous avez ${userWallet.wallet.balance} TWC, il en faut ${price} TWC.`,
        data: {
          current_balance: userWallet.wallet.balance,
          required_amount: price,
          missing_amount: price - userWallet.wallet.balance
        }
      });
    }

    let spendResult;
    try {
      spendResult = await NewEconomyService.spendCoins(
        userId,
        currencyId,
        price,
        'subscription_purchase',
        itemId,
        description,
        transaction
      );
    } catch (spendError) {
      console.error('❌ [SUB] Erreur transaction TWC:', spendError);
      await transaction.rollback();
      return res.status(500).json({
        success: false,
        message: 'Erreur lors de la transaction. Vos TWC n\'ont pas été débités.'
      });
    }

    let nextExpiry;
    if (active && user.subscription_tier === TIER.PLUS && tier === TIER.PRO) {
      nextExpiry = user.subscription_expires_at
        ? new Date(user.subscription_expires_at)
        : computeNewExpiry(user, durationDays);
    } else {
      nextExpiry = computeNewExpiry(user, durationDays);
    }

    await user.update(
      {
        subscription_tier: tier,
        subscription_expires_at: nextExpiry,
        updated_at: new Date()
      },
      { transaction }
    );

    await transaction.commit();

    res.json({
      success: true,
      message: tier === TIER.PRO ? 'Abonnement Pro activé !' : 'Abonnement Plus activé !',
      data: {
        premium: true,
        subscription_tier: tier,
        subscription_expires_at: nextExpiry,
        duration_days: durationDays,
        transaction_id: spendResult.transaction.transactionHash,
        amount_spent: price,
        remaining_balance: spendResult.remainingBalance
      }
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('Erreur lors de l\'achat d\'abonnement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'achat de l\'abonnement'
    });
  }
}

// ========================================
// ROUTES PUBLIQUES (sans authentification)
// ========================================

/**
 * GET /api/users/suggestions
 * Obtenir des suggestions d'utilisateurs à suivre
 */
router.get('/suggestions', [
  authenticateToken,
  denySuspended,
  query('limit').optional().isInt({ min: 1, max: 20 }).withMessage('La limite doit être entre 1 et 20'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const userId = req.user.id;

    const suggestions = await UserFollow.getFollowSuggestions(userId, parseInt(limit));

    res.json({
      success: true,
      message: 'Suggestions d\'utilisateurs récupérées avec succès',
      data: { suggestions }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des suggestions:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/profile/:username
 * Obtenir le profil public d'un utilisateur par son username
 */
router.get('/profile/:username', [
  param('username').isLength({ min: 1, max: 30 }).withMessage('Username doit être entre 1 et 30 caractères'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { username } = req.params;
    
    const user = await User.findOne({
      where: { 
        username: username,
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'banner', 'bio', 'verified', 'premium', 'subscription_tier', 'verification_style', 'stats', 'created_at', 'last_activity']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Profil introuvable'
      });
    }

    res.json({
      success: true,
      message: 'Profil utilisateur récupéré avec succès',
      data: { user }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération du profil utilisateur par username:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/profile/authenticated/:username
 * Obtenir le profil d'un utilisateur par son username (authentifié),
 * en incluant des informations de relation (ex: isFollowing)
 */
router.get('/profile/authenticated/:username', [
  authenticateToken,
  checkUserBanReadOnly,
  param('username').isLength({ min: 1, max: 30 }).withMessage('Username doit être entre 1 et 30 caractères'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { username } = req.params;
    const currentUserId = req.user.id;

    const user = await User.findOne({
      where: {
        username: username,
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'banner', 'verified', 'premium', 'subscription_tier', 'verification_style', 'stats', 'created_at', 'last_activity']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Profil introuvable'
      });
    }

    // 📊 Track profile view pour l'algorithme Rust
    if (currentUserId && user.id !== currentUserId) {
      ctrTracker.trackProfileView(currentUserId, user.id).catch(err => {
        logger.warn(`CTR tracking error: ${err.message}`);
      });
    }

    // Déterminer la relation de suivi si l'utilisateur courant n'est pas le même
    let isFollowing = false;
    if (currentUserId && user.id !== currentUserId) {
      isFollowing = await UserFollow.isFollowing(currentUserId, user.id);
    }

    res.json({
      success: true,
      message: 'Profil utilisateur (auth) récupéré avec succès',
      data: { user, isFollowing }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération du profil utilisateur (auth):', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/:id
 * Obtenir le profil public d'un utilisateur par son ID
 */
router.get('/:id', [
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    
    const user = await User.findOne({
      where: { 
        id: id,
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'banner', 'bio', 'verified', 'premium', 'verification_style', 'stats', 'created_at', 'last_activity']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Profil introuvable'
      });
    }

    res.json({
      success: true,
      message: 'Profil utilisateur récupéré avec succès',
      data: { user }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération du profil utilisateur:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/:id/tweets
 * Obtenir les tweets d'un utilisateur
 */
router.get('/:id/tweets', [
  authenticateToken,
  checkUserBanReadOnly,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  query('type').optional().isIn(['all', 'tweets', 'replies', 'retweets']).withMessage('Type de tweet invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0, type = 'all' } = req.query;

    // Vérifier que l'utilisateur existe
    const user = await User.findOne({
      where: { 
        id: id,
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Profil introuvable'
      });
    }

    // Utilisateur authentifié via middleware
    const currentUserId = req.user.id;

    let tweets = [];
    let totalCount = 0;

    if (type === 'retweets') {
      // Récupérer les retweets via la table TweetRetweet
      const retweets = await TweetRetweet.findAll({
        where: { user_id: id },
        include: [{
          model: Tweet,
          as: 'tweet',
          include: [{
            model: User,
            as: 'author',
            attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style']
          }]
        }],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      totalCount = await TweetRetweet.count({ where: { user_id: id } });

      // Mapper vers les tweets enrichis
      tweets = await Promise.all(retweets.map(async (rt) => {
        const tweet = rt.tweet;
        const likeCount = await TweetLike.count({ where: { tweet_id: tweet.id } });
        const retweetCount = await TweetRetweet.count({ where: { tweet_id: tweet.id } });
        const replyCount = await Tweet.count({ where: { parent_tweet_id: tweet.id } });

        let isLiked = false;
        let isRetweeted = false; // statut pour l'utilisateur connecté, pas le propriétaire du profil
        if (currentUserId) {
          isLiked = await TweetLike.hasUserLikedTweet(currentUserId, tweet.id);
          isRetweeted = await TweetRetweet.hasUserRetweetedTweet(currentUserId, tweet.id);
        }

        return {
          ...tweet.toJSON(),
          stats: {
            likes: likeCount,
            retweets: retweetCount,
            replies: replyCount,
            views: tweet.view_count || 0
          },
          user_interaction: {
            is_liked: isLiked,
            is_retweeted: isRetweeted
          }
        };
      }));
    } else {
      // Tweets et réponses (et éventuellement all)
      const whereClause = { user_id: id, is_private: false, moderation_status: 'approved' };
      if (type === 'replies') {
        whereClause.parent_tweet_id = { [Op.ne]: null };
        whereClause.is_retweet = false;
        whereClause.is_quote = false;
      } else if (type === 'tweets') {
        whereClause.parent_tweet_id = null;
        whereClause.is_retweet = false;
        whereClause.is_quote = false;
      }

      const rawTweets = await Tweet.findAll({
        where: whereClause,
        include: [{
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style']
        }],
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      totalCount = await Tweet.count({ where: whereClause });

      tweets = await Promise.all(rawTweets.map(async (tweet) => {
        const likeCount = await TweetLike.count({ where: { tweet_id: tweet.id } });
        const retweetCount = await TweetRetweet.count({ where: { tweet_id: tweet.id } });
        const replyCount = await Tweet.count({ where: { parent_tweet_id: tweet.id } });
        let isLiked = false;
        let isRetweeted = false;
        if (currentUserId) {
          isLiked = await TweetLike.hasUserLikedTweet(currentUserId, tweet.id);
          isRetweeted = await TweetRetweet.hasUserRetweetedTweet(currentUserId, tweet.id);
        }
        return {
          ...tweet.toJSON(),
          stats: {
            likes: likeCount,
            retweets: retweetCount,
            replies: replyCount,
            views: tweet.view_count || 0
          },
          user_interaction: {
            is_liked: isLiked,
            is_retweeted: isRetweeted
          }
        };
      }));
    }

    res.json({
      success: true,
      message: 'Tweets de l\'utilisateur récupérés avec succès',
      data: {
        user,
        tweets,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + tweets.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des tweets de l\'utilisateur:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/:id/followers
 * Obtenir les followers d'un utilisateur
 */
router.get('/:id/followers', [
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Vérifier que l'utilisateur existe
    const user = await User.findByPk(id, {
      where: { is_active: true },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    const followers = await UserFollow.getFollowers(id, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      includeUser: true
    });

    // Compter le total
    const totalCount = await UserFollow.countFollowers(id);

    res.json({
      success: true,
      message: 'Followers récupérés avec succès',
      data: {
        user,
        followers: followers.map(f => f.follower),
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + followers.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des followers:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * GET /api/users/:id/following
 * Obtenir les utilisateurs suivis par un utilisateur
 */
router.get('/:id/following', [
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('La limite doit être entre 1 et 100'),
  query('offset').optional().isInt({ min: 0 }).withMessage('L\'offset doit être un nombre positif'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    // Vérifier que l'utilisateur existe
    const user = await User.findByPk(id, {
      where: { is_active: true },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'verification_style']
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    const following = await UserFollow.getFollowing(id, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      includeUser: true
    });

    // Compter le total
    const totalCount = await UserFollow.countFollowing(id);

    res.json({
      success: true,
      message: 'Utilisateurs suivis récupérés avec succès',
      data: {
        user,
        following: following.map(f => f.following),
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: offset + following.length < totalCount
        }
      }
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération des utilisateurs suivis:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

// ========================================
// ROUTES PROTÉGÉES (avec authentification)
// ========================================

/**
 * POST /api/users/:id/follow
 * S'abonner à un utilisateur
 */
router.post('/:id/follow', [
  authenticateToken,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const followerId = req.user.id;
    const followingId = req.params.id;

    // Vérifier que l'utilisateur ne suit pas lui-même
    if (followerId === followingId) {
      return res.status(400).json({
        success: false,
        message: 'Vous ne pouvez pas vous suivre vous-même'
      });
    }

    // Vérifier que l'utilisateur à suivre existe
    const userToFollow = await User.findByPk(followingId, {
      where: { is_active: true }
    });

    if (!userToFollow) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur à suivre non trouvé'
      });
    }

    // Vérifier si l'utilisateur suit déjà
    const existingFollow = await UserFollow.findOne({
      where: {
        follower_id: followerId,
        following_id: followingId
      }
    });

    if (existingFollow) {
      return res.status(400).json({
        success: false,
        message: 'Vous suivez déjà cet utilisateur'
      });
    }

    // Créer le suivi
    const follow = await UserFollow.create({
      follower_id: followerId,
      following_id: followingId,
      status: 'active',
      metadata: {
        source: req.userPlatform || 'unknown',
        device: req.headers['user-agent'] || 'unknown',
        ip_address: req.ip
      }
    });

    // 🔗 Mettre à jour le graphe social du moteur de similarité en temps réel
    try {
      const similarity = require('../services/similarity');
      similarity.onFollow(followerId, followingId);

      // 🎬 [VideoReco] New video engine follow
      const videoRecommendationService = require('../services/videoRecommendationService');
      videoRecommendationService.onFollow(followerId, followingId, true);
    } catch (e) { /* non-critique */ }

    res.status(201).json({
      success: true,
      message: 'Abonnement créé avec succès',
      data: { follow }
    });

  } catch (error) {
    logger.error('Erreur lors de la création de l\'abonnement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * DELETE /api/users/:id/follow
 * Se désabonner d'un utilisateur
 */
router.delete('/:id/follow', [
  authenticateToken,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const followerId = req.user.id;
    const followingId = req.params.id;

    // Vérifier que l'utilisateur ne se désabonne pas de lui-même
    if (followerId === followingId) {
      return res.status(400).json({
        success: false,
        message: 'Opération invalide'
      });
    }

    // Vérifier si l'utilisateur suit déjà
    const existingFollow = await UserFollow.findOne({
      where: {
        follower_id: followerId,
        following_id: followingId
      }
    });

    if (!existingFollow) {
      return res.status(400).json({
        success: false,
        message: 'Vous ne suivez pas cet utilisateur'
      });
    }

    // Supprimer le suivi
    await existingFollow.destroy();

    // 🔗 Mettre à jour le graphe social du moteur de similarité en temps réel
    try {
      const similarity = require('../services/similarity');
      similarity.onUnfollow(followerId, followingId);

      // 🎬 [VideoReco] New video engine unfollow
      const videoRecommendationService = require('../services/videoRecommendationService');
      videoRecommendationService.onFollow(followerId, followingId, false);
    } catch (e) { /* non-critique */ }

    res.json({
      success: true,
      message: 'Désabonnement effectué avec succès'
    });

  } catch (error) {
    logger.error('Erreur lors de la suppression de l\'abonnement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/users/me/avatar
 * Importer une image d'avatar, la stocker et mettre à jour l'URL de profil
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Seules les images sont autorisées'));
    }
    cb(null, true);
  }
});

router.post('/me/avatar', [
  authenticateToken,
  upload.single('avatar')
], async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Fichier avatar manquant (champ "avatar")' });
    }

    const userId = req.user.id;
    const avatarsDir = path.join(__dirname, '../public/avatars');
    fs.mkdirSync(avatarsDir, { recursive: true });

    const filename = `${userId}-${Date.now()}-${uuidv4().slice(0,8)}.jpg`;
    const outputPath = path.join(avatarsDir, filename);

    // Traitement image: carré 256x256, couverture, JPEG qualité 85
    await sharp(req.file.buffer)
      .rotate()
      .resize(256, 256, { fit: 'cover', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(outputPath);

    const publicUrl = buildStaticMediaPublicUrl('avatars', filename);

    // Mettre à jour l'utilisateur
    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }
    user.avatar = publicUrl;
    logger.info(`Avatar DB URL: ${publicUrl}`);
    await user.save();

    return res.status(201).json({
      success: true,
      message: 'Avatar mis à jour avec succès',
      data: { url: publicUrl }
    });
  } catch (error) {
    logger.error('Erreur upload avatar:', error);
    return res.status(500).json({ success: false, message: 'Erreur lors de l\'upload de l\'avatar' });
  }
});

/**
 * POST /api/users/me/banner
 * Bannière profil (image large), stockée et URL enregistrée sur l'utilisateur
 */
router.post('/me/banner', [
  authenticateToken,
  upload.single('banner')
], async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Fichier bannière manquant (champ "banner")' });
    }

    const userId = req.user.id;
    const bannersDir = path.join(__dirname, '../public/banners');
    fs.mkdirSync(bannersDir, { recursive: true });

    const filename = `banner-${userId}-${Date.now()}-${uuidv4().slice(0, 8)}.jpg`;
    const outputPath = path.join(bannersDir, filename);

    await sharp(req.file.buffer)
      .rotate()
      .resize(1500, 500, { fit: 'cover', withoutEnlargement: false })
      .jpeg({ quality: 82 })
      .toFile(outputPath);

    const publicUrl = buildStaticMediaPublicUrl('banners', filename);

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }
    user.banner = publicUrl;
    logger.info(`Banner DB URL: ${publicUrl}`);
    await user.save();

    return res.status(201).json({
      success: true,
      message: 'Bannière mise à jour avec succès',
      data: { url: publicUrl }
    });
  } catch (error) {
    logger.error('Erreur upload bannière:', error);
    return res.status(500).json({ success: false, message: 'Erreur lors de l\'upload de la bannière' });
  }
});

/**
 * GET /api/users/:id/follow-status
 * Vérifier le statut de suivi entre deux utilisateurs
 */
router.get('/:id/follow-status', [
  authenticateToken,
  param('id').notEmpty().withMessage('ID d\'utilisateur requis'),
  handleValidationErrors
], async (req, res) => {
  try {
    const followerId = req.user.id;
    const followingId = req.params.id;

    // Vérifier si l'utilisateur suit déjà
    const isFollowing = await UserFollow.isFollowing(followerId, followingId);

    res.json({
      success: true,
      message: 'Statut de suivi récupéré avec succès',
      data: { isFollowing }
    });

  } catch (error) {
    logger.error('Erreur lors de la vérification du statut de suivi:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

// ========================================
// ROUTES D'ADMINISTRATION DES BANS
// ========================================

/**
 * POST /api/users/:id/suspend
 * Suspendre un utilisateur (admin seulement)
 */
router.post('/:id/suspend', [
  authenticateToken,
  checkUserBanStrict, // Vérifier que l'admin n'est pas banni
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, duration_days = 7 } = req.body;
    const adminId = req.user.id;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Raison de suspension requise'
      });
    }

    const result = await BanService.suspendUser(id, reason, duration_days, adminId);

    res.json({
      success: true,
      message: 'Utilisateur suspendu avec succès',
      data: result
    });

  } catch (error) {
    logger.error('Erreur lors de la suspension:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suspension'
    });
  }
});

/**
 * POST /api/users/:id/unsuspend
 * Lever la suspension d'un utilisateur (admin seulement)
 */
router.post('/:id/unsuspend', [
  authenticateToken,
  checkUserBanStrict,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const result = await BanService.unsuspendUser(id, adminId);

    res.json({
      success: true,
      message: 'Suspension levée avec succès',
      data: result
    });

  } catch (error) {
    logger.error('Erreur lors de la levée de suspension:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la levée de suspension'
    });
  }
});

/**
 * POST /api/users/:id/ban
 * Ajouter un ban à un utilisateur (admin seulement)
 */
router.post('/:id/ban', [
  authenticateToken,
  checkUserBanStrict,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user.id;

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Raison du ban requise'
      });
    }

    const result = await BanService.addBan(id, reason, adminId);

    res.json({
      success: true,
      message: 'Ban ajouté avec succès',
      data: result
    });

  } catch (error) {
    logger.error('Erreur lors de l\'ajout du ban:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'ajout du ban'
    });
  }
});

/**
 * POST /api/users/:id/unban
 * Réduire le nombre de bans d'un utilisateur (admin seulement)
 */
router.post('/:id/unban', [
  authenticateToken,
  checkUserBanStrict,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const result = await BanService.reduceBan(id, adminId);

    res.json({
      success: true,
      message: 'Ban réduit avec succès',
      data: result
    });

  } catch (error) {
    logger.error('Erreur lors de la réduction du ban:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la réduction du ban'
    });
  }
});

/**
 * GET /api/users/:id/ban-history
 * Obtenir l'historique des bans d'un utilisateur
 */
router.get('/:id/ban-history', [
  authenticateToken,
  checkUserBanReadOnly,
  param('id').isUUID().withMessage('ID d\'utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id } = req.params;
    const history = await BanService.getBanHistory(id);

    res.json({
      success: true,
      message: 'Historique des bans récupéré avec succès',
      data: history
    });

  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'historique des bans:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération de l\'historique des bans'
    });
  }
});

/**
 * POST /api/users/purchase-subscription
 * Acheter ou prolonger un abonnement payant (body.tier: « plus » | « pro »).
 */
router.post('/purchase-subscription', [
  authenticateToken,
  denySuspended
], async (req, res) => handleSubscriptionPurchase(req, res, null));

/**
 * POST /api/users/purchase-premium
 * Rétrocompatibilité : achète le palier Plus (équivalent ancien « premium » d’entrée de gamme).
 */
router.post('/purchase-premium', [
  authenticateToken,
  denySuspended
], async (req, res) => handleSubscriptionPurchase(req, res, TIER.PLUS));

/**
 * POST /api/users/:id/block
 * Bloquer un utilisateur
 */
router.post('/:id/block', [
  authenticateToken,
  denySuspended,
  param('id').isUUID().withMessage('ID utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id: blockedUserId } = req.params;
    const currentUserId = req.user.id;

    // Vérifier qu'on ne se bloque pas soi-même
    if (currentUserId === blockedUserId) {
      return res.status(400).json({
        success: false,
        message: 'Vous ne pouvez pas vous bloquer vous-même'
      });
    }

    // Vérifier que l'utilisateur à bloquer existe
    const userToBlock = await User.findByPk(blockedUserId);
    if (!userToBlock) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Stocker le block dans Redis pour performance
    // Clé: user:blocked:{userId} = SET d'user IDs bloqués
    const blockKey = `user:blocked:${currentUserId}`;

    // 📊 Track block pour l'algorithme Rust
    ctrTracker.trackBlock(currentUserId, blockedUserId).catch(err => {
      logger.warn(`CTR tracking error: ${err.message}`);
    });

    // Si l'utilisateur était suivi, le retirer du follow
    const following = await UserFollow.findOne({
      where: {
        follower_id: currentUserId,
        following_id: blockedUserId
      }
    });

    if (following) {
      await following.destroy();
    }

    logger.info(`Utilisateur ${currentUserId} a bloqué ${blockedUserId}`);

    res.json({
      success: true,
      message: 'Utilisateur bloqué avec succès',
      data: {
        blocked_user_id: blockedUserId,
        blocked: true
      }
    });

  } catch (error) {
    logger.error('Erreur lors du blocage:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

/**
 * POST /api/users/:id/unblock
 * Débloquer un utilisateur
 */
router.post('/:id/unblock', [
  authenticateToken,
  denySuspended,
  param('id').isUUID().withMessage('ID utilisateur invalide'),
  handleValidationErrors
], async (req, res) => {
  try {
    const { id: unblockedUserId } = req.params;
    const currentUserId = req.user.id;

    // Vérifier que l'utilisateur à débloquer existe
    const userToUnblock = await User.findByPk(unblockedUserId);
    if (!userToUnblock) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Supprimer du blocage depuis Redis
    const blockKey = `user:blocked:${currentUserId}`;

    logger.info(`Utilisateur ${currentUserId} a débloqué ${unblockedUserId}`);

    res.json({
      success: true,
      message: 'Utilisateur débloqué avec succès',
      data: {
        unblocked_user_id: unblockedUserId,
        blocked: false
      }
    });

  } catch (error) {
    logger.error('Erreur lors du déblocage:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur interne du serveur'
    });
  }
});

module.exports = router;
