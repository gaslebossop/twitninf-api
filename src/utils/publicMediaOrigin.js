/**
 * Origine publique des fichiers statiques (avatars, bannières).
 * Toujours le nom de domaine (HTTPS) — jamais l’IP en URL stockée ou renvoyée.
 */

const path = require('path');

const DEFAULT_PUBLIC_MEDIA_ORIGIN = 'https://twitninf.duckdns.org';

/** Origine canonique sans slash final */
function getPublicMediaOrigin() {
  const explicit = (
    process.env.PUBLIC_MEDIA_ORIGIN ||
    process.env.PUBLIC_BASE_URL
  )
    ?.trim()
    .replace(/\/$/, '');
  if (explicit) return explicit;
  return DEFAULT_PUBLIC_MEDIA_ORIGIN;
}

/**
 * Origine pour enregistrer une URL en base à l’upload.
 * Ignore Host / IP de la requête — toujours le domaine public (env ou défaut).
 */
function getPublicMediaOriginForUpload() {
  return getPublicMediaOrigin();
}

/**
 * URL absolue à persister en DB après upload fichier.
 * @param {'avatars'|'banners'|'stories'|'messages'} kind
 * @param {string} filename
 */
function buildStaticMediaPublicUrl(kind, filename) {
  const origin = getPublicMediaOriginForUpload().replace(/\/$/, '');
  const safeName = path.basename(String(filename || ''));
  return `${origin}/static/${kind}/${safeName}`;
}

function resolvePublicMediaOrigin(_req) {
  return getPublicMediaOriginForUpload();
}

const STATIC_MEDIA_PATH = /(\/static\/(?:avatars|banners|stories|messages)\/[^\s?#]+)/i;

/**
 * Normalise une URL de média vers le domaine public (remplace les URLs en IP).
 */
function rewriteMediaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.startsWith('http')) return url;

  const pathMatch = url.match(STATIC_MEDIA_PATH);
  if (!pathMatch) return url;

  return `${getPublicMediaOrigin()}${pathMatch[1]}`;
}

function applyMediaUrlRewriteToPlainObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(applyMediaUrlRewriteToPlainObject);
  }
  const out = { ...obj };
  if (typeof out.avatar === 'string') out.avatar = rewriteMediaUrl(out.avatar);
  if (typeof out.banner === 'string') out.banner = rewriteMediaUrl(out.banner);
  if (Array.isArray(out.media_urls)) {
    out.media_urls = out.media_urls.map((u) => rewriteMediaUrl(u));
  }
  if (out.author && typeof out.author === 'object') {
    out.author = applyMediaUrlRewriteToPlainObject(out.author);
  }
  return out;
}

module.exports = {
  getPublicMediaOrigin,
  getPublicMediaOriginForUpload,
  buildStaticMediaPublicUrl,
  resolvePublicMediaOrigin,
  rewriteMediaUrl,
  applyMediaUrlRewriteToPlainObject,
  DEFAULT_PUBLIC_MEDIA_ORIGIN
};
