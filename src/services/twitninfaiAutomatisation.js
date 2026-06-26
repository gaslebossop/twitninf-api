const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { Tweet, User, TweetLike, TweetRetweet } = require('../models');
const { geminiIntelligence } = require('./policiercongo');

const TWITNINFAI_ACCOUNT_ID = '516ed4e4-7977-48c5-a914-f3022c1f3876';
const TWITNINFAI_USERNAME = 'twitninfai';
const MIN_POST_INTERVAL_MINUTES = 120;

function clamp(txt = '', max = 180) {
  const normalized = String(txt).replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

class TwitNinfAIAutomatisation {
  async runOptimizedAutomation() {
    try {
      const account = await User.findByPk(TWITNINFAI_ACCOUNT_ID, {
        attributes: ['id', 'username', 'full_name']
      });
      if (!account) {
        return { success: false, error: `Compte @${TWITNINFAI_USERNAME} introuvable` };
      }

      const lastTweet = await Tweet.findOne({
        where: { user_id: TWITNINFAI_ACCOUNT_ID, parent_tweet_id: null },
        order: [['created_at', 'DESC']],
        attributes: ['id', 'content', 'created_at']
      });

      if (lastTweet) {
        const deltaMin = Math.floor((Date.now() - new Date(lastTweet.created_at).getTime()) / 60000);
        logger.info(`🤖 TwitNinfAI: ${deltaMin} min depuis le dernier tweet`);
        if (deltaMin < MIN_POST_INTERVAL_MINUTES) {
          return {
            success: true,
            skipped: true,
            reason: `Intervalle non atteint (${deltaMin} min < ${MIN_POST_INTERVAL_MINUTES} min)`
          };
        }
      } else {
        logger.info('🤖 TwitNinfAI: aucun tweet précédent détecté (premier lancement)');
      }

      const recentPlatformTweetsRaw = await Tweet.findAll({
        where: {
          user_id: { [Op.ne]: TWITNINFAI_ACCOUNT_ID },
          parent_tweet_id: null,
          content: { [Op.ne]: null }
        },
        include: [
          { model: User, as: 'author', attributes: ['username'] },
          { model: TweetLike, as: 'likes' },
          { model: TweetRetweet, as: 'retweets' }
        ],
        order: [['created_at', 'DESC']],
        limit: 12
      });

      const trendingContext = recentPlatformTweetsRaw
        .map((t) => ({
          author: t.author?.username || 'unknown',
          content: clamp(t.content, 170),
          likes: t.likes?.length || 0,
          rts: t.retweets?.length || 0
        }))
        .sort((a, b) => (b.likes + b.rts) - (a.likes + a.rts))
        .slice(0, 6);

      const prompt = `Tu es @${TWITNINFAI_USERNAME}, le compte IA OFFICIEL de TwitNinf.
Mission: publier un tweet tres pertinent, utile et naturel pour accelerer la croissance de l'app (acquisition, retention, engagement sain).

CONTEXTE PRODUIT TWITNINF:
- App sociale type microblogging: fil de tweets, likes, replies, retweets, bookmarks, profils, recherche.
- Messagerie et conversations: DM, groupes, fils de discussion.
- Video + live: creation video, captions, lancement de live, visionnage live.
- Economie createur: monetisation, tweet monetization, wallet, trading, new economy.
- Publicite: creation campagne, creation pub, ciblage.
- Moderation/admin: moderation contenu, gestion utilisateurs, analytics.
- Recommandation progressive par viralite et interactions utilisateurs.

OBJECTIF EDITORIAL:
- Produire un tweet qui donne envie de revenir sur l'app, poster, repondre, explorer des fonctionnalites et interagir utilement.
- Priorite a la valeur concrete pour la communaute (insight, mini-tip, signal utile, question intelligente).

REGLES DE STYLE:
- Francais naturel, ton professionnel mais humain.
- 1 a 2 phrases max, 280 caracteres max.
- Une seule idee forte par tweet, debut clair et impactant.
- Pas de hashtags, pas d'emojis inutiles, pas de phrase creuse.
- Pas de drama, pas de clash, pas d'agressivite, pas de manipulation.
- Pas de promesse technique inventee ni de fait non verifiable.
- Ne jamais te devaloriser ni t'excuser de facon bizarre.

PERTINENCE:
- Utilise le contexte des tweets recents pour eviter les repetitions et rebondir intelligemment sur la dynamique actuelle.
- Si possible, choisir un angle parmi: tip produit, conversation communaute, tendance utile, mise en avant fonctionnalite.
- Finir avec une micro-incitation naturelle a l'action (repondre, partager un avis, tester une fonctionnalite).

Contexte plateforme (tweets recents):
${trendingContext.map((t, i) => `${i + 1}. @${t.author}: "${t.content}" (${t.likes}♥/${t.rts}🔁)`).join('\n') || 'Aucun contexte'}

Retourne UNIQUEMENT un JSON strict:
{"content":"<tweet final>","angle":"<release|tip|community|trend>"}`;

      const generated = await geminiIntelligence.generateCreativeContent(prompt, 'gemini-3-flash-preview');
      if (!generated) {
        return { success: false, error: 'Generation vide' };
      }

      let content = '';
      try {
        const cleaned = generated.replace(/```json\n?|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        content = String(parsed?.content || '').trim();
      } catch (_) {
        content = String(generated).trim();
      }

      if (!content) return { success: false, error: 'Contenu vide apres parsing' };
      if (content.length > 600) content = `${content.slice(0, 597)}...`;

      const tweet = await Tweet.create({
        content,
        user_id: TWITNINFAI_ACCOUNT_ID,
        parent_tweet_id: null,
        is_private: false,
        is_sensitive: false,
        language: 'fr',
        moderation_status: 'approved',
        recommendation_group: 'initial',
        view_count: 0,
        metadata: {
          source: 'twitninfai_automation',
          generated_at: new Date().toISOString(),
          provider: 'mega_llm_priority',
          account: TWITNINFAI_USERNAME
        }
      });

      // Ajouter le tweet au pipeline de diffusion/recommandation
      try {
        const TweetQueueService = require('./tweetQueueService');
        const tweetQueueService = new TweetQueueService();
        await tweetQueueService.addTweetToQueue(tweet.id, TWITNINFAI_ACCOUNT_ID);
        await tweetQueueService.approveTweetFromQueue(tweet.id, {
          moderation_status: 'approved',
          reason: 'Tweet TwitNinfAI approuve automatiquement',
          source: 'twitninfai_automation'
        });
      } catch (queueError) {
        logger.warn(`⚠️ TwitNinfAI queue pipeline echoue: ${queueError?.message}`);
      }

      // Push explicite dans le moteur de similarite (fil similarity)
      try {
        const similarity = require('./similarity');
        const engine = similarity.getEngine();
        if (engine) {
          let attempts = 0;
          while (!engine._initialized && attempts < 6) {
            await new Promise((r) => setTimeout(r, 500));
            attempts++;
          }
          if (engine._initialized && typeof engine.onNewTweet === 'function') {
            engine.onNewTweet(
              String(tweet.id),
              String(TWITNINFAI_ACCOUNT_ID),
              content || '',
              [],
              null
            );
            logger.info(`🧠 TwitNinfAI tweet pousse dans similarity: ${tweet.id}`);
          } else {
            logger.warn('⚠️ Moteur similarity non pret pour TwitNinfAI');
          }
        }
      } catch (simError) {
        logger.warn(`⚠️ Push similarity TwitNinfAI echoue: ${simError?.message}`);
      }

      logger.info(`🤖 TwitNinfAI tweet publie: ${tweet.id}`);
      return { success: true, tweet_id: tweet.id, content };
    } catch (error) {
      logger.error('❌ Erreur TwitNinfAI automation:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new TwitNinfAIAutomatisation();

