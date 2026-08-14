/**
 * Reporte sur la Carte NF les localisations antifraude déjà en base.
 *
 *     node src/scripts/backfillNfMapFromLocations.js            # simulation
 *     node src/scripts/backfillNfMapFromLocations.js --apply    # écrit
 *
 * ── Pourquoi ce script ────────────────────────────────────────────────────
 * `recordSessionLocation` reporte désormais vers la carte, mais seulement au
 * PROCHAIN démarrage de l'app. Les localisations déjà enregistrées — celles
 * d'avant le changement — n'ont jamais été reportées. Ce script rattrape.
 *
 * ── L'heure de capture est conservée ──────────────────────────────────────
 * La présence n'expire plus : toute position reportée reste affichée jusqu'à
 * son remplacement. `shared_at` est donc recalé sur la capture RÉELLE, et pas
 * sur maintenant.
 *
 * La distinction compte : la position s'affiche dans les deux cas, mais
 * l'antidater ferait passer une localisation vieille de dix jours pour
 * fraîche. Garder la vraie date laisse à l'app la possibilité de dire depuis
 * quand elle date — sur une carte où d'autres peuvent aller chercher
 * quelqu'un, c'est la seule chose qui distingue « elle est là » de « elle y
 * était ».
 *
 * ── Le consentement ───────────────────────────────────────────────────────
 * Le mode de partage est relu par compte, et « fantôme » est ignoré. La
 * précision appliquée est celle du mode, pas celle de la donnée source.
 */

const { sequelize } = require('../models');
const nfMap = require('../services/nfMapService');

async function main() {
  const apply = process.argv.includes('--apply');

  await sequelize.authenticate();

  // La localisation la PLUS RÉCENTE de chaque compte, et elle seule.
  const rows = await sequelize.query(
    `SELECT DISTINCT ON (e.user_id)
            e.user_id, u.username, e.latitude, e.longitude, e.city, e.captured_at,
            ROUND(EXTRACT(EPOCH FROM (NOW() - e.captured_at)) / 3600)::int AS age_hours
       FROM user_location_events e
       JOIN users u ON u.id = e.user_id
      WHERE e.latitude IS NOT NULL AND e.longitude IS NOT NULL
      ORDER BY e.user_id, e.captured_at DESC`,
    { type: sequelize.QueryTypes.SELECT }
  );

  console.log(`${rows.length} compte(s) avec une localisation exploitable :\n`);

  let live = 0;
  let stale = 0;
  let skipped = 0;

  for (const row of rows) {
    const settings = await nfMap.getSettings(sequelize, row.user_id);
    if (settings.sharing_mode === 'ghost') {
      console.log(`  ${String(row.username).padEnd(16)} ignoré (mode fantôme)`);
      skipped += 1;
      continue;
    }

    // Tout devient visible : la presence n'expire plus. L'age reste affiche
    // parce qu'il change le SENS de ce qu'on publie.
    const fresh = row.age_hours < 8;
    const mark = fresh ? 'VISIBLE (recente)' : 'VISIBLE (ancienne)';
    console.log(
      `  ${String(row.username).padEnd(16)} ${String(row.city || '—').padEnd(14)} ` +
      `${String(row.age_hours).padStart(4)} h   ${mark}`
    );
    if (fresh) live += 1;
    else stale += 1;

    if (!apply) continue;

    // On passe par `updatePosition` pour bénéficier de la relecture du mode et
    // de la précision associée, puis on RECALE l'horodatage sur la capture.
    const result = await nfMap.updatePosition(sequelize, row.user_id, {
      latitude: row.latitude,
      longitude: row.longitude,
      place_label: row.city || null,
    });
    if (!result.stored) continue;

    // On recale `shared_at` sur la capture reelle : la position reste
    // affichee (elle n'expire plus), mais l'app peut dire honnetement DEPUIS
    // QUAND elle date. L'antidater a maintenant serait le seul vrai mensonge.
    await sequelize.query(
      `UPDATE nf_map_presence
          SET shared_at = :capturedAt
        WHERE user_id = :userId`,
      { replacements: { userId: row.user_id, capturedAt: row.captured_at } }
    );
  }

  console.log(
    `\n${live} visible(s) immédiatement, ${stale} écrite(s) mais déjà expirée(s), ` +
    `${skipped} ignoré(s).`
  );
  if (!apply) console.log('\n-> simulation. Relancer avec --apply pour écrire.');

  await sequelize.close();
}

main().catch((error) => {
  console.error('ECHEC :', error.message);
  process.exit(1);
});
