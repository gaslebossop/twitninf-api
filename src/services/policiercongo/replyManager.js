/**
 * 💬 Gestionnaire de Réponses PolicierCongo
 * 
 * Gère toutes les réponses et interactions avec les utilisateurs
 */

const logger = require('../../utils/logger');
const { Tweet, User } = require('../../models');
const { POLICE_ACCOUNT_ID, LIMITS, RESPONSE_TYPES } = require('./config');

class ReplyManager {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialise le gestionnaire de réponses
   */
  async initialize() {
    try {
      logger.info('💬 Initialisation du gestionnaire de réponses...');
      
      // Vérifier la connexion à la base de données
      await this._testConnection();
      
      this.initialized = true;
      logger.info('✅ Gestionnaire de réponses initialisé');
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation du gestionnaire de réponses:', error);
      throw error;
    }
  }

  /**
   * Teste la connexion à la base de données
   */
  async _testConnection() {
    try {
      const tweetCount = await Tweet.count();
      logger.info(`💬 Connexion DB OK - ${tweetCount} tweets trouvés`);
    } catch (error) {
      throw new Error(`Impossible de se connecter à la base de données: ${error.message}`);
    }
  }

  /**
   * Répond à un tweet spécifique
   */
  async respondToTweet(tweetId, context = {}) {
    try {
      if (!this.initialized) {
        throw new Error('Gestionnaire de réponses non initialisé');
      }

      logger.info(`💬 Réponse contextuelle au tweet: ${tweetId}`);
      
      // Récupérer le tweet original
      const originalTweet = await Tweet.findByPk(tweetId, {
        include: [
          { model: User, as: 'author', attributes: ['username', 'full_name', 'created_at'] }
        ]
      });

      if (!originalTweet) {
        throw new Error('Tweet non trouvé');
      }

      // Vérifier si PolicierCongo a déjà répondu
      const existingResponse = await Tweet.findOne({
        where: {
          parent_tweet_id: tweetId,
          user_id: POLICE_ACCOUNT_ID
        }
      });

      if (existingResponse) {
        logger.info(`ℹ️ PolicierCongo a déjà répondu au tweet ${tweetId}`);
        return {
          success: true,
          already_responded: true,
          existing_response_id: existingResponse.id
        };
      }

      // Générer une réponse contextuelle
      const responseData = await this.generateContextualResponse(originalTweet, context);
      
      if (!responseData) {
        throw new Error('Impossible de générer une réponse contextuelle');
      }

      // Créer la réponse
      const responseTweet = await Tweet.create({
        content: responseData.content,
        user_id: POLICE_ACCOUNT_ID,
        parent_tweet_id: tweetId,
        is_private: false,
        is_sensitive: false,
        language: 'fr',
        moderation_status: 'approved',
        metadata: {
          source: 'contextual_response',
          original_tweet_id: tweetId,
          original_author: originalTweet.author?.username,
          response_type: responseData.type,
          context_analysis: responseData.contextAnalysis,
          generated_at: new Date().toISOString()
        }
      });

      logger.info(`✅ Réponse contextuelle créée: ${responseTweet.id}`);
      
      return {
        success: true,
        response_tweet_id: responseTweet.id,
        original_tweet_id: tweetId,
        content: responseData.content,
        type: responseData.type,
        context_analysis: responseData.contextAnalysis
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la réponse contextuelle:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Génère une réponse contextuelle intelligente
   */
  async generateContextualResponse(originalTweet, context = {}) {
    try {
      const { runPolicierCongoV2Turn, isPolicierCongoV2Enabled, TRIGGER_TYPES } = require('./policiercongov3/compatibilityBridge');
      const { geminiIntelligence } = require('./index');

      if (isPolicierCongoV2Enabled() && originalTweet.user_id && originalTweet.content) {
        const username = originalTweet.author?.username || 'user';
        const event = {
          id: `reply_${originalTweet.id}`,
          trigger: TRIGGER_TYPES.MENTION,
          userId: String(originalTweet.user_id),
          postId: String(originalTweet.id),
          threadId: String(originalTweet.parent_tweet_id || originalTweet.id),
          rawText: String(originalTweet.content),
          metadata: { source: 'reply_manager', username }
        };

        const tweetAge = Math.floor((new Date() - new Date(originalTweet.created_at)) / (1000 * 60 * 60));
        const systemPrompt = [
          'Tu es Policier Congo sur TwitNinf. Tu réponds en mention / reply à un tweet.',
          `Auteur du tweet : @${username}`,
          `Âge du tweet : ~${tweetAge} h.`,
          'Style : argot 2026, direct, pas de hashtags, court. Jamais dire que tu es une IA.',
          'Réponds en JSON uniquement : action, content, next_check_in, store_memory. content = texte du tweet de réponse (avec @ si pertinent).'
        ].join('\n');

        try {
          const v2 = await runPolicierCongoV2Turn({
            event,
            buildOptions: { systemPrompt },
            geminiIntelligence
          });
          if (v2 && v2.replyText) {
            const responseType = this._detectContentType(String(originalTweet.content).toLowerCase());
            return {
              content: v2.replyText,
              type: responseType === 'question' ? RESPONSE_TYPES.conseil : RESPONSE_TYPES.salutation,
              contextAnalysis: {
                userMood: 'neutre',
                tweetRelevance: 'moyenne',
                responseStrategy: 'policiercongo_v2',
                timing: tweetAge < 6 ? 'reponse_immediate' : 'reponse_standard',
                content_type: responseType,
                urgency: tweetAge < 6 ? 'high' : tweetAge < 24 ? 'medium' : 'low'
              }
            };
          }
        } catch (e) {
          logger.warn('⚠️ ReplyManager V3 indisponible, fallback heuristique:', e.message);
        }
      }

      // Analyser le contexte temporel
      const tweetAge = Math.floor((new Date() - new Date(originalTweet.created_at)) / (1000 * 60 * 60));
      
      // Analyser le contenu du tweet
      const content = originalTweet.content.toLowerCase();
      const username = originalTweet.author?.username || 'ami';
      
      // Détecter le type de contenu
      let responseType = RESPONSE_TYPES.salutation;
      let responseContent = '';

      // Réponses basées sur le contenu
      if (content.includes('?') || content.includes('comment') || content.includes('pourquoi')) {
        responseType = RESPONSE_TYPES.conseil;
        responseContent = `Hey @${username} ! 🌟 Excellente question ! Sécurité priorité ! 💪`;
      } else if (content.includes('merci') || content.includes('bravo') || content.includes('félicitations')) {
        responseType = RESPONSE_TYPES.encouragement;
        responseContent = `Merci @${username} ! 😊 Votre soutien nous motive ! 🤝`;
      } else if (content.includes('sécurité') || content.includes('police') || content.includes('danger')) {
        responseType = RESPONSE_TYPES.conseil;
        responseContent = `Salut @${username} ! 🚨 Sécurité quartier préoccupation ! On travaille dessus ! 💪🚔`;
      } else if (content.includes('quartier') || content.includes('rue') || content.includes('problème')) {
        responseType = RESPONSE_TYPES.encouragement;
        responseContent = `Salut @${username} ! 😊 On surveille votre quartier ! Restez vigilants ! 👀`;
      } else {
        // Réponse générique basée sur l'âge du tweet
        if (tweetAge < 2) {
          responseContent = `Salut @${username} ! 😊 J'ai vu ton message ! Questions sécurité ? 🚔💪`;
        } else if (tweetAge < 12) {
          responseContent = `Hey @${username} ! 🌟 Merci pour ton tweet ! Sujet important ! 🤝`;
        } else {
          responseContent = `Bonjour @${username} ! 👋 Désolé du retard ! Point intéressant ! 💭`;
        }
      }

      // Limiter la longueur de la réponse
      if (responseContent.length > LIMITS.maxReplyLength) {
        responseContent = responseContent.substring(0, LIMITS.maxReplyLength - 3) + '...';
      }

      return {
        content: responseContent,
        type: responseType,
        contextAnalysis: {
          userMood: 'neutre',
          tweetRelevance: 'moyenne',
          responseStrategy: 'contextual_analysis',
          timing: tweetAge < 6 ? 'reponse_immediate' : 'reponse_standard',
          content_type: this._detectContentType(content),
          urgency: tweetAge < 6 ? 'high' : tweetAge < 24 ? 'medium' : 'low'
        }
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la génération de réponse contextuelle:', error);
      return this.generateFallbackResponse(originalTweet);
    }
  }

  /**
   * Détecte le type de contenu d'un tweet
   */
  _detectContentType(content) {
    const lowerContent = content.toLowerCase();
    
    if (lowerContent.includes('?') || lowerContent.includes('comment') || lowerContent.includes('pourquoi')) {
      return 'question';
    } else if (lowerContent.includes('merci') || lowerContent.includes('bravo') || lowerContent.includes('félicitations')) {
      return 'gratitude';
    } else if (lowerContent.includes('sécurité') || lowerContent.includes('police') || lowerContent.includes('danger')) {
      return 'securite';
    } else if (lowerContent.includes('quartier') || lowerContent.includes('rue') || lowerContent.includes('problème')) {
      return 'quartier';
    } else if (lowerContent.includes('urgence') || lowerContent.includes('aide') || lowerContent.includes('conseil')) {
      return 'demande_aide';
    } else {
      return 'general';
    }
  }

  /**
   * Génère une réponse de fallback
   */
  generateFallbackResponse(originalTweet) {
    const username = originalTweet.author?.username || 'ami';
    const tweetAge = Math.floor((new Date() - new Date(originalTweet.created_at)) / (1000 * 60 * 60));
    
    let content, type;
    
    if (tweetAge < 2) {
      content = `Salut @${username} ! 😊 J'ai vu ton message ! Questions sécurité ? 🚔💪`;
      type = RESPONSE_TYPES.salutation;
    } else if (tweetAge < 12) {
      content = `Hey @${username} ! 🌟 Merci pour ton tweet ! Sujet important ! 🤝`;
      type = RESPONSE_TYPES.encouragement;
    } else {
      content = `Bonjour @${username} ! 👋 Désolé du retard ! Point intéressant ! 💭`;
      type = RESPONSE_TYPES.salutation;
    }
    
    return {
      content,
      type,
      contextAnalysis: {
        userMood: 'neutre',
        tweetRelevance: 'moyenne',
        responseStrategy: 'fallback_simple',
        timing: 'reponse_standard'
      }
    };
  }

  /**
   * Détecte automatiquement les tweets qui méritent une réponse
   */
  async detectTweetsForResponse() {
    try {
      logger.info('🔍 Détection automatique des tweets pour réponse...');
      
      // Récupérer les tweets récents (24h) qui ne sont pas de PolicierCongo
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      
      const recentTweets = await Tweet.findAll({
        where: {
          user_id: { [require('sequelize').Op.ne]: POLICE_ACCOUNT_ID },
          created_at: { [require('sequelize').Op.gte]: oneDayAgo },
          parent_tweet_id: null, // Pas de réponses aux réponses
          moderation_status: 'approved'
        },
        include: [
          { model: User, as: 'author', attributes: ['username', 'full_name', 'created_at'] }
        ],
        order: [['created_at', 'DESC']],
        limit: 50
      });

      if (recentTweets.length === 0) {
        logger.info('ℹ️ Aucun tweet récent trouvé pour analyse');
        return [];
      }

      // Analyser chaque tweet pour déterminer s'il mérite une réponse
      const tweetsToRespond = [];
      
      for (const tweet of recentTweets) {
        const shouldRespond = await this.analyzeTweetForResponse(tweet);
        if (shouldRespond.shouldRespond) {
          tweetsToRespond.push({
            tweet,
            priority: shouldRespond.priority,
            reason: shouldRespond.reason,
            context: shouldRespond.context
          });
        }
      }

      // Trier par priorité et limiter le nombre de réponses
      const sortedTweets = tweetsToRespond
        .sort((a, b) => {
          const priorityOrder = { high: 3, medium: 2, low: 1 };
          return priorityOrder[b.priority] - priorityOrder[a.priority];
        })
        .slice(0, LIMITS.maxRepliesPerCycle);

      logger.info(`✅ ${sortedTweets.length} tweets sélectionnés pour réponse`);
      
      return sortedTweets;

    } catch (error) {
      logger.error('❌ Erreur lors de la détection des tweets pour réponse:', error);
      return [];
    }
  }

  /**
   * Analyse un tweet pour déterminer s'il mérite une réponse
   */
  async analyzeTweetForResponse(tweet) {
    try {
      // Vérifier si PolicierCongo a déjà répondu
      const existingResponse = await Tweet.findOne({
        where: {
          parent_tweet_id: tweet.id,
          user_id: POLICE_ACCOUNT_ID
        }
      });

      if (existingResponse) {
        return { shouldRespond: false, reason: 'Déjà répondu' };
      }

      // Analyser le contenu du tweet
      const content = tweet.content.toLowerCase();
      const username = tweet.author?.username || '';
      
      // Mots-clés qui indiquent une demande ou un sujet important
      const importantKeywords = [
        'sécurité', 'police', 'vol', 'agression', 'urgence', 'aide', 'conseil',
        'quartier', 'rue', 'danger', 'problème', 'question', 'inquiétude',
        'merci', 'bravo', 'félicitations', 'soutien', 'solidarité'
      ];

      // Mots-clés spécifiques au Congo
      const congoKeywords = [
        'kinshasa', 'lubumbashi', 'mbuji-mayi', 'kananga', 'kisangani',
        'rdc', 'congo', 'congolais', 'kinshasaise', 'lubumbashien'
      ];

      // Calculer le score de pertinence
      let relevanceScore = 0;
      let detectedContext = {};

      // Score basé sur les mots-clés importants
      importantKeywords.forEach(keyword => {
        if (content.includes(keyword)) {
          relevanceScore += 2;
          detectedContext.importantTopics = detectedContext.importantTopics || [];
          detectedContext.importantTopics.push(keyword);
        }
      });

      // Score basé sur les mots-clés Congo
      congoKeywords.forEach(keyword => {
        if (content.includes(keyword) || username.toLowerCase().includes(keyword)) {
          relevanceScore += 1;
          detectedContext.congoRelevance = true;
        }
      });

      // Score basé sur l'âge du tweet (plus récent = plus important)
      const tweetAge = Math.floor((new Date() - new Date(tweet.created_at)) / (1000 * 60 * 60));
      if (tweetAge < 2) relevanceScore += 3;
      else if (tweetAge < 6) relevanceScore += 2;
      else if (tweetAge < 12) relevanceScore += 1;

      // Détecter le type de contenu
      if (content.includes('?') || content.includes('comment') || content.includes('pourquoi')) {
        relevanceScore += 2;
        detectedContext.hasQuestion = true;
      }

      if (content.includes('merci') || content.includes('bravo') || content.includes('félicitations')) {
        relevanceScore += 1;
        detectedContext.isGratitude = true;
      }

      // Déterminer la priorité et la décision
      let priority, shouldRespond, reason;

      if (relevanceScore >= 8) {
        priority = 'high';
        shouldRespond = true;
        reason = 'Tweet très pertinent avec mots-clés importants';
      } else if (relevanceScore >= 5) {
        priority = 'medium';
        shouldRespond = true;
        reason = 'Tweet pertinent avec éléments intéressants';
      } else if (relevanceScore >= 3) {
        priority = 'low';
        shouldRespond = true;
        reason = 'Tweet modérément pertinent';
      } else {
        priority = 'none';
        shouldRespond = false;
        reason = 'Tweet peu pertinent pour une réponse';
      }

      return {
        shouldRespond,
        priority,
        reason,
        relevanceScore,
        context: detectedContext
      };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse du tweet:', error);
      return { shouldRespond: false, reason: 'Erreur d\'analyse' };
    }
  }

  /**
   * Répond à plusieurs tweets en lot
   */
  async respondToMultipleTweets(tweetsToRespond) {
    try {
      logger.info(`💬 Réponse en lot à ${tweetsToRespond.length} tweets...`);
      
      const results = [];
      
      for (const tweetData of tweetsToRespond) {
        try {
          const result = await this.respondToTweet(tweetData.tweet.id, tweetData.context);
          results.push({
            tweet_id: tweetData.tweet.id,
            success: result.success,
            response_id: result.response_tweet_id,
            error: result.error
          });
          
          // Attendre un peu entre les réponses pour éviter le spam
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          logger.error(`❌ Erreur lors de la réponse au tweet ${tweetData.tweet.id}:`, error);
          results.push({
            tweet_id: tweetData.tweet.id,
            success: false,
            error: error.message
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      logger.info(`✅ ${successCount}/${results.length} réponses créées avec succès`);
      
      return {
        success: successCount > 0,
        total_tweets: tweetsToRespond.length,
        successful_responses: successCount,
        failed_responses: tweetsToRespond.length - successCount,
        results: results
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la réponse en lot:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Obtient les statistiques des réponses
   */
  async getReplyStats() {
    try {
      // Compter toutes les réponses de PolicierCongo
      const totalReplies = await Tweet.count({
        where: {
          user_id: POLICE_ACCOUNT_ID,
          parent_tweet_id: { [require('sequelize').Op.ne]: null }
        }
      });

      // Compter les réponses des dernières 24h
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      
      const recentReplies = await Tweet.count({
        where: {
          user_id: POLICE_ACCOUNT_ID,
          parent_tweet_id: { [require('sequelize').Op.ne]: null },
          created_at: { [require('sequelize').Op.gte]: oneDayAgo }
        }
      });

      // Compter les réponses des dernières 7 jours
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      
      const weeklyReplies = await Tweet.count({
        where: {
          user_id: POLICE_ACCOUNT_ID,
          parent_tweet_id: { [require('sequelize').Op.ne]: null },
          created_at: { [require('sequelize').Op.gte]: sevenDaysAgo }
        }
      });

      return {
        success: true,
        stats: {
          total_replies: totalReplies,
          last_24h: recentReplies,
          last_7_days: weeklyReplies,
          average_daily: Math.round(weeklyReplies / 7 * 10) / 10
        }
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des statistiques des réponses:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = ReplyManager;
