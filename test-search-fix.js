const { sequelize, Tweet, User } = require('./src/models');

async function testSearchFix() {
  try {
    console.log('🧪 Test de la correction de recherche...');
    
    // Test de connexion
    await sequelize.authenticate();
    console.log('✅ Connexion à la base de données réussie');
    
    // Test de recherche simple
    const testQuery = 'test';
    console.log(`🔍 Test de recherche pour: "${testQuery}"`);
    
    const tweets = await Tweet.searchTweets(testQuery, {
      limit: 5,
      includeReplies: false,
      includeRetweets: true
    });
    
    console.log(`✅ Recherche réussie: ${tweets.length} tweets trouvés`);
    
    // Afficher les premiers résultats
    tweets.forEach((tweet, index) => {
      console.log(`${index + 1}. Tweet ID: ${tweet.id}`);
      console.log(`   Contenu: ${tweet.content?.substring(0, 50)}...`);
      console.log(`   Auteur: ${tweet.author?.username || 'N/A'}`);
      console.log(`   Hashtags: ${tweet.hashtags?.join(', ') || 'Aucun'}`);
      console.log('---');
    });
    
    console.log('🎉 Test terminé avec succès !');
    
  } catch (error) {
    console.error('❌ Erreur lors du test:', error);
  } finally {
    await sequelize.close();
  }
}

testSearchFix();
