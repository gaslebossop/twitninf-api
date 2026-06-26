
/**
 * 🔍 Service de vérification avec Gemini
 * Analyse les demandes de vérification des utilisateurs
 */

const logger = require('../utils/logger');
const { User, Tweet, TweetLike, TweetRetweet, UserFollow } = require('../models');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

class VerificationService {
  constructor() {
    this.megaModel = 'gpt-5.4';
    this.initialized = true;
    
    logger.info('🔍 Service de vérification MegaLLM initialisé (gpt-5.4)');
  }

  async generateWithMegaLLM(prompt) {
    const megaModulePath = path.resolve(__dirname, '..', 'megallm-client', 'index.js');
    const megaModule = await import(pathToFileURL(megaModulePath).href);
    const MegaLLMClient = megaModule?.MegaLLMClient;
    if (!MegaLLMClient) {
      throw new Error('MegaLLMClient introuvable');
    }

    const sessionCandidates = [
      path.resolve(__dirname, '..', 'megallm-client', 'megallm-session.json'),
      path.resolve(process.cwd(), 'src', 'megallm-client', 'megallm-session.json')
    ];
    const sessionPath = sessionCandidates.find((p) => fs.existsSync(p));
    if (!sessionPath) {
      throw new Error('Fichier megallm-session.json introuvable');
    }

    const client = new MegaLLMClient(sessionPath);
    client.defaultModel = this.megaModel;
    return client.generate(prompt, {
      model: this.megaModel,
      temperature: 0.1,
      maxTokens: 1400
    });
  }

  /**
   * 📊 Collecter toutes les données utilisateur pour l'analyse
   */
  async collectUserData(userId) {
    try {
      logger.info(`📊 Collecte des données utilisateur pour vérification: ${userId}`);

      // Récupérer les données utilisateur de base (sans restriction d'attributs pour être sûr)
      const user = await User.findByPk(userId);

      if (!user) {
        throw new Error('Utilisateur non trouvé');
      }

      // Log pour vérifier les données utilisateur
      logger.info(`👤 Données utilisateur récupérées:`, {
        id: user.id,
        username: user.username,
        created_at: user.created_at,
        created_at_type: typeof user.created_at,
        created_at_value: user.created_at,
        last_activity: user.last_activity,
        verified: user.verified,
        all_user_keys: Object.keys(user.dataValues || user)
      });

      // Récupérer les 50 derniers tweets
      const recentTweets = await Tweet.findAll({
        where: { 
          user_id: userId,
          moderation_status: 'approved'
        },
        attributes: [
          'id', 'content', 'created_at', 'view_count', 'is_retweet', 'is_quote',
          'media_urls', 'location', 'language'
        ],
        order: [['created_at', 'DESC']],
        limit: 50
      });

      // Compter les interactions
      const [totalLikes, totalRetweets, totalViews] = await Promise.all([
        TweetLike.count({ 
          where: { 
            user_id: userId 
          } 
        }),
        TweetRetweet.count({ 
          where: { 
            user_id: userId 
          } 
        }),
        Tweet.sum('view_count', { 
          where: { 
            user_id: userId,
            moderation_status: 'approved'
          } 
        })
      ]);

      // Compter les abonnements
      const [followersCount, followingCount] = await Promise.all([
        UserFollow.count({ 
          where: { 
            following_id: userId 
          } 
        }),
        UserFollow.count({ 
          where: { 
            follower_id: userId 
          } 
        })
      ]);

      // Calculer l'engagement moyen
      const engagementRate = recentTweets.length > 0 ? 
        ((totalLikes + totalRetweets) / recentTweets.length) : 0;

      // Récupérer les statistiques globales de l'app
      const globalStats = await this.getGlobalAppStats();

      // Utiliser createdAt (camelCase) au lieu de created_at (snake_case)
      const createdAt = user.createdAt || user.created_at;
      const accountAgeDays = createdAt ? Math.floor((Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)) : 0;
      
      // Log pour vérifier le calcul
      logger.info(`📅 Calcul âge du compte:`, {
        created_at: user.created_at,
        createdAt: user.createdAt,
        createdAt_used: createdAt,
        account_age_days: accountAgeDays
      });

      const userData = {
        user: {
          id: user.id,
          username: user.username,
          full_name: user.full_name,
          verified: user.verified,
          premium: user.premium,
          account_age_days: accountAgeDays,
          last_activity: user.last_activity
        },
        tweets: {
          total_count: recentTweets.length,
          recent_tweets: recentTweets.slice(0, 20).map(tweet => ({
            content: tweet.content.substring(0, 600), // Limiter la longueur
            created_at: tweet.created_at,
            view_count: tweet.view_count || 0,
            has_media: !!tweet.media_urls,
            is_retweet: tweet.is_retweet,
            is_quote: tweet.is_quote
          })),
          engagement_rate: engagementRate
        },
        stats: {
          total_views: totalViews || 0,
          total_likes: totalLikes,
          total_retweets: totalRetweets,
          followers_count: followersCount,
          following_count: followingCount,
          engagement_rate: engagementRate
        },
        global_context: globalStats
      };

      logger.info(`✅ Données utilisateur collectées: ${userData.tweets.total_count} tweets, ${userData.stats.followers_count} abonnés`);
      return userData;

    } catch (error) {
      logger.error(`❌ Erreur lors de la collecte des données utilisateur ${userId}:`, error);
      throw error;
    }
  }

  /**
   * 📈 Récupérer les statistiques globales de l'application
   */
  async getGlobalAppStats() {
    try {
      const [totalUsers, totalTweets, totalViews, verifiedUsers] = await Promise.all([
        User.count({ where: { is_active: true } }),
        Tweet.count({ where: { moderation_status: 'approved' } }),
        Tweet.sum('view_count', { where: { moderation_status: 'approved' } }),
        User.count({ where: { verified: true, is_active: true } })
      ]);

      return {
        total_users: totalUsers,
        total_tweets: totalTweets,
        total_views: totalViews || 0,
        verified_users_count: verifiedUsers,
        verification_rate: totalUsers > 0 ? (verifiedUsers / totalUsers) : 0
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des stats globales:', error);
      return {
        total_users: 0,
        total_tweets: 0,
        total_views: 0,
        verified_users_count: 0,
        verification_rate: 0
      };
    }
  }

  /**
   * 🤖 Analyser la demande de vérification avec Gemini
   */
  async analyzeVerificationRequest(verificationRequest) {
    try {
      logger.info(`🤖 Analyse Gemini de la demande de vérification: ${verificationRequest.id}`);

      // Collecter les données utilisateur
      const userData = await this.collectUserData(verificationRequest.user_id);

      // Créer le prompt pour Gemini
      const prompt = this.createVerificationPrompt(userData, verificationRequest.form_data);

      let text = '';
      let aiProvider = `MegaLLM (${this.megaModel})`;
      text = await this.generateWithMegaLLM(prompt);
      text = (text || '').trim();
      
      if (!text) {
        throw new Error(`Texte de la réponse ${aiProvider} vide`);
      }

      // Parser la réponse de Gemini
      const analysis = this.parseGeminiResponse(text);
      
      // Log de l'analyse pour déboguer
      logger.info(`🔍 Analyse ${aiProvider} pour ${verificationRequest.id}:`, {
        ai_provider: aiProvider,
        recommendation: analysis.recommendation,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
        key_factors: analysis.key_factors
      });

      // Mettre à jour la demande avec l'analyse
      await verificationRequest.update({
        analysis_data: userData,
        gemini_response: {
          raw_response: text,
          parsed_analysis: analysis,
          analyzed_at: new Date().toISOString(),
          ai_provider: aiProvider
        }
      });

      logger.info(`✅ Analyse ${aiProvider} terminée pour ${verificationRequest.id}: ${analysis.recommendation}`);
      return analysis;

    } catch (error) {
      logger.error(`❌ Erreur lors de l'analyse IA pour ${verificationRequest.id}:`, error);
      throw error;
    }
  }

  /**
   * 📝 Créer le prompt pour l'analyse Gemini
   */
  createVerificationPrompt(userData, formData) {
    // Calculer l'âge de l'application (créée le 15 août 2024)
    const appCreationDate = new Date('2025-08-15');
    const today = new Date();
    const appAgeDays = Math.floor((today - appCreationDate) / (1000 * 60 * 60 * 24));
    
    const prompt = `
Tu es un expert en vérification de comptes sur l'app twitninf. Analyse cette demande et donne une recommandation stricte.

## DONNÉES UTILISATEUR:

**Informations de base:**
- Nom d'utilisateur: ${userData.user.username}
- Nom complet: ${userData.user.full_name}
- Âge du compte: ${userData.user.account_age_days} jours
- Premium: ${userData.user.premium ? 'Oui' : 'Non'}
- Déjà vérifié: ${userData.user.verified ? 'Oui' : 'Non'}

**Statistiques:**
- Abonnés: ${userData.stats.followers_count}
- Abonnements: ${userData.stats.following_count}
- Vues totales: ${userData.stats.total_views}
- Likes total: ${userData.stats.total_likes}
- Retweets total: ${userData.stats.total_retweets}
- Taux d'engagement: ${userData.stats.engagement_rate.toFixed(2)}

**Contenu récent (${userData.tweets.total_count} tweets):**
${userData.tweets.recent_tweets.map((tweet, index) => 
  `${index + 1}. "${tweet.content}" (${tweet.view_count} vues, ${tweet.created_at})`
).join('\n')}

**Contexte global de l'application:**
- Âge de l'application: ${appAgeDays} jours (créée le 15 août 2024)
- Total utilisateurs: 35 utilisateurs (application très récente)
- Utilisateurs actifs: 5 utilisateurs seulement
- Total tweets: ${userData.global_context.total_tweets}
- Total vues: ${userData.global_context.total_views}
- Utilisateurs vérifiés: ${userData.global_context.verified_users_count} sur ${userData.global_context.total_users} (${(userData.global_context.verification_rate * 100).toFixed(1)}%)
- Taux de vérification: ${(userData.global_context.verification_rate * 100).toFixed(1)}% des utilisateurs actifs sont vérifiés

**⚠️ IMPORTANT - CONTEXTE DE L'APPLICATION:**
twitninf est une petite application. Les stats peuvent etre modestes, mais la verification doit rester selective.

**Réponses utilisateur (questions simplifiées twitninf):**
1) Qui est ce compte sur twitninf ?  
Réponse: ${formData.public_identification || 'Non fournie'}

2) Pourquoi ce compte doit être vérifié ?  
Réponse: ${formData.public_impact || 'Non fournie'}

3) Pourquoi ce compte est important sur twitninf ?  
Réponse: ${formData.platform_impact || 'Non fournie'}

4) Activité principale / rôle (optionnel)  
Réponse: ${formData.profession || formData.organization || 'Non précisé'}

5) Éléments notables (optionnel)  
Réponse: ${formData.notable_achievements || 'Non fourni'}

## CRITÈRES D'ÉVALUATION:

1. Authenticite du compte
2. Coherence et clarté des réponses utilisateur
3. Utilite reelle de la verification (risque d'usurpation / confusion)
4. Qualite minimale de presence sur twitninf

## SIGNAUX D'ALERTE (REJET IMMÉDIAT):

🚨 **REJETTE** si tu detectes:
- Compte tres recent (moins de 7 jours)
- Activite suspecte, spam, usurpation, contenu copie
- Infos de demande trop vagues ou incoherentes

## CRITÈRES D'APPROBATION (ADAPTÉS AU CONTEXTE DE L'APP):

✅ **APPROUVE** seulement si:
- Profil authentique et coherent
- Justification claire de verification
- Risque realiste d'usurpation ou besoin public clair
- Comportement sain sur la plateforme

🚫 **REJETTE automatiquement** si:

- Contenu problématique, spam ou inapproprié
- Activité suspecte ou artificielle
- Compte créé il y a moins de 7 jours
- **NOTE**: ne pas approuver automatiquement juste parce que les stats sont "correctes"

## RÉPONSE REQUISE:

Réponds UNIQUEMENT avec un JSON strict dans ce format exact:

{
  "recommendation": "APPROVE" ou "REJECT",
  "confidence": 0.0 à 1.0,
  "reasoning": "Explication détaillée de la décision avec analyse des risques",
  "key_factors": ["facteur1", "facteur2", "facteur3"],
  "suggestions": "Suggestions d'amélioration si applicable"
}

`;
    
    // Enregistrer le prompt dans un fichier temporaire
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tempDir = path.join(__dirname, '../../temp');
      
      // Créer le dossier temp s'il n'existe pas
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const filename = `verification-prompt-${timestamp}.txt`;
      const filepath = path.join(tempDir, filename);
      
      fs.writeFileSync(filepath, prompt, 'utf8');
      logger.info(`📝 Prompt verification enregistré dans: ${filepath}`);
    } catch (error) {
      logger.error('❌ Erreur lors de l\'enregistrement du prompt:', error);
    }
    
    return prompt;
  }

  /**
   * 🔍 Parser la réponse de Gemini
   */
  parseGeminiResponse(responseText) {
    try {
      // S'assurer que responseText est une chaîne de caractères
      const text = typeof responseText === 'string' ? responseText : String(responseText || '');
      
      // Essayer de parser le JSON de la réponse
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // Validation des champs requis
        if (!parsed.recommendation || !['APPROVE', 'REJECT'].includes(parsed.recommendation)) {
          throw new Error('Réponse Gemini invalide: recommendation manquante ou invalide');
        }

        return {
          recommendation: parsed.recommendation,
          confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
          reasoning: parsed.reasoning || 'Aucune explication fournie',
          key_factors: Array.isArray(parsed.key_factors) ? parsed.key_factors : [],
          suggestions: parsed.suggestions || null,
          parsed_successfully: true
        };
      } else {
        throw new Error('Aucun JSON trouvé dans la réponse Gemini');
      }
    } catch (error) {
      logger.error('❌ Erreur lors du parsing de la réponse Gemini:', error);
      
      // Fallback strict: en cas d'erreur de parsing, rejeter par sécurité
      const text = typeof responseText === 'string' ? responseText : String(responseText || '');
      const textLower = text.toLowerCase();
      const isApprove = textLower.includes('approve') || textLower.includes('approuver') || textLower.includes('oui');
      const isReject = textLower.includes('reject') || textLower.includes('rejeter') || textLower.includes('non');
      
      // Par défaut, rejeter si on ne peut pas parser correctement (sécurité anti-fraude)
      const recommendation = (isApprove && !isReject) ? 'APPROVE' : 'REJECT';
      
      return {
        recommendation: recommendation,
        confidence: 0.2, // Très faible confiance pour les réponses non parsées
        reasoning: `Réponse IA non parsée - Sécurité anti-fraude: ${text.substring(0, 500)}`,
        key_factors: ['Réponse non parsée', 'Sécurité anti-fraude'],
        suggestions: 'Vérification manuelle obligatoire',
        parsed_successfully: false,
        raw_response: responseText
      };
    }
  }

  /**
   * 🎯 Traiter automatiquement une demande de vérification
   */
  async processVerificationRequest(verificationRequestId) {
    try {
      const { VerificationRequest } = require('../models');
      
      const verificationRequest = await VerificationRequest.findByPk(verificationRequestId, {
        include: [{ model: User, as: 'user' }]
      });

      if (!verificationRequest) {
        throw new Error('Demande de vérification non trouvée');
      }

      if (verificationRequest.status !== 'pending') {
        throw new Error('Demande déjà traitée');
      }

      logger.info(`🎯 Traitement automatique de la demande ${verificationRequestId}`);

      // Analyser avec Gemini
      let analysis;
      try {
        analysis = await this.analyzeVerificationRequest(verificationRequest);
      } catch (geminiError) {
      logger.error(`❌ Erreur IA pour la demande ${verificationRequestId}, passage en révision manuelle:`, geminiError);
        
        // En cas d'erreur Gemini, passer en révision manuelle
        await verificationRequest.update({
          status: 'under_review',
          reason: 'Erreur lors de l\'analyse automatique - Révision manuelle requise',
          gemini_response: {
            error: geminiError.message,
            error_type: 'VERIFICATION_AI_ERROR',
            analyzed_at: new Date().toISOString()
          }
        });
        
        return {
          processed: false,
          recommendation: 'MANUAL_REVIEW',
          confidence: 0,
          requires_manual_review: true,
          error: 'Erreur lors de l\'analyse automatique'
        };
      }

      // Appliquer la recommandation automatiquement si confiance élevée (seuil strict anti-fraude)
      if (analysis.confidence >= 0.8) {
        if (analysis.recommendation === 'APPROVE') {
          await verificationRequest.approve(null, `Approuvé automatiquement par Gemini (confiance: ${(analysis.confidence * 100).toFixed(1)}%)`);
          logger.info(`✅ Demande ${verificationRequestId} approuvée automatiquement`);
        } else {
          await verificationRequest.reject(null, `Rejeté automatiquement par Gemini (confiance: ${(analysis.confidence * 100).toFixed(1)}%)`);
          logger.info(`❌ Demande ${verificationRequestId} rejetée automatiquement`);
        }
      } else {
        // Confiance faible: passer en mode révision manuelle
        await verificationRequest.update({
          status: 'under_review',
          reason: `En révision manuelle - Confiance Gemini: ${(analysis.confidence * 100).toFixed(1)}%`
        });
        logger.info(`🔍 Demande ${verificationRequestId} mise en révision manuelle (confiance: ${(analysis.confidence * 100).toFixed(1)}%)`);
      }

      return {
        processed: true,
        recommendation: analysis.recommendation,
        confidence: analysis.confidence,
        requires_manual_review: analysis.confidence < 0.8
      };

    } catch (error) {
      logger.error(`❌ Erreur lors du traitement de la demande ${verificationRequestId}:`, error);
      throw error;
    }
  }

  /**
   * 📊 Obtenir les statistiques des demandes de vérification
   */
  async getVerificationStats() {
    try {
      const { VerificationRequest } = require('../models');
      
      const stats = await VerificationRequest.getStats();
      const globalStats = await this.getGlobalAppStats();

      return {
        requests: {
          pending: stats.pending || 0,
          approved: stats.approved || 0,
          rejected: stats.rejected || 0,
          under_review: stats.under_review || 0,
          total: Object.values(stats).reduce((sum, count) => sum + count, 0)
        },
        global: globalStats,
        approval_rate: stats.total > 0 ? ((stats.approved || 0) / stats.total) : 0
      };
    } catch (error) {
      logger.error('❌ Erreur lors de la récupération des stats de vérification:', error);
      return null;
    }
  }

  /**
   * 🔍 Analyser la qualité du contenu d'un utilisateur
   */
  async analyzeContentQuality(userId) {
    try {
      const tweets = await Tweet.findAll({
        where: { 
          user_id: userId,
          moderation_status: 'approved',
          created_at: {
            [require('sequelize').Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 derniers jours
          }
        },
        attributes: ['id', 'content', 'created_at', 'view_count'],
        order: [['created_at', 'DESC']],
        limit: 20
      });

      if (tweets.length === 0) {
        return { quality_score: 0, analysis: 'Aucun contenu récent' };
      }

      // Analyser la diversité du contenu
      const contentLengths = tweets.map(t => t.content.length);
      const avgLength = contentLengths.reduce((sum, len) => sum + len, 0) / contentLengths.length;
      const lengthVariety = Math.max(0, 1 - (Math.max(...contentLengths) - Math.min(...contentLengths)) / 600);

      // Analyser la fréquence de publication
      const timeBetweenTweets = [];
      for (let i = 1; i < tweets.length; i++) {
        const diff = new Date(tweets[i-1].created_at) - new Date(tweets[i].created_at);
        timeBetweenTweets.push(diff / (1000 * 60 * 60)); // en heures
      }
      const avgTimeBetween = timeBetweenTweets.reduce((sum, time) => sum + time, 0) / timeBetweenTweets.length;

      // Calculer le score de qualité (0-1)
      const qualityScore = Math.min(1, (
        (avgLength / 100) * 0.3 + // Longueur moyenne
        lengthVariety * 0.2 + // Variété de longueur
        Math.min(1, avgTimeBetween / 24) * 0.2 + // Fréquence de publication
        Math.min(1, tweets.length / 20) * 0.3 // Quantité de contenu
      ));

      return {
        quality_score: qualityScore,
        analysis: {
          avg_content_length: Math.round(avgLength),
          content_variety: lengthVariety,
          avg_time_between_posts_hours: Math.round(avgTimeBetween),
          recent_tweets_count: tweets.length
        }
      };

    } catch (error) {
      logger.error(`❌ Erreur lors de l'analyse de qualité pour ${userId}:`, error);
      return { quality_score: 0, analysis: 'Erreur d\'analyse' };
    }
  }
}

module.exports = VerificationService;
