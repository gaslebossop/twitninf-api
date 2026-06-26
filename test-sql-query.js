const { Sequelize } = require('sequelize');
const { User, Tweet } = require('./src/models');

async function testSQLQuery() {
  try {
    console.log('🧪 Test de requête SQL brute...');
    
    // Test 1: Requête SQL brute
    console.log('\n📝 Test 1: Requête SQL brute...');
    const [results] = await Tweet.sequelize.query(`
      SELECT id, content, user_id, tweet_type, is_retweet, is_quote,
             media_urls, hashtags, mentions, view_count, click_count,
             moderation_status, deleted_at
      FROM tweets 
      WHERE deleted_at IS NULL 
      LIMIT 3
    `);
    
    console.log('✅ Résultats SQL bruts:', results);
    
    // Test 2: Requête avec include via Sequelize
    console.log('\n📝 Test 2: Requête Sequelize avec include...');
    const sequelizeResults = await Tweet.findAll({
      where: { deleted_at: null },
      attributes: ['id', 'content', 'user_id', 'tweet_type', 'is_retweet', 'is_quote',
                  'media_urls', 'hashtags', 'mentions', 'view_count', 'click_count',
                  'moderation_status', 'deleted_at'],
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name', 'avatar', 'verified', 'premium']
        }
      ],
      limit: 3,
      raw: false
    });
    
    console.log('✅ Résultats Sequelize:', sequelizeResults.length, 'tweets trouvés');
    
    if (sequelizeResults.length > 0) {
      const firstResult = sequelizeResults[0];
      console.log('\n🔍 Premier résultat détaillé:');
      console.log('Type:', typeof firstResult);
      console.log('Clés:', Object.keys(firstResult));
      console.log('dataValues:', firstResult.dataValues ? Object.keys(firstResult.dataValues) : 'AUCUN');
      console.log('ID:', firstResult.id);
      console.log('Content:', firstResult.content);
      console.log('Author:', firstResult.author ? firstResult.author.username : 'AUCUN');
      
      // Test de conversion
      const jsonResult = firstResult.toJSON ? firstResult.toJSON() : firstResult;
      console.log('\n🧹 Après toJSON():');
      console.log('Clés:', Object.keys(jsonResult));
      console.log('ID:', jsonResult.id);
      console.log('Content:', jsonResult.content);
    }

  } catch (error) {
    console.error('❌ Erreur lors du test:', error);
  } finally {
    process.exit(0);
  }
}

testSQLQuery();
