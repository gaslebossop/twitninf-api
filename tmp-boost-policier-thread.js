const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { sequelize } = require('./src/models');

const BATCH_ID = `qa_policier_thread_boost_${new Date().toISOString().replace(/[:.]/g, '-')}`;
const MAX_USERS = 3369;
const FIRST_VIEWS = 10000;
const FIRST_LIKES = 3369;
const FIRST_RETWEETS = 427;

function interpolate(first, last, index, total) {
  if (total <= 1) return first;
  const ratio = index / (total - 1);
  return Math.max(last, Math.round(first - (first - last) * ratio));
}

function valuesPlaceholders(rows, columns) {
  const bind = [];
  const parts = rows.map((row) => {
    const slots = columns.map((column) => {
      bind.push(row[column]);
      return `$${bind.length}`;
    });
    return `(${slots.join(',')})`;
  });
  return { sql: parts.join(','), bind };
}

async function query(sql, options = {}) {
  return sequelize.query(sql, options);
}

async function main() {
  const [[envInfo]] = await query(`
    SELECT current_database() AS database_name, inet_server_addr()::text AS server_addr, NOW() AS db_now
  `);

  const [[police]] = await query(`
    SELECT id, username FROM users WHERE username = 'policiercongo' LIMIT 1
  `);
  if (!police) throw new Error('Compte @policiercongo introuvable');

  const [[target]] = await query(`
    SELECT id
    FROM tweets
    WHERE user_id = :policeId
      AND deleted_at IS NULL
      AND content ILIKE '%agence%'
    ORDER BY created_at DESC
    LIMIT 1
  `, { replacements: { policeId: police.id } });

  const [[latest]] = target ? [[target]] : await query(`
    SELECT id
    FROM tweets
    WHERE user_id = :policeId AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `, { replacements: { policeId: police.id } });
  if (!latest) throw new Error('Aucun tweet @policiercongo trouvé');

  const [[root]] = await query(`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_tweet_id, created_at, 0 AS depth
      FROM tweets
      WHERE id = :tweetId
      UNION ALL
      SELECT parent.id, parent.parent_tweet_id, parent.created_at, ancestors.depth + 1
      FROM tweets parent
      JOIN ancestors ON ancestors.parent_tweet_id = parent.id
      WHERE parent.user_id = :policeId AND parent.deleted_at IS NULL
    )
    SELECT id FROM ancestors ORDER BY depth DESC LIMIT 1
  `, { replacements: { tweetId: latest.id, policeId: police.id } });

  const [thread] = await query(`
    WITH RECURSIVE thread AS (
      SELECT id, content, parent_tweet_id, created_at, view_count, 1 AS depth
      FROM tweets
      WHERE id = :rootId
      UNION ALL
      SELECT child.id, child.content, child.parent_tweet_id, child.created_at, child.view_count, thread.depth + 1
      FROM tweets child
      JOIN thread ON child.parent_tweet_id = thread.id
      WHERE child.user_id = :policeId AND child.deleted_at IS NULL
    )
    SELECT id, content, parent_tweet_id, created_at, view_count, depth
    FROM thread
    ORDER BY depth ASC, created_at ASC
  `, { replacements: { rootId: root.id, policeId: police.id } });
  if (!thread.length) throw new Error('Thread vide');

  const passwordHash = await bcrypt.hash(`TwitNinfUser-${BATCH_ID}`, 10);
  const users = Array.from({ length: MAX_USERS }, (_, index) => {
    const n = String(index + 1).padStart(4, '0');
    return {
      id: crypto.randomUUID(),
      username: `twitninfuser${n}`,
      full_name: `TwitNinf User ${n}`,
      email: `twitninfuser${n}@twitninf.test`,
      password: passwordHash,
      platform: 'web',
      stats: JSON.stringify({ followers: 0, following: 0, tweets: 0, likes: 0, qa: true }),
      preferences: JSON.stringify({ language: 'fr', theme: 'dark', notifications: { push: false, email: false, sms: false } }),
      is_active: true,
      email_verified: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  });

  const summary = await sequelize.transaction(async (transaction) => {
    const originalViews = thread.map(tweet => ({ id: tweet.id, view_count: tweet.view_count || 0 }));
    const tweetIds = thread.map(tweet => tweet.id);

    await query(`
      DELETE FROM notifications
      WHERE metadata->>'source' = 'qa_policier_thread_boost'
        AND tweet_id IN (:tweetIds)
    `, { replacements: { tweetIds }, transaction });
    await query(`
      DELETE FROM tweet_likes
      WHERE metadata->>'source' = 'qa_policier_thread_boost'
        AND tweet_id IN (:tweetIds)
    `, { replacements: { tweetIds }, transaction });
    await query(`
      DELETE FROM tweet_retweets
      WHERE metadata->>'source' = 'qa_policier_thread_boost'
        AND tweet_id IN (:tweetIds)
    `, { replacements: { tweetIds }, transaction });

    for (let start = 0; start < users.length; start += 500) {
      const chunk = users.slice(start, start + 500);
      const { sql, bind } = valuesPlaceholders(chunk, ['id', 'username', 'full_name', 'email', 'password', 'platform', 'stats', 'preferences', 'is_active', 'email_verified', 'created_at', 'updated_at']);
      await query(`
        INSERT INTO users (id, username, full_name, email, password, platform, stats, preferences, is_active, email_verified, created_at, updated_at)
        VALUES ${sql}
        ON CONFLICT (username) DO UPDATE SET
          full_name = EXCLUDED.full_name,
          email = EXCLUDED.email,
          platform = EXCLUDED.platform,
          stats = EXCLUDED.stats,
          preferences = EXCLUDED.preferences,
          is_active = true,
          is_suspended = false,
          updated_at = NOW()
      `, { bind, transaction });
    }

    const [testUsers] = await query(`
      SELECT id, username
      FROM users
      WHERE username LIKE 'twitninfuser%'
      ORDER BY username ASC
      LIMIT :limit
    `, { replacements: { limit: MAX_USERS }, transaction });
    if (testUsers.length < MAX_USERS) throw new Error(`Pas assez de comptes test (${testUsers.length}/${MAX_USERS})`);

    const perTweet = [];
    for (let index = 0; index < thread.length; index += 1) {
      const tweet = thread[index];
      const views = interpolate(FIRST_VIEWS, 650, index, thread.length);
      const targetLikes = interpolate(FIRST_LIKES, 95, index, thread.length);
      const targetRetweets = interpolate(FIRST_RETWEETS, 12, index, thread.length);

      await query(`UPDATE tweets SET view_count = :views, recommendation_group = 'viral', updated_at = NOW() WHERE id = :tweetId`, {
        replacements: { views, tweetId: tweet.id },
        transaction
      });

      const [[existingLikesRow]] = await query(`
        SELECT COUNT(*)::int AS count
        FROM tweet_likes tl
        JOIN users u ON u.id = tl.user_id
        WHERE tl.tweet_id = :tweetId AND u.username NOT LIKE 'twitninfuser%'
      `, { replacements: { tweetId: tweet.id }, transaction });
      const likesToCreate = Math.max(0, targetLikes - Number(existingLikesRow.count || 0));
      const likeUsers = testUsers.slice(0, likesToCreate);
      for (let start = 0; start < likeUsers.length; start += 500) {
        const rows = likeUsers.slice(start, start + 500).map((user, localIndex) => ({
          id: crypto.randomUUID(),
          user_id: user.id,
          tweet_id: tweet.id,
          like_type: 'like',
          metadata: JSON.stringify({ source: 'qa_policier_thread_boost', batchId: BATCH_ID, visibleTestUser: true }),
          created_at: new Date(Date.now() - ((thread.length - index) * 60000) - (start + localIndex) * 350).toISOString(),
          updated_at: new Date().toISOString()
        }));
        const { sql, bind } = valuesPlaceholders(rows, ['id', 'user_id', 'tweet_id', 'like_type', 'metadata', 'created_at', 'updated_at']);
        await query(`
          INSERT INTO tweet_likes (id, user_id, tweet_id, like_type, metadata, created_at, updated_at)
          VALUES ${sql}
          ON CONFLICT (user_id, tweet_id) DO NOTHING
        `, { bind, transaction });
      }

      const retweetUsers = testUsers.slice(0, targetRetweets);
      for (let start = 0; start < retweetUsers.length; start += 500) {
        const rows = retweetUsers.slice(start, start + 500).map((user, localIndex) => ({
          id: crypto.randomUUID(),
          user_id: user.id,
          tweet_id: tweet.id,
          retweet_type: 'retweet',
          metadata: JSON.stringify({ source: 'qa_policier_thread_boost', batchId: BATCH_ID, visibleTestUser: true }),
          created_at: new Date(Date.now() - ((thread.length - index) * 60000) - (start + localIndex) * 500).toISOString(),
          updated_at: new Date().toISOString()
        }));
        const { sql, bind } = valuesPlaceholders(rows, ['id', 'user_id', 'tweet_id', 'retweet_type', 'metadata', 'created_at', 'updated_at']);
        await query(`
          INSERT INTO tweet_retweets (id, user_id, tweet_id, retweet_type, metadata, created_at, updated_at)
          VALUES ${sql}
          ON CONFLICT (user_id, tweet_id) DO NOTHING
        `, { bind, transaction });
      }

      const notificationUsers = [
        ...likeUsers.slice(0, Math.min(likesToCreate, index === 0 ? 90 : 25)).map(user => ({ ...user, type: 'like' })),
        ...retweetUsers.slice(0, index === 0 ? 20 : 6).map(user => ({ ...user, type: 'retweet' }))
      ];
      for (let start = 0; start < notificationUsers.length; start += 500) {
        const rows = notificationUsers.slice(start, start + 500).map((user, localIndex) => {
          const isRetweet = user.type === 'retweet';
          return {
            id: crypto.randomUUID(),
            recipient_id: police.id,
            sender_id: user.id,
            tweet_id: tweet.id,
            type: user.type,
            title: isRetweet ? `@${user.username} a retweeté votre tweet` : `@${user.username} a aimé votre tweet`,
            message: isRetweet ? 'Nouveau retweet' : 'Nouveau like',
            content: JSON.stringify({ qa: true, batchId: BATCH_ID, threadIndex: index + 1 }),
            is_read: false,
            priority: index === 0 ? 'high' : 'normal',
            metadata: JSON.stringify({ source: 'qa_policier_thread_boost', batchId: BATCH_ID, visibleTestUser: true }),
            created_at: new Date(Date.now() - (start + localIndex) * 1000).toISOString(),
            updated_at: new Date().toISOString()
          };
        });
        const { sql, bind } = valuesPlaceholders(rows, ['id', 'recipient_id', 'sender_id', 'tweet_id', 'type', 'title', 'message', 'content', 'is_read', 'priority', 'metadata', 'created_at', 'updated_at']);
        await query(`
          INSERT INTO notifications (id, recipient_id, sender_id, tweet_id, type, title, message, content, is_read, priority, metadata, created_at, updated_at)
          VALUES ${sql}
        `, { bind, transaction });
      }

      const [[finalLikeRow]] = await query(`SELECT COUNT(*)::int AS count FROM tweet_likes WHERE tweet_id = :tweetId`, { replacements: { tweetId: tweet.id }, transaction });
      const [[finalRetweetRow]] = await query(`SELECT COUNT(*)::int AS count FROM tweet_retweets WHERE tweet_id = :tweetId`, { replacements: { tweetId: tweet.id }, transaction });
      perTweet.push({
        index: index + 1,
        id: tweet.id,
        content: tweet.content,
        views,
        likes: Number(finalLikeRow.count || 0),
        retweets: Number(finalRetweetRow.count || 0)
      });
    }

    const manifest = {
      batchId: BATCH_ID,
      createdAt: new Date().toISOString(),
      envInfo,
      police,
      rootId: root.id,
      tweetIds,
      testUserPrefix: 'twitninfuser',
      originalViews,
      perTweet
    };
    const manifestPath = path.join(process.cwd(), 'tmp', `${BATCH_ID}.json`);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { manifestPath, ...manifest };
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => sequelize.close());
