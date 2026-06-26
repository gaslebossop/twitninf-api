/**
 * 📝 Gestionnaire de Tweets PolicierCongo
 * 
 * Gère la création, modification et suppression des tweets
 */

const logger = require('../../utils/logger');
const { Tweet, User, TweetLike, TweetRetweet } = require('../../models');
const { POLICE_ACCOUNT_ID, LIMITS, DEFAULT_METADATA } = require('./config');

class TweetManager {
  constructor() {
    this.initialized = false;
  }

  /**
   * Vérifie si une chaîne est un UUID valide
   */
  _isValidUUID(uuid) {
    if (!uuid || typeof uuid !== 'string') return false;
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    return uuidRegex.test(uuid);
  }

  /**
   * Initialise le gestionnaire de tweets
   */
  async initialize() {
    try {
      logger.info('📝 Initialisation du gestionnaire de tweets...');
      
      // Vérifier la connexion à la base de données
      await this._testConnection();
      
      this.initialized = true;
      logger.info('✅ Gestionnaire de tweets initialisé');
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation du gestionnaire de tweets:', error);
      throw error;
    }
  }

  /**
   * Teste la connexion à la base de données
   */
  async _testConnection() {
    try {
      const tweetCount = await Tweet.count();
      logger.info(`📝 Connexion DB OK - ${tweetCount} tweets trouvés`);
    } catch (error) {
      throw new Error(`Impossible de se connecter à la base de données: ${error.message}`);
    }
  }

  /**
   * Valide les données du tweet
   */
  _validateTweetData(tweetData) {
    if (!tweetData.content || typeof tweetData.content !== 'string') {
      throw new Error('Le contenu du tweet est requis et doit être une chaîne');
    }

    if (tweetData.content.length === 0) {
      throw new Error('Le contenu du tweet ne peut pas être vide');
    }

    if (tweetData.content.length > LIMITS.maxTweetLength) {
      logger.warn(`⚠️ Contenu trop long (${tweetData.content.length} caractères), troncature à ${LIMITS.maxTweetLength} caractères`);
      tweetData.content = tweetData.content.substring(0, LIMITS.maxTweetLength - 3) + '...';
    }

    // Validation du parent_tweet_id si fourni
    if (tweetData.parent_tweet_id && typeof tweetData.parent_tweet_id !== 'string') {
      throw new Error('Le parent_tweet_id doit être une chaîne UUID valide');
    }
  }

  /**
   * Crée un nouveau tweet
   */
  async createTweet(tweetData) {
    try {
      if (!this.initialized) {
        throw new Error('Gestionnaire de tweets non initialisé');
      }

      logger.info('📝 Création d\'un nouveau tweet...');
      
      // Validation minimale (pas de limite de longueur pour PolicierCongo)
      this._validateTweetData(tweetData);
      
      // Préparer les métadonnées
      const metadata = {
        ...DEFAULT_METADATA,
        ...tweetData.metadata,
        generated_at: new Date().toISOString(),
        source: 'policiercongo_automation'
      };

      // Créer le tweet
      const tweet = await Tweet.create({
        content: tweetData.content,
        user_id: POLICE_ACCOUNT_ID,
        parent_tweet_id: tweetData.parent_tweet_id || null,
        is_private: tweetData.is_private || false,
        is_sensitive: tweetData.is_sensitive || false,
        language: tweetData.language || 'fr',
        moderation_status: tweetData.moderation_status || 'approved',
        recommendation_group: 'initial', // Enum valide: 'initial', 'expansion', 'viral', etc.
        view_count: 0,
        metadata: {
          ...metadata,
          progressive_testing: {
            added_at: new Date().toISOString(),
            status: 'approved',
            group: 'initial',
            reason: 'Tweet PolicierCongo approuvé automatiquement'
          }
        }
      });

      // Récupérer le tweet avec l'auteur
      const tweetWithAuthor = await Tweet.findByPk(tweet.id, {
        include: [{
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium']
        }]
      });

      logger.info(`✅ Tweet créé avec succès: ${tweet.id}`);
      
      // 🎯 AJOUT À LA TWEET QUEUE: Ajouter le tweet de PolicierCongo à la queue de traitement
      try {
        const TweetQueueService = require('../tweetQueueService');
        const tweetQueueService = new TweetQueueService();
        
        // Seulement pour les tweets originaux (pas de réponses)
        if (!tweetData.parent_tweet_id) {
          logger.info(`📥 Ajout du tweet PolicierCongo ${tweet.id} à la queue de traitement`);
          await tweetQueueService.addTweetToQueue(tweet.id, POLICE_ACCOUNT_ID);
          
          // Approuver directement le tweet de PolicierCongo dans la queue
          await tweetQueueService.approveTweetFromQueue(tweet.id, {
            moderation_status: 'approved',
            reason: 'Tweet PolicierCongo approuvé automatiquement',
            source: 'policiercongo_automation'
          });
          
          logger.info(`✅ Tweet PolicierCongo ${tweet.id} ajouté et approuvé dans la queue`);
        } else {
          logger.info(`💬 Tweet PolicierCongo ${tweet.id} est une réponse - non ajouté à la queue`);
        }
        
      } catch (queueError) {
        logger.error(`❌ Erreur lors de l'ajout du tweet PolicierCongo ${tweet.id} à la queue:`, queueError);
        // Ne pas faire échouer la création du tweet pour cette erreur
      }

      // 🧠 AJOUT AU MOTEUR DE RECOMMANDATION / SIMILARITÉ ET RETARGETING
      try {
        const similarity = require('../similarity');
        let retargetingHook = null;
        try {
          retargetingHook = require('../retargetingHook');
        } catch(e) { /* ignore if not available */ }
        
        const engine = similarity.getEngine();
        
        let mediaArray = [];
        if (tweetWithAuthor.media_urls) {
          try { mediaArray = typeof tweetWithAuthor.media_urls === 'string' ? JSON.parse(tweetWithAuthor.media_urls) : tweetWithAuthor.media_urls; } catch (e) {}
        }

        if (tweetData.parent_tweet_id) {
          // C'est une réponse
          if (retargetingHook) {
            retargetingHook.trackComment({
              userId: String(POLICE_ACCOUNT_ID),
              tweetId: String(tweetData.parent_tweet_id),
              tweetContent: tweet.content || '',
              authorUsername: '',
              mediaUrls: Array.isArray(mediaArray) ? mediaArray : []
            });
          }
          if (engine) engine.onInteraction(String(POLICE_ACCOUNT_ID), String(tweetData.parent_tweet_id), 'comment', tweet.content || '');
          logger.info(`🧠 Interaction (réponse) PolicierCongo sur ${tweetData.parent_tweet_id} poussée dans l'algo`);
        } else {
          // C'est un tweet original
          if (retargetingHook) {
            retargetingHook.trackPost({
              userId: String(POLICE_ACCOUNT_ID),
              tweetId: String(tweet.id),
              tweetContent: tweet.content || '',
              mediaUrls: Array.isArray(mediaArray) ? mediaArray : []
            });
          }
          if (engine) {
            // Attendre init max 3s
            let attempts = 0;
            while (!engine._initialized && attempts < 6) {
              await new Promise(r => setTimeout(r, 500));
              attempts++;
            }
            if (engine._initialized && typeof engine.onNewTweet === 'function') {
              engine.onNewTweet(
                String(tweet.id),
                String(POLICE_ACCOUNT_ID),
                tweet.content || '',
                Array.isArray(mediaArray) ? mediaArray : [],
                tweet.parent_tweet_id
              );
              logger.info(`🧠 Tweet original PolicierCongo ${tweet.id} poussé dans le moteur de similarité/recommandation ✅`);
            }
          }
        }
      } catch (simError) {
        logger.error(`❌ Erreur lors de l'ajout du tweet au moteur de similarité:`, simError);
      }

      
      return {
        success: true,
        tweet: tweetWithAuthor,
        metadata: metadata
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la création du tweet:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Crée un tweet de réponse
   */
  async createReplyTweet(replyData) {
    try {
      logger.info('💬 Création d\'un tweet de réponse...');
      
      // Validation spécifique aux réponses
      if (!replyData.parent_tweet_id) {
        throw new Error('Le parent_tweet_id est requis pour une réponse');
      }

      if (!this._isValidUUID(replyData.parent_tweet_id)) {
        logger.warn(`⚠️ ID de tweet parent invalide (non-UUID): ${replyData.parent_tweet_id}. Annulation de la réponse.`);
        return { success: false, error: 'ID de tweet parent invalide' };
      }

      // Créer la réponse
      const replyTweet = await Tweet.create({
        content: replyData.content,
        user_id: POLICE_ACCOUNT_ID,
        parent_tweet_id: replyData.parent_tweet_id,
        is_private: false,
        is_sensitive: false,
        language: 'fr',
        moderation_status: 'approved',
        metadata: {
          ...DEFAULT_METADATA,
          source: 'policiercongo_response',
          target_user: replyData.target_user,
          reason: replyData.reason,
          priority: replyData.priority,
          generated_at: new Date().toISOString(),
          auto_generated: replyData.auto_generated || false,
          response_context: replyData.response_context,
          comment_content: replyData.comment_content
        }
      });

      logger.info(`✅ Réponse créée avec succès: ${replyTweet.id}`);
      
      // Récupérer la réponse avec l'auteur pour la similarité
      const replyWithAuthor = await Tweet.findByPk(replyTweet.id, {
        include: [{
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium']
        }]
      });

      // 🧠 AJOUT AU MOTEUR DE RECOMMANDATION / SIMILARITÉ
      try {
        const similarity = require('../similarity');
        let retargetingHook = null;
        try {
          retargetingHook = require('../retargetingHook');
        } catch(e) { }

        const engine = similarity.getEngine();
        
        if (retargetingHook) {
          retargetingHook.trackComment({
            userId: String(POLICE_ACCOUNT_ID),
            tweetId: String(replyData.parent_tweet_id),
            tweetContent: replyTweet.content || '',
            authorUsername: '',
            mediaUrls: []
          });
        }

        if (engine && typeof engine.onInteraction === 'function') {
          engine.onInteraction(
            String(replyTweet.user_id),
            String(replyTweet.parent_tweet_id),
            'comment',
            replyTweet.content || ''
          );
          logger.info(`🧠 Réponse PolicierCongo poussée dans le moteur de similarité`);
        }
      } catch (simError) {
        logger.error(`❌ Erreur lors de l'ajout de la réponse au moteur de similarité:`, simError);
      }

      return {
        success: true,
        reply_tweet: replyTweet,
        parent_tweet_id: replyData.parent_tweet_id
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la création de la réponse:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Met à jour un tweet existant
   */
  async updateTweet(tweetId, updateData) {
    try {
      logger.info(`📝 Mise à jour du tweet: ${tweetId}`);
      
      if (!this._isValidUUID(tweetId)) {
        logger.warn(`⚠️ ID de tweet invalide (non-UUID) pour mise à jour: ${tweetId}`);
        return { success: false, error: 'ID de tweet invalide' };
      }

      // Vérifier que le tweet existe et appartient à PolicierCongo
      const tweet = await Tweet.findOne({
        where: {
          id: tweetId,
          user_id: POLICE_ACCOUNT_ID
        }
      });

      if (!tweet) {
        throw new Error('Tweet non trouvé ou non autorisé');
      }

      // Validation des données de mise à jour
      if (updateData.content && updateData.content.length > LIMITS.maxTweetLength) {
        throw new Error(`Le contenu ne peut pas dépasser ${LIMITS.maxTweetLength} caractères`);
      }

      // Mettre à jour le tweet
      await tweet.update(updateData);

      // Récupérer le tweet mis à jour
      const updatedTweet = await Tweet.findByPk(tweetId, {
        include: [{
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium']
        }]
      });

      logger.info(`✅ Tweet mis à jour avec succès: ${tweetId}`);
      
      return {
        success: true,
        tweet: updatedTweet
      };

    } catch (error) {
      logger.error(`❌ Erreur lors de la mise à jour du tweet ${tweetId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Supprime un tweet (EXTRÊME URGENCE SEULEMENT)
   */
  async deleteTweet(tweetId, deleteReason) {
    try {
      logger.warn(`🚨🚨🚨 SUPPRESSION D'URGENCE DU TWEET: ${tweetId}`);
      
      if (!this._isValidUUID(tweetId)) {
        logger.warn(`⚠️ ID de tweet invalide (non-UUID) pour suppression: ${tweetId}`);
        return { success: false, error: 'ID de tweet invalide' };
      }

      // Vérifier que le tweet existe et appartient à PolicierCongo
      const tweet = await Tweet.findOne({
        where: {
          id: tweetId,
          user_id: POLICE_ACCOUNT_ID
        }
      });

      if (!tweet) {
        throw new Error('Tweet non trouvé ou non autorisé');
      }

      // Validation stricte des conditions d'urgence
      if (!deleteReason || !deleteReason.emergency_level || deleteReason.emergency_level !== 'critical') {
        throw new Error('Suppression non autorisée - Niveau d\'urgence insuffisant');
      }

      if (!deleteReason.legal_justification || !deleteReason.delete_reason) {
        throw new Error('Suppression non autorisée - Justification légale manquante');
      }

      // Vérifier que la raison est valide
      const validReasons = ['illégal', 'dangereux', 'menaçant', 'sécurité publique', 'urgence'];
      const hasValidReason = validReasons.some(reason => 
        deleteReason.delete_reason.toLowerCase().includes(reason) || 
        deleteReason.legal_justification.toLowerCase().includes(reason)
      );

      if (!hasValidReason) {
        throw new Error('Suppression non autorisée - Raison invalide');
      }

      // LOG D'URGENCE
      logger.warn(`🚨🚨🚨 SUPPRESSION D'URGENCE AUTORISÉE - Tweet ${tweetId}`);
      logger.warn(`🚨 Raison: ${deleteReason.delete_reason}`);
      logger.warn(`🚨 Justification légale: ${deleteReason.legal_justification}`);
      logger.warn(`🚨 Niveau d'urgence: ${deleteReason.emergency_level}`);
      logger.warn(`🚨 Contenu du tweet: ${tweet.content.substring(0, 280)}...`);

      // Supprimer le tweet
      await tweet.destroy();

      logger.warn(`🚨🚨🚨 TWEET ${tweetId} SUPPRIMÉ D'URGENCE AVEC SUCCÈS`);
      
      return {
        success: true,
        deleted_tweet_id: tweetId,
        emergency_level: deleteReason.emergency_level,
        legal_justification: deleteReason.legal_justification,
        reason: deleteReason.delete_reason
      };

    } catch (error) {
      logger.error(`❌❌❌ Erreur lors de la suppression d'urgence du tweet ${tweetId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Récupère un tweet avec ses métadonnées
   */
  async getTweet(tweetId) {
    try {
      if (!this._isValidUUID(tweetId)) {
        return { success: false, error: 'ID de tweet invalide' };
      }
      const tweet = await Tweet.findByPk(tweetId, {
        include: [
          { model: User, as: 'author', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium'] },
          { model: Tweet, as: 'parentTweet', include: [{ model: User, as: 'author', attributes: ['username'] }] },
          { model: Tweet, as: 'replies', include: [{ model: User, as: 'author', attributes: ['username'] }] }
        ]
      });

      if (!tweet) {
        return { success: false, error: 'Tweet non trouvé' };
      }

      return {
        success: true,
        tweet: tweet
      };

    } catch (error) {
      logger.error(`❌ Erreur lors de la récupération du tweet ${tweetId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Récupère les tweets d'un utilisateur
   */
  async getUserTweets(userId, options = {}) {
    try {
      const {
        limit = 20,
        offset = 0,
        includeReplies = true,
        includeRetweets = true
      } = options;

      const whereClause = { user_id: userId };

      if (!includeReplies) {
        whereClause.parent_tweet_id = null;
      }

      if (!includeRetweets) {
        whereClause.is_retweet = false;
      }

      const tweets = await Tweet.findAll({
        where: whereClause,
        include: [{
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium']
        }],
        order: [['created_at', 'DESC']],
        limit,
        offset
      });

      return {
        success: true,
        tweets: tweets,
        total: tweets.length
      };

    } catch (error) {
      logger.error(`❌ Erreur lors de la récupération des tweets de l'utilisateur ${userId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Récupère les réponses à un tweet
   */
  async getTweetReplies(tweetId, options = {}) {
    try {
      const {
        limit = 20,
        offset = 0
      } = options;

      const replies = await Tweet.findAll({
        where: { parent_tweet_id: tweetId },
        include: [{
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style', 'premium']
        }],
        order: [['created_at', 'DESC']],
        limit,
        offset
      });

      return {
        success: true,
        replies: replies,
        total: replies.length
      };

    } catch (error) {
      logger.error(`❌ Erreur lors de la récupération des réponses au tweet ${tweetId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Génère un tweet par défaut
   */
  generateDefaultTweet() {
    const defaultTweets = [
      "Bonjour la communauté ! 👋 Restez vigilants et entraidez-vous ! 💪",
      "Conseil du jour : Verrouillez vos portes la nuit ! 🔒",
      "Salut ! 😄 Questions sur la sécurité ? Je suis là ! 🚔",
      "En cas d'urgence : 112. Restez calmes ! 🚨",
      "Bonjour ! 🌟 Comment va votre journée ? 🤝"
    ];
    
    const randomIndex = Math.floor(Math.random() * defaultTweets.length);
    return defaultTweets[randomIndex];
  }

  /**
   * Vérifie si un utilisateur peut répondre à un tweet
   */
  async canReplyToTweet(tweetId, userId) {
    try {
      if (!this._isValidUUID(tweetId)) {
        return { canReply: false, reason: 'ID de tweet invalide' };
      }
      const tweet = await Tweet.findByPk(tweetId);
      
      if (!tweet) {
        return { canReply: false, reason: 'Tweet non trouvé' };
      }

      // Vérifier si l'utilisateur peut répondre au tweet
      if (tweet.is_private && tweet.user_id !== userId) {
        return { canReply: false, reason: 'Tweet privé' };
      }

      // Vérifier si l'utilisateur a déjà répondu
      const existingReply = await Tweet.findOne({
        where: {
          parent_tweet_id: tweetId,
          user_id: userId
        }
      });

      if (existingReply) {
        return { canReply: false, reason: 'Déjà répondu' };
      }

      return { canReply: true };

    } catch (error) {
      logger.error(`❌ Erreur lors de la vérification de la possibilité de réponse au tweet ${tweetId}:`, error);
      return { canReply: false, reason: 'Erreur système' };
    }
  }

  /**
   * Compte les tweets d'un utilisateur
   */
  async countUserTweets(userId) {
    try {
      const count = await Tweet.count({
        where: { user_id: userId }
      });

      return {
        success: true,
        count: count
      };

    } catch (error) {
      logger.error(`❌ Erreur lors du comptage des tweets de l'utilisateur ${userId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Like un tweet
   */
  async likeTweet(tweetId, userId = POLICE_ACCOUNT_ID) {
    try {
      if (!this._isValidUUID(tweetId)) {
        return { success: false, error: 'ID de tweet invalide' };
      }

      const existing = await TweetLike.findOne({
        where: { tweet_id: tweetId, user_id: userId }
      });

      if (existing) {
        return { success: true, message: 'Déjà liké', like: existing };
      }

      const like = await TweetLike.create({
        tweet_id: tweetId,
        user_id: userId,
        like_type: 'like'
      });

      // Track interaction for recommendation engine
      try {
        const similarity = require('../similarity');
        const engine = similarity.getEngine();
        if (engine && typeof engine.onInteraction === 'function') {
          engine.onInteraction(String(userId), String(tweetId), 'like');
        }
      } catch (e) {
        logger.warn('⚠️ Erreur tracking like pour algo:', e.message);
      }

      logger.info(`✅ Tweet ${tweetId} liké par ${userId}`);
      return { success: true, like };

    } catch (error) {
      logger.error(`❌ Erreur lors du like du tweet ${tweetId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Repost (Retweet) un tweet
   */
  async retweetTweet(tweetId, userId = POLICE_ACCOUNT_ID) {
    try {
      if (!this._isValidUUID(tweetId)) {
        return { success: false, error: 'ID de tweet invalide' };
      }

      const existing = await TweetRetweet.findOne({
        where: { tweet_id: tweetId, user_id: userId }
      });

      if (existing) {
        return { success: true, message: 'Déjà reposté', retweet: existing };
      }

      // 1. Créer le retweet technique
      const retweet = await TweetRetweet.create({
        tweet_id: tweetId,
        user_id: userId
      });

      // 2. Créer le tweet de type 'retweet' pour l'affichage dans le feed
      const originalTweet = await Tweet.findByPk(tweetId);
      if (!originalTweet) throw new Error('Tweet original introuvable');

      const retweetDisplay = await Tweet.create({
        content: originalTweet.content,
        user_id: userId,
        original_tweet_id: originalTweet.id,
        tweet_type: 'retweet',
        is_retweet: true,
        moderation_status: 'approved',
        metadata: {
          ...DEFAULT_METADATA,
          source: 'policiercongo_retweet',
          original_author_id: originalTweet.user_id
        }
      });

      // Track interaction
      try {
        const similarity = require('../similarity');
        const engine = similarity.getEngine();
        if (engine && typeof engine.onInteraction === 'function') {
          engine.onInteraction(String(userId), String(tweetId), 'retweet');
        }
      } catch (e) {
        logger.warn('⚠️ Erreur tracking retweet pour algo:', e.message);
      }

      logger.info(`✅ Tweet ${tweetId} reposté par ${userId}`);
      return { success: true, retweet, retweetDisplay };

    } catch (error) {
      logger.error(`❌ Erreur lors du retweet du tweet ${tweetId}:`, error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = TweetManager;
