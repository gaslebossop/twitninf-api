/**
 * 🎯 Routes pour la gestion des publicités
 * API pour créer, gérer et analyser les campagnes publicitaires
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authMiddleware');
const adService = require('../services/adService');
const logger = require('../utils/logger');
const { Advertisement, AdCampaign, User, Tweet } = require('../models');

/**
 * Décalage horaire de la plateforme. Doit valoir la même chose que
 * `PLATFORM_UTC_OFFSET_HOURS` côté moteur : les heures proposées ici sont
 * celles que le moteur compare à l'heure courante.
 */
const PLATFORM_UTC_OFFSET_HOURS = parseInt(process.env.PLATFORM_UTC_OFFSET_HOURS, 10) || 1;

/**
 * Résout et valide ce qu'une publicité met en avant.
 *
 * Deux règles ont sauté ici, et pour la même raison : elles ne protégeaient
 * rien.
 *
 * — « on ne peut promouvoir qu'un tweet » venait d'une colonne NOT NULL, pas
 *   d'un choix. Un compte est une cible publicitaire aussi légitime qu'un
 *   post.
 * — « et seulement le sien » interdisait de payer pour mettre en avant le
 *   contenu de quelqu'un d'autre, ce qui est le cas d'usage normal d'une
 *   régie. Ce qui compte n'est pas QUI a écrit la cible, c'est qu'elle soit
 *   déjà publiquement visible : payer ne doit jamais donner accès à ce que
 *   l'algorithme refuserait de servir gratuitement.
 *
 * Renvoie `{ target_type, tweet_id, target_user_id, label }`, ou lève une
 * erreur portant `.status` pour que l'appelant réponde le bon code.
 */
async function resolveAdTarget({ target_type, tweet_id, target_user_id, target_username }) {
  const fail = (status, message) => {
    const e = new Error(message);
    e.status = status;
    throw e;
  };

  const type = target_type === 'profile' ? 'profile' : (target_type === 'tweet' || tweet_id ? 'tweet' : null);
  if (!type) fail(400, 'Cible manquante : indiquez un tweet ou un compte à promouvoir');

  if (type === 'profile') {
    const where = target_user_id ? { id: target_user_id } : { username: target_username };
    if (!target_user_id && !target_username) fail(400, 'Compte à promouvoir manquant');
    const user = await User.findOne({ where });
    if (!user) fail(404, 'Compte à promouvoir introuvable');
    // Mêmes conditions que celles du moteur (`load_active_ads`) : inutile de
    // débiter un annonceur pour une cible que le fil n'affichera jamais.
    if (user.is_active === false || user.is_suspended) fail(403, 'Ce compte ne peut pas être promu');
    if (user.is_private_account) fail(403, 'Un compte privé ne peut pas être promu');
    return {
      target_type: 'profile',
      tweet_id: null,
      target_user_id: user.id,
      label: `@${user.username}`,
    };
  }

  if (!tweet_id) fail(400, 'Tweet à promouvoir manquant');
  const tweet = await Tweet.findByPk(tweet_id, {
    include: [{ model: User, as: 'author', attributes: ['id', 'username', 'is_active', 'is_suspended', 'is_private_account'] }],
  });
  if (!tweet || tweet.deleted_at) fail(404, 'Tweet à promouvoir introuvable');
  if (tweet.is_private) fail(403, 'Un tweet privé ne peut pas être promu');
  if (tweet.moderation_status && tweet.moderation_status !== 'approved') {
    fail(403, 'Ce tweet n’est pas diffusable');
  }
  const author = tweet.author;
  if (author && (author.is_active === false || author.is_suspended || author.is_private_account)) {
    fail(403, 'Ce tweet ne peut pas être promu');
  }
  return {
    target_type: 'tweet',
    tweet_id: tweet.id,
    target_user_id: null,
    label: (tweet.content || '').slice(0, 60) || `Tweet de @${author?.username || ''}`,
  };
}

/**
 * 📊 Créer une nouvelle campagne publicitaire
 * POST /api/ads/campaigns
 */
router.post('/campaigns', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const campaignData = req.body;

    // Validation des données
    if (!campaignData.name || !campaignData.total_budget) {
      return res.status(400).json({
        success: false,
        message: 'Nom et budget total requis'
      });
    }

    const campaign = await adService.createCampaign(userId, campaignData);

    res.status(201).json({
      success: true,
      message: 'Campagne créée avec succès',
      data: campaign
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la création de campagne:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création de la campagne',
      error: error.message
    });
  }
});

/**
 * 🎯 Créer une nouvelle publicité
 * POST /api/ads/advertisements
 */
router.post('/advertisements', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const adData = req.body;

    // Validation des données
    if (!adData.budget) {
      return res.status(400).json({
        success: false,
        message: 'Budget requis'
      });
    }

    // Tweet OU compte, à soi ou non — voir `resolveAdTarget`.
    const target = await resolveAdTarget(adData);

    const advertisement = await adService.createAdvertisement(userId, { ...adData, ...target });

    res.status(201).json({
      success: true,
      message: 'Publicité créée avec succès',
      data: advertisement
    });
  } catch (error) {
    // Un solde insuffisant, une cible refusée ou un portefeuille en revue
    // anti-fraude ne sont pas des pannes du serveur : les renvoyer en 500
    // avec un message générique empêchait le client de dire à l'utilisateur
    // ce qui bloquait — il ne voyait qu'une erreur inexpliquée, et retentait
    // en boucle, ce qui côté anti-fraude aggrave justement la revue en cours.
    const insufficient = /solde insuffisant/i.test(error.message || '');
    const status = error.status || error.httpStatus || (insufficient ? 402 : 500);
    if (status >= 500) logger.error('❌ Erreur lors de la création de publicité:', error);
    res.status(status).json({
      success: false,
      message: status === 500 ? 'Erreur lors de la création de la publicité' : error.message,
      error: error.message
    });
  }
});

/**
 * 📋 Obtenir les campagnes de l'utilisateur
 * GET /api/ads/campaigns
 */
router.get('/campaigns', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, page = 1, limit = 10 } = req.query;

    const whereClause = { user_id: userId };
    if (status) {
      whereClause.status = status;
    }

    const campaigns = await AdCampaign.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: Advertisement,
          as: 'advertisements',
          include: [
            {
              model: Tweet,
              as: 'tweet'
            }
          ]
        }
      ],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    });

    // Ajouter les statistiques à chaque campagne
    const campaignsWithStats = await Promise.all(
      campaigns.rows.map(async (campaign) => {
        const stats = await adService.getCampaignStats(campaign.id);
        return {
          ...campaign.toJSON(),
          stats
        };
      })
    );

    res.json({
      success: true,
      data: campaignsWithStats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: campaigns.count,
        pages: Math.ceil(campaigns.count / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des campagnes:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des campagnes',
      error: error.message
    });
  }
});

/**
 * 📋 Obtenir les publicités de l'utilisateur
 * GET /api/ads/advertisements
 */
router.get('/advertisements', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, page = 1, limit = 10 } = req.query;

    const whereClause = { user_id: userId };
    if (status) {
      whereClause.status = status;
    }

    const advertisements = await Advertisement.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: Tweet,
          as: 'tweet'
        },
        {
          model: AdCampaign,
          as: 'campaign'
        }
      ],
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    });

    // Ajouter les statistiques à chaque publicité
    const adsWithStats = await Promise.all(
      advertisements.rows.map(async (ad) => {
        const stats = await adService.getAdvertisementStats(ad.id);
        return {
          ...ad.toJSON(),
          stats
        };
      })
    );

    res.json({
      success: true,
      data: adsWithStats,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: advertisements.count,
        pages: Math.ceil(advertisements.count / parseInt(limit))
      }
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des publicités:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des publicités',
      error: error.message
    });
  }
});

/**
 * 📊 Obtenir les statistiques d'une campagne
 * GET /api/ads/campaigns/:id/stats
 */
router.get('/campaigns/:id/stats', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const userId = req.user.id;

    // Vérifier que la campagne appartient à l'utilisateur
    const campaign = await AdCampaign.findOne({
      where: { id: campaignId, user_id: userId }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campagne non trouvée'
      });
    }

    const stats = await adService.getCampaignStats(campaignId);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des statistiques de campagne:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques',
      error: error.message
    });
  }
});

/**
 * 📊 Obtenir les statistiques d'une publicité
 * GET /api/ads/advertisements/:id/stats
 */
router.get('/advertisements/:id/stats', authenticateToken, async (req, res) => {
  try {
    const advertisementId = req.params.id;
    const userId = req.user.id;

    // Vérifier que la publicité appartient à l'utilisateur
    const advertisement = await Advertisement.findOne({
      where: { id: advertisementId, user_id: userId }
    });

    if (!advertisement) {
      return res.status(404).json({
        success: false,
        message: 'Publicité non trouvée'
      });
    }

    const stats = await adService.getAdvertisementStats(advertisementId);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des statistiques de publicité:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques',
      error: error.message
    });
  }
});

/**
 * 🚀 Activer une campagne
 * PUT /api/ads/campaigns/:id/activate
 */
router.put('/campaigns/:id/activate', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const userId = req.user.id;

    // Vérifier que la campagne appartient à l'utilisateur
    const campaign = await AdCampaign.findOne({
      where: { id: campaignId, user_id: userId }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campagne non trouvée'
      });
    }

    const activatedCampaign = await adService.activateCampaign(campaignId);

    res.json({
      success: true,
      message: 'Campagne activée avec succès',
      data: activatedCampaign
    });
  } catch (error) {
    logger.error('❌ Erreur lors de l\'activation de la campagne:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'activation de la campagne',
      error: error.message
    });
  }
});

/**
 * ⏸️ Mettre en pause une campagne
 * PUT /api/ads/campaigns/:id/pause
 */
router.put('/campaigns/:id/pause', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const userId = req.user.id;

    // Vérifier que la campagne appartient à l'utilisateur
    const campaign = await AdCampaign.findOne({
      where: { id: campaignId, user_id: userId }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campagne non trouvée'
      });
    }

    const pausedCampaign = await adService.pauseCampaign(campaignId);

    res.json({
      success: true,
      message: 'Campagne mise en pause avec succès',
      data: pausedCampaign
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la mise en pause de la campagne:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise en pause de la campagne',
      error: error.message
    });
  }
});

/**
 * 🖱️ Enregistrer un clic sur une publicité
 * POST /api/ads/advertisements/:id/click
 */
router.post('/advertisements/:id/click', authenticateToken, async (req, res) => {
  try {
    const advertisementId = req.params.id;
    const userId = req.user.id;
    const context = req.body.context || {};

    await adService.recordClick(advertisementId, userId, context);

    res.json({
      success: true,
      message: 'Clic enregistré avec succès'
    });
  } catch (error) {
    logger.error('❌ Erreur lors de l\'enregistrement du clic:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'enregistrement du clic',
      error: error.message
    });
  }
});

/**
 * ❤️ Enregistrer un engagement sur une publicité
 * POST /api/ads/advertisements/:id/engagement
 */
router.post('/advertisements/:id/engagement', authenticateToken, async (req, res) => {
  try {
    const advertisementId = req.params.id;
    const userId = req.user.id;
    const { engagement_type, context = {} } = req.body;

    if (!engagement_type) {
      return res.status(400).json({
        success: false,
        message: 'Type d\'engagement requis'
      });
    }

    await adService.recordEngagement(advertisementId, userId, engagement_type, context);

    res.json({
      success: true,
      message: 'Engagement enregistré avec succès'
    });
  } catch (error) {
    logger.error('❌ Erreur lors de l\'enregistrement de l\'engagement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'enregistrement de l\'engagement',
      error: error.message
    });
  }
});

/**
 * 🎯 Obtenir les publicités éligibles pour un utilisateur (pour l'algorithme)
 * GET /api/ads/eligible
 */
router.get('/eligible', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 5 } = req.query;

    const eligibleAds = await adService.getEligibleAds(userId, parseInt(limit));

    res.json({
      success: true,
      data: eligibleAds
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des publicités éligibles:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des publicités éligibles',
      error: error.message
    });
  }
});

/**
 * 💰 Obtenir le solde TWC de l'utilisateur
 * GET /api/ads/balance
 */
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const balance = await adService.getUserTWCBalance(userId);

    res.json({
      success: true,
      data: {
        balance: balance,
        currency: 'TWC',
        prices: {
          impression: 0.10,
          click: 0.10,
          engagement: 0.05
        }
      }
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération du solde TWC:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération du solde TWC',
      error: error.message
    });
  }
});

/**
 * 🗑️ Supprimer une campagne
 * DELETE /api/ads/campaigns/:id
 */
router.delete('/campaigns/:id', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const userId = req.user.id;

    // Vérifier que la campagne appartient à l'utilisateur
    const campaign = await AdCampaign.findOne({
      where: { id: campaignId, user_id: userId }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campagne non trouvée'
      });
    }

    // Mettre en pause toutes les publicités actives
    const advertisements = await campaign.getAdvertisements();
    for (const ad of advertisements) {
      if (ad.status === 'active') {
        ad.status = 'cancelled';
        await ad.save();
      }
    }

    // Supprimer la campagne
    await campaign.destroy();

    res.json({
      success: true,
      message: 'Campagne supprimée avec succès'
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la suppression de la campagne:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression de la campagne',
      error: error.message
    });
  }
});

/**
 * 🗑️ Supprimer une publicité
 * DELETE /api/ads/advertisements/:id
 */
router.delete('/advertisements/:id', authenticateToken, async (req, res) => {
  try {
    const advertisementId = req.params.id;
    const userId = req.user.id;

    // Vérifier que la publicité appartient à l'utilisateur
    const advertisement = await Advertisement.findOne({
      where: { id: advertisementId, user_id: userId }
    });

    if (!advertisement) {
      return res.status(404).json({
        success: false,
        message: 'Publicité non trouvée'
      });
    }

    // Mettre en pause si active
    if (advertisement.status === 'active') {
      advertisement.status = 'cancelled';
      await advertisement.save();
    } else {
      // Supprimer si pas encore active
      await advertisement.destroy();
    }

    res.json({
      success: true,
      message: 'Publicité supprimée avec succès'
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la suppression de la publicité:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la suppression de la publicité',
      error: error.message
    });
  }
});

/**
 * 💰 Ajouter des fonds TWC à une campagne
 * POST /api/ads/campaigns/:id/fund
 */
router.post('/campaigns/:id/fund', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const userId = req.user.id;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Montant invalide'
      });
    }

    // Vérifier que la campagne appartient à l'utilisateur
    const campaign = await AdCampaign.findOne({
      where: { id: campaignId, user_id: userId }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campagne non trouvée'
      });
    }

    // Vérifier le solde TWC
    const balance = await adService.getUserTWCBalance(userId);
    if (balance < amount) {
      return res.status(400).json({
        success: false,
        message: `Solde TWC insuffisant. Solde: ${balance} TWC, Montant requis: ${amount} TWC`
      });
    }

    // Débiter les TWC
    await adService.debitTWC(userId, amount, `Financement campagne - ${campaign.name}`);

    // Ajouter au budget de la campagne
    campaign.total_budget = parseFloat(campaign.total_budget) + amount;
    await campaign.save();

    res.json({
      success: true,
      message: `${amount} TWC ajoutés à la campagne`,
      data: {
        new_budget: campaign.total_budget,
        remaining_balance: balance - amount
      }
    });
  } catch (error) {
    logger.error('❌ Erreur lors du financement de la campagne:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du financement de la campagne',
      error: error.message
    });
  }
});

/**
 * 💰 Ajouter des fonds TWC à une publicité
 * POST /api/ads/advertisements/:id/fund
 */
router.post('/advertisements/:id/fund', authenticateToken, async (req, res) => {
  try {
    const advertisementId = req.params.id;
    const userId = req.user.id;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Montant invalide'
      });
    }

    // Vérifier que la publicité appartient à l'utilisateur
    const advertisement = await Advertisement.findOne({
      where: { id: advertisementId, user_id: userId }
    });

    if (!advertisement) {
      return res.status(404).json({
        success: false,
        message: 'Publicité non trouvée'
      });
    }

    // Vérifier le solde TWC
    const balance = await adService.getUserTWCBalance(userId);
    if (balance < amount) {
      return res.status(400).json({
        success: false,
        message: `Solde TWC insuffisant. Solde: ${balance} TWC, Montant requis: ${amount} TWC`
      });
    }

    // Débiter les TWC
    await adService.debitTWC(userId, amount, `Financement publicité - ${advertisement.title}`);

    // Ajouter au budget de la publicité
    advertisement.budget = parseFloat(advertisement.budget) + amount;
    await advertisement.save();

    res.json({
      success: true,
      message: `${amount} TWC ajoutés à la publicité`,
      data: {
        new_budget: advertisement.budget,
        remaining_balance: balance - amount
      }
    });
  } catch (error) {
    logger.error('❌ Erreur lors du financement de la publicité:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du financement de la publicité',
      error: error.message
    });
  }
});

/**
 * 📊 Obtenir les statistiques globales des publicités de l'utilisateur
 * GET /api/ads/stats
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Statistiques des campagnes
    const campaigns = await AdCampaign.findAll({
      where: { user_id: userId },
      include: [{ model: Advertisement, as: 'advertisements' }]
    });

    let totalImpressions = 0;
    let totalClicks = 0;
    let totalEngagements = 0;
    let totalSpent = 0;

    for (const campaign of campaigns) {
      const stats = await adService.getCampaignStats(campaign.id);
      totalImpressions += stats.total_impressions;
      totalClicks += stats.total_clicks;
      totalEngagements += stats.total_engagements;
      totalSpent += parseFloat(stats.total_spent);
    }

    // Solde TWC actuel
    const currentBalance = await adService.getUserTWCBalance(userId);

    res.json({
      success: true,
      data: {
        campaigns: {
          total: campaigns.length,
          active: campaigns.filter(c => c.status === 'active').length,
          paused: campaigns.filter(c => c.status === 'paused').length
        },
        performance: {
          total_impressions: totalImpressions,
          total_clicks: totalClicks,
          total_engagements: totalEngagements,
          total_spent: totalSpent,
          ctr: totalImpressions > 0 ? (totalClicks / totalImpressions * 100).toFixed(2) : 0,
          engagement_rate: totalImpressions > 0 ? (totalEngagements / totalImpressions * 100).toFixed(2) : 0
        },
        balance: {
          current: currentBalance,
          currency: 'TWC'
        }
      }
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la récupération des statistiques:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des statistiques',
      error: error.message
    });
  }
});

/**
 * 📝 Mettre à jour une campagne
 * PUT /api/ads/campaigns/:id
 */
router.put('/campaigns/:id', authenticateToken, async (req, res) => {
  try {
    const campaignId = req.params.id;
    const userId = req.user.id;
    const updateData = req.body;

    // Vérifier que la campagne appartient à l'utilisateur
    const campaign = await AdCampaign.findOne({
      where: { id: campaignId, user_id: userId }
    });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campagne non trouvée'
      });
    }

    // Mettre à jour la campagne
    await campaign.update(updateData);

    res.json({
      success: true,
      message: 'Campagne mise à jour avec succès',
      data: campaign
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la mise à jour de la campagne:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour de la campagne',
      error: error.message
    });
  }
});

/**
 * 📝 Mettre à jour une publicité
 * PUT /api/ads/advertisements/:id
 */
router.put('/advertisements/:id', authenticateToken, async (req, res) => {
  try {
    const advertisementId = req.params.id;
    const userId = req.user.id;
    const updateData = req.body;

    // Vérifier que la publicité appartient à l'utilisateur
    const advertisement = await Advertisement.findOne({
      where: { id: advertisementId, user_id: userId }
    });

    if (!advertisement) {
      return res.status(404).json({
        success: false,
        message: 'Publicité non trouvée'
      });
    }

    // Mettre à jour la publicité
    await advertisement.update(updateData);

    res.json({
      success: true,
      message: 'Publicité mise à jour avec succès',
      data: advertisement
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la mise à jour de la publicité:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la mise à jour de la publicité',
      error: error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CIBLAGE PAR LES CRITÈRES DE L'ALGORITHME
//
//  Remplace `/api/targeting/*` (module SQLite séparé, réduit à un stub sur le
//  VPS : la route renvoyait 404, d'où le « route non trouvée » à la création
//  d'une publicité ciblée). Le ciblage s'appuie désormais sur les signaux que
//  le moteur calcule déjà — voir `rust-recommender/src/ads/serving.rs`.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 🎯 Audiences disponibles, avec leur portée réelle
 * GET /api/ads/targeting/options
 *
 * Les effectifs sont comptés en base, pas estimés : un annonceur qui choisit
 * une audience doit savoir combien de comptes elle représente vraiment.
 */
router.get('/targeting/options', authenticateToken, async (req, res) => {
  try {
    const { sequelize } = require('../database');
    const { QueryTypes } = require('sequelize');

    const [types, hours, accounts] = await Promise.all([
      // Type de lecteur — même découpage que `UserProfile::user_type` côté
      // moteur : c'est le volume d'interactions sur 30 jours qui classe.
      sequelize.query(`
        WITH activite AS (
          SELECT u.id,
                 (SELECT COUNT(*) FROM tweet_likes l
                   WHERE l.user_id = u.id AND l.created_at > NOW() - INTERVAL '30 days') AS n
          FROM users u
          WHERE u.is_active = true AND COALESCE(u.is_suspended, false) = false
        )
        SELECT CASE WHEN n >= 50 THEN 'power' WHEN n >= 10 THEN 'regular' ELSE 'casual' END AS value,
               COUNT(*)::int AS user_count
        FROM activite GROUP BY 1`, { type: QueryTypes.SELECT }),

      // Heures d'activité — comptées sur les likes réels, dans le fuseau de
      // la plateforme et NON en UTC. Le serveur tourne en Etc/UTC : sans ce
      // décalage, les effectifs annoncés désignaient des heures décalées de
      // celles réellement ciblées par le moteur (voir `platform_hour_offset`
      // dans `rust-recommender/src/ads/serving.rs` — les deux doivent rester
      // d'accord).
      sequelize.query(`
        SELECT EXTRACT(HOUR FROM l.created_at + make_interval(hours => :offset))::int::text AS value,
               COUNT(DISTINCT l.user_id)::int AS user_count
        FROM tweet_likes l
        WHERE l.created_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 2 DESC`,
        { replacements: { offset: PLATFORM_UTC_OFFSET_HOURS }, type: QueryTypes.SELECT }),

      // Cibler les abonnés d'un compte : la portée est son nombre d'abonnés.
      sequelize.query(`
        SELECT u.id AS value, u.username AS label, COUNT(f.follower_id)::int AS user_count
        FROM users u
        JOIN user_follows f ON f.following_id = u.id AND f.status = 'active'
        WHERE u.is_active = true AND COALESCE(u.is_suspended, false) = false
        GROUP BY u.id, u.username
        HAVING COUNT(f.follower_id) > 0
        ORDER BY 3 DESC LIMIT 25`, { type: QueryTypes.SELECT }),
    ]);

    const TYPE_LABELS = { power: 'Lecteurs très actifs', regular: 'Lecteurs réguliers', casual: 'Lecteurs occasionnels' };

    return res.json({
      success: true,
      data: [
        {
          category: 'user_types',
          label: 'Niveau d’activité',
          description: 'Selon le volume d’interactions des 30 derniers jours.',
          values: types.map(t => ({ value: t.value, label: TYPE_LABELS[t.value] || t.value, user_count: t.user_count })),
        },
        {
          category: 'hours',
          label: 'Heure de la journée',
          description: 'La publicité n’est servie qu’à ces heures-là.',
          values: hours.map(h => ({ value: h.value, label: `${String(h.value).padStart(2, '0')}h`, user_count: h.user_count })),
        },
        {
          category: 'follows_any_of',
          label: 'Abonnés d’un compte',
          description: 'Cible les comptes qui suivent au moins un de ces profils.',
          values: accounts.map(a => ({ value: a.value, label: `@${a.label}`, user_count: a.user_count })),
        },
      ],
    });
  } catch (error) {
    logger.error('❌ Options de ciblage indisponibles:', error);
    return res.status(500).json({ success: false, message: 'Options de ciblage indisponibles' });
  }
});

/**
 * 🎯 Créer une publicité ciblée en une seule étape
 * POST /api/ads/targeted
 *
 * L'écran mobile ne connaît pas la distinction campagne/publicité : il envoie
 * un tweet, un budget et des critères. On crée les deux et on active, plutôt
 * que d'imposer un vocabulaire de régie à quelqu'un qui veut juste promouvoir
 * un post.
 */
router.post('/targeted', authenticateToken, async (req, res) => {
  try {
    const { sequelize } = require('../database');
    const userId = req.user.id;
    const { budget, targeting, title, max_impressions_per_user } = req.body || {};

    if (!budget || Number(budget) <= 0) {
      return res.status(400).json({ success: false, message: 'Budget requis' });
    }
    // Tweet ou compte, le sien ou celui d'un autre : la seule condition est
    // que la cible soit déjà publiquement visible (voir `resolveAdTarget`).
    const target = await resolveAdTarget(req.body || {});

    // On ne retient que les critères réellement évalués par le moteur : en
    // accepter d'autres ferait payer un ciblage sans effet.
    const t = targeting || {};
    const targeting_criteria = {
      user_types: Array.isArray(t.user_types) ? t.user_types : [],
      hours: Array.isArray(t.hours) ? t.hours.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 23) : [],
      follows_any_of: Array.isArray(t.follows_any_of) ? t.follows_any_of : [],
      keywords: Array.isArray(t.keywords) ? t.keywords : [],
      daily_cap: Number.isInteger(t.daily_cap) ? t.daily_cap : undefined,
    };

    // Campagne, publicité, débit et activation dans UNE seule transaction :
    // si le débit refuse (solde, revue anti-fraude…), tout se défait, y
    // compris la campagne. Sans ça, chaque tentative ratée laissait une
    // campagne vide en base — c'est exactement ce qui s'est produit pendant
    // les essais du 2026-08-18 : 16 campagnes « draft » sans aucune publicité.
    const dbTransaction = await sequelize.transaction();
    let campaign, advertisement;
    try {
      campaign = await adService.createCampaign(userId, {
        name: title || `Promotion ${new Date().toLocaleDateString('fr-FR')}`,
        total_budget: budget,
        daily_budget: budget,
        targeting_criteria,
      }, { transaction: dbTransaction });

      advertisement = await adService.createAdvertisement(userId, {
        ...target,
        campaign_id: campaign.id,
        title: title || target.label || 'Publicité',
        budget,
        targeting_criteria,
        max_impressions_per_user: max_impressions_per_user || 3,
      }, { transaction: dbTransaction });

      // Le débit a réussi (sinon `createAdvertisement` aurait levé) : la
      // publicité et sa campagne doivent être diffusables tout de suite, pas
      // rester en brouillon.
      await advertisement.update({ status: 'active' }, { transaction: dbTransaction });
      await campaign.update({ status: 'active' }, { transaction: dbTransaction });

      await dbTransaction.commit();
    } catch (error) {
      await dbTransaction.rollback();
      throw error;
    }

    return res.status(201).json({
      success: true,
      message: 'Publicité créée et activée',
      data: { id: advertisement.id, campaign_id: campaign.id, target_type: target.target_type },
    });
  } catch (error) {
    const insufficient = /solde insuffisant/i.test(error.message || '');
    const status = error.status || error.httpStatus || (insufficient ? 402 : 500);
    if (status >= 500) logger.error('❌ Création de publicité ciblée en échec:', error);
    return res.status(status).json({
      success: false,
      message: status === 500 ? 'Erreur lors de la création de la publicité' : error.message,
    });
  }
});

/**
 * 📈 Mes publicités ciblées, avec leurs résultats
 * GET /api/ads/targeted/me
 *
 * Cette route renvoyait `impressions`/`clicks` pendant que l'écran lisait
 * `current_views`/`max_views`/`text_content` — des noms hérités de l'ancien
 * module de ciblage SQLite, disparu depuis. D'où les « undefined » partout
 * dans « Mes campagnes » : rien n'était cassé côté calcul, les deux moitiés
 * ne parlaient simplement plus de la même chose.
 *
 * Les compteurs portent maintenant le vocabulaire de l'écran (des VUES, pas
 * des « impressions »), et l'objectif de vues est reconstitué depuis le
 * budget : c'est exactement ce que l'annonceur a acheté (budget ÷ prix de la
 * vue), donc la barre de progression a de nouveau un dénominateur.
 */
router.get('/targeted/me', authenticateToken, async (req, res) => {
  try {
    const { sequelize } = require('../database');
    const { QueryTypes } = require('sequelize');
    const rows = await sequelize.query(`
      SELECT a.id, a.title, a.status, a.created_at,
             a.budget::float8            AS budget,
             a.cost_per_impression::float8 AS cost_per_impression,
             a.target_type, a.tweet_id, a.target_user_id,
             a.targeting_criteria,
             t.content       AS tweet_content,
             tu.username     AS tweet_author_username,
             pu.username     AS promoted_username,
             pu.avatar       AS promoted_avatar,
             (SELECT COUNT(*) FROM ad_impressions i WHERE i.advertisement_id = a.id)::int AS impressions,
             (SELECT COUNT(*) FROM ad_clicks c      WHERE c.advertisement_id = a.id)::int AS clicks
      FROM advertisements a
      LEFT JOIN tweets t  ON t.id  = a.tweet_id
      LEFT JOIN users  tu ON tu.id = t.user_id
      LEFT JOIN users  pu ON pu.id = a.target_user_id
      WHERE a.user_id = :userId
      ORDER BY a.created_at DESC LIMIT 50`,
      { replacements: { userId: req.user.id }, type: QueryTypes.SELECT });

    const data = rows.map((r) => {
      const cpi = Number(r.cost_per_impression) || 0.10;
      const views = Number(r.impressions) || 0;
      const clicks = Number(r.clicks) || 0;
      // Objectif de vues = ce qui a été acheté. Sans prix unitaire lisible on
      // ne devine pas : mieux vaut 0 qu'un dénominateur inventé.
      const maxViews = cpi > 0 ? Math.round(Number(r.budget) / cpi) : 0;
      const isProfile = r.target_type === 'profile';
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        created_at: r.created_at,
        target_type: r.target_type || 'tweet',
        target_id: isProfile ? r.target_user_id : r.tweet_id,
        // Ce que l'annonceur reconnaît dans la liste : le compte promu, ou le
        // début du tweet promu.
        target_label: isProfile
          ? `@${r.promoted_username || ''}`
          : (r.tweet_content || '').slice(0, 90),
        target_avatar: isProfile ? r.promoted_avatar : null,
        target_author: isProfile ? r.promoted_username : r.tweet_author_username,
        budget: Number(r.budget) || 0,
        cost_per_view: cpi,
        current_views: views,
        max_views: maxViews,
        clicks,
        spent: Number((views * cpi).toFixed(2)),
        ctr: views > 0 ? Number(((clicks / views) * 100).toFixed(1)) : 0,
        targeting_criteria: r.targeting_criteria || {},
      };
    });

    return res.json({ success: true, data });
  } catch (error) {
    logger.error('❌ Lecture des publicités impossible:', error);
    return res.status(500).json({ success: false, message: 'Publicités indisponibles' });
  }
});

module.exports = router;
