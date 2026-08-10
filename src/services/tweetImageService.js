'use strict';

/**
 * 🖼️ Images jointes à un tweet.
 *
 * Deux responsabilités, volontairement séparées de la route :
 *   - transformer un fichier envoyé en une image servable (recompression) ;
 *   - décider si une URL a le droit d'entrer dans `media_urls`.
 *
 * ── Pourquoi recompresser plutôt que stocker tel quel ──
 * Un téléphone récent produit des JPEG de 6 à 12 Mo, en 4032 px de large, avec
 * l'orientation dans les métadonnées EXIF. Servis tels quels dans un fil, ils
 * coûtent la bande passante des lecteurs, s'affichent parfois couchés, et
 * emportent les métadonnées de la prise de vue — dont la position GPS. On
 * réencode donc systématiquement : `rotate()` sans argument applique
 * l'orientation EXIF puis la supprime, et sharp ne recopie aucun autre bloc de
 * métadonnées par défaut.
 *
 * ── Pourquoi filtrer les URLs à la publication ──
 * `POST /api/tweets` accepte `media_urls` depuis le client. Sans contrôle,
 * n'importe qui pourrait y écrire l'URL d'un serveur tiers : le fil chargerait
 * alors une ressource distante à chaque affichage, ce qui revient à donner à
 * un inconnu l'adresse IP et l'heure de lecture de tous ceux qui croisent le
 * tweet. On n'accepte donc que les fichiers que cette API a elle-même émis.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');

const { buildStaticMediaPublicUrl, getPublicMediaOrigin } = require('../utils/publicMediaOrigin');

/** Servi par `app.use('/static', express.static(src/public))`. */
const TWEET_IMAGES_DIR = path.join(__dirname, '../public/tweets');

/** Même plafond que le modèle `Tweet` (`media_urls` : 4 maximum). */
const MAX_IMAGES_PER_TWEET = 4;

/**
 * Assez grand pour rester net sur un écran de téléphone à densité 3x affiché
 * en pleine largeur, assez petit pour ne pas facturer 8 Mo à chaque lecteur.
 */
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 82;

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Formats acceptés à l'entrée. Tout ressort en JPEG. */
const ACCEPTED_MIME = /^image\/(jpe?g|png|webp|heic|heif|gif)$/i;

function isAcceptedMimetype(mimetype) {
  return ACCEPTED_MIME.test(String(mimetype || ''));
}

/**
 * Recompresse un fichier reçu et l'écrit sur disque.
 *
 * `withoutEnlargement` : une petite image reste petite. L'agrandir ne
 * révélerait aucun détail et coûterait des octets pour du flou.
 *
 * @returns {Promise<string>} URL publique absolue à stocker dans `media_urls`.
 */
async function storeUploadedImage(buffer, userId) {
  fs.mkdirSync(TWEET_IMAGES_DIR, { recursive: true });

  const filename = `tweet-${userId}-${Date.now()}-${uuidv4().slice(0, 8)}.jpg`;
  const outputPath = path.join(TWEET_IMAGES_DIR, filename);

  await sharp(buffer)
    .rotate()
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toFile(outputPath);

  return buildStaticMediaPublicUrl('tweets', filename);
}

/**
 * Ne garde que les images émises par cette API, dans la limite du modèle.
 *
 * Le contrôle porte sur l'origine ET sur le chemin : autoriser tout le domaine
 * laisserait passer `/static/avatars/…`, donc republier l'avatar d'un tiers
 * comme sa propre image. Les entrées refusées sont écartées en silence — un
 * client officiel n'en envoie jamais, et détailler ce qui est refusé ne
 * servirait qu'à chercher la limite.
 *
 * @param {unknown} mediaUrls Ce que le client a envoyé.
 * @returns {string[]} URLs retenues, au plus `MAX_IMAGES_PER_TWEET`.
 */
function sanitizeMediaUrls(mediaUrls) {
  if (!Array.isArray(mediaUrls)) return [];

  const prefix = `${getPublicMediaOrigin().replace(/\/$/, '')}/static/tweets/`;

  return mediaUrls
    .filter((url) => typeof url === 'string')
    .map((url) => url.trim())
    .filter((url) => url.startsWith(prefix))
    // Un `..` dans le nom de fichier remonterait hors du dossier servi.
    .filter((url) => !url.slice(prefix.length).includes('/'))
    .filter((url) => !url.includes('..'))
    .slice(0, MAX_IMAGES_PER_TWEET);
}

module.exports = {
  TWEET_IMAGES_DIR,
  MAX_IMAGES_PER_TWEET,
  MAX_UPLOAD_BYTES,
  MAX_DIMENSION,
  isAcceptedMimetype,
  storeUploadedImage,
  sanitizeMediaUrls,
};
