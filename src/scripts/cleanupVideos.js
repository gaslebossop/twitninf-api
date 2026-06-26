const fs = require('fs');
const path = require('path');
const { Tweet, User } = require('../models');
const { STORAGE_DIR } = require('../services/videoService');
const logger = require('../utils/logger');

async function cleanupVideos() {
  try {
    logger.info('🧹 Démarrage du nettoyage complet des vidéos...');

    // 1. Récupérer toutes les vidéos de la DB
    const videos = await Tweet.findAll({
      where: { tweet_type: 'video' }
    });

    logger.info(`🔍 ${videos.length} vidéos trouvées dans la base de données.`);

    // 2. Supprimer les fichiers physiques
    if (fs.existsSync(STORAGE_DIR)) {
      const files = fs.readdirSync(STORAGE_DIR);
      let deletedFilesCount = 0;

      for (const file of files) {
        // Supprimer uniquement les fichiers liés aux vidéos (vid_*.mp4, thumb_*.jpg, temp_*)
        if (file.startsWith('vid_') || file.startsWith('thumb_') || file.startsWith('temp_')) {
          const filePath = path.join(STORAGE_DIR, file);
          try {
            fs.unlinkSync(filePath);
            deletedFilesCount++;
          } catch (err) {
            logger.error(`❌ Impossible de supprimer le fichier ${file}:`, err.message);
          }
        }
      }
      logger.info(`🗑️ ${deletedFilesCount} fichiers supprimés du dossier storage.`);
    }

    // 3. Supprimer les entrées de la DB
    const deletedTweetsCount = await Tweet.destroy({
      where: { tweet_type: 'video' }
    });

    logger.info(`✅ ${deletedTweetsCount} enregistrements supprimés de la table tweets.`);
    logger.info('✨ Nettoyage terminé avec succès.');
    
    process.exit(0);
  } catch (error) {
    logger.error('💥 Erreur fatale lors du nettoyage:', error);
    process.exit(1);
  }
}

// Lancer le script
cleanupVideos();
