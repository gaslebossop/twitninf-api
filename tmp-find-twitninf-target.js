const { sequelize } = require('./src/models');

async function main() {
  const [users] = await sequelize.query(`
    SELECT id, username, full_name
    FROM users
    WHERE username ILIKE '%twitninf%'
    ORDER BY username
    LIMIT 30
  `);
  const [twitninfTweets] = await sequelize.query(`
    SELECT t.id, u.username, t.content, t.created_at, t.view_count
    FROM tweets t
    JOIN users u ON u.id = t.user_id
    WHERE u.username ILIKE '%twitninf%'
      AND t.deleted_at IS NULL
    ORDER BY t.created_at DESC
    LIMIT 30
  `);
  const [latestTweets] = await sequelize.query(`
    SELECT t.id, u.username, t.content, t.created_at, t.view_count
    FROM tweets t
    JOIN users u ON u.id = t.user_id
    WHERE t.deleted_at IS NULL
    ORDER BY t.created_at DESC
    LIMIT 12
  `);
  console.log(JSON.stringify({ users, twitninfTweets, latestTweets }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => sequelize.close());
