/**
 * Pose explicitement le mode « ville » aux comptes qui n'ont aucun réglage.
 *
 *     node src/scripts/backfillNfMapDefault.js            # compte, sans écrire
 *     node src/scripts/backfillNfMapDefault.js --apply    # écrit
 *
 * ── Pourquoi ce script ────────────────────────────────────────────────────
 * Le mode par défaut est passé de « fantôme » à « ville ». Ce défaut suffit au
 * fonctionnement — `getSettings` le renvoie pour un compte sans ligne — mais il
 * laisse l'état implicite : rien en base ne dit ce qu'il en est, et il faut
 * lire le code pour le savoir. Ce script matérialise le choix.
 *
 * ── Ce qu'il ne fait PAS ──────────────────────────────────────────────────
 * Il n'écrit AUCUNE coordonnée. Les lignes créées ont `latitude`, `longitude`
 * et `expires_at` à NULL : personne n'apparaît sur la carte du seul fait de ce
 * script. Un compte ne devient visible qu'à sa prochaine position transmise,
 * et à la précision d'une grille de quartier.
 *
 * ── Ce qu'il ne touche pas ────────────────────────────────────────────────
 * Les comptes qui ont DÉJÀ une ligne, quelle qu'elle soit. Au moment de
 * l'écriture, 37 comptes sont en « précis » et 11 en « ville » — tous par
 * choix. Aucun n'est en « fantôme » : personne n'a jamais demandé à être
 * invisible, ce qui est précisément ce qui rend ce changement de défaut
 * défendable.
 */

const { sequelize } = require('../models');

async function main() {
  const apply = process.argv.includes('--apply');

  await sequelize.authenticate();

  const [{ count: missing }] = await sequelize.query(
    `SELECT COUNT(*)::int AS count
       FROM users u
       LEFT JOIN nf_map_presence p ON p.user_id = u.id
      WHERE p.user_id IS NULL`,
    { type: sequelize.QueryTypes.SELECT }
  );

  const existing = await sequelize.query(
    `SELECT sharing_mode, COUNT(*)::int AS count
       FROM nf_map_presence GROUP BY 1 ORDER BY 2 DESC`,
    { type: sequelize.QueryTypes.SELECT }
  );

  console.log('Réglages existants (inchangés) :');
  if (existing.length === 0) console.log('  aucun');
  existing.forEach((r) => console.log(`  ${String(r.sharing_mode).padEnd(8)} ${r.count}`));
  console.log(`\nComptes sans aucun réglage      : ${missing}`);

  if (!apply) {
    console.log('\n-> simulation. Relancer avec --apply pour créer les lignes « ville ».');
    await sequelize.close();
    return;
  }

  // `ON CONFLICT DO NOTHING` plutôt qu'un WHERE NOT EXISTS : la garantie vient
  // alors de la contrainte d'unicité, et non d'une lecture qui pourrait être
  // périmée entre le SELECT et l'INSERT. Le script est donc rejouable sans
  // risque d'écraser un choix fait entre-temps.
  const [, meta] = await sequelize.query(
    `INSERT INTO nf_map_presence (user_id, sharing_mode, audience, created_at, updated_at)
     SELECT u.id, 'city', 'connections', NOW(), NOW()
       FROM users u
       LEFT JOIN nf_map_presence p ON p.user_id = u.id
      WHERE p.user_id IS NULL
     ON CONFLICT (user_id) DO NOTHING`
  );

  const written = typeof meta === 'number' ? meta : meta?.rowCount ?? missing;
  console.log(`\nOK : ${written} compte(s) passé(s) en « ville », sans aucune coordonnée.`);
  console.log('     Ils apparaîtront à leur prochaine position transmise, au quartier près.');

  await sequelize.close();
}

main().catch((error) => {
  console.error('ECHEC :', error.message);
  process.exit(1);
});
