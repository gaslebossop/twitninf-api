/**
 * Programme de monétisation : condition supplémentaire à l'abonnement payant.
 * Personne ne touche de récompense tweet avant d'être `approved` ici, même
 * avec un abonnement Plus/Pro actif (voir `TweetMonetizationService.isAuthorMonetizable`).
 * Les seuils sont objectifs mais l'entrée reste toujours une validation manuelle.
 */

const { sequelize } = require('../database/index');
const { User } = require('../models');
const { isSubscriptionActive } = require('../utils/subscriptionHelpers');
const logger = require('../utils/logger');

class MonetizationProgramService {
  static MIN_VIEWS_30D = 1500;
  static MIN_FOLLOWERS = 10;
  // Un peu au-dessus du total mesuré sur @gas le 2026-08-13 (7074, comptes de
  // test exclus) — événements `user_behavior_data` cumulés des abonnés
  // réels : c'est le signal qui distingue une vraie audience d'un lot
  // d'abonnés scriptés (voir la note sur les rafales dans users).
  static MIN_FOLLOWER_BEHAVIOR_SCORE = 7500;

  static async computeStats(userId) {
    const [viewsRows, followersRows, behaviorRows] = await Promise.all([
      sequelize.query(`
        SELECT COALESCE(SUM(view_count), 0) AS views
        FROM tweets
        WHERE user_id = :userId AND parent_tweet_id IS NULL AND created_at >= NOW() - INTERVAL '30 days'
      `, { replacements: { userId }, type: sequelize.QueryTypes.SELECT }),
      sequelize.query(`
        SELECT COUNT(*) AS count
        FROM user_follows
        WHERE following_id = :userId AND status = 'active'
      `, { replacements: { userId }, type: sequelize.QueryTypes.SELECT }),
      // Comptes de test (rafales scriptées) exclus : ils gonfleraient le
      // nombre d'abonnés sans jamais produire de comportement réel.
      sequelize.query(`
        SELECT COUNT(*) AS score
        FROM user_behavior_data ubd
        JOIN user_follows uf ON uf.follower_id = ubd.user_id
        JOIN users u ON u.id = uf.follower_id
        WHERE uf.following_id = :userId AND uf.status = 'active' AND u.is_data_test IS NOT TRUE
      `, { replacements: { userId }, type: sequelize.QueryTypes.SELECT }),
    ]);

    return {
      views30d: parseInt(viewsRows[0]?.views, 10) || 0,
      followersCount: parseInt(followersRows[0]?.count, 10) || 0,
      followerBehaviorScore: parseInt(behaviorRows[0]?.score, 10) || 0,
    };
  }

  static async getEligibility(userId) {
    const user = await User.findByPk(userId, {
      attributes: [
        'id', 'subscription_tier', 'subscription_expires_at',
        'monetization_program_status', 'monetization_applied_at',
        'monetization_reviewed_at', 'monetization_rejection_reason',
      ],
    });
    if (!user) throw new Error('Utilisateur introuvable');

    const stats = await this.computeStats(userId);

    const meetsViews = stats.views30d >= this.MIN_VIEWS_30D;
    const meetsFollowers = stats.followersCount >= this.MIN_FOLLOWERS;
    const meetsBehavior = stats.followerBehaviorScore >= this.MIN_FOLLOWER_BEHAVIOR_SCORE;
    const meetsAllThresholds = meetsViews && meetsFollowers && meetsBehavior;

    return {
      stats,
      thresholds: {
        views30d: this.MIN_VIEWS_30D,
        followersCount: this.MIN_FOLLOWERS,
        followerBehaviorScore: this.MIN_FOLLOWER_BEHAVIOR_SCORE,
      },
      criteria: { meetsViews, meetsFollowers, meetsBehavior },
      meetsAllThresholds,
      hasActiveSubscription: isSubscriptionActive(user),
      programStatus: user.monetization_program_status,
      appliedAt: user.monetization_applied_at,
      reviewedAt: user.monetization_reviewed_at,
      rejectionReason: user.monetization_rejection_reason,
      canApply: meetsAllThresholds && ['none', 'rejected'].includes(user.monetization_program_status),
    };
  }

  static async applyToProgram(userId) {
    const eligibility = await this.getEligibility(userId);
    if (!eligibility.meetsAllThresholds) {
      return { success: false, reason: 'Les seuils ne sont pas encore tous atteints' };
    }
    if (!['none', 'rejected'].includes(eligibility.programStatus)) {
      return { success: false, reason: 'Candidature déjà en cours ou déjà acceptée' };
    }

    await User.update(
      {
        monetization_program_status: 'pending',
        monetization_applied_at: new Date(),
        monetization_rejection_reason: null,
      },
      { where: { id: userId } }
    );

    logger.info(`📝 Candidature au programme de monétisation soumise: ${userId}`);
    return { success: true };
  }

  static async listPendingApplications() {
    const users = await User.findAll({
      where: { monetization_program_status: 'pending' },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'monetization_applied_at'],
      order: [['monetization_applied_at', 'ASC']],
    });

    return Promise.all(users.map(async (u) => ({
      id: u.id,
      username: u.username,
      fullName: u.full_name,
      avatar: u.avatar,
      verified: u.verified,
      appliedAt: u.monetization_applied_at,
      stats: await this.computeStats(u.id),
      thresholds: {
        views30d: this.MIN_VIEWS_30D,
        followersCount: this.MIN_FOLLOWERS,
        followerBehaviorScore: this.MIN_FOLLOWER_BEHAVIOR_SCORE,
      },
    })));
  }

  static async reviewApplication(userId, adminId, decision, reason = null) {
    if (!['approve', 'reject'].includes(decision)) {
      throw new Error('Décision invalide');
    }
    const user = await User.findByPk(userId);
    if (!user) throw new Error('Utilisateur introuvable');
    if (user.monetization_program_status !== 'pending') {
      return { success: false, reason: 'Cette candidature n\'est plus en attente' };
    }

    await user.update({
      monetization_program_status: decision === 'approve' ? 'approved' : 'rejected',
      monetization_reviewed_at: new Date(),
      monetization_reviewed_by: adminId,
      monetization_rejection_reason: decision === 'reject' ? (reason || null) : null,
    });

    logger.info(`${decision === 'approve' ? '✅' : '🚫'} Programme monétisation: ${userId} ${decision} par ${adminId}`);
    return { success: true, status: user.monetization_program_status };
  }
}

module.exports = MonetizationProgramService;
