/**
 * Migre les médias déjà stockés sur le disque du VPS vers R2, puis réécrit
 * leurs URLs en base.
 *
 *   node scripts/migrateMediaToR2.js            # aperçu : compte, n'écrit rien
 *   node scripts/migrateMediaToR2.js --apply    # envoie, réécrit, archive, nettoie
 *
 * Ordre volontaire : tout est d'abord envoyé sur R2 ; la base n'est réécrite
 * (en une transaction) que si chaque envoi a réussi ; les fichiers locaux ne
 * sont supprimés qu'après, et une archive .tgz est gardée dans ~/media-backups.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { sequelize } = require('../src/models');
const objectStorage = require('../src/services/objectStorage');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const PUBLIC = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
const PREFIX = objectStorage.PREFIX;

const SOURCES = [
  { dir: 'storage', kind: 'videos', filter: (f) => /^(vid|thumb)_.+\.(mp4|jpg)$/i.test(f) },
  ...['avatars', 'banners', 'stories', 'messages', 'tweets', 'audio'].map((kind) => ({
    dir: `src/public/${kind}`, kind, filter: (f) => !f.startsWith('.'),
  })),
];

/** Colonnes qui contiennent des URLs de médias servis par nous. */
const COLUMNS = [
  ['users', 'avatar', 'text'], ['users', 'banner', 'text'], ['popular_users', 'avatar', 'text'],
  ['tweets', 'media_urls', 'jsonb'], ['tweets', 'audio_url', 'text'],
  ['messages', 'metadata', 'jsonb'], ['notifications', 'content', 'jsonb'],
  ['stories', 'media_url', 'text'], ['stories', 'thumbnail_url', 'text'],
  ['story_highlights', 'cover_url', 'text'], ['user_avatar_fingerprints', 'avatar_url', 'text'],
];

const STATIC_RE = `https?://[^"[:space:]]*?/static/(avatars|banners|stories|messages|tweets|audio)/([^"[:space:]?#/]+)`;
const STORAGE_RE = `https?://[^"[:space:]]*?/storage/((vid|thumb)_[^"[:space:]?#/]+)`;

async function main() {
  if (!objectStorage.enabled()) throw new Error('R2 non configuré (.env)');

  // 1. Inventaire
  const files = [];
  for (const s of SOURCES) {
    const abs = path.join(ROOT, s.dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      const full = path.join(abs, f);
      if (fs.statSync(full).isFile() && s.filter(f)) files.push({ full, kind: s.kind, name: f, rel: path.join(s.dir, f) });
    }
  }
  const bytes = files.reduce((n, f) => n + fs.statSync(f.full).size, 0);
  console.log(`${files.length} fichiers, ${(bytes / 1e6).toFixed(1)} Mo`);

  const counts = {};
  for (const [t, c] of COLUMNS) {
    const [[r]] = await sequelize.query(
      `SELECT count(*)::int n FROM "${t}" WHERE "${c}"::text ~ '/(static/(avatars|banners|stories|messages|tweets|audio)|storage)/'`);
    counts[`${t}.${c}`] = r.n;
  }
  console.log('lignes à réécrire', counts);
  if (!APPLY) return;

  // 2. Envoi (8 en parallèle)
  let done = 0;
  const failed = [];
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(files.slice(i, i + 8).map(async (f) => {
      try { await objectStorage.putFile(f.full, f.kind, f.name); done++; }
      catch (e) { failed.push(`${f.rel}: ${e.message}`); }
    }));
    process.stdout.write(`\renvoyés ${done}/${files.length}`);
  }
  console.log();
  if (failed.length) {
    console.error('Échecs, base NON modifiée :', failed.slice(0, 10));
    process.exit(1);
  }

  // 3. Réécriture des URLs, en une transaction
  const staticTo = `${PUBLIC}/${PREFIX}/\\1/\\2`;
  const storageTo = `${PUBLIC}/${PREFIX}/videos/\\1`;
  await sequelize.transaction(async (transaction) => {
    for (const [t, c, type] of COLUMNS) {
      const expr = `regexp_replace(regexp_replace("${c}"::text, :staticRe, :staticTo, 'g'), :storageRe, :storageTo, 'g')`;
      const [, meta] = await sequelize.query(
        `UPDATE "${t}" SET "${c}" = ${type === 'jsonb' ? `(${expr})::jsonb` : expr}
          WHERE "${c}"::text ~ '/(static/(avatars|banners|stories|messages|tweets|audio)|storage)/'`,
        { replacements: { staticRe: STATIC_RE, staticTo, storageRe: STORAGE_RE, storageTo }, transaction });
      console.log(`${t}.${c} : ${meta.rowCount} lignes`);
    }
  });

  // 4. Archive puis suppression des fichiers locaux
  const backups = path.join(process.env.HOME, 'media-backups');
  fs.mkdirSync(backups, { recursive: true });
  const archive = path.join(backups, `media-avant-r2-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.tgz`);
  const list = path.join(backups, 'liste.txt');
  fs.writeFileSync(list, files.map((f) => f.rel).join('\n'));
  execSync(`tar czf "${archive}" -C "${ROOT}" -T "${list}"`);
  for (const f of files) fs.unlinkSync(f.full);
  console.log(`Archive : ${archive}. Fichiers locaux supprimés : ${files.length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
