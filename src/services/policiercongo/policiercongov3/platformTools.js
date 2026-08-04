'use strict';

const { Op, QueryTypes } = require('sequelize');
const ActionExecutor = require('../actionExecutor');
const DataCollector = require('../dataCollector');
const messagingManager = require('../messagingManager');
const { POLICE_ACCOUNT_ID } = require('../config');
const { TOOL_RISK, AUTONOMOUS_THREAD_ID } = require('./constants');
const { ADVANCED_SEARCH_SCHEMA, advancedSearchTweets } = require('./advancedSearch');
const { getPlatformRules } = require('./platformRules');
const { listAgencies, getAgencyAffiliation } = require('./agencies');
const { entityKey } = require('./memoryRanker');
const { reviewSelfVerificationRequest } = require('./crossModelVerification');
const { asPlain, clip } = require('./utils');
const NewEconomyService = require('../../newEconomyService');
const CasinoService = require('../../casinoService');
const contractService = require('../contractService');
const { getPlatformCurrency } = require('../../../economy/platformCurrency');
const { getOrCreateEurCurrency } = require('../../../economy/eurCurrency');
const { convertUserCurrency, getCurrencyDetail, listUserCurrencies } = require('../../../economy/userCurrency');
const { TIER, TIER_PRICES_TWC, DEFAULT_DURATION_DAYS } = require('../../../constants/subscriptionTiers');
const {
  SUBSCRIPTION_TWEET_CREDITS,
  creditsAfterSubscriptionPurchase,
} = require('../../../constants/tweetGeneration');
const { maybeExpireSubscription, isSubscriptionActive, computeNewExpiry } = require('../../../utils/subscriptionHelpers');

const UUID = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' };
const CONTENT = { type: 'string', maxLength: 600 };
const object = (properties, required = []) => ({ type: 'object', properties, required });

/** Nombre max de destinataires par appel à pay_currency_holders — au-delà, on refuse plutôt que de payer partiellement en silence. */
const MAX_AIRDROP_RECIPIENTS = 300;

function publicUser(user) {
  if (!user) return null;
  const value = asPlain(user);
  return { id: value.id, username: value.username, full_name: value.full_name, bio: value.bio, avatar: value.avatar,
    banner: value.banner, verified: value.verified, premium: value.premium, is_suspended: value.is_suspended, created_at: value.created_at };
}

function publicTweet(tweet) {
  if (!tweet) return null;
  const value = asPlain(tweet);
  return { id: value.id, content: value.content, user_id: value.user_id, parent_tweet_id: value.parent_tweet_id,
    original_tweet_id: value.original_tweet_id, tweet_type: value.tweet_type, media_urls: value.media_urls,
    hashtags: value.hashtags, mentions: value.mentions, language: value.language, view_count: value.view_count,
    click_count: value.click_count, moderation_status: value.moderation_status, recommendation_group: value.recommendation_group,
    created_at: value.created_at, author: publicUser(value.author), likes: value.likes?.length, retweets: value.retweets?.length };
}

async function getTweetEngagementSummary(models, { tweet_id, sample_limit = 0 } = {}) {
  const safeSampleLimit = Math.max(0, Math.min(50, Number(sample_limit) || 0));
  const tweet = await models.Tweet.findByPk(tweet_id, {
    include: [{ model: models.User, as: 'author', attributes: ['id','username','full_name','avatar','verified','premium'] }]
  });
  if (!tweet) return { found: false, tweet_id };

  const [counts] = await models.sequelize.query(`
    SELECT
      (SELECT COUNT(*)::int FROM tweets r WHERE r.parent_tweet_id = :tweetId AND r.deleted_at IS NULL) AS comments,
      (SELECT COUNT(DISTINCT r.user_id)::int FROM tweets r WHERE r.parent_tweet_id = :tweetId AND r.deleted_at IS NULL) AS unique_commenters,
      (SELECT COUNT(*)::int FROM tweet_likes l WHERE l.tweet_id = :tweetId) AS likes,
      (SELECT COUNT(DISTINCT l.user_id)::int FROM tweet_likes l WHERE l.tweet_id = :tweetId) AS unique_likers,
      (SELECT COUNT(*)::int FROM tweet_retweets rt WHERE rt.tweet_id = :tweetId) AS retweets,
      (SELECT COUNT(DISTINCT rt.user_id)::int FROM tweet_retweets rt WHERE rt.tweet_id = :tweetId) AS unique_retweeters,
      (
        SELECT COUNT(DISTINCT r.user_id)::int
        FROM tweets r
        JOIN tweet_likes l ON l.tweet_id = :tweetId AND l.user_id = r.user_id
        JOIN tweet_retweets rt ON rt.tweet_id = :tweetId AND rt.user_id = r.user_id
        WHERE r.parent_tweet_id = :tweetId AND r.deleted_at IS NULL
      ) AS complete_participants
  `, { replacements: { tweetId: tweet_id }, type: QueryTypes.SELECT });

  let sample_comments = [];
  if (safeSampleLimit > 0) {
    const rows = await models.Tweet.findAll({
      where: { parent_tweet_id: tweet_id, deleted_at: null },
      include: [{ model: models.User, as: 'author', attributes: ['id','username','full_name','avatar','verified','premium'] }],
      order: [['created_at', 'DESC']],
      limit: safeSampleLimit
    });
    sample_comments = rows.map(publicTweet);
  }

  const commentCount = Number(counts.comments || 0);
  return {
    found: true,
    tweet: { ...publicTweet(tweet), likes: Number(counts.likes || 0), retweets: Number(counts.retweets || 0), comments: commentCount },
    counts: {
      comments: commentCount,
      unique_commenters: Number(counts.unique_commenters || 0),
      likes: Number(counts.likes || 0),
      unique_likers: Number(counts.unique_likers || 0),
      retweets: Number(counts.retweets || 0),
      unique_retweeters: Number(counts.unique_retweeters || 0),
      complete_participants: Number(counts.complete_participants || 0),
      views: Number(tweet.view_count || 0)
    },
    volume_hint: commentCount > safeSampleLimit
      ? `Beaucoup de commentaires: annonce les compteurs agreges, ne liste pas tout.`
      : 'Volume faible: les commentaires peuvent etre listes si utile.',
    sample_comments
  };
}

async function pickRandomCommenter(models, {
  tweet_id,
  require_like = false,
  require_retweet = false,
  unique_user = true
} = {}) {
  const tweet = await models.Tweet.findByPk(tweet_id, {
    include: [{ model: models.User, as: 'author', attributes: ['id','username','full_name','avatar','verified','premium'] }]
  });
  if (!tweet) return { found: false, tweet_id };

  const uniqueSql = unique_user ? 'DISTINCT ON (r.user_id)' : '';
  const likeJoin = require_like ? 'JOIN tweet_likes l ON l.tweet_id = :tweetId AND l.user_id = r.user_id' : '';
  const retweetJoin = require_retweet ? 'JOIN tweet_retweets rt ON rt.tweet_id = :tweetId AND rt.user_id = r.user_id' : '';
  const orderSql = unique_user ? 'ORDER BY r.user_id, random()' : 'ORDER BY random()';

  const candidates = await models.sequelize.query(`
    WITH eligible AS (
      SELECT ${uniqueSql}
        r.id AS comment_id,
        r.user_id,
        r.content,
        r.created_at
      FROM tweets r
      ${likeJoin}
      ${retweetJoin}
      WHERE r.parent_tweet_id = :tweetId
        AND r.deleted_at IS NULL
      ${orderSql}
    )
    SELECT e.comment_id, e.user_id, e.content, e.created_at, u.username, u.full_name, u.avatar, u.verified, u.premium
    FROM eligible e
    JOIN users u ON u.id = e.user_id
    ORDER BY random()
    LIMIT 1
  `, { replacements: { tweetId: tweet_id }, type: QueryTypes.SELECT });

  const [counts] = await models.sequelize.query(`
    SELECT
      COUNT(*)::int AS eligible_comments,
      COUNT(DISTINCT r.user_id)::int AS eligible_users
    FROM tweets r
    ${likeJoin}
    ${retweetJoin}
    WHERE r.parent_tweet_id = :tweetId
      AND r.deleted_at IS NULL
  `, { replacements: { tweetId: tweet_id }, type: QueryTypes.SELECT });

  const winner = candidates[0];
  return {
    found: true,
    tweet: publicTweet(tweet),
    criteria: { require_like: Boolean(require_like), require_retweet: Boolean(require_retweet), unique_user: Boolean(unique_user) },
    eligible_comments: Number(counts.eligible_comments || 0),
    eligible_users: Number(counts.eligible_users || 0),
    winner: winner ? {
      comment_id: winner.comment_id,
      comment_content: winner.content,
      comment_created_at: winner.created_at,
      user: publicUser({
        id: winner.user_id,
        username: winner.username,
        full_name: winner.full_name,
        avatar: winner.avatar,
        verified: winner.verified,
        premium: winner.premium
      })
    } : null
  };
}

async function resolveUser(models, target) {
  if (!target) return null;
  const raw = String(target).replace(/^@/, '');
  return models.User.findOne({ where: { [Op.or]: [{ id: raw }, { username: raw }] } }).catch(() => models.User.findOne({ where: { username: raw } }));
}

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/** Résout une monnaie COMMUNAUTAIRE (isUserCreated) par id, symbole ou nom — jamais NF ni EUR. */
async function resolveCommunityCurrency(models, target) {
  const raw = String(target ?? '').trim();
  if (!raw) return null;
  if (UUID_RE.test(raw)) {
    const byId = await models.VirtualCurrency.findByPk(raw);
    return byId && byId.isUserCreated ? byId : null;
  }
  return models.VirtualCurrency.findOne({
    where: {
      isUserCreated: true,
      [Op.or]: [{ symbol: raw.toUpperCase() }, { name: { [Op.iLike]: raw } }]
    }
  });
}

/** Résout une monnaie de PAIEMENT : 'NF', 'EUR', ou le symbole/nom d'une monnaie communautaire. */
async function resolvePayoutCurrency(models, label) {
  const raw = String(label ?? '').trim().toUpperCase();
  if (raw === 'NF') return getPlatformCurrency({ fresh: true });
  if (raw === 'EUR') return getOrCreateEurCurrency();
  return resolveCommunityCurrency(models, label);
}

function publicMessage(message) {
  if (!message) return null;
  const value = asPlain(message);
  return {
    id: value.id,
    conversation_id: value.conversation_id,
    sender_id: value.sender_id,
    sender: publicUser(value.sender),
    content: value.content,
    message_type: value.message_type,
    metadata: value.metadata,
    created_at: value.created_at,
    updated_at: value.updated_at
  };
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function durationParts(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return { remaining_ms: 0, remaining_minutes: 0, remaining_hours: 0, remaining_days: 0 };
  return {
    remaining_ms: ms,
    remaining_minutes: Math.ceil(ms / 60000),
    remaining_hours: Math.ceil(ms / 3600000),
    remaining_days: Math.ceil(ms / 86400000)
  };
}

function publicUnbanTicket(ticket) {
  if (!ticket) return null;
  const value = asPlain(ticket);
  return {
    id: value.id,
    user_id: value.user_id,
    reason: value.reason,
    status: value.status,
    admin_notes: value.admin_notes,
    processed_by: value.processed_by,
    processed_at: value.processed_at,
    created_at: value.created_at,
    updated_at: value.updated_at
  };
}

async function latestPoliceUnbanTicket(models, { since = null } = {}) {
  const where = { user_id: POLICE_ACCOUNT_ID };
  if (since) where.created_at = { [Op.gte]: since };
  return models.UnbanTicket.findOne({ where, order: [['created_at', 'DESC']] });
}

async function latestPoliceModerationAction(models) {
  if (!models.ModerationAction) return null;
  return models.ModerationAction.findOne({
    where: {
      target_type: 'user',
      target_id: POLICE_ACCOUNT_ID,
      type: { [Op.in]: ['ban', 'suspend'] }
    },
    order: [['created_at', 'DESC']]
  }).catch(() => null);
}

async function getPoliceBanStatus(models) {
  const user = await models.User.findByPk(POLICE_ACCOUNT_ID);
  if (!user) throw new Error('Compte PolicierCongo introuvable');

  const suspendedAt = user.suspended_at ? new Date(user.suspended_at) : null;
  const suspendedUntil = user.suspended_until ? new Date(user.suspended_until) : null;
  const now = new Date();
  const permanent = Boolean(user.is_suspended && !suspendedUntil);
  const expiredButStillFlagged = Boolean(user.is_suspended && suspendedUntil && suspendedUntil.getTime() <= now.getTime());
  const currentAppeal = await latestPoliceUnbanTicket(models, { since: suspendedAt });
  const latestAction = await latestPoliceModerationAction(models);

  return {
    account: publicUser(user),
    suspended: Boolean(user.is_suspended),
    reason: user.suspension_reason || null,
    suspended_at: toIso(user.suspended_at),
    suspended_until: toIso(user.suspended_until),
    is_permanent: permanent,
    expired_but_still_flagged: expiredButStillFlagged,
    now: now.toISOString(),
    ...(suspendedUntil ? durationParts(suspendedUntil.getTime() - now.getTime()) : durationParts(0)),
    can_appeal: Boolean(user.is_suspended && !currentAppeal),
    appeal_already_sent: Boolean(currentAppeal),
    appeal: publicUnbanTicket(currentAppeal),
    latest_moderation_action: latestAction ? {
      id: latestAction.id,
      type: latestAction.type,
      reason: latestAction.reason,
      duration: latestAction.duration,
      status: latestAction.status,
      expires_at: toIso(latestAction.expires_at),
      created_at: toIso(latestAction.created_at)
    } : null
  };
}

async function findDirectConversationWithUser(models, targetUserId) {
  const rows = await models.sequelize.query(`
    SELECT c.id
    FROM conversations c
    JOIN conversation_participants police_participant
      ON police_participant.conversation_id = c.id
      AND police_participant.user_id = :policeId
    JOIN conversation_participants target_participant
      ON target_participant.conversation_id = c.id
      AND target_participant.user_id = :targetUserId
    WHERE c.type = 'direct'
      AND (
        SELECT COUNT(*)::int
        FROM conversation_participants participant_count
        WHERE participant_count.conversation_id = c.id
      ) = 2
    ORDER BY c.updated_at DESC
    LIMIT 1
  `, {
    replacements: { policeId: POLICE_ACCOUNT_ID, targetUserId },
    type: QueryTypes.SELECT
  });
  if (!rows[0]?.id) return null;
  return models.Conversation.findByPk(rows[0].id);
}

function messageSenderFilter(sender) {
  if (sender === 'policiercongo') return POLICE_ACCOUNT_ID;
  if (sender === 'user') return { [Op.ne]: POLICE_ACCOUNT_ID };
  return null;
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getPrivateMessagesWithUser(models, { target, limit = 5, before = null } = {}) {
  const user = await resolveUser(models, target);
  if (!user) throw new Error('Utilisateur introuvable');
  const conversation = await findDirectConversationWithUser(models, user.id);
  if (!conversation) return { found: false, user: publicUser(user), messages: [] };

  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 5));
  const beforeDate = normalizeDate(before);
  const rows = await models.Message.findAll({
    where: {
      conversation_id: conversation.id,
      ...(beforeDate ? { created_at: { [Op.lt]: beforeDate } } : {})
    },
    include: [{ model: models.User, as: 'sender', attributes: ['id','username','full_name','avatar','verified','premium'] }],
    order: [['created_at', 'DESC']],
    limit: safeLimit
  });
  return {
    found: true,
    user: publicUser(user),
    conversation_id: conversation.id,
    returned: rows.length,
    messages: rows.reverse().map(publicMessage)
  };
}

async function getMessageContext(models, conversationId, messageId, { before = 3, after = 3 } = {}) {
  const target = await models.Message.findOne({
    where: { id: messageId, conversation_id: conversationId },
    include: [{ model: models.User, as: 'sender', attributes: ['id','username','full_name','avatar','verified','premium'] }]
  });
  if (!target) return null;
  const beforeLimit = Math.max(0, Math.min(50, Number(before) || 0));
  const afterLimit = Math.max(0, Math.min(50, Number(after) || 0));
  const [previous, next] = await Promise.all([
    beforeLimit ? models.Message.findAll({
      where: { conversation_id: conversationId, created_at: { [Op.lt]: target.created_at } },
      include: [{ model: models.User, as: 'sender', attributes: ['id','username','full_name','avatar','verified','premium'] }],
      order: [['created_at', 'DESC']],
      limit: beforeLimit
    }) : [],
    afterLimit ? models.Message.findAll({
      where: { conversation_id: conversationId, created_at: { [Op.gt]: target.created_at } },
      include: [{ model: models.User, as: 'sender', attributes: ['id','username','full_name','avatar','verified','premium'] }],
      order: [['created_at', 'ASC']],
      limit: afterLimit
    }) : []
  ]);
  return [...previous.reverse(), target, ...next].map(publicMessage);
}

async function searchPrivateMessagesWithUser(models, args = {}) {
  const user = await resolveUser(models, args.target);
  if (!user) throw new Error('Utilisateur introuvable');
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query requis');
  const conversation = await findDirectConversationWithUser(models, user.id);
  if (!conversation) return { found: false, user: publicUser(user), matches: [] };

  const limit = Math.max(1, Math.min(30, Number(args.limit) || 5));
  const contextBefore = Math.max(0, Math.min(20, Number(args.context_before) || 3));
  const contextAfter = Math.max(0, Math.min(20, Number(args.context_after) || 3));
  const createdAt = {};
  const since = normalizeDate(args.since);
  const until = normalizeDate(args.until);
  if (since) createdAt[Op.gte] = since;
  if (until) createdAt[Op.lte] = until;
  const senderFilter = messageSenderFilter(args.sender);
  const order = args.order === 'oldest' ? 'ASC' : 'DESC';
  const matches = await models.Message.findAll({
    where: {
      conversation_id: conversation.id,
      content: { [Op.iLike]: `%${query}%` },
      ...(Object.keys(createdAt).length ? { created_at: createdAt } : {}),
      ...(senderFilter ? { sender_id: senderFilter } : {})
    },
    include: [{ model: models.User, as: 'sender', attributes: ['id','username','full_name','avatar','verified','premium'] }],
    order: [['created_at', order]],
    limit
  });

  const contexts = [];
  for (const match of matches) {
    contexts.push({
      match: publicMessage(match),
      context_before: contextBefore,
      context_after: contextAfter,
      messages: await getMessageContext(models, conversation.id, match.id, { before: contextBefore, after: contextAfter })
    });
  }
  return {
    found: true,
    user: publicUser(user),
    conversation_id: conversation.id,
    query,
    returned: contexts.length,
    matches: contexts
  };
}

async function expandPrivateMessageContext(models, args = {}) {
  const user = await resolveUser(models, args.target);
  if (!user) throw new Error('Utilisateur introuvable');
  const conversation = await findDirectConversationWithUser(models, user.id);
  if (!conversation) return { found: false, user: publicUser(user), messages: [] };
  const messages = await getMessageContext(models, conversation.id, args.message_id, {
    before: args.before ?? 10,
    after: args.after ?? 10
  });
  if (!messages) throw new Error('Message introuvable dans cette conversation');
  return {
    found: true,
    user: publicUser(user),
    conversation_id: conversation.id,
    message_id: args.message_id,
    messages
  };
}

async function collectEcosystemSnapshot(models) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const policeRoots = await models.Tweet.findAll({
    where: { user_id: POLICE_ACCOUNT_ID, parent_tweet_id: null },
    attributes: ['id'], order: [['created_at', 'DESC']], limit: 20, raw: true
  });
  const policeRootIds = policeRoots.map(tweet => tweet.id);
  const [recentRoots, repliesToPolice, notifications, totalTweets24h, totalReplies24h, activeAuthors24h] = await Promise.all([
    models.Tweet.findAll({
      where: { parent_tweet_id: null, created_at: { [Op.gte]: since } },
      include: [{ model: models.User, as: 'author' }], order: [['created_at', 'DESC']], limit: 40
    }),
    policeRootIds.length ? models.Tweet.findAll({
      where: { parent_tweet_id: { [Op.in]: policeRootIds }, created_at: { [Op.gte]: since } },
      include: [{ model: models.User, as: 'author' }], order: [['created_at', 'DESC']], limit: 50
    }) : [],
    models.Notification.findAll({
      where: { recipient_id: POLICE_ACCOUNT_ID, created_at: { [Op.gte]: since } },
      include: [{ model: models.User, as: 'sender', attributes: ['id','username','full_name','avatar','verified'] }],
      order: [['created_at', 'DESC']], limit: 40
    }),
    models.Tweet.count({ where: { created_at: { [Op.gte]: since } } }),
    models.Tweet.count({ where: { parent_tweet_id: { [Op.ne]: null }, created_at: { [Op.gte]: since } } }),
    models.Tweet.count({ distinct: true, col: 'user_id', where: { created_at: { [Op.gte]: since } } })
  ]);
  return {
    generated_at: new Date().toISOString(),
    window: '24h',
    counts: { tweets: totalTweets24h, replies: totalReplies24h, active_authors: activeAuthors24h,
      recent_roots_returned: recentRoots.length, replies_to_police_returned: repliesToPolice.length, notifications_returned: notifications.length },
    recent_roots: recentRoots.map(publicTweet),
    replies_to_policiercongo: repliesToPolice.map(publicTweet),
    notifications: asPlain(notifications).map(item => ({ id: item.id, type: item.type, title: item.title, message: item.message,
      is_read: item.is_read, tweet_id: item.tweet_id, created_at: item.created_at, sender: publicUser(item.sender) }))
  };
}

async function getAccountStatsSnapshot(models, user) {
  const [rows] = await models.sequelize.query(`
    SELECT
      (SELECT COUNT(*)::int FROM tweets WHERE user_id=:userId AND deleted_at IS NULL) AS tweets,
      (SELECT COUNT(*)::int FROM tweets WHERE user_id=:userId AND parent_tweet_id IS NULL AND deleted_at IS NULL) AS root_tweets,
      (SELECT COUNT(*)::int FROM tweets WHERE user_id=:userId AND parent_tweet_id IS NOT NULL AND deleted_at IS NULL) AS replies,
      (SELECT COALESCE(SUM(view_count),0)::bigint FROM tweets WHERE user_id=:userId AND deleted_at IS NULL) AS views,
      (SELECT COUNT(*)::int FROM tweet_likes l JOIN tweets t ON t.id=l.tweet_id WHERE t.user_id=:userId AND t.deleted_at IS NULL) AS likes_received,
      (SELECT COUNT(*)::int FROM tweet_retweets r JOIN tweets t ON t.id=r.tweet_id WHERE t.user_id=:userId AND t.deleted_at IS NULL) AS reposts_received,
      (SELECT COUNT(*)::int FROM user_follows WHERE following_id=:userId) AS followers,
      (SELECT COUNT(*)::int FROM user_follows WHERE follower_id=:userId) AS following
  `, { replacements: { userId: user.id } });
  const recent = await models.Tweet.findAll({ where: { user_id: user.id }, include: [{ model: models.User, as: 'author' }], order: [['created_at','DESC']], limit: 10 });
  return { user: publicUser(user), stats: rows[0] || {}, recent_tweets: recent.map(publicTweet), generated_at: new Date().toISOString() };
}

async function getTrendsSnapshot(models, { period = '24h', limit = 10 } = {}) {
  const periodMs = { '1h': 3600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[period];
  const since = new Date(Date.now() - periodMs).toISOString();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const replacements = { since, limit: safeLimit };
  const [hashtags, topTweets, totals] = await Promise.all([
    models.sequelize.query(`
      SELECT lower(tag.value) AS tag, COUNT(*)::int AS uses,
        COUNT(DISTINCT t.user_id)::int AS unique_authors,
        COALESCE(SUM(t.view_count),0)::bigint AS views,
        MAX(t.created_at) AS last_used_at,
        ROUND((COUNT(*) * 3 + LN(COALESCE(SUM(t.view_count),0) + 1))::numeric, 3) AS trend_score
      FROM tweets t
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(t.hashtags,'[]'::jsonb)) tag(value)
      WHERE t.created_at >= :since AND t.deleted_at IS NULL AND t.parent_tweet_id IS NULL
        AND t.is_private IS FALSE AND t.moderation_status='approved'
      GROUP BY lower(tag.value)
      ORDER BY trend_score DESC, last_used_at DESC
      LIMIT :limit
    `, { replacements, type: QueryTypes.SELECT }),
    models.sequelize.query(`
      SELECT t.id,t.content,t.created_at,t.view_count,u.id AS author_id,u.username,u.full_name,u.avatar,u.verified,
        (SELECT COUNT(*)::int FROM tweet_likes l WHERE l.tweet_id=t.id) AS likes,
        (SELECT COUNT(*)::int FROM tweet_retweets r WHERE r.tweet_id=t.id) AS reposts,
        (SELECT COUNT(*)::int FROM tweets x WHERE x.parent_tweet_id=t.id AND x.deleted_at IS NULL) AS replies,
        ROUND(((t.view_count +
          4*(SELECT COUNT(*) FROM tweet_likes l WHERE l.tweet_id=t.id) +
          6*(SELECT COUNT(*) FROM tweet_retweets r WHERE r.tweet_id=t.id) +
          3*(SELECT COUNT(*) FROM tweets x WHERE x.parent_tweet_id=t.id AND x.deleted_at IS NULL)) /
          SQRT(GREATEST(EXTRACT(EPOCH FROM (NOW()-t.created_at))/3600,0)+1))::numeric, 3) AS trend_score
      FROM tweets t JOIN users u ON u.id=t.user_id
      WHERE t.created_at >= :since AND t.deleted_at IS NULL AND t.parent_tweet_id IS NULL
        AND t.is_private IS FALSE AND t.moderation_status='approved'
      ORDER BY trend_score DESC,t.created_at DESC LIMIT :limit
    `, { replacements, type: QueryTypes.SELECT }),
    models.sequelize.query(`
      SELECT COUNT(*)::int AS root_tweets,COUNT(DISTINCT user_id)::int AS active_authors,
        COALESCE(SUM(view_count),0)::bigint AS views
      FROM tweets WHERE created_at >= :since AND deleted_at IS NULL AND parent_tweet_id IS NULL
        AND is_private IS FALSE AND moderation_status='approved'
    `, { replacements, type: QueryTypes.SELECT })
  ]);
  return {
    period, since, generated_at: new Date().toISOString(), totals: totals[0] || {}, hashtags,
    top_tweets: topTweets.map(row => ({
      id: row.id, content: clip(row.content || '', 600), created_at: row.created_at,
      author: { id: row.author_id, username: row.username, full_name: row.full_name, avatar: row.avatar, verified: row.verified },
      metrics: { views: row.view_count, likes: row.likes, reposts: row.reposts, replies: row.replies }, trend_score: row.trend_score
    }))
  };
}

/**
 * Rassemble plusieurs signaux réels de la plateforme pour nourrir le choix
 * d'un sujet de tweet : ce qui monte (hashtags/posts en momentum, déjà calculé
 * par getTrendsSnapshot), ce qui fait débat (beaucoup de réponses de personnes
 * différentes, pas juste un flood d'une seule personne), et le climat de
 * modération en aggrégat (jamais de contenu individuel identifiable).
 *
 * Ne choisit rien à la place du modèle : fournit des candidats groundés avec
 * leurs métriques, à lui de décider ce qui vaut réellement un post.
 */
async function getTweetTopicSuggestions(models, { window_hours = 24, limit = 8, min_replies = 3 } = {}) {
  const windowHours = Math.max(1, Math.min(168, Number(window_hours) || 24));
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 8));
  const safeMinReplies = Math.max(1, Math.min(50, Number(min_replies) || 3));
  const since = new Date(Date.now() - windowHours * 3600000).toISOString();
  const replacements = { since, limit: safeLimit, minReplies: safeMinReplies };

  const [trending, hotDebates, moderationClimate] = await Promise.all([
    getTrendsSnapshot(models, { period: windowHours <= 1 ? '1h' : windowHours <= 24 ? '24h' : windowHours <= 168 ? '7d' : '30d', limit: safeLimit }),
    models.sequelize.query(`
      SELECT t.id, t.content, t.created_at, u.id AS author_id, u.username, u.full_name, u.avatar, u.verified,
        COUNT(DISTINCT x.id)::int AS reply_count,
        COUNT(DISTINCT x.user_id)::int AS distinct_repliers
      FROM tweets t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN tweets x ON x.parent_tweet_id = t.id AND x.deleted_at IS NULL
      WHERE t.created_at >= :since AND t.deleted_at IS NULL AND t.parent_tweet_id IS NULL
        AND t.is_private IS FALSE AND t.moderation_status = 'approved'
      GROUP BY t.id, u.id
      HAVING COUNT(DISTINCT x.id) >= :minReplies
      ORDER BY COUNT(DISTINCT x.id) DESC, COUNT(DISTINCT x.user_id) DESC, t.created_at DESC
      LIMIT :limit
    `, { replacements, type: QueryTypes.SELECT }),
    models.sequelize.query(`
      SELECT type, severity, status, COUNT(*)::int AS count
      FROM reports
      WHERE created_at >= :since
      GROUP BY type, severity, status
      ORDER BY count DESC
    `, { replacements, type: QueryTypes.SELECT })
  ]);

  return {
    window_hours: windowHours,
    since,
    generated_at: new Date().toISOString(),
    trending_hashtags: trending.hashtags,
    viral_posts: trending.top_tweets,
    hot_debates: hotDebates.map(row => ({
      id: row.id, content: clip(row.content || '', 600), created_at: row.created_at,
      author: { id: row.author_id, username: row.username, full_name: row.full_name, avatar: row.avatar, verified: row.verified },
      reply_count: row.reply_count, distinct_repliers: row.distinct_repliers,
      note: row.distinct_repliers <= 1 ? 'une seule personne répond en boucle: probablement pas un vrai débat' : null
    })),
    moderation_climate: moderationClimate,
    usage_note: 'Ce sont des candidats groundés, pas des sujets imposés. Croise avec ce que tu as déjà publié récemment (recent_episodes, ton profil) avant de choisir, et vérifie un candidat avec get_tweet/get_thread avant de le citer ou d’y réagir.'
  };
}

async function getVerificationRequestsSnapshot(models, args = {}) {
  const statuses = Array.isArray(args.statuses) && args.statuses.length ? args.statuses : ['pending', 'under_review'];
  const requestTypes = Array.isArray(args.request_types) ? args.request_types : [];
  const where = { status: { [Op.in]: statuses }, ...(requestTypes.length ? { request_type: { [Op.in]: requestTypes } } : {}) };
  if (args.user) {
    const user = await resolveUser(models, args.user);
    if (!user) return { found_user: false, requests: [], pagination: { total: 0, returned: 0 }, stats: await models.VerificationRequest.getStats() };
    where.user_id = user.id;
  }
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
  const result = await models.VerificationRequest.findAndCountAll({
    where,
    include: [
      { model: models.User, as: 'user', attributes: ['id','username','full_name','avatar','verified','verification_style','created_at'] },
      { model: models.User, as: 'processor', attributes: ['id','username'], required: false }
    ],
    order: [['created_at','DESC']], limit
  });
  return {
    filters: { statuses, request_types: requestTypes, user: args.user || null },
    stats: await models.VerificationRequest.getStats(),
    pagination: { total: result.count, returned: result.rows.length, limit },
    requests: result.rows.map(row => {
      const value = asPlain(row);
      return {
        id: value.id, status: value.status, request_type: value.request_type, reason: value.reason,
        created_at: value.created_at, processed_at: value.processed_at,
        user: publicUser(value.user), processor: publicUser(value.processor),
        form_data: args.include_form_data ? value.form_data : undefined,
        analysis_data: args.include_analysis ? value.analysis_data : undefined,
        gemini_response: args.include_analysis ? value.gemini_response : undefined
      };
    })
  };
}

async function unfollowUser(models, targetUser) {
  if (!targetUser) throw new Error('Compte a ne plus suivre introuvable');
  if (String(targetUser.id) === String(POLICE_ACCOUNT_ID)) throw new Error('Impossible de ne plus suivre soi-meme');

  const existingFollow = await models.UserFollow.findOne({
    where: { follower_id: POLICE_ACCOUNT_ID, following_id: targetUser.id }
  });
  if (!existingFollow) {
    return { success: true, action: 'UNFOLLOW', already_unfollowed: true, target: publicUser(targetUser) };
  }

  await existingFollow.destroy();
  try {
    const similarity = require('../../similarity');
    similarity.onUnfollow(POLICE_ACCOUNT_ID, targetUser.id);
    const videoRecommendationService = require('../../videoRecommendationService');
    videoRecommendationService.onFollow(POLICE_ACCOUNT_ID, targetUser.id, false);
  } catch (_) {}

  return { success: true, action: 'UNFOLLOW', target: publicUser(targetUser) };
}

async function buyPremiumSubscription(models, { tier = TIER.PLUS, duration_days = DEFAULT_DURATION_DAYS } = {}) {
  const selectedTier = [TIER.PLUS, TIER.PRO].includes(String(tier).toLowerCase())
    ? String(tier).toLowerCase()
    : null;
  if (!selectedTier) throw new Error('Palier invalide: utilise plus ou pro');

  const durationDays = Math.max(1, Math.min(365, parseInt(duration_days, 10) || DEFAULT_DURATION_DAYS));
  const transaction = await models.sequelize.transaction();
  try {
    const user = await models.User.findByPk(POLICE_ACCOUNT_ID, { transaction, lock: true });
    if (!user) throw new Error('Compte PolicierCongo introuvable');

    await maybeExpireSubscription(user, transaction);
    await user.reload({ transaction, lock: true });

    const active = isSubscriptionActive(user);
    if (active && user.subscription_tier === TIER.PRO && selectedTier === TIER.PLUS) {
      throw new Error('PolicierCongo a deja un abonnement Pro actif; impossible d acheter Plus');
    }

    let price = TIER_PRICES_TWC[selectedTier];
    let itemId = `subscription_${selectedTier}_${DEFAULT_DURATION_DAYS}d`;
    let description = `Abonnement ${selectedTier === TIER.PLUS ? 'Plus' : 'Pro'} (${durationDays} j.)`;

    if (active && user.subscription_tier === TIER.PLUS && selectedTier === TIER.PRO) {
      price = TIER_PRICES_TWC[TIER.PRO] - TIER_PRICES_TWC[TIER.PLUS];
      itemId = 'subscription_upgrade_plus_to_pro';
      description = 'Mise a niveau Plus -> Pro';
      if (price <= 0) throw new Error('Montant de mise a niveau invalide');
    }

    const currency = await getPlatformCurrency({ transaction });
    if (!currency) throw new Error('Cryptomonnaie non trouvee');

    await NewEconomyService.ensureWalletsForUser(POLICE_ACCOUNT_ID, transaction);
    const userWallet = await NewEconomyService.getUserWallet(currency.id, POLICE_ACCOUNT_ID, transaction);
    if (userWallet.wallet.balance < price) {
      throw new Error(`Solde insuffisant: ${userWallet.wallet.balance} ${currency.symbol}, requis ${price} ${currency.symbol}`);
    }

    const spendResult = await NewEconomyService.spendCoins(
      POLICE_ACCOUNT_ID,
      currency.id,
      price,
      'subscription_purchase',
      itemId,
      description,
      transaction
    );

    const nextExpiry = active && user.subscription_tier === TIER.PLUS && selectedTier === TIER.PRO
      ? (user.subscription_expires_at ? new Date(user.subscription_expires_at) : computeNewExpiry(user, durationDays))
      : computeNewExpiry(user, durationDays);

    await user.update({
      subscription_tier: selectedTier,
      subscription_expires_at: nextExpiry,
      tweet_generation_credits: creditsAfterSubscriptionPurchase(user.tweet_generation_credits),
      updated_at: new Date()
    }, { transaction });

    await transaction.commit();
    return {
      success: true,
      action: 'BUY_PREMIUM_SUBSCRIPTION',
      premium: true,
      subscription_tier: selectedTier,
      subscription_expires_at: nextExpiry,
      tweet_generation_credits: user.tweet_generation_credits,
      tweet_generation_credits_granted: SUBSCRIPTION_TWEET_CREDITS,
      duration_days: durationDays,
      amount_spent: price,
      currency: currency.symbol,
      transaction_id: spendResult.transaction.transactionHash,
      remaining_balance: spendResult.remainingBalance
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

function registerPlatformTools(registry, { models, memory, config, providerRouter }) {
  const executor = new ActionExecutor();
  const collector = new DataCollector();
  let collectorInitialization = null;
  const withCollector = async task => {
    if (!collector.initialized) {
      collectorInitialization ||= collector.initialize().catch(error => {
        collectorInitialization = null;
        throw error;
      });
      await collectorInitialization;
    }
    const result = await task();
    if (result === null || result === undefined) throw new Error('Le collecteur PolicierCongo n’a renvoyé aucune donnée exploitable');
    return result;
  };
  const register = definition => registry.register(definition);

  register({
    name: 'advanced_search_tweets', risk: TOOL_RISK.READ,
    description: 'Recherche analytique multi-filtres des tweets. Distingue auteur de la réponse, auteur du parent et auteur du post racine; trie, pagine et renvoie les métriques. À rappeler avec des filtres affinés après chaque observation.',
    inputSchema: ADVANCED_SEARCH_SCHEMA,
    handler: args => advancedSearchTweets(args, { models, config })
  });
  register({ name: 'get_my_profile', risk: TOOL_RISK.READ, description: 'Lit le profil public actuel du compte PolicierCongo.', inputSchema: object({}),
    handler: async () => publicUser(await models.User.findByPk(POLICE_ACCOUNT_ID)) });
  register({
    name: 'get_own_recent_posts', risk: TOOL_RISK.READ,
    description: 'Liste les derniers posts publiés par PolicierCongo (racines uniquement), du plus récent au plus ancien. À consulter avant post_tweet/reply_to_tweet si tu veux éviter de reprendre le même angle ou la même ouverture qu’un post récent — rien n’oblige à l’appeler, et rien ne bloque une publication qui se ressemble si tu choisis quand même de la publier.',
    inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 50 } }),
    handler: async ({ limit = 15 }) => {
      const posts = await models.Tweet.findAll({
        where: { user_id: POLICE_ACCOUNT_ID, parent_tweet_id: null },
        order: [['created_at', 'DESC']],
        limit: Math.max(1, Math.min(50, limit))
      });
      return { count: posts.length, posts: posts.map(publicTweet) };
    }
  });
  register({ name: 'get_user', risk: TOOL_RISK.READ, description: 'Résout un utilisateur par UUID ou username et renvoie son profil public. À utiliser avant une action ciblée.',
    inputSchema: object({ target: { type: 'string', maxLength: 100 } }, ['target']), handler: async ({ target }) => publicUser(await resolveUser(models, target)) });
  register({
    name: 'get_recent_private_messages', risk: TOOL_RISK.READ,
    description: 'Lit les derniers messages de la conversation privee directe entre PolicierCongo et un utilisateur resolu. Par defaut renvoie les 5 derniers DMs en ordre chronologique.',
    inputSchema: object({
      target: { type: 'string', maxLength: 100 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      before: { type: 'string', maxLength: 80 }
    }, ['target']),
    handler: args => getPrivateMessagesWithUser(models, args)
  });
  register({
    name: 'search_private_messages', risk: TOOL_RISK.READ,
    description: 'Recherche un terme dans les DMs directs entre PolicierCongo et un utilisateur, puis renvoie chaque match avec un contexte configurable avant/apres (3 messages avant et 3 apres par defaut). Sert comme advanced search prive avec filtres bornes.',
    inputSchema: object({
      target: { type: 'string', maxLength: 100 },
      query: { type: 'string', maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 30 },
      context_before: { type: 'integer', minimum: 0, maximum: 20 },
      context_after: { type: 'integer', minimum: 0, maximum: 20 },
      sender: { type: 'string', enum: ['any','policiercongo','user'] },
      since: { type: 'string', maxLength: 80 },
      until: { type: 'string', maxLength: 80 },
      order: { type: 'string', enum: ['recent','oldest'] }
    }, ['target','query']),
    handler: args => searchPrivateMessagesWithUser(models, args)
  });
  register({
    name: 'expand_private_message_context', risk: TOOL_RISK.READ,
    description: 'Elargit le contexte autour d un message prive deja trouve dans les DMs avec un utilisateur. Utilise message_id depuis search_private_messages ou get_recent_private_messages.',
    inputSchema: object({
      target: { type: 'string', maxLength: 100 },
      message_id: UUID,
      before: { type: 'integer', minimum: 0, maximum: 50 },
      after: { type: 'integer', minimum: 0, maximum: 50 }
    }, ['target','message_id']),
    handler: args => expandPrivateMessageContext(models, args)
  });
  register({ name: 'get_tweet', risk: TOOL_RISK.READ, description: 'Lit un tweet precis, son auteur et ses compteurs agreges sans charger toutes les listes de likes/RT/commentaires. Verifie la cible avant reponse, like, repost ou moderation.',
    inputSchema: object({ tweet_id: UUID }, ['tweet_id']), handler: async ({ tweet_id }) => {
      const summary = await getTweetEngagementSummary(models, { tweet_id });
      return summary.found ? summary.tweet : null;
    } });
  register({
    name: 'get_tweet_engagement_summary', risk: TOOL_RISK.READ,
    description: 'Compte proprement les commentaires, commentateurs uniques, likes, retweets, vues et participants complets (com + like + RT) d un tweet. Quand il y a beaucoup de commentaires, renvoie surtout les nombres agreges au lieu de lister la foule.',
    inputSchema: object({
      tweet_id: UUID,
      sample_limit: { type: 'integer', minimum: 0, maximum: 50 }
    }, ['tweet_id']),
    handler: args => getTweetEngagementSummary(models, args)
  });
  register({
    name: 'pick_random_commenter', risk: TOOL_RISK.READ,
    description: 'Tire au hasard un utilisateur parmi les commentaires directs d un tweet, optionnellement seulement parmi ceux qui ont aussi like et/ou retweet. Utile pour choisir un gagnant de concours sans lister tous les participants.',
    inputSchema: object({
      tweet_id: UUID,
      require_like: { type: 'boolean' },
      require_retweet: { type: 'boolean' },
      unique_user: { type: 'boolean' }
    }, ['tweet_id']),
    handler: args => pickRandomCommenter(models, args)
  });
  register({ name: 'get_thread', risk: TOOL_RISK.READ, description: 'Reconstruit un fil autour d’un tweet: ancêtres jusqu’à la racine puis réponses descendantes. Utilise depth pour contrôler le volume.',
    inputSchema: object({ tweet_id: UUID, depth: { type: 'integer', minimum: 1, maximum: 8 }, replies_per_node: { type: 'integer', minimum: 1, maximum: 100 } }, ['tweet_id']),
    handler: async ({ tweet_id, depth = 4, replies_per_node = 30 }) => {
      let current = await models.Tweet.findByPk(tweet_id, { include: [{ model: models.User, as: 'author' }] });
      if (!current) return { found: false };
      const ancestors = []; let cursor = current;
      while (cursor?.parent_tweet_id && ancestors.length < 100) {
        cursor = await models.Tweet.findByPk(cursor.parent_tweet_id, { include: [{ model: models.User, as: 'author' }] });
        if (!cursor) break; ancestors.unshift(publicTweet(cursor));
      }
      const loadReplies = async (id, remaining) => {
        if (remaining <= 0) return [];
        const rows = await models.Tweet.findAll({ where: { parent_tweet_id: id }, include: [{ model: models.User, as: 'author' }], order: [['created_at','ASC']], limit: replies_per_node });
        return Promise.all(rows.map(async row => ({ ...publicTweet(row), replies: await loadReplies(row.id, remaining - 1) })));
      };
      return { found: true, ancestors, target: publicTweet(current), replies: await loadReplies(current.id, depth) };
    }
  });
  register({ name: 'get_timeline', risk: TOOL_RISK.READ, description: 'Lit les posts racines récents. Pour une recherche relationnelle ou précise, préfère advanced_search_tweets.',
    inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string' } }),
    handler: async ({ limit = 30, before }) => (await models.Tweet.findAll({ where: { parent_tweet_id: null, moderation_status: 'approved', ...(before ? { created_at: { [Op.lt]: new Date(before) } } : {}) }, include: [{ model: models.User, as: 'author' }], order: [['created_at','DESC']], limit })).map(publicTweet) });
  register({ name: 'get_notifications', risk: TOOL_RISK.READ, description: 'Lit les notifications reçues par PolicierCongo avec filtres lu/non-lu et types.',
    inputSchema: object({ unread_only: { type: 'boolean' }, types: { type: 'array', items: { type: 'string', enum: ['like','retweet','reply','mention','follow','unfollow','quote','system','verification','premium'] }, maxItems: 10 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    handler: async ({ unread_only = false, types = [], limit = 50 }) => asPlain(await models.Notification.findAll({ where: { recipient_id: POLICE_ACCOUNT_ID, ...(unread_only ? { is_read: false } : {}), ...(types.length ? { type: { [Op.in]: types } } : {}) }, include: [{ model: models.User, as: 'sender' }, { model: models.Tweet, as: 'tweet' }], order: [['created_at','DESC']], limit })) });
  register({ name: 'get_platform_rules', risk: TOOL_RISK.READ, description: 'Lit les règles TwitNinf réellement appliquées. À utiliser seulement avant une action ambiguë, limite ou sensible; inutile sur les tours ordinaires.',
    inputSchema: object({ scope: { type: 'string', enum: ['all','recommendation','limited_reach','prohibited','privacy','spam','partners'] }, question: { type: 'string', maxLength: 1000 } }),
    handler: ({ scope = 'all', question = '' }) => ({ ...getPlatformRules(scope), question: question || null }) });
  register({ name: 'get_affiliated_agencies', risk: TOOL_RISK.READ, description: 'Liste les agences affiliées à TwitNinf (partenariats de promotion) et les comptes qui leur sont liés.', inputSchema: object({}), handler: () => listAgencies() });
  register({
    name: 'get_agency_affiliation', risk: TOOL_RISK.READ,
    description: 'Cherche le lien agence ↔ compte : passe username pour trouver l’agence d’une personne, agency pour lister les comptes liés à une agence, ou aucun des deux pour avoir toute la table de correspondance.',
    inputSchema: object({ username: { type: 'string', maxLength: 100 }, agency: { type: 'string', maxLength: 100 } }),
    handler: ({ username, agency } = {}) => getAgencyAffiliation({ username, agency })
  });
  register({ name: 'get_trends', risk: TOOL_RISK.READ, description: 'Calcule les tendances réelles à partir des posts racines publics approuvés: hashtags, contenus en momentum et métriques.',
    inputSchema: object({ period: { type: 'string', enum: ['1h','24h','7d','30d'] }, limit: { type: 'integer', minimum: 1, maximum: 50 } }),
    handler: args => getTrendsSnapshot(models, args) });
  register({
    name: 'suggest_tweet_topics', risk: TOOL_RISK.READ,
    description: 'Rassemble ce qui se passe réellement sur TwitNinf pour trouver quoi tweeter: hashtags et posts en momentum, débats actifs (beaucoup de réponses de personnes différentes, pas un flood d’une seule), et climat de modération en agrégat. Ne choisit rien à ta place: des candidats groundés, jamais des sujets imposés ni inventés.',
    inputSchema: object({
      window_hours: { type: 'integer', minimum: 1, maximum: 168 },
      limit: { type: 'integer', minimum: 1, maximum: 30 },
      min_replies: { type: 'integer', minimum: 1, maximum: 50 }
    }),
    handler: args => getTweetTopicSuggestions(models, args)
  });
  register({ name: 'get_verification_requests', risk: TOOL_RISK.READ, description: 'Lit les demandes de vérification avec statuts, types, utilisateur et statistiques. Les données détaillées du formulaire ou de l’analyse sont exclues par défaut.',
    inputSchema: object({
      statuses: { type: 'array', items: { type: 'string', enum: ['pending','approved','rejected','under_review'] }, maxItems: 4 },
      request_types: { type: 'array', items: { type: 'string', enum: ['individual','brand','organization','celebrity'] }, maxItems: 4 },
      user: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      include_form_data: { type: 'boolean' }, include_analysis: { type: 'boolean' }
    }), handler: args => getVerificationRequestsSnapshot(models, args) });
  register({
    name: 'request_self_verification', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Soumet une demande de badge vérifié pour le compte PolicierCongo lui-même. Analysée EN DIRECT par l’AUTRE modèle IA (jamais celui qui a pris la décision) — pas de file d’attente humaine, la décision et son raisonnement reviennent dans la même réponse. N’utilise cet outil qu’avec une justification concrète et vérifiable ; une demande vague sera refusée par le second avis.',
    inputSchema: object({
      reason: { type: 'string', minLength: 20, maxLength: 2000 },
      request_type: { type: 'string', enum: ['individual', 'brand', 'organization', 'celebrity'] },
      evidence: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 10 }
    }, ['reason']),
    handler: async ({ reason, request_type, evidence = [] }, ctx) => {
      const bot = await models.User.findByPk(POLICE_ACCOUNT_ID);
      if (!bot) throw new Error('Compte PolicierCongo introuvable');
      if (bot.verified) return { already_verified: true, user: publicUser(bot) };

      const pending = await models.VerificationRequest.findOne({
        where: { user_id: POLICE_ACCOUNT_ID, status: { [Op.in]: ['pending', 'under_review'] } },
        order: [['created_at', 'DESC']]
      });
      if (pending) throw new Error(`Une demande est déjà en cours (id ${pending.id}, statut ${pending.status}). Attends sa résolution avant d’en soumettre une nouvelle.`);

      if (!providerRouter) throw new Error('providerRouter non configuré : impossible d’obtenir un second avis en direct.');

      const request = await models.VerificationRequest.createVerificationRequest(
        POLICE_ACCOUNT_ID,
        { reason, evidence, submitted_by: 'self', submitted_at: new Date().toISOString() },
        request_type || 'organization'
      );

      const verdict = await reviewSelfVerificationRequest({
        providerRouter,
        primaryProvider: ctx.provider,
        botProfile: publicUser(bot),
        formData: { request_type: request_type || 'organization', reason, evidence },
        signal: ctx.signal
      }, config);

      if (verdict.approved) {
        await request.approve(POLICE_ACCOUNT_ID, `[Second avis ${verdict.verifier}] ${verdict.reasoning}`);
      } else {
        await request.reject(POLICE_ACCOUNT_ID, `[Second avis ${verdict.verifier || 'indisponible'}] ${verdict.reasoning}`);
      }
      const refreshed = await models.User.findByPk(POLICE_ACCOUNT_ID);

      return {
        request_id: request.id,
        approved: verdict.approved,
        verified: refreshed.verified,
        verifier: verdict.verifier,
        reasoning: verdict.reasoning,
        user: publicUser(refreshed)
      };
    }
  });
  register({ name: 'collect_ecosystem', risk: TOOL_RISK.READ, description: 'Produit en parallèle un snapshot borné des dernières 24 h: posts racines, réponses à PolicierCongo, notifications et compteurs. Optimisé pour commencer un cycle proactif.', inputSchema: object({}), handler: () => collectEcosystemSnapshot(models) });
  register({ name: 'get_account_stats', risk: TOOL_RISK.READ, description: 'Calcule un snapshot borné des statistiques d’un compte résolu par id ou username, avec ses dix tweets récents.', inputSchema: object({ target: { type: 'string' } }, ['target']), handler: async ({ target }) => { const user = await resolveUser(models, target); return user ? getAccountStatsSnapshot(models, user) : { found: false }; } });
  register({ name: 'get_financial_context', risk: TOOL_RISK.SENSITIVE, description: 'Lit les données financières utiles au compte PolicierCongo. Réservé aux tours autorisés sensibles.', inputSchema: object({}), handler: () => withCollector(() => collector.collectFinancialData()) });
  register({
    name: 'recall_memory', risk: TOOL_RISK.READ,
    description: 'Recherche la mémoire longue par pertinence sémantique et lexicale. Accepte une entité (username) pour retrouver tout ce qui concerne une personne précise, depuis n’importe quelle conversation. Un souvenir n’est pas une preuve de l’état actuel de la plateforme.',
    inputSchema: object({
      query: { type: 'string', maxLength: 2000 },
      entity: { type: 'string', maxLength: 64 },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    }, ['query']),
    handler: (args, ctx) => memory.recall({
      userId: ctx.event.userId, threadId: ctx.event.threadId, query: args.query, limit: args.limit,
      entityKeys: args.entity ? [entityKey(args.entity)].filter(Boolean) : []
    })
  });
  register({
    name: 'remember', risk: TOOL_RISK.WRITE,
    description: 'Écrit une mémoire longue atomique. scope=user pour le compte qui parle; scope=self pour l’identité, les engagements et relations durables de PolicierCongo, visibles dans toutes ses conversations. kind=correction avec supersedes retire réellement le souvenir erroné du rappel.',
    inputSchema: object({
      kind: { type: 'string', enum: ['fact','preference','relationship','commitment','episode','procedure','self','correction'] },
      scope: { type: 'string', enum: ['user','thread','global','self'] },
      content: { type: 'string', maxLength: 4000 },
      entity: { type: 'string', maxLength: 64 },
      supersedes: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      importance: { type: 'number', minimum: 0, maximum: 1 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      pinned: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 12 }
    }, ['kind','scope','content']),
    handler: (args, ctx) => memory.writeMemories([args], { userId: ctx.event.userId, threadId: ctx.event.threadId, source: 'remember_tool' })
  });
  register({
    name: 'forget_memory', risk: TOOL_RISK.WRITE,
    description: 'Retire définitivement un souvenir du rappel, par son id. À utiliser quand une information est fausse, périmée, ou quand la personne demande qu’elle soit oubliée. Le souvenir reste auditable mais n’influence plus rien.',
    inputSchema: object({ memory_id: { type: 'string', maxLength: 128 }, reason: { type: 'string', maxLength: 500 } }, ['memory_id']),
    handler: async ({ memory_id, reason }) => {
      const forgotten = await memory.forgetMemory(memory_id, reason || null);
      if (!forgotten) throw new Error(`Aucun souvenir actif avec l’id ${memory_id}`);
      return { forgotten: true, memory: forgotten };
    }
  });

  const action = (name, risk, description, schema, build) => register({ name, risk, description, inputSchema: schema, idempotent: true,
    handler: async (args, ctx) => executor.execute(build(args, ctx)) });
  register({
    name: 'post_tweet', risk: TOOL_RISK.WRITE, idempotent: true,
    description: 'Publie un nouveau post racine de 600 caractères maximum.',
    inputSchema: object({ content: CONTENT, tweet_type: { type: 'string', enum: ['tweet','video'] }, reason: { type: 'string', maxLength: 500 } }, ['content']),
    handler: async args => executor.execute({ action: 'POST', reason: args.reason, details: { content: args.content, tweet_type: args.tweet_type || 'tweet' } })
  });
  register({ name: 'reply_to_tweet', risk: TOOL_RISK.WRITE, description: 'Crée une réponse directe sous le tweet_id exact. Pour répondre à un commentaire ou à son auteur, tweet_id doit impérativement être l’ID du commentaire, pas celui du post racine. Vérifie automatiquement l’auteur cible avant exécution.',
    inputSchema: object({ tweet_id: UUID, content: CONTENT, target_user: { type: 'string', maxLength: 100 }, reason: { type: 'string', maxLength: 500 } }, ['tweet_id','content']), idempotent: true,
    handler: async args => {
      const targetTweet = await models.Tweet.findByPk(args.tweet_id, { include: [{ model: models.User, as: 'author' }] });
      if (!targetTweet) throw new Error('Tweet cible introuvable');
      return executor.execute({ action: 'REPLY', reason: args.reason, details: { parent_tweet_id: args.tweet_id, response_content: args.content, target_user: args.target_user || targetTweet.author?.username || targetTweet.user_id } });
    } });
  action('like_tweet', TOOL_RISK.WRITE, 'Like un tweet observé.', object({ tweet_id: UUID, reason: { type: 'string' } }, ['tweet_id']), args => ({ action: 'LIKE', reason: args.reason, details: { parent_tweet_id: args.tweet_id } }));
  action('repost_tweet', TOOL_RISK.WRITE, 'Reposte un tweet observé.', object({ tweet_id: UUID, reason: { type: 'string' } }, ['tweet_id']), args => ({ action: 'REPOST', reason: args.reason, details: { parent_tweet_id: args.tweet_id } }));
  register({
    name: 'follow_user', risk: TOOL_RISK.WRITE, idempotent: true,
    description: 'Suit un compte résolu (username ou ID).',
    inputSchema: object({ target: { type: 'string', maxLength: 100 }, reason: { type: 'string', maxLength: 500 } }, ['target']),
    handler: async ({ target, reason }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error('Compte à suivre introuvable');
      return executor.execute({ action: 'FOLLOW', reason, details: { target_user_id: user.id } });
    }
  });
  register({
    name: 'unfollow_user', risk: TOOL_RISK.WRITE, idempotent: true,
    description: 'Ne suit plus un compte resolu (username ou ID). Idempotent: reussit aussi si PolicierCongo ne suivait deja plus la cible.',
    inputSchema: object({ target: { type: 'string', maxLength: 100 }, reason: { type: 'string', maxLength: 500 } }, ['target']),
    handler: async ({ target }) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error('Compte a ne plus suivre introuvable');
      return unfollowUser(models, user);
    }
  });
  register({ name: 'send_private_message', risk: TOOL_RISK.WRITE, description: 'Envoie un DM unique à un utilisateur résolu.', inputSchema: object({ target: { type: 'string', maxLength: 100 }, content: { type: 'string', maxLength: 3000 } }, ['target','content']), idempotent: true, handler: async ({ target, content }) => { const user = await resolveUser(models, target); if (!user) throw new Error('Destinataire introuvable'); return messagingManager.sendPrivateMessage(user.id, content); } });
  register({
    name: 'send_outbound_private_message', risk: TOOL_RISK.WRITE,
    description: 'Ouvre ou retrouve une conversation directe et envoie un MP initie par PolicierCongo a un autre utilisateur. A utiliser quand PolicierCongo veut contacter quelqu un de lui-meme, pas pour livrer la reponse au DM/chat courant.',
    inputSchema: object({
      target: { type: 'string', maxLength: 100 },
      content: { type: 'string', maxLength: 3000 },
      reason: { type: 'string', maxLength: 500 }
    }, ['target','content']),
    idempotent: true,
    handler: async ({ target, content, reason }, ctx) => {
      const user = await resolveUser(models, target);
      if (!user) throw new Error('Destinataire introuvable');
      if (String(user.id) === String(POLICE_ACCOUNT_ID)) throw new Error('Impossible d envoyer un MP a soi-meme');
      if (ctx.event?.trigger === 'direct_message' && String(user.id) === String(ctx.event.userId || '')) {
        throw new Error('Pour repondre au DM courant, utilise final: la route livre deja cette reponse. Cet outil sert aux MPs sortants vers un autre utilisateur.');
      }
      const sourceConversationId = ctx.event?.trigger === 'direct_message'
        ? String(ctx.event.threadId || '').replace(/^conv_/, '')
        : null;
      const isPendingReplyForwardTurn = String(ctx.event?.context?.legacyContextPack || '').includes('PROMESSE EN ATTENTE:');
      return messagingManager.sendOutboundPrivateMessage(user.id, content, {
        reason,
        relayToUserId: ctx.event?.trigger === 'direct_message' && !isPendingReplyForwardTurn ? ctx.event.userId : null,
        relayToUsername: ctx.event?.trigger === 'direct_message' && !isPendingReplyForwardTurn ? ctx.event.username : null,
        sourceConversationId,
        fulfillPendingReplyConversationId: isPendingReplyForwardTurn ? sourceConversationId : null
      });
    }
  });
  register({
    name: 'get_contract', risk: TOOL_RISK.READ,
    description: 'Consulte un contrat créé via /createcontrat par un utilisateur vérifié : texte, statut, messages échangés depuis sa création.',
    inputSchema: object({ contract_id: UUID }, ['contract_id']),
    handler: async ({ contract_id }) => {
      const contract = await contractService.getContract(contract_id);
      if (!contract) throw new Error('Contrat introuvable');
      return asPlain(contract);
    }
  });
  register({
    name: 'accept_contract', risk: TOOL_RISK.WRITE, idempotent: false,
    description: 'Accepte un contrat en attente créé via /createcontrat. Le contrat est figé (fin de capture des messages) et sert ensuite de justificatif, notamment pour send_money.',
    inputSchema: object({ contract_id: UUID, reason: { type: 'string', maxLength: 1000 } }, ['contract_id']),
    handler: async ({ contract_id, reason }) => asPlain(await contractService.acceptContract(contract_id, reason))
  });
  register({
    name: 'refuse_contract', risk: TOOL_RISK.WRITE, idempotent: false,
    description: 'Refuse un contrat en attente créé via /createcontrat. Le contrat et sa copie de messages sont supprimés (le DM d\'origine n\'est jamais touché).',
    inputSchema: object({ contract_id: UUID, reason: { type: 'string', maxLength: 1000 } }, ['contract_id']),
    handler: async ({ contract_id, reason }) => contractService.refuseContract(contract_id, reason)
  });
  action('update_profile', TOOL_RISK.SENSITIVE, 'Met à jour un ou plusieurs champs du profil PolicierCongo.', object({ username: { type: 'string', maxLength: 30 }, full_name: { type: 'string', maxLength: 100 }, bio: { type: 'string', maxLength: 300 }, avatar: { type: 'string' }, reason: { type: 'string' } }), args => ({ action: 'UPDATE_PROFILE', reason: args.reason, details: { new_username: args.username, new_full_name: args.full_name, new_bio: args.bio, new_profile_picture: args.avatar } }));
  action('report_content', TOOL_RISK.SENSITIVE, 'Signale un tweet ou un utilisateur avec raison et gravité observables.', object({ target_id: { type: 'string' }, target_type: { type: 'string', enum: ['tweet','user'] }, reason: { type: 'string', maxLength: 1000 }, severity: { type: 'string', enum: ['low','medium','high','critical'] } }, ['target_id','target_type','reason']), args => ({ action: 'MODERATE', reason: args.reason, details: { target_id: args.target_id, ...(args.target_type === 'tweet' ? { parent_tweet_id: args.target_id } : { target_user: args.target_id }), severity: args.severity || 'medium' } }));
  action('delete_own_tweet', TOOL_RISK.WRITE, 'Supprime un tweet appartenant au compte PolicierCongo.', object({ tweet_id: UUID, reason: { type: 'string', maxLength: 1000 }, legal_justification: { type: 'string', maxLength: 1000 } }, ['tweet_id','reason']), args => ({ action: 'DELETE_TWEET', reason: args.reason, details: { parent_tweet_id: args.tweet_id, delete_reason: args.reason, legal_justification: args.legal_justification, emergency_level: 'approved_v3' } }));
  register({
    name: 'check_ban_status', risk: TOOL_RISK.READ,
    description: 'Lit uniquement le statut de suspension/bannissement du compte PolicierCongo: raison, date, duree restante, caractere permanent, derniere sanction et recours actuel.',
    inputSchema: object({}),
    handler: () => getPoliceBanStatus(models)
  });
  register({
    name: 'appeal_ban', risk: TOOL_RISK.WRITE, idempotent: false,
    description: 'Cree le recours de debannissement de PolicierCongo pour la suspension actuelle. Un seul recours est autorise par suspension active; si deja envoye, renvoie le ticket existant.',
    inputSchema: object({ reason: { type: 'string', maxLength: 2000 } }, ['reason']),
    handler: async ({ reason }) => {
      const status = await getPoliceBanStatus(models);
      if (!status.suspended) {
        return { created: false, reason: 'Compte PolicierCongo non suspendu', status };
      }
      if (status.appeal_already_sent) {
        return { created: false, already_sent: true, ticket: status.appeal, status };
      }
      const ticket = await models.UnbanTicket.create({
        user_id: POLICE_ACCOUNT_ID,
        reason,
        status: 'pending'
      });
      return {
        created: true,
        ticket: publicUnbanTicket(ticket),
        status: await getPoliceBanStatus(models)
      };
    }
  });
  register({
    name: 'check_appeal_response', risk: TOOL_RISK.READ,
    description: 'Lit la derniere reponse au recours de PolicierCongo, si un recours existe deja: pending, approved ou rejected avec notes admin.',
    inputSchema: object({}),
    handler: async () => {
      const status = await getPoliceBanStatus(models);
      return {
        has_appeal: Boolean(status.appeal),
        ticket: status.appeal,
        appeal_status: status.appeal?.status || null,
        admin_response: status.appeal?.admin_notes || null,
        processed_at: status.appeal?.processed_at || null,
        ban_status: status
      };
    }
  });
  action('request_unban', TOOL_RISK.SENSITIVE, 'Crée une demande de débannissement argumentée.', object({ reason: { type: 'string', maxLength: 2000 } }, ['reason']), args => ({ action: 'UNBAN_REQUEST', reason: args.reason, details: { reason: args.reason } }));
  action('request_withdrawal', TOOL_RISK.SENSITIVE, 'Collecte immédiatement toutes les récompenses de monétisation en attente (vues/likes/RT/réponses sur tes tweets) et les crédite à ton portefeuille. Vérifie le montant en attente avec get_financial_context avant d\'appeler ce tool si besoin.', object({ reason: { type: 'string' } }, []), args => ({ action: 'REQUEST_WITHDRAWAL', reason: args.reason, details: args }));
  register({
    name: 'buy_premium_subscription', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Achete ou prolonge un abonnement Plus/Pro pour le compte PolicierCongo en depensant ses TWC/NF. Utilise get_financial_context avant si le solde est incertain.',
    inputSchema: object({
      tier: { type: 'string', enum: ['plus', 'pro'] },
      duration_days: { type: 'integer', minimum: 1, maximum: 365 },
      reason: { type: 'string', maxLength: 500 }
    }, ['tier', 'reason']),
    handler: async ({ tier, duration_days }) => buyPremiumSubscription(models, { tier, duration_days })
  });
  register({
    name: 'play_casino_wheel', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Mise des NF sur la roue casino officielle de TwitNinf. Le compte PolicierCongo choisit seulement la mise; la case est tiree cote serveur, sans choix de probabilite expose. Utilise get_financial_context avant si le solde est incertain; la mise est reellement depensee et irreversible.',
    inputSchema: object({
      amount: { type: 'number', minimum: 0.01 },
      mode: { type: 'string', enum: ['classic', 'boost', 'jackpot'] },
      reason: { type: 'string', maxLength: 300 }
    }, ['amount']),
    handler: async ({ amount, mode = 'classic' }) => {
      const currency = await getPlatformCurrency();
      if (!currency) throw new Error('Cryptomonnaie non trouvee');
      const result = await CasinoService.playWheel(POLICE_ACCOUNT_ID, currency.id, amount, mode);
      return { ...result, currency: currency.symbol };
    }
  });
  register({
    name: 'play_casino_dice', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Mise des NF au casino de la plateforme (jeu "dés" à provably-fair) : tu choisis une chance de gain en % et une mise, le multiplicateur de gain en découle automatiquement (avantage maison ~8% intégré, comme un vrai casino — perdant est plus fréquent que gagnant, mais un gain réel arrive régulièrement). Utilise get_financial_context avant si le solde est incertain ; get_casino_config pour connaître les bornes actuelles (mise min/max, chance min/max, avantage maison).',
    inputSchema: object({
      amount: { type: 'number', minimum: 0.01 },
      win_chance: { type: 'number', minimum: 1, maximum: 95 },
      reason: { type: 'string', maxLength: 300 }
    }, ['amount', 'win_chance']),
    handler: async ({ amount, win_chance }) => {
      const currency = await getPlatformCurrency();
      if (!currency) throw new Error('Cryptomonnaie non trouvée');
      const result = await CasinoService.playDice(POLICE_ACCOUNT_ID, currency.id, amount, win_chance);
      return { ...result, currency: currency.symbol };
    }
  });
  register({
    name: 'get_casino_config', risk: TOOL_RISK.READ,
    description: 'Lit les paramètres actuels du casino (avantage maison, mise min/max, chance de gain min/max, table de paiement des machines à sous) avant de jouer.',
    inputSchema: object({}),
    handler: () => CasinoService.getConfig()
  });
  register({
    name: 'play_casino_coinflip', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Mise des NF sur pile ou face : jeu à faible risque — gain fréquent (~45%) mais modeste (+20% de la mise), et ~20% de chance de tomber sur la tranche (mise rendue, ni gain ni perte). Le choix pile/face n\'affecte pas la chance de gagner, seulement le résultat affiché. Utilise get_financial_context avant si le solde est incertain ; la mise est réellement dépensée et irréversible.',
    inputSchema: object({
      amount: { type: 'number', minimum: 0.01 },
      choice: { type: 'string', enum: ['pile', 'face'] },
      reason: { type: 'string', maxLength: 300 }
    }, ['amount']),
    handler: async ({ amount, choice = 'pile' }) => {
      const currency = await getPlatformCurrency();
      if (!currency) throw new Error('Cryptomonnaie non trouvée');
      const result = await CasinoService.playCoinflip(POLICE_ACCOUNT_ID, currency.id, amount, choice);
      return { ...result, currency: currency.symbol };
    }
  });
  register({
    name: 'play_casino_slots', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Mise des NF à la machine à sous : jeu à forte variance — très difficile à gagner (~12% toutes combinaisons confondues, ~88% de perte sèche), mais aligner 3 symboles identiques paie un multiplicateur énorme (jusqu\'à x500 sur le symbole le plus rare). Consulte get_casino_config pour la table de paiement complète. Utilise get_financial_context avant si le solde est incertain ; la mise est réellement dépensée et irréversible.',
    inputSchema: object({
      amount: { type: 'number', minimum: 0.01 },
      reason: { type: 'string', maxLength: 300 }
    }, ['amount']),
    handler: async ({ amount }) => {
      const currency = await getPlatformCurrency();
      if (!currency) throw new Error('Cryptomonnaie non trouvée');
      const result = await CasinoService.playSlots(POLICE_ACCOUNT_ID, currency.id, amount);
      return { ...result, currency: currency.symbol };
    }
  });
  register({
    name: 'convert_nf_eur', risk: TOOL_RISK.READ,
    description: 'Convertit un montant entre la monnaie de la plateforme (NF) et l\'euro, au taux de change réel actuel (currentPrice de la cryptomonnaie, qui évolue avec la dilution du minage — jamais un taux fixe supposé). Utile pour répondre en euros à quelqu\'un qui raisonne en NF, ou l\'inverse.',
    inputSchema: object({
      amount: { type: 'number', minimum: 0 },
      direction: { type: 'string', enum: ['nf_to_eur', 'eur_to_nf'] }
    }, ['amount', 'direction']),
    handler: async ({ amount, direction }) => {
      const currency = await getPlatformCurrency();
      if (!currency) throw new Error('Cryptomonnaie non trouvée');
      const rate = Number(currency.currentPrice) || 0;
      if (rate <= 0) throw new Error('Taux de change actuel invalide (currentPrice <= 0)');
      const round2 = value => Math.round(value * 100) / 100;
      const converted = direction === 'nf_to_eur'
        ? { input: amount, input_unit: currency.symbol, output: round2(amount * rate), output_unit: 'EUR' }
        : { input: amount, input_unit: 'EUR', output: round2(amount / rate), output_unit: currency.symbol };
      return {
        currency: currency.symbol,
        exchange_rate_eur_per_nf: rate,
        exchange_rate_nf_per_eur: round2(1 / rate),
        converted
      };
    }
  });
  register({
    name: 'send_money', risk: TOOL_RISK.DESTRUCTIVE, idempotent: false,
    description: 'Envoie des TWC/NF de ton portefeuille vers un autre utilisateur. Transfert réel et irréversible (une petite commission plateforme est prélevée sur le montant envoyé). Vérifie ton solde avec get_financial_context avant d’appeler ce tool — un solde insuffisant fait échouer le transfert. Soumis au second avis croisé : dans reason, cite explicitement l’accord qui justifie le paiement (ex: tweet public d’entrée dans une agence affiliée comme la G Corp, montant et moment convenus, ou un contract_id d’un contrat accepté via accept_contract) — le vérificateur ne voit que ce que tu écris ici, pas le fil de conversation. Pour un paiement basé sur un contrat, cite l’ID du contrat et rappelle les termes clés dans reason : le vérificateur peut consulter le contrat via get_contract mais ne le fait pas automatiquement.',
    inputSchema: object({
      target: { type: 'string', maxLength: 100 },
      amount: { type: 'number', minimum: 0.01 },
      reason: { type: 'string', minLength: 5, maxLength: 500 }
    }, ['target', 'amount', 'reason']),
    handler: async ({ target, amount, reason }) => {
      const recipient = await resolveUser(models, target);
      if (!recipient) throw new Error('Destinataire introuvable');
      if (recipient.id === POLICE_ACCOUNT_ID) throw new Error('Impossible de s’envoyer de l’argent à soi-même');

      const currency = await getPlatformCurrency();
      if (!currency) throw new Error('Cryptomonnaie non trouvée');

      const result = await NewEconomyService.transferCoins(POLICE_ACCOUNT_ID, recipient.id, currency.id, amount, reason);

      return {
        sent: true,
        amount_sent: amount,
        fee: result.fee,
        amount_received: result.netAmount,
        currency: currency.symbol,
        recipient: publicUser(recipient),
        reason
      };
    }
  });

  register({
    name: 'exchange_nf_eur', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Échange RÉEL entre le portefeuille NF et le portefeuille EUR interne de PolicierCongo, au cours réel courant du NF — contrairement à convert_nf_eur qui ne fait que calculer sans rien déplacer. direction=nf_to_eur débite `amount` NF pour créditer de l’EUR ; eur_to_nf fait l’inverse. Les deux portefeuilles appartiennent à PolicierCongo (aucun tiers impliqué, pas de second avis requis), mais l’opération est réelle, irréversible, et déplace légèrement le cours du NF (impact de marché). Vérifie ton solde avec get_financial_context avant si besoin.',
    inputSchema: object({
      amount: { type: 'number', minimum: 0.00000001 },
      direction: { type: 'string', enum: ['nf_to_eur', 'eur_to_nf'] }
    }, ['amount', 'direction']),
    handler: async ({ amount, direction }) => {
      const nfCurrency = await getPlatformCurrency({ fresh: true });
      if (!nfCurrency || !(Number(nfCurrency.currentPrice) > 0)) throw new Error('Taux de change NF indisponible');
      const eurCurrency = await getOrCreateEurCurrency();
      const nfPriceEur = Number(nfCurrency.currentPrice);

      const fromCurrencyId = direction === 'eur_to_nf' ? eurCurrency.id : nfCurrency.id;
      const toCurrencyId = direction === 'eur_to_nf' ? nfCurrency.id : eurCurrency.id;
      const rate = direction === 'eur_to_nf' ? (1 / nfPriceEur) : nfPriceEur;

      const result = await NewEconomyService.exchangeCurrency(POLICE_ACCOUNT_ID, fromCurrencyId, toCurrencyId, amount, rate);

      return {
        direction,
        debited: result.debited,
        credited: result.credited,
        fromBalance: result.fromBalance,
        toBalance: result.toBalance,
        nfPriceEur
      };
    }
  });

  register({
    name: 'trade_community_currency', risk: TOOL_RISK.SENSITIVE, idempotent: false,
    description: 'Achète ou vend une monnaie COMMUNAUTAIRE (émise par un utilisateur, ex. via create_user_currency côté mobile) contre NF ou EUR, depuis le portefeuille de PolicierCongo. direction=buy dépense `amount` en `counterpart` (NF ou EUR) pour investir dans `currency` — utile pour soutenir une monnaie qu’on juge sous-évaluée. direction=sell vend `amount` unités de `currency` détenues contre `counterpart`. Le taux part des prix réels en euros des deux monnaies (currentPrice) ; consulte get_community_currency avant un montant important, car chaque échange déplace légèrement le cours des deux monnaies (impact de marché). Aucun tiers impliqué (les deux portefeuilles sont les tiens), pas de second avis requis, mais l’opération est réelle et irréversible.',
    inputSchema: object({
      currency: { type: 'string', maxLength: 100 },
      counterpart: { type: 'string', enum: ['NF', 'EUR'] },
      direction: { type: 'string', enum: ['buy', 'sell'] },
      amount: { type: 'number', minimum: 0.00000001 }
    }, ['currency', 'counterpart', 'direction', 'amount']),
    handler: async ({ currency, counterpart, direction, amount }) => {
      const currencyRow = await resolveCommunityCurrency(models, currency);
      if (!currencyRow) throw new Error(`Monnaie communautaire introuvable: ${currency}`);

      const result = await convertUserCurrency(POLICE_ACCOUNT_ID, currencyRow.id, counterpart, amount, { reverse: direction === 'buy' });

      return {
        symbol: currencyRow.symbol,
        direction,
        counterpart,
        rate: result.rate,
        debited: result.debited,
        credited: result.credited,
        fromBalance: result.fromBalance,
        toBalance: result.toBalance
      };
    }
  });

  register({
    name: 'list_community_currencies', risk: TOOL_RISK.READ,
    description: 'Liste les monnaies COMMUNAUTAIRES existantes (émises par des utilisateurs), triées par capitalisation décroissante — nom, symbole, créateur, prix en euros, capitalisation, offre totale, et ce que PolicierCongo en détient. Point de départ pour repérer une monnaie à soutenir, comparer plusieurs monnaies, ou avant get_community_currency si le symbole/nom exact n’est pas connu.',
    inputSchema: object({
      creator: { type: 'string', maxLength: 100 }
    }),
    handler: async ({ creator } = {}) => {
      let creatorId = null;
      if (creator) {
        const creatorUser = await resolveUser(models, creator);
        if (!creatorUser) throw new Error(`Créateur introuvable: ${creator}`);
        creatorId = creatorUser.id;
      }
      const currencies = await listUserCurrencies({ creatorId });
      return {
        count: currencies.length,
        currencies: currencies.map(c => ({
          id: c.id,
          name: c.name,
          symbol: c.symbol,
          creator: c.creator ? c.creator.username : null,
          priceEur: Number(c.currentPrice),
          marketCapEur: Number(c.marketCap),
          totalSupply: Number(c.totalSupply),
          isActive: c.isActive,
          createdAt: c.createdAt
        }))
      };
    }
  });

  register({
    name: 'get_community_currency', risk: TOOL_RISK.READ,
    description: 'Fiche complète d’une monnaie COMMUNAUTAIRE : cours actuel (en euros et en NF), variation depuis son émission, courbe de prix récente (jusqu’à 30 jours, un point par jour où un échange a eu lieu), capitalisation, offre émise à la création vs offre réellement en circulation (unités créées après coup par les achats), activité sur 30 jours (opérations, volume, comptes actifs), principaux détenteurs et leur part, et ce que PolicierCongo détient. `currency` accepte un UUID, un symbole (ex. "KOSP") ou un nom. Utilise list_community_currencies d’abord si le symbole exact est incertain. À consulter avant un trade_community_currency ou pay_currency_holders pour juger si une monnaie est sous/sur-évaluée ou en tendance.',
    inputSchema: object({
      currency: { type: 'string', maxLength: 100 }
    }, ['currency']),
    handler: async ({ currency }) => {
      const currencyRow = await resolveCommunityCurrency(models, currency);
      if (!currencyRow) throw new Error(`Monnaie communautaire introuvable: ${currency}`);
      return getCurrencyDetail(POLICE_ACCOUNT_ID, currencyRow.id);
    }
  });

  register({
    name: 'pay_currency_holders', risk: TOOL_RISK.DESTRUCTIVE, idempotent: false,
    description: `Verse un montant fixe à CHAQUE compte détenant un solde positif d’une monnaie communautaire donnée (photo instantanée des détenteurs au moment de l’appel) — pour récompenser une communauté entière plutôt qu’un individu (ex. tous les détenteurs de la monnaie d’un créateur). PolicierCongo est automatiquement exclu s’il figure lui-même parmi les détenteurs (transfert vers soi-même impossible). Le paiement peut se faire en NF, en EUR interne, ou dans une AUTRE monnaie communautaire (payout_currency). Plafonné à ${MAX_AIRDROP_RECIPIENTS} destinataires par appel — au-delà, l’appel échoue plutôt que de payer une partie silencieusement ; réduis amount_per_holder ou vise une monnaie moins répandue plutôt que de contourner la limite. Soumis au second avis croisé comme send_money : cite dans reason la décision ou l’accord qui justifie cette distribution — le vérificateur ne voit que ce texte, pas le fil de conversation.`,
    inputSchema: object({
      currency: { type: 'string', maxLength: 100 },
      payout_currency: { type: 'string', maxLength: 100 },
      amount_per_holder: { type: 'number', minimum: 0.00000001 },
      reason: { type: 'string', minLength: 5, maxLength: 500 }
    }, ['currency', 'payout_currency', 'amount_per_holder', 'reason']),
    handler: async ({ currency, payout_currency, amount_per_holder, reason }) => {
      const targetCurrency = await resolveCommunityCurrency(models, currency);
      if (!targetCurrency) throw new Error(`Monnaie communautaire introuvable: ${currency}`);

      const payoutCurrency = await resolvePayoutCurrency(models, payout_currency);
      if (!payoutCurrency) throw new Error(`Monnaie de paiement introuvable: ${payout_currency}`);

      const holderRows = await models.UserWallet.findAll({
        where: { currencyId: targetCurrency.id, balance: { [Op.gt]: 0 } },
        include: [{ model: models.User, as: 'user', attributes: ['id', 'username'] }]
      });

      const holders = holderRows
        .filter(row => row.user && row.userId !== POLICE_ACCOUNT_ID)
        .map(row => ({ id: row.userId, username: row.user.username }));

      if (!holders.length) {
        return { paid: 0, holders_targeted: 0, currency: targetCurrency.symbol, note: 'Aucun détenteur éligible (hors PolicierCongo lui-même le cas échéant).' };
      }

      if (holders.length > MAX_AIRDROP_RECIPIENTS) {
        throw new Error(`${holders.length} détenteurs de ${targetCurrency.symbol} — au-delà de la limite de ${MAX_AIRDROP_RECIPIENTS} par appel. Réduis la portée plutôt que de la contourner.`);
      }

      const totalCost = amount_per_holder * holders.length;
      const payerWallet = await models.UserWallet.findOne({ where: { userId: POLICE_ACCOUNT_ID, currencyId: payoutCurrency.id } });
      const payerBalance = payerWallet ? Number(payerWallet.balance) : 0;
      if (payerBalance < totalCost) {
        throw new Error(`Solde insuffisant : ${totalCost} ${payoutCurrency.symbol} nécessaires pour ${holders.length} détenteurs, solde actuel ${payerBalance} ${payoutCurrency.symbol}.`);
      }

      const results = [];
      for (const holder of holders) {
        try {
          const r = await NewEconomyService.transferCoins(
            POLICE_ACCOUNT_ID, holder.id, payoutCurrency.id, amount_per_holder,
            `Distribution aux détenteurs de ${targetCurrency.symbol} — ${reason}`
          );
          results.push({ username: holder.username, sent: true, net_received: r.netAmount });
        } catch (error) {
          results.push({ username: holder.username, sent: false, error: error.message });
        }
      }

      return {
        currency: targetCurrency.symbol,
        payout_currency: payoutCurrency.symbol,
        amount_per_holder,
        holders_targeted: holders.length,
        paid: results.filter(r => r.sent).length,
        failed: results.filter(r => !r.sent).length,
        results
      };
    }
  });

  register({
    name: 'get_next_wake', risk: TOOL_RISK.READ,
    description: 'Consulte le prochain réveil programmé (cycle autonome persistant), sans le modifier. Renvoie null si aucun réveil n’est en attente.',
    inputSchema: object({}),
    handler: async () => {
      const wake = await memory.getNextWake(AUTONOMOUS_THREAD_ID);
      if (!wake) return { scheduled: false };
      const runAfter = new Date(wake.run_after);
      return {
        scheduled: true,
        wake_id: wake.wake_id,
        run_after: runAfter.toISOString(),
        minutes_from_now: Math.round((runAfter.getTime() - Date.now()) / 60000),
        status: wake.status,
        reason: wake.reason || null
      };
    }
  });
  register({ name: 'schedule_next_wake', risk: TOOL_RISK.WRITE, description: 'Programme le prochain passage agentique persistant après la fin du run. Renvoie date/heure exacte.', inputSchema: object({ minutes: { type: 'integer', minimum: config.minWakeMinutes, maximum: config.maxWakeMinutes }, reason: { type: 'string', maxLength: 1000 } }, ['minutes','reason']), idempotent: true,
    handler: ({ minutes, reason }, ctx) => ctx.scheduleWake(minutes, reason) });
  register({ name: 'schedule_wakes', risk: TOOL_RISK.WRITE,
    description: 'Programme plusieurs passages agentiques en un seul appel (ex: 3 réveils espacés dans la journée), au lieu de répéter schedule_next_wake un par un (chaque appel individuel écrase le précédent). Chaque entrée prend soit "minutes" (délai depuis maintenant), soit "run_at" (horodatage ISO absolu) — pas les deux.',
    inputSchema: object({
      wakes: {
        type: 'array', minItems: 1, maxItems: 10,
        items: object({
          minutes: { type: 'integer', minimum: config.minWakeMinutes, maximum: config.maxWakeMinutes },
          run_at: { type: 'string', format: 'date-time' },
          reason: { type: 'string', maxLength: 1000 }
        }, ['reason'])
      }
    }, ['wakes']),
    idempotent: true,
    handler: ({ wakes }, ctx) => ctx.scheduleWakes(wakes) });
  return registry;
}

module.exports = { registerPlatformTools, publicUser, publicTweet, resolveUser, collectEcosystemSnapshot, getAccountStatsSnapshot,
  getTrendsSnapshot, getTweetTopicSuggestions, getVerificationRequestsSnapshot, UUID, CONTENT, object };
