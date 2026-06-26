const { Tweet, User, sequelize } = require('./src/models');
const logger = require('./src/utils/logger');

async function testReplySystem() {
  try {
    logger.info('🧪 Test du système de réponses...');
    
    // 1. Vérifier la structure de la base de données
    logger.info('📊 Vérification de la structure de la base de données...');
    
    // Vérifier si la table tweets existe
    const tables = await sequelize.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'tweets'",
      { type: sequelize.QueryTypes.SELECT }
    );
    
    if (tables.length === 0) {
      logger.error('❌ Table tweets non trouvée');
      return;
    }
    
    logger.info('✅ Table tweets trouvée');
    
    // Vérifier la structure de la table tweets
    const columns = await sequelize.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tweets' ORDER BY ordinal_position",
      { type: sequelize.QueryTypes.SELECT }
    );
    
    logger.info('📋 Structure de la table tweets:');
    columns.forEach(col => {
      logger.info(`   - ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
    });
    
    // 2. Vérifier les associations
    logger.info('🔗 Vérification des associations...');
    
    // Vérifier si les clés étrangères existent
    const foreignKeys = await sequelize.query(
      "SELECT tc.constraint_name, tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name FROM information_schema.table_constraints AS tc JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'tweets'",
      { type: sequelize.QueryTypes.SELECT }
    );
    
    logger.info('🔑 Clés étrangères de la table tweets:');
    foreignKeys.forEach(fk => {
      logger.info(`   - ${fk.column_name} → ${fk.foreign_table_name}.${fk.foreign_column_name}`);
    });
    
    // 3. Vérifier les données existantes
    logger.info('📊 Vérification des données existantes...');
    
    const tweetCount = await Tweet.count();
    const userCount = await User.count();
    
    logger.info(`   - Tweets: ${tweetCount}`);
    logger.info(`   - Utilisateurs: ${userCount}`);
    
    if (tweetCount === 0 || userCount === 0) {
      logger.warn('⚠️ Pas assez de données pour tester les réponses');
      return;
    }
    
    // 4. Récupérer un utilisateur et un tweet existants
    const user = await User.findOne();
    const tweet = await Tweet.findOne({
      where: { parent_tweet_id: null }, // Tweet original (pas une réponse)
      include: [{ model: User, as: 'author' }]
    });
    
    if (!user || !tweet) {
      logger.error('❌ Impossible de trouver un utilisateur et un tweet pour le test');
      return;
    }
    
    logger.info(`👤 Utilisateur de test: @${user.username}`);
    logger.info(`📝 Tweet de test: ${tweet.id} - "${tweet.content.substring(0, 50)}..."`);
    
    // 5. Tester la création d'une réponse
    logger.info('💬 Test de création d\'une réponse...');
    
    try {
      const reply = await Tweet.create({
        content: 'Ceci est une réponse de test ! 🚔',
        user_id: user.id,
        parent_tweet_id: tweet.id, // Réponse au tweet
        is_private: false,
        is_sensitive: false,
        language: 'fr',
        moderation_status: 'approved',
        metadata: {
          source: 'test',
          test_type: 'reply_creation'
        }
      });
      
      logger.info(`✅ Réponse créée avec succès: ${reply.id}`);
      logger.info(`   - Parent tweet: ${reply.parent_tweet_id}`);
      logger.info(`   - Auteur: ${reply.user_id}`);
      logger.info(`   - Contenu: ${reply.content}`);
      
      // 6. Vérifier que la réponse est bien liée
      const replyWithParent = await Tweet.findByPk(reply.id, {
        include: [
          { model: Tweet, as: 'parentTweet' },
          { model: User, as: 'author' }
        ]
      });
      
      if (replyWithParent.parentTweet) {
        logger.info(`✅ Association parentTweet confirmée: ${replyWithParent.parentTweet.id}`);
      } else {
        logger.error('❌ Association parentTweet échouée');
      }
      
      // 7. Vérifier que le tweet parent a bien la réponse
      const parentWithReplies = await Tweet.findByPk(tweet.id, {
        include: [
          { model: Tweet, as: 'replies' },
          { model: User, as: 'author' }
        ]
      });
      
      if (parentWithReplies.replies && parentWithReplies.replies.length > 0) {
        logger.info(`✅ Réponse trouvée dans le tweet parent: ${parentWithReplies.replies.length} réponse(s)`);
        parentWithReplies.replies.forEach((reply, index) => {
          logger.info(`   - Réponse ${index + 1}: ${reply.id} par @${reply.author?.username}`);
        });
      } else {
        logger.error('❌ Réponse non trouvée dans le tweet parent');
      }
      
      // 8. Nettoyer le test
      await reply.destroy();
      logger.info('🧹 Réponse de test supprimée');
      
    } catch (replyError) {
      logger.error('❌ Erreur lors de la création de la réponse:', replyError);
      
      // Analyser l'erreur
      if (replyError.name === 'SequelizeValidationError') {
        logger.error('   - Erreur de validation Sequelize');
        replyError.errors.forEach(err => {
          logger.error(`     * ${err.path}: ${err.message}`);
        });
      } else if (replyError.name === 'SequelizeForeignKeyConstraintError') {
        logger.error('   - Erreur de contrainte de clé étrangère');
        logger.error(`     * Table: ${replyError.table}`);
        logger.error(`     * Colonne: ${replyError.fields}`);
        logger.error(`     * Valeur: ${replyError.value}`);
      } else if (replyError.name === 'SequelizeDatabaseError') {
        logger.error('   - Erreur de base de données');
        logger.error(`     * Code: ${replyError.parent?.code}`);
        logger.error(`     * Message: ${replyError.parent?.message}`);
      }
    }
    
    // 9. Tester la requête pour récupérer les réponses
    logger.info('🔍 Test de récupération des réponses...');
    
    try {
      // Récupérer toutes les réponses à un tweet
      const replies = await Tweet.findAll({
        where: { parent_tweet_id: tweet.id },
        include: [{ model: User, as: 'author' }],
        order: [['created_at', 'DESC']]
      });
      
      logger.info(`✅ Réponses récupérées: ${replies.length}`);
      
      // Récupérer le tweet avec ses réponses
      const tweetWithReplies = await Tweet.findByPk(tweet.id, {
        include: [
          { model: Tweet, as: 'replies', include: [{ model: User, as: 'author' }] },
          { model: User, as: 'author' }
        ]
      });
      
      if (tweetWithReplies.replies) {
        logger.info(`✅ Tweet avec réponses: ${tweetWithReplies.replies.length} réponse(s)`);
      }
      
    } catch (queryError) {
      logger.error('❌ Erreur lors de la récupération des réponses:', queryError);
    }
    
    logger.info('✅ Test du système de réponses terminé');
    
  } catch (error) {
    logger.error('❌ Erreur lors du test:', error);
  } finally {
    await sequelize.close();
  }
}

// Exécuter le test
testReplySystem();
