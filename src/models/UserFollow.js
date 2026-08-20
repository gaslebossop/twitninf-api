const { DataTypes, Model, Op, literal } = require('sequelize');
const logger = require('../utils/logger');

// Applique `delta` (+1/-1) aux compteurs `following`/`followers` des deux
// côtés d'une relation de suivi. Partagé par les hooks afterCreate (suivi
// direct sur compte public), afterUpdate (demande acceptée) et afterDestroy
// (désabonnement/refus) — seuls les follows `active` doivent l'appeler.
async function bumpFollowStats(follow, delta) {
  const follower = await follow.sequelize.models.User.findByPk(follow.follower_id);
  if (follower) {
    const currentStats = follower.stats || {};
    await follower.update({
      stats: {
        ...currentStats,
        following: Math.max(0, (currentStats.following || 0) + delta)
      }
    });
  }

  const following = await follow.sequelize.models.User.findByPk(follow.following_id);
  if (following) {
    const currentStats = following.stats || {};
    await following.update({
      stats: {
        ...currentStats,
        followers: Math.max(0, (currentStats.followers || 0) + delta)
      }
    });
  }
}

class UserFollow extends Model {
  // Méthode statique pour vérifier si un utilisateur suit un autre
  static async isFollowing(followerId, followingId, transaction = null) {
    const follow = await this.findOne({
      where: {
        follower_id: followerId,
        following_id: followingId,
        status: 'active'
      },
      transaction
    });
    return !!follow;
  }

  // A bloque-t-il B, ou B bloque-t-il A ? Un blocage est toujours mutuel côté
  // visibilité même s'il n'est posé que dans un sens en base.
  static async isBlocked(userId, otherId) {
    const row = await this.findOne({
      where: {
        status: 'blocked',
        [Op.or]: [
          { follower_id: userId, following_id: otherId },
          { follower_id: otherId, following_id: userId }
        ]
      }
    });
    return !!row;
  }

  // Identifiants de tous les comptes liés à `userId` par un blocage, dans
  // n'importe quel sens — pour exclure ces auteurs d'un vivier (Rust) ou de
  // résultats de recherche.
  static async getBlockedIds(userId) {
    const rows = await this.findAll({
      where: {
        status: 'blocked',
        [Op.or]: [{ follower_id: userId }, { following_id: userId }]
      },
      attributes: ['follower_id', 'following_id']
    });
    const ids = new Set();
    for (const row of rows) {
      const other = String(row.follower_id) === String(userId) ? row.following_id : row.follower_id;
      ids.add(String(other));
    }
    return Array.from(ids);
  }

  // Pose un blocage. Détruit d'abord toute relation existante dans les DEUX
  // sens (sauf un blocage déjà posé par l'autre, qu'on ne doit pas écraser) —
  // passer par `destroy` puis `create` plutôt qu'un `update` de statut fait
  // déclencher `afterDestroy` sur un éventuel follow `active`, qui décrémente
  // correctement les stats. Un `update` direct active→blocked ne le ferait
  // pas : `afterUpdate` ne bascule les stats que sur pending→active.
  static async block(blockerId, blockedId, transaction = null) {
    await this.destroy({
      where: { follower_id: blockerId, following_id: blockedId },
      transaction
    });
    await this.destroy({
      where: {
        follower_id: blockedId,
        following_id: blockerId,
        status: { [Op.ne]: 'blocked' }
      },
      transaction
    });
    return this.create(
      { follower_id: blockerId, following_id: blockedId, status: 'blocked' },
      { transaction }
    );
  }

  // Lève le blocage posé par `blockerId` sur `blockedId`. Ne restaure aucun
  // follow antérieur — débloquer ne veut pas dire se réabonner.
  static async unblock(blockerId, blockedId, transaction = null) {
    await this.destroy({
      where: { follower_id: blockerId, following_id: blockedId, status: 'blocked' },
      transaction
    });
  }

  // Méthode statique pour obtenir les utilisateurs suivis par un utilisateur
  static async getFollowing(userId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      includeUser = true
    } = options;

    const includeOptions = includeUser ? [{
      model: this.sequelize.models.User,
      as: 'following',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats', 'profile_customization'],
      where: { 
        is_active: true,
        is_suspended: false
      }
    }] : [];

    return this.findAll({
      where: { follower_id: userId, status: 'active' },
      include: includeOptions,
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
  }

  // Méthode statique pour obtenir les followers d'un utilisateur
  static async getFollowers(userId, options = {}) {
    const {
      limit = 20,
      offset = 0,
      includeUser = true
    } = options;

    const includeOptions = includeUser ? [{
      model: this.sequelize.models.User,
      as: 'follower',
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats', 'profile_customization'],
      where: { 
        is_active: true,
        is_suspended: false
      }
    }] : [];

    return this.findAll({
      where: { following_id: userId, status: 'active' },
      include: includeOptions,
      order: [['created_at', 'DESC']],
      limit,
      offset
    });
  }

  // Méthode statique pour compter les utilisateurs suivis
  static async countFollowing(userId) {
    return this.count({
      where: { follower_id: userId, status: 'active' }
    });
  }

  // Méthode statique pour compter les followers
  static async countFollowers(userId) {
    return this.count({
      where: { following_id: userId, status: 'active' }
    });
  }

  // Méthode statique pour obtenir les suggestions de suivi
  static async getFollowSuggestions(userId, limit = 10) {
    // AUDIT R3-05 (2026-08-19) : la liste d'abonnements matérialisée en
    // littéral `NOT IN` (jusqu'à ~190 Ko de SQL à 5 000 abonnements, un plan
    // jamais réutilisable) empêchait en plus toute anti-jointure : `NOT IN`
    // sur des littéraux est évalué ligne à ligne sur `users`. Sous-requête
    // corrélée à la place — un seul aller-retour, indexable par
    // `user_follows(follower_id)`. On prend TOUS les liens, pas seulement
    // les `active` : une demande déjà en attente ne doit pas être
    // re-suggérée comme un compte qu'on ne connaît pas.
    const followingSubquery = literal(
      `(SELECT following_id FROM user_follows WHERE follower_id = ${this.sequelize.escape(String(userId))})`
    );

    return this.sequelize.models.User.findAll({
      where: {
        id: { [Op.notIn]: followingSubquery, [Op.ne]: userId }, // exclut aussi l'utilisateur lui-même
        is_active: true,
        is_suspended: false,
        // Un compte privé ne se recommande pas. Il a demandé à n'être visible
        // que de ses abonnés : le pousser à des inconnus, c'est exactement ce
        // qu'il a refusé. Et comme cette liste ne contient QUE des comptes non
        // suivis, aucun compte privé n'a sa place ici — pas besoin de croiser
        // avec le statut de suivi.
        is_private_account: false,
        verified: true // Priorité aux comptes vérifiés
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'stats', 'profile_customization'],
      order: [
        ['verified', 'DESC'],
        ['stats.followers', 'DESC'],
        ['created_at', 'DESC']
      ],
      limit
    });
  }

  /**
   * Comptes les plus influents, pour l'ecran d'abonnements de l'inscription.
   *
   * Volontairement different de `getFollowSuggestions`, qui s'appuie sur le
   * graphe : un compte cree il y a dix secondes n'a aucun graphe. On classe
   * donc par influence brute.
   *
   * Le filtre d'activite recente n'est pas cosmetique. La table `users`
   * contient plusieurs milliers de comptes issus de rafales de creation
   * scriptees, non marques `is_data_test` : sans cette porte, l'ecran
   * proposerait des coquilles vides et les trois abonnements imposes
   * n'alimenteraient rien du tout. Seuls les comptes ayant publie recemment
   * peuvent remplir un fil.
   */
  static async getInfluentialSuggestions(userId, limit = 12, activityDays = 30) {
    const rows = await this.sequelize.query(`
      WITH candidats AS (
        SELECT
          u.id, u.username, u.full_name, u.avatar, u.bio,
          u.verified, u.premium, u.profile_customization,
          (SELECT COUNT(*) FROM user_follows f
            WHERE f.following_id = u.id AND f.status = 'active') AS followers,
          (SELECT COUNT(*) FROM tweets t
            WHERE t.user_id = u.id
              AND t.created_at >= NOW() - (:activityDays * INTERVAL '1 day')) AS tweets_recents,
          (SELECT COUNT(*) FROM tweet_likes l
             JOIN tweets t2 ON t2.id = l.tweet_id
            WHERE t2.user_id = u.id
              AND l.created_at >= NOW() - (:activityDays * INTERVAL '1 day')) AS likes_recus
        FROM users u
        WHERE u.is_active = TRUE
          AND u.is_suspended = FALSE
          -- Un compte prive a demande a n'etre visible que de ses abonnes :
          -- le pousser a des inconnus est exactement ce qu'il a refuse.
          AND u.is_private_account = FALSE
          AND u.id <> :userId
          AND NOT EXISTS (
            SELECT 1 FROM user_follows f2
             WHERE f2.follower_id = :userId AND f2.following_id = u.id
          )
      )
      SELECT *,
        -- Logarithmes : sans eux le compte le plus suivi ecrase tout le
        -- classement et l'ecran propose toujours les trois memes personnes.
        (LN(1 + followers) * 2.0 + LN(1 + likes_recus) + LN(1 + tweets_recents) * 0.5)
          AS influence
      FROM candidats
      -- Barre minimale : publier un peu ET avoir suscité au moins une
      -- reaction. Sans elle, la liste descend vite sur des comptes a deux
      -- tweets et zero lecteur, qu'on imposerait a chaque nouvelle personne.
      WHERE tweets_recents >= :minTweets
        AND (likes_recus >= 1 OR followers >= 2)
      ORDER BY influence DESC, followers DESC
      LIMIT :limit
    `, {
      type: this.sequelize.QueryTypes.SELECT,
      replacements: { userId, limit, activityDays, minTweets: 3 },
    });

    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      full_name: row.full_name,
      avatar: row.avatar,
      bio: row.bio,
      verified: row.verified,
      premium: row.premium,
      profile_customization: row.profile_customization,
      followers: Number(row.followers),
      recent_tweets: Number(row.tweets_recents),
      recent_likes: Number(row.likes_recus),
    }));
  }

  // Méthode statique pour obtenir les utilisateurs mutuellement suivis
  static async getMutualFollowers(userId, otherUserId) {
    const [userFollowing, otherFollowing] = await Promise.all([
      this.findAll({
        where: { follower_id: userId, status: 'active' },
        attributes: ['following_id']
      }),
      this.findAll({
        where: { follower_id: otherUserId, status: 'active' },
        attributes: ['following_id']
      })
    ]);

    const userFollowingIds = userFollowing.map(f => f.following_id);
    const otherFollowingIds = otherFollowing.map(f => f.following_id);

    const mutualIds = userFollowingIds.filter(id => otherFollowingIds.includes(id));

    if (mutualIds.length === 0) return [];

    return this.sequelize.models.User.findAll({
      where: {
        id: { [Op.in]: mutualIds },
        is_active: true,
        is_suspended: false
      },
      attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium', 'profile_customization'],
      order: [['username', 'ASC']]
    });
  }
}

// Définition du schéma du modèle UserFollow
const userFollowSchema = {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  // Utilisateur qui suit
  follower_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },

  // Utilisateur qui est suivi
  following_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },

  // Statut de la relation. `pending` = demande de suivi en attente
  // d'approbation (compte privé), pas encore comptée dans les stats.
  status: {
    type: DataTypes.ENUM('active', 'pending', 'blocked', 'muted'),
    defaultValue: 'active'
  },

  // Notifications activées pour ce suivi
  notifications_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },

  // Métadonnées de la relation
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {
      source: 'web',
      device: 'unknown',
      ip_address: null
    }
  }
};

// Options du modèle
const modelOptions = {
  modelName: 'UserFollow',
  tableName: 'user_follows',
  timestamps: true,
  underscored: true,

  // Index pour optimiser les requêtes
  indexes: [
    {
      unique: true,
      fields: ['follower_id', 'following_id'] // Un utilisateur ne peut suivre un autre qu'une fois
    },
    {
      fields: ['follower_id']
    },
    {
      fields: ['following_id']
    },
    {
      fields: ['status']
    },
    {
      fields: ['created_at']
    },
    // Index composite pour les requêtes fréquentes
    {
      fields: ['follower_id', 'status']
    },
    {
      fields: ['following_id', 'status']
    }
  ],

  // Hooks
  hooks: {
    // Un follow `pending` (compte privé, demande non acceptée) ne doit ni
    // compter dans les stats abonnés/abonnements, ni déclencher la notif
    // "vous suit désormais" — seul un statut `active` doit le faire.
    afterCreate: async (follow) => {
      if (follow.status !== 'active') return;
      try {
        await bumpFollowStats(follow, +1);

        try {
          if (follow.sequelize.models.Notification && follow.sequelize.models.Notification.createFollowNotification) {
            await follow.sequelize.models.Notification.createFollowNotification(
              follow.follower_id,
              follow.following_id
            );
          }
        } catch (notificationError) {
          logger.warn('Impossible de créer la notification de suivi:', notificationError.message);
        }

        logger.info(`Nouveau suivi créé: utilisateur ${follow.follower_id} suit maintenant ${follow.following_id}`);
      } catch (error) {
        logger.error('Erreur lors de la création du suivi:', error);
      }
    },

    // Transition `pending` → `active` (demande de suivi acceptée) : c'est
    // seulement à ce moment-là que le suivi doit compter dans les stats.
    afterUpdate: async (follow) => {
      if (!follow.changed('status')) return;
      if (follow.status !== 'active' || follow.previous('status') !== 'pending') return;
      try {
        await bumpFollowStats(follow, +1);

        try {
          if (follow.sequelize.models.Notification && follow.sequelize.models.Notification.createFollowAcceptNotification) {
            await follow.sequelize.models.Notification.createFollowAcceptNotification(
              follow.following_id,
              follow.follower_id
            );
          }
        } catch (notificationError) {
          logger.warn('Impossible de créer la notification d\'acceptation de suivi:', notificationError.message);
        }

        logger.info(`Demande de suivi acceptée: ${follow.following_id} a accepté ${follow.follower_id}`);
      } catch (error) {
        logger.error('Erreur lors de l\'acceptation du suivi:', error);
      }
    },

    afterDestroy: async (follow) => {
      // Annuler/refuser une demande `pending` ne doit décrémenter aucun
      // compteur : elle n'a jamais été comptée à la création.
      if (follow.status !== 'active') return;
      try {
        await bumpFollowStats(follow, -1);
        logger.info(`Suivi supprimé: utilisateur ${follow.follower_id} ne suit plus ${follow.following_id}`);
      } catch (error) {
        logger.error('Erreur lors de la suppression du suivi:', error);
      }
    }
  }
};

// Fonction pour initialiser le modèle avec sequelize
function initUserFollowModel(sequelize) {
  UserFollow.init(userFollowSchema, {
    ...modelOptions,
    sequelize
  });
}

module.exports = UserFollow;
module.exports.initUserFollowModel = initUserFollowModel;
module.exports.userFollowSchema = userFollowSchema;
module.exports.modelOptions = modelOptions;
