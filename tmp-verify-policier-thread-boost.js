const { sequelize } = require('./src/models');

async function main() {
  const tweetIds = process.argv.slice(2);
  if (!tweetIds.length) throw new Error('Usage: node tmp-verify-policier-thread-boost.js <tweetId...>');
  const [rows] = await sequelize.query(`
    SELECT t.id,
           t.view_count,
           (SELECT COUNT(*)::int FROM tweet_likes tl WHERE tl.tweet_id = t.id) AS likes,
           (SELECT COUNT(*)::int FROM tweet_retweets tr WHERE tr.tweet_id = t.id) AS retweets
    FROM tweets t
    WHERE t.id IN (:tweetIds)
    ORDER BY array_position(ARRAY[:tweetIds]::uuid[], t.id)
  `, { replacements: { tweetIds } });
  const [[notif]] = await sequelize.query(`
    SELECT COUNT(*)::int AS unread_qa_notifications
    FROM notifications
    WHERE metadata->>'source' = 'qa_policier_thread_boost'
      AND is_read = false
  `);
  const [[users]] = await sequelize.query(`
    SELECT COUNT(*)::int AS twitninfuser_count FROM users WHERE username LIKE 'twitninfuser%'
  `);
  console.log(JSON.stringify({ rows, notif, users }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => sequelize.close());
