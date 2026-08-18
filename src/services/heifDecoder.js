const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');

const logger = require('../utils/logger');

const execFileAsync = promisify(execFile);

/**
 * Rend décodable par `sharp` une image que `sharp` refuse de lire.
 *
 * ── Le problème ────────────────────────────────────────────────────────────
 * Un iPhone photographie en HEIC, dont le codec interne est HEVC. `sharp`
 * embarque son PROPRE libvips (`node_modules/sharp/vendor/8.14.5`), compilé
 * sans décodeur HEVC — c'est un choix de licence en amont, pas un défaut
 * d'installation. Résultat observé en production :
 *
 *     Erreur publication story: source: bad seek to 2470260
 *     heif: Unsupported feature: Unsupported codec (4.3000)
 *
 * Le message est trompeur : « bad seek » laisse croire à un fichier tronqué ou
 * à un problème de réseau, alors que le fichier est intact et que c'est le
 * codec qui n'est pas lisible. Tous les envois d'images depuis un iPhone
 * échouaient, en story comme en tweet.
 *
 * ── Pourquoi `heif-convert` et pas une bibliothèque npm ────────────────────
 * La machine possède déjà libheif 1.19.8 AVEC le greffon `libde265`, donc le
 * décodeur HEVC est présent — simplement hors d'atteinte de libvips embarqué.
 * `heif-convert` (paquet `libheif-examples`) s'appuie dessus. Ajouter un
 * décodeur JavaScript aurait dupliqué un décodeur déjà installé, en plus lent.
 *
 * ── Pourquoi une reprise sur échec et pas un aiguillage sur le type MIME ───
 * Le client déclare `image/jpeg` pour TOUT ce qu'il envoie, y compris un HEIC :
 * le type déclaré ne dit donc rien du contenu réel. On se fie aux octets, et on
 * ne convertit que ce que `sharp` a réellement refusé — un JPEG ou un PNG
 * normal ne paie aucun coût.
 */

/** Un HEIF non converti ne doit pas bloquer la requête indéfiniment. */
const CONVERT_TIMEOUT_MS = 20_000;

/**
 * Marques ISO-BMFF des variantes HEIF. `mif1`/`msf1` sont les marques
 * génériques que posent certains appareils au lieu de `heic`.
 */
const HEIF_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis',
  'hevc', 'hevx', 'hevm', 'hevs',
  'mif1', 'msf1',
]);

/**
 * Reconnaît un conteneur HEIF à ses octets, jamais à son nom ni à son type
 * déclaré. Structure ISO-BMFF : taille de boîte sur 4 octets, puis `ftyp`,
 * puis la marque principale.
 */
function looksLikeHeif(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  return HEIF_BRANDS.has(buffer.toString('ascii', 8, 12).toLowerCase());
}

/**
 * Convertit un HEIF en JPEG via `heif-convert`.
 *
 * Passe par des fichiers temporaires : `heif-convert` lit et écrit des chemins,
 * pas des flux. Le nettoyage est dans un `finally` pour ne rien laisser derrière
 * même en cas d'échec de la conversion.
 */
async function heifToJpeg(buffer) {
  const base = path.join(os.tmpdir(), `heif-${Date.now()}-${uuidv4().slice(0, 8)}`);
  const inputPath = `${base}.heic`;
  const outputPath = `${base}.jpg`;

  try {
    await fs.promises.writeFile(inputPath, buffer);
    await execFileAsync('heif-convert', ['-q', '92', inputPath, outputPath], {
      timeout: CONVERT_TIMEOUT_MS,
    });
    return await fs.promises.readFile(outputPath);
  } finally {
    await Promise.allSettled([
      fs.promises.unlink(inputPath),
      fs.promises.unlink(outputPath),
    ]);
  }
}

/**
 * Rend un tampon lisible par `sharp`, en le convertissant si nécessaire.
 *
 * Toujours appeler ceci AVANT `sharp(buffer)` sur un fichier venant d'un
 * client. Rend le tampon d'origine quand `sharp` sait déjà le lire — c'est le
 * cas courant, et il ne coûte alors qu'une lecture d'en-tête.
 *
 * Ne masque JAMAIS une vraie erreur : si le fichier n'est pas un HEIF, ou si la
 * conversion échoue elle aussi, l'erreur d'origine de `sharp` est relancée
 * telle quelle. Un fichier corrompu doit continuer à échouer.
 *
 * @param {Buffer} buffer Fichier reçu du client.
 * @returns {Promise<Buffer>} Un tampon que `sharp` sait décoder.
 */
async function toDecodableBuffer(buffer) {
  const sharp = require('sharp');

  try {
    // Lit uniquement l'en-tête : ne décode pas l'image entière.
    await sharp(buffer).metadata();
    return buffer;
  } catch (sharpError) {
    if (!looksLikeHeif(buffer)) throw sharpError;

    try {
      const converted = await heifToJpeg(buffer);
      logger.info(
        `Image HEIF convertie en JPEG (${buffer.length} → ${converted.length} octets)`
      );
      return converted;
    } catch (convertError) {
      logger.error('Conversion HEIF impossible:', convertError);
      throw sharpError;
    }
  }
}

module.exports = {
  toDecodableBuffer,
  looksLikeHeif,
};
