const { Sequelize } = require('sequelize');
const { User, Tweet } = require('./src/models');

async function testDatabaseStructure() {
  try {
    console.log('🧪 Test de la structure de la base de données...');
    
    // Test 1: Récupérer un tweet simple
    console.log('\n📝 Test 1: Récupération d\'un tweet simple...');
    const simpleTweet = await Tweet.findOne({
      where: { deleted_at: null },
      attributes: ['id', 'content', 'created_at', 'user_id'],
      raw: true // Récupérer les données brutes
    });
    
    if (simpleTweet) {
      console.log('✅ Tweet trouvé:', {
        id: simpleTweet.id,
        content: simpleTweet.content ? `"${simpleTweet.content.substring(0, 50)}..."` : 'AUCUN CONTENU',
        contentLength: simpleTweet.content ? simpleTweet.content.length : 0,
        created_at: simpleTweet.created_at,
        user_id: simpleTweet.user_id
      });
    } else {
      console.log('❌ Aucun tweet trouvé');
    }

    // Test 2: Récupérer un tweet avec include
    console.log('\n📝 Test 2: Récupération d\'un tweet avec include...');
    const tweetWithAuthor = await Tweet.findOne({
      where: { deleted_at: null },
      attributes: ['id', 'content', 'created_at', 'user_id'],
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name']
        }
      ]
    });
    
    if (tweetWithAuthor) {
      console.log('✅ Tweet avec auteur trouvé:', {
        id: tweetWithAuthor.id,
        content: tweetWithAuthor.content ? `"${tweetWithAuthor.content.substring(0, 50)}..."` : 'AUCUN CONTENU',
        contentLength: tweetWithAuthor.content ? tweetWithAuthor.content.length : 0,
        author: tweetWithAuthor.author ? tweetWithAuthor.author.username : 'AUCUN AUTEUR',
        keys: Object.keys(tweetWithAuthor),
        hasDataValues: !!tweetWithAuthor.dataValues,
        dataValuesKeys: tweetWithAuthor.dataValues ? Object.keys(tweetWithAuthor.dataValues) : 'AUCUN'
      });
    } else {
      console.log('❌ Aucun tweet avec auteur trouvé');
    }

    // Test 3: Vérifier la structure du modèle
    console.log('\n📝 Test 3: Structure du modèle Tweet...');
    console.log('Attributs du modèle:', Object.keys(Tweet.rawAttributes));
    console.log('Associations:', Object.keys(Tweet.associations));

  } catch (error) {
    console.error('❌ Erreur lors du test:', error);
  } finally {
    process.exit(0);
  }
}

testDatabaseStructure();
