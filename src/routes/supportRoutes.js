const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const {
  authenticateToken,
  requireModeratorRole,
} = require('../middleware/authMiddleware');
const {
  SupportTicket,
  SupportTicketMessage,
  User,
  Notification,
  sequelize,
} = require('../models');
const { TIER, isProOrAbove } = require('../constants/subscriptionTiers');
const { maybeExpireSubscription, isSubscriptionActive } = require('../utils/subscriptionHelpers');
const logger = require('../utils/logger');

/**
 * Support — « accès direct au support », avantage mis en avant sur le palier Pro.
 *
 * ── Qui peut ouvrir un ticket ─────────────────────────────────────────────
 * TOUT LE MONDE. Ce qui est vendu avec le palier Pro, c'est le TRAITEMENT
 * PRIORITAIRE et un fil sans plafond, pas le droit de signaler un problème :
 * couper à un utilisateur gratuit le seul canal pour dire « je n'arrive plus à
 * me connecter » ou « on m'a débité deux fois » serait indéfendable, et se
 * retournerait de toute façon en signalements publics.
 *
 * La différence réelle, et elle est nette :
 *  - Pro   : priorité `high` (tête de file du staff), jusqu'à 5 tickets ouverts ;
 *  - autre : priorité `normal`, 1 seul ticket ouvert à la fois.
 */

/** Tickets simultanément ouverts, selon le palier. */
const MAX_OPEN_TICKETS_PRO = 5;
const MAX_OPEN_TICKETS_STANDARD = 1;
/** Anti-rafale : un fil de support n'est pas une messagerie instantanée. */
const MAX_MESSAGES_PER_TICKET = 100;

const OPEN_STATUSES = ['open', 'pending', 'answered'];

const VALID_CATEGORIES = ['compte', 'abonnement', 'economie', 'moderation', 'bug', 'autre'];
const VALID_STATUSES = ['open', 'pending', 'answered', 'resolved', 'closed'];

/** Attributs d'auteur exposés dans un fil — jamais l'objet User complet. */
const AUTHOR_ATTRIBUTES = ['id', 'username', 'full_name', 'avatar', 'verified', 'verification_style'];

/**
 * Palier effectif de l'utilisateur, expiration prise en compte.
 * Recalculé depuis la base et non lu dans le jeton : un jeton émis avant
 * l'expiration annoncerait encore « pro ».
 */
async function resolveTier(userId) {
  const user = await User.findByPk(userId, {
    attributes: ['id', 'premium', 'subscription_tier', 'subscription_expires_at', 'role'],
  });
  if (!user) return { tier: TIER.FREE, active: false, user: null };
  await maybeExpireSubscription(user);
  const active = isSubscriptionActive(user);
  return {
    tier: active ? user.subscription_tier : TIER.FREE,
    active,
    user,
  };
}

function isStaffRole(role) {
  return ['moderateur', 'moderator', 'admin', 'superadmin', 'super_admin', 'supermoderateur']
    .includes(String(role || '').trim().toLowerCase());
}

/**
 * Les rôles changent sans forcément invalider le JWT courant. Les routes de
 * file staff utilisaient déjà `requireModeratorRole`, qui relit la base, mais
 * les routes génériques de lecture/réponse se fiaient encore au rôle du token.
 * Résultat : un modérateur fraîchement promu voyait la file puis prenait 403 en
 * ouvrant ou en répondant au ticket. Toute décision staff passe désormais par
 * cette lecture courte et autoritaire de `users.role`.
 */
async function resolveSupportActor(req) {
  const dbUser = req.user?.id
    ? await User.findByPk(req.user.id, { attributes: ['id', 'role'] })
    : null;
  // Ne jamais restaurer un rôle privilégié depuis un token si le compte a été
  // supprimé ou n'est plus lisible : seule la ligne courante en base fait foi.
  const role = dbUser?.role || 'user';
  req.user = { ...req.user, role };
  return {
    id: req.user?.id,
    role,
    isStaff: isStaffRole(role),
  };
}

/** Délai de réponse annoncé. Une promesse tenable, pas un argument marketing. */
function slaHoursFor(priority) {
  return priority === 'high' ? 24 : 72;
}

// ── Côté utilisateur ───────────────────────────────────────────────────────

/**
 * GET /api/support/tickets
 * Mes tickets, du plus récemment actif au plus ancien.
 */
router.get('/tickets', authenticateToken, async (req, res) => {
  try {
    const { status } = req.query;
    const where = { user_id: req.user.id };
    if (status === 'open') where.status = { [Op.in]: OPEN_STATUSES };
    else if (status === 'closed') where.status = { [Op.in]: ['resolved', 'closed'] };

    const tickets = await SupportTicket.findAll({
      where,
      order: [
        [sequelize.literal('COALESCE(last_message_at, created_at)'), 'DESC'],
      ],
      limit: 50,
    });

    res.json({
      success: true,
      data: {
        tickets: tickets.map((t) => ({
          id: t.id,
          subject: t.subject,
          category: t.category,
          status: t.status,
          priority: t.priority,
          unread: t.unread_for_user,
          slaHours: slaHoursFor(t.priority),
          lastMessageAt: t.last_message_at,
          createdAt: t.createdAt,
        })),
      },
    });
  } catch (error) {
    logger.error('[Support] Liste des tickets en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible de charger tes tickets.' });
  }
});

/**
 * POST /api/support/tickets
 * Ouvre un ticket. Le premier message part avec.
 */
router.post('/tickets', authenticateToken, async (req, res) => {
  try {
    const subject = String(req.body?.subject || '').trim();
    const body = String(req.body?.message || '').trim();
    const category = VALID_CATEGORIES.includes(req.body?.category) ? req.body.category : 'autre';

    if (subject.length < 3 || subject.length > 160) {
      return res.status(400).json({ success: false, message: 'Le sujet doit faire entre 3 et 160 caractères.' });
    }
    if (body.length < 10 || body.length > 4000) {
      return res.status(400).json({ success: false, message: 'Décris ton problème en 10 à 4000 caractères.' });
    }

    const { tier } = await resolveTier(req.user.id);
    const isPro = isProOrAbove(tier);
    const maxOpen = isPro ? MAX_OPEN_TICKETS_PRO : MAX_OPEN_TICKETS_STANDARD;

    const openCount = await SupportTicket.count({
      where: { user_id: req.user.id, status: { [Op.in]: OPEN_STATUSES } },
    });
    if (openCount >= maxOpen) {
      return res.status(429).json({
        success: false,
        message: isPro
          ? `Tu as déjà ${maxOpen} tickets ouverts. Termine-en un avant d'en ouvrir un autre.`
          : 'Tu as déjà un ticket ouvert. Réponds dedans plutôt que d\'en ouvrir un second.',
        code: 'too_many_open_tickets',
      });
    }

    const priority = isPro ? 'high' : 'normal';
    const now = new Date();

    // Ticket et premier message dans la même transaction : un ticket vide dans
    // la file du staff n'a aucun intérêt et ne peut pas être traité.
    const ticket = await sequelize.transaction(async (transaction) => {
      const created = await SupportTicket.create({
        user_id: req.user.id,
        subject,
        category,
        priority,
        opened_with_tier: tier,
        status: 'open',
        last_message_at: now,
        unread_for_staff: true,
        unread_for_user: false,
        metadata: {
          platform: req.headers['user-platform'] || null,
          app_version: req.headers['x-app-version'] || null,
        },
      }, { transaction });

      await SupportTicketMessage.create({
        ticket_id: created.id,
        author_id: req.user.id,
        body,
        is_staff: false,
      }, { transaction });

      return created;
    });

    logger.info(`[Support] Ticket ${ticket.id} ouvert par ${req.user.id} (priorité ${priority}).`);

    res.status(201).json({
      success: true,
      data: {
        ticket: {
          id: ticket.id,
          subject: ticket.subject,
          category: ticket.category,
          status: ticket.status,
          priority: ticket.priority,
          slaHours: slaHoursFor(priority),
          createdAt: ticket.createdAt,
        },
      },
    });
  } catch (error) {
    logger.error('[Support] Ouverture de ticket en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible d\'ouvrir le ticket.' });
  }
});

/**
 * GET /api/support/tickets/:id
 * Le fil complet. Les notes internes du staff n'en font pas partie.
 */
router.get('/tickets/:id', authenticateToken, async (req, res) => {
  try {
    const [actor, ticket] = await Promise.all([
      resolveSupportActor(req),
      SupportTicket.findByPk(req.params.id, {
        include: [
          { model: User, as: 'user', attributes: AUTHOR_ATTRIBUTES },
          { model: User, as: 'assignee', attributes: ['id', 'username'] },
        ],
      }),
    ]);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket introuvable.' });
    }

    const staff = actor.isStaff;
    if (String(ticket.user_id) !== String(actor.id) && !staff) {
      return res.status(403).json({ success: false, message: 'Ce ticket n\'est pas le tien.' });
    }

    const where = { ticket_id: ticket.id };
    // Filtré dans la REQUÊTE et non à l'affichage : une note interne ne doit
    // jamais quitter le serveur vers un client non-staff.
    if (!staff) where.is_internal = false;

    const messages = await SupportTicketMessage.findAll({
      where,
      include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRIBUTES }],
      order: [['created_at', 'ASC']],
    });

    // Ouvrir le fil vaut lecture, pour celui des deux côtés qui l'ouvre.
    if (!staff && ticket.unread_for_user) {
      await ticket.update({ unread_for_user: false });
    } else if (staff && ticket.unread_for_staff) {
      await ticket.update({ unread_for_staff: false });
    }

    res.json({
      success: true,
      data: {
        ticket: {
          id: ticket.id,
          subject: ticket.subject,
          category: ticket.category,
          status: ticket.status,
          priority: ticket.priority,
          slaHours: slaHoursFor(ticket.priority),
          createdAt: ticket.createdAt,
          closedAt: ticket.closed_at,
          requester: staff && ticket.user
            ? {
              id: ticket.user.id,
              username: ticket.user.username,
              fullName: ticket.user.full_name,
              avatar: ticket.user.avatar,
              verified: ticket.user.verified,
            }
            : null,
          assignee: staff && ticket.assignee
            ? { id: ticket.assignee.id, username: ticket.assignee.username }
            : null,
        },
        actor: {
          isStaff: staff,
          isOwner: String(ticket.user_id) === String(actor.id),
          role: actor.role,
        },
        messages: messages.map((m) => ({
          id: m.id,
          body: m.body,
          isStaff: m.is_staff,
          isInternal: m.is_internal,
          author: m.author
            ? {
              id: m.author.id,
              username: m.author.username,
              fullName: m.author.full_name,
              avatar: m.author.avatar,
              verified: m.author.verified,
            }
            : null,
          createdAt: m.createdAt,
        })),
      },
    });
  } catch (error) {
    logger.error('[Support] Lecture de ticket en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible de charger ce ticket.' });
  }
});

/**
 * POST /api/support/tickets/:id/messages
 * Répondre dans un fil, côté utilisateur comme côté staff.
 */
router.post('/tickets/:id/messages', authenticateToken, async (req, res) => {
  try {
    const body = String(req.body?.message || '').trim();
    if (body.length < 1 || body.length > 4000) {
      return res.status(400).json({ success: false, message: 'Message vide ou trop long.' });
    }

    const [actor, ticket] = await Promise.all([
      resolveSupportActor(req),
      SupportTicket.findByPk(req.params.id),
    ]);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket introuvable.' });
    }

    const staff = actor.isStaff;
    if (String(ticket.user_id) !== String(actor.id) && !staff) {
      return res.status(403).json({ success: false, message: 'Ce ticket n\'est pas le tien.' });
    }
    if (['resolved', 'closed'].includes(ticket.status)) {
      return res.status(409).json({
        success: false,
        message: 'Ce ticket est clos. Ouvres-en un nouveau si le problème persiste.',
        code: 'ticket_closed',
      });
    }

    const messageCount = await SupportTicketMessage.count({ where: { ticket_id: ticket.id } });
    if (messageCount >= MAX_MESSAGES_PER_TICKET) {
      return res.status(429).json({
        success: false,
        message: 'Ce fil est trop long. Ouvre un nouveau ticket pour la suite.',
        code: 'thread_too_long',
      });
    }

    // `is_staff` vient du rôle vérifié en base, jamais du corps de la requête :
    // sinon n'importe qui pourrait poster une fausse réponse « officielle »
    // dans son propre fil et la capturer en écran.
    const isOwner = String(ticket.user_id) === String(actor.id);
    // Un modérateur qui parle dans SON propre ticket reste un utilisateur, sauf
    // s'il demande explicitement le mode staff. Sur le ticket d'un tiers, toute
    // réponse d'un rôle staff est automatiquement officielle.
    const actingAsStaff = staff && (!isOwner || req.body?.asStaff === true);
    const isInternal = actingAsStaff && req.body?.internal === true;

    const message = await SupportTicketMessage.create({
      ticket_id: ticket.id,
      author_id: actor.id,
      body,
      is_staff: actingAsStaff,
      is_internal: isInternal,
    });

    // Une note interne ne change ni le statut ni les pastilles : côté
    // utilisateur, il ne s'est rien passé.
    if (!isInternal) {
      await ticket.update({
        status: actingAsStaff ? 'answered' : 'pending',
        last_message_at: new Date(),
        unread_for_user: actingAsStaff,
        unread_for_staff: !actingAsStaff,
      });

      if (actingAsStaff && !isOwner) {
        // Notification uniquement vers l'utilisateur : le staff a sa file.
        await Notification.createNotification({
          recipient_id: ticket.user_id,
          type: 'system',
          title: 'Le support t\'a répondu',
          message: ticket.subject,
          priority: ticket.priority === 'high' ? 'high' : 'normal',
          metadata: { kind: 'support_reply', ticket_id: ticket.id },
        }).catch((e) => logger.warn('[Support] Notification non envoyée:', e?.message));
      }
    }

    res.status(201).json({
      success: true,
      data: {
        message: {
          id: message.id,
          body: message.body,
          isStaff: message.is_staff,
          isInternal: message.is_internal,
          createdAt: message.createdAt,
        },
        ticketStatus: ticket.status,
      },
    });
  } catch (error) {
    logger.error('[Support] Envoi de message en échec:', error);
    res.status(500).json({ success: false, message: 'Message non envoyé.' });
  }
});

/**
 * POST /api/support/tickets/:id/close
 * L'utilisateur clôt son propre ticket.
 */
router.post('/tickets/:id/close', authenticateToken, async (req, res) => {
  try {
    const [actor, ticket] = await Promise.all([
      resolveSupportActor(req),
      SupportTicket.findByPk(req.params.id),
    ]);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket introuvable.' });
    }
    if (String(ticket.user_id) !== String(actor.id) && !actor.isStaff) {
      return res.status(403).json({ success: false, message: 'Ce ticket n\'est pas le tien.' });
    }
    if (['resolved', 'closed'].includes(ticket.status)) {
      return res.json({ success: true, data: { status: ticket.status } });
    }

    await ticket.update({ status: 'closed', closed_at: new Date(), unread_for_staff: false });
    res.json({ success: true, data: { status: 'closed' } });
  } catch (error) {
    logger.error('[Support] Clôture en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible de clore ce ticket.' });
  }
});

/**
 * GET /api/support/summary
 * De quoi afficher une pastille et l'état de l'avantage, en un appel.
 */
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const { tier, user } = await resolveTier(req.user.id);
    const isPro = isProOrAbove(tier);
    const isStaff = isStaffRole(user?.role);

    const [unread, open] = await Promise.all([
      SupportTicket.count({
        where: isStaff
          ? { unread_for_staff: true, status: { [Op.in]: OPEN_STATUSES } }
          : { user_id: req.user.id, unread_for_user: true },
      }),
      SupportTicket.count({
        where: isStaff
          ? { status: { [Op.in]: OPEN_STATUSES } }
          : { user_id: req.user.id, status: { [Op.in]: OPEN_STATUSES } },
      }),
    ]);

    res.json({
      success: true,
      data: {
        unreadTickets: unread,
        openTickets: open,
        priority: isPro ? 'high' : 'normal',
        slaHours: slaHoursFor(isPro ? 'high' : 'normal'),
        maxOpenTickets: isPro ? MAX_OPEN_TICKETS_PRO : MAX_OPEN_TICKETS_STANDARD,
        isPro,
        isStaff,
        staffRole: isStaff ? user.role : null,
      },
    });
  } catch (error) {
    logger.error('[Support] Résumé en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible de charger l\'état du support.' });
  }
});

// ── Côté staff ─────────────────────────────────────────────────────────────

/**
 * GET /api/support/admin/queue
 * La file de travail : prioritaires d'abord, puis les plus anciens.
 */
router.get('/admin/queue', authenticateToken, requireModeratorRole, async (req, res) => {
  try {
    const { status = 'open', limit = 50 } = req.query;
    const where = {};
    if (status === 'open') where.status = { [Op.in]: OPEN_STATUSES };
    else if (VALID_STATUSES.includes(status)) where.status = status;

    const tickets = await SupportTicket.findAll({
      where,
      include: [
        { model: User, as: 'user', attributes: AUTHOR_ATTRIBUTES.concat(['subscription_tier']) },
        { model: User, as: 'assignee', attributes: ['id', 'username'] },
      ],
      order: [
        // `high` avant `normal` : c'est exactement l'avantage vendu.
        // Les colonnes doivent être qualifiées : les jointures `user` et
        // `assignee` ont elles aussi un `created_at`, que PostgreSQL juge sinon
        // ambigu et refuse avec une erreur 500.
        [sequelize.literal("CASE WHEN \"SupportTicket\".\"priority\" = 'high' THEN 0 ELSE 1 END"), 'ASC'],
        [sequelize.literal('COALESCE("SupportTicket"."last_message_at", "SupportTicket"."created_at")'), 'ASC'],
      ],
      limit: Math.min(parseInt(limit, 10) || 50, 200),
    });

    res.json({
      success: true,
      data: {
        tickets: tickets.map((t) => ({
          id: t.id,
          subject: t.subject,
          category: t.category,
          status: t.status,
          priority: t.priority,
          unreadForStaff: t.unread_for_staff,
          slaHours: slaHoursFor(t.priority),
          user: t.user
            ? {
              id: t.user.id,
              username: t.user.username,
              tier: t.user.subscription_tier,
            }
            : null,
          assignee: t.assignee ? { id: t.assignee.id, username: t.assignee.username } : null,
          lastMessageAt: t.last_message_at,
          createdAt: t.createdAt,
        })),
      },
    });
  } catch (error) {
    logger.error('[Support] File staff en échec:', error);
    res.status(500).json({ success: false, message: 'Impossible de charger la file.' });
  }
});

/**
 * PATCH /api/support/admin/tickets/:id
 * Assignation et changement de statut.
 */
router.patch('/admin/tickets/:id', authenticateToken, requireModeratorRole, async (req, res) => {
  try {
    const ticket = await SupportTicket.findByPk(req.params.id);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket introuvable.' });
    }

    const updates = {};
    if (req.body?.status) {
      if (!VALID_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ success: false, message: 'Statut inconnu.' });
      }
      updates.status = req.body.status;
      if (['resolved', 'closed'].includes(req.body.status)) {
        updates.closed_at = new Date();
        updates.unread_for_user = true;
      }
    }
    if (req.body?.assignToMe === true) updates.assigned_to = req.user.id;
    if (req.body?.assignToMe === false) updates.assigned_to = null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'Rien à mettre à jour.' });
    }

    await ticket.update(updates);
    res.json({ success: true, data: { status: ticket.status, assignedTo: ticket.assigned_to } });
  } catch (error) {
    logger.error('[Support] Mise à jour staff en échec:', error);
    res.status(500).json({ success: false, message: 'Mise à jour impossible.' });
  }
});

module.exports = router;
