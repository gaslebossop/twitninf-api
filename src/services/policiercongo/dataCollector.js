/**
 * 📊 Collecteur de Données PolicierCongo
 * 
 * Collecte et analyse toutes les données nécessaires pour l'automatisation
 */

const logger = require('../../utils/logger');
const { Tweet, User, TweetLike, TweetRetweet, ModerationAction } = require('../../models');
const { POLICE_ACCOUNT_ID, URGENCY_LEVELS, LIMITS } = require('./config');

class DataCollector {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialise le collecteur de données
   */
  async initialize() {
    try {
      logger.info('📊 Initialisation du collecteur de données...');
      
      // Vérifier la connexion à la base de données
      await this._testConnection();
      
      this.initialized = true;
      logger.info('✅ Collecteur de données initialisé');
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation du collecteur:', error);
      throw error;
    }
  }

  /**
   * Teste la connexion à la base de données
   */
  async _testConnection() {
    try {
      const tweetCount = await Tweet.count();
      logger.info(`📊 Connexion DB OK - ${tweetCount} tweets trouvés`);
    } catch (error) {
      throw new Error(`Impossible de se connecter à la base de données: ${error.message}`);
    }
  }

  /**
   * Collecte toutes les données récentes pour l'analyse
   */
  async collectRecentData() {
    try {
      if (!this.initialized) {
        throw new Error('Collecteur de données non initialisé');
      }

      logger.info('📊 Collecte des données récentes...');
      const Op = require('sequelize').Op;
      const { fn, col } = require('sequelize');
      const pickTweetDate = (tweet) => tweet?.created_at || tweet?.createdAt || tweet?.timestamp || null;

      // Utilitaire heure Paris (UTC+2) — corrige le décalage serveur UTC
      const fmtParis = (dateVal, opts = {}) => {
        try {
          const d = new Date(dateVal || Date.now());
          if (isNaN(d.getTime())) return '?';
          return new Intl.DateTimeFormat('fr-FR', {
            timeZone: 'Europe/Paris',
            hour: '2-digit', minute: '2-digit',
            ...opts
          }).format(d);
        } catch (_) { return '?'; }
      };
      const agoLabel = (dateVal) => {
        const ms = Date.now() - new Date(dateVal || 0).getTime();
        const min = Math.round(ms / 60000);
        return min < 60 ? `il y a ${min}min` : `il y a ${Math.round(min / 60)}h`;
      };
      
      // Récupérer les tweets récents de PolicierCongo (7 derniers jours)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      
      const recentTweets = await Tweet.findAll({
        where: {
          user_id: POLICE_ACCOUNT_ID,
          created_at: { [Op.gte]: sevenDaysAgo }
        },
        include: [
          { model: TweetLike, as: 'likes' },
          { model: TweetRetweet, as: 'retweets' }
        ],
        order: [['created_at', 'DESC']],
        limit: 50
      });

      // Analyser les réponses et interactions
      const replies = await Tweet.findAll({
        where: {
          parent_tweet_id: { [Op.in]: recentTweets.map(t => t.id) },
          user_id: { [Op.ne]: POLICE_ACCOUNT_ID }
        },
        include: [{ model: User, as: 'author', attributes: ['username', 'verified'] }],
        order: [['created_at', 'DESC']],
        limit: 100
      });

      // Détecter les commentaires non répondu
      let unrepliedComments = await this.detectUnrepliedCommentsFromDB();
      try {
        const { memoryManager } = require('./index');
        const repliedIds = memoryManager.getRepliedCommentIds?.() || [];
        if (Array.isArray(unrepliedComments) && repliedIds.length > 0) {
          const before = unrepliedComments.length;
          unrepliedComments = unrepliedComments.filter(c => !repliedIds.includes(c.id));
          const after = unrepliedComments.length;
          if (before !== after) {
            logger.info(`🧠 Filtre mémoire: ${before - after} commentaire(s) retiré(s) (déjà répondu)`);
          }
        }
      } catch (_) {}

      // Récupérer le profil actuel
      const currentProfile = await User.findByPk(POLICE_ACCOUNT_ID, {
        attributes: ['username', 'full_name', 'updated_at', 'is_suspended', 'suspension_reason', 'suspended_until', 'moderation_history']
      });

      // 🛡️ INFOS DE MODÉRATION DU COMPTE POLICIER CONGO
      let selfModeration = { is_suspended: false, shadowbanned: false, reason: null, history: [] };
      try {
        const recentActions = await ModerationAction.findAll({
          where: {
            target_id: POLICE_ACCOUNT_ID,
            target_type: 'user'
          },
          order: [['created_at', 'DESC']],
          limit: 5
        });

        selfModeration = {
          is_suspended: currentProfile?.is_suspended || false,
          shadowbanned: false,
          reason: currentProfile?.suspension_reason || null,
          suspended_until: currentProfile?.suspended_until,
          history: recentActions.map(a => ({
            type: a.type,
            reason: a.reason,
            date: a.created_at,
            status: a.status
          }))
        };

        // Détection Shadowban via Smart Engine
        try {
          const { recommendationEngine } = require('./index');
          if (recommendationEngine) {
            const sb = await recommendationEngine.checkShadowbanStatus(POLICE_ACCOUNT_ID);
            if (sb && sb.isShadowbanned) {
              selfModeration.shadowbanned = true;
              selfModeration.reason = selfModeration.reason || sb.reason;
              logger.warn(`🛡️ Shadowban détecté pour PolicierCongo: ${sb.reason}`);
            }
          }
        } catch (sbErr) {
          logger.warn('⚠️ Erreur détection shadowban self:', sbErr.message);
        }

        logger.info(`🛡️ Infos modération self collectées: ${selfModeration.is_suspended ? 'SUSPENDU' : (selfModeration.shadowbanned ? 'SHADOWBANNED' : 'ACTIF')}`);
      } catch (e) {
        logger.warn('⚠️ Erreur collecte infos modération self:', e?.message);
      }

      // ═══ NOUVELLES DONNÉES ENRICHIES ═══

      // 📈 TENDANCES TWITNINF — Top hashtags et sujets des dernières 24h
      let trendingTopics = [];
      try {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const trendingTweets = await Tweet.findAll({
          where: {
            created_at: { [Op.gte]: oneDayAgo },
            parent_tweet_id: null,
            content: { [Op.ne]: null }
          },
          include: [
            { model: TweetLike, as: 'likes' },
            { model: TweetRetweet, as: 'retweets' }
          ],
          order: [['created_at', 'DESC']],
          limit: 200
        });

        // Extraire les hashtags et mots fréquents
        const hashtagCount = {};
        const topicCount = {};
        for (const t of trendingTweets) {
          const content = t.content || '';
          const hashtags = content.match(/#[\w\u00C0-\u024F]+/g) || [];
          hashtags.forEach(h => { hashtagCount[h.toLowerCase()] = (hashtagCount[h.toLowerCase()] || 0) + 1; });
          // Mots-clés importants (>4 chars, pas de mots communs)
          const words = content.toLowerCase().split(/\s+/).filter(w => w.length > 4 && !['dans', 'avec', 'pour', 'cette', 'c\'est', 'aussi', 'tout', 'mais', 'très', 'plus', 'comme', 'votre', 'notre'].includes(w));
          words.forEach(w => { topicCount[w] = (topicCount[w] || 0) + 1; });
        }

        // Top 10 hashtags
        const topHashtags = Object.entries(hashtagCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([h, c]) => `${h}(${c})`);
        // Top 5 sujets chauds
        const topTopics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${t}(${c})`);

        trendingTopics = { hashtags: topHashtags, sujets: topTopics, totalTweetsAnalyses: trendingTweets.length };
        logger.info(`📈 Tendances TwitNinf: ${topHashtags.length} hashtags, ${topTopics.length} sujets`);
      } catch (e) {
        logger.warn('⚠️ Erreur collecte tendances:', e?.message);
      }

      // Tweets déjà likés par PolicierCongo — à exclure des candidats "à liker/reposter"
      // pour ne pas qu'il retombe indéfiniment sur les mêmes (constaté en prod 21/07/2026).
      let alreadyLikedTweetIds = [];
      try {
        const ownLikes = await TweetLike.findAll({
          where: { user_id: POLICE_ACCOUNT_ID },
          attributes: ['tweet_id'],
          limit: 500,
          order: [['created_at', 'DESC']]
        });
        alreadyLikedTweetIds = ownLikes.map(l => l.tweet_id);
      } catch (_) { }

      // 🌐 DERNIERS TWEETS DE TOUTE LA PLATEFORME (contexte temps réel)
      let recentPlatformTweets = [];
      try {
        let processedPlatformTweetIds = [];
        try {
          const { memoryManager } = require('./index');
          processedPlatformTweetIds = memoryManager.getProcessedPlatformTweetIds?.() || [];
        } catch (_) { }

        const excludedIds = [...new Set([...processedPlatformTweetIds.slice(-250), ...alreadyLikedTweetIds])];

        const platformTweets = await Tweet.findAll({
          where: {
            user_id: { [Op.ne]: POLICE_ACCOUNT_ID },
            parent_tweet_id: null,
            content: { [Op.ne]: null },
            moderation_status: 'approved',
            ...(excludedIds.length > 0 ? { id: { [Op.notIn]: excludedIds } } : {})
          },
          include: [{ model: User, as: 'author', attributes: ['username', 'is_suspended'], where: { is_suspended: false } }],
          order: [['created_at', 'DESC']],
          limit: 25
        });

        recentPlatformTweets = platformTweets.map(t => ({
          id: t.id,
          author: t.author?.username,
          content: t.content,
          // Heure Paris (UTC+2) pour que le bot sache si le tweet est récent ou vieux
          heure_paris: fmtParis(t.created_at),
          ago: agoLabel(t.created_at)
        }));
        logger.info(`🌐 ${recentPlatformTweets.length} tweets récents de la plateforme collectés`);
      } catch (e) {
        logger.warn('⚠️ Erreur collecte tweets récents plateforme:', e?.message);
      }

      // 👥 DERNIERS TWEETS POPULAIRES DES UTILISATEURS (contexte pour PolicierCongo)
      let userTrendingTweets = [];
      try {
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const popularTweets = await Tweet.findAll({
          where: {
            user_id: { [Op.ne]: POLICE_ACCOUNT_ID },
            created_at: { [Op.gte]: sixHoursAgo },
            parent_tweet_id: null,
            content: { [Op.ne]: null },
            moderation_status: 'approved',
            ...(alreadyLikedTweetIds.length > 0 ? { id: { [Op.notIn]: alreadyLikedTweetIds } } : {})
          },
          include: [
            { model: User, as: 'author', attributes: ['username', 'is_suspended'], where: { is_suspended: false } },
            { model: TweetLike, as: 'likes' },
            { model: TweetRetweet, as: 'retweets' }
          ],
          order: [['created_at', 'DESC']],
          limit: 30
        });

        // Trier par engagement et prendre les 10 meilleurs (longueur > 30 chars pour le style)
        userTrendingTweets = popularTweets
          .filter(t => (t.content || '').length > 30)
          .map(t => ({
            id: t.id,
            author: t.author?.username,
            content: t.content,
            likes: t.likes?.length || 0,
            rts: t.retweets?.length || 0,
            // Heure Paris (UTC+2) + depuis combien de temps
            heure_paris: fmtParis(t.created_at),
            ago: agoLabel(t.created_at),
            // Garder created_at pour que le bridge calcule le décalage aussi
            created_at: t.created_at
          }))
          .sort((a, b) => (b.likes + b.rts) - (a.likes + a.rts))
          .slice(0, 10);
        logger.info(`👥 ${userTrendingTweets.length} tweets populaires (style inspiration) collectés`);
      } catch (e) {
        logger.warn('⚠️ Erreur collecte tweets utilisateurs:', e?.message);
      }

      // 💔 SENTIMENT COMMUNAUTAIRE — La commu aime-t-elle PolicierCongo ?
      let communitySentiment = { score: 0, mood: 'neutre', details: '' };
      try {
        // Compter les followers
        const UserFollow = require('../../models/UserFollow');
        const followersCount = await UserFollow.count({ where: { following_id: POLICE_ACCOUNT_ID, status: 'active' } });
        
        // Calculer engagement moyen sur les derniers tweets
        const engagementTotal = recentTweets.reduce((sum, t) => sum + (t.likes?.length || 0) + (t.retweets?.length || 0), 0);
        const avgEngagement = engagementTotal / Math.max(recentTweets.filter(t => !t.parent_tweet_id).length, 1);
        
        // Analyser le ton des commentaires récents (mots négatifs vs positifs)
        let positiveWords = 0, negativeWords = 0;
        const positiveKeywords = ['merci', 'bravo', 'super', 'bien', 'top', 'genial', 'force', 'continue', 'j\'aime', 'cool', 'respect', 'excellent', 'parfait', 'love', '❤️', '🔥', '💪', '👏', '🙏'];
        const negativeKeywords = ['nul', 'pourri', 'stop', 'arrête', 'degage', 'chiant', 'merde', 'ennuyant', 'bot', 'spam', 'fake', 'inutile', 'honte', 'ridicule', 'pire', '💩', '🤮', '👎', 'suicide', 'creve'];
        
        for (const reply of replies) {
          const c = (reply.content || '').toLowerCase();
          positiveKeywords.forEach(k => { if (c.includes(k)) positiveWords++; });
          negativeKeywords.forEach(k => { if (c.includes(k)) negativeWords++; });
        }
        
        const totalSentimentWords = positiveWords + negativeWords;
        let sentimentScore = 50; // neutre par défaut
        if (totalSentimentWords > 0) {
          sentimentScore = Math.round((positiveWords / totalSentimentWords) * 100);
        }
        
        let mood = 'neutre';
        if (sentimentScore >= 75) mood = 'adore';
        else if (sentimentScore >= 55) mood = 'positif';
        else if (sentimentScore >= 40) mood = 'mitige';
        else if (sentimentScore >= 20) mood = 'negatif';
        else mood = 'hostile';
        
        communitySentiment = {
          score: sentimentScore,
          mood,
          followers: followersCount,
          avgEngagement: Math.round(avgEngagement * 10) / 10,
          positiveWords,
          negativeWords,
          details: `${positiveWords} positifs / ${negativeWords} négatifs sur ${replies.length} commentaires`
        };
        
        logger.info(`💔 Sentiment commu: ${mood} (${sentimentScore}%) - ${followersCount} followers`);
      } catch (e) {
        logger.warn('⚠️ Erreur analyse sentiment:', e?.message);
      }

      // Calculer l'engagement global
      const totalEngagement = recentTweets.reduce((sum, tweet) => {
        const likes = tweet.likes?.length || 0;
        const retweets = tweet.retweets?.length || 0;
        return sum + likes + retweets;
      }, 0);

      const averageEngagement = totalEngagement / Math.max(recentTweets.length, 1);

      // Analyser les tweets principaux (pas les réponses)
      const mainTweets = recentTweets.filter(t => !t.parent_tweet_id);
      const replyTweets = recentTweets.filter(t => t.parent_tweet_id);
      
      // Calculer le temps écoulé depuis le dernier tweet principal
      const lastMainTweet = mainTweets[0];
      const lastMainTweetRawDate = pickTweetDate(lastMainTweet);
      const lastMainTweetDate = lastMainTweetRawDate ? new Date(lastMainTweetRawDate) : null;
      const isLastMainTweetDateValid = !!lastMainTweetDate && !Number.isNaN(lastMainTweetDate.getTime());
      const hoursSinceLastMainTweet = isLastMainTweetDateValid
        ? Math.floor((Date.now() - lastMainTweetDate.getTime()) / (1000 * 60 * 60))
        : 24;

      const collectedData = {
        // 🏷️ CONTEXTE APP
        appName: 'TwitNinf',
        botName: 'Policier Congo',
        recentPlatformTweets: recentPlatformTweets,
        
        // 📊 Tweets PolicierCongo (compact — max 10 pour le prompt)
        mainTweets: mainTweets.slice(0, 20).map(tweet => ({
          id: tweet.id,
          content: (tweet.content || '').substring(0, 280),
          created_at: pickTweetDate(tweet),
          likes: tweet.likes?.length || 0,
          rts: tweet.retweets?.length || 0
        })),
        replyTweets: replyTweets.slice(0, 5).map(tweet => ({
          content: (tweet.content || '').substring(0, 100),
          created_at: pickTweetDate(tweet)
        })),
        
        // 💬 Commentaires
        replies: replies.slice(0, 20).map(reply => ({
          id: reply.id,
          content: (reply.content || '').substring(0, 100),
          author: reply.author?.username,
          author_verified: reply.author?.verified,
          created_at: pickTweetDate(reply)
        })),
        unrepliedComments: unrepliedComments,
        
        // 👤 Profil
        currentProfile: {
          username: currentProfile?.username,
          full_name: currentProfile?.full_name,
          lastUpdated: currentProfile?.updated_at
        },
        
        // 📈 NOUVELLES DONNÉES
        trendingTopics,
        userTrendingTweets,
        communitySentiment,
        selfModeration,
        financialData: await this.collectFinancialData(),
        
        // 📊 Métriques (compact)
        engagementMetrics: {
          total: totalEngagement,
          average: Math.round(averageEngagement * 10) / 10,
          mainTweets: mainTweets.length,
          replies: replies.length,
          unreplied: unrepliedComments.length
        },
        timingAnalysis: {
          // Heure courante en Paris (UTC+2) — le bot sait exactement quelle heure il est
          currentTime: new Intl.DateTimeFormat('fr-FR', {
            timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short'
          }).format(new Date()) + ' (Paris UTC+2)',
          lastMainTweet: isLastMainTweetDateValid ? lastMainTweetRawDate : null,
          hoursSinceLastMainTweet,
          shouldPostMainTweet: true,
          daysSinceLastProfileUpdate: currentProfile ? 
            (Date.now() - new Date(currentProfile.updated_at).getTime()) / (1000 * 60 * 60 * 24) : 0
        }
      };

      logger.info('✅ Données collectées:', {
        mainTweets: collectedData.mainTweets.length,
        replies: collectedData.replies.length,
        unreplied: collectedData.unrepliedComments.length,
        trending: trendingTopics?.hashtags?.length || 0,
        userTweets: userTrendingTweets.length,
        sentiment: communitySentiment.mood
      });

      return collectedData;
    } catch (error) {
      logger.error('❌ Erreur lors de la collecte des données:', error);
      return null;
    }
  }

  /**
   * Détecte les commentaires non répondu sur les 3 derniers tweets de PolicierCongo
   */
  async detectUnrepliedCommentsFromDB() {
    try {
      logger.info('🔍 Détection des commentaires non répondu sur les 3 derniers tweets de PolicierCongo...');
      
      // Récupérer UNIQUEMENT les 3 derniers tweets de PolicierCongo
      const policeTweets = await Tweet.findAll({
        where: { 
          user_id: POLICE_ACCOUNT_ID,
          parent_tweet_id: null // Tweets principaux uniquement
        },
        order: [['created_at', 'DESC']],
        attributes: ['id', 'content', 'created_at'],
        limit: 3
      });

      if (policeTweets.length === 0) {
        logger.info('📝 Aucun tweet de PolicierCongo trouvé');
        return [];
      }

      logger.info(`📝 Analyse des ${policeTweets.length} derniers tweets de PolicierCongo`);

      // Récupérer tous les commentaires sur ces 3 tweets uniquement
      const allComments = await Tweet.findAll({
        where: {
          parent_tweet_id: { [require('sequelize').Op.in]: policeTweets.map(t => t.id) },
          user_id: { [require('sequelize').Op.ne]: POLICE_ACCOUNT_ID }
        },
        include: [
          { model: User, as: 'author', attributes: ['username', 'full_name', 'verified', 'is_suspended'], where: { is_suspended: false } }
        ],
        order: [['created_at', 'DESC']]
      });

      logger.info(`💬 ${allComments.length} commentaires trouvés sur les 3 derniers tweets`);

      // Filtrer les commentaires non répondu
      const unrepliedComments = [];
      for (const comment of allComments) {
        const hasReply = await Tweet.findOne({
          where: {
            parent_tweet_id: comment.id,
            user_id: POLICE_ACCOUNT_ID
          }
        });

        if (!hasReply) {
          const hoursAgo = Math.floor((new Date() - comment.created_at) / (1000 * 60 * 60));
          
          // IGNORER les commentaires de plus de 48h (2 jours)
          if (hoursAgo > 48) {
            continue;
          }

          const urgency = hoursAgo < 6 ? URGENCY_LEVELS.urgent : hoursAgo < 24 ? URGENCY_LEVELS.normal : URGENCY_LEVELS.old;
          
          unrepliedComments.push({
            id: comment.id,
            content: comment.content,
            author: comment.author.username,
            author_full_name: comment.author.full_name,
            author_verified: comment.author.verified,
            parent_tweet_id: comment.parent_tweet_id,
            created_at: comment.created_at,
            hours_ago: hoursAgo,
            urgency: urgency,
            priority: urgency === URGENCY_LEVELS.urgent ? 'high' : urgency === URGENCY_LEVELS.normal ? 'medium' : 'low'
          });
        }
      }

      // Trier par priorité (urgent d'abord)
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      unrepliedComments.sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);

      logger.info(`🔍 ${unrepliedComments.length} commentaires non répondu détectés sur les 3 derniers tweets`);
      return unrepliedComments;

    } catch (error) {
      logger.error('❌ Erreur lors de la détection des commentaires non répondu:', error);
      return [];
    }
  }

  /**
   * Détecte les commentaires non répondu (version legacy)
   */
  async detectUnrepliedComments(replies) {
    try {
      if (!replies || replies.length === 0) return [];
      
      const unreplied = [];
      
      for (const reply of replies) {
        // Vérifier si PolicierCongo a déjà répondu à ce commentaire
        const existingResponse = await Tweet.findOne({
          where: {
            parent_tweet_id: reply.id,
            user_id: POLICE_ACCOUNT_ID
          }
        });
        
        if (!existingResponse) {
          // Commentaire non répondu
          const hoursAgo = Math.floor((new Date() - new Date(reply.created_at)) / (1000 * 60 * 60));
          const urgency = hoursAgo < 6 ? URGENCY_LEVELS.urgent : hoursAgo < 24 ? URGENCY_LEVELS.normal : URGENCY_LEVELS.old;
          
          unreplied.push({
            id: reply.id,
            content: reply.content,
            author: reply.author?.username,
            created_at: reply.created_at,
            hours_ago: hoursAgo,
            urgency: urgency,
            priority: urgency === URGENCY_LEVELS.urgent ? 'high' : urgency === URGENCY_LEVELS.normal ? 'medium' : 'low'
          });
        }
      }
      
      // Trier par priorité (urgent > normal > old)
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      unreplied.sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);
      
      logger.info(`🔍 ${unreplied.length} commentaires non répondu détectés`);
      
      return unreplied;
    } catch (error) {
      logger.error('❌ Erreur lors de la détection des commentaires non répondu:', error);
      return [];
    }
  }

  /**
   * Collecte les statistiques complètes d'un utilisateur
   */
  async collectUserCompleteStats(userId) {
    try {
      // Récupérer le profil utilisateur
      const user = await User.findByPk(userId, {
        attributes: ['id', 'username', 'full_name', 'created_at']
      });

      if (!user) return {};

      // Compter les abonnés
      const followersCount = await require('../../models/UserFollow').count({
        where: { following_id: userId }
      });

      // Compter les abonnements
      const followingCount = await require('../../models/UserFollow').count({
        where: { follower_id: userId }
      });

      // Compter tous les tweets
      const totalTweets = await Tweet.count({
        where: { user_id: userId }
      });

      // Calculer l'engagement total (likes + retweets reçus)
      const userTweets = await Tweet.findAll({
        where: { user_id: userId },
        include: [
          { model: TweetLike, as: 'likes' },
          { model: TweetRetweet, as: 'retweets' }
        ]
      });

      const totalLikesReceived = userTweets.reduce((sum, tweet) => sum + (tweet.likes?.length || 0), 0);
      const totalRetweetsReceived = userTweets.reduce((sum, tweet) => sum + (tweet.retweets?.length || 0), 0);
      const averageEngagement = totalTweets > 0 ? (totalLikesReceived + totalRetweetsReceived) / totalTweets : 0;

      return {
        followersCount,
        followingCount,
        totalTweets,
        totalLikesReceived,
        totalRetweetsReceived,
        averageEngagement: Math.round(averageEngagement * 100) / 100
      };

    } catch (error) {
      logger.error('❌ Erreur lors de la collecte des statistiques utilisateur:', error);
      return {};
    }
  }

  /**
   * Collecte les réponses reçues par un utilisateur
   */
  async collectUserReplies(userId) {
    try {
      // Récupérer les tweets de l'utilisateur
      const userTweets = await Tweet.findAll({
        where: { user_id: userId },
        attributes: ['id'],
        limit: 20
      });

      if (userTweets.length === 0) return [];

      // Récupérer les réponses à ces tweets (dernières 24h)
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);

      const replies = await Tweet.findAll({
        where: {
          parent_tweet_id: { [require('sequelize').Op.in]: userTweets.map(t => t.id) },
          created_at: { [require('sequelize').Op.gte]: oneDayAgo },
          user_id: { [require('sequelize').Op.ne]: userId } // Pas ses propres réponses
        },
        include: [
          { model: User, as: 'author', attributes: ['username'] },
          { model: TweetLike, as: 'likes' }
        ],
        order: [['created_at', 'DESC']],
        limit: 10
      });

      return replies;

    } catch (error) {
      logger.error('❌ Erreur lors de la collecte des réponses utilisateur:', error);
      return [];
    }
  }

  /**
   * Détecte automatiquement les tweets de Congo qui méritent une réponse contextuelle
   */
  async detectCongoTweetsForResponse() {
    try {
      logger.info('🔍 Détection automatique des tweets Congo pour réponse contextuelle...');
      
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
          { model: User, as: 'author', attributes: ['username', 'full_name', 'created_at', 'is_suspended'], where: { is_suspended: false } },
          { model: TweetLike, as: 'likes' },
          { model: TweetRetweet, as: 'retweets' }
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
        .slice(0, LIMITS.maxRepliesPerCycle); // Maximum 3 réponses par cycle

      logger.info(`✅ ${sortedTweets.length} tweets sélectionnés pour réponse contextuelle`);
      
      return sortedTweets;

    } catch (error) {
      logger.error('❌ Erreur lors de la détection des tweets Congo:', error);
      return [];
    }
  }

  /**
   * Analyse un tweet pour déterminer s'il mérite une réponse contextuelle
   */
  async analyzeTweetForResponse(tweet) {
    try {
      // Vérifier si PolicierCongo a déjà répondu à ce tweet
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
      let relevanceScore = 5;
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

      // Score basé sur l'engagement
      const engagement = (tweet.likes?.length || 0) + (tweet.retweets?.length || 0);
      if (engagement > 5) relevanceScore += 2;
      else if (engagement > 2) relevanceScore += 1;

      // Score basé sur l'âge du tweet (plus récent = plus important)
      const tweetAge = Math.floor((new Date() - new Date(tweet.created_at)) / (1000 * 60 * 60));
      if (tweetAge < 2) relevanceScore += 3;
      else if (tweetAge < 6) relevanceScore += 2;
      else if (tweetAge < 12) relevanceScore += 1;

      // Score basé sur la longueur du tweet (plus long = plus détaillé)
      if (tweet.content.length > 100) relevanceScore += 1;

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
        reason = 'Tweet très pertinent avec mots-clés importants et engagement élevé';
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
        reason = 'Tweet peu pertinent pour une réponse contextuelle';
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
   * Détecte et enregistre automatiquement les interactions significatives
   * Inclut les dédicaces, demandes spéciales, et contextes importants
   */
  async detectAndRecordSignificantInteractions() {
    try {
      logger.info('🔍 Détection et enregistrement des interactions significatives...');
      
      // Récupérer les tweets récents (24h) pour analyse
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      
      const recentTweets = await Tweet.findAll({
        where: {
          user_id: { [require('sequelize').Op.ne]: POLICE_ACCOUNT_ID },
          created_at: { [require('sequelize').Op.gte]: oneDayAgo },
          parent_tweet_id: null,
          moderation_status: 'approved'
        },
        include: [
          { model: User, as: 'author', attributes: ['username', 'full_name', 'created_at'] },
          { model: TweetLike, as: 'likes' },
          { model: TweetRetweet, as: 'retweets' }
        ],
        order: [['created_at', 'DESC']],
        limit: 100
      });

      if (recentTweets.length === 0) {
        logger.info('ℹ️ Aucun tweet récent pour analyse d\'interactions');
        return [];
      }

      const { memoryManager } = require('./index');
      const interactions = [];

      for (const tweet of recentTweets) {
        const interaction = await this.analyzeTweetForSignificantInteraction(tweet);
        if (interaction.isSignificant) {
          // Enregistrer dans la mémoire
          await memoryManager.addSignificantInteraction({
            tweet_id: tweet.id,
            user_id: tweet.user_id,
            user_username: tweet.author?.username,
            user_full_name: tweet.author?.full_name,
            content: tweet.content,
            timestamp: tweet.created_at,
            type: interaction.type,
            importance: interaction.importance,
            context: interaction.context,
            user_request: interaction.userRequest,
            response_given: false,
            follow_up_needed: interaction.followUpNeeded
          });

          // Si c'est une demande de dédicace
          if (interaction.type === 'dedication_request') {
            await memoryManager.addDedicationRequest({
              tweet_id: tweet.id,
              user_id: tweet.user_id,
              user_username: tweet.author?.username,
              request_content: tweet.content,
              user_context: interaction.userContext,
              priority: interaction.importance,
              timestamp: tweet.created_at
            });
          }

          // Si c'est une demande spéciale
          if (interaction.type === 'special_request') {
            await memoryManager.addUserSpecialRequest({
              tweet_id: tweet.id,
              user_id: tweet.user_id,
              user_username: tweet.author?.username,
              request_details: tweet.content,
              user_context: interaction.userContext,
              category: interaction.category,
              urgency: interaction.urgency,
              priority: interaction.importance,
              timestamp: tweet.created_at
            });
          }

          interactions.push(interaction);
        }
      }

      // Fallback: si aucune interaction significative détectée, enregistrer tous les commentaires récents
      if (interactions.length === 0) {
        logger.info('ℹ️ Aucune interaction significative détectée. Fallback: enregistrement de tous les commentaires récents des tweets de PolicierCongo.');
        const recentComments = await this.getRecentCommentsOnPoliceTweets(24, 100);
        let recorded = 0;

        for (const comment of recentComments) {
          // Construire un objet de type tweet pour la même analyse
          const asTweet = {
            id: comment.id,
            content: comment.content || '',
            created_at: comment.created_at,
            user_id: comment.user_id,
            author: { username: comment.author, full_name: comment.author_full_name }
          };
          const analysis = await this.analyzeTweetForSignificantInteraction(asTweet);

          // Par défaut, considérer comme demande spéciale si non détecté
          const type = analysis.isSignificant ? analysis.type : 'special_request';
          const importance = analysis.isSignificant ? analysis.importance : (comment.hours_ago < 6 ? 'high' : 'medium');
          const urgency = comment.hours_ago < 2 ? 'urgent' : (comment.hours_ago < 6 ? 'high' : (comment.hours_ago < 24 ? 'normal' : 'low'));

          await memoryManager.addSignificantInteraction({
            tweet_id: comment.id,
            user_id: comment.user_id,
            user_username: comment.author,
            user_full_name: comment.author_full_name,
            content: comment.content,
            timestamp: comment.created_at,
            type,
            importance,
            context: analysis.context || {},
            user_request: analysis.userRequest || 'Interaction comment récente',
            response_given: !!comment.hasReply,
            follow_up_needed: !comment.hasReply
          });

          if (type === 'dedication_request') {
            await memoryManager.addDedicationRequest({
              tweet_id: comment.id,
              user_id: comment.user_id,
              user_username: comment.author,
              request_content: comment.content,
              user_context: analysis.userContext || {},
              priority: importance,
              timestamp: comment.created_at
            });
          } else {
            await memoryManager.addUserSpecialRequest({
              tweet_id: comment.id,
              user_id: comment.user_id,
              user_username: comment.author,
              request_details: comment.content,
              user_context: analysis.userContext || {},
              category: analysis.category || 'general',
              urgency,
              priority: importance,
              timestamp: comment.created_at,
              response_required: !comment.hasReply,
              follow_up_needed: !comment.hasReply
            });
          }

          recorded++;
        }

        logger.info(`✅ Fallback: ${recorded} commentaire(s) récents enregistrés comme demandes`);
      }

      logger.info(`✅ ${interactions.length} interactions significatives détectées et enregistrées`);
      return interactions;

    } catch (error) {
      logger.error('❌ Erreur lors de la détection des interactions significatives:', error);
      return [];
    }
  }

  /**
   * Analyse un tweet pour détecter s'il contient une interaction significative
   */
  async analyzeTweetForSignificantInteraction(tweet) {
    try {
      const content = tweet.content.toLowerCase();
      const username = tweet.author?.username || '';
      
      // Détecter les demandes de dédicaces
      const dedicationKeywords = [
        'dédicace', 'dedicace', 'pour moi', 'pour nous', 'fais moi', 'fais nous',
        'écris moi', 'ecris moi', 'tweet pour', 'message pour', 'mot pour',
        'pensée pour', 'pensee pour', 'salut spécial', 'salut special'
      ];

      // Détecter les demandes spéciales
      const specialRequestKeywords = [
        'conseil', 'aide', 'question', 'problème', 'probleme', 'inquiétude', 'inquietude',
        'peur', 'stress', 'sécurité', 'securite', 'danger', 'urgence', 'soutien',
        'solidarité', 'solidarite', 'protection', 'surveillance', 'patrouille'
      ];

      // Détecter les demandes de contenu personnalisé
      const personalizedContentKeywords = [
        'personnalisé', 'personnalise', 'spécial', 'special', 'unique', 'différent',
        'different', 'nouveau', 'nouvelle', 'créatif', 'creatif', 'original'
      ];

      let isSignificant = false;
      let type = 'general';
      let importance = 'medium';
      let context = {};
      let userRequest = '';
      let userContext = '';
      let category = 'general';
      let urgency = 'normal';
      let followUpNeeded = false;

      // Vérifier les demandes de dédicaces
      const hasDedicationRequest = dedicationKeywords.some(keyword => 
        content.includes(keyword)
      );

      if (hasDedicationRequest) {
        isSignificant = true;
        type = 'dedication_request';
        importance = 'high';
        context = { requestType: 'dedication', keywords: dedicationKeywords.filter(k => content.includes(k)) };
        userRequest = 'Demande de dédicace ou contenu personnalisé';
        userContext = this.extractUserContext(content, username);
        followUpNeeded = true;
      }

      // Vérifier les demandes spéciales
      const hasSpecialRequest = specialRequestKeywords.some(keyword => 
        content.includes(keyword)
      );

      if (hasSpecialRequest && !isSignificant) {
        isSignificant = true;
        type = 'special_request';
        importance = 'high';
        context = { requestType: 'special_help', keywords: specialRequestKeywords.filter(k => content.includes(k)) };
        userRequest = 'Demande d\'aide, conseil ou soutien spécial';
        userContext = this.extractUserContext(content, username);
        category = this.determineRequestCategory(content);
        urgency = this.determineUrgency(content, tweet.created_at);
        followUpNeeded = true;
      }

      // Vérifier les demandes de contenu personnalisé
      const hasPersonalizedRequest = personalizedContentKeywords.some(keyword => 
        content.includes(keyword)
      );

      if (hasPersonalizedRequest && !isSignificant) {
        isSignificant = true;
        type = 'personalized_content_request';
        importance = 'medium';
        context = { requestType: 'personalized_content', keywords: personalizedContentKeywords.filter(k => content.includes(k)) };
        userRequest = 'Demande de contenu personnalisé ou créatif';
        userContext = this.extractUserContext(content, username);
        followUpNeeded = true;
      }

      // Vérifier l'engagement et l'urgence
      if (isSignificant) {
        const engagement = (tweet.likes?.length || 0) + (tweet.retweets?.length || 0);
        if (engagement > 10) {
          importance = 'critical';
        } else if (engagement > 5) {
          importance = 'high';
        }

        // Vérifier l'urgence temporelle
        const tweetAge = Math.floor((new Date() - new Date(tweet.created_at)) / (1000 * 60 * 60));
        if (tweetAge < 2) {
          urgency = 'urgent';
          importance = Math.max(importance === 'critical' ? 3 : importance === 'high' ? 2 : 1, 2);
        }
      }

      return {
        isSignificant,
        type,
        importance,
        context,
        userRequest,
        userContext,
        category,
        urgency,
        followUpNeeded,
        tweet_id: tweet.id,
        user_id: tweet.user_id,
        username: username
      };

    } catch (error) {
      logger.error('❌ Erreur lors de l\'analyse d\'interaction significative:', error);
      return { isSignificant: false };
    }
  }

  /**
   * Extrait le contexte utilisateur d'un tweet
   */
  extractUserContext(content, username) {
    const context = {
      username: username,
      hasQuestion: content.includes('?'),
      hasUrgency: content.includes('urgence') || content.includes('urgent') || content.includes('maintenant'),
      hasEmotion: this.detectEmotion(content),
      hasLocation: this.detectLocation(content),
      hasTimeReference: this.detectTimeReference(content)
    };

    return context;
  }

  /**
   * Détecte l'émotion dans le contenu
   */
  detectEmotion(content) {
    const emotions = {
      happy: ['😊', '😄', '😃', '😁', '😆', 'joyeux', 'heureux', 'content', 'satisfait'],
      sad: ['😢', '😭', '😔', '😞', '😟', 'triste', 'malheureux', 'déprimé', 'deprime'],
      angry: ['😠', '😡', '😤', '😾', 'fâché', 'fache', 'en colère', 'en colere', 'frustré', 'frustre'],
      scared: ['😨', '😰', '😱', '😳', 'peur', 'effrayé', 'effraye', 'inquiet', 'stressé', 'stresse'],
      neutral: ['😐', '😑', '😶', 'neutre', 'normal', 'ok', 'bien']
    };

    for (const [emotion, indicators] of Object.entries(emotions)) {
      if (indicators.some(indicator => content.includes(indicator))) {
        return emotion;
      }
    }

    return 'neutral';
  }

  /**
   * Détecte les références de localisation
   */
  detectLocation(content) {
    const locations = [
      'kinshasa', 'lubumbashi', 'mbuji-mayi', 'kananga', 'kisangani',
      'quartier', 'rue', 'avenue', 'boulevard', 'zone', 'secteur',
      'rdc', 'congo', 'congolais'
    ];

    return locations.filter(location => content.includes(location));
  }

  /**
   * Détecte les références temporelles
   */
  detectTimeReference(content) {
    const timeRefs = [
      'maintenant', 'aujourd\'hui', 'aujourdhui', 'ce soir', 'cette nuit',
      'demain', 'hier', 'semaine', 'mois', 'année', 'annee'
    ];

    return timeRefs.filter(ref => content.includes(ref));
  }

  /**
   * Détermine la catégorie de la demande
   */
  determineRequestCategory(content) {
    if (content.includes('conseil') || content.includes('aide')) return 'advice';
    if (content.includes('sécurité') || content.includes('securite') || content.includes('protection')) return 'security';
    if (content.includes('urgence') || content.includes('danger')) return 'emergency';
    if (content.includes('soutien') || content.includes('solidarité') || content.includes('solidarite')) return 'support';
    if (content.includes('question') || content.includes('?')) return 'information';
    return 'general';
  }

  /**
   * Détermine l'urgence de la demande
   */
  determineUrgency(content, tweetDate) {
    const now = new Date();
    const tweetAge = Math.floor((now - new Date(tweetDate)) / (1000 * 60 * 60));
    
    // Urgence basée sur le contenu
    if (content.includes('urgence') || content.includes('urgent') || content.includes('maintenant')) {
      return 'urgent';
    }
    
    if (content.includes('danger') || content.includes('peur') || content.includes('stress')) {
      return 'high';
    }
    
    // Urgence basée sur le temps
    if (tweetAge < 2) return 'urgent';
    if (tweetAge < 6) return 'high';
    if (tweetAge < 24) return 'normal';
    
    return 'low';
  }

  /**
   * Récupère tous les commentaires récents (même s'il y a déjà une réponse) sur les derniers tweets de PolicierCongo
   */
  async getRecentCommentsOnPoliceTweets(sinceHours = 24, maxComments = 100, maxTweets = 5) {
    try {
      const sinceDate = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

      // Derniers tweets principaux de PolicierCongo
      const policeTweets = await Tweet.findAll({
        where: { user_id: POLICE_ACCOUNT_ID, parent_tweet_id: null },
        order: [['created_at', 'DESC']],
        attributes: ['id', 'content', 'created_at'],
        limit: maxTweets
      });

      if (policeTweets.length === 0) return [];

      // Tous les commentaires sur ces tweets depuis sinceDate (même si déjà répondu)
      const comments = await Tweet.findAll({
        where: {
          parent_tweet_id: { [require('sequelize').Op.in]: policeTweets.map(t => t.id) },
          created_at: { [require('sequelize').Op.gte]: sinceDate },
          user_id: { [require('sequelize').Op.ne]: POLICE_ACCOUNT_ID }
        },
        include: [
          { model: User, as: 'author', attributes: ['username', 'full_name'] }
        ],
        order: [['created_at', 'DESC']],
        limit: maxComments
      });

      // Enrichir avec informations utiles
      const results = [];
      for (const comment of comments) {
        // Savoir s'il y a déjà une réponse
        const reply = await Tweet.findOne({
          where: { parent_tweet_id: comment.id, user_id: POLICE_ACCOUNT_ID }
        });

        results.push({
          id: comment.id,
          content: comment.content,
          author: comment.author?.username,
          author_full_name: comment.author?.full_name,
          user_id: comment.user_id,
          parent_tweet_id: comment.parent_tweet_id,
          created_at: comment.created_at,
          hours_ago: Math.floor((new Date() - comment.created_at) / (1000 * 60 * 60)),
          hasReply: !!reply
        });
      }

      return results;
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des commentaires récents sur les tweets de PolicierCongo:', error);
      return [];
    }
  }
  /**
   * Collecte les données financières (portefeuille et monétisation)
   */
  async collectFinancialData() {
    try {
      const { UserWallet, VirtualCurrency, Transaction, User } = require('../../models');
      const { Op } = require('sequelize');
      const TweetMonetizationService = require('../tweetMonetizationService');

      // 1. Récupérer le portefeuille principal
      const wallets = await UserWallet.findAll({
        where: { userId: POLICE_ACCOUNT_ID },
        include: [{ model: VirtualCurrency, as: 'currency' }]
      });

      // 1bis. Dernières transactions (reçues ET envoyées), avec l'autre partie
      // identifiée — sans ça, le solde du wallet est un chiffre sans preuve de
      // qui l'a envoyé ni pourquoi (constaté : impossible de justifier un
      // paiement reçu sans ce détail).
      const recentTransactions = await Transaction.findAll({
        where: {
          [Op.or]: [{ fromUserId: POLICE_ACCOUNT_ID }, { toUserId: POLICE_ACCOUNT_ID }]
        },
        include: [
          { model: User, as: 'fromUser', attributes: ['id', 'username'] },
          { model: User, as: 'toUser', attributes: ['id', 'username'] },
          { model: VirtualCurrency, as: 'currency', attributes: ['symbol'] }
        ],
        order: [['createdAt', 'DESC']],
        limit: 20
      });

      // 2. Récompenses en attente, calculées en direct sur les vraies stats
      // d'engagement (vues/likes/RT/réponses) — la table MonetizationMetrics
      // n'est jamais alimentée par le vrai chemin de monétisation et ne
      // reflète donc rien : on réutilise ici le même calcul que le panneau
      // "Collecter mes gains" côté utilisateur pour rester cohérent.
      const preview = await TweetMonetizationService.previewEarnings(POLICE_ACCOUNT_ID);

      const walletTotals = wallets.reduce((acc, w) => {
        acc.earned += parseFloat(w.totalEarned || 0);
        acc.balance += parseFloat(w.balance || 0);
        return acc;
      }, { earned: 0, balance: 0 });

      return {
        wallets: wallets.map(w => ({
          balance: parseFloat(w.balance).toFixed(2),
          currency: w.currency?.name,
          symbol: w.currency?.symbol,
          totalEarned: parseFloat(w.totalEarned).toFixed(2)
        })),
        monetization: {
          totalEarnedHistorical: walletTotals.earned.toFixed(2),
          pendingRewards: preview.totalRewards.toFixed(2),
          pendingEligibleTweets: preview.eligibleTweets,
          topPendingTweets: preview.tweetDetails
            .sort((a, b) => b.reward - a.reward)
            .slice(0, 5)
            .map(d => ({
              tweetId: d.tweetId,
              content: d.content,
              reward: d.reward.toFixed(2),
              views: d.stats.views
            }))
        },
        recentTransactions: recentTransactions.map(tx => ({
          id: tx.id,
          type: tx.type,
          direction: tx.toUserId === POLICE_ACCOUNT_ID ? 'received' : 'sent',
          amount: parseFloat(tx.amount).toFixed(2),
          currency: tx.currency?.symbol,
          from: tx.fromUser ? { id: tx.fromUser.id, username: tx.fromUser.username } : null,
          to: tx.toUser ? { id: tx.toUser.id, username: tx.toUser.username } : null,
          description: tx.description,
          status: tx.status,
          created_at: tx.createdAt
        }))
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la collecte des données financières:', error);
      return null;
    }
  }
}

module.exports = DataCollector;
