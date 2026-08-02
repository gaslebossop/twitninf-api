#!/usr/bin/env node
/**
 * Reprise de `community_review_items.report_count`.
 *
 * Ce compteur ordonne la file de la revue (`nextItemFor` trie dessus). Il
 * comptait jusqu'ici les MOTIFS affichés, signalements humains et détections
 * automatiques confondus : un tweet repéré tout seul par l'IA sur trois
 * critères affichait « 3 » et passait devant un tweet réellement signalé par
 * quelqu'un, qui affichait « 1 ». Exactement l'inverse de l'ordre voulu.
 *
 * Depuis le changement, `createItemForTweet` n'y met plus que le nombre de
 * signalements HUMAINS. Les lignes créées avant gardent l'ancien décompte —
 * d'où ce script, qui recalcule les items encore ouverts.
 *
 * Idempotent : le relancer ne change rien de plus.
 *
 * Usage (sur le VPS, depuis /home/debian/api) :
 *   node scripts/backfillReviewReportCount.js --dry-run   # montre, ne touche à rien
 *   node scripts/backfillReviewReportCount.js             # applique
 */

const path = require('path');
const { Client } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

function envFromApi() {
  const fs = require('fs');
  const p = path.join(__dirname, '..', '.env');
  const out = {};
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

const env = envFromApi();
const db = new Client({
  host: env.DB_HOST || 'localhost',
  port: +(env.DB_PORT || 5432),
  database: env.DB_NAME || 'twitninf',
  user: env.DB_USER || 'admin',
  password: env.DB_PASSWORD,
});

/**
 * Nombre de signalements humains encore ouverts par item ouvert, à côté du
 * compteur actuellement stocké. Seuls les items OUVERTS comptent : réécrire
 * l'historique des items déjà clos ne changerait aucun tri et effacerait ce
 * qui était affiché au moment du vote.
 */
const QUERY = `
  SELECT i.id,
         i.report_count AS stored,
         COUNT(r.id)::int AS human
  FROM community_review_items i
  LEFT JOIN reports r
    ON r.target_type = 'tweet'
   AND r.target_id = i.tweet_id
   AND r.status IN ('pending', 'investigating')
  WHERE i.status = 'open'
  GROUP BY i.id, i.report_count
  HAVING i.report_count IS DISTINCT FROM COUNT(r.id)::int
  ORDER BY COUNT(r.id)::int DESC
`;

(async () => {
  await db.connect();

  const { rows } = await db.query(QUERY);

  if (rows.length === 0) {
    console.log('Rien à corriger : tous les items ouverts sont déjà à jour.');
    await db.end();
    return;
  }

  console.log(`${rows.length} item(s) ouvert(s) à recalculer :\n`);
  for (const r of rows.slice(0, 20)) {
    console.log(`  ${r.id}  ${String(r.stored).padStart(2)} → ${String(r.human).padStart(2)}`
      + (r.human === 0 ? '   (aucun signalement humain — détection automatique seule)' : ''));
  }
  if (rows.length > 20) console.log(`  … et ${rows.length - 20} autre(s)`);

  if (DRY_RUN) {
    console.log('\n--dry-run : rien n\'a été écrit.');
    await db.end();
    return;
  }

  // Un seul UPDATE plutôt qu'une boucle : la file est lue en continu par la
  // revue, autant que le nouvel ordre apparaisse d'un coup.
  const applied = await db.query(`
    UPDATE community_review_items i
    SET report_count = sub.human, updated_at = now()
    FROM (${QUERY}) sub
    WHERE i.id = sub.id
  `);

  console.log(`\n${applied.rowCount} item(s) mis à jour.`);
  await db.end();
})().catch(async (e) => {
  console.error('ERREUR', e.message);
  try { await db.end(); } catch { /* déjà fermée */ }
  process.exit(1);
});
