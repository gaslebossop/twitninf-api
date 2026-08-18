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
 * ── Pourquoi l'aiguillage se fait sur les OCTETS, et surtout pas sur un essai
 *    de `sharp` ──────────────────────────────────────────────────────────────
 * Première version de ce module : « essayer `sharp(buffer).metadata()`, et ne
 * convertir que si ça échoue ». **Ça ne marche pas**, et le piège mérite d'être
 * écrit noir sur blanc parce qu'il est contre-intuitif :
 *
 *   `sharp.format.heif.input` vaut `true`, et `metadata()` RÉUSSIT sur un HEIC
 *   — libvips sait parfaitement lire le CONTENEUR HEIF (dimensions, EXIF…).
 *   Ce qu'il ne sait pas faire, c'est décoder les PIXELS, parce que le codec
 *   interne est HEVC. L'échec n'arrive donc qu'au `toFile()`/`toBuffer()`.
 *
 * Une sonde par `metadata()` répond « sharp sait lire » et laisse passer le
 * fichier tel quel : la panne reste entière. Sonder par un vrai décodage
 * coûterait un décodage complet en pure perte sur chaque image.
 *
 * Le client, lui, déclare `image/jpeg` pour TOUT ce qu'il envoie, y compris un
 * HEIC : le type MIME déclaré ne dit rien du contenu. Restent les octets, qui
 * ne mentent pas — c'est le seul critère fiable des trois.
 *
 * Un JPEG, un PNG ou un AVIF (marque `avif`, que libvips décode) ne sont pas
 * reconnus ici et repartent intacts, sans aucun coût.
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
 * client. Tout ce qui n'est pas un HEIF repart tel quel, à l'octet près.
 *
 * Ne juge jamais de la validité d'un fichier : en cas d'échec de conversion,
 * rend le tampon d'origine pour que l'appelant échoue sur SA propre erreur
 * `sharp`. Un fichier corrompu doit continuer à échouer, et le message d'erreur
 * doit rester celui de l'outil qui traite l'image, pas celui d'un convertisseur
 * intercalé.
 *
 * @param {Buffer} buffer Fichier reçu du client.
 * @returns {Promise<Buffer>} Un tampon que `sharp` sait décoder.
 */
async function toDecodableBuffer(buffer) {
  if (!looksLikeHeif(buffer)) return buffer;

  try {
    const converted = await heifToJpeg(buffer);
    logger.info(
      `Image HEIF convertie en JPEG (${buffer.length} → ${converted.length} octets)`
    );
    return converted;
  } catch (convertError) {
    logger.error('Conversion HEIF impossible:', convertError);
    return buffer;
  }
}

module.exports = {
  toDecodableBuffer,
  looksLikeHeif,
};
