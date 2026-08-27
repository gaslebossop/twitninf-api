const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { authenticateToken } = require('../middleware/authMiddleware');
const { Tweet, User } = require('../models');
const instructionManager = require('../services/policiercongo/InstructionManager');
const { geminiIntelligence, memoryManager } = require('../services/policiercongo');
const { POLICE_ACCOUNT_ID } = require('../services/policiercongo/config');
const { TRIGGER_TYPES, runPolicierCongoV2Turn, isPolicierCongoV2Enabled } = require('../services/policiercongo/policiercongov3/compatibilityBridge');

const MAX_CONTEXT_CHARS = 260;
const MAX_HISTORY_CHARS = 180;
const clamp = (txt = '', max = MAX_CONTEXT_CHARS) => {
  const normalized = String(txt).replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
};
const toTimeAgo = (value) => {
  if (!value) return 'date inconnue';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'date inconnue';
  const deltaMin = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (deltaMin < 1) return 'a l\'instant';
  if (deltaMin < 60) return `il y a ${deltaMin} min`;
  const h = Math.floor(deltaMin / 60);
  if (h < 24) return `il y a ${h}h`;
  const days = Math.floor(h / 24);
  return `il y a ${days}j`;
};

// Fichier de persistance des conversations
const CHAT_STORAGE_PATH = path.join(__dirname, '../services/policiercongo/chat-history.json');

function loadChatHistory() {
  try {
    if (fs.existsSync(CHAT_STORAGE_PATH)) {
      return JSON.parse(fs.readFileSync(CHAT_STORAGE_PATH, 'utf8'));
    }
  } catch (_) { }
  return {};
}

function saveChatHistory(data) {
  try {
    fs.writeFileSync(CHAT_STORAGE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn('⚠️ Impossible de sauvegarder le chat history:', err.message);
  }
}

// Rate limiting: 10 messages per user per day
const chatLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: 'Tu as atteint ta limite de 10 messages par jour avec PolicierCongo. Reviens demain !'
  },
  keyGenerator: (req) => req.user ? `chat_${req.user.id}` : req.ip,
  skip: (req) => {
    // Bypass limit for superadmins
    return req.user && req.user.role === 'superadmin';
  }
});

/**
 * GET /api/policiercongo/chat/profile
 * Retourne le vrai profil de PolicierCongo
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const profile = await User.findByPk(POLICE_ACCOUNT_ID, {
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style']
    });
    if (!profile) {
      return res.json({
        success: true,
        profile: { username: 'PolicierCongo', full_name: 'Policier Congo', avatar: null, verified: true, verification_style: 'default' }
      });
    }
    return res.json({ success: true, profile: profile.get({ plain: true }) });
  } catch (error) {
    logger.error('❌ Erreur profil PolicierCongo chat:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * GET /api/policiercongo/chat/history
 * Historique de conversation de l'utilisateur
 */
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const userId = String(req.user.id);
    const history = loadChatHistory();
    const userHistory = history[userId] || [];
    return res.json({ success: true, messages: userHistory });
  } catch (error) {
    logger.error('❌ Erreur history chat:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/**
 * POST /api/policiercongo/chat/message
 * Envoyer un message à PolicierCongo
 */
router.post('/message', authenticateToken, chatLimiter, async (req, res) => {
  // Désactiver le timeout pour laisser le temps au modèle local de se charger (Transformers.js)
  req.setTimeout(0);
  res.setTimeout(0);
  try {
    const { message } = req.body;
    const userId = String(req.user.id);
    const username = req.user.username || 'Utilisateur';
    const fallbackFullName = req.user.full_name || req.user.name || 'Utilisateur';

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Le message ne peut pas être vide' });
    }

    // Charger historique existant
    const allHistory = loadChatHistory();
    const userHistory = allHistory[userId] || [];
    userHistory.push({ role: 'user', text: message.trim(), ts: Date.now() });

    // Résumé mémoire (minimal)
    let memorySummaryText = '';
    try {
      const memStatus = memoryManager.getStatus();
      let parts = [];
      if (memStatus.communityMood) parts.push(`Humeur de ta team: ${memStatus.communityMood}`);
      if (memStatus.priorities && memStatus.priorities.length > 0) parts.push(`Tes priorités: ${memStatus.priorities.join(', ')}`);
      if (memStatus.lastAnalysis && memStatus.lastAnalysis.summary) parts.push(`En tête: ${memStatus.lastAnalysis.summary}`);

      if (parts.length > 0) {
        memorySummaryText = parts.join(' | ');
      }
    } catch (_) { }

    // Instructions de personnalité admin
    const adminInstructions = instructionManager.getFormattedInstructions();

    let senderContext = `Expéditeur DM: @${username} (id: ${userId}, nom: ${fallbackFullName})`;
    try {
      const sender = await User.findByPk(userId, {
        attributes: ['id', 'username', 'full_name']
      });
      if (sender) {
        senderContext = `Expéditeur DM: @${sender.username || username} (id: ${sender.id}, nom: ${sender.full_name || fallbackFullName})`;
      }
    } catch (_) { }

    // Détecter un @username dans le message
    const mentionedUsernameMatch = message.match(/@([a-zA-Z0-9_]+)/);
    let mentionedUserContext = '';

    if (mentionedUsernameMatch) {
      const mentionedUsername = mentionedUsernameMatch[1];
      try {
        const mentionedUser = await User.findOne({
          where: { username: { [Op.iLike]: mentionedUsername } },
          attributes: ['id', 'username']
        });

        if (mentionedUser) {
          const mentionedTweets = await Tweet.findAll({
            where: { user_id: mentionedUser.id, parent_tweet_id: null },
            order: [['created_at', 'DESC']],
            limit: 1, // Allègement de l'input
            attributes: ['content']
          });

          if (mentionedTweets.length > 0) {
            mentionedUserContext = `\nTweets récents de @${mentionedUser.username}:\n` +
              mentionedTweets.map((t, i) => `${i + 1}. "${clamp(t.content, 220)}"`).join('\n') + '\n';
          } else {
            mentionedUserContext = `\n(Info: @${mentionedUser.username} n'a posté aucun tweet récent)\n`;
          }
        }
      } catch (err) {
        logger.warn(`⚠️ Impossible de récupérer les tweets de ${mentionedUsername}:`, err.message);
      }
    }

    // Détecter un #hashtag dans le message
    const mentionedHashtagMatch = message.match(/#([a-zA-Z0-9_]+)/);
    let hashtagContext = '';

    if (mentionedHashtagMatch) {
      const hashtag = mentionedHashtagMatch[1];
      try {
        const hashtagTweets = await Tweet.findAll({
          where: {
            content: { [Op.iLike]: `%#${hashtag}%` },
            parent_tweet_id: null
          },
          order: [['created_at', 'DESC']],
          limit: 1, // Allègement de l'input
          attributes: ['content']
        });

        if (hashtagTweets.length > 0) {
          hashtagContext = `\nTweets récents sur #${hashtag}:\n` +
            hashtagTweets.map((t, i) => `${i + 1}. "${clamp(t.content, 220)}"`).join('\n') + '\n';
        } else {
          hashtagContext = `\n(Info: Aucun tweet récent avec le hashtag #${hashtag})\n`;
        }
      } catch (err) {
        logger.warn(`⚠️ Impossible de récupérer les tweets pour #${hashtag}:`, err.message);
      }
    }

    // Historique allégé pour économiser de la puissance (4 messages suffisent)
    const recentHistory = userHistory.slice(-4);
    const convHistoryStr = recentHistory.length > 1
      ? recentHistory
        .slice(0, -1)
        .map(m => `${m.role === 'user' ? `Expéditeur(@${username})` : 'Toi(PolicierCongo)'}: ${clamp(m.text, MAX_HISTORY_CHARS)}`)
        .join('\n')
      : '';

    // Contexte DM (identité/règles/mémoire viennent du prompt système standard V2,
    // le même que pour les tweets — on ajoute juste ce qui est spécifique au DM).
    const contextPack = [
      senderContext,
      `La personne qui t'écrit MAINTENANT en DM est exactement: @${username}.`,
      memorySummaryText ? `TON ÉTAT: ${memorySummaryText}` : '',
      mentionedUserContext,
      hashtagContext,
      convHistoryStr ? `CONVERSATION DM RÉCENTE:\n${convHistoryStr}` : ''
    ].filter(Boolean).join('\n');

    let botReply = '';
    let usedV2 = false;

    if (isPolicierCongoV2Enabled()) {
      const event = {
        id: `chat_${userId}_${Date.now()}`,
        trigger: TRIGGER_TYPES.DIRECT_MESSAGE,
        userId,
        threadId: `dm_${userId}`,
        rawText: message.trim(),
        metadata: { source: 'api_chat', username }
      };

      try {
        const v2 = await runPolicierCongoV2Turn({
          event,
          // Pas de `model` ici : le pont V3 ne lit de buildOptions que
          // contextPack et systemPrompt. Un `model: 'haiku'` y traînait et
          // n'a jamais rien choisi — le modèle du chat est celui du moteur
          // (POLICIERCONGO_V3_CLAUDE_MODEL), comme partout ailleurs.
          buildOptions: { contextPack },
          geminiIntelligence
        });
        if (v2 && v2.replyText) {
          botReply = v2.replyText;
          usedV2 = true;
        }

        // Comme pour les DM : exécuter réellement toute action à effet de bord
        // décidée pendant la conversation, sinon il "annonce" un truc jamais fait.
        const sideEffectActions = Array.isArray(v2?.actions)
          ? v2.actions.filter((a) => {
            const t = String(a?.type || '').toUpperCase();
            return t && !['NOOP', 'NO_ACTION', 'REPLY', 'RESPOND_TO_USER', 'CLARIFY', 'SUGGEST'].includes(t);
          })
          : [];
        if (sideEffectActions.length) {
          const ActionExecutor = require('../services/policiercongo/actionExecutor');
          const executor = new ActionExecutor();
          for (const act of sideEffectActions) {
            try {
              await executor.executeSingleAction({ action: act.type, reason: act.reason, priority: 'medium', details: act.details || act });
            } catch (execErr) {
              logger.warn('⚠️ Exécution action déclenchée par chat échouée:', execErr?.message);
            }
          }
        }
      } catch (v2Err) {
        logger.warn('⚠️ Chat PolicierCongo V3 indisponible:', v2Err);
      }
    }

    if (!botReply || !String(botReply).trim()) {
      return res.status(503).json({ success: false, message: 'PolicierCongo est injoignable. Réessaie.' });
    }

    // Stocker la réponse
    userHistory.push({ role: 'bot', text: botReply, ts: Date.now() });
    allHistory[userId] = userHistory;
    saveChatHistory(allHistory);

    return res.json({ success: true, message: botReply });
  } catch (error) {
    logger.error('❌ Erreur chat PolicierCongo:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur interne.' });
  }
});

module.exports = router;
