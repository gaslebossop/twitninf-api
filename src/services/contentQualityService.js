/**
 * Qualité de publication : ce qui arrive au COMPTE quand un contenu est
 * retiré ou écarté des recommandations.
 *
 * Le trou que ce service comble : jusqu'ici, un avertissement daté n'était
 * posé qu'à un seul endroit — un modérateur humain clôturant un signalement
 * (`moderationController`). Un tweet supprimé par la modération hors
 * signalement, ou rendu non éligible par l'algorithme, ne laissait aucune
 * trace sur le compte. On pouvait donc en accumuler indéfiniment sans que
 * rien ne change.
 *
 * Le modèle retenu, dans l'esprit de l'application des règles chez TikTok :
 *
 * - **Un fait isolé ne sanctionne pas.** Il informe. Quelqu'un qui découvre
 *   ce qui passe et ce qui ne passe pas n'est pas quelqu'un qui triche.
 * - **La récidive, si.** Un second fait dans une fenêtre glissante de 14
 *   jours pose une restriction COURTE et ANNONCÉE : `monitoring` (×0,85 sur
 *   la portée) pendant 24 h.
 * - **L'escalade est douce mais réelle.** 1 jour, puis 3, puis 7. Au-delà,
 *   ce n'est plus un accident de parcours : un vrai avertissement daté entre
 *   au registre du moteur Rust, avec ses seuils par domaine et son expiration
 *   à 90 jours.
 * - **Rien n'est silencieux.** Chaque marche produit une notification, et
 *   l'écran « État du compte » dit ce qui s'est passé et quand ça se lève. Un
 *   shadowban muet ne corrige aucun comportement : il fabrique de la
 *   paranoïa.
 *
 * Aucun changement côté Rust n'est nécessaire : `setShadowban` accepte déjà
 * une décision manuelle à expiration, et elle prime sur le calcul automatique
 * du registre.
 */

const { sequelize } = require('../database/index');
const rustClient = require('./rustRecommenderClient');
const { getSettings } = require('../economy/creatorPool/settings');
const logger = require('../utils/logger');

/** Natures d'événement qui comptent dans la récidive. */
const KIND = {
  /** Tweet retiré par un modérateur, hors signalement résolu (qui pose déjà un vrai avertissement). */
  MODERATOR_DELETE: 'moderator_delete',
  /** Tweet publié mais écarté des recommandations par l'algorithme. */
  NOT_ELIGIBLE: 'not_eligible',
};

const KIND_LABELS = {
  [KIND.MODERATOR_DELETE]: 'Publication retirée par la modération',
  [KIND.NOT_ELIGIBLE]: 'Publication écartée des recommandations',
};

class ContentQualityService {
  /**
   * Enregistre un fait et applique la conséquence qui en découle.
   *
   * Ne lève jamais : c'est un effet de bord d'une action déjà décidée
   * (publier, modérer). Un moteur Rust indisponible ou une table absente ne
   * doivent pas faire échouer la publication d'un tweet — mais la perte doit
   * se voir dans les journaux.
   */
  static async record({ userId, tweetId = null, kind, reason = null, metadata = null }) {
    if (!userId || !Object.values(KIND).includes(kind)) {
      logger.warn(`[contentQuality] fait ignoré (userId=${userId}, kind=${kind})`);
      return { recorded: false };
    }

    try {
      const inserted = await this.insertEvent({ userId, tweetId, kind, reason, metadata });
      if (!inserted) {
        // Déjà connu pour ce tweet : une reprise de file ou une décision de
        // modération rejouée ne fabrique pas une récidive.
        return { recorded: false, duplicate: true };
      }

      const settings = await getSettings();
      const occurrence = await this.countInWindow(userId, settings.quality.recurrenceWindowDays);

      const outcome = await this.applyConsequence({
        userId,
        tweetId,
        kind,
        reason,
        occurrence,
        settings,
      });

      return { recorded: true, occurrence, ...outcome };
    } catch (error) {
      logger.error(`[contentQuality] fait non traité pour ${userId} (${kind}): ${error.message}`);
      return { recorded: false, error: error.message };
    }
  }

  /**
   * @returns {boolean} vrai si la ligne est neuve — l'index unique
   * `(tweet_id, kind)` absorbe silencieusement les doublons.
   */
  static async insertEvent({ userId, tweetId, kind, reason, metadata }) {
    const rows = await sequelize.query(
      `INSERT INTO content_quality_events (id, user_id, tweet_id, kind, reason, metadata, occurred_at)
       VALUES (gen_random_uuid(), :userId, :tweetId, :kind, :reason, CAST(:metadata AS jsonb), NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      {
        replacements: {
          userId,
          tweetId: tweetId || null,
          kind,
          reason: reason ? String(reason).slice(0, 1000) : null,
          metadata: JSON.stringify(metadata || {}),
        },
        type: sequelize.QueryTypes.INSERT,
      }
    );
    const returned = Array.isArray(rows) ? rows[0] : rows;
    return Array.isArray(returned) ? returned.length > 0 : !!returned;
  }

  /** Nombre de faits dans la fenêtre glissante, celui qui vient d'être posé compris. */
  static async countInWindow(userId, windowDays) {
    const [row] = await sequelize.query(
      `SELECT COUNT(*) AS count
       FROM content_quality_events
       WHERE user_id = :userId
         AND occurred_at >= NOW() - (:windowDays * INTERVAL '1 day')`,
      { replacements: { userId, windowDays }, type: sequelize.QueryTypes.SELECT }
    );
    return parseInt(row?.count, 10) || 0;
  }

  /**
   * Traduit un rang de récidive en conséquence.
   *
   * `occurrence === 1` : rien qu'une notification.
   * `occurrence >= 2`  : restriction `monitoring` de N jours, N venant de
   *                      l'escalade configurée.
   * Au-delà de la dernière marche : avertissement daté au registre Rust.
   */
  static async applyConsequence({ userId, tweetId, kind, reason, occurrence, settings }) {
    const label = KIND_LABELS[kind] || 'Publication écartée';

    // Immunité Ultra : l'événement reste enregistré (il a déjà été inséré par
    // `record`, avant cet appel — l'historique sert toujours à l'analyse de
    // motifs), mais aucune restriction de portée n'est appliquée. Seul ce
    // pipeline automatique est couvert : un retrait manuel par un modérateur
    // reste possible, ce n'est pas la même porte.
    if (occurrence >= 2) {
      const { User } = require('../models');
      const { TIER } = require('../constants/subscriptionTiers');
      const { isSubscriptionActive } = require('../utils/subscriptionHelpers');
      const user = await User.findByPk(userId, { attributes: ['subscription_tier', 'subscription_expires_at'] });
      if (user && user.subscription_tier === TIER.ULTRA && isSubscriptionActive(user)) {
        logger.info(`[contentQuality] ${userId}: restriction ignorée (palier Ultra), occurrence ${occurrence}`);
        return { action: 'ultra_exempt' };
      }
    }

    if (occurrence <= 1) {
      await this.notify(userId, tweetId, {
        title: label,
        message: 'Rien ne change pour ton compte cette fois. Un second cas sous '
          + `${settings.quality.recurrenceWindowDays} jours réduirait temporairement ta portée.`,
        severity: 'info',
        kind,
        reason,
        occurrence,
      });
      return { action: 'notice' };
    }

    const steps = settings.quality.escalationDays;
    const stepIndex = occurrence - 2;

    if (stepIndex >= steps.length) {
      // La répétition n'est plus un tâtonnement : elle entre au registre, où
      // elle expirera seule au bout de 90 jours et où les seuils par domaine
      // décideront de la suite.
      try {
        await rustClient.issueStrike(
          userId,
          settings.quality.strikePolicyBeyondEscalation,
          tweetId,
          reason || `${label} — ${occurrence}ᵉ cas en ${settings.quality.recurrenceWindowDays} jours`
        );
      } catch (e) {
        logger.warn(`[contentQuality] avertissement non posé pour ${userId}: ${e.message}`);
      }
      await this.notify(userId, tweetId, {
        title: 'Avertissement sur ton compte',
        message: `${occurrence} publications écartées en ${settings.quality.recurrenceWindowDays} jours. `
          + 'Un avertissement est désormais inscrit à ton dossier ; il expire seul au bout de 90 jours.',
        severity: 'high',
        kind,
        reason,
        occurrence,
      });
      return { action: 'strike', policy: settings.quality.strikePolicyBeyondEscalation };
    }

    const days = steps[stepIndex];
    try {
      await rustClient.setShadowban(
        userId,
        'monitoring',
        reason || `${label} — ${occurrence}ᵉ cas en ${settings.quality.recurrenceWindowDays} jours`,
        days
      );
    } catch (e) {
      logger.warn(`[contentQuality] restriction non posée pour ${userId}: ${e.message}`);
      return { action: 'failed', error: e.message };
    }

    await this.notify(userId, tweetId, {
      title: days === 1 ? 'Portée réduite pendant 24 h' : `Portée réduite pendant ${days} jours`,
      message: `C'est le ${occurrence}ᵉ cas en ${settings.quality.recurrenceWindowDays} jours. `
        + 'Tes publications restent visibles de tes abonnés et sur ton profil ; '
        + 'elles sont simplement moins recommandées le temps que ça se lève.',
      severity: 'medium',
      kind,
      reason,
      occurrence,
      days,
    });

    logger.info(`[contentQuality] ${userId}: monitoring ${days} j (${occurrence}ᵉ cas, ${kind})`);
    return { action: 'shadowban', level: 'monitoring', days };
  }

  /** Notification in-app. Un échec ici ne doit pas annuler la sanction. */
  static async notify(userId, tweetId, payload) {
    try {
      const { Notification } = require('../models');
      await Notification.createNotification({
        recipient_id: userId,
        sender_id: userId,
        tweet_id: tweetId || null,
        type: 'system',
        title: payload.title,
        message: payload.message,
        content: {
          domain: 'content_quality',
          kind: payload.kind,
          reason: payload.reason || null,
          occurrence: payload.occurrence,
          days: payload.days || null,
          severity: payload.severity,
        },
        priority: payload.severity === 'high' ? 'high' : 'normal',
      });
    } catch (e) {
      logger.warn(`[contentQuality] notification non créée pour ${userId}: ${e.message}`);
    }
  }

  /**
   * État du compte, tel que l'écran dédié doit le montrer.
   *
   * Deux sources réunies : le niveau réellement appliqué par le moteur (seule
   * vérité sur la portée, avertissements du registre compris) et l'historique
   * local des faits qualité (le seul endroit où l'on sache POURQUOI). L'un
   * sans l'autre donne soit un niveau inexpliqué, soit une liste de faits sans
   * conséquence visible.
   */
  static async getAccountStatus(userId) {
    const settings = await getSettings();

    const [engine, events, windowCount] = await Promise.all([
      rustClient.getAccountStatus(userId).catch((e) => {
        logger.warn(`[contentQuality] état moteur illisible pour ${userId}: ${e.message}`);
        return null;
      }),
      sequelize.query(
        `SELECT id, tweet_id, kind, reason, occurred_at
         FROM content_quality_events
         WHERE user_id = :userId
         ORDER BY occurred_at DESC
         LIMIT 30`,
        { replacements: { userId }, type: sequelize.QueryTypes.SELECT }
      ).catch(() => []),
      this.countInWindow(userId, settings.quality.recurrenceWindowDays).catch(() => 0),
    ]);

    const steps = settings.quality.escalationDays;
    const nextIndex = Math.max(0, windowCount - 1);
    const nextPenaltyDays = nextIndex < steps.length ? steps[nextIndex] : null;

    return {
      engine,
      window: {
        days: settings.quality.recurrenceWindowDays,
        count: windowCount,
        // Ce que coûterait le PROCHAIN fait. C'est l'information qui change un
        // comportement — pas celle qui décrit le passé.
        nextPenaltyDays,
        nextIsStrike: nextPenaltyDays === null,
      },
      events: events.map((e) => ({
        id: e.id,
        tweetId: e.tweet_id,
        kind: e.kind,
        label: KIND_LABELS[e.kind] || e.kind,
        reason: e.reason,
        occurredAt: e.occurred_at,
      })),
    };
  }
}

module.exports = ContentQualityService;
module.exports.KIND = KIND;
module.exports.KIND_LABELS = KIND_LABELS;
