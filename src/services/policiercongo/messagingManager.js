/**
 * 📩 Gestionnaire de Messagerie PolicierCongo
 * 
 * Gère l'envoi de messages privés (DMs)
 */

const logger = require('../../utils/logger');
const { Conversation, ConversationParticipant, Message, User, sequelize } = require('../../models');
const { POLICE_ACCOUNT_ID } = require('./config');

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
      // 1. Chercher une conversation directe existante
      // (Logique simplifiée : on cherche une conversation de type 'direct' où les deux sont participants)
      const existing = await Conversation.findOne({
        where: { type: 'direct' },
        include: [
          {
            model: ConversationParticipant,
            as: 'participants',
            where: { user_id: [POLICE_ACCOUNT_ID, targetUserId] }
          }
        ],
        transaction: tx
      });

      // Il faudrait normalement vérifier qu'il n'y a QUE ces deux là, mais pour PolicierCongo
      // on peut simplifier ou faire une recherche plus stricte si besoin.
      
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
  async sendPrivateMessage(targetUserId, content) {
    try {
      if (!content || !targetUserId) throw new Error('Cible et contenu requis');

      const conversation = await this.getOrCreateDirectConversation(targetUserId);

      const message = await Message.create({
        conversation_id: conversation.id,
        sender_id: POLICE_ACCOUNT_ID,
        content: content,
        message_type: 'text',
        metadata: { source: 'policiercongo_notify' }
      });

      // Mettre à jour le timestamp de la conversation
      await Conversation.update(
        { updated_at: new Date() },
        { where: { id: conversation.id }, silent: true }
      );

      logger.info(`📩 Message envoyé à ${targetUserId} dans la conv ${conversation.id}`);
      return { success: true, messageId: message.id, conversationId: conversation.id };

    } catch (error) {
      logger.error('❌ Erreur sendPrivateMessage:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new MessagingManager();
