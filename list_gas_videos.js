const { User, Tweet } = require('./src/models');

async function listVideos() {
  try {
    const user = await User.findOne({ where: { username: 'gas' } });
    if (!user) {
      console.log('User gas not found.');
      process.exit(0);
    }
    
    const videos = await Tweet.findAll({
      where: {
        user_id: user.id,
        tweet_type: 'video'
      },
      order: [['created_at', 'ASC']]
    });
    
    console.log(`Found ${videos.length} video tweets for user gas (sorted ASC):`);
    videos.forEach((v, index) => {
      console.log(`${index + 1}. ID: ${v.id} | Content: "${v.content}" | Created At: ${v.created_at || v.createdAt}`);
    });
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

listVideos();
