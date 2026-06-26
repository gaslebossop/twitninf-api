const { Tweet, User, TweetLike, TweetRetweet, sequelize } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

/**
 * 📊 Script d'analyse des statistiques d'engagement vidéo par compte
 * Calcule : Vues, Watchtime total, Moyenne par vidéo, Likes, Retweets, Taux d'engagement
 */
async function analyzeVideoEngagement() {
  try {
    console.log('\n🚀 [VideoStats] Démarrage de l\'analyse des comptes vidéo...');

    // 1. Récupérer toutes les vidéos non supprimées avec leurs auteurs
    const videos = await Tweet.findAll({
      where: { 
        tweet_type: 'video',
        deleted_at: null 
      },
      include: [
        {
          model: User,
          as: 'author',
          attributes: ['id', 'username', 'full_name']
        }
      ]
    });

    if (videos.length === 0) {
      console.log('⚠️ Aucune vidéo trouvée pour l\'analyse.');
      process.exit(0);
    }

    console.log(`🔍 Analyse de ${videos.length} vidéos en cours...\n`);

    const statsByUser = {};

    // 2. Agrégation des statistiques par auteur
    for (const video of videos) {
      const author = video.author;
      if (!author) continue;

      const userId = author.id;
      if (!statsByUser[userId]) {
        statsByUser[userId] = {
          username: author.username,
          fullName: author.full_name,
          videoCount: 0,
          totalViews: 0,
          totalWatchTime: 0, // en secondes
          totalLikes: 0,
          totalRetweets: 0,
          totalReplies: 0
        };
      }

      const uStats = statsByUser[userId];
      uStats.videoCount++;
      uStats.totalViews += (video.view_count || 0);
      
      // Extraction du watch time depuis la colonne metadata (JSONB)
      // La clé attendue est 'total_watch_time' (secondes)
      const watchTime = parseFloat(video.metadata?.total_watch_time) || 0;
      uStats.totalWatchTime += watchTime;

      // Récupération des counts d'engagement (on pourrait faire plus rapide en batch SQL)
      const [lCount, rtCount, repCount] = await Promise.all([
        TweetLike.count({ where: { tweet_id: video.id } }),
        TweetRetweet.count({ where: { tweet_id: video.id } }),
        Tweet.count({ where: { parent_tweet_id: video.id, deleted_at: null } })
      ]);

      uStats.totalLikes += lCount;
      uStats.totalRetweets += rtCount;
      uStats.totalReplies += repCount;

      process.stdout.write('.'); // Un petit indicateur de progrès
    }

    // 3. Calcul des métriques dérivées et tri
    const results = Object.values(statsByUser)
      .map(u => ({
        ...u,
        avgWatchTime: u.videoCount > 0 ? (u.totalWatchTime / u.videoCount).toFixed(2) : 0,
        engagementRate: u.totalViews > 0 
          ? (((u.totalLikes + u.totalRetweets + u.totalReplies) / u.totalViews) * 100).toFixed(2)
          : 0
      }))
      .sort((a, b) => b.totalWatchTime - a.totalWatchTime); // Classement principal par WatchTime Total

    // 4. Affichage du rapport
    console.log('\n\n🏆 CLASSEMENT DES MEILLEURS COMPTES CRÉATEURS VIDÉO');
    console.log('=' .repeat(110));
    console.log(
      'Utilisateur'.padEnd(25),
      'Vidéos'.padEnd(10),
      'Vues'.padEnd(12),
      'WatchTime (s)'.padEnd(18),
      'Moy/Vid (s)'.padEnd(15),
      'Likes'.padEnd(12),
      'Engag %'
    );
    console.log('-' .repeat(110));

    results.forEach((u, i) => {
      const rank = `${i + 1}. `.padEnd(4);
      console.log(
        (rank + u.username).padEnd(25),
        String(u.videoCount).padEnd(10),
        String(u.totalViews).padEnd(12),
        String(u.totalWatchTime.toFixed(1)).padEnd(18),
        String(u.avgWatchTime).padEnd(15),
        String(u.totalLikes).padEnd(12),
        String(u.engagementRate + '%')
      );
    });

    console.log('=' .repeat(110));
    console.log(`📊 Résumé : ${results.length} créateurs actifs analysés.`);
    console.log('✨ Analyse terminée avec succès.\n');
    
    process.exit(0);

  } catch (error) {
    console.error('❌ Erreur fatale lors de l\'analyse des statistiques:', error);
    process.exit(1);
  }
}

// Lancement de l'analyse
analyzeVideoEngagement();
