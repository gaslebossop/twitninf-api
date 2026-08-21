/**
 * Migration ponctuelle : table tweet_human_labels (annotation manuelle par un
 * admin, indépendante de tweet_human_labels — ne touche jamais celle-là, qui
 * alimente déjà D9 du recommender via annotator-worker.js).
 *
 * Usage : node migrate-tweet-human-labels.js
 */
const { Pool } = require('pg');
const config = require('./src/config/config');
const { THEMES, VIOLATION_RULES } = require('./src/constants/tweetAnnotatorConstants');

const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.username,
  password: config.database.password,
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 Migration tweet_human_labels...');

    const themeList = THEMES.map((t) => `'${t.id}'`).join(', ');
    const ruleList = VIOLATION_RULES.map((r) => `'${r.id}'`).join(', ');

    await client.query(`
      CREATE TABLE IF NOT EXISTS tweet_human_labels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tweet_id UUID NOT NULL UNIQUE REFERENCES tweets(id) ON DELETE CASCADE,
        content_snapshot TEXT NOT NULL,
        spam_score SMALLINT,
        quality_score SMALLINT,
        theme VARCHAR(40),
        sentiment VARCHAR(10),
        compliant BOOLEAN,
        violation_rule VARCHAR(40),
        insult_spans JSONB NOT NULL DEFAULT '[]',
        annotator_id UUID REFERENCES users(id),
        skipped BOOLEAN NOT NULL DEFAULT false,
        annotated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_theme CHECK (theme IS NULL OR theme IN (${themeList})),
        CONSTRAINT chk_sentiment CHECK (sentiment IS NULL OR sentiment IN ('positif', 'negatif')),
        CONSTRAINT chk_violation_rule CHECK (violation_rule IS NULL OR violation_rule IN (${ruleList})),
        CONSTRAINT chk_spam_score CHECK (spam_score IS NULL OR spam_score BETWEEN 1 AND 10),
        CONSTRAINT chk_quality_score CHECK (quality_score IS NULL OR quality_score BETWEEN 1 AND 10),
        CONSTRAINT chk_compliance CHECK (
          compliant IS NULL
          OR (compliant = true AND violation_rule IS NULL)
          OR (compliant = false AND violation_rule IS NOT NULL)
        ),
        CONSTRAINT chk_complete CHECK (
          skipped = true OR (
            spam_score IS NOT NULL AND quality_score IS NOT NULL AND theme IS NOT NULL
            AND sentiment IS NOT NULL AND compliant IS NOT NULL
          )
        )
      )
    `);

    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_tweet_human_labels_tweet_id ON tweet_human_labels(tweet_id)',
    );

    console.log('✅ Table tweet_human_labels prête.');
  } catch (error) {
    console.error('❌ Migration échouée:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
