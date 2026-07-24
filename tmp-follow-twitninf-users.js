const crypto = require('crypto');
const { sequelize } = require('./src/models');

const TARGET_USERNAME = (process.argv[2] || 'policiercongo').replace(/^@/, '');
const BATCH_ID = `qa_${TARGET_USERNAME}_follow_boost_${new Date().toISOString().replace(/[:.]/g, '-')}`;
const FOLLOWERS = 3369;

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
  const summary = await sequelize.transaction(async (transaction) => {
    const [[target]] = await query(`
      SELECT id, username, stats FROM users WHERE username = :username LIMIT 1
    `, { replacements: { username: TARGET_USERNAME }, transaction });
    if (!target) throw new Error(`Compte @${TARGET_USERNAME} introuvable`);

    const [testUsers] = await query(`
      SELECT id, username
      FROM users
      WHERE username LIKE 'twitninfuser%'
        AND is_active = true
        AND COALESCE(is_suspended, false) = false
      ORDER BY username ASC
      LIMIT :limit
    `, { replacements: { limit: FOLLOWERS }, transaction });
    if (testUsers.length < FOLLOWERS) {
      throw new Error(`Pas assez de comptes twitninfuser (${testUsers.length}/${FOLLOWERS})`);
    }

    const rows = testUsers.map((user, index) => ({
      id: crypto.randomUUID(),
      follower_id: user.id,
      following_id: target.id,
      status: 'active',
      notifications_enabled: true,
      metadata: JSON.stringify({ source: 'qa_follow_boost', batchId: BATCH_ID, visibleTestUser: true, targetUsername: TARGET_USERNAME }),
      created_at: new Date(Date.now() - index * 700).toISOString(),
      updated_at: new Date().toISOString()
    }));

    for (let start = 0; start < rows.length; start += 500) {
      const chunk = rows.slice(start, start + 500);
      const { sql, bind } = valuesPlaceholders(chunk, ['id', 'follower_id', 'following_id', 'status', 'notifications_enabled', 'metadata', 'created_at', 'updated_at']);
      await query(`
        INSERT INTO user_follows (id, follower_id, following_id, status, notifications_enabled, metadata, created_at, updated_at)
        VALUES ${sql}
        ON CONFLICT (follower_id, following_id) DO UPDATE SET
          status = 'active',
          notifications_enabled = true,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
      `, { bind, transaction });
    }

    const notifUsers = testUsers.slice(0, 120);
    for (let start = 0; start < notifUsers.length; start += 500) {
      const chunk = notifUsers.slice(start, start + 500).map((user, index) => ({
        id: crypto.randomUUID(),
        recipient_id: target.id,
        sender_id: user.id,
        type: 'follow',
        title: `@${user.username} vous suit maintenant`,
        message: 'Nouveau suivi',
        content: JSON.stringify({ qa: true, batchId: BATCH_ID, target: `@${TARGET_USERNAME}` }),
        is_read: false,
        priority: 'high',
        metadata: JSON.stringify({ source: 'qa_follow_boost', batchId: BATCH_ID, visibleTestUser: true, targetUsername: TARGET_USERNAME }),
        created_at: new Date(Date.now() - (start + index) * 1000).toISOString(),
        updated_at: new Date().toISOString()
      }));
      const { sql, bind } = valuesPlaceholders(chunk, ['id', 'recipient_id', 'sender_id', 'type', 'title', 'message', 'content', 'is_read', 'priority', 'metadata', 'created_at', 'updated_at']);
      await query(`
        INSERT INTO notifications (id, recipient_id, sender_id, type, title, message, content, is_read, priority, metadata, created_at, updated_at)
        VALUES ${sql}
      `, { bind, transaction });
    }

    await query(`
      UPDATE users u
      SET stats = COALESCE(u.stats, '{}'::jsonb)
        || jsonb_build_object('followers', (
          SELECT COUNT(*)::int FROM user_follows uf WHERE uf.following_id = u.id AND uf.status = 'active'
        )),
        updated_at = NOW()
      WHERE u.id = :targetId
    `, { replacements: { targetId: target.id }, transaction });

    await query(`
      UPDATE users u
      SET stats = COALESCE(u.stats, '{}'::jsonb)
        || jsonb_build_object('following', (
          SELECT COUNT(*)::int FROM user_follows uf WHERE uf.follower_id = u.id AND uf.status = 'active'
        )),
        updated_at = NOW()
      WHERE u.username LIKE 'twitninfuser%'
    `, { transaction });

    const [[final]] = await query(`
      SELECT u.id,
             u.username,
             u.stats,
             (SELECT COUNT(*)::int FROM user_follows WHERE following_id = u.id AND status = 'active') AS followers_count,
             (SELECT COUNT(*)::int FROM notifications WHERE recipient_id = u.id AND metadata->>'batchId' = :batchId AND is_read = false) AS unread_qa_follow_notifications
      FROM users u
      WHERE u.id = :targetId
    `, { replacements: { targetId: target.id, batchId: BATCH_ID }, transaction });

    return { batchId: BATCH_ID, target: final, requestedFollowers: FOLLOWERS };
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => sequelize.close());
