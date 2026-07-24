require('dotenv').config();
const { Tweet, User } = require('./src/models');

async function deleteLastPolicierCongoTweet() {
  try {
    // L'ID du compte PolicierCongo d'après la configuration de l'app
    const policeUserId = 'a13a7745-448f-4faa-892a-f6ea140f2f5b';
    
    console.log(`⏳ Recherche du dernier tweet de PolicierCongo (ID: ${policeUserId})...`);
    
    // Trouver le dernier tweet non supprimé
    const lastTweet = await Tweet.findOne({
      where: { 
        user_id: policeUserId,
        deleted_at: null 
      },
      order: [['created_at', 'DESC']]
    });

    if (!lastTweet) {
      console.log('❌ Aucun tweet actif trouvé pour PolicierCongo.');
      process.exit(0);
    }

    console.log(`📄 Tweet trouvé : [ID: ${lastTweet.id}]`);
    console.log(`💬 Contenu : "${lastTweet.content.substring(0, 60)}..."`);
    console.log(`📅 Date : ${lastTweet.created_at}`);

    // Suppression définitive de la BDD (Hard Delete pour s'assurer qu'il disparaisse partout)
    await lastTweet.destroy({ force: true });
    
    console.log('✅ Le dernier tweet a été supprimé définitivement avec succès !');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Erreur lors de la suppression du tweet:', error);
    process.exit(1);
  }
}

deleteLastPolicierCongoTweet();
