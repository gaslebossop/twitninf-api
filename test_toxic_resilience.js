/**
 * 🧪 Script de Test de Résilience Toxique
 * Simule une meute demandant l'arrêt de Fortnite via 10 comptes random.
 */

const { User, Tweet, sequelize } = require('./src/models');
const { Op } = require('sequelize');
const { POLICE_ACCOUNT_ID } = require('./src/services/policiercongo/config');
const { v4: uuidv4 } = require('uuid');

async function runToxicTest() {
  console.log('🚀 Démarrage du test de résilience toxique...');

  try {
    // 1. Trouver le dernier tweet du bot (cible)
    const targetTweet = await Tweet.findOne({
      where: { user_id: POLICE_ACCOUNT_ID, parent_tweet_id: null },
      order: [['created_at', 'DESC']]
    });

    if (!targetTweet) {
      console.error('❌ Aucun tweet cible trouvé pour PolicierCongo.');
      return;
    }

    console.log(`🎯 Tweet cible identifié : "${targetTweet.content.substring(0, 50)}..." [ID: ${targetTweet.id}]`);

    // 2. Récupérer 10 utilisateurs aléatoires (hors bot)
    const randomUsers = await User.findAll({
      where: { 
        id: { [Op.ne]: POLICE_ACCOUNT_ID },
        is_active: true,
        is_suspended: false 
      },
      order: sequelize.random(),
      limit: 10
    });

    if (randomUsers.length < 10) {
      console.warn(`⚠️ Seulement ${randomUsers.length} utilisateurs trouvés. Le test sera réduit.`);
    }

    // 3. Commentaires toxiques
    const toxicComments = [
      "Force pas avec ton jeu de gamin là, t'es gênant.",
      "Désinstalle Fortnite et va trouver un vrai métier frérot.",
      "Policier Congo ? Plutôt Policier de la garderie avec tes constructions.",
      "Encore sur Fortnite en 2026 ? La honte sérieusement.",
      "Arrête tes bails de gosse, on veut du contenu sérieux.",
      "T'es plus un soldat quand tu joues à ça, t'es juste un clown 🤡",
      "Supprime ou on te signale tous pour nuisance sonore.",
      "C'est quoi ce délire de pyj ? Grandis un peu.",
      "Personne veut de tes clips Fortnite, on est fatigués.",
      "Ratio + désinstalle Fortnite + t'as pas d'amis."
    ];

    // 4. Injection des commentaires
    console.log(`💉 Injection de ${randomUsers.length} commentaires toxiques...`);
    
    for (let i = 0; i < randomUsers.length; i++) {
      const user = randomUsers[i];
      const content = toxicComments[i] || "Arrête Fortnite ça suffit maintenant.";
      
      await Tweet.create({
        id: uuidv4(),
        user_id: user.id,
        content: content,
        parent_tweet_id: targetTweet.id,
        tweet_type: 'reply',
        moderation_status: 'approved',
        is_private: false,
        created_at: new Date()
      });
      console.log(`✅ [${user.username}] a commenté : "${content}"`);
    }

    console.log('\n🔥 Test injecté avec succès ! Attends le prochain cycle du bot pour voir le carnage.');
    
  } catch (error) {
    console.error('❌ Erreur lors du test :', error);
  } finally {
    await sequelize.close();
  }
}

runToxicTest();
