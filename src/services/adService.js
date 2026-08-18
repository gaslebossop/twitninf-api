/**
 * 🎯 Service de gestion des publicités
 * Gère les campagnes publicitaires, le ciblage et l'intégration dans l'algorithme
 */

const logger = require('../utils/logger');
const { Advertisement, AdCampaign, AdImpression, AdClick, AdEngagement, User, Tweet, UserWallet, VirtualCurrency, Transaction } = require('../models');

/**
 * Monnaie de facturation publicitaire.
 *
 * ⚠ C'était `TWC`, qui n'existe PLUS dans `virtual_currencies` (la table ne
 * contient que NF, EUR, KOSP, BEBET, GCORP, CONG, LLL). La recherche de la
 * monnaie renvoyait donc toujours `null` et toute création de publicité
 * échouait — en 500 avec un message générique, sans jamais dire pourquoi.
 * Personne ne pouvait créer de publicité, et rien ne l'indiquait.
 *
 * Les méthodes gardent leur nom historique (`debitTWC`, `getUserTWCBalance`,
 * `initializeTWC`) : le module `targeting/` appelle `adService.debitTWC` par
 * son nom, hors de ce dépôt. Seule la monnaie réellement débitée change.
 */
const AD_CURRENCY = 'NF';

class AdService {
  constructor() {
    this.initialized = true;
    this.currencyId = null; // Résolu au premier appel
    logger.info('🎯 Service de publicité initialisé');
  }

  /**
   * 💰 Résoudre l'ID de la monnaie de facturation (voir AD_CURRENCY)
   */
  async initializeTWC() {
    if (this.currencyId) return this.currencyId;
    
    try {
      const currency = await VirtualCurrency.findOne({
        where: { symbol: AD_CURRENCY }
      });
      
      if (!currency) {
        throw new Error(`Monnaie ${AD_CURRENCY} introuvable`);
      }
      
      this.currencyId = currency.id;
      logger.info(`💰 Monnaie publicitaire ${AD_CURRENCY} résolue: ${this.currencyId}`);
      return this.currencyId;
    } catch (error) {
      logger.error(`❌ Résolution de la monnaie ${AD_CURRENCY} impossible:`, error);
      throw error;
    }
  }

  /**
   * 💰 Solde publicitaire d'un utilisateur
   */
  async getUserTWCBalance(userId) {
    try {
      const currencyId = await this.initializeTWC();
      
      const wallet = await UserWallet.findOne({
        where: {
          userId: userId,
          currencyId: currencyId
        }
      });
      
      return wallet ? parseFloat(wallet.balance) : 0;
    } catch (error) {
      logger.error(`❌ Lecture du solde ${AD_CURRENCY} impossible:`, error);
      return 0;
    }
  }

  /**
   * 💰 Débiter le portefeuille de l'annonceur
   */
  async debitTWC(userId, amount, description = 'Paiement publicitaire', externalTransaction = null) {
    try {
      const { UserWallet, VirtualCurrency } = require('../models');
      const NewEconomyService = require('./newEconomyService');

      // Récupérer la cryptomonnaie
      const currency = await VirtualCurrency.findOne({ where: { symbol: AD_CURRENCY } });
      if (!currency) {
        throw new Error(`Monnaie ${AD_CURRENCY} introuvable`);
      }
      
      const currencyId = currency.id;
      
      const result = await NewEconomyService.spendCoins(
        userId,
        currencyId,
        amount,
        'ADVERTISEMENT_CREATION',
        null, // Pas de itemId spécifique
        description,
        externalTransaction
      );

      logger.info(`💰 ${amount} NF débités de l'utilisateur ${userId} pour: ${description}`);
      return result.remainingBalance;
    } catch (error) {
      logger.error(`❌ Débit ${AD_CURRENCY} en échec:`, error);
      throw error;
    }
  }

  /**
   * 📊 Créer une nouvelle campagne publicitaire
   */
  async createCampaign(userId, campaignData) {
    try {
      const campaign = await AdCampaign.create({
        user_id: userId,
        name: campaignData.name,
        description: campaignData.description,
        objective: campaignData.objective || 'awareness',
        total_budget: campaignData.total_budget,
        daily_budget: campaignData.daily_budget,
        start_date: campaignData.start_date || new Date(),
        end_date: campaignData.end_date,
        targeting_criteria: campaignData.targeting_criteria || {},
        status: 'draft'
      });

      logger.info(`📊 Campagne créée: ${campaign.id} pour l'utilisateur ${userId}`);
      return campaign;
    } catch (error) {
      logger.error('❌ Erreur lors de la création de la campagne:', error);
      throw error;
    }
  }

  /**
   * 🎯 Créer une nouvelle publicité
   */
  async createAdvertisement(userId, adData) {
    const { sequelize } = require('../database/index');
    const transaction = await sequelize.transaction();
    try {
      // 1. Vérifier le solde de l'utilisateur
      const userBalance = await this.getUserTWCBalance(userId);
      const costTWC = adData.budget || 0;
      
      if (userBalance < costTWC) {
        throw new Error(`Solde insuffisant : ${userBalance} NF disponibles, ${costTWC} NF requis`);
      }

      // 2. Débiter l'utilisateur de manière atomique
      if (costTWC > 0) {
        await this.debitTWC(userId, costTWC, `Création publicité - ${adData.title || 'Nouvelle pub'}`, transaction);
      }

      // 3. Créer la publicité
      const advertisement = await Advertisement.create({
        user_id: userId,
        tweet_id: adData.tweet_id,
        campaign_id: adData.campaign_id && adData.campaign_id.trim() !== '' ? adData.campaign_id : null,
        title: adData.title,
        description: adData.description,
        budget: adData.budget,
        cost_per_impression: adData.cost_per_impression || 0.10, // 0.10 NF par vue
        cost_per_click: adData.cost_per_click || 0.10, // 0.10 NF par clic
        cost_per_engagement: adData.cost_per_engagement || 0.05, // 0.05 NF par engagement
        start_date: adData.start_date || new Date(),
        end_date: adData.end_date,
        max_impressions_per_day: adData.max_impressions_per_day,
        max_impressions_per_user: adData.max_impressions_per_user || 1,
        targeting_criteria: adData.targeting_criteria || {},
        creative_data: adData.creative_data || {},
        status: 'draft'
      }, { transaction });

      await transaction.commit();
      logger.info(`🎯 Publicité créée: ${advertisement.id} pour l'utilisateur ${userId} (Budget: ${adData.budget} NF)`);
      return advertisement;
    } catch (error) {
      await transaction.rollback();
      logger.error('❌ Erreur lors de la création de la publicité:', error);
      throw error;
    }
  }

  /**
   * 🎲 Obtenir les publicités éligibles pour un utilisateur
   */
  async getEligibleAds(userId, limit = 5) {
    try {
      const user = await User.findByPk(userId);
      if (!user) {
        throw new Error('Utilisateur non trouvé');
      }

      // Récupérer toutes les publicités actives
      const activeAds = await Advertisement.findAll({
        where: {
          status: 'active'
        },
        include: [
          {
            model: Tweet,
            as: 'tweet',
            include: [
              {
                model: User,
                as: 'author'
              }
            ]
          },
          {
            model: AdCampaign,
            as: 'campaign'
          }
        ]
      });

      // Filtrer les publicités éligibles
      const eligibleAds = [];
      for (const ad of activeAds) {
        if (await this.isAdEligibleForUser(ad, user)) {
          eligibleAds.push(ad);
        }
      }

      // Trier par priorité (budget restant, coût par impression, etc.)
      eligibleAds.sort((a, b) => {
        // Priorité basée sur le budget restant et le coût
        const aPriority = a.budget * (1 - a.cost_per_impression);
        const bPriority = b.budget * (1 - b.cost_per_impression);
        return bPriority - aPriority;
      });

      return eligibleAds.slice(0, limit);
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des publicités éligibles:', error);
      throw error;
    }
  }

  /**
   * ✅ Vérifier si une publicité est éligible pour un utilisateur
   */
  async isAdEligibleForUser(advertisement, user) {
    try {
      // Vérifier si la publicité est active
      if (!advertisement.isActive()) {
        return false;
      }

      // Vérifier si le budget n'est pas épuisé
      if (await advertisement.isBudgetExhausted()) {
        return false;
      }

      // Vérifier les limites par utilisateur
      const userImpressions = await AdImpression.count({
        where: {
          advertisement_id: advertisement.id,
          user_id: user.id
        }
      });

      if (userImpressions >= (advertisement.max_impressions_per_user || 1)) {
        return false;
      }

      // Vérifier les critères de ciblage
      if (advertisement.targeting_criteria && Object.keys(advertisement.targeting_criteria).length > 0) {
        return await this.matchesTargetingCriteria(user, advertisement.targeting_criteria);
      }

      return true;
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification d\'éligibilité:', error);
      return false;
    }
  }

  /**
   * 🎯 Vérifier si un utilisateur correspond aux critères de ciblage
   */
  async matchesTargetingCriteria(user, criteria) {
    try {
      // Ciblage par âge du compte
      if (criteria.min_account_age_days) {
        const accountAge = Math.floor((new Date() - user.created_at) / (1000 * 60 * 60 * 24));
        if (accountAge < criteria.min_account_age_days) {
          return false;
        }
      }

      // Ciblage par nombre de followers
      if (criteria.min_followers) {
        const followersCount = user.stats?.followers || 0;
        if (followersCount < criteria.min_followers) {
          return false;
        }
      }

      // Ciblage par statut de vérification
      if (criteria.verified_only && !user.verified) {
        return false;
      }

      // Ciblage par statut premium
      if (criteria.premium_only && !user.premium) {
        return false;
      }

      // Ciblage par localisation (si disponible)
      if (criteria.location) {
        // Implémenter la logique de localisation si nécessaire
      }

      // Ciblage par intérêts (basé sur les hashtags des tweets)
      if (criteria.interests && criteria.interests.length > 0) {
        const userTweets = await Tweet.findAll({
          where: { user_id: user.id },
          limit: 50
        });

        const userHashtags = new Set();
        userTweets.forEach(tweet => {
          if (tweet.hashtags) {
            tweet.hashtags.forEach(tag => userHashtags.add(tag.toLowerCase()));
          }
        });

        const hasMatchingInterest = criteria.interests.some(interest => 
          userHashtags.has(interest.toLowerCase())
        );

        if (!hasMatchingInterest) {
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification des critères de ciblage:', error);
      return false;
    }
  }

  /**
   * 📊 Enregistrer une impression publicitaire
   */
  async recordImpression(advertisementId, userId, context = {}) {
    try {
      // Vérifier si l'impression n'a pas déjà été enregistrée pour éviter les doublons
      const existingImpression = await AdImpression.findOne({
        where: {
          advertisement_id: advertisementId,
          user_id: userId
        }
      });

      if (existingImpression) {
        logger.info(`📊 Impression déjà enregistrée pour la publicité ${advertisementId} et l'utilisateur ${userId}`);
        return;
      }

      // Récupérer la publicité pour obtenir le coût
      const advertisement = await Advertisement.findByPk(advertisementId);
      if (!advertisement) {
        throw new Error('Publicité non trouvée');
      }

      // Vérifier si le budget n'est pas épuisé
      if (await advertisement.isBudgetExhausted()) {
        logger.warn(`⚠️ Budget épuisé pour la publicité ${advertisementId}`);
        return;
      }

      // Enregistrer l'impression
      await AdImpression.create({
        advertisement_id: advertisementId,
        user_id: userId,
        context: context
      });

      // Débiter le coût de l'impression
      try {
        await this.debitTWC(
          advertisement.user_id, 
          advertisement.cost_per_impression, 
          `Impression publicitaire - ${advertisement.title}`
        );
        logger.info(`💰 ${advertisement.cost_per_impression} NF débités pour l'impression de la publicité ${advertisementId}`);
      } catch (paymentError) {
        logger.error('❌ Erreur lors du paiement de l\'impression:', paymentError);
        // Ne pas faire échouer l'impression si le paiement échoue
      }

      logger.info(`📊 Impression enregistrée pour la publicité ${advertisementId} et l'utilisateur ${userId}`);
    } catch (error) {
      logger.error('❌ Erreur lors de l\'enregistrement de l\'impression:', error);
    }
  }

  /**
   * 🖱️ Enregistrer un clic publicitaire
   */
  async recordClick(advertisementId, userId, context = {}) {
    try {
      // Vérifier si le clic n'a pas déjà été enregistré pour éviter les doublons
      const existingClick = await AdClick.findOne({
        where: {
          advertisement_id: advertisementId,
          user_id: userId
        }
      });

      if (existingClick) {
        logger.info(`🖱️ Clic déjà enregistré pour la publicité ${advertisementId} et l'utilisateur ${userId}`);
        return;
      }

      // Récupérer la publicité pour obtenir le coût
      const advertisement = await Advertisement.findByPk(advertisementId);
      if (!advertisement) {
        throw new Error('Publicité non trouvée');
      }

      // Vérifier si le budget n'est pas épuisé
      if (await advertisement.isBudgetExhausted()) {
        logger.warn(`⚠️ Budget épuisé pour la publicité ${advertisementId}`);
        return;
      }

      // Enregistrer le clic
      await AdClick.create({
        advertisement_id: advertisementId,
        user_id: userId,
        context: context
      });

      // Débiter le coût du clic
      try {
        await this.debitTWC(
          advertisement.user_id, 
          advertisement.cost_per_click, 
          `Clic publicitaire - ${advertisement.title}`
        );
        logger.info(`💰 ${advertisement.cost_per_click} NF débités pour le clic de la publicité ${advertisementId}`);
      } catch (paymentError) {
        logger.error('❌ Erreur lors du paiement du clic:', paymentError);
        // Ne pas faire échouer le clic si le paiement échoue
      }

      logger.info(`🖱️ Clic enregistré pour la publicité ${advertisementId} et l'utilisateur ${userId}`);
    } catch (error) {
      logger.error('❌ Erreur lors de l\'enregistrement du clic:', error);
    }
  }

  /**
   * ❤️ Enregistrer un engagement publicitaire
   */
  async recordEngagement(advertisementId, userId, engagementType, context = {}) {
    try {
      // Vérifier si l'engagement n'a pas déjà été enregistré pour éviter les doublons
      const existingEngagement = await AdEngagement.findOne({
        where: {
          advertisement_id: advertisementId,
          user_id: userId,
          engagement_type: engagementType
        }
      });

      if (existingEngagement) {
        logger.info(`❤️ Engagement ${engagementType} déjà enregistré pour la publicité ${advertisementId} et l'utilisateur ${userId}`);
        return;
      }

      // Récupérer la publicité pour obtenir le coût
      const advertisement = await Advertisement.findByPk(advertisementId);
      if (!advertisement) {
        throw new Error('Publicité non trouvée');
      }

      // Vérifier si le budget n'est pas épuisé
      if (await advertisement.isBudgetExhausted()) {
        logger.warn(`⚠️ Budget épuisé pour la publicité ${advertisementId}`);
        return;
      }

      // Enregistrer l'engagement
      await AdEngagement.create({
        advertisement_id: advertisementId,
        user_id: userId,
        engagement_type: engagementType,
        context: context
      });

      // Débiter le coût de l'engagement (si défini)
      if (advertisement.cost_per_engagement && advertisement.cost_per_engagement > 0) {
        try {
          await this.debitTWC(
            advertisement.user_id, 
            advertisement.cost_per_engagement, 
            `Engagement ${engagementType} publicitaire - ${advertisement.title}`
          );
          logger.info(`💰 ${advertisement.cost_per_engagement} NF débités pour l'engagement ${engagementType} de la publicité ${advertisementId}`);
        } catch (paymentError) {
          logger.error('❌ Erreur lors du paiement de l\'engagement:', paymentError);
          // Ne pas faire échouer l'engagement si le paiement échoue
        }
      }

      logger.info(`❤️ Engagement ${engagementType} enregistré pour la publicité ${advertisementId} et l'utilisateur ${userId}`);
    } catch (error) {
      logger.error('❌ Erreur lors de l\'enregistrement de l\'engagement:', error);
    }
  }

  /**
   * 📈 Obtenir les statistiques d'une campagne
   */
  async getCampaignStats(campaignId) {
    try {
      const campaign = await AdCampaign.findByPk(campaignId, {
        include: [
          {
            model: Advertisement,
            as: 'advertisements'
          }
        ]
      });

      if (!campaign) {
        throw new Error('Campagne non trouvée');
      }

      return await campaign.getCampaignStats();
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des statistiques de campagne:', error);
      throw error;
    }
  }

  /**
   * 📊 Obtenir les statistiques d'une publicité
   */
  async getAdvertisementStats(advertisementId) {
    try {
      const advertisement = await Advertisement.findByPk(advertisementId);
      if (!advertisement) {
        throw new Error('Publicité non trouvée');
      }

      return await advertisement.getAdStats();
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des statistiques de publicité:', error);
      throw error;
    }
  }

  /**
   * 🎯 Intégrer les publicités dans le feed algorithmique
   */
  async injectAdsIntoFeed(userId, tweets, adRatio = 0.1) {
    try {
      // Calculer le nombre de publicités à injecter
      const adCount = Math.floor(tweets.length * adRatio);
      
      if (adCount === 0) {
        return tweets;
      }

      // Obtenir les publicités éligibles
      const eligibleAds = await this.getEligibleAds(userId, adCount);
      
      if (eligibleAds.length === 0) {
        return tweets;
      }

      // Injecter les publicités dans le feed
      const feedWithAds = [...tweets];
      const adPositions = this.calculateAdPositions(tweets.length, adCount);

      for (let i = 0; i < eligibleAds.length && i < adPositions.length; i++) {
        const ad = eligibleAds[i];
        const position = adPositions[i];
        
        // Créer un objet tweet publicitaire
        const adTweet = {
          id: `ad_${ad.id}`,
          user_id: ad.user_id,
          content: ad.tweet.content,
          hashtags: ad.tweet.hashtags,
          mentions: ad.tweet.mentions,
          media_urls: ad.tweet.media_urls,
          language: ad.tweet.language,
          created_at: ad.tweet.created_at,
          updated_at: ad.tweet.updated_at,
          is_advertisement: true,
          advertisement_id: ad.id,
          advertisement_title: ad.title,
          advertisement_budget: ad.budget,
          author: ad.tweet.author,
          stats: {
            likes: 0,
            retweets: 0,
            replies: 0,
            views: 0
          }
        };

        // Insérer la publicité à la position calculée
        feedWithAds.splice(position, 0, adTweet);

        // Enregistrer l'impression
        await this.recordImpression(ad.id, userId, {
          position: position,
          feed_type: 'algorithmic'
        });
      }

      logger.info(`🎯 ${eligibleAds.length} publicités injectées dans le feed de l'utilisateur ${userId}`);
      return feedWithAds;
    } catch (error) {
      logger.error('❌ Erreur lors de l\'injection des publicités:', error);
      return tweets; // Retourner le feed original en cas d'erreur
    }
  }

  /**
   * 📍 Calculer les positions optimales pour les publicités
   */
  calculateAdPositions(totalTweets, adCount) {
    const positions = [];
    const interval = Math.floor(totalTweets / (adCount + 1));
    
    for (let i = 1; i <= adCount; i++) {
      const position = i * interval;
      if (position < totalTweets) {
        positions.push(position);
      }
    }
    
    return positions;
  }

  /**
   * 🚀 Activer une campagne
   */
  async activateCampaign(campaignId) {
    try {
      const campaign = await AdCampaign.findByPk(campaignId);
      if (!campaign) {
        throw new Error('Campagne non trouvée');
      }

      campaign.status = 'active';
      await campaign.save();

      // Activer toutes les publicités de la campagne
      const advertisements = await campaign.getAdvertisements();
      for (const ad of advertisements) {
        if (ad.status === 'draft' || ad.status === 'paused') {
          ad.status = 'active';
          await ad.save();
        }
      }

      logger.info(`🚀 Campagne ${campaignId} activée`);
      return campaign;
    } catch (error) {
      logger.error('❌ Erreur lors de l\'activation de la campagne:', error);
      throw error;
    }
  }

  /**
   * ⏸️ Mettre en pause une campagne
   */
  async pauseCampaign(campaignId) {
    try {
      const campaign = await AdCampaign.findByPk(campaignId);
      if (!campaign) {
        throw new Error('Campagne non trouvée');
      }

      await campaign.pause();
      logger.info(`⏸️ Campagne ${campaignId} mise en pause`);
      return campaign;
    } catch (error) {
      logger.error('❌ Erreur lors de la mise en pause de la campagne:', error);
      throw error;
    }
  }
}

module.exports = new AdService();
