'use strict';

const models = require('../src/models');

async function main() {
  const [state] = await models.sequelize.query(`
    SELECT
      to_regclass('public.tweet_queue') AS queue_table,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='tweets' AND column_name='progressive_testing_status'
      ) AS has_progressive_testing_status
  `, { type: models.sequelize.QueryTypes.SELECT });
  const counts = {};
  if (state.queue_table) {
    const [queue] = await models.sequelize.query("SELECT COUNT(*)::int AS count FROM tweet_queue", { type: models.sequelize.QueryTypes.SELECT });
    counts.tweet_queue = queue.count;
  }
  if (state.has_progressive_testing_status) {
    const [testing] = await models.sequelize.query("SELECT COUNT(*)::int AS count FROM tweets WHERE progressive_testing_status='testing' AND deleted_at IS NULL", { type: models.sequelize.QueryTypes.SELECT });
    counts.testing_tweets = testing.count;
  }
  console.log(JSON.stringify({ state, counts }, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => models.sequelize.close());
