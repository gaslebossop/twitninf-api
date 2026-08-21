/**
 * Insertion en masse dans tweet_human_labels, hors de la page /tools/annotator
 * (utilisé pour les lots annotés par Claude — voir la colonne `source`).
 *
 * Lit un tableau JSON sur stdin :
 *   [{ tweetId, spamScore, qualityScore, theme, sentiment, compliant,
 *      violationRule?, insultSpans? }, ...]
 *
 * Usage : cat batch.json | node scripts/bulkAnnotateTweets.js claude
 *         (le premier argument devient la colonne `source`, défaut 'claude')
 */
'use strict';

const { sequelize } = require('../src/models');
const { THEMES, VIOLATION_RULES } = require('../src/constants/tweetAnnotatorConstants');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(entry) {
  const {
    tweetId, spamScore, qualityScore, theme, sentiment, compliant, violationRule, insultSpans,
  } = entry;
  if (typeof tweetId !== 'string' || !UUID_RE.test(tweetId)) return 'tweetId invalide';
  if (!Number.isInteger(spamScore) || spamScore < 1 || spamScore > 10) return 'spamScore invalide';
  if (!Number.isInteger(qualityScore) || qualityScore < 1 || qualityScore > 10) return 'qualityScore invalide';
  if (!THEMES.some((t) => t.id === theme)) return 'theme invalide';
  if (sentiment !== 'positif' && sentiment !== 'negatif') return 'sentiment invalide';
  if (typeof compliant !== 'boolean') return 'compliant invalide';
  if (!compliant && !VIOLATION_RULES.some((r) => r.id === violationRule)) return 'violationRule requis';
  if (insultSpans !== undefined && !Array.isArray(insultSpans)) return 'insultSpans invalide';
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const source = process.argv[2] || 'claude';
  const raw = await readStdin();
  const batch = JSON.parse(raw);

  if (!Array.isArray(batch) || !batch.length) {
    console.error('Aucune entrée à insérer.');
    process.exit(1);
  }

  let ok = 0;
  for (const entry of batch) {
    const error = validate(entry);
    if (error) {
      console.error(`❌ ${entry.tweetId || '?'} : ${error}`);
      continue;
    }

    const rows = await sequelize.query('SELECT content FROM tweets WHERE id = :tweetId', {
      replacements: { tweetId: entry.tweetId },
      type: sequelize.QueryTypes.SELECT,
    });
    if (!rows.length) {
      console.error(`❌ ${entry.tweetId} : tweet introuvable`);
      continue;
    }

    await sequelize.query(
      `INSERT INTO tweet_human_labels
        (tweet_id, content_snapshot, spam_score, quality_score, theme, sentiment,
         compliant, violation_rule, insult_spans, source, skipped, annotated_at)
       VALUES (:tweetId, :content, :spamScore, :qualityScore, :theme, :sentiment,
               :compliant, :violationRule, :insultSpans, :source, false, now())
       ON CONFLICT (tweet_id) DO UPDATE SET
         content_snapshot = EXCLUDED.content_snapshot,
         spam_score = EXCLUDED.spam_score,
         quality_score = EXCLUDED.quality_score,
         theme = EXCLUDED.theme,
         sentiment = EXCLUDED.sentiment,
         compliant = EXCLUDED.compliant,
         violation_rule = EXCLUDED.violation_rule,
         insult_spans = EXCLUDED.insult_spans,
         source = EXCLUDED.source,
         skipped = false,
         annotated_at = now()`,
      {
        replacements: {
          tweetId: entry.tweetId,
          content: rows[0].content,
          spamScore: entry.spamScore,
          qualityScore: entry.qualityScore,
          theme: entry.theme,
          sentiment: entry.sentiment,
          compliant: entry.compliant,
          violationRule: entry.compliant ? null : entry.violationRule,
          insultSpans: JSON.stringify(entry.insultSpans || []),
          source,
        },
      },
    );
    ok += 1;
  }

  console.log(`✅ ${ok}/${batch.length} annotations insérées (source=${source}).`);
  await sequelize.close();
}

main().catch((err) => {
  console.error('Échec insertion en masse:', err);
  process.exit(1);
});
