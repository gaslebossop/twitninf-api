/**
 * Stockage des médias sur Cloudflare R2.
 *
 * ── Pourquoi ──
 * Tout partait sur le disque du VPS A (`storage/`, `src/public/*`) : un seul
 * nœud pouvait servir les médias, la place disque fixait la limite, et une
 * reconstruction du VPS emportait les fichiers des utilisateurs. R2 sert les
 * fichiers depuis le CDN Cloudflare, indépendamment des VPS.
 *
 * ── Où ──
 * Même compte et même bucket que Trame (clé reprise de son `.env`), sous le
 * préfixe `R2_PREFIX` (`twitninf/` par défaut) : `twitninf/<kind>/<fichier>`.
 * Servi publiquement par `R2_PUBLIC_URL` (https://media.twitninf.fr).
 *
 * ── Si R2 est indisponible ──
 * L'envoi ne doit jamais échouer pour autant : le fichier reste sur le disque
 * et l'URL locale (`/static/...` ou `/storage/...`) est rendue, comme avant.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { buildStaticMediaPublicUrl, getPublicMediaOrigin } = require('../utils/publicMediaOrigin');

const PREFIX = (process.env.R2_PREFIX || 'twitninf').replace(/^\/+|\/+$/g, '');
const PUBLIC = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'video/webm',
};

let client = null;
function getClient() {
  if (client) return client;
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !PUBLIC) return null;
  const { S3Client } = require('@aws-sdk/client-s3');
  client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return client;
}

const enabled = () => !!getClient();
const keyFor = (kind, filename) => `${PREFIX}/${kind}/${path.basename(String(filename))}`;
const publicUrlFor = (kind, filename) => `${PUBLIC}/${keyFor(kind, filename)}`;

/** Préfixe public d'un type de média sur R2 (pour valider les URLs reçues). */
const publicPrefix = (kind) => (PUBLIC ? `${PUBLIC}/${PREFIX}/${kind}/` : null);

async function putFile(localPath, kind, filename, contentType) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const body = await fs.promises.readFile(localPath);
  await getClient().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: keyFor(kind, filename),
    Body: body,
    ContentType: contentType || MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream',
    // Noms uniques (uuid/horodatage) : un fichier ne change jamais une fois publié.
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

/**
 * Publie un fichier déjà écrit sur le disque et rend son URL publique.
 * Sur R2 : le fichier local est supprimé. Sinon : il reste, URL locale.
 *
 * @param {string} localPath
 * @param {'avatars'|'banners'|'stories'|'messages'|'tweets'|'audio'|'videos'} kind
 * @param {string} filename
 * @param {{localUrl?: string, contentType?: string}} [options]
 */
async function publish(localPath, kind, filename, { localUrl, contentType } = {}) {
  const fallback = localUrl || buildStaticMediaPublicUrl(kind, filename);
  if (!enabled()) return fallback;
  try {
    await putFile(localPath, kind, filename, contentType);
    fs.promises.unlink(localPath).catch(() => {});
    return publicUrlFor(kind, filename);
  } catch (error) {
    logger.error(`[R2] envoi de ${kind}/${filename} impossible, fichier gardé sur le disque: ${error.message}`);
    return fallback;
  }
}

/** URL locale d'un fichier vidéo de `storage/` (repli quand R2 est absent). */
const storageUrl = (filename) => `${getPublicMediaOrigin()}/storage/${path.basename(filename)}`;

module.exports = { enabled, publish, putFile, keyFor, publicUrlFor, publicPrefix, storageUrl, PREFIX };
