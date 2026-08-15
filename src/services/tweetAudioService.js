'use strict';

/**
 * 🎙️ Message vocal joint à un tweet (La Forge : « pouvoir ajouter un message
 * vocal dans notre tweet »).
 *
 * Même séparation que `tweetImageService` : stocker le fichier reçu d'un
 * côté, décider si une URL a le droit d'entrer dans `audio_url` de l'autre.
 * Contrairement aux images, on ne réencode pas le fichier (pas de `sharp`
 * équivalent léger pour l'audio ici) — on se contente de l'écrire tel quel,
 * après avoir vérifié son type et sa taille.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { buildStaticMediaPublicUrl, getPublicMediaOrigin } = require('../utils/publicMediaOrigin');

/** Servi par `app.use('/static', express.static(src/public))`. */
const TWEET_AUDIO_DIR = path.join(__dirname, '../public/audio');

/** Un message vocal reste bref : pas de quoi héberger un podcast. */
const MAX_DURATION_SECONDS = 120;

/** ~1 Mo/minute en AAC/M4A à débit voix : largement assez pour 2 minutes. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Formats produits par `expo-av` (`Audio.Recording`) sur iOS/Android. */
const ACCEPTED_MIME = /^audio\/(mp4|m4a|x-m4a|aac|mpeg|mp3|wav|x-wav|webm|3gpp|3gpp2)$/i;

const EXTENSION_BY_MIME = {
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/3gpp': '3gp',
  'audio/3gpp2': '3g2',
};

function isAcceptedMimetype(mimetype) {
  return ACCEPTED_MIME.test(String(mimetype || ''));
}

/**
 * Écrit le fichier reçu sur disque et renvoie son URL publique.
 *
 * @returns {Promise<string>} URL publique absolue à stocker dans `audio_url`.
 */
async function storeUploadedAudio(buffer, userId, mimetype) {
  fs.mkdirSync(TWEET_AUDIO_DIR, { recursive: true });

  const extension = EXTENSION_BY_MIME[String(mimetype || '').toLowerCase()] || 'm4a';
  const filename = `voice-${userId}-${Date.now()}-${uuidv4().slice(0, 8)}.${extension}`;
  const outputPath = path.join(TWEET_AUDIO_DIR, filename);

  await fs.promises.writeFile(outputPath, buffer);

  return buildStaticMediaPublicUrl('audio', filename);
}

/**
 * Ne garde une URL audio que si elle a été émise par cette API — même
 * raisonnement que `tweetImageService.sanitizeMediaUrls` : accepter une URL
 * arbitraire ferait charger un serveur tiers à chaque lecture du tweet.
 *
 * @param {unknown} audioUrl Ce que le client a envoyé.
 * @returns {string|null}
 */
function sanitizeAudioUrl(audioUrl) {
  if (typeof audioUrl !== 'string') return null;

  const prefix = `${getPublicMediaOrigin().replace(/\/$/, '')}/static/audio/`;
  const url = audioUrl.trim();

  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (!rest || rest.includes('/') || rest.includes('..')) return null;

  return url;
}

/**
 * Durée annoncée par le client, bornée à `MAX_DURATION_SECONDS`. `null` si
 * absente ou invalide plutôt que de faire échouer toute la publication pour
 * un simple compteur d'affichage.
 *
 * @param {unknown} duration
 * @returns {number|null}
 */
function sanitizeAudioDuration(duration) {
  const parsed = Number(duration);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.round(parsed), MAX_DURATION_SECONDS);
}

module.exports = {
  TWEET_AUDIO_DIR,
  MAX_DURATION_SECONDS,
  MAX_UPLOAD_BYTES,
  isAcceptedMimetype,
  storeUploadedAudio,
  sanitizeAudioUrl,
  sanitizeAudioDuration,
};
