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
    if (!adData.tweet_id || !adData.budget) {
      return res.status(400).json({
        success: false,
        message: 'Tweet ID et budget requis'
      });
    }

    // Vérifier que le tweet appartient à l'utilisateur
    const tweet = await Tweet.findByPk(adData.tweet_id);
    if (!tweet || tweet.user_id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Vous ne pouvez promouvoir que vos propres tweets'
      });
    }

    const advertisement = await adService.createAdvertisement(userId, adData);

    res.status(201).json({
      success: true,
      message: 'Publicité créée avec succès',
      data: advertisement
    });
  } catch (error) {
    logger.error('❌ Erreur lors de la création de publicité:', error);
    // Un solde insuffisant n'est pas une panne du serveur : le renvoyer en
    // 500 avec un message générique empêchait le client de dire à
    // l'utilisateur ce qui manquait — il ne voyait qu'une erreur inexpliquée.
    const insufficient = /solde insuffisant/i.test(error.message || '');
    res.status(insufficient ? 402 : 500).json({
      success: false,
      message: insufficient ? error.message : 'Erreur lors de la création de la publicité',
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

      // Heures d'activité — comptées sur les likes réels.
      sequelize.query(`
        SELECT EXTRACT(HOUR FROM l.created_at)::int::text AS value,
               COUNT(DISTINCT l.user_id)::int AS user_count
        FROM tweet_likes l
        WHERE l.created_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 2 DESC`, { type: QueryTypes.SELECT }),

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
    const userId = req.user.id;
    const { tweet_id, budget, targeting, title, max_impressions_per_user } = req.body || {};

    if (!tweet_id || !budget || Number(budget) <= 0) {
      return res.status(400).json({ success: false, message: 'Tweet et budget requis' });
    }
    const tweet = await Tweet.findByPk(tweet_id);
    if (!tweet || tweet.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Vous ne pouvez promouvoir que vos propres tweets' });
    }

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

    const campaign = await adService.createCampaign(userId, {
      name: title || `Promotion ${new Date().toLocaleDateString('fr-FR')}`,
      total_budget: budget,
      daily_budget: budget,
      targeting_criteria,
    });

    const advertisement = await adService.createAdvertisement(userId, {
      tweet_id,
      campaign_id: campaign.id,
      title: title || 'Publicité',
      budget,
      targeting_criteria,
      max_impressions_per_user: max_impressions_per_user || 3,
    });

    // Le débit a réussi (sinon `createAdvertisement` aurait levé) : la
    // publicité doit être diffusable tout de suite, pas rester en brouillon.
    await advertisement.update({ status: 'active' });

    return res.status(201).json({
      success: true,
      message: 'Publicité créée et activée',
      data: { id: advertisement.id, campaign_id: campaign.id },
    });
  } catch (error) {
    const insufficient = /solde insuffisant/i.test(error.message || '');
    if (!insufficient) logger.error('❌ Création de publicité ciblée en échec:', error);
    return res.status(insufficient ? 402 : 500).json({
      success: false,
      message: insufficient ? error.message : 'Erreur lors de la création de la publicité',
    });
  }
});

/**
 * 📈 Mes publicités ciblées, avec leurs résultats
 * GET /api/ads/targeted/me
 */
router.get('/targeted/me', authenticateToken, async (req, res) => {
  try {
    const { sequelize } = require('../database');
    const { QueryTypes } = require('sequelize');
    const rows = await sequelize.query(`
      SELECT a.id, a.title, a.status, a.budget::float8 AS budget,
             a.targeting_criteria, a.created_at, a.tweet_id,
             (SELECT COUNT(*) FROM ad_impressions i WHERE i.advertisement_id = a.id)::int AS impressions,
             (SELECT COUNT(*) FROM ad_clicks c WHERE c.advertisement_id = a.id)::int AS clicks
      FROM advertisements a
      WHERE a.user_id = :userId
      ORDER BY a.created_at DESC LIMIT 50`,
      { replacements: { userId: req.user.id }, type: QueryTypes.SELECT });

    return res.json({ success: true, data: rows });
  } catch (error) {
    logger.error('❌ Lecture des publicités impossible:', error);
    return res.status(500).json({ success: false, message: 'Publicités indisponibles' });
  }
});

module.exports = router;
