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
 * ── Pourquoi l'heure de capture est conservée ─────────────────────────────
 * C'est le point important, et le seul choix discutable de ce script.
 *
 * La présence sur la carte dure 8 heures : c'est une PRÉSENCE, pas une
 * dernière adresse connue. Reporter une localisation vieille de dix jours avec
 * l'horodatage du jour la ferait passer pour actuelle — on afficherait
 * quelqu'un à un endroit qu'il a quitté depuis longtemps, sur une carte où
 * d'autres personnes peuvent aller le chercher.
 *
 * `shared_at` et `expires_at` sont donc calculés depuis `captured_at`. En
 * pratique, seules les localisations de moins de 8 heures deviennent visibles ;
 * les autres sont écrites mais déjà expirées, et réapparaîtront d'elles-mêmes
 * à la prochaine ouverture de l'app par leur propriétaire.
 *
 * Si l'on voulait qu'une localisation ancienne reste affichée, le bon levier
 * serait d'allonger `PRESENCE_TTL_HOURS` — décision de produit — et non de
 * mentir sur la date.
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

    const fresh = row.age_hours < 8;
    const mark = fresh ? 'VISIBLE' : 'expirée';
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

    await sequelize.query(
      `UPDATE nf_map_presence
          SET shared_at = :capturedAt,
              expires_at = :capturedAt::timestamptz + INTERVAL '8 hours'
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
