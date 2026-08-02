'use strict';

/**
 * Détection et nettoyage des raids de bots.
 *
 * Reprend la logique de `scripts/exportRaidBotSuspects.js` (raids de likes
 * coordonnés + fermes de comptes séquentiels) et y ajoute la détection des
 * follow bots demandée : rafales d'abonnements et cibles gonflées.
 *
 * Aucun signal n'est basé sur l'IP ou l'appareil — ces colonnes n'existent pas
 * en base. Tout est déduit du graphe d'activité, donc ce sont des faisceaux
 * d'indices, pas des preuves : le purge reste une décision humaine explicite.
 */

const { sequelize } = require('../database/index');
const { QueryTypes } = require('sequelize');
const logger = require('../utils/logger');

/** Nombre de comptes distincts likant un même tweet dans l'heure au-delà duquel on parle de raid. */
const LIKE_RAID_MIN_USERS = 8;
/** Nombre de raids auxquels un compte doit avoir participé pour être suspect. */
const LIKE_RAID_MIN_HITS = 3;
/** Comptes séquentiels (`twitninfuserN`) créés dans la même heure. */
const FARM_MIN_ACCOUNTS = 20;
/** Abonnements émis dans la même heure par un même compte. */
const FOLLOW_BURST_MIN = 15;
/** Comptes distincts s'abonnant à une même cible dans l'heure. */
const FOLLOW_RAID_MIN_USERS = 8;
/** Nombre de comptes distincts retweetant un même tweet dans l'heure au-delà duquel on parle de raid. */
const RETWEET_RAID_MIN_USERS = 8;

const REASON_LABELS = {
  like_raid_coordonne: 'Participation à des raids de likes coordonnés',
  account_farm_creation_massive: 'Compte issu d’une ferme créée en masse',
  follow_burst_automatise: 'Rafale d’abonnements (cadence non humaine)',
  follow_raid_coordonne: 'Participation à des raids d’abonnements'
};

/**
 * Scanne les comptes suspects sur `days` jours.
 * Un seul aller-retour SQL : les CTE font tout le travail côté Postgres.
 */
async function scan({ days = 30, limit = 500 } = {}) {
  const lookback = Math.min(365, Math.max(1, Number(days) || 30));
  const rowLimit = Math.min(5000, Math.max(1, Number(limit) || 500));

  const rows = await sequelize.query(
    `
    WITH
    recent_likes AS (
      SELECT tl.user_id, tl.tweet_id, tl.created_at
      FROM tweet_likes tl
      WHERE tl.created_at >= NOW() - (:lookback * INTERVAL '1 day')
    ),
    like_raid_targets AS (
      SELECT tweet_id, date_trunc('hour', created_at) AS bucket,
             COUNT(DISTINCT user_id)::int AS users_in_raid
      FROM recent_likes
      GROUP BY tweet_id, date_trunc('hour', created_at)
      HAVING COUNT(DISTINCT user_id) >= :likeRaidMinUsers
    ),
    like_raid_users AS (
      SELECT rl.user_id,
             COUNT(*)::int AS like_raid_hits,
             MAX(lrt.users_in_raid)::int AS largest_like_raid
      FROM recent_likes rl
      JOIN like_raid_targets lrt
        ON lrt.tweet_id = rl.tweet_id
       AND lrt.bucket = date_trunc('hour', rl.created_at)
      GROUP BY rl.user_id
    ),
    account_farm_users AS (
      SELECT id AS user_id, created_bucket_sequential_count
      FROM (
        SELECT id,
               COUNT(*) FILTER (WHERE username ~ '^twitninfuser[0-9]+$')
                 OVER (PARTITION BY date_trunc('hour', created_at))::int AS created_bucket_sequential_count
        FROM users
        WHERE created_at >= NOW() - (:lookback * INTERVAL '1 day')
      ) u
      WHERE created_bucket_sequential_count >= :farmMinAccounts
    ),
    recent_follows AS (
      SELECT uf.follower_id, uf.following_id, uf.created_at
      FROM user_follows uf
      WHERE uf.created_at >= NOW() - (:lookback * INTERVAL '1 day')
    ),
    follow_burst_users AS (
      SELECT follower_id AS user_id,
             MAX(follows_in_hour)::int AS largest_follow_burst,
             COUNT(*)::int AS follow_burst_hours
      FROM (
        SELECT follower_id, date_trunc('hour', created_at) AS bucket,
               COUNT(*)::int AS follows_in_hour
        FROM recent_follows
        GROUP BY follower_id, date_trunc('hour', created_at)
        HAVING COUNT(*) >= :followBurstMin
      ) b
      GROUP BY follower_id
    ),
    follow_raid_targets AS (
      SELECT following_id, date_trunc('hour', created_at) AS bucket,
             COUNT(DISTINCT follower_id)::int AS followers_in_raid
      FROM recent_follows
      GROUP BY following_id, date_trunc('hour', created_at)
      HAVING COUNT(DISTINCT follower_id) >= :followRaidMinUsers
    ),
    follow_raid_users AS (
      SELECT rf.follower_id AS user_id, COUNT(*)::int AS follow_raid_hits
      FROM recent_follows rf
      JOIN follow_raid_targets frt
        ON frt.following_id = rf.following_id
       AND frt.bucket = date_trunc('hour', rf.created_at)
      GROUP BY rf.follower_id
    )
    SELECT
      u.id                                                    AS "userId",
      u.username,
      u.avatar,
      u.is_suspended                                          AS "isSuspended",
      u.ban_count::int                                        AS "banCount",
      u.created_at                                            AS "accountCreatedAt",
      COALESCE(lru.like_raid_hits, 0)::int                    AS "likeRaidHits",
      COALESCE(lru.largest_like_raid, 0)::int                 AS "largestLikeRaid",
      COALESCE(afu.created_bucket_sequential_count, 0)::int   AS "farmBucketSize",
      COALESCE(fbu.largest_follow_burst, 0)::int              AS "largestFollowBurst",
      COALESCE(fbu.follow_burst_hours, 0)::int                AS "followBurstHours",
      COALESCE(fru.follow_raid_hits, 0)::int                  AS "followRaidHits",
      LEAST(100,
        CASE WHEN COALESCE(lru.like_raid_hits, 0) >= :likeRaidMinHits THEN 40 ELSE 0 END +
        CASE WHEN COALESCE(afu.created_bucket_sequential_count, 0) >= :farmMinAccounts THEN 40 ELSE 0 END +
        CASE WHEN COALESCE(fbu.largest_follow_burst, 0) >= :followBurstMin THEN 30 ELSE 0 END +
        CASE WHEN COALESCE(fru.follow_raid_hits, 0) >= :likeRaidMinHits THEN 20 ELSE 0 END
      )::int AS score,
      array_remove(ARRAY[
        CASE WHEN COALESCE(lru.like_raid_hits, 0) >= :likeRaidMinHits THEN 'like_raid_coordonne' END,
        CASE WHEN COALESCE(afu.created_bucket_sequential_count, 0) >= :farmMinAccounts THEN 'account_farm_creation_massive' END,
        CASE WHEN COALESCE(fbu.largest_follow_burst, 0) >= :followBurstMin THEN 'follow_burst_automatise' END,
        CASE WHEN COALESCE(fru.follow_raid_hits, 0) >= :likeRaidMinHits THEN 'follow_raid_coordonne' END
      ], NULL) AS reasons
    FROM users u
    LEFT JOIN like_raid_users   lru ON lru.user_id = u.id
    LEFT JOIN account_farm_users afu ON afu.user_id = u.id
    LEFT JOIN follow_burst_users fbu ON fbu.user_id = u.id
    LEFT JOIN follow_raid_users  fru ON fru.user_id = u.id
    WHERE COALESCE(u.role::text, 'user') = 'user'
      AND (
        COALESCE(lru.like_raid_hits, 0) >= :likeRaidMinHits
        OR COALESCE(afu.created_bucket_sequential_count, 0) >= :farmMinAccounts
        OR COALESCE(fbu.largest_follow_burst, 0) >= :followBurstMin
        OR COALESCE(fru.follow_raid_hits, 0) >= :likeRaidMinHits
      )
    ORDER BY score DESC, u.username ASC
    LIMIT :rowLimit
    `,
    {
      type: QueryTypes.SELECT,
      replacements: {
        lookback,
        rowLimit,
        likeRaidMinUsers: LIKE_RAID_MIN_USERS,
        likeRaidMinHits: LIKE_RAID_MIN_HITS,
        farmMinAccounts: FARM_MIN_ACCOUNTS,
        followBurstMin: FOLLOW_BURST_MIN,
        followRaidMinUsers: FOLLOW_RAID_MIN_USERS
      }
    }
  );

  // Tweets qui ont subi un raid : la cible, pas l'auteur du raid.
  // Un tweet peut être raidé en likes, en retweets, ou les deux — on prend
  // l'union des deux dimensions pour ne rater aucune cible.
  const raidedTweets = await sequelize.query(
    `
    WITH like_bursts AS (
      SELECT tweet_id, MAX(users_in_raid)::int AS raid_likes
      FROM (
        SELECT tweet_id, date_trunc('hour', created_at) AS bucket,
               COUNT(DISTINCT user_id)::int AS users_in_raid
        FROM tweet_likes
        WHERE created_at >= NOW() - (:lookback * INTERVAL '1 day')
        GROUP BY tweet_id, date_trunc('hour', created_at)
        HAVING COUNT(DISTINCT user_id) >= :likeRaidMinUsers
      ) hourly
      GROUP BY tweet_id
    ),
    retweet_bursts AS (
      SELECT tweet_id, MAX(users_in_raid)::int AS raid_retweets
      FROM (
        SELECT tweet_id, date_trunc('hour', created_at) AS bucket,
               COUNT(DISTINCT user_id)::int AS users_in_raid
        FROM tweet_retweets
        WHERE created_at >= NOW() - (:lookback * INTERVAL '1 day')
        GROUP BY tweet_id, date_trunc('hour', created_at)
        HAVING COUNT(DISTINCT user_id) >= :retweetRaidMinUsers
      ) hourly
      GROUP BY tweet_id
    ),
    raided_tweet_ids AS (
      SELECT tweet_id FROM like_bursts
      UNION
      SELECT tweet_id FROM retweet_bursts
    )
    SELECT
      t.id                                  AS "tweetId",
      t.content,
      t.user_id                             AS "authorId",
      au.username                           AS "authorUsername",
      t.created_at                          AS "createdAt",
      COALESCE(lb.raid_likes, 0)::int       AS "raidLikes",
      -- La table tweets ne porte aucun compteur denormalise : on compte.
      (SELECT COUNT(*) FROM tweet_likes tl WHERE tl.tweet_id = t.id)::int AS "totalLikes",
      COALESCE(rb.raid_retweets, 0)::int    AS "raidRetweets",
      (SELECT COUNT(*) FROM tweet_retweets tr WHERE tr.tweet_id = t.id)::int AS "totalRetweets"
    FROM raided_tweet_ids rti
    JOIN tweets t ON t.id = rti.tweet_id AND t.deleted_at IS NULL
    LEFT JOIN users au ON au.id = t.user_id
    LEFT JOIN like_bursts lb ON lb.tweet_id = t.id
    LEFT JOIN retweet_bursts rb ON rb.tweet_id = t.id
    ORDER BY GREATEST(COALESCE(lb.raid_likes, 0), COALESCE(rb.raid_retweets, 0)) DESC
    LIMIT 200
    `,
    {
      type: QueryTypes.SELECT,
      replacements: { lookback, likeRaidMinUsers: LIKE_RAID_MIN_USERS, retweetRaidMinUsers: RETWEET_RAID_MIN_USERS }
    }
  );

  // Comptes dont l'audience a été gonflée par un raid d'abonnements.
  const raidedAccounts = await sequelize.query(
    `
    SELECT
      u.id                        AS "userId",
      u.username,
      u.avatar,
      -- Pas de colonne followers_count en base : on compte l'audience reelle.
      (SELECT COUNT(*) FROM user_follows f WHERE f.following_id = u.id)::int AS "followersCount",
      r.followers_in_raid::int    AS "raidFollowers"
    FROM (
      SELECT following_id, MAX(followers_in_raid)::int AS followers_in_raid
      FROM (
        SELECT following_id, date_trunc('hour', created_at) AS bucket,
               COUNT(DISTINCT follower_id)::int AS followers_in_raid
        FROM user_follows
        WHERE created_at >= NOW() - (:lookback * INTERVAL '1 day')
        GROUP BY following_id, date_trunc('hour', created_at)
        HAVING COUNT(DISTINCT follower_id) >= :followRaidMinUsers
      ) hourly
      GROUP BY following_id
    ) r
    JOIN users u ON u.id = r.following_id
    ORDER BY r.followers_in_raid DESC
    LIMIT 200
    `,
    {
      type: QueryTypes.SELECT,
      replacements: { lookback, followRaidMinUsers: FOLLOW_RAID_MIN_USERS }
    }
  );

  const flagged = rows.map(row => ({
    ...row,
    reasons: (row.reasons || []).map(code => ({ code, label: REASON_LABELS[code] ?? code })),
    severity: row.score >= 70 ? 'high' : row.score >= 40 ? 'medium' : 'low'
  }));

  return {
    scannedAt: new Date().toISOString(),
    lookbackDays: lookback,
    thresholds: {
      likeRaidMinUsers: LIKE_RAID_MIN_USERS,
      likeRaidMinHits: LIKE_RAID_MIN_HITS,
      farmMinAccounts: FARM_MIN_ACCOUNTS,
      followBurstMin: FOLLOW_BURST_MIN,
      followRaidMinUsers: FOLLOW_RAID_MIN_USERS
    },
    // La liste est plafonnée : sans ce drapeau, un admin croirait avoir purgé
    // toute la ferme alors qu'il n'en voit qu'une tranche.
    truncated: flagged.length >= rowLimit,
    limit: rowLimit,
    stats: {
      usersFlagged: flagged.length,
      highSeverity: flagged.filter(u => u.severity === 'high').length,
      mediumSeverity: flagged.filter(u => u.severity === 'medium').length,
      lowSeverity: flagged.filter(u => u.severity === 'low').length,
      raidedTweets: raidedTweets.length,
      raidedAccounts: raidedAccounts.length
    },
    flaggedUsers: flagged,
    raidedTweets,
    raidedAccounts
  };
}

/**
 * Recalcule `users.stats.{followers,following}` depuis `user_follows` pour
 * les comptes affectés. Les DELETE de ce fichier sont en SQL brut — ils
 * contournent les hooks Sequelize de `UserFollow` (`afterDestroy`) qui
 * tiennent normalement ces compteurs à jour, sinon les profils gardent des
 * chiffres gonflés après un nettoyage.
 */
async function recalcFollowStats(userIds, t) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return;
  await sequelize.query(
    `UPDATE users u SET stats = COALESCE(u.stats, '{}'::jsonb) || jsonb_build_object(
       'followers', (SELECT COUNT(*)::int FROM user_follows f WHERE f.following_id = u.id),
       'following', (SELECT COUNT(*)::int FROM user_follows f WHERE f.follower_id = u.id)
     )
     WHERE u.id IN (:ids)`,
    { replacements: { ids }, transaction: t }
  );
}

/** Même principe que `recalcFollowStats`, pour `stats.likes` après un DELETE brut sur `tweet_likes`. */
async function recalcLikeStats(userIds, t) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return;
  await sequelize.query(
    `UPDATE users u SET stats = COALESCE(u.stats, '{}'::jsonb) || jsonb_build_object(
       'likes', (SELECT COUNT(*)::int FROM tweet_likes tl WHERE tl.user_id = u.id)
     )
     WHERE u.id IN (:ids)`,
    { replacements: { ids }, transaction: t }
  );
}

/** Même principe que `recalcFollowStats`, pour `stats.retweets` après un DELETE brut sur `tweet_retweets`. */
async function recalcRetweetStats(userIds, t) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return;
  await sequelize.query(
    `UPDATE users u SET stats = COALESCE(u.stats, '{}'::jsonb) || jsonb_build_object(
       'retweets', (SELECT COUNT(*)::int FROM tweet_retweets tr WHERE tr.user_id = u.id)
     )
     WHERE u.id IN (:ids)`,
    { replacements: { ids }, transaction: t }
  );
}

/**
 * Nettoyage. Chaque volet est optionnel et l'appelant choisit explicitement
 * lesquels appliquer. Tout se joue dans une transaction : soit le nettoyage
 * passe entièrement, soit la base reste intacte.
 *
 * Ni `tweets.likes_count` ni `users.followers_count` n'existent comme
 * colonnes en base — mais `users.stats` (JSONB) porte bien des compteurs
 * dénormalisés (`likes`, `retweets`, `followers`, `following`) maintenus par
 * les hooks Sequelize des modèles `TweetLike`/`TweetRetweet`/`UserFollow`.
 * Comme ce nettoyage passe par du SQL brut, ces hooks ne se déclenchent pas :
 * chaque volet recalcule donc explicitement les compteurs affectés.
 */
async function purge(userIds, options, moderatorId) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) {
    throw Object.assign(new Error('Aucun compte sélectionné.'), { status: 400 });
  }

  const {
    removeLikes = false,
    removeFollows = false,
    removeRetweets = false,
    deleteTweets = false,
    banAccounts = false,
    reason = 'Nettoyage anti-raidbot'
  } = options || {};

  if (!removeLikes && !removeFollows && !removeRetweets && !deleteTweets && !banAccounts) {
    throw Object.assign(new Error('Aucune action de nettoyage sélectionnée.'), { status: 400 });
  }

  return sequelize.transaction(async (t) => {
    const report = { accounts: ids.length, likesRemoved: 0, followsRemoved: 0, retweetsRemoved: 0, tweetsDeleted: 0, accountsBanned: 0 };
    const opts = { type: QueryTypes.SELECT, replacements: { ids, reason, moderatorId }, transaction: t };

    if (removeLikes) {
      const deletedRows = await sequelize.query(
        `DELETE FROM tweet_likes WHERE user_id IN (:ids) RETURNING user_id`,
        { type: QueryTypes.SELECT, replacements: { ids }, transaction: t }
      );
      report.likesRemoved = deletedRows.length;
      await recalcLikeStats(deletedRows.map(r => r.user_id), t);
    }

    if (removeRetweets) {
      const deletedRows = await sequelize.query(
        `DELETE FROM tweet_retweets WHERE user_id IN (:ids) RETURNING user_id`,
        { type: QueryTypes.SELECT, replacements: { ids }, transaction: t }
      );
      report.retweetsRemoved = deletedRows.length;
      await recalcRetweetStats(deletedRows.map(r => r.user_id), t);
    }

    if (removeFollows) {
      // On coupe dans les deux sens : les abonnements émis par les bots, et
      // ceux qu'ils ont reçus (une ferme s'auto-abonne pour paraître vivante).
      const deletedRows = await sequelize.query(
        `DELETE FROM user_follows
         WHERE follower_id IN (:ids) OR following_id IN (:ids)
         RETURNING follower_id, following_id`,
        { type: QueryTypes.SELECT, replacements: { ids }, transaction: t }
      );
      report.followsRemoved = deletedRows.length;
      const affected = new Set();
      deletedRows.forEach(r => { affected.add(r.follower_id); affected.add(r.following_id); });
      await recalcFollowStats([...affected], t);
    }

    if (deleteTweets) {
      // Soft delete, comme partout ailleurs dans l'app : les publications
      // restent en base pour l'audit, elles sortent juste des fils.
      const [{ count }] = await sequelize.query(
        `WITH deleted AS (
           UPDATE tweets SET deleted_at = NOW()
           WHERE user_id IN (:ids) AND deleted_at IS NULL
           RETURNING id
         ) SELECT COUNT(*)::int AS count FROM deleted`,
        opts
      );
      report.tweetsDeleted = count;
    }

    if (banAccounts) {
      // Bannissement définitif : `suspended_until = NULL` est la convention
      // du banService pour « permanent ». Les modérateurs sont épargnés.
      const [{ count }] = await sequelize.query(
        `WITH updated AS (
           UPDATE users
           SET is_suspended = TRUE,
               suspended_at = NOW(),
               suspended_until = NULL,
               suspension_reason = :reason,
               ban_count = COALESCE(ban_count, 0) + 1,
               suspension_meta = COALESCE(suspension_meta, '{}'::jsonb) || jsonb_build_object(
                 'permanent_ban', true,
                 'permanent_ban_date', NOW(),
                 'last_ban_reason', :reason::text,
                 'last_ban_admin', :moderatorId::text,
                 'source', 'raidbot_purge'
               )
           WHERE id IN (:ids)
             AND COALESCE(role::text, 'user') = 'user'
             AND is_suspended = FALSE
           RETURNING id
         ) SELECT COUNT(*)::int AS count FROM updated`,
        opts
      );
      report.accountsBanned = count;
    }

    logger.info(`[raidbot] purge par ${moderatorId} — ${JSON.stringify(report)}`);
    return report;
  }).then((report) => {
    // Le gate de ban met en cache le statut : sans invalidation, un compte
    // banni garde l'accès jusqu'à l'expiration du TTL. Hors transaction, et
    // best-effort — un cache non purgé ne doit pas annuler le nettoyage.
    if (report.accountsBanned > 0) {
      try {
        const { invalidateUser } = require('../middleware/globalBanMiddleware');
        ids.forEach(id => invalidateUser(String(id)));
      } catch (e) {
        logger.debug('[raidbot] invalidation du cache de ban indisponible:', e.message);
      }
    }
    return report;
  });
}

/**
 * Retire directement les likes de raid sous des tweets ciblés, sans passer
 * par la liste des comptes suspects.
 *
 * Le purge par compte (`purge`) ne touche que les `userIds` sélectionnés,
 * or un compte doit avoir participé à `LIKE_RAID_MIN_HITS` (3) raids
 * distincts pour apparaître dans `flaggedUsers` — un compte qui n'a raidé
 * qu'un seul tweet n'y figure jamais et son like reste donc en place même
 * après un nettoyage complet. Cette fonction cible directement les
 * tweets : elle supprime, pour chaque tweet donné, les likes posés dans le
 * créneau d'une heure où au moins `LIKE_RAID_MIN_USERS` comptes distincts
 * ont liké — c'est-à-dire exactement les likes comptés dans `raidLikes` par
 * `scan()`. Les likes posés hors de ce créneau (probablement organiques)
 * sont laissés intacts.
 */
async function purgeRaidLikes(tweetIds, moderatorId) {
  const ids = [...new Set((tweetIds || []).filter(Boolean))];
  if (!ids.length) {
    throw Object.assign(new Error('Aucun tweet sélectionné.'), { status: 400 });
  }

  return sequelize.transaction(async (t) => {
    const deletedRows = await sequelize.query(
      `WITH burst_buckets AS (
         SELECT tweet_id, date_trunc('hour', created_at) AS bucket
         FROM tweet_likes
         WHERE tweet_id IN (:ids)
         GROUP BY tweet_id, date_trunc('hour', created_at)
         HAVING COUNT(DISTINCT user_id) >= :likeRaidMinUsers
       )
       DELETE FROM tweet_likes tl
       USING burst_buckets bb
       WHERE tl.tweet_id = bb.tweet_id
         AND date_trunc('hour', tl.created_at) = bb.bucket
       RETURNING tl.user_id`,
      { type: QueryTypes.SELECT, replacements: { ids, likeRaidMinUsers: LIKE_RAID_MIN_USERS }, transaction: t }
    );

    await recalcLikeStats(deletedRows.map(r => r.user_id), t);

    logger.info(`[raidbot] purge likes de raid par ${moderatorId} — ${deletedRows.length} like(s) sur ${ids.length} tweet(s)`);
    return { tweets: ids.length, likesRemoved: deletedRows.length };
  });
}

/**
 * Même logique que `purgeRaidLikes`, mais pour les retweets : retire, pour
 * chaque tweet donné, les retweets posés dans le créneau d'une heure où au
 * moins `RETWEET_RAID_MIN_USERS` comptes distincts ont retweeté — exactement
 * les retweets comptés dans `raidRetweets` par `scan()`.
 */
async function purgeRaidRetweets(tweetIds, moderatorId) {
  const ids = [...new Set((tweetIds || []).filter(Boolean))];
  if (!ids.length) {
    throw Object.assign(new Error('Aucun tweet sélectionné.'), { status: 400 });
  }

  return sequelize.transaction(async (t) => {
    const deletedRows = await sequelize.query(
      `WITH burst_buckets AS (
         SELECT tweet_id, date_trunc('hour', created_at) AS bucket
         FROM tweet_retweets
         WHERE tweet_id IN (:ids)
         GROUP BY tweet_id, date_trunc('hour', created_at)
         HAVING COUNT(DISTINCT user_id) >= :retweetRaidMinUsers
       )
       DELETE FROM tweet_retweets tr
       USING burst_buckets bb
       WHERE tr.tweet_id = bb.tweet_id
         AND date_trunc('hour', tr.created_at) = bb.bucket
       RETURNING tr.user_id`,
      { type: QueryTypes.SELECT, replacements: { ids, retweetRaidMinUsers: RETWEET_RAID_MIN_USERS }, transaction: t }
    );

    await recalcRetweetStats(deletedRows.map(r => r.user_id), t);

    logger.info(`[raidbot] purge retweets de raid par ${moderatorId} — ${deletedRows.length} retweet(s) sur ${ids.length} tweet(s)`);
    return { tweets: ids.length, retweetsRemoved: deletedRows.length };
  });
}

/**
 * Retire directement les abonnements de raid reçus par des comptes ciblés
 * (les cibles listées dans `raidedAccounts`), sans passer par la liste des
 * comptes suspects — même raisonnement que `purgeRaidLikes` : un compte n'a
 * besoin que d'avoir participé à un seul raid d'abonnements pour gonfler une
 * cible, mais il ne devient « suspect » qu'à partir de plusieurs raids.
 * Supprime, pour chaque compte ciblé, les abonnements reçus dans le créneau
 * d'une heure où au moins `FOLLOW_RAID_MIN_USERS` comptes distincts se sont
 * abonnés — exactement les abonnements comptés dans `raidFollowers`.
 */
async function purgeRaidFollows(targetUserIds, moderatorId) {
  const ids = [...new Set((targetUserIds || []).filter(Boolean))];
  if (!ids.length) {
    throw Object.assign(new Error('Aucun compte sélectionné.'), { status: 400 });
  }

  return sequelize.transaction(async (t) => {
    const deletedRows = await sequelize.query(
      `WITH burst_buckets AS (
         SELECT following_id, date_trunc('hour', created_at) AS bucket
         FROM user_follows
         WHERE following_id IN (:ids)
         GROUP BY following_id, date_trunc('hour', created_at)
         HAVING COUNT(DISTINCT follower_id) >= :followRaidMinUsers
       )
       DELETE FROM user_follows uf
       USING burst_buckets bb
       WHERE uf.following_id = bb.following_id
         AND date_trunc('hour', uf.created_at) = bb.bucket
       RETURNING uf.follower_id, uf.following_id`,
      { type: QueryTypes.SELECT, replacements: { ids, followRaidMinUsers: FOLLOW_RAID_MIN_USERS }, transaction: t }
    );

    const affected = new Set();
    deletedRows.forEach(r => { affected.add(r.follower_id); affected.add(r.following_id); });
    await recalcFollowStats([...affected], t);

    logger.info(`[raidbot] purge follows de raid par ${moderatorId} — ${deletedRows.length} follow(s) sur ${ids.length} compte(s)`);
    return { accounts: ids.length, followsRemoved: deletedRows.length };
  });
}

/**
 * Compteurs dénormalisés (`users.stats`) vs graphe réel.
 *
 * `users.stats` porte des compteurs (`followers`, `following`, `likes`,
 * `retweets`) tenus par les hooks Sequelize des modèles. Tout ce qui écrit
 * dans `user_follows` / `tweet_likes` / `tweet_retweets` en SQL brut
 * court-circuite ces hooks : le compteur reste alors figé sur une valeur qui
 * ne correspond plus à rien. C'est ce qui produit un profil affichant des
 * milliers d'abonnés dont la liste, elle, n'en montre qu'une poignée — la
 * liste lit le graphe réel, le compteur lit `stats`.
 *
 * Ces deux fonctions rendent le problème visible puis réparable depuis
 * l'anti-raidbot, sans avoir à repurger quoi que ce soit.
 */

/** Sous-requêtes de vérité : le graphe fait foi, jamais `stats`. */
const REAL_COUNTS = {
  followers: '(SELECT COUNT(*)::int FROM user_follows f WHERE f.following_id = u.id)',
  following: '(SELECT COUNT(*)::int FROM user_follows f WHERE f.follower_id = u.id)',
  likes: '(SELECT COUNT(*)::int FROM tweet_likes tl WHERE tl.user_id = u.id)',
  retweets: '(SELECT COUNT(*)::int FROM tweet_retweets tr WHERE tr.user_id = u.id)'
};

/**
 * `stats->>'x'` peut être absent, vide ou non numérique : NULLIF + COALESCE
 * évitent qu'une valeur sale fasse échouer le cast et sorte le compte du scan.
 */
const shownCount = (key) => `COALESCE(NULLIF(u.stats->>'${key}', '')::int, 0)`;

/** Condition « au moins un compteur s'écarte du réel de plus de `minGap` ». */
const desyncCondition = (minGap) => Object.entries(REAL_COUNTS)
  .map(([key, real]) => `ABS(${shownCount(key)} - ${real}) >= ${minGap}`)
  .join(' OR ');

/**
 * Liste les comptes dont au moins un compteur affiché diverge du graphe réel.
 * Lecture pure : ne modifie rien.
 *
 * @param {{limit?: number, minGap?: number}} options `minGap` = écart minimal
 *   pour être signalé (1 = toute divergence).
 */
async function scanCounterDesync({ limit = 500, minGap = 1 } = {}) {
  const rowLimit = Math.min(5000, Math.max(1, Number(limit) || 500));
  const gap = Math.min(1000000, Math.max(1, Number(minGap) || 1));

  const accounts = await sequelize.query(
    `SELECT u.id, u.username, u.avatar, u.verified, u.is_suspended, u.created_at,
            ${shownCount('followers')} AS shown_followers, ${REAL_COUNTS.followers} AS real_followers,
            ${shownCount('following')} AS shown_following, ${REAL_COUNTS.following} AS real_following,
            ${shownCount('likes')}     AS shown_likes,     ${REAL_COUNTS.likes}     AS real_likes,
            ${shownCount('retweets')}  AS shown_retweets,  ${REAL_COUNTS.retweets}  AS real_retweets
     FROM users u
     WHERE ${desyncCondition(gap)}
     ORDER BY ABS(${shownCount('followers')} - ${REAL_COUNTS.followers}) DESC,
              ABS(${shownCount('following')} - ${REAL_COUNTS.following}) DESC
     LIMIT :rowLimit`,
    { type: QueryTypes.SELECT, replacements: { rowLimit } }
  );

  const [totals] = await sequelize.query(
    `SELECT COUNT(*)::int AS accounts,
            COALESCE(SUM(GREATEST(0, ${shownCount('followers')} - ${REAL_COUNTS.followers})), 0)::int AS phantom_followers,
            COALESCE(SUM(GREATEST(0, ${shownCount('following')} - ${REAL_COUNTS.following})), 0)::int AS phantom_following
     FROM users u
     WHERE ${desyncCondition(gap)}`,
    { type: QueryTypes.SELECT }
  );

  return {
    generatedAt: new Date().toISOString(),
    minGap: gap,
    totals: {
      accounts: totals?.accounts ?? 0,
      /** Abonnés affichés qui n'existent dans aucune ligne de `user_follows`. */
      phantomFollowers: totals?.phantom_followers ?? 0,
      phantomFollowing: totals?.phantom_following ?? 0
    },
    accounts: accounts.map(row => ({
      id: row.id,
      username: row.username,
      avatar: row.avatar,
      verified: row.verified,
      isSuspended: row.is_suspended,
      createdAt: row.created_at,
      followers: { shown: row.shown_followers, real: row.real_followers, gap: row.shown_followers - row.real_followers },
      following: { shown: row.shown_following, real: row.real_following, gap: row.shown_following - row.real_following },
      likes: { shown: row.shown_likes, real: row.real_likes, gap: row.shown_likes - row.real_likes },
      retweets: { shown: row.shown_retweets, real: row.real_retweets, gap: row.shown_retweets - row.real_retweets }
    })),
    returned: accounts.length,
    truncated: accounts.length >= rowLimit
  };
}

/**
 * Réaligne `users.stats` sur le graphe réel.
 *
 * Ne touche NI aux abonnements, NI aux likes, NI aux comptes eux-mêmes : seuls
 * les compteurs affichés sont réécrits à partir de ce que la base contient
 * vraiment. Un compte qui affichait 3 375 abonnés pour 5 réels affichera 5 —
 * le chiffre que sa liste d'abonnés montrait déjà.
 *
 * @param {string[]|null} userIds comptes ciblés ; vide/null = tous les comptes
 *   désynchronisés (c'est le cas d'usage normal : la corruption touche
 *   rarement un seul compte).
 * @param {{minGap?: number, dryRun?: boolean}} options
 */
async function resyncCounters(userIds, options = {}, moderatorId = null) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const gap = Math.min(1000000, Math.max(1, Number(options.minGap) || 1));
  const scope = ids.length ? 'AND u.id IN (:ids)' : '';

  // Le WHERE porte la condition de désync : on ne réécrit que les lignes
  // réellement fausses, jamais les 3 400 comptes sains de la table.
  const selection = `WHERE (${desyncCondition(gap)}) ${scope}`;

  if (options.dryRun) {
    // Le total vient d'un COUNT sur toute la sélection, pas de la taille de
    // l'échantillon : sinon un dry-run sur 3 380 comptes annoncerait « 200 »
    // (la limite d'affichage) et l'admin validerait en croyant l'opération
    // dix fois plus petite qu'elle ne l'est.
    const [{ total }] = await sequelize.query(
      `SELECT COUNT(*)::int AS total FROM users u ${selection}`,
      { type: QueryTypes.SELECT, replacements: ids.length ? { ids } : {} }
    );
    const preview = await sequelize.query(
      `SELECT u.id, u.username,
              ${shownCount('followers')} AS shown_followers, ${REAL_COUNTS.followers} AS real_followers,
              ${shownCount('following')} AS shown_following, ${REAL_COUNTS.following} AS real_following
       FROM users u ${selection}
       ORDER BY ABS(${shownCount('followers')} - ${REAL_COUNTS.followers}) DESC
       LIMIT 200`,
      { type: QueryTypes.SELECT, replacements: ids.length ? { ids } : {} }
    );
    return { dryRun: true, wouldFix: total, sample: preview, sampleTruncated: total > preview.length };
  }

  return sequelize.transaction(async (t) => {
    const fixed = await sequelize.query(
      `UPDATE users u
       SET stats = COALESCE(u.stats, '{}'::jsonb) || jsonb_build_object(
             'followers', ${REAL_COUNTS.followers},
             'following', ${REAL_COUNTS.following},
             'likes',     ${REAL_COUNTS.likes},
             'retweets',  ${REAL_COUNTS.retweets}
           ),
           updated_at = NOW()
       ${selection}
       RETURNING u.id, u.username,
                 (u.stats->>'followers')::int AS followers,
                 (u.stats->>'following')::int AS following`,
      { type: QueryTypes.SELECT, replacements: ids.length ? { ids } : {}, transaction: t }
    );

    logger.info(`[raidbot] resync des compteurs par ${moderatorId || 'système'} — ${fixed.length} compte(s) réalignés sur le graphe réel`);
    return {
      dryRun: false,
      accountsFixed: fixed.length,
      // Échantillon seulement : `accountsFixed` porte le total réel.
      sample: fixed.slice(0, 200),
      sampleTruncated: fixed.length > 200
    };
  });
}

module.exports = {
  scan,
  purge,
  purgeRaidLikes,
  purgeRaidRetweets,
  purgeRaidFollows,
  scanCounterDesync,
  resyncCounters,
  REASON_LABELS
};
