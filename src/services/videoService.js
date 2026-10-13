const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const videoEditService = require('./videoEditService');
const { sequelize } = require('../database');
const { getPublicMediaOrigin } = require('../utils/publicMediaOrigin');
const objectStorage = require('./objectStorage');

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
 * Vrai si la vidéo peut être servie TELLE QUELLE, après un simple remux.
 *
 * L'app iOS exporte elle-même en H.264 1080×1920, 30 i/s, ~6 Mbit/s, AAC
 * (voir `VideoExporter.swift`). Réencoder ce fichier coûtait des dizaines de
 * secondes de CPU au VPS — c'était l'attente « Traitement de la vidéo… » — et
 * le RABAISSAIT en 720p, deuxième génération de compression en prime. On ne
 * réencode donc plus que ce qui en a besoin : codec exotique, image trop
 * grande, débit trop lourd, rotation à appliquer, ou habillage à incruster.
 */
function isServable(metadata) {
  const streams = metadata.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) return false;

  const rotation = Number(v.tags?.rotate || 0)
    || Number((v.side_data_list || []).find((d) => d.rotation !== undefined)?.rotation || 0);
  const [num, den] = String(v.r_frame_rate || '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;
  const bitrate = Number(metadata.format?.bit_rate || 0);
  const duration = Number(metadata.format?.duration || 0);

  return v.codec_name === 'h264'
    && v.pix_fmt === 'yuv420p'
    && rotation === 0
    && v.width <= 1080 && v.height <= 1920 && v.height >= v.width
    && fps > 0 && fps <= 31
    && duration > 0 && duration <= 60.5
    && bitrate > 0 && bitrate <= 10_000_000
    && (!a || a.codec_name === 'aac');
}

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

        // Chemin rapide : fichier déjà conforme et rien à incruster → remux
        // sans réencodage (quelques secondes au lieu de dizaines).
        const fast = !editSpec && isServable(metadata);
        if (fast) logger.info(`⚡ Vidéo ${videoId} déjà conforme : remux sans réencodage`);

        let command = fast
          ? ffmpeg(inputPath)
            .format('mp4')
            .outputOptions(['-map 0:v:0', '-map 0:a:0?', '-c copy', '-movflags +faststart'])
          : ffmpeg(inputPath)
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
          // `superfast`/CRF 26 dégradait visiblement l'image (bug Forge « page creer tweet » :
          // rendu flou/pixelisé après compression) ; `veryfast`/CRF 23 reste rapide côté
          // serveur tout en gardant un niveau de détail correct.
          .outputOptions([
            '-preset veryfast',
            '-crf 23',
            '-movflags +faststart',
            '-pix_fmt yuv420p',
            '-r 30',   // Force 30 fps
            '-g 30',   // Keyframe chaque 1 seconde (évite le lag lors du loop Playback)
            '-sc_threshold 0' // Améliore la fluidité de lecture en boucle
          ]);

        // Couper le son se fait ici, à l'encodage : supprimer la piste après
        // coup demanderait un remux de plus, pour le même résultat.
        if (!fast && editSpec && editSpec.muted) {
          command = command.noAudio();
        }

        // Limiter à 60 secondes max uniquement si nécessaire
        if (!fast && exactDuration > 60) {
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
              .on('end', async () => {
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
                // Vidéo et miniature partent sur R2 (repli : disque, comme avant).
                const [publicUrl, publicThumbnailUrl] = await Promise.all([
                  objectStorage.publish(outputPath, 'videos', fileName,
                    { localUrl: objectStorage.storageUrl(fileName), contentType: 'video/mp4' }),
                  objectStorage.publish(thumbnailPath, 'videos', thumbName,
                    { localUrl: objectStorage.storageUrl(thumbName), contentType: 'image/jpeg' }),
                ]);
                resolve({
                  videoPath: outputPath,
                  publicUrl,
                  thumbnailPath: thumbnailPath,
                  publicThumbnailUrl,
                  duration: targetDuration
                });
              })
              .on('error', async (screenshotErr) => {
                logger.error('Erreur génération thumbnail:', screenshotErr);
                // On résout quand même si la vidéo a marché
                resolve({
                  videoPath: outputPath,
                  publicUrl: await objectStorage.publish(outputPath, 'videos', fileName,
                    { localUrl: objectStorage.storageUrl(fileName), contentType: 'video/mp4' }),
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
  isServable,
  upload,
  videoService: new VideoService(),
  STORAGE_DIR
};
