/**
 * 📩 Gestionnaire de Messagerie PolicierCongo
 * 
 * Gère l'envoi de messages privés (DMs)
 */

const { Op } = require('sequelize');
const logger = require('../../utils/logger');
const { Conversation, ConversationParticipant, Message, User, sequelize } = require('../../models');
const { POLICE_ACCOUNT_ID } = require('./config');

function sameId(a, b) {
  return String(a || '') === String(b || '');
}

class MessagingManager {
  constructor() {
    this.initialized = false;
  }

  async initialize() {
    this.initialized = true;
    logger.info('📩 Gestionnaire de messagerie PolicierCongo prêt');
  }

  /**
   * Trouve ou crée une conversation directe entre PolicierCongo et un utilisateur
   */
  async getOrCreateDirectConversation(targetUserId) {
    const tx = await sequelize.transaction();
    try {
      const conversations = await Conversation.findAll({
        where: { type: 'direct' },
        include: [
          {
            model: ConversationParticipant,
            as: 'participants',
            where: { user_id: { [Op.in]: [POLICE_ACCOUNT_ID, targetUserId] } },
            required: true
          }
        ],
        transaction: tx
      });

      let existing = null;
      for (const conversation of conversations) {
        const candidateIds = (conversation.participants || [])
          .map((participant) => String(participant.user_id))
          .filter(Boolean);
        const candidateSet = new Set(candidateIds);
        if (!candidateSet.has(String(POLICE_ACCOUNT_ID)) || !candidateSet.has(String(targetUserId))) continue;

        const allParticipants = await ConversationParticipant.findAll({
          where: { conversation_id: conversation.id },
          attributes: ['user_id'],
          transaction: tx
        });
        const allIds = allParticipants.map((participant) => String(participant.user_id)).filter(Boolean);
        const exactSet = new Set(allIds);
        if (allIds.length === 2 && exactSet.size === 2
          && exactSet.has(String(POLICE_ACCOUNT_ID))
          && exactSet.has(String(targetUserId))) {
          existing = conversation;
          break;
        }
      }
      
      let conversation = existing;

      if (!conversation) {
        // 2. Créer la conversation if not found
        conversation = await Conversation.create({
          type: 'direct',
          created_by: POLICE_ACCOUNT_ID,
          metadata: { invitation_status: 'accepted', source: 'policiercongo_automation' }
        }, { transaction: tx });

        await ConversationParticipant.bulkCreate([
          { conversation_id: conversation.id, user_id: POLICE_ACCOUNT_ID, role: 'owner' },
          { conversation_id: conversation.id, user_id: targetUserId, role: 'member' }
        ], { transaction: tx });
      }

      await tx.commit();
      return conversation;
    } catch (error) {
      await tx.rollback();
      logger.error('❌ Erreur getOrCreateDirectConversation:', error);
      throw error;
    }
  }

  /**
   * Envoie un message privé à un utilisateur
   */
  async sendPrivateMessage(targetUserId, content, options = {}) {
    try {
      if (!content || !targetUserId) throw new Error('Cible et contenu requis');

      const conversation = await this.getOrCreateDirectConversation(targetUserId);
      const metadata = {
        source: options.source || 'policiercongo_notify',
        ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {})
      };

      const message = await Message.create({
        conversation_id: conversation.id,
        sender_id: POLICE_ACCOUNT_ID,
        content: content,
        message_type: 'text',
        metadata
      });

      // Mettre à jour le timestamp de la conversation
      const conversationMetadata = { ...(conversation.metadata || {}) };
      if (options.relayToUserId && !sameId(options.relayToUserId, targetUserId)) {
        conversationMetadata.pending_reply_forward = {
          status: 'pending',
          requested_by_user_id: options.relayToUserId,
          requested_by_username: options.relayToUsername || null,
          source_conversation_id: options.sourceConversationId || null,
          target_user_id: targetUserId,
          outbound_message_id: message.id,
          reason: options.reason || null,
          created_at: new Date().toISOString()
        };
      }

      await Conversation.update(
        { metadata: conversationMetadata, updated_at: new Date() },
        { where: { id: conversation.id }, silent: true }
      );

      if (options.fulfillPendingReplyConversationId) {
        const sourceConversation = await Conversation.findByPk(options.fulfillPendingReplyConversationId);
        const pending = sourceConversation?.metadata?.pending_reply_forward;
        if (pending?.status === 'pending') {
          await sourceConversation.update({
            metadata: {
              ...(sourceConversation.metadata || {}),
              pending_reply_forward: {
                ...pending,
                status: 'fulfilled',
                fulfilled_at: new Date().toISOString(),
                forwarded_conversation_id: conversation.id,
                forwarded_message_id: message.id
              }
            },
            updated_at: new Date()
          }, { silent: true });
        }
      }

      logger.info(`📩 Message envoyé à ${targetUserId} dans la conv ${conversation.id}`);
      return { success: true, messageId: message.id, conversationId: conversation.id };

    } catch (error) {
      logger.error('❌ Erreur sendPrivateMessage:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Envoie un MP initié par PolicierCongo, sans dépendre d'une réponse au DM courant.
   */
  async sendOutboundPrivateMessage(targetUserId, content, options = {}) {
    if (sameId(targetUserId, POLICE_ACCOUNT_ID)) {
      return { success: false, error: 'PolicierCongo ne peut pas envoyer un MP à lui-même' };
    }

    const result = await this.sendPrivateMessage(targetUserId, content, {
      source: 'policiercongo_outbound',
      reason: options.reason || null,
      relayToUserId: options.relayToUserId || null,
      relayToUsername: options.relayToUsername || null,
      sourceConversationId: options.sourceConversationId || null,
      fulfillPendingReplyConversationId: options.fulfillPendingReplyConversationId || null,
      metadata: {
        outbound: true,
        requested_by_user_id: options.relayToUserId || null,
        requested_by_username: options.relayToUsername || null,
        source_conversation_id: options.sourceConversationId || null
      }
    });
    if (!result.success) return result;

    return {
      ...result,
      outbound: true,
      initiatedBy: POLICE_ACCOUNT_ID,
      targetUserId,
      reason: options.reason || null
    };
  }
}

module.exports = new MessagingManager();
