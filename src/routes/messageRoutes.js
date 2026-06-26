const express = require('express');
const { Op } = require('sequelize');
const router = express.Router();
const logger = require('../utils/logger');
const { authenticateToken, denySuspended } = require('../middleware/authMiddleware');
const { sequelize, User, UserFollow, Conversation, ConversationParticipant, Message } = require('../models');
const { POLICE_ACCOUNT_ID } = require('../services/policiercongo/config');
const { geminiIntelligence } = require('../services/policiercongo');

async function requireMembership(conversationId, userId) {
  return ConversationParticipant.findOne({
    where: { conversation_id: conversationId, user_id: userId }
  });
}

async function requireGroupManagementRights(conversationId, userId) {
  const membership = await ConversationParticipant.findOne({
    where: { conversation_id: conversationId, user_id: userId }
  });
  if (!membership) return { ok: false, reason: 'not_member' };
  if (!['owner', 'admin'].includes(membership.role)) return { ok: false, reason: 'forbidden' };
  return { ok: true, membership };
}

function getInvitationMeta(conv) {
  const meta = conv?.metadata || {};
  return {
    status: meta.invitation_status || 'accepted',
    from: meta.invitation_from || null,
    to: meta.invitation_to || null,
    message: meta.invitation_message || null,
    responded_at: meta.invitation_responded_at || null
  };
}

function sameId(a, b) {
  return String(a || '') === String(b || '');
}

function getGroupInvitationForUser(conv, userId) {
  const meta = conv?.metadata || {};
  const groupInvites = meta.group_invitations || {};
  const key = String(userId || '');
  const record = groupInvites[key];
  if (!record) return { status: 'accepted', invited_by: null, responded_at: null };
  return {
    status: record.status || 'accepted',
    invited_by: record.invited_by || null,
    responded_at: record.responded_at || null
  };
}

function getGroupBannedUsers(conv) {
  const meta = conv?.metadata || {};
  return Array.isArray(meta.group_banned_users) ? meta.group_banned_users.map((id) => String(id)) : [];
}

function hasGroupOwnerRights(participant) {
  return String(participant?.role || '') === 'owner';
}

async function canOpenDirectWithoutInvitation(senderId, recipientId) {
  if (!senderId || !recipientId) return false;
  if (recipientId === POLICE_ACCOUNT_ID || senderId === POLICE_ACCOUNT_ID) return true;

  const sender = await User.findByPk(senderId, { attributes: ['id', 'verified'] });
  if (sender?.verified) return true; // Compte certifie: DM libre

  const [aFollowsB, bFollowsA] = await Promise.all([
    UserFollow.isFollowing(senderId, recipientId),
    UserFollow.isFollowing(recipientId, senderId)
  ]);
  return !!(aFollowsB && bFollowsA);
}

async function maybeAutoReplyFromPolicier(conversationId, senderId, incomingContent, io = null) {
  try {
    if (!conversationId || !senderId || senderId === POLICE_ACCOUNT_ID) return;

    const policeMembership = await ConversationParticipant.findOne({
      where: { conversation_id: conversationId, user_id: POLICE_ACCOUNT_ID }
    });
    if (!policeMembership) return;

    const recent = await Message.findAll({
      where: { conversation_id: conversationId },
      include: [{ model: User, as: 'sender', attributes: ['id', 'username'] }],
      order: [['created_at', 'DESC']],
      limit: 8
    });
    const timeline = recent.reverse().map((m) => `${m.sender?.id === POLICE_ACCOUNT_ID ? '@policiercongo' : `@${m.sender?.username || 'user'}`}: ${m.content}`).join('\n');

    const prompt = `Tu es @policiercongo dans un groupe/DM TwitNinf.
Reponds a ce message en gardant ton style: direct, argot 2026, court, sans hashtag.
Ne dis jamais que tu es une IA.

Conversation recente:
${timeline}

Dernier message a traiter:
"${incomingContent}"

Retourne UNIQUEMENT un JSON:
{"reply":"<ta reponse courte>"}`;

    if (io) {
      io.to(`conversation_${conversationId}`).emit('typing:update', {
        conversation_id: conversationId,
        conversationId,
        user_id: String(POLICE_ACCOUNT_ID),
        userId: String(POLICE_ACCOUNT_ID),
        username: 'policiercongo',
        is_typing: true,
        isTyping: true
      });
    }

    // Dans les messages (DM/groupes), on force Gemini pour la reponse PolicierCongo.
    const raw = await geminiIntelligence.generateContent(prompt, 'gemini-3-flash-preview', true);
    if (!raw) return;

    let reply = '';
    try {
      const parsed = JSON.parse(String(raw).replace(/```json\n?|```/g, '').trim());
      reply = String(parsed?.reply || '').trim();
    } catch (_) {
      reply = String(raw).trim();
    }
    if (!reply) return;

    const message = await Message.create({
      conversation_id: conversationId,
      sender_id: POLICE_ACCOUNT_ID,
      content: reply,
      message_type: 'text',
      metadata: { source: 'policiercongo_auto_reply' }
    });
    await Conversation.update({ updated_at: new Date() }, { where: { id: conversationId }, silent: true });

    if (io) {
      io.to(`conversation_${conversationId}`).emit('typing:update', {
        conversation_id: conversationId,
        conversationId,
        user_id: String(POLICE_ACCOUNT_ID),
        userId: String(POLICE_ACCOUNT_ID),
        username: 'policiercongo',
        is_typing: false,
        isTyping: false
      });
      io.to(`conversation_${conversationId}`).emit('message:new', {
        conversation_id: conversationId,
        conversationId,
        message
      });
      const members = await ConversationParticipant.findAll({
        where: { conversation_id: conversationId },
        attributes: ['user_id']
      });
      members.forEach((m) => {
        io.to(`user_${m.user_id}`).emit('conversation:update', {
          conversation_id: conversationId,
          conversationId
        });
      });
    }
  } catch (e) {
    if (io) {
      io.to(`conversation_${conversationId}`).emit('typing:update', {
        conversation_id: conversationId,
        conversationId,
        user_id: String(POLICE_ACCOUNT_ID),
        userId: String(POLICE_ACCOUNT_ID),
        username: 'policiercongo',
        is_typing: false,
        isTyping: false
      });
    }
    logger.warn('⚠️ Auto-reponse PolicierCongo echouee:', e?.message);
  }
}

async function findExactDirectConversation(userA, userB, transaction) {
  const candidates = await Conversation.findAll({
    where: { type: 'direct' },
    include: [
      {
        model: ConversationParticipant,
        as: 'participants',
        required: true
      }
    ],
    transaction
  });

  const a = String(userA);
  const b = String(userB);

  for (const conv of candidates) {
    const ids = (conv.participants || []).map((p) => String(p.user_id)).filter(Boolean);
    if (ids.length !== 2) continue;
    const uniq = new Set(ids);
    if (uniq.size !== 2) continue;
    if (uniq.has(a) && uniq.has(b)) {
      return conv;
    }
  }
  return null;
}

router.get('/conversations', authenticateToken, denySuspended, async (req, res) => {
  try {
    const userId = req.user.id;
    const memberships = await ConversationParticipant.findAll({
      where: { user_id: userId },
      include: [
        {
          model: Conversation,
          as: 'conversation',
          include: [
            {
              model: ConversationParticipant,
              as: 'participants',
              include: [{ model: User, as: 'user', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style'] }]
            },
            {
              model: Message,
              as: 'messages',
              limit: 1,
              separate: true,
              order: [['created_at', 'DESC']],
              include: [{ model: User, as: 'sender', attributes: ['id', 'username', 'full_name'] }]
            }
          ]
        }
      ],
      order: [['updated_at', 'DESC']]
    });

    const data = memberships.map((m) => {
      const conv = m.conversation;
      const invitation = getInvitationMeta(conv);
      const groupInvitation = conv.type === 'group' ? getGroupInvitationForUser(conv, userId) : null;
      // UX Instagram-like:
      // - receveur d'une invitation pending: uniquement dans /invitations (pas dans la liste conversations)
      // - expéditeur garde la conversation avec statut "envoyee/refusee"
      if (conv.type === 'direct' && invitation.status === 'pending' && sameId(invitation.to, userId)) {
        return null;
      }
      if (conv.type === 'direct' && invitation.status === 'declined' && sameId(invitation.to, userId)) {
        return null;
      }
      if (conv.type === 'group' && groupInvitation?.status === 'pending') {
        return null;
      }
      const lastMessage = (conv.messages || [])[0] || null;
      const participants = (conv.participants || []).map((p) => p.user).filter(Boolean);
      const participant_reads = (conv.participants || [])
        .filter((p) => p?.user_id)
        .map((p) => ({
          user_id: p.user_id,
          last_read_at: p.last_read_at || null
        }));
      return {
        id: conv.id,
        type: conv.type,
        title: conv.title,
        avatar: conv.avatar,
        invitation: conv.type === 'group' ? groupInvitation : invitation,
        participants,
        participant_reads,
        last_message: lastMessage ? {
          id: lastMessage.id,
          content: lastMessage.content,
          created_at: lastMessage.created_at,
          sender: lastMessage.sender
        } : null,
        last_read_at: m.last_read_at,
        updated_at: conv.updated_at
      };
    }).filter(Boolean);

    return res.json({ success: true, conversations: data });
  } catch (error) {
    logger.error('❌ Erreur liste conversations:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/direct/:userId', authenticateToken, denySuspended, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const currentUserId = req.user.id;
    const otherUserId = req.params.userId;
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ success: false, message: 'Message vide' });
    if (currentUserId === otherUserId) return res.status(400).json({ success: false, message: 'Conversation invalide' });

    const otherUser = await User.findByPk(otherUserId, { transaction: tx });
    if (!otherUser) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Utilisateur introuvable' });
    }

    const existing = await findExactDirectConversation(currentUserId, otherUserId, tx);

    let conversation = null;
    const allowedWithoutInvitation = await canOpenDirectWithoutInvitation(currentUserId, otherUserId);

    if (existing) {
      conversation = existing;
    } else {
      conversation = await Conversation.create({
        type: 'direct',
        created_by: currentUserId,
        metadata: allowedWithoutInvitation ? { invitation_status: 'accepted' } : {
          invitation_status: 'pending',
          invitation_from: currentUserId,
          invitation_to: otherUserId,
          invitation_message: content
        }
      }, { transaction: tx });
      await ConversationParticipant.bulkCreate([
        { conversation_id: conversation.id, user_id: currentUserId, role: 'owner' },
        { conversation_id: conversation.id, user_id: otherUserId, role: 'member' }
      ], { transaction: tx });
    }

    let invitation = getInvitationMeta(conversation);

    // Si une ancienne invitation a ete refusee, un nouvel envoi doit redevenir une invitation pending
    // (jamais basculer en DM direct par erreur).
    if (!allowedWithoutInvitation && invitation.status === 'declined') {
      await conversation.update({
        metadata: {
          ...(conversation.metadata || {}),
          invitation_status: 'pending',
          invitation_from: currentUserId,
          invitation_to: otherUserId,
          invitation_message: content,
          invitation_responded_at: null
        },
        updated_at: new Date()
      }, { transaction: tx, silent: true });
      invitation = {
        ...invitation,
        status: 'pending',
        from: currentUserId,
        to: otherUserId,
        message: content,
        responded_at: null
      };
    }

    if (!allowedWithoutInvitation && invitation.status === 'pending') {
      if (!sameId(invitation.from, currentUserId)) {
        await tx.rollback();
        return res.status(403).json({ success: false, message: 'Invitation en attente' });
      }

      // Tant que non accepte: max 2 messages de l'initiateur
      const pendingCount = await Message.count({
        where: { conversation_id: conversation.id, sender_id: currentUserId },
        transaction: tx
      });
      if (pendingCount >= 2) {
        await tx.rollback();
        return res.status(429).json({
          success: false,
          message: 'Limite atteinte: 2 messages max avant acceptation'
        });
      }

      const pendingMessage = await Message.create({
        conversation_id: conversation.id,
        sender_id: currentUserId,
        content,
        message_type: 'text'
      }, { transaction: tx });

      await conversation.update({
        metadata: {
          ...(conversation.metadata || {}),
          invitation_status: 'pending',
          invitation_from: currentUserId,
          invitation_to: otherUserId,
          invitation_message: content
        },
        updated_at: new Date()
      }, { transaction: tx, silent: true });

      await tx.commit();
      const io = req.app.get('io');
      if (io) {
        io.to(`conversation_${conversation.id}`).emit('message:new', {
          conversation_id: conversation.id,
          conversationId: conversation.id,
          message: pendingMessage
        });
        io.to(`user_${otherUserId}`).emit('invitation:update', {
          conversation_id: conversation.id,
          status: 'pending'
        });
        io.to(`user_${currentUserId}`).emit('conversation:update', {
          conversation_id: conversation.id,
          invitation_status: 'pending'
        });
      }
      return res.status(202).json({
        success: true,
        invitation_required: true,
        conversation_id: conversation.id,
        message: 'Invitation envoyee. Attente de l\'acceptation.',
        pending_message: pendingMessage
      });
    }

    const message = await Message.create({
      conversation_id: conversation.id,
      sender_id: currentUserId,
      content,
      message_type: 'text'
    }, { transaction: tx });

    await Conversation.update(
      { updated_at: new Date() },
      { where: { id: conversation.id }, transaction: tx, silent: true }
    );

    await tx.commit();
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${conversation.id}`).emit('message:new', {
        conversation_id: conversation.id,
        conversationId: conversation.id,
        message
      });
      io.to(`user_${otherUserId}`).emit('conversation:update', { conversation_id: conversation.id });
      io.to(`user_${currentUserId}`).emit('conversation:update', { conversation_id: conversation.id });
    }
    setImmediate(() => {
      maybeAutoReplyFromPolicier(conversation.id, currentUserId, content, io);
    });
    return res.status(201).json({ success: true, conversation_id: conversation.id, message });
  } catch (error) {
    await tx.rollback();
    logger.error('❌ Erreur create direct message:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/groups', authenticateToken, denySuspended, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const userId = req.user.id;
    const title = String(req.body?.title || '').trim();
    const participantIds = Array.isArray(req.body?.participantIds) ? req.body.participantIds : [];
    if (!title) return res.status(400).json({ success: false, message: 'Titre requis' });

    const uniqueParticipants = Array.from(new Set([userId, ...participantIds.filter(Boolean)]));
    if (uniqueParticipants.length < 2) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Au moins 2 participants requis' });
    }

    const users = await User.findAll({
      where: { id: { [Op.in]: uniqueParticipants } },
      attributes: ['id'],
      transaction: tx
    });
    if (users.length !== uniqueParticipants.length) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Participants invalides' });
    }

    const groupInvitations = {};
    for (const pid of uniqueParticipants) {
      if (sameId(pid, userId)) continue;
      const followsCreator = await UserFollow.isFollowing(pid, userId);
      if (!followsCreator) {
        groupInvitations[String(pid)] = {
          status: 'pending',
          invited_by: userId,
          responded_at: null
        };
      }
    }

    const conversation = await Conversation.create({
      type: 'group',
      title,
      created_by: userId,
      metadata: {
        invitation_status: 'accepted',
        group_invitations: groupInvitations
      }
    }, { transaction: tx });

    await ConversationParticipant.bulkCreate(
      uniqueParticipants.map((pid) => ({
        conversation_id: conversation.id,
        user_id: pid,
        role: pid === userId ? 'owner' : 'member'
      })),
      { transaction: tx }
    );

    await tx.commit();
    const io = req.app.get('io');
    if (io) {
      uniqueParticipants.forEach((pid) => {
        if (sameId(pid, userId)) return;
        const gInv = groupInvitations[String(pid)];
        if (gInv?.status === 'pending') {
          io.to(`user_${pid}`).emit('invitation:update', {
            conversation_id: conversation.id,
            type: 'group',
            status: 'pending'
          });
        } else {
          io.to(`user_${pid}`).emit('conversation:update', { conversation_id: conversation.id });
        }
      });
    }
    return res.status(201).json({ success: true, conversation });
  } catch (error) {
    await tx.rollback();
    logger.error('❌ Erreur create group:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.get('/conversations/:conversationId', authenticateToken, denySuspended, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const membership = await requireMembership(conversationId, userId);
    if (!membership) return res.status(403).json({ success: false, message: 'Accès refusé' });

    const conv = await Conversation.findByPk(conversationId, {
      include: [{
        model: ConversationParticipant,
        as: 'participants',
        include: [{ model: User, as: 'user', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style'] }]
      }]
    });
    if (!conv) return res.status(404).json({ success: false, message: 'Conversation introuvable' });

    const myParticipation = (conv.participants || []).find((p) => sameId(p.user_id, userId));
    const invitation = conv.type === 'group' ? getGroupInvitationForUser(conv, userId) : getInvitationMeta(conv);
    const participants = (conv.participants || []).map((p) => ({
      user_id: p.user_id,
      role: p.role,
      invited_status: conv.type === 'group' ? getGroupInvitationForUser(conv, p.user_id).status : null,
      user: p.user || null
    }));

    return res.json({
      success: true,
      conversation: {
        id: conv.id,
        type: conv.type,
        title: conv.title,
        avatar: conv.avatar,
        created_by: conv.created_by,
        invitation,
        my_role: myParticipation?.role || 'member',
        is_owner: hasGroupOwnerRights(myParticipation),
        participants,
        banned_user_ids: conv.type === 'group' ? getGroupBannedUsers(conv) : []
      }
    });
  } catch (error) {
    logger.error('❌ Erreur detail conversation:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/conversations/:conversationId/participants', authenticateToken, denySuspended, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const targetUserId = String(req.body?.userId || '').trim();
    if (!targetUserId) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Utilisateur cible requis' });
    }

    const me = await requireMembership(conversationId, userId);
    if (!me) {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Accès refusé' });
    }
    if (!hasGroupOwnerRights(me)) {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Seul le chef du groupe peut ajouter des membres' });
    }

    const conv = await Conversation.findByPk(conversationId, { transaction: tx });
    if (!conv || conv.type !== 'group') {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Groupe introuvable' });
    }
    if (sameId(targetUserId, userId)) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Action invalide' });
    }

    const targetUser = await User.findByPk(targetUserId, { attributes: ['id'], transaction: tx });
    if (!targetUser) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Utilisateur introuvable' });
    }

    const bannedIds = getGroupBannedUsers(conv);
    if (bannedIds.includes(String(targetUserId))) {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Utilisateur banni du groupe' });
    }

    const existing = await ConversationParticipant.findOne({
      where: { conversation_id: conversationId, user_id: targetUserId },
      transaction: tx
    });
    if (!existing) {
      await ConversationParticipant.create({
        conversation_id: conversationId,
        user_id: targetUserId,
        role: 'member'
      }, { transaction: tx });
    }

    const followsOwner = await UserFollow.isFollowing(targetUserId, userId);
    const invites = { ...((conv.metadata || {}).group_invitations || {}) };
    invites[String(targetUserId)] = {
      status: followsOwner ? 'accepted' : 'pending',
      invited_by: userId,
      responded_at: null
    };

    await conv.update({
      metadata: {
        ...(conv.metadata || {}),
        group_invitations: invites
      },
      updated_at: new Date()
    }, { transaction: tx, silent: true });

    await tx.commit();
    const io = req.app.get('io');
    if (io) {
      if (followsOwner) {
        io.to(`user_${targetUserId}`).emit('conversation:update', { conversation_id: conversationId });
      } else {
        io.to(`user_${targetUserId}`).emit('invitation:update', {
          conversation_id: conversationId,
          type: 'group',
          status: 'pending'
        });
      }
      io.to(`conversation_${conversationId}`).emit('conversation:participants:update', { conversation_id: conversationId });
    }

    return res.json({
      success: true,
      status: followsOwner ? 'accepted' : 'pending',
      message: followsOwner ? 'Participant ajouté' : 'Invitation envoyée (en attente)'
    });
  } catch (error) {
    await tx.rollback();
    logger.error('❌ Erreur ajout participant groupe:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/conversations/:conversationId/transfer-ownership', authenticateToken, denySuspended, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const targetUserId = String(req.body?.userId || '').trim();
    if (!targetUserId) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Utilisateur cible requis' });
    }

    const conv = await Conversation.findByPk(conversationId, { transaction: tx });
    if (!conv || conv.type !== 'group') {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Groupe introuvable' });
    }

    const me = await ConversationParticipant.findOne({
      where: { conversation_id: conversationId, user_id: userId },
      transaction: tx
    });
    if (!me || !hasGroupOwnerRights(me)) {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Seul le chef du groupe peut transférer le rôle' });
    }

    const target = await ConversationParticipant.findOne({
      where: { conversation_id: conversationId, user_id: targetUserId },
      transaction: tx
    });
    if (!target) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Membre introuvable' });
    }

    await target.update({ role: 'owner' }, { transaction: tx });
    await me.update({ role: 'member' }, { transaction: tx });
    await conv.update({ created_by: targetUserId, updated_at: new Date() }, { transaction: tx, silent: true });

    await tx.commit();
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${conversationId}`).emit('conversation:participants:update', { conversation_id: conversationId });
    }
    return res.json({ success: true, message: 'Rôle de chef transféré' });
  } catch (error) {
    await tx.rollback();
    logger.error('❌ Erreur transfert ownership groupe:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.delete('/conversations/:conversationId/participants/:targetUserId', authenticateToken, denySuspended, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const targetUserId = req.params.targetUserId;
    const mode = String(req.query?.mode || 'remove').toLowerCase();
    const ban = mode === 'ban';

    const conv = await Conversation.findByPk(conversationId, { transaction: tx });
    if (!conv || conv.type !== 'group') {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Groupe introuvable' });
    }

    const me = await ConversationParticipant.findOne({
      where: { conversation_id: conversationId, user_id: userId },
      transaction: tx
    });
    if (!me || !hasGroupOwnerRights(me)) {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Seul le chef du groupe peut retirer/ban un membre' });
    }
    if (sameId(targetUserId, userId)) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Le chef ne peut pas se retirer lui-même' });
    }

    const target = await ConversationParticipant.findOne({
      where: { conversation_id: conversationId, user_id: targetUserId },
      transaction: tx
    });
    if (!target) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Membre introuvable' });
    }

    await target.destroy({ transaction: tx });
    const metadata = { ...(conv.metadata || {}) };
    if (ban) {
      const banned = new Set(getGroupBannedUsers(conv));
      banned.add(String(targetUserId));
      metadata.group_banned_users = Array.from(banned);
      const invites = { ...(metadata.group_invitations || {}) };
      invites[String(targetUserId)] = {
        ...(invites[String(targetUserId)] || {}),
        status: 'declined',
        invited_by: userId,
        responded_at: new Date().toISOString()
      };
      metadata.group_invitations = invites;
    }
    await conv.update({ metadata, updated_at: new Date() }, { transaction: tx, silent: true });

    await tx.commit();
    const io = req.app.get('io');
    if (io) {
      io.to(`user_${targetUserId}`).emit('conversation:update', { conversation_id: conversationId, removed: true });
      io.to(`conversation_${conversationId}`).emit('conversation:participants:update', { conversation_id: conversationId });
    }
    return res.json({ success: true, action: ban ? 'ban' : 'remove' });
  } catch (error) {
    await tx.rollback();
    logger.error('❌ Erreur retrait/ban participant groupe:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.get('/conversations/:conversationId/participants', authenticateToken, denySuspended, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const membership = await requireMembership(conversationId, userId);
    if (!membership) return res.status(403).json({ success: false, message: 'Accès refusé' });

    const conversation = await Conversation.findByPk(conversationId, {
      include: [{
        model: ConversationParticipant,
        as: 'participants',
        include: [{ model: User, as: 'user', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style'] }]
      }]
    });
    if (!conversation || conversation.type !== 'group') {
      return res.status(404).json({ success: false, message: 'Groupe introuvable' });
    }

    const participants = (conversation.participants || []).map((p) => ({
      id: p.user?.id,
      username: p.user?.username,
      full_name: p.user?.full_name,
      avatar: p.user?.avatar,
      verified: p.user?.verified,
      verification_style: p.user?.verification_style,
      role: p.role
    })).filter((p) => p.id);

    return res.json({
      success: true,
      group: {
        id: conversation.id,
        title: conversation.title,
        created_by: conversation.created_by
      },
      participants
    });
  } catch (error) {
    logger.error('❌ Erreur get participants groupe:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/conversations/:conversationId/members', authenticateToken, denySuspended, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
    if (memberIds.length === 0) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Aucun membre à ajouter' });
    }

    const rights = await requireGroupManagementRights(conversationId, userId);
    if (!rights.ok) {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Action non autorisée' });
    }

    const conversation = await Conversation.findByPk(conversationId, { transaction: tx });
    if (!conversation || conversation.type !== 'group') {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Groupe introuvable' });
    }

    const existing = await ConversationParticipant.findAll({
      where: { conversation_id: conversationId },
      attributes: ['user_id'],
      transaction: tx
    });
    const existingSet = new Set(existing.map((x) => String(x.user_id)));
    const toAdd = memberIds.map(String).filter((id) => !existingSet.has(id));
    if (toAdd.length === 0) {
      await tx.commit();
      return res.json({ success: true, added: 0, invitations: 0 });
    }

    const users = await User.findAll({
      where: { id: { [Op.in]: toAdd } },
      attributes: ['id'],
      transaction: tx
    });
    const validIds = users.map((u) => String(u.id));

    await ConversationParticipant.bulkCreate(
      validIds.map((id) => ({ conversation_id: conversationId, user_id: id, role: 'member' })),
      { transaction: tx }
    );

    const groupInvitations = { ...((conversation.metadata || {}).group_invitations || {}) };
    let invitations = 0;
    for (const targetId of validIds) {
      const followsManager = await UserFollow.isFollowing(targetId, userId);
      if (!followsManager) {
        invitations += 1;
        groupInvitations[String(targetId)] = {
          status: 'pending',
          invited_by: userId,
          responded_at: null
        };
      } else {
        groupInvitations[String(targetId)] = {
          status: 'accepted',
          invited_by: userId,
          responded_at: new Date().toISOString()
        };
      }
    }
    await conversation.update({
      metadata: {
        ...(conversation.metadata || {}),
        group_invitations: groupInvitations
      },
      updated_at: new Date()
    }, { transaction: tx, silent: true });

    await tx.commit();
    const io = req.app.get('io');
    if (io) {
      validIds.forEach((id) => {
        const inv = groupInvitations[String(id)];
        if (inv?.status === 'pending') {
          io.to(`user_${id}`).emit('invitation:update', { conversation_id: conversationId, type: 'group', status: 'pending' });
        } else {
          io.to(`user_${id}`).emit('conversation:update', { conversation_id: conversationId });
        }
      });
    }
    return res.json({ success: true, added: validIds.length, invitations });
  } catch (error) {
    await tx.rollback();
    logger.error('❌ Erreur add members groupe:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/conversations/:conversationId/transfer-owner', authenticateToken, denySuspended, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const targetUserId = String(req.body?.targetUserId || '');
    if (!targetUserId) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'targetUserId requis' });
    }

    const me = await ConversationParticipant.findOne({
      where: { conversation_id: conversationId, user_id: userId },
      transaction: tx
    });
    if (!me || me.role !== 'owner') {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Seul le propriétaire peut transférer' });
    }
    const target = await ConversationParticipant.findOne({
      where: { conversation_id: conversationId, user_id: targetUserId },
      transaction: tx
    });
    if (!target) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Membre introuvable' });
    }

    await me.update({ role: 'admin' }, { transaction: tx });
    await target.update({ role: 'owner' }, { transaction: tx });
    await tx.commit();
    return res.json({ success: true });
  } catch (error) {
    await tx.rollback();
    logger.error('❌ Erreur transfer owner groupe:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/conversations/:conversationId/members/:memberId/role', authenticateToken, denySuspended, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const memberId = req.params.memberId;
    const role = String(req.body?.role || '').toLowerCase();
    if (!['admin', 'member'].includes(role)) {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Role invalide' });
    }

    const rights = await requireGroupManagementRights(conversationId, userId);
    if (!rights.ok) {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Action non autorisée' });
    }

    const target = await ConversationParticipant.findOne({
      where: { conversation_id: conversationId, user_id: memberId },
      transaction: tx
    });
    if (!target) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Membre introuvable' });
    }
    if (target.role === 'owner') {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Utilise transfer-owner pour le propriétaire' });
    }
    await target.update({ role }, { transaction: tx });
    await tx.commit();
    return res.json({ success: true });
  } catch (error) {
    await tx.rollback();
    logger.error('❌ Erreur update role groupe:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/conversations/:conversationId/members/:memberId/ban', authenticateToken, denySuspended, async (req, res) => {
  const tx = await sequelize.transaction();
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const memberId = req.params.memberId;

    const rights = await requireGroupManagementRights(conversationId, userId);
    if (!rights.ok) {
      await tx.rollback();
      return res.status(403).json({ success: false, message: 'Action non autorisée' });
    }
    const target = await ConversationParticipant.findOne({
      where: { conversation_id: conversationId, user_id: memberId },
      transaction: tx
    });
    if (!target) {
      await tx.rollback();
      return res.status(404).json({ success: false, message: 'Membre introuvable' });
    }
    if (target.role === 'owner') {
      await tx.rollback();
      return res.status(400).json({ success: false, message: 'Impossible de bannir le propriétaire' });
    }

    await target.destroy({ transaction: tx });
    const conversation = await Conversation.findByPk(conversationId, { transaction: tx });
    const banned = Array.isArray((conversation?.metadata || {}).group_banned_users) ? (conversation.metadata.group_banned_users || []) : [];
    const nextBanned = Array.from(new Set([...banned.map(String), String(memberId)]));
    await conversation.update({
      metadata: {
        ...(conversation.metadata || {}),
        group_banned_users: nextBanned
      },
      updated_at: new Date()
    }, { transaction: tx, silent: true });

    await tx.commit();
    return res.json({ success: true });
  } catch (error) {
    await tx.rollback();
    logger.error('❌ Erreur ban membre groupe:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.get('/conversations/:conversationId/messages', authenticateToken, denySuspended, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
    const membership = await requireMembership(conversationId, userId);
    if (!membership) return res.status(403).json({ success: false, message: 'Accès refusé' });

    const conv = await Conversation.findByPk(conversationId);
    const invitation = getInvitationMeta(conv);
    const groupInvitation = conv?.type === 'group' ? getGroupInvitationForUser(conv, userId) : null;
    if (conv?.type === 'direct' && invitation.status === 'pending' && !sameId(invitation.to, userId) && !sameId(invitation.from, userId)) {
      return res.status(403).json({ success: false, message: 'Invitation requise' });
    }
    if (conv?.type === 'group' && groupInvitation?.status === 'pending') {
      return res.status(403).json({ success: false, message: 'Invitation groupe en attente' });
    }
    if (conv?.type === 'group' && groupInvitation?.status === 'declined') {
      return res.status(403).json({ success: false, message: 'Invitation groupe refusee' });
    }

    const messages = await Message.findAll({
      where: { conversation_id: conversationId },
      include: [{ model: User, as: 'sender', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style'] }],
      order: [['created_at', 'DESC']],
      limit
    });

    return res.json({ success: true, messages: messages.reverse() });
  } catch (error) {
    logger.error('❌ Erreur get messages:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/conversations/:conversationId/messages', authenticateToken, denySuspended, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ success: false, message: 'Message vide' });

    const membership = await requireMembership(conversationId, userId);
    if (!membership) return res.status(403).json({ success: false, message: 'Accès refusé' });

    const conv = await Conversation.findByPk(conversationId);
    const invitation = getInvitationMeta(conv);
    const groupInvitation = conv?.type === 'group' ? getGroupInvitationForUser(conv, userId) : null;
    if (conv?.type === 'direct' && invitation.status === 'declined') {
      return res.status(403).json({ success: false, message: 'Invitation refusee. Renvoie une nouvelle invitation.' });
    }
    if (conv?.type === 'direct' && invitation.status === 'pending') {
      // Avant acceptation, seul l'initiateur peut envoyer (max 2 messages)
      if (!sameId(invitation.from, userId)) {
        return res.status(403).json({ success: false, message: 'Invitation non acceptee' });
      }
      const pendingCount = await Message.count({
        where: { conversation_id: conversationId, sender_id: userId }
      });
      if (pendingCount >= 2) {
        return res.status(429).json({
          success: false,
          message: 'Limite atteinte: 2 messages max avant acceptation'
        });
      }
    }
    if (conv?.type === 'group' && groupInvitation?.status === 'pending') {
      return res.status(403).json({ success: false, message: 'Invitation groupe non acceptee' });
    }
    if (conv?.type === 'group' && groupInvitation?.status === 'declined') {
      return res.status(403).json({ success: false, message: 'Invitation groupe refusee' });
    }

    const message = await Message.create({
      conversation_id: conversationId,
      sender_id: userId,
      content,
      message_type: 'text'
    });

    await Conversation.update(
      { updated_at: new Date() },
      { where: { id: conversationId }, silent: true }
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${conversationId}`).emit('message:new', {
        conversation_id: conversationId,
        conversationId,
        message
      });
      const members = await ConversationParticipant.findAll({
        where: { conversation_id: conversationId },
        attributes: ['user_id']
      });
      members.forEach((m) => {
        io.to(`user_${m.user_id}`).emit('conversation:update', { conversation_id: conversationId });
      });
    }

    setImmediate(() => {
      maybeAutoReplyFromPolicier(conversationId, userId, content, io);
    });

    return res.status(201).json({ success: true, message });
  } catch (error) {
    logger.error('❌ Erreur send message:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/conversations/:conversationId/read', authenticateToken, denySuspended, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const membership = await requireMembership(conversationId, userId);
    if (!membership) return res.status(403).json({ success: false, message: 'Accès refusé' });

    const incomingReadAtRaw = req.body?.read_at;
    const incomingReadAt = incomingReadAtRaw ? new Date(incomingReadAtRaw) : new Date();
    const nextReadAt = Number.isNaN(incomingReadAt.getTime()) ? new Date() : incomingReadAt;
    const currentReadAt = membership.last_read_at ? new Date(membership.last_read_at) : null;

    // Anti-doublon: si un read identique/plus recent existe deja, on n'ecrit rien.
    if (currentReadAt && currentReadAt.getTime() >= nextReadAt.getTime()) {
      return res.json({
        success: true,
        skipped: true,
        last_read_at: currentReadAt.toISOString()
      });
    }

    await membership.update({ last_read_at: nextReadAt });
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${conversationId}`).emit('read:update', {
        conversation_id: conversationId,
        conversationId,
        user_id: String(userId),
        userId: String(userId),
        last_read_at: nextReadAt.toISOString()
      });
    }
    return res.json({ success: true, last_read_at: nextReadAt.toISOString() });
  } catch (error) {
    logger.error('❌ Erreur mark read:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.get('/invitations', authenticateToken, denySuspended, async (req, res) => {
  try {
    const userId = req.user.id;
    const memberships = await ConversationParticipant.findAll({
      where: { user_id: userId },
      include: [{
        model: Conversation,
        as: 'conversation',
        include: [{
          model: ConversationParticipant,
          as: 'participants',
          include: [{ model: User, as: 'user', attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style'] }]
        }]
      }]
    });

    const directInvitations = memberships
      .map((m) => m.conversation)
      .filter(Boolean)
      .filter((conv) => conv.type === 'direct')
      .map((conv) => ({ conv, inv: getInvitationMeta(conv) }))
      .filter(({ inv }) => inv.status === 'pending' && sameId(inv.to, userId))
      .map(({ conv, inv }) => ({
        conversation_id: conv.id,
        from_user_id: inv.from,
        message: inv.message,
        participants: (conv.participants || []).map((p) => p.user).filter(Boolean),
        created_at: conv.created_at
      }));

    const groupInvitations = memberships
      .map((m) => m.conversation)
      .filter((conv) => conv && conv.type === 'group')
      .map((conv) => ({ conv, inv: getGroupInvitationForUser(conv, userId) }))
      .filter(({ inv }) => inv.status === 'pending')
      .map(({ conv, inv }) => ({
        conversation_id: conv.id,
        type: 'group',
        from_user_id: inv.invited_by,
        message: `Invitation au groupe "${conv.title || 'Groupe'}"`,
        participants: (conv.participants || []).map((p) => p.user).filter(Boolean),
        created_at: conv.created_at
      }));

    const invitations = [...directInvitations, ...groupInvitations];

    return res.json({ success: true, invitations });
  } catch (error) {
    logger.error('❌ Erreur liste invitations:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/conversations/:conversationId/invitation/respond', authenticateToken, denySuspended, async (req, res) => {
  try {
    const userId = req.user.id;
    const conversationId = req.params.conversationId;
    const action = String(req.body?.action || '').toLowerCase();
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action invalide' });
    }

    const membership = await requireMembership(conversationId, userId);
    if (!membership) return res.status(403).json({ success: false, message: 'Accès refusé' });

    const conversation = await Conversation.findByPk(conversationId);
    if (!conversation || !['direct', 'group'].includes(conversation.type)) {
      return res.status(404).json({ success: false, message: 'Conversation introuvable' });
    }

    const accepted = action === 'accept';
    if (conversation.type === 'direct') {
      const invitation = getInvitationMeta(conversation);
      if (invitation.status !== 'pending' || !sameId(invitation.to, userId)) {
        return res.status(400).json({ success: false, message: 'Aucune invitation a traiter' });
      }

      await conversation.update({
        metadata: {
          ...(conversation.metadata || {}),
          invitation_status: accepted ? 'accepted' : 'declined',
          invitation_responded_at: new Date().toISOString()
        },
        updated_at: new Date()
      }, { silent: true });

      if (!accepted) {
        await Message.destroy({ where: { conversation_id: conversationId } });
      }

      return res.json({ success: true, status: accepted ? 'accepted' : 'declined' });
    }

    // Group invitation response
    const current = getGroupInvitationForUser(conversation, userId);
    if (current.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Aucune invitation groupe a traiter' });
    }
    const groupInvites = { ...((conversation.metadata || {}).group_invitations || {}) };
    groupInvites[String(userId)] = {
      ...(groupInvites[String(userId)] || {}),
      status: accepted ? 'accepted' : 'declined',
      responded_at: new Date().toISOString()
    };
    await conversation.update({
      metadata: {
        ...(conversation.metadata || {}),
        group_invitations: groupInvites
      },
      updated_at: new Date()
    }, { silent: true });

    return res.json({ success: true, status: accepted ? 'accepted' : 'declined', type: 'group' });
  } catch (error) {
    logger.error('❌ Erreur reponse invitation:', error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

module.exports = router;

