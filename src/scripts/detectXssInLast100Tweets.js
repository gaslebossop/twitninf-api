const { Tweet, User, closeConnection } = require('../models');

function isPotentialXss(content) {
  if (!content || typeof content !== 'string') return false;

  const patterns = [
    /<script[\s\S]*?>[\s\S]*?<\/script>/i,
    /<\s*img[^>]+onerror\s*=/i,
    /<\s*svg[^>]+onload\s*=/i,
    /javascript\s*:/i,
    /on\w+\s*=\s*["'][^"']*["']/i,
    /on\w+\s*=\s*[^\s>]+/i,
    /<\s*iframe/i,
    /<\s*object/i,
    /<\s*embed/i
  ];

  return patterns.some((re) => re.test(content));
}

async function detectXssInLast100Tweets() {
  try {
    const tweets = await Tweet.findAll({
      include: [{ model: User, as: 'author', attributes: ['username'] }],
      order: [['created_at', 'DESC']],
      limit: 100
    });

    const suspicious = tweets.filter((tweet) => isPotentialXss(tweet.content || ''));

    console.log(`Tweets analyses: ${tweets.length}`);
    console.log(`Tweets suspects XSS: ${suspicious.length}`);
    console.log('='.repeat(120));

    if (suspicious.length === 0) {
      console.log('Aucun tweet suspect detecte.');
      return;
    }

    suspicious.forEach((tweet, index) => {
      const author = tweet.author?.username || 'unknown';
      const preview = (tweet.content || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      console.log(`${index + 1}. id=${tweet.id} | author=@${author} | parent=${tweet.parent_tweet_id || 'null'}`);
      console.log(`   preview: ${preview}`);
      console.log('-'.repeat(120));
    });

    console.log('IDS_ONLY:');
    suspicious.forEach((tweet) => console.log(tweet.id));
  } catch (error) {
    console.error('Erreur detection XSS:', error.message);
    process.exitCode = 1;
  } finally {
    await closeConnection();
  }
}

detectXssInLast100Tweets();
