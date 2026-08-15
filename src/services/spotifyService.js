/**
 * 🎵 Recherche de morceaux Spotify, pour les attacher à un tweet.
 *
 * ── Pourquoi passer par le serveur plutôt que par le client ──
 * L'authentification "Client Credentials" de Spotify n'authentifie pas un
 * utilisateur, elle authentifie CETTE API (`SPOTIFY_CLIENT_ID` /
 * `SPOTIFY_CLIENT_SECRET`, jamais envoyés au client). Le token applicatif est
 * mis en cache en mémoire jusqu'à son expiration, pour ne pas refaire un
 * aller-retour d'auth à chaque recherche.
 *
 * ── Pourquoi ce n'est pas une vraie connexion de compte Spotify ──
 * Une connexion par compte (OAuth Authorization Code) demanderait une
 * application Spotify enregistrée avec une URI de redirection approuvée —
 * indisponible dans cet environnement. Cette recherche applicative couvre le
 * besoin principal de la proposition (« mettre de la musique dans les
 * tweets ») sans dépendre de ces identifiants ; la connexion par compte
 * pourra suivre dans une itération séparée une fois l'app Spotify créée.
 */

const axios = require('axios');
const logger = require('../utils/logger');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';
/**
 * Spotify a retiré `preview_url` de sa réponse de recherche pour la quasi
 * totalité des morceaux (retrait du 27/11/2024, jamais réintroduit malgré
 * les demandes de la communauté). L'API iTunes, elle, fournit encore
 * gratuitement un extrait de 30s sans clé — on l'utilise en repli, matché
 * par titre + artiste, uniquement quand Spotify n'a rien fourni.
 */
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';

/** Marge de sécurité avant l'expiration réelle du token, pour ne jamais l'utiliser périmé. */
const TOKEN_EXPIRY_MARGIN_MS = 30 * 1000;

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function isConfigured() {
  return !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

async function getAppAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  if (!isConfigured()) {
    throw new Error('SPOTIFY_NOT_CONFIGURED');
  }

  const basicAuth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  const response = await axios.post(
    TOKEN_URL,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 8000,
    }
  );

  cachedToken = response.data.access_token;
  cachedTokenExpiresAt = Date.now() + response.data.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS;
  return cachedToken;
}

/**
 * Normalise un item de l'API Spotify (`GET /v1/search`) vers la seule forme
 * que ce backend accepte de stocker sur un tweet — voir `sanitizeSpotifyTrack`,
 * qui revalide cette même forme côté écriture.
 */
function mapSpotifyTrack(item) {
  if (!item || typeof item !== 'object') return null;

  const album = item.album || {};
  const images = Array.isArray(album.images) ? album.images : [];
  // Spotify trie ses images du plus grand au plus petit — la plus petite
  // reste largement suffisante pour une vignette de carte de tweet.
  const albumArt = images.length > 0 ? images[images.length - 1].url : null;
  const artistName = Array.isArray(item.artists) && item.artists.length > 0
    ? item.artists.map((a) => a.name).filter(Boolean).join(', ')
    : null;

  return {
    id: item.id,
    name: item.name,
    artist: artistName,
    albumName: album.name || null,
    albumArt,
    previewUrl: item.preview_url || null,
    externalUrl: item.external_urls?.spotify || null,
    durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : null,
  };
}

/**
 * Cherche un extrait 30s sur iTunes pour un morceau que Spotify n'en fournit
 * plus. Best-effort : toute erreur ou absence de résultat renvoie `null`
 * plutôt que de faire échouer la recherche Spotify qui l'appelle.
 */
async function fetchItunesPreviewUrl(name, artist) {
  try {
    const term = artist ? `${name} ${artist}` : name;
    const response = await axios.get(ITUNES_SEARCH_URL, {
      params: { term, media: 'music', entity: 'song', limit: 1 },
      timeout: 4000,
    });
    const result = response.data?.results?.[0];
    return typeof result?.previewUrl === 'string' ? result.previewUrl : null;
  } catch (e) {
    logger.warn('[spotifyService] fetchItunesPreviewUrl:', e.message);
    return null;
  }
}

async function searchTracks(query, { limit = 8 } = {}) {
  const token = await getAppAccessToken();
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 8, 10));

  const response = await axios.get(SEARCH_URL, {
    headers: { Authorization: `Bearer ${token}` },
    params: { q: query, type: 'track', limit: cappedLimit },
    timeout: 8000,
  });

  const items = response.data?.tracks?.items || [];
  const tracks = items.map(mapSpotifyTrack).filter((track) => track && track.id && track.externalUrl);

  await Promise.all(
    tracks.map(async (track) => {
      if (track.previewUrl) return;
      track.previewUrl = await fetchItunesPreviewUrl(track.name, track.artist);
    })
  );

  return tracks;
}

/**
 * Revalide un morceau envoyé par le client avant de l'attacher à un tweet
 * (`POST /api/tweets`). Même logique de prudence que
 * `tweetImageService.sanitizeMediaUrls` pour `media_urls` : on ne stocke que
 * des URLs venant réellement des domaines Spotify attendus, jamais une URL
 * arbitraire fournie par le client — sinon le fil chargerait une ressource
 * tierce arbitraire à chaque affichage du tweet.
 */
function sanitizeSpotifyTrack(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const { id, name, artist } = payload;
  if (typeof id !== 'string' || !id.trim()) return null;
  if (typeof name !== 'string' || !name.trim()) return null;

  const externalUrl = typeof payload.externalUrl === 'string' ? payload.externalUrl : null;
  if (!externalUrl || !/^https:\/\/open\.spotify\.com\//.test(externalUrl)) return null;

  const albumArt = typeof payload.albumArt === 'string' && /^https:\/\/i\.scdn\.co\//.test(payload.albumArt)
    ? payload.albumArt
    : null;
  const previewUrl = typeof payload.previewUrl === 'string'
    && /^https:\/\/(p\.scdn\.co|audio-ssl\.itunes\.apple\.com)\//.test(payload.previewUrl)
    ? payload.previewUrl
    : null;

  return {
    id: id.trim(),
    name: name.trim(),
    artist: typeof artist === 'string' && artist.trim() ? artist.trim() : null,
    albumName: typeof payload.albumName === 'string' ? payload.albumName.trim() || null : null,
    albumArt,
    previewUrl,
    externalUrl,
    durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : null,
  };
}

module.exports = {
  isConfigured,
  getAppAccessToken,
  searchTracks,
  mapSpotifyTrack,
  sanitizeSpotifyTrack,
};
