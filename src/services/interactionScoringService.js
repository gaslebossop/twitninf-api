/**
 * 🎯 Service de Scoring des Interactions - TwitNin Legacy
 * 
 * Service avancé de calcul des scores d'interaction avec pondération
 * intelligente et analyse comportementale.
 * 
 * @author TwitNin Team
 * @version 1.0.0 - Advanced Interaction Scoring
 * @license MIT
 */

const { Op, fn, col, literal, Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const { User, Tweet, TweetLike, TweetRetweet, UserBehaviorData, UserFollow } = require('../models');

class InteractionScoringService {
  constructor() {
    // Configuration des scores de base
    this.baseScores = {
      // Interactions positives (augmentent la viralité)
      positive: {
        'tweet_like': 1.0,
        'tweet_comment': 3.0,
        'tweet_retweet': 5.0,
        'tweet_share': 4.0,
        'profile_view': 2.0,
        'tweet_view': 0.5,
        'tweet_bookmark': 2.5,
        'link_click': 1.0,
        'media_view': 1.5,
        'hashtag_click': 1.0,
        'mention_click': 1.2,
        'fullscreen': 1.0,
        'content_replay': 2.0
      },
      
      // Interactions négatives (diminuent la viralité)
      negative: {
        'tweet_unlike': -1.0,
        'tweet_unretweet': -2.0,
        'tweet_report': -10.0,
        'user_block': -15.0,
        'user_mute': -5.0,
        'content_skip': -0.5,
        'scroll_fast': -0.3
      },
      
      // Interactions temporelles (bonus selon la durée)
      temporal: {
        'view_duration': 0.1, // par seconde
        'scroll_pause': 0.3,
        'time_spent': 0.05, // par seconde
        'session_duration': 0.02 // par seconde
      }
    };
    
    // Multiplicateurs de qualité professionnels
    this.qualityMultipliers = {
      // Qualité de l'utilisateur qui interagit
      verified_user_like: 2.0,        // Utilisateur vérifié qui like
      premium_user_like: 1.8,         // Utilisateur premium qui like
      verified_user_comment: 3.0,     // Utilisateur vérifié qui commente
      premium_user_comment: 2.5,      // Utilisateur premium qui commente
      verified_user_retweet: 4.0,     // Utilisateur vérifié qui retweet
      premium_user_retweet: 3.5,      // Utilisateur premium qui retweet
      
      // Qualité de l'auteur du tweet
      verified_author: 1.8,           // Auteur vérifié
      premium_author: 1.6,            // Auteur premium
      verified_author_high_activity: 2.2, // Auteur vérifié très actif
      premium_author_high_activity: 2.0,  // Auteur premium très actif
      
      // Influence et réputation
      high_follower_count: 1.4,       // Beaucoup de followers
      very_high_follower_count: 1.8,  // Très beaucoup de followers
      influencer_user: 2.5,           // Utilisateur influenceur
      celebrity_user: 3.0,            // Utilisateur célèbre
      
      // Activité et engagement
      very_active_user: 1.5,          // Utilisateur très actif
      consistent_poster: 1.3,         // Utilisateur qui poste régulièrement
      high_engagement_user: 1.4,      // Utilisateur avec haut engagement
      
      // Qualité du contenu
      with_media: 1.3,                // Avec médias
      with_video: 1.5,                // Avec vidéo
      with_images: 1.2,               // Avec images
      with_hashtags: 1.15,            // Avec hashtags
      with_mentions: 1.1,             // Avec mentions
      long_content: 1.2,              // Contenu long
      very_long_content: 1.4,         // Contenu très long
      
      // Timing et contexte
      peak_hours: 1.3,                // Heures de pointe
      very_peak_hours: 1.5,           // Très heures de pointe
      recent_content: 1.4,            // Contenu récent
      very_recent_content: 1.6,       // Contenu très récent
      trending_topic: 1.6,            // Sujet tendance
      viral_topic: 2.0,               // Sujet viral
      
      // Engagement et performance
      high_engagement_rate: 1.8,      // Taux d'engagement élevé
      very_high_engagement_rate: 2.5, // Taux d'engagement très élevé
      viral_potential: 2.5,           // Potentiel viral
      explosive_growth: 3.0,          // Croissance explosive
      
      // Interactions spéciales
      first_interaction: 1.2,         // Première interaction
      quick_interaction: 1.3,         // Interaction rapide après publication
      sustained_engagement: 1.4,      // Engagement soutenu
      cross_platform_share: 1.5,      // Partage cross-platform
      
      // Facteurs sociaux
      mutual_follow: 1.3,             // Suivi mutuel
      close_connection: 1.5,          // Connexion proche
      community_member: 1.2,          // Membre de la communauté
      brand_affiliate: 1.4,           // Affilié à une marque
      
      // Facteurs temporels
      weekend_engagement: 1.1,        // Engagement weekend
      holiday_engagement: 1.3,        // Engagement jour férié
      event_engagement: 1.6,          // Engagement pendant un événement
      
      // Facteurs de qualité
      original_content: 1.3,          // Contenu original
      educational_content: 1.4,       // Contenu éducatif
      entertaining_content: 1.2,      // Contenu divertissant
      news_content: 1.5,              // Contenu d'actualité
      personal_content: 1.1,          // Contenu personnel
      
      // Facteurs de diversité
      diverse_audience: 1.2,          // Audience diverse
      international_reach: 1.3,       // Portée internationale
      cross_demographic: 1.4          // Cross-démographique
    };
    
    // Seuils de qualité professionnels (adaptés pour 40 utilisateurs)
    this.qualityThresholds = {
      // Seuils de followers
      high_follower_count: 10,        // 10 followers
      very_high_follower_count: 20,   // 20 followers
      influencer_follower_count: 30,  // 30 followers (influenceur local)
      celebrity_follower_count: 35,   // 35 followers (célébrité locale)
      
      // Seuils d'activité
      active_user_posts_per_day: 1,   // 1 post par jour
      very_active_user_posts_per_day: 3, // 3 posts par jour
      consistent_poster_days: 7,      // 7 jours consécutifs
      
      // Seuils temporels
      recent_content_hours: 6,        // 6 heures
      very_recent_content_hours: 2,   // 2 heures
      peak_hours_start: 9,            // 9h
      peak_hours_end: 21,             // 21h
      very_peak_hours_start: 12,      // 12h
      very_peak_hours_end: 18,        // 18h
      
      // Seuils d'engagement
      high_engagement_rate: 0.25,     // 25%
      very_high_engagement_rate: 0.40, // 40%
      viral_potential_score: 5,       // 5 points
      explosive_growth_rate: 0.60,    // 60%
      
      // Seuils de contenu
      long_content_length: 200,       // 200 caractères
      very_long_content_length: 500,  // 500 caractères
      media_content_bonus: 1,         // 1 média minimum
      video_content_bonus: 1,         // 1 vidéo minimum
      
      // Seuils de timing
      quick_interaction_minutes: 5,   // 5 minutes
      sustained_engagement_hours: 2,  // 2 heures
      first_interaction_hours: 1,     // 1 heure
      
      // Seuils de qualité
      educational_keywords: ['tutorial', 'guide', 'apprendre', 'formation', 'conseil'],
      news_keywords: ['actualité', 'news', 'breaking', 'urgent', 'important'],
      trending_hashtags: 3,           // 3 hashtags tendance
      viral_keywords: ['viral', 'buzz', 'tendance', 'populaire']
    };
  }

  /**
   * Calcule le score d'une interaction avec tous les facteurs
   */
  async calculateInteractionScore(tweetId, userId, interactionType, metadata = {}) {
    try {
      // Score de base
      let baseScore = this.getBaseScore(interactionType);
      
      // Récupérer les données contextuelles
      const context = await this.getInteractionContext(tweetId, userId, metadata);
      
      // Appliquer les multiplicateurs de qualité
      const qualityMultiplier = await this.calculateQualityMultiplier(context);
      
      // Calculer le bonus temporel
      const temporalBonus = this.calculateTemporalBonus(interactionType, metadata);
      
      // Calculer le bonus d'engagement
      const engagementBonus = await this.calculateEngagementBonus(tweetId, context);
      
      // Calculer le bonus de similarité
      const similarityBonus = await this.calculateSimilarityBonus(tweetId, userId, context);
      
      // Score final
      const finalScore = (baseScore + temporalBonus + engagementBonus + similarityBonus) * qualityMultiplier;
      
      // Appliquer les limites
      const cappedScore = Math.max(-20, Math.min(20, finalScore));
      
      logger.info(`🎯 Score calculé pour ${interactionType}: ${cappedScore} (base: ${baseScore}, qualité: ${qualityMultiplier})`);
      
      return {
        baseScore,
        qualityMultiplier,
        temporalBonus,
        engagementBonus,
        similarityBonus,
        finalScore: cappedScore,
        context
      };
      
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score d\'interaction:', error);
      return { finalScore: 0, error: error.message };
    }
  }

  /**
   * Obtient le score de base pour un type d'interaction
   */
  getBaseScore(interactionType) {
    if (this.baseScores.positive[interactionType]) {
      return this.baseScores.positive[interactionType];
    } else if (this.baseScores.negative[interactionType]) {
      return this.baseScores.negative[interactionType];
    } else if (this.baseScores.temporal[interactionType]) {
      return this.baseScores.temporal[interactionType];
    }
    return 0;
  }

  /**
   * Récupère le contexte de l'interaction
   */
  async getInteractionContext(tweetId, userId, metadata) {
    const [tweet, user, userBehavior] = await Promise.all([
      Tweet.findByPk(tweetId, {
        include: [
          { model: User, as: 'author', attributes: ['id', 'username', 'verified', 'followers_count', 'premium'] }
        ]
      }),
      User.findByPk(userId, {
        attributes: ['id', 'username', 'verified', 'followers_count', 'premium', 'created_at']
      }),
      UserBehaviorData.findOne({
        where: { user_id: userId },
        order: [['created_at', 'DESC']]
      })
    ]);

    return {
      tweet,
      user,
      userBehavior,
      metadata,
      timestamp: new Date()
    };
  }

  /**
   * Calcule le multiplicateur de qualité professionnel avancé
   */
  async calculateQualityMultiplier(context) {
    let multiplier = 1.0;
    const { tweet, user, metadata } = context;
    
    if (!tweet || !user) return multiplier;
    
    // 1. BONUS UTILISATEUR QUI INTERAGIT
    multiplier *= await this.calculateUserInteractionBonus(user, context);
    
    // 2. BONUS AUTEUR DU TWEET
    multiplier *= await this.calculateAuthorBonus(tweet, context);
    
    // 3. BONUS QUALITÉ DU CONTENU
    multiplier *= await this.calculateContentQualityBonus(tweet, context);
    
    // 4. BONUS TIMING ET CONTEXTE
    multiplier *= await this.calculateTimingBonus(tweet, context);
    
    // 5. BONUS ENGAGEMENT ET PERFORMANCE
    multiplier *= await this.calculateEngagementBonus(tweet, context);
    
    // 6. BONUS INTERACTIONS SPÉCIALES
    multiplier *= await this.calculateSpecialInteractionBonus(user, tweet, metadata);
    
    // 7. BONUS FACTEURS SOCIAUX
    multiplier *= await this.calculateSocialBonus(user, tweet, context);
    
    // 8. BONUS FACTEURS TEMPORELS
    multiplier *= await this.calculateTemporalBonus(tweet, context);
    
    // 9. BONUS FACTEURS DE QUALITÉ
    multiplier *= await this.calculateContentTypeBonus(tweet, context);
    
    // 10. BONUS DIVERSITÉ ET PORTÉE
    multiplier *= await this.calculateDiversityBonus(tweet, context);
    
    return Math.min(10.0, multiplier); // Limiter à 10x pour la professionnalisation
  }

  /**
   * Calcule les bonus de l'utilisateur qui interagit
   */
  async calculateUserInteractionBonus(user, context) {
    let bonus = 1.0;
    const { interactionType } = context.metadata || {};
    
    // Bonus utilisateur vérifié
    if (user.verified) {
      if (interactionType === 'tweet_like') bonus *= this.qualityMultipliers.verified_user_like;
      else if (interactionType === 'tweet_comment') bonus *= this.qualityMultipliers.verified_user_comment;
      else if (interactionType === 'tweet_retweet') bonus *= this.qualityMultipliers.verified_user_retweet;
    }
    
    // Bonus utilisateur premium
    if (user.premium) {
      if (interactionType === 'tweet_like') bonus *= this.qualityMultipliers.premium_user_like;
      else if (interactionType === 'tweet_comment') bonus *= this.qualityMultipliers.premium_user_comment;
      else if (interactionType === 'tweet_retweet') bonus *= this.qualityMultipliers.premium_user_retweet;
    }
    
    // Bonus influence
    if (user.followers_count >= this.qualityThresholds.celebrity_follower_count) {
      bonus *= this.qualityMultipliers.celebrity_user;
    } else if (user.followers_count >= this.qualityThresholds.influencer_follower_count) {
      bonus *= this.qualityMultipliers.influencer_user;
    } else if (user.followers_count >= this.qualityThresholds.very_high_follower_count) {
      bonus *= this.qualityMultipliers.very_high_follower_count;
    } else if (user.followers_count >= this.qualityThresholds.high_follower_count) {
      bonus *= this.qualityMultipliers.high_follower_count;
    }
    
    return bonus;
  }

  /**
   * Calcule les bonus de l'auteur du tweet
   */
  async calculateAuthorBonus(tweet, context) {
    let bonus = 1.0;
    
    if (!tweet.author) return bonus;
    
    // Bonus auteur vérifié
    if (tweet.author.verified) {
      bonus *= this.qualityMultipliers.verified_author;
      
      // Bonus auteur vérifié très actif
      if (await this.isVeryActiveUser(tweet.author.id)) {
        bonus *= this.qualityMultipliers.verified_author_high_activity;
      }
    }
    
    // Bonus auteur premium
    if (tweet.author.premium) {
      bonus *= this.qualityMultipliers.premium_author;
      
      // Bonus auteur premium très actif
      if (await this.isVeryActiveUser(tweet.author.id)) {
        bonus *= this.qualityMultipliers.premium_author_high_activity;
      }
    }
    
    // Bonus influence de l'auteur
    if (tweet.author.followers_count >= this.qualityThresholds.celebrity_follower_count) {
      bonus *= this.qualityMultipliers.celebrity_user;
    } else if (tweet.author.followers_count >= this.qualityThresholds.influencer_follower_count) {
      bonus *= this.qualityMultipliers.influencer_user;
    }
    
    return bonus;
  }

  /**
   * Calcule les bonus de qualité du contenu
   */
  async calculateContentQualityBonus(tweet, context) {
    let bonus = 1.0;
    
    // Bonus médias
    if (tweet.media_urls && tweet.media_urls.length > 0) {
      bonus *= this.qualityMultipliers.with_media;
      
      // Bonus vidéo
      const hasVideo = tweet.media_urls.some(url => 
        url.includes('.mp4') || url.includes('.mov') || url.includes('.avi')
      );
      if (hasVideo) {
        bonus *= this.qualityMultipliers.with_video;
      } else {
        bonus *= this.qualityMultipliers.with_images;
      }
    }
    
    // Bonus hashtags
    if (tweet.hashtags && tweet.hashtags.length > 0) {
      bonus *= this.qualityMultipliers.with_hashtags;
      
      // Bonus hashtags tendance
      const trendingHashtags = await this.getTrendingHashtags();
      const trendingCount = tweet.hashtags.filter(tag => 
        trendingHashtags.includes(tag.toLowerCase())
      ).length;
      
      if (trendingCount >= this.qualityThresholds.trending_hashtags) {
        bonus *= this.qualityMultipliers.trending_topic;
      }
    }
    
    // Bonus mentions
    if (tweet.mentions && tweet.mentions.length > 0) {
      bonus *= this.qualityMultipliers.with_mentions;
    }
    
    // Bonus longueur du contenu
    if (tweet.content) {
      if (tweet.content.length >= this.qualityThresholds.very_long_content_length) {
        bonus *= this.qualityMultipliers.very_long_content;
      } else if (tweet.content.length >= this.qualityThresholds.long_content_length) {
        bonus *= this.qualityMultipliers.long_content;
      }
    }
    
    return bonus;
  }

  /**
   * Calcule les bonus de timing
   */
  async calculateTimingBonus(tweet, context) {
    let bonus = 1.0;
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();
    
    // Bonus heures de pointe
    if (hour >= this.qualityThresholds.very_peak_hours_start && 
        hour <= this.qualityThresholds.very_peak_hours_end) {
      bonus *= this.qualityMultipliers.very_peak_hours;
    } else if (hour >= this.qualityThresholds.peak_hours_start && 
               hour <= this.qualityThresholds.peak_hours_end) {
      bonus *= this.qualityMultipliers.peak_hours;
    }
    
    // Bonus contenu récent
    const ageInHours = (Date.now() - new Date(tweet.created_at)) / (1000 * 60 * 60);
    if (ageInHours <= this.qualityThresholds.very_recent_content_hours) {
      bonus *= this.qualityMultipliers.very_recent_content;
    } else if (ageInHours <= this.qualityThresholds.recent_content_hours) {
      bonus *= this.qualityMultipliers.recent_content;
    }
    
    // Bonus weekend
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      bonus *= this.qualityMultipliers.weekend_engagement;
    }
    
    // Bonus événements spéciaux
    if (await this.isSpecialEvent()) {
      bonus *= this.qualityMultipliers.event_engagement;
    }
    
    return bonus;
  }

  /**
   * Calcule les bonus d'engagement
   */
  async calculateEngagementBonus(tweet, context) {
    let bonus = 1.0;
    
    // Récupérer les stats d'engagement du tweet
    const engagementStats = await this.getTweetEngagementStats(tweet.id);
    
    if (engagementStats.engagementRate >= this.qualityThresholds.explosive_growth_rate) {
      bonus *= this.qualityMultipliers.explosive_growth;
    } else if (engagementStats.engagementRate >= this.qualityThresholds.very_high_engagement_rate) {
      bonus *= this.qualityMultipliers.very_high_engagement_rate;
    } else if (engagementStats.engagementRate >= this.qualityThresholds.high_engagement_rate) {
      bonus *= this.qualityMultipliers.high_engagement_rate;
    }
    
    // Bonus potentiel viral
    if (engagementStats.viralScore >= this.qualityThresholds.viral_potential_score) {
      bonus *= this.qualityMultipliers.viral_potential;
    }
    
    return bonus;
  }

  /**
   * Calcule les bonus d'interactions spéciales
   */
  async calculateSpecialInteractionBonus(user, tweet, metadata) {
    let bonus = 1.0;
    
    // Bonus première interaction
    if (await this.isFirstInteraction(user.id, tweet.id)) {
      bonus *= this.qualityMultipliers.first_interaction;
    }
    
    // Bonus interaction rapide
    const ageInMinutes = (Date.now() - new Date(tweet.created_at)) / (1000 * 60);
    if (ageInMinutes <= this.qualityThresholds.quick_interaction_minutes) {
      bonus *= this.qualityMultipliers.quick_interaction;
    }
    
    // Bonus engagement soutenu
    if (await this.hasSustainedEngagement(tweet.id)) {
      bonus *= this.qualityMultipliers.sustained_engagement;
    }
    
    // Bonus partage cross-platform
    if (metadata && metadata.crossPlatform) {
      bonus *= this.qualityMultipliers.cross_platform_share;
    }
    
    return bonus;
  }

  /**
   * Calcule les bonus sociaux
   */
  async calculateSocialBonus(user, tweet, context) {
    let bonus = 1.0;
    
    // Bonus suivi mutuel
    if (await this.isMutualFollow(user.id, tweet.author_id)) {
      bonus *= this.qualityMultipliers.mutual_follow;
    }
    
    // Bonus connexion proche
    if (await this.isCloseConnection(user.id, tweet.author_id)) {
      bonus *= this.qualityMultipliers.close_connection;
    }
    
    // Bonus membre de la communauté
    if (await this.isCommunityMember(user.id)) {
      bonus *= this.qualityMultipliers.community_member;
    }
    
    // Bonus affilié à une marque
    if (await this.isBrandAffiliate(user.id)) {
      bonus *= this.qualityMultipliers.brand_affiliate;
    }
    
    return bonus;
  }

  /**
   * Calcule les bonus temporels
   */
  async calculateTemporalBonus(tweet, context) {
    let bonus = 1.0;
    
    // Bonus jour férié
    if (await this.isHoliday()) {
      bonus *= this.qualityMultipliers.holiday_engagement;
    }
    
    return bonus;
  }

  /**
   * Calcule les bonus de type de contenu
   */
  async calculateContentTypeBonus(tweet, context) {
    let bonus = 1.0;
    
    if (!tweet.content) return bonus;
    
    const content = tweet.content.toLowerCase();
    
    // Bonus contenu éducatif
    const educationalKeywords = this.qualityThresholds.educational_keywords;
    if (educationalKeywords.some(keyword => content.includes(keyword))) {
      bonus *= this.qualityMultipliers.educational_content;
    }
    
    // Bonus contenu d'actualité
    const newsKeywords = this.qualityThresholds.news_keywords;
    if (newsKeywords.some(keyword => content.includes(keyword))) {
      bonus *= this.qualityMultipliers.news_content;
    }
    
    // Bonus contenu viral
    const viralKeywords = this.qualityThresholds.viral_keywords;
    if (viralKeywords.some(keyword => content.includes(keyword))) {
      bonus *= this.qualityMultipliers.viral_topic;
    }
    
    // Bonus contenu original
    if (await this.isOriginalContent(tweet.content)) {
      bonus *= this.qualityMultipliers.original_content;
    }
    
    return bonus;
  }

  /**
   * Calcule les bonus de diversité
   */
  async calculateDiversityBonus(tweet, context) {
    let bonus = 1.0;
    
    // Bonus audience diverse
    if (await this.hasDiverseAudience(tweet.id)) {
      bonus *= this.qualityMultipliers.diverse_audience;
    }
    
    // Bonus portée internationale
    if (await this.hasInternationalReach(tweet.id)) {
      bonus *= this.qualityMultipliers.international_reach;
    }
    
    // Bonus cross-démographique
    if (await this.isCrossDemographic(tweet.id)) {
      bonus *= this.qualityMultipliers.cross_demographic;
    }
    
    return bonus;
  }

  /**
   * Calcule le bonus temporel
   */
  calculateTemporalBonus(interactionType, metadata) {
    let bonus = 0;
    
    // Bonus pour la durée de visualisation
    if (metadata.duration) {
      const durationSeconds = metadata.duration / 1000;
      bonus += durationSeconds * this.baseScores.temporal.view_duration;
    }
    
    // Bonus pour les pauses de scroll
    if (metadata.scrollPause) {
      bonus += this.baseScores.temporal.scroll_pause;
    }
    
    // Bonus pour le temps passé sur le contenu
    if (metadata.timeSpent) {
      const timeSeconds = metadata.timeSpent / 1000;
      bonus += timeSeconds * this.baseScores.temporal.time_spent;
    }
    
    // Bonus pour la durée de session
    if (metadata.sessionDuration) {
      const sessionSeconds = metadata.sessionDuration / 1000;
      bonus += sessionSeconds * this.baseScores.temporal.session_duration;
    }
    
    return Math.min(10, bonus); // Limiter à 10 points
  }

  /**
   * Calcule le bonus d'engagement
   */
  async calculateEngagementBonus(tweetId, context) {
    try {
      const tweet = context.tweet;
      if (!tweet) return 0;
      
      // Calculer le taux d'engagement
      const totalInteractions = (tweet.like_count || 0) + (tweet.retweet_count || 0) + (tweet.reply_count || 0);
      const views = tweet.view_count || 1;
      const engagementRate = totalInteractions / views;
      
      let bonus = 0;
      
      // Bonus pour un taux d'engagement élevé
      if (engagementRate > this.qualityThresholds.high_engagement_rate) {
        bonus += this.qualityMultipliers.high_engagement_rate * 10;
      }
      
      // Bonus pour le potentiel viral
      if (totalInteractions > this.qualityThresholds.viral_potential_score) {
        bonus += this.qualityMultipliers.viral_potential * 5;
      }
      
      return Math.min(15, bonus); // Limiter à 15 points
      
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du bonus d\'engagement:', error);
      return 0;
    }
  }

  /**
   * Calcule le bonus de similarité
   */
  async calculateSimilarityBonus(tweetId, userId, context) {
    try {
      const { tweet, user } = context;
      if (!tweet || !user) return 0;
      
      let bonus = 0;
      
      // Vérifier si l'utilisateur suit l'auteur
      if (tweet.author_id !== userId) {
        const isFollowing = await UserFollow.findOne({
          where: {
            follower_id: userId,
            following_id: tweet.author_id
          }
        });
        
        if (isFollowing) {
          bonus += 2.0; // Bonus pour suivre l'auteur
        }
      }
      
      // Vérifier les interactions passées avec l'auteur
      const pastInteractions = await UserBehaviorData.count({
        where: {
          user_id: userId,
          target_id: tweet.author_id,
          target_type: 'user',
          action_type: ['tweet_like', 'tweet_retweet', 'tweet_comment']
        }
      });
      
      if (pastInteractions > 0) {
        bonus += Math.min(3.0, pastInteractions * 0.5); // Bonus pour l'historique
      }
      
      // Vérifier les hashtags communs
      if (tweet.hashtags && tweet.hashtags.length > 0) {
        const userHashtagPreferences = await this.getUserHashtagPreferences(userId);
        const commonHashtags = tweet.hashtags.filter(tag => 
          userHashtagPreferences.includes(tag.toLowerCase())
        );
        
        if (commonHashtags.length > 0) {
          bonus += (commonHashtags.length / tweet.hashtags.length) * 2.0;
        }
      }
      
      return Math.min(8, bonus); // Limiter à 8 points
      
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du bonus de similarité:', error);
      return 0;
    }
  }

  /**
   * Obtient les préférences de hashtags de l'utilisateur
   */
  async getUserHashtagPreferences(userId) {
    try {
      const hashtagInteractions = await UserBehaviorData.findAll({
        where: {
          user_id: userId,
          action_type: 'hashtag_click',
          created_at: {
            [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 derniers jours
          }
        },
        attributes: ['context_data'],
        limit: 100
      });
      
      const hashtags = new Set();
      hashtagInteractions.forEach(interaction => {
        if (interaction.context_data && interaction.context_data.hashtag) {
          hashtags.add(interaction.context_data.hashtag.toLowerCase());
        }
      });
      
      return Array.from(hashtags);
      
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des préférences de hashtags:', error);
      return [];
    }
  }

  /**
   * Calcule le score de viralité d'un tweet
   */
  async calculateTweetViralityScore(tweetId) {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      
      // Récupérer toutes les interactions récentes
      const interactions = await UserBehaviorData.findAll({
        where: {
          target_id: tweetId,
          target_type: 'tweet',
          timestamp: { [Op.gte]: oneHourAgo }
        },
        order: [['timestamp', 'DESC']]
      });
      
      let totalScore = 0;
      let positiveCount = 0;
      let negativeCount = 0;
      
      // Calculer le score total
      for (const interaction of interactions) {
        const score = this.getBaseScore(interaction.action_type);
        totalScore += score;
        
        if (score > 0) positiveCount++;
        else if (score < 0) negativeCount++;
      }
      
      // Calculer le taux d'engagement
      const engagementRate = interactions.length > 0 ? positiveCount / interactions.length : 0;
      
      // Calculer la vélocité (interactions par minute)
      const timeSpan = (Date.now() - oneHourAgo.getTime()) / (1000 * 60); // en minutes
      const velocity = interactions.length / timeSpan;
      
      return {
        tweetId,
        totalScore,
        positiveCount,
        negativeCount,
        engagementRate,
        velocity,
        interactionCount: interactions.length,
        calculatedAt: new Date()
      };
      
    } catch (error) {
      logger.error('❌ Erreur lors du calcul du score de viralité:', error);
      return { tweetId, totalScore: 0, error: error.message };
    }
  }

  /**
   * Obtient les statistiques d'interaction d'un utilisateur
   */
  async getUserInteractionStats(userId, timeWindow = 24) {
    try {
      const timeAgo = new Date(Date.now() - timeWindow * 60 * 60 * 1000);
      
      const interactions = await UserBehaviorData.findAll({
        where: {
          user_id: userId,
          timestamp: { [Op.gte]: timeAgo }
        },
        attributes: ['action_type', 'target_type', 'interaction_quality', 'created_at']
      });
      
      const stats = {
        totalInteractions: interactions.length,
        positiveInteractions: 0,
        negativeInteractions: 0,
        averageQuality: 0,
        topActions: {},
        hourlyDistribution: {},
        qualityScore: 0
      };
      
      let totalQuality = 0;
      
      interactions.forEach(interaction => {
        const score = this.getBaseScore(interaction.action_type);
        
        if (score > 0) stats.positiveInteractions++;
        else if (score < 0) stats.negativeInteractions++;
        
        if (interaction.interaction_quality) {
          totalQuality += interaction.interaction_quality;
        }
        
        // Top actions
        stats.topActions[interaction.action_type] = (stats.topActions[interaction.action_type] || 0) + 1;
        
        // Distribution horaire
        const hour = new Date(interaction.created_at).getHours();
        stats.hourlyDistribution[hour] = (stats.hourlyDistribution[hour] || 0) + 1;
      });
      
      stats.averageQuality = interactions.length > 0 ? totalQuality / interactions.length : 0;
      stats.qualityScore = stats.averageQuality * (stats.positiveInteractions / Math.max(1, stats.totalInteractions));
      
      return stats;
      
    } catch (error) {
      logger.error('❌ Erreur lors du calcul des statistiques d\'interaction:', error);
      return { error: error.message };
    }
  }

  // ===== MÉTHODES HELPER POUR LES BONUS PROFESSIONNELS =====

  /**
   * Vérifie si un utilisateur est très actif
   */
  async isVeryActiveUser(userId) {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      const postCount = await Tweet.count({
        where: {
          author_id: userId,
          created_at: { [Op.gte]: oneDayAgo }
        }
      });
      
      return postCount >= this.qualityThresholds.very_active_user_posts_per_day;
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification de l\'activité:', error);
      return false;
    }
  }

  /**
   * Obtient les hashtags tendance
   */
  async getTrendingHashtags() {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      
      const trendingHashtags = await UserBehaviorData.findAll({
        where: {
          action_type: 'hashtag_click',
          timestamp: { [Op.gte]: oneHourAgo }
        },
        attributes: ['context_data'],
        limit: 20
      });
      
      const hashtagCounts = {};
      trendingHashtags.forEach(interaction => {
        if (interaction.context_data && interaction.context_data.hashtag) {
          const hashtag = interaction.context_data.hashtag.toLowerCase();
          hashtagCounts[hashtag] = (hashtagCounts[hashtag] || 0) + 1;
        }
      });
      
      // Retourner les hashtags les plus populaires
      return Object.keys(hashtagCounts)
        .sort((a, b) => hashtagCounts[b] - hashtagCounts[a])
        .slice(0, 10);
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des hashtags tendance:', error);
      return [];
    }
  }

  /**
   * Obtient les statistiques d'engagement d'un tweet
   */
  async getTweetEngagementStats(tweetId) {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      
      const interactions = await UserBehaviorData.findAll({
        where: {
          target_id: tweetId,
          target_type: 'tweet',
          timestamp: { [Op.gte]: oneHourAgo }
        }
      });
      
      const views = interactions.filter(i => i.action_type === 'tweet_view').length;
      const positiveInteractions = interactions.filter(i => this.getBaseScore(i.action_type) > 0).length;
      
      return {
        views,
        positiveInteractions,
        engagementRate: views > 0 ? positiveInteractions / views : 0,
        viralScore: positiveInteractions
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des stats d\'engagement:', error);
      return { views: 0, positiveInteractions: 0, engagementRate: 0, viralScore: 0 };
    }
  }

  /**
   * Vérifie si c'est la première interaction
   */
  async isFirstInteraction(userId, tweetId) {
    try {
      const existingInteraction = await UserBehaviorData.findOne({
        where: {
          user_id: userId,
          target_id: tweetId,
          target_type: 'tweet',
          action_type: { [Op.in]: ['tweet_like', 'tweet_comment', 'tweet_retweet'] }
        }
      });
      
      return !existingInteraction;
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification de la première interaction:', error);
      return false;
    }
  }

  /**
   * Vérifie si le tweet a un engagement soutenu
   */
  async hasSustainedEngagement(tweetId) {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      
      const interactions = await UserBehaviorData.count({
        where: {
          target_id: tweetId,
          target_type: 'tweet',
          timestamp: { [Op.gte]: twoHoursAgo },
          action_type: { [Op.in]: ['tweet_like', 'tweet_comment', 'tweet_retweet'] }
        }
      });
      
      return interactions >= 5; // Au moins 5 interactions en 2h
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification de l\'engagement soutenu:', error);
      return false;
    }
  }

  /**
   * Vérifie si c'est un suivi mutuel
   */
  async isMutualFollow(userId, authorId) {
    try {
      const [userFollowsAuthor, authorFollowsUser] = await Promise.all([
        UserFollow.findOne({
          where: { follower_id: userId, following_id: authorId }
        }),
        UserFollow.findOne({
          where: { follower_id: authorId, following_id: userId }
        })
      ]);
      
      return !!(userFollowsAuthor && authorFollowsUser);
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification du suivi mutuel:', error);
      return false;
    }
  }

  /**
   * Vérifie si c'est une connexion proche
   */
  async isCloseConnection(userId, authorId) {
    try {
      // Vérifier les interactions passées entre les utilisateurs
      const pastInteractions = await UserBehaviorData.count({
        where: {
          user_id: userId,
          target_id: authorId,
          target_type: 'user',
          action_type: { [Op.in]: ['tweet_like', 'tweet_comment', 'tweet_retweet'] }
        }
      });
      
      return pastInteractions >= 10; // Au moins 10 interactions passées
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification de la connexion proche:', error);
      return false;
    }
  }

  /**
   * Vérifie si l'utilisateur est membre de la communauté
   */
  async isCommunityMember(userId) {
    try {
      // Vérifier si l'utilisateur a des interactions avec d'autres membres
      const communityInteractions = await UserBehaviorData.count({
        where: {
          user_id: userId,
          action_type: { [Op.in]: ['tweet_like', 'tweet_comment', 'tweet_retweet'] }
        }
      });
      
      return communityInteractions >= 20; // Au moins 20 interactions communautaires
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification du membre de communauté:', error);
      return false;
    }
  }

  /**
   * Vérifie si l'utilisateur est affilié à une marque
   */
  async isBrandAffiliate(userId) {
    try {
      // Vérifier si l'utilisateur a des mentions de marques dans ses tweets
      const brandTweets = await Tweet.count({
        where: {
          author_id: userId,
          content: { [Op.iLike]: '%@%' } // Tweets avec mentions
        }
      });
      
      return brandTweets >= 5; // Au moins 5 tweets avec mentions
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification de l\'affiliation marque:', error);
      return false;
    }
  }

  /**
   * Vérifie si c'est un jour férié
   */
  async isHoliday() {
    const today = new Date();
    const holidays = [
      '01-01', // Nouvel An
      '12-25', // Noël
      '07-14', // Fête Nationale
      '05-01', // Fête du Travail
      '11-11'  // Armistice
    ];
    
    const todayStr = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return holidays.includes(todayStr);
  }

  /**
   * Vérifie si c'est un événement spécial
   */
  async isSpecialEvent() {
    // Logique pour détecter des événements spéciaux
    // Peut être étendue avec une base de données d'événements
    return false;
  }

  /**
   * Vérifie si le contenu est original
   */
  async isOriginalContent(content) {
    try {
      // Vérifier si le contenu n'est pas un retweet ou une citation
      const isRetweet = content.startsWith('RT @') || content.startsWith('QT @');
      return !isRetweet;
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification du contenu original:', error);
      return true;
    }
  }

  /**
   * Vérifie si le tweet a une audience diverse
   */
  async hasDiverseAudience(tweetId) {
    try {
      const interactions = await UserBehaviorData.findAll({
        where: {
          target_id: tweetId,
          target_type: 'tweet',
          action_type: 'tweet_view'
        },
        attributes: ['user_id'],
        limit: 20
      });
      
      // Vérifier la diversité des utilisateurs qui ont interagi
      const uniqueUsers = new Set(interactions.map(i => i.user_id));
      return uniqueUsers.size >= 10; // Au moins 10 utilisateurs différents
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification de l\'audience diverse:', error);
      return false;
    }
  }

  /**
   * Vérifie si le tweet a une portée internationale
   */
  async hasInternationalReach(tweetId) {
    // Pour l'instant, retourner false
    // Peut être étendue avec des données de géolocalisation
    return false;
  }

  /**
   * Vérifie si le tweet est cross-démographique
   */
  async isCrossDemographic(tweetId) {
    try {
      const interactions = await UserBehaviorData.findAll({
        where: {
          target_id: tweetId,
          target_type: 'tweet',
          action_type: 'tweet_view'
        },
        include: [{
          model: User,
          as: 'user',
          attributes: ['followers_count']
        }],
        limit: 20
      });
      
      // Vérifier la diversité des niveaux d'influence
      const followerCounts = interactions.map(i => i.user?.followers_count || 0);
      const hasHighInfluence = followerCounts.some(count => count >= 20);
      const hasLowInfluence = followerCounts.some(count => count < 5);
      
      return hasHighInfluence && hasLowInfluence;
    } catch (error) {
      logger.error('❌ Erreur lors de la vérification cross-démographique:', error);
      return false;
    }
  }
}

module.exports = InteractionScoringService;
