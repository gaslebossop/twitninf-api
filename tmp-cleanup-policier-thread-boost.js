const fs = require('fs');
const { sequelize } = require('./src/models');

async function query(sql, options = {}) {
  return sequelize.query(sql, options);
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error('Usage: node tmp-cleanup-policier-thread-boost.js /home/debian/api/tmp/<manifest>.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const tweetIds = manifest.tweetIds || [];
  const originalViews = manifest.originalViews || [];
  if (!tweetIds.length) throw new Error('Manifest sans tweetIds');

  const summary = await sequelize.transaction(async (transaction) => {
    const [deletedNotifications] = await query(`
      DELETE FROM notifications
      WHERE metadata->>'batchId' = :batchId
      RETURNING id
    `, { replacements: { batchId: manifest.batchId }, transaction });

    const [deletedLikes] = await query(`
      DELETE FROM tweet_likes
      WHERE metadata->>'batchId' = :batchId
      RETURNING id
    `, { replacements: { batchId: manifest.batchId }, transaction });

    const [deletedRetweets] = await query(`
      DELETE FROM tweet_retweets
      WHERE metadata->>'batchId' = :batchId
      RETURNING id
    `, { replacements: { batchId: manifest.batchId }, transaction });

    for (const row of originalViews) {
      await query(`UPDATE tweets SET view_count = :views, updated_at = NOW() WHERE id = :tweetId`, {
        replacements: { views: row.view_count || 0, tweetId: row.id },
        transaction
      });
    }

    const [deletedUsers] = await query(`
      DELETE FROM users
      WHERE username LIKE 'twitninfuser%'
        AND id NOT IN (SELECT DISTINCT user_id FROM tweet_likes)
        AND id NOT IN (SELECT DISTINCT user_id FROM tweet_retweets)
        AND id NOT IN (SELECT DISTINCT user_id FROM tweets)
        AND id NOT IN (SELECT DISTINCT sender_id FROM notifications WHERE sender_id IS NOT NULL)
      RETURNING username
    `, { transaction });

    return {
      batchId: manifest.batchId,
      restoredTweets: originalViews.length,
      deletedNotifications: deletedNotifications.length,
      deletedLikes: deletedLikes.length,
      deletedRetweets: deletedRetweets.length,
      deletedUsers: deletedUsers.length
    };
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => sequelize.close());
