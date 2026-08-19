const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const videoEditService = require('./videoEditService');
const { sequelize } = require('../database');
const { getPublicMediaOrigin } = require('../utils/publicMediaOrigin');

// Dossier cible pour le stockage (dans le code API)
const STORAGE_DIR = path.join(__dirname, '../../storage');
// Dossier temporaire pour les uploads non compressés
const TEMP_DIR = path.join(__dirname, '../../storage/temp');

// S'assurer que les dossiers existent (le VPS devra gérer ça, mais on tente au cas où)
try {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
} catch (error) {
  logger.warn('⚠️ Impossible de créer les dossiers de stockage vidéo, assurez-vous qu\'ils existent sur le VPS:', error.message);
}

// Configuration Multer pour l'upload initial (temporaire)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Utilise le dossier local TEMP_DIR garanti d'exister
    cb(null, TEMP_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'temp_video_' + uniqueSuffix + path.extname(file.originalname));
  }
});

// Filtre pour n'accepter que les vidéos
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Le fichier doit être une vidéo.'), false);
  }
};

// On ne met pas de filesize limit ici pour laisser la compression faire le job, 
// mais on limite à des fichiers raisonnables (ex: 500MB max à l'upload)
const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit avant compression
});

/**
 * Service pour la gestion des vidéos
 */
class VideoService {
  constructor() {
    this.io = null;
  }

  setIo(io) {
    this.io = io;
  }

  /**
   * Compresse une vidéo avec ffmpeg et force une résolution verticale 720p (720x1280)
   * @param {string} inputPath Chemin de la vidéo originale
   * @param {string} videoId ID unique pour la nouvelle vidéo (utilisé pour les fichiers)
   * @param {string} socketRoomId ID du salon socket pour les notifications (par défaut videoId)
   * @returns {Promise<{videoPath: string, publicUrl: string, duration: number, thumbnailPath: string, publicThumbnailUrl: string}>}
   */
  async processVideo(inputPath, videoId, socketRoomId = null, edit = null) {
    const roomId = socketRoomId || videoId;
    // Habillage demandé par l'app (textes, étalonnage, coupure du son). Il
    // s'applique DANS cette passe : réencoder une seconde fois pour incruster
    // empilerait deux générations de compression.
    const editSpec = edit ? videoEditService.parseEdit(edit) : null;
    return new Promise((resolve, reject) => {
      const targetDir = STORAGE_DIR;
      
      const fileName = `vid_${videoId}.mp4`;
      const thumbName = `thumb_${videoId}.jpg`;
      
      const outputPath = path.join(targetDir, fileName);
      const thumbnailPath = path.join(targetDir, thumbName);

      // On vérifie d'abord les metadata (durée)
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          logger.error('Erreur ffprobe:', err);
          // AUDIT S3 (2026-08-19) : seul chemin d'échec qui laissait le
          // fichier temporaire (jusqu'à 500 Mo) sur disque indéfiniment —
          // celui de la compression, juste en dessous, le fait déjà.
          fs.unlink(inputPath, () => {});
          return reject(new Error('Impossible de lire les métadonnées de la vidéo.'));
        }

        const exactDuration = metadata.format.duration; // en secondes
        let targetDuration = exactDuration;

        // L'habillage vient APRÈS scale+crop : incruster avant placerait les
        // textes d'après un cadre qui n'existe plus dans le fichier final.
        const editFilters = editSpec
          ? videoEditService.buildVideoFilters(editSpec, targetDir, videoId)
          : [];

        let command = ffmpeg(inputPath)
          .format('mp4')
          .videoCodec('libx264')
          .audioCodec('aac')
          // Force vertical 720p (720x1280) avec crop si nécessaire
          .videoFilters([
            'scale=720:1280:force_original_aspect_ratio=increase',
            'crop=720:1280',
            ...editFilters,
          ])
          // Optimisation pour streaming fluide et boucles sans freeze (-g 30 = I-Frame chaque sec)
          .outputOptions([
            '-preset superfast',
            '-crf 26',
            '-movflags +faststart',
            '-pix_fmt yuv420p',
            '-r 30',   // Force 30 fps
            '-g 30',   // Keyframe chaque 1 seconde (évite le lag lors du loop Playback)
            '-sc_threshold 0' // Améliore la fluidité de lecture en boucle
          ]);

        // Couper le son se fait ici, à l'encodage : supprimer la piste après
        // coup demanderait un remux de plus, pour le même résultat.
        if (editSpec && editSpec.muted) {
          command = command.noAudio();
        }

        // Limiter à 60 secondes max uniquement si nécessaire
        if (exactDuration > 60) {
          command = command.setDuration(60);
          targetDuration = 60;
        }

        // Suivi de la progression en temps réel
        command.on('progress', (progress) => {
          if (this.io) {
            this.io.to(`video_upload_${roomId}`).emit('processing_progress', {
              percent: progress.percent || 0,
              videoId
            });
          }
        });

        command.on('end', () => {
            // Les fichiers texte des incrustations ont fini leur office : les
            // laisser encombrerait le dossier de stockage sans qu'on les y
            // cherche jamais.
            if (editSpec) videoEditService.cleanupOverlayFiles(targetDir, videoId);
            logger.info(`✅ Vidéo analysée et compressée: ${outputPath}`);
            
            // 2ème étape: Générer la miniature au milieu de la vidéo (ou à 1 sec si très court)
            const thumbTime = targetDuration > 2 ? Math.floor(targetDuration / 2) : 0;
            
            ffmpeg(inputPath)
              .screenshots({
                timestamps: [thumbTime],
                filename: thumbName,
                folder: targetDir,
                size: '320x?'
              })
              .on('end', () => {
                logger.info(`✅ Thumbnail généré pour ${videoId}`);
                
                // Supprimer le fichier d'origine temporaire
                fs.unlink(inputPath, (unlinkErr) => {
                  if (unlinkErr) logger.warn(`Impossible de supprimer le fichier temporaire ${inputPath}:`, unlinkErr);
                });

                // Retourner info.
                // URL absolue (domaine + /storage/, servi en statique par Express) :
                // un chemin relatif n'est pas une URI valide pour <Image>/<Video>
                // côté client, qui a besoin d'un schéma + hôte pour aller chercher
                // le fichier sur le réseau — c'est resté en chemin relatif jusqu'ici,
                // d'où une vidéo/miniature qui ne charge jamais.
                resolve({
                  videoPath: outputPath,
                  publicUrl: `${getPublicMediaOrigin()}/storage/${fileName}`,
                  thumbnailPath: thumbnailPath,
                  publicThumbnailUrl: `${getPublicMediaOrigin()}/storage/${thumbName}`,
                  duration: targetDuration
                });
              })
              .on('error', (screenshotErr) => {
                logger.error('Erreur génération thumbnail:', screenshotErr);
                // On résout quand même si la vidéo a marché
                resolve({
                  videoPath: outputPath,
                  publicUrl: `${getPublicMediaOrigin()}/storage/${fileName}`,
                  thumbnailPath: null,
                  publicThumbnailUrl: null,
                  duration: targetDuration
                });
              });
          })
          .on('error', (err) => {
            logger.error(`Erreur FFMPEG pendant la compression vidéo [${videoId}]:`, err);
            if (editSpec) videoEditService.cleanupOverlayFiles(targetDir, videoId);
            // Essayer de supprimer le fichier temporaire
            fs.unlink(inputPath, () => {});
            reject(new Error('Erreur de traitement de la vidéo. FFMPEG est-il installé sur le serveur ?'));
          });

        command.save(outputPath);
      });
    });
  }
}

module.exports = {
  upload,
  videoService: new VideoService(),
  STORAGE_DIR
};
