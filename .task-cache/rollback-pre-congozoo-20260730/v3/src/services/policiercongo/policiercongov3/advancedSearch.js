'use strict';

const { QueryTypes } = require('sequelize');
const { asPlain, clip } = require('./utils');

const S = type => ({ type });
const A = (items, maxItems = 100) => ({ type: 'array', items, maxItems });
const STRINGS = A(S('string'));
const BOOL = S('boolean');
const INT = (minimum, maximum) => ({ type: 'integer', minimum, maximum });

const ADVANCED_SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'object', properties: {
      query: S('string'), exact_phrase: S('string'), all_words: STRINGS, any_words: STRINGS, none_words: STRINGS,
      starts_with: S('string'), ends_with: S('string'), regex: S('string'), case_sensitive: BOOL,
      min_length: INT(0, 600), max_length: INT(0, 600), is_empty: BOOL,
      has_hashtags: BOOL, hashtags_any: STRINGS, hashtags_all: STRINGS, hashtags_none: STRINGS,
      has_mentions: BOOL, mentions_any: STRINGS, mentions_all: STRINGS, mentions_none: STRINGS,
      has_urls: BOOL, domains_any: STRINGS, language_any: STRINGS, language_none: STRINGS
    }},
    author: { type: 'object', properties: {
      ids: STRINGS, usernames: STRINGS, exclude_ids: STRINGS, exclude_usernames: STRINGS,
      verified: BOOL, premium: BOOL, suspended: BOOL,
      min_followers: INT(0, 2000000000), max_followers: INT(0, 2000000000),
      min_following: INT(0, 2000000000), max_following: INT(0, 2000000000),
      account_created_after: S('string'), account_created_before: S('string')
    }},
    conversation: { type: 'object', properties: {
      kind: { type: 'string', enum: ['any', 'root', 'reply', 'repost', 'quote', 'video'] },
      tweet_ids: STRINGS, exclude_tweet_ids: STRINGS, parent_tweet_ids: STRINGS, exclude_parent_tweet_ids: STRINGS,
      original_tweet_ids: STRINGS, root_tweet_ids: STRINGS,
      parent_author_ids: STRINGS, parent_author_usernames: STRINGS,
      root_author_ids: STRINGS, root_author_usernames: STRINGS,
      replied_by_ids: STRINGS, replied_by_usernames: STRINGS,
      reply_to_self: BOOL, direct_reply_only: BOOL, min_depth: INT(0, 100), max_depth: INT(0, 100),
      has_parent: BOOL, has_replies: BOOL, has_no_replies: BOOL
    }},
    media: { type: 'object', properties: {
      has_media: BOOL, no_media: BOOL, min_media_count: INT(0, 4), max_media_count: INT(0, 4),
      media_type_any: { type: 'array', items: { type: 'string', enum: ['image', 'video', 'gif', 'audio'] }, maxItems: 4 },
      has_location: BOOL, is_sensitive: BOOL, is_private: BOOL, is_pinned: BOOL,
      is_quote: BOOL, is_retweet: BOOL, source_any: STRINGS, device_any: STRINGS
    }},
    time: { type: 'object', properties: {
      created_after: S('string'), created_before: S('string'), updated_after: S('string'), updated_before: S('string'),
      last_minutes: INT(1, 5256000), last_hours: INT(1, 87600), last_days: INT(1, 3650),
      hour_min: INT(0, 23), hour_max: INT(0, 23), weekday_any: A(INT(0, 6), 7)
    }},
    engagement: { type: 'object', properties: {
      min_views: INT(0, 2000000000), max_views: INT(0, 2000000000),
      min_likes: INT(0, 2000000000), max_likes: INT(0, 2000000000),
      min_reposts: INT(0, 2000000000), max_reposts: INT(0, 2000000000),
      min_replies: INT(0, 2000000000), max_replies: INT(0, 2000000000),
      min_clicks: INT(0, 2000000000), max_clicks: INT(0, 2000000000),
      min_total: INT(0, 2000000000), max_total: INT(0, 2000000000),
      liked_by_ids: STRINGS, not_liked_by_ids: STRINGS, reposted_by_ids: STRINGS, not_reposted_by_ids: STRINGS,
      engaged_by_ids: STRINGS, engagement_rate_min: S('number'), engagement_rate_max: S('number')
    }},
    moderation: { type: 'object', properties: {
      status_any: STRINGS, status_none: STRINGS, recommendation_group_any: STRINGS,
      monetized: BOOL, has_moderation_reason: BOOL
    }},
    projection: { type: 'object', properties: {
      include_content: BOOL, include_author: BOOL, include_parent: BOOL, include_root: BOOL,
      include_metrics: BOOL, include_metadata: BOOL, include_media: BOOL, include_facets: BOOL,
      include_match_explanation: BOOL, content_max_chars: INT(40, 600)
    }},
    sort: { type: 'object', properties: {
      by: { type: 'string', enum: ['relevance', 'recent', 'oldest', 'views', 'likes', 'reposts', 'replies', 'engagement', 'controversial', 'random'] },
      direction: { type: 'string', enum: ['asc', 'desc'] }, seed: S('string')
    }},
    page: { type: 'object', properties: { limit: INT(1, 1000), offset: INT(0, 1000000), cursor: S('string') }},
    logic: { type: 'object', properties: { minimum_should_match: INT(0, 100), explain: BOOL, timeout_ms: INT(100, 60000) }}
  }
};

function list(value) { return Array.isArray(value) ? value.filter(v => v !== null && v !== undefined && String(v).trim()) : []; }
function normalizeMarker(value, marker) {
  const clean = String(value || '').trim().toLowerCase();
  return clean && !clean.startsWith(marker) ? `${marker}${clean}` : clean;
}
function parseDate(value, name) { if (!value) return null; const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error(`${name}: date invalide`); return date.toISOString(); }
function decodeOffset(cursor) { try { const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); return Number.isInteger(value.offset) ? value.offset : 0; } catch (_) { return 0; } }
function encodeOffset(offset) { return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url'); }

class SqlBuilder {
  constructor() { this.where = ['t.deleted_at IS NULL']; this.having = []; this.replacements = {}; this.n = 0; }
  value(value, prefix = 'p') { const key = `${prefix}${this.n++}`; this.replacements[key] = value; return `:${key}`; }
  add(condition) { if (condition) this.where.push(condition); }
  addHaving(condition) { if (condition) this.having.push(condition); }
  in(column, values, negate = false) { const clean = list(values); if (!clean.length) return; this.add(`${column} ${negate ? 'NOT ' : ''}IN (${clean.map(v => this.value(v)).join(',')})`); }
  bool(column, value) { if (typeof value === 'boolean') this.add(`${column} IS ${value ? 'TRUE' : 'FALSE'}`); }
  range(column, min, max) { if (min !== undefined) this.add(`${column} >= ${this.value(min)}`); if (max !== undefined) this.add(`${column} <= ${this.value(max)}`); }
}

async function resolveUserIds(User, ids, usernames) {
  const cleanIds = list(ids).map(String);
  const names = list(usernames).map(name => String(name).replace(/^@/, '').toLowerCase());
  if (!names.length) return cleanIds;
  const { Op } = require('sequelize');
  const users = await User.findAll({ where: { username: { [Op.in]: names } }, attributes: ['id'], raw: true });
  return [...new Set([...cleanIds, ...users.map(user => String(user.id))])];
}

async function advancedSearchTweets(args, { models, config }) {
  const { sequelize, User } = models;
  const text = args.text || {}, author = args.author || {}, conv = args.conversation || {};
  const media = args.media || {}, time = args.time || {}, eng = args.engagement || {}, mod = args.moderation || {};
  const projection = args.projection || {}, sort = args.sort || {}, page = args.page || {};
  const b = new SqlBuilder();

  const authorIds = await resolveUserIds(User, author.ids, author.usernames);
  const excludedAuthorIds = await resolveUserIds(User, author.exclude_ids, author.exclude_usernames);
  const parentAuthorIds = await resolveUserIds(User, conv.parent_author_ids, conv.parent_author_usernames);
  const rootAuthorIds = await resolveUserIds(User, conv.root_author_ids, conv.root_author_usernames);
  const repliedByIds = await resolveUserIds(User, conv.replied_by_ids, conv.replied_by_usernames);
  b.in('t.user_id', authorIds); b.in('t.user_id', excludedAuthorIds, true);
  b.in('t.id', conv.tweet_ids); b.in('t.id', conv.exclude_tweet_ids, true);
  b.in('t.parent_tweet_id', conv.parent_tweet_ids); b.in('t.parent_tweet_id', conv.exclude_parent_tweet_ids, true);
  b.in('t.original_tweet_id', conv.original_tweet_ids); b.in('pa.id', parentAuthorIds); b.in('ra.id', rootAuthorIds);
  b.in('t.user_id', repliedByIds);

  if (text.query) b.add(`to_tsvector('simple',COALESCE(t.content,'')) @@ websearch_to_tsquery('simple',${b.value(text.query, 'q')})`);
  if (text.exact_phrase) b.add(`t.content ILIKE ${b.value(`%${text.exact_phrase}%`)}`);
  for (const word of list(text.all_words)) b.add(`t.content ILIKE ${b.value(`%${word}%`)}`);
  if (list(text.any_words).length) b.add(`(${text.any_words.map(word => `t.content ILIKE ${b.value(`%${word}%`)}`).join(' OR ')})`);
  for (const word of list(text.none_words)) b.add(`t.content NOT ILIKE ${b.value(`%${word}%`)}`);
  if (text.starts_with) b.add(`t.content ILIKE ${b.value(`${text.starts_with}%`)}`);
  if (text.ends_with) b.add(`t.content ILIKE ${b.value(`%${text.ends_with}`)}`);
  if (text.regex) b.add(`t.content ${text.case_sensitive ? '~' : '~*'} ${b.value(text.regex)}`);
  b.range('char_length(t.content)', text.min_length, text.max_length);
  if (text.is_empty === true) b.add(`btrim(COALESCE(t.content,''))=''`);
  if (text.is_empty === false) b.add(`btrim(COALESCE(t.content,''))<>''`);
  if (typeof text.has_hashtags === 'boolean') b.add(`jsonb_array_length(COALESCE(t.hashtags,'[]'::jsonb)) ${text.has_hashtags ? '>' : '='} 0`);
  if (typeof text.has_mentions === 'boolean') b.add(`jsonb_array_length(COALESCE(t.mentions,'[]'::jsonb)) ${text.has_mentions ? '>' : '='} 0`);
  if (typeof text.has_urls === 'boolean') b.add(`jsonb_array_length(COALESCE(t.urls,'[]'::jsonb)) ${text.has_urls ? '>' : '='} 0`);
  const jsonAny = (column, values, negate = false) => { const clean = list(values); if (clean.length) b.add(`${negate ? 'NOT ' : ''}EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${column},'[]'::jsonb)) j(v) WHERE lower(j.v) IN (${clean.map(v => b.value(String(v).toLowerCase())).join(',')}))`); };
  jsonAny('t.hashtags', list(text.hashtags_any).map(value => normalizeMarker(value, '#')));
  jsonAny('t.hashtags', list(text.hashtags_none).map(value => normalizeMarker(value, '#')), true);
  for (const tag of list(text.hashtags_all).map(value => normalizeMarker(value, '#'))) b.add(`COALESCE(t.hashtags,'[]'::jsonb) @> ${b.value(JSON.stringify([tag]))}::jsonb`);
  jsonAny('t.mentions', list(text.mentions_any).map(value => normalizeMarker(value, '@')));
  jsonAny('t.mentions', list(text.mentions_none).map(value => normalizeMarker(value, '@')), true);
  for (const mention of list(text.mentions_all).map(value => normalizeMarker(value, '@'))) b.add(`COALESCE(t.mentions,'[]'::jsonb) @> ${b.value(JSON.stringify([mention]))}::jsonb`);
  b.in('t.language', text.language_any); b.in('t.language', text.language_none, true);

  b.bool('a.verified', author.verified); b.bool('a.premium', author.premium); b.bool('a.is_suspended', author.suspended);
  b.range('a.followers_count', author.min_followers, author.max_followers); b.range('a.following_count', author.min_following, author.max_following);
  if (author.account_created_after) b.add(`a.created_at >= ${b.value(parseDate(author.account_created_after, 'account_created_after'))}`);
  if (author.account_created_before) b.add(`a.created_at <= ${b.value(parseDate(author.account_created_before, 'account_created_before'))}`);

  const kind = conv.kind || 'any';
  if (kind === 'root') b.add('t.parent_tweet_id IS NULL');
  if (kind === 'reply') b.add('t.parent_tweet_id IS NOT NULL');
  if (['repost','quote','video'].includes(kind)) b.add(`t.tweet_type=${b.value(kind)}`);
  if (typeof conv.has_parent === 'boolean') b.add(`t.parent_tweet_id IS ${conv.has_parent ? 'NOT ' : ''}NULL`);
  if (conv.reply_to_self === true) b.add('t.user_id=p.user_id');
  if (conv.reply_to_self === false) b.add('(p.id IS NULL OR t.user_id<>p.user_id)');
  if (conv.direct_reply_only === true) b.add('COALESCE(tree.depth,0)=1');
  if (conv.has_replies === true) b.add('reply_count > 0');
  if (conv.has_no_replies === true) b.add('reply_count = 0');
  b.in('root.id', conv.root_tweet_ids);
  b.range('COALESCE(tree.depth,0)', conv.min_depth, conv.max_depth);

  b.bool('t.is_sensitive', media.is_sensitive); b.bool('t.is_private', media.is_private); b.bool('t.is_pinned', media.is_pinned);
  b.bool('t.is_quote', media.is_quote); b.bool('t.is_retweet', media.is_retweet);
  if (typeof media.has_media === 'boolean') b.add(`jsonb_array_length(COALESCE(t.media_urls,'[]'::jsonb)) ${media.has_media ? '>' : '='} 0`);
  if (media.no_media === true) b.add(`jsonb_array_length(COALESCE(t.media_urls,'[]'::jsonb))=0`);
  b.range(`jsonb_array_length(COALESCE(t.media_urls,'[]'::jsonb))`, media.min_media_count, media.max_media_count);
  if (typeof media.has_location === 'boolean') b.add(`t.location IS ${media.has_location ? 'NOT ' : ''}NULL`);
  if (list(media.media_type_any).length) {
    const patterns = media.media_type_any.flatMap(type => ({ image: ['%.jpg','%.jpeg','%.png','%.webp'], video: ['%.mp4','%.webm','%.mov'], gif: ['%.gif'], audio: ['%.mp3','%.wav','%.ogg'] }[type] || []));
    if (patterns.length) b.add(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.media_urls,'[]'::jsonb)) m(url) WHERE ${patterns.map(pattern => `lower(m.url) LIKE ${b.value(pattern)}`).join(' OR ')})`);
  }
  if (list(text.domains_any).length) b.add(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.urls,'[]'::jsonb)) u(url) WHERE ${text.domains_any.map(domain => `lower(u.url) LIKE ${b.value(`%${String(domain).toLowerCase()}%`)}`).join(' OR ')})`);
  b.in(`t.metadata->>'source'`, media.source_any); b.in(`t.metadata->>'device'`, media.device_any);

  const after = time.created_after || (time.last_minutes ? new Date(Date.now() - time.last_minutes * 60000).toISOString() : time.last_hours ? new Date(Date.now() - time.last_hours * 3600000).toISOString() : time.last_days ? new Date(Date.now() - time.last_days * 86400000).toISOString() : null);
  if (after) b.add(`t.created_at >= ${b.value(parseDate(after, 'created_after'))}`);
  if (time.created_before) b.add(`t.created_at <= ${b.value(parseDate(time.created_before, 'created_before'))}`);
  if (time.updated_after) b.add(`t.updated_at >= ${b.value(parseDate(time.updated_after, 'updated_after'))}`);
  if (time.updated_before) b.add(`t.updated_at <= ${b.value(parseDate(time.updated_before, 'updated_before'))}`);
  b.range(`EXTRACT(HOUR FROM t.created_at AT TIME ZONE 'Europe/Paris')`, time.hour_min, time.hour_max);
  b.in(`EXTRACT(DOW FROM t.created_at AT TIME ZONE 'Europe/Paris')`, time.weekday_any);

  b.range('t.view_count', eng.min_views, eng.max_views); b.range('t.click_count', eng.min_clicks, eng.max_clicks);
  b.range('like_count', eng.min_likes, eng.max_likes); b.range('repost_count', eng.min_reposts, eng.max_reposts); b.range('reply_count', eng.min_replies, eng.max_replies);
  b.range('(like_count+repost_count+reply_count)', eng.min_total, eng.max_total);
  const existsInteraction = (table, users, negate = false) => { const clean = list(users); if (clean.length) b.add(`${negate ? 'NOT ' : ''}EXISTS(SELECT 1 FROM ${table} x WHERE x.tweet_id=t.id AND x.user_id IN (${clean.map(v => b.value(v)).join(',')}))`); };
  existsInteraction('tweet_likes', eng.liked_by_ids); existsInteraction('tweet_likes', eng.not_liked_by_ids, true);
  existsInteraction('tweet_retweets', eng.reposted_by_ids); existsInteraction('tweet_retweets', eng.not_reposted_by_ids, true);
  if (list(eng.engaged_by_ids).length) {
    const placeholders = eng.engaged_by_ids.map(value => b.value(value)).join(',');
    b.add(`(EXISTS(SELECT 1 FROM tweet_likes x WHERE x.tweet_id=t.id AND x.user_id IN (${placeholders})) OR EXISTS(SELECT 1 FROM tweet_retweets x WHERE x.tweet_id=t.id AND x.user_id IN (${placeholders})) OR EXISTS(SELECT 1 FROM tweets x WHERE x.parent_tweet_id=t.id AND x.user_id IN (${placeholders}) AND x.deleted_at IS NULL))`);
  }
  const rateExpr = '((like_count+repost_count+reply_count)::numeric/GREATEST(t.view_count,1))';
  b.range(rateExpr, eng.engagement_rate_min, eng.engagement_rate_max);

  b.in('t.moderation_status', mod.status_any); b.in('t.moderation_status', mod.status_none, true); b.in('t.recommendation_group', mod.recommendation_group_any);
  b.bool('t.monetized', mod.monetized);
  if (typeof mod.has_moderation_reason === 'boolean') b.add(`t.moderation_reason IS ${mod.has_moderation_reason ? 'NOT ' : ''}NULL`);

  const select = `SELECT t.id,t.user_id,t.parent_tweet_id,t.original_tweet_id,t.tweet_type,t.created_at,t.updated_at,t.deleted_at,
    t.content,t.language,t.view_count,t.click_count,t.is_sensitive,t.is_private,t.is_pinned,t.is_quote,t.is_retweet,
    t.moderation_status,t.recommendation_group,t.media_urls,t.hashtags,t.mentions,t.urls,t.metadata,
    a.username,a.full_name,a.avatar,a.verified,a.premium,a.is_suspended,a.created_at author_created_at,
    (SELECT COUNT(*)::int FROM user_follows uf WHERE uf.following_id=a.id) followers_count,
    (SELECT COUNT(*)::int FROM user_follows uf WHERE uf.follower_id=a.id) following_count,
    p.content parent_content,p.user_id parent_user_id,pa.username parent_username,
    root.id root_tweet_id,ra.id root_author_id,ra.username root_author_username,COALESCE(tree.depth,0) thread_depth,
    (SELECT COUNT(*)::int FROM tweet_likes l WHERE l.tweet_id=t.id) like_count,
    (SELECT COUNT(*)::int FROM tweet_retweets r WHERE r.tweet_id=t.id) repost_count,
    (SELECT COUNT(*)::int FROM tweets rr WHERE rr.parent_tweet_id=t.id AND rr.deleted_at IS NULL) reply_count`;
  const cte = `WITH RECURSIVE tree AS (
    SELECT id,id AS root_id,0 AS depth FROM tweets WHERE parent_tweet_id IS NULL AND deleted_at IS NULL
    UNION ALL SELECT child.id,tree.root_id,tree.depth+1 FROM tweets child JOIN tree ON child.parent_tweet_id=tree.id WHERE child.deleted_at IS NULL AND tree.depth<100
  ), enriched AS (
    ${select} FROM tweets t JOIN users a ON a.id=t.user_id
    LEFT JOIN tweets p ON p.id=t.parent_tweet_id LEFT JOIN users pa ON pa.id=p.user_id
    LEFT JOIN tree ON tree.id=t.id LEFT JOIN tweets root ON root.id=tree.root_id LEFT JOIN users ra ON ra.id=root.user_id
  )`;
  const aliases = `SELECT * FROM enriched t`;
  // Conditions use aliases a/p/root from the inner query; replace them with projected names for the outer query.
  const outerWhere = b.where.join(' AND ')
    .replace(/\ba\.(verified|premium|is_suspended|followers_count|following_count)\b/g, 't.$1').replace(/\ba\.created_at\b/g, 't.author_created_at')
    .replace(/\bpa\.id\b/g, 't.parent_user_id').replace(/\bra\.id\b/g, 't.root_author_id')
    .replace(/\broot\.id\b/g, 't.root_tweet_id').replace(/\bp\.user_id\b/g, 't.parent_user_id')
    .replace(/\btree\.depth\b/g, 't.thread_depth');

  const sortMap = {
    relevance: text.query ? `ts_rank(to_tsvector('simple',COALESCE(t.content,'')),websearch_to_tsquery('simple',${b.value(text.query, 'rank')}))` : 't.created_at',
    recent: 't.created_at', oldest: 't.created_at', views: 't.view_count', likes: 't.like_count', reposts: 't.repost_count',
    replies: 't.reply_count', engagement: '(t.like_count+t.repost_count+t.reply_count)',
    controversial: '(LEAST(t.like_count,t.reply_count)*2+GREATEST(t.like_count,t.reply_count))', random: `md5(t.id::text||${b.value(sort.seed || 'pc3')})`
  };
  const sortBy = sort.by || (text.query ? 'relevance' : 'recent');
  const direction = sort.direction || (sortBy === 'oldest' ? 'asc' : 'desc');
  const limit = Math.min(Number(page.limit || 50), config.advancedSearchMaxLimit);
  const offset = page.cursor ? decodeOffset(page.cursor) : Number(page.offset || 0);
  const sql = `${cte} ${aliases} WHERE ${outerWhere} ORDER BY ${sortMap[sortBy]} ${direction.toUpperCase()},t.id ${direction.toUpperCase()} LIMIT ${b.value(limit, 'limit')} OFFSET ${b.value(offset, 'offset')}`;
  const rows = await sequelize.query(sql, { replacements: b.replacements, type: QueryTypes.SELECT, raw: true });

  const maxContent = projection.content_max_chars || 600;
  const results = rows.map(row => ({
    id: row.id, kind: row.parent_tweet_id ? 'reply' : row.tweet_type, content: projection.include_content === false ? undefined : clip(row.content || '', maxContent),
    author: projection.include_author === false ? undefined : { id: row.user_id, username: row.username, full_name: row.full_name, avatar: row.avatar, verified: row.verified, premium: row.premium },
    parent: projection.include_parent === false ? undefined : row.parent_tweet_id ? { id: row.parent_tweet_id, author_id: row.parent_user_id, author_username: row.parent_username, content: clip(row.parent_content || '', maxContent) } : null,
    root: projection.include_root === false ? undefined : { id: row.root_tweet_id || row.id, author_id: row.root_author_id || row.user_id, author_username: row.root_author_username || row.username, depth: row.thread_depth },
    metrics: projection.include_metrics === false ? undefined : { views: row.view_count, clicks: row.click_count, likes: row.like_count, reposts: row.repost_count, replies: row.reply_count },
    media_urls: projection.include_media === false ? undefined : row.media_urls,
    metadata: projection.include_metadata ? row.metadata : undefined,
    language: row.language, moderation_status: row.moderation_status, recommendation_group: row.recommendation_group,
    created_at: row.created_at, updated_at: row.updated_at
  }));
  const facets = projection.include_facets ? results.reduce((acc, item) => { acc.kinds[item.kind] = (acc.kinds[item.kind] || 0) + 1; if (item.author) acc.authors[item.author.username] = (acc.authors[item.author.username] || 0) + 1; return acc; }, { kinds: {}, authors: {}, scope: 'current_page' }) : undefined;
  return { results: asPlain(results), page: { limit, offset, returned: results.length, has_more: results.length === limit, next_cursor: results.length === limit ? encodeOffset(offset + results.length) : null }, facets,
    interpretation: { author_ids: authorIds, parent_author_ids: parentAuthorIds, root_author_ids: rootAuthorIds, replied_by_ids: repliedByIds, sort: `${sortBy}:${direction}`,
      relation_note: 'author=result author; parent_author=immediate parent author; root_author=conversation root author', applied_filter_count: b.where.length - 1 } };
}

module.exports = { ADVANCED_SEARCH_SCHEMA, advancedSearchTweets, resolveUserIds, decodeOffset, encodeOffset };
