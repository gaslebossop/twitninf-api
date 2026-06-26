const { User, Tweet } = require('./src/models');

async function checkTweets() {
  try {
    const user = await User.findOne({ where: { username: 'gas' } });
    if (!user) {
      console.log('User gas not found.');
      process.exit(0);
    }
    
    const lastVideo = await Tweet.findOne({
      where: {
        user_id: user.id,
        tweet_type: 'video'
      },
      order: [['created_at', 'DESC']]
    });
    
    if (lastVideo) {
      console.log('Last video tweet found:', {
        id: lastVideo.id,
        content: lastVideo.content,
        created_at: lastVideo.created_at
      });
    } else {
      console.log('No video tweet found for user gas.');
    }
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkTweets();
