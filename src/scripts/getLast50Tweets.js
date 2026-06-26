const { Tweet, User, closeConnection } = require('../models');

async function getLast50Tweets() {
  try {
    const tweets = await Tweet.findAll({
      include: [{ model: User, as: 'author', attributes: ['id', 'username', 'full_name'] }],
      order: [['created_at', 'DESC']],
      limit: 50
    });

    console.log(`Total tweets recuperes: ${tweets.length}`);
    console.log('='.repeat(120));

    tweets.forEach((tweet, index) => {
      const author = tweet.author?.username || 'unknown';
      const createdAt = tweet.created_at ? new Date(tweet.created_at).toISOString() : 'unknown_date';
      const content = (tweet.content || '').replace(/\s+/g, ' ').trim();

      console.log(
        `${index + 1}. [${createdAt}] @${author} | id=${tweet.id} | parent=${tweet.parent_tweet_id || 'null'}`
      );
      console.log(`   ${content}`);
      console.log('-'.repeat(120));
    });
  } catch (error) {
    console.error('Erreur lors de la recuperation des 50 derniers tweets:', error.message);
    process.exitCode = 1;
  } finally {
    await closeConnection();
  }
}

getLast50Tweets();
