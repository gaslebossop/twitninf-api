'use strict';

/**
 * Outils d'administration et de modération pour PolicierCongo V3.
 *
 * Contrairement à platformTools.js (actions sur le compte PolicierCongo
 * lui-même : poster, aimer, republier), ce module agit sur LES AUTRES
 * comptes et contenus de la plateforme : bannir, suspendre, modérer un
 * tweet, traiter un signalement, une demande de vérification, un ticket de
 * débannissement.
 *
 * Chaque outil s'appuie sur un chemin de code réellement fonctionnel et
 * déjà utilisé en production (moderationController, VerificationRequest,
 * BanService, similarity/index.js). Volontairement absents :
 *  - `markTweetNotEligible` tel quel : son log ModerationAction utilise
 *    type='mark_not_eligible', absent de l'ENUM Postgres réel
 *    ('ban','suspend','delete','warn','approve','reject') — l'appel lève une
 *    erreur de validation à chaque utilisation dans le code existant. Ici,
 *    le statut 'not_eligible' est appliqué mais journalisé sous type='reject'
 *    (avec la vraie valeur en metadata) pour rester dans l'ENUM valide.
 *  - promote/demoteModerator, updateModeratorPermissions, get/updateModerationConfig,
 *    getModerators : stubs qui ne touchent pas la base dans le code existant.
 *  - toute notion de "mute" ou d'historique de connexions/IP : aucune colonne
 *    ni table n'existe pour ça.
 */

const { Op } = require('sequelize');
const { POLICE_ACCOUNT_ID } = require('../config');
const { TOOL_RISK } = require('./constants');
const { publicUser, publicTweet, resolveUser, UUID, object } = require('./platformTools');
const { asPlain, clip } = require('./utils');

const REASON = { type: 'string', minLength: 3, maxLength: 1000 };

/** Résout en une seule requête les comptes référencés par une liste de lignes. */
async function attachUserLabels(models, rows, idField, targetKey = 'target_user') {
  const ids = [...new Set(rows.map(row => row[idField]).filter(Boolean))];
  if (!ids.length) return rows.map(row => ({ ...row, [targetKey]: null }));
  const users = await models.User.findAll({ where: { id: { [Op.in]: ids } } });
  const byId = new Map(users.map(user => [user.id, publicUser(user)]));
  return rows.map(row => ({ ...row, [targetKey]: byId.get(row[idField]) || null }));
}

function requireNotSelf(userId, action) {
  if (String(userId) === String(POLICE_ACCOUNT_ID)) {
    throw new Error(`${action} refusé : impossible de cibler le compte PolicierCongo lui-même.`);
  }
}

async function logModerationAction(models, { type, targetType, targetId, reason, status = 'active', duration = null, expiresAt = null, metadata = {} }) {
  return models.ModerationAction.create({
    type, target_type: targetType, target_id: targetId, moderator_id: POLICE_ACCOUNT_ID,
    reason: reason || null, duration, status, expires_at: expiresAt, metadata
  });
}

function registerAdminModerationTools(registry, { models }) {
  const register = definition => registry.register(definition);

  // ─────────────────────────────────────────────────────── comptes : sanctions

  register({
    name: 'ban_user', risk: TOOL_RISK.DESTRUCTIVE, idempotent: false,
    description: 'Bannit un compte de façon permanente (accès bloqué indéfiniment). Action lourde et difficile à faire oublier socialement : réserve-la aux violations graves et confirmées, jamais à un simple désaccord. Journalisée et réversible via unban_user.',
    inputSchema: object({ target: { type: 'string', maxLength: 100 }, reason: REASON }, ['target', 'reason']),
    handler: async ({ target, reason }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error(`Compte introuvable: ${target}`);
      requireNotSelf(user.id, 'Bannissement');
      await user.update({ is_suspended: true, suspended_at: new Date(), suspended_until: null, suspension_reason: reason });
      await logModerationAction(models, { type: 'ban', targetType: 'user', targetId: user.id, reason, duration: null, metadata: { permanent: true } });
      return { banned: true, permanent: true, user: publicUser(user) };
    }
  });

  register({
    name: 'suspend_user', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Suspend un compte temporairement, en heures. Moins lourd et plus facilement réversible qu’un bannissement : préfère cet outil pour une première sanction ou une violation modérée.',
    inputSchema: object({
      target: { type: 'string', maxLength: 100 },
      duration_hours: { type: 'integer', minimum: 1, maximum: 8760 },
      reason: REASON
    }, ['target', 'duration_hours', 'reason']),
    handler: async ({ target, duration_hours, reason }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error(`Compte introuvable: ${target}`);
      requireNotSelf(user.id, 'Suspension');
      const until = new Date(Date.now() + duration_hours * 3600000);
      await user.update({ is_suspended: true, suspended_at: new Date(), suspended_until: until, suspension_reason: reason });
      await logModerationAction(models, { type: 'suspend', targetType: 'user', targetId: user.id, reason, duration: duration_hours, expiresAt: until, status: 'active' });
      return { suspended: true, until: until.toISOString(), user: publicUser(user) };
    }
  });

  register({
    name: 'unban_user', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Lève toute suspension ou bannissement en cours sur un compte, temporaire ou permanent. Utilise le même mécanisme que ban_user/suspend_user en sens inverse.',
    inputSchema: object({ target: { type: 'string', maxLength: 100 }, reason: REASON }, ['target', 'reason']),
    handler: async ({ target, reason }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error(`Compte introuvable: ${target}`);
      if (!user.is_suspended) return { already_clean: true, user: publicUser(user) };
      await user.update({ is_suspended: false, suspended_at: null, suspended_until: null, suspension_reason: null });
      await logModerationAction(models, { type: 'approve', targetType: 'user', targetId: user.id, reason, status: 'reversed', metadata: { action_type: 'unban' } });
      return { unbanned: true, user: publicUser(user) };
    }
  });

  register({
    name: 'warn_user', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Enregistre un avertissement officiel sur un compte, sans le sanctionner. Si notify=true, envoie aussi un MP expliquant l’avertissement — le seul effet visible pour la personne.',
    inputSchema: object({
      target: { type: 'string', maxLength: 100 }, reason: REASON, notify: { type: 'boolean' }
    }, ['target', 'reason']),
    handler: async ({ target, reason, notify = true }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error(`Compte introuvable: ${target}`);
      requireNotSelf(user.id, 'Avertissement');
      await logModerationAction(models, { type: 'warn', targetType: 'user', targetId: user.id, reason });
      let notified = false;
      if (notify) {
        const messagingManager = require('../messagingManager');
        await messagingManager.sendPrivateMessage(user.id, `Avertissement officiel : ${reason}`).then(() => { notified = true; }).catch(() => {});
      }
      return { warned: true, notified, user: publicUser(user) };
    }
  });

  // ────────────────────────────────────────────────────────── comptes : lecture

  register({
    name: 'search_users', risk: TOOL_RISK.READ,
    description: 'Recherche des comptes par critères combinés : texte (username/nom/bio), rôle, statut de suspension, vérification, premium, nombre de bans minimum, date d’inscription. Utile pour retrouver des comptes à risque sans connaître leur identifiant.',
    inputSchema: object({
      text: { type: 'string', maxLength: 200 },
      role: { type: 'string', enum: ['user', 'moderateur', 'admin', 'superadmin', 'classeurdetweets', 'economiegardien'] },
      is_suspended: { type: 'boolean' },
      verified: { type: 'boolean' },
      premium: { type: 'boolean' },
      min_ban_count: { type: 'integer', minimum: 0 },
      created_before: { type: 'string' },
      created_after: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    }),
    handler: async (args) => {
      const where = {};
      if (args.text) {
        const needle = `%${args.text}%`;
        where[Op.or] = [{ username: { [Op.iLike]: needle } }, { full_name: { [Op.iLike]: needle } }, { bio: { [Op.iLike]: needle } }];
      }
      if (args.role) where.role = args.role;
      if (args.is_suspended !== undefined) where.is_suspended = args.is_suspended;
      if (args.verified !== undefined) where.verified = args.verified;
      if (args.premium !== undefined) where.premium = args.premium;
      if (Number.isFinite(args.min_ban_count)) where.ban_count = { [Op.gte]: args.min_ban_count };
      if (args.created_before || args.created_after) {
        where.created_at = {};
        if (args.created_before) where.created_at[Op.lte] = new Date(args.created_before);
        if (args.created_after) where.created_at[Op.gte] = new Date(args.created_after);
      }
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      const users = await models.User.findAll({ where, order: [['created_at', 'DESC']], limit });
      return { count: users.length, users: users.map(publicUser) };
    }
  });

  register({
    name: 'get_bot_reputation', risk: TOOL_RISK.READ,
    description: 'Lit le score de réputation anti-bot d’un compte (last_score, moyenne 30 jours, niveau de confiance). Signal utile avant une décision de modération, pas une preuve à lui seul.',
    inputSchema: object({ target: { type: 'string', maxLength: 100 } }, ['target']),
    handler: async ({ target }) => {
      const user = await resolveUser(models, target);
      if (!user) return { found: false };
      const reputation = await models.BotReputation.findByPk(user.id);
      return { found: true, user: publicUser(user), reputation: reputation ? asPlain(reputation) : null };
    }
  });

  // ─────────────────────────────────────────────────────────────── tweets

  register({
    name: 'moderate_tweet', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Change le statut de modération d’un tweet : approved (visible et recommandable), rejected (« banni » — reste visible sur le profil de l’auteur mais sort des recherches et recommandations), ou not_eligible (visible mais exclu des recommandations, sanction plus légère que rejected). Ne supprime rien.',
    inputSchema: object({
      tweet_id: UUID,
      status: { type: 'string', enum: ['approved', 'rejected', 'not_eligible'] },
      reason: { type: 'string', maxLength: 1000 }
    }, ['tweet_id', 'status']),
    handler: async ({ tweet_id, status, reason }) => {
      const tweet = await models.Tweet.findByPk(tweet_id, { include: [{ model: models.User, as: 'author' }] });
      if (!tweet) throw new Error('Tweet introuvable');
      if (status !== 'approved' && !reason) throw new Error('Une raison est requise pour rejeter ou exclure un tweet');
      const previousStatus = tweet.moderation_status;
      await tweet.update({ moderation_status: status, moderation_reason: reason || null });

      // 'not_eligible' n'existe pas dans l'ENUM de ModerationAction.type : on
      // journalise sous 'reject', le vrai statut appliqué reste en metadata.
      const logType = status === 'approved' ? 'approve' : 'reject';
      await logModerationAction(models, {
        type: logType, targetType: 'tweet', targetId: tweet_id, reason,
        metadata: { applied_status: status, previous_status: previousStatus }
      });

      if (status === 'approved') {
        // Best-effort : réintègre le tweet au moteur de recommandation progressive,
        // comme le fait l'approbation manuelle existante. Une erreur ici ne doit
        // pas annuler le changement de statut déjà appliqué.
        try {
          const ProgressiveRecommendationEngine = require('../../progressiveRecommendationEngine');
          await new ProgressiveRecommendationEngine().addNewTweet(tweet_id);
        } catch (_) { /* non bloquant */ }
      }
      return { moderated: true, status, tweet: publicTweet(tweet) };
    }
  });

  register({
    name: 'admin_delete_tweet', risk: TOOL_RISK.DESTRUCTIVE, idempotent: false,
    description: 'Supprime (soft-delete, récupérable en base) le tweet de N’IMPORTE QUEL compte, contrairement à delete_own_tweet qui n’agit que sur les tweets de PolicierCongo. Réservé aux contenus qui doivent disparaître, pas seulement sortir des recommandations — pour ça, préfère moderate_tweet.',
    inputSchema: object({ tweet_id: UUID, reason: REASON }, ['tweet_id', 'reason']),
    handler: async ({ tweet_id, reason }) => {
      const tweet = await models.Tweet.findByPk(tweet_id);
      if (!tweet) throw new Error('Tweet introuvable');
      await logModerationAction(models, {
        type: 'delete', targetType: 'tweet', targetId: tweet_id, reason,
        metadata: { content_preview: clip(tweet.content || '', 200), author_id: tweet.user_id }
      });
      await tweet.destroy();
      return { deleted: true, tweet_id, soft_delete: true };
    }
  });

  register({
    name: 'pin_own_tweet', risk: TOOL_RISK.WRITE, idempotent: false,
    description: 'Épingle ou désépingle un tweet de PolicierCongo sur son propre profil. N’agit que sur les tweets appartenant au compte PolicierCongo.',
    inputSchema: object({ tweet_id: UUID, pinned: { type: 'boolean' } }, ['tweet_id', 'pinned']),
    handler: async ({ tweet_id, pinned }) => {
      const tweet = await models.Tweet.findByPk(tweet_id);
      if (!tweet) throw new Error('Tweet introuvable');
      if (String(tweet.user_id) !== String(POLICE_ACCOUNT_ID)) throw new Error('pin_own_tweet ne peut épingler qu’un tweet appartenant à PolicierCongo');
      await tweet.update({ is_pinned: pinned });
      return { pinned, tweet: publicTweet(tweet) };
    }
  });

  // ────────────────────────────────────────────────────────────── signalements

  register({
    name: 'list_reports', risk: TOOL_RISK.READ,
    description: 'Liste les signalements (tweets ou comptes) avec filtres statut/type/gravité/cible. File d’attente de modération : à consulter avant une décision plutôt qu’à partir d’une simple impression.',
    inputSchema: object({
      statuses: { type: 'array', items: { type: 'string', enum: ['pending', 'investigating', 'resolved', 'dismissed'] }, maxItems: 4 },
      target_type: { type: 'string', enum: ['tweet', 'user', 'comment'] },
      target_id: { type: 'string', maxLength: 100 },
      severities: { type: 'array', items: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, maxItems: 4 },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    }),
    handler: async (args) => {
      const where = {};
      if (Array.isArray(args.statuses) && args.statuses.length) where.status = { [Op.in]: args.statuses };
      if (args.target_type) where.target_type = args.target_type;
      if (args.target_id) where.target_id = args.target_id;
      if (Array.isArray(args.severities) && args.severities.length) where.severity = { [Op.in]: args.severities };
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 25));
      const rows = await models.Report.findAll({ where, order: [['priority', 'DESC'], ['created_at', 'DESC']], limit, raw: true });
      const withReporter = await attachUserLabels(models, rows, 'reporter_id', 'reporter');
      return { count: withReporter.length, reports: withReporter };
    }
  });

  register({
    name: 'resolve_report', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Clôt un signalement : status=resolved (une action a été prise, précise laquelle dans resolution_action) ou dismissed (signalement non fondé). Ne sanctionne personne par lui-même — applique d’abord la sanction avec l’outil adapté si nécessaire.',
    inputSchema: object({
      report_id: UUID,
      status: { type: 'string', enum: ['investigating', 'resolved', 'dismissed'] },
      resolution_action: { type: 'string', enum: ['none', 'warn', 'suspend', 'ban', 'delete'] },
      notes: { type: 'string', maxLength: 1000 }
    }, ['report_id', 'status']),
    handler: async ({ report_id, status, resolution_action, notes }) => {
      const report = await models.Report.findByPk(report_id);
      if (!report) throw new Error('Signalement introuvable');
      const patch = { status, moderator_notes: notes || report.moderator_notes };
      if (['resolved', 'dismissed'].includes(status)) {
        patch.resolved_at = new Date();
        patch.resolved_by = POLICE_ACCOUNT_ID;
        patch.resolution_action = resolution_action || 'none';
        patch.resolution_reason = notes || null;
      }
      await report.update(patch);
      return { resolved: status !== 'investigating', report: asPlain(report) };
    }
  });

  register({
    name: 'get_moderation_history', risk: TOOL_RISK.READ,
    description: 'Lit l’historique des actions de modération (bans, suspensions, suppressions, avertissements, approbations, rejets) déjà appliquées à un compte ou un tweet précis. À consulter avant de sanctionner à nouveau, pour éviter une double sanction ou ignorer un contexte déjà connu.',
    inputSchema: object({
      target_type: { type: 'string', enum: ['user', 'tweet', 'comment'] },
      target_id: { type: 'string', maxLength: 100 },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    }, ['target_type', 'target_id']),
    handler: async ({ target_type, target_id, limit = 30 }) => {
      const rows = await models.ModerationAction.findAll({
        where: { target_type, target_id }, order: [['created_at', 'DESC']], limit: Math.max(1, Math.min(100, limit)), raw: true
      });
      const withModerator = await attachUserLabels(models, rows, 'moderator_id', 'moderator');
      return { count: withModerator.length, actions: withModerator };
    }
  });

  // ──────────────────────────────────────────────────────────── vérification

  register({
    name: 'verify_user_directly', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Accorde le badge vérifié à un compte sans passer par une demande de vérification. Réservé aux cas évidents (personnalité publique confirmée, organisation identifiée) ; sinon préfère approve_verification_request sur une vraie demande.',
    inputSchema: object({ target: { type: 'string', maxLength: 100 }, reason: REASON }, ['target', 'reason']),
    handler: async ({ target, reason }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error(`Compte introuvable: ${target}`);
      if (user.verified) return { already_verified: true, user: publicUser(user) };
      await user.update({ verified: true });
      await logModerationAction(models, { type: 'approve', targetType: 'user', targetId: user.id, reason, metadata: { action_type: 'verify' } });
      return { verified: true, user: publicUser(user) };
    }
  });

  register({
    name: 'unverify_user', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Retire le badge vérifié d’un compte (badge usurpé, obtenu par erreur, ou motif devenu invalide). Ne touche pas aux demandes de vérification existantes.',
    inputSchema: object({ target: { type: 'string', maxLength: 100 }, reason: REASON }, ['target', 'reason']),
    handler: async ({ target, reason }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error(`Compte introuvable: ${target}`);
      requireNotSelf(user.id, 'Retrait de vérification');
      if (!user.verified) return { already_unverified: true, user: publicUser(user) };
      await user.update({ verified: false });
      await logModerationAction(models, { type: 'reject', targetType: 'user', targetId: user.id, reason, metadata: { action_type: 'unverify' } });
      return { unverified: true, user: publicUser(user) };
    }
  });

  register({
    name: 'set_verification_style', risk: TOOL_RISK.SENSITIVE, idempotent: true,
    description: 'Change le style visuel du badge d’un compte déjà vérifié : default, rose (ex. certification spéciale de type prix de concours), gray ou gold. Ne touche pas au booléen verified — si le compte n’est pas encore vérifié, attribue d’abord le badge via verify_user_directly ou approve_verification_request.',
    inputSchema: object({
      target: { type: 'string', maxLength: 100 },
      style: { type: 'string', enum: ['default', 'rose', 'gray', 'gold'] },
      reason: REASON
    }, ['target', 'style', 'reason']),
    handler: async ({ target, style, reason }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error(`Compte introuvable: ${target}`);
      if (!user.verified) throw new Error('Ce compte n’est pas vérifié : attribue d’abord le badge (verify_user_directly ou approve_verification_request) avant de choisir son style.');
      const previousStyle = user.verification_style;
      if (previousStyle === style) return { styled: true, unchanged: true, style, user: { ...publicUser(user), verification_style: style } };
      await user.update({ verification_style: style });
      await logModerationAction(models, {
        type: 'approve', targetType: 'user', targetId: user.id, reason,
        metadata: { action_type: 'verification_style', previous_style: previousStyle, new_style: style }
      });
      return { styled: true, style, user: { ...publicUser(user), verification_style: style } };
    }
  });

  register({
    name: 'approve_verification_request', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Approuve une demande de vérification en attente. Vérifie d’abord son contenu avec get_verification_requests (include_form_data=true) avant de décider.',
    inputSchema: object({ request_id: UUID, reason: { type: 'string', maxLength: 500 } }, ['request_id']),
    handler: async ({ request_id, reason }) => {
      const request = await models.VerificationRequest.findByPk(request_id);
      if (!request) throw new Error('Demande de vérification introuvable');
      if (request.status !== 'pending' && request.status !== 'under_review') throw new Error(`Demande déjà traitée (status=${request.status})`);
      await request.approve(POLICE_ACCOUNT_ID, reason || null);
      return { approved: true, request_id };
    }
  });

  register({
    name: 'reject_verification_request', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Rejette une demande de vérification en attente, avec une raison compréhensible par la personne qui l’a soumise.',
    inputSchema: object({ request_id: UUID, reason: { type: 'string', minLength: 5, maxLength: 500 } }, ['request_id', 'reason']),
    handler: async ({ request_id, reason }) => {
      const request = await models.VerificationRequest.findByPk(request_id);
      if (!request) throw new Error('Demande de vérification introuvable');
      if (request.status !== 'pending' && request.status !== 'under_review') throw new Error(`Demande déjà traitée (status=${request.status})`);
      await request.reject(POLICE_ACCOUNT_ID, reason);
      return { rejected: true, request_id };
    }
  });

  // ──────────────────────────────────────────────────────── tickets de recours

  register({
    name: 'get_unban_tickets', risk: TOOL_RISK.READ,
    description: 'Liste les tickets de demande de débannissement soumis par des comptes suspendus/bannis, avec leur statut.',
    inputSchema: object({
      status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    }),
    handler: async ({ status, limit = 30 }) => {
      const rows = await models.UnbanTicket.findAll({
        where: status ? { status } : {}, order: [['created_at', 'DESC']], limit: Math.max(1, Math.min(100, limit)), raw: true
      });
      const withUser = await attachUserLabels(models, rows, 'user_id', 'user');
      return { count: withUser.length, tickets: withUser };
    }
  });

  register({
    name: 'process_unban_ticket', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Approuve ou rejette un ticket de débannissement. L’approbation lève automatiquement la suspension/le bannissement du compte concerné ; le rejet ne change rien à son statut.',
    inputSchema: object({
      ticket_id: UUID,
      decision: { type: 'string', enum: ['approved', 'rejected'] },
      notes: { type: 'string', maxLength: 1000 }
    }, ['ticket_id', 'decision']),
    handler: async ({ ticket_id, decision, notes }) => {
      const ticket = await models.UnbanTicket.findByPk(ticket_id);
      if (!ticket) throw new Error('Ticket introuvable');
      if (ticket.status !== 'pending') throw new Error(`Ticket déjà traité (status=${ticket.status})`);
      await ticket.update({ status: decision, admin_notes: notes || null, processed_by: POLICE_ACCOUNT_ID, processed_at: new Date() });
      if (decision === 'approved') {
        const user = await models.User.findByPk(ticket.user_id);
        if (user?.is_suspended) {
          await user.update({ is_suspended: false, suspended_at: null, suspended_until: null, suspension_reason: null });
          await logModerationAction(models, {
            type: 'approve', targetType: 'user', targetId: ticket.user_id, reason: notes || 'Ticket de débannissement approuvé',
            status: 'reversed', metadata: { action_type: 'unban', ticket_id }
          });
        }
      }
      return { processed: true, decision, ticket_id };
    }
  });

  // ─────────────────────────────────────────────────────────── visibilité

  register({
    name: 'set_shadow_visibility', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Ajuste la portée algorithmique d’un compte sans le bannir : multiplicateur 0 (invisible des recommandations) à 5 (favorisé), 1 étant la normale. Effet silencieux pour la personne concernée — à documenter précisément dans reason.',
    inputSchema: object({ target: { type: 'string', maxLength: 100 }, multiplier: { type: 'number', minimum: 0, maximum: 5 }, reason: REASON }, ['target', 'multiplier', 'reason']),
    handler: async ({ target, multiplier, reason }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error(`Compte introuvable: ${target}`);
      requireNotSelf(user.id, 'Ajustement de visibilité');
      const previous = Number(user.algorithmic_visibility_multiplier ?? 1);
      await user.update({ algorithmic_visibility_multiplier: multiplier });
      try {
        const similarity = require('../../similarity');
        await similarity.reloadShadowbanMaps();
      } catch (_) { /* le moteur peut être hors service sans bloquer l'écriture DB */ }
      await logModerationAction(models, {
        type: multiplier < 1 ? 'suspend' : 'approve', targetType: 'user', targetId: user.id, reason,
        metadata: { action_type: 'shadow_visibility', previous_multiplier: previous, new_multiplier: multiplier }
      });
      return { updated: true, previous_multiplier: previous, new_multiplier: multiplier, user: publicUser(user) };
    }
  });

  register({
    name: 'recalculate_user_recommendations', risk: TOOL_RISK.WRITE, idempotent: false,
    description: 'Recalcule le vecteur d’interactions d’un compte à partir de la vérité en base (likes, reposts, commentaires, posts). Action de resynchronisation inoffensive et idempotente, utile après une suppression massive de contenu ou un comportement de recommandation qui semble désynchronisé.',
    inputSchema: object({ target: { type: 'string', maxLength: 100 } }, ['target']),
    handler: async ({ target }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error(`Compte introuvable: ${target}`);
      const similarity = require('../../similarity');
      const engine = similarity.getEngine();
      if (!engine) throw new Error('Moteur de recommandation indisponible');
      const ok = await engine.recalculateUserVector(user.id, models);
      if (!ok) throw new Error('Le recalcul a échoué côté moteur de recommandation');
      return { recalculated: true, user: publicUser(user) };
    }
  });

  // ─────────────────────────────────────────────────── algorithme (superadmin)

  register({
    name: 'get_algorithm_config', risk: TOOL_RISK.READ,
    description: 'Lit la configuration actuelle du moteur de recommandation (poids, fenêtres, seuils) et ses statistiques d’exécution.',
    inputSchema: object({}),
    handler: async () => {
      const similarity = require('../../similarity');
      const config = similarity.getAlgorithmConfig();
      if (!config) throw new Error('Moteur de recommandation indisponible');
      return { config, stats: similarity.getAlgorithmAdminStats() };
    }
  });

  register({
    name: 'update_algorithm_config', risk: TOOL_RISK.DESTRUCTIVE, idempotent: false,
    description: 'Modifie en direct des paramètres du moteur de recommandation (poids, fenêtres, seuils) pour TOUTE la plateforme. Blast radius maximal : chaque champ non fourni reste inchangé, mais toute valeur fournie s’applique immédiatement à tous les comptes. Vérifie get_algorithm_config avant et après.',
    inputSchema: object({
      weights: { type: 'object', properties: {} },
      coldStartWeights: { type: 'object', properties: {} },
      interactionWeights: { type: 'object', properties: {} },
      similarUsersK: { type: 'integer', minimum: 5, maximum: 300 },
      discoveryWindowH: { type: 'integer', minimum: 6, maximum: 168 },
      discoveryMinRatio: { type: 'number', minimum: 0.02, maximum: 0.5 },
      freshnessHalfLifeH: { type: 'integer', minimum: 1, maximum: 168 },
      maxSameAuthorWindow: { type: 'integer', minimum: 1, maximum: 10 },
      authorDiversityWindow: { type: 'integer', minimum: 5, maximum: 50 }
    }),
    handler: async (patch) => {
      const similarity = require('../../similarity');
      const before = similarity.getAlgorithmConfig();
      if (!before) throw new Error('Moteur de recommandation indisponible');
      const result = similarity.applyAlgorithmConfig(patch);
      if (!result?.success) throw new Error(result?.message || 'Application de la configuration refusée');
      return { updated: true, previous: before, applied_patch: patch, config: similarity.getAlgorithmConfig() };
    }
  });

  return registry;
}

module.exports = { registerAdminModerationTools };
