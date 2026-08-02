#!/usr/bin/env node
/**
 * Worker d'annotation LLM des tweets.
 *
 * Annote chaque nouveau tweet via codex et écrit le résultat dans
 * `tweet_llm_labels`, qui alimente la dimension D9 du recommender et la file
 * `llm_moderation_queue`.
 *
 * Volontairement HORS du chemin de publication : le tweet est publié
 * immédiatement par l'API, ce worker le rattrape ensuite. Une panne ou une
 * lenteur de l'API codex ralentit l'annotation, jamais la publication — et D9
 * traite un tweet non annoté comme neutre, donc le feed reste correct pendant
 * ce temps.
 *
 * Le rattrapage par sondage (plutôt qu'un déclencheur) couvre aussi les tweets
 * publiés pendant un arrêt du worker : au redémarrage il reprend le retard tout
 * seul.
 */
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const POLL_MS = Number(process.env.ANNOTATOR_POLL_MS || 20000);
const BATCH = Number(process.env.ANNOTATOR_BATCH || 20);
const MODEL = process.env.ANNOTATOR_MODEL || 'gpt-5.4-mini';
const CODEX = process.env.CODEX_BIN || 'codex';
const MODEL_TAG = `codex:${MODEL}`;
/** Au-delà, on arrête de réessayer un tweet : il bloquerait la file. */
const MAX_ATTEMPTS = 3;

const SCHEMA_PATH = path.join(__dirname, 'annotator-schema.json');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'twitninf',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD,
  max: 2,
});

/** Compteur d'échecs par tweet, en mémoire : un redémarrage relance les essais. */
const attempts = new Map();

const CONSIGNE = `Tu es un annotateur de contenu pour un reseau social francophone (TwitNinf).
Le corpus est en francais familier, avec de l'argot, des emojis et du verlan.

Annote CHAQUE tweet de la liste ci-dessous. Regles importantes :

- Le registre familier, l'argot ou le tutoiement ne sont PAS de la toxicite.
  "frro", "reuf", "wsh", "mdr" sont neutres. Ne penalise que l'intention de nuire.
- \`toxicity_score\` mesure l'agression envers une personne ou un groupe, pas la
  grossierete decorative. Une insulte directe visant quelqu'un est grave ;
  un juron d'exasperation sans cible ne l'est pas.
- \`quality_score\` mesure l'apport reel du message. Un message qui informe, fait
  rire ou lance une vraie discussion est haut. Un message generique, un compliment
  automatique sur la plateforme, une salutation vide ou du remplissage est bas.
- \`theme\` : choisis le sujet dominant. \`plateforme_meta\` = parle de TwitNinf,
  de l'algorithme ou du dashboard. \`crypto_finance_jeu\` = NF, casino, mining,
  wallet, trading. \`clash_insulte\` = attaque ou embrouille entre utilisateurs.
- \`n\` doit reprendre exactement le numero affiche devant le tweet.

Reponds uniquement avec l'objet JSON conforme au schema, sans commentaire.

TWEETS A ANNOTER :
`;

const SELECT_PENDING = `
  SELECT t.id, t.content, u.username
  FROM tweets t
  JOIN users u ON u.id = t.user_id
  WHERE t.deleted_at IS NULL
    AND length(trim(t.content)) > 0
    AND NOT EXISTS (SELECT 1 FROM tweet_llm_labels l WHERE l.tweet_id = t.id)
  ORDER BY t.created_at DESC
  LIMIT $1
`;

const UPSERT = `
  INSERT INTO tweet_llm_labels
    (tweet_id, theme, toxicity_score, toxicity_category,
     quality_score, quality_class, tone, confidence, model)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  ON CONFLICT (tweet_id) DO UPDATE SET
    theme = EXCLUDED.theme,
    toxicity_score = EXCLUDED.toxicity_score,
    toxicity_category = EXCLUDED.toxicity_category,
    quality_score = EXCLUDED.quality_score,
    quality_class = EXCLUDED.quality_class,
    tone = EXCLUDED.tone,
    confidence = EXCLUDED.confidence,
    model = EXCLUDED.model,
    annotated_at = now()
`;

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

/** Lance codex sur un lot et renvoie les labels, ou null si l'appel a échoué. */
function runCodex(rows) {
  return new Promise((resolve) => {
    const prompt = CONSIGNE + rows
      .map((r, n) => `${n}. [@${r.username}] ${String(r.content).replace(/\s+/g, ' ').trim().slice(0, 500)}`)
      .join('\n');

    const outFile = path.join(os.tmpdir(), `annot-${process.pid}-${Date.now()}.json`);
    const args = [
      'exec', '--ignore-user-config', '-m', MODEL,
      '--skip-git-repo-check', '--ephemeral', '-s', 'read-only',
      '--output-schema', SCHEMA_PATH, '-o', outFile, '-',
    ];

    const child = execFile(CODEX, args, { timeout: 300000, maxBuffer: 16 * 1024 * 1024 }, (err) => {
      let labels = null;
      try {
        if (fs.existsSync(outFile)) {
          labels = JSON.parse(fs.readFileSync(outFile, 'utf8')).labels;
        }
      } catch (e) {
        log('warn', 'sortie codex illisible', { error: e.message });
      } finally {
        try { fs.unlinkSync(outFile); } catch { /* deja parti */ }
      }
      if (!labels && err) log('warn', 'codex a echoue', { error: err.message });
      resolve(Array.isArray(labels) ? labels : null);
    });

    child.stdin.end(prompt, 'utf8');
  });
}

async function tick() {
  const { rows } = await pool.query(SELECT_PENDING, [BATCH]);
  const pending = rows.filter((r) => (attempts.get(r.id) || 0) < MAX_ATTEMPTS);
  if (pending.length === 0) return;

  log('info', 'lot a annoter', { tweets: pending.length });
  const started = Date.now();
  const labels = await runCodex(pending);

  if (!labels) {
    // Échec du lot entier : on incrémente pour ne pas boucler indéfiniment
    // sur un tweet qui ferait systématiquement planter l'annotation.
    for (const r of pending) attempts.set(r.id, (attempts.get(r.id) || 0) + 1);
    return;
  }

  let written = 0;
  for (const lab of labels) {
    const n = lab && lab.n;
    if (!Number.isInteger(n) || n < 0 || n >= pending.length) continue;
    const t = pending[n];
    try {
      await pool.query(UPSERT, [
        t.id,
        lab.theme,
        clamp01(lab.toxicity_score),
        lab.toxicity_category,
        clamp01(lab.quality_score),
        lab.quality_class,
        lab.tone,
        clamp01(lab.confidence),
        MODEL_TAG,
      ]);
      attempts.delete(t.id);
      written += 1;
      if (clamp01(lab.toxicity_score) >= 0.6 && clamp01(lab.confidence) >= 0.5) {
        log('warn', 'tweet remonte en file de moderation', {
          tweet_id: t.id, username: t.username,
          toxicity: lab.toxicity_score, categorie: lab.toxicity_category,
        });
      }
    } catch (e) {
      log('error', 'ecriture du label impossible', { tweet_id: t.id, error: e.message });
    }
  }

  // Les tweets du lot restés sans label repartiront au tour suivant.
  for (const r of pending) {
    if (!labels.some((l) => l && pending[l.n] && pending[l.n].id === r.id)) {
      attempts.set(r.id, (attempts.get(r.id) || 0) + 1);
    }
  }

  log('info', 'lot annote', { ecrits: written, sur: pending.length, ms: Date.now() - started });
}

let stopping = false;

async function loop() {
  while (!stopping) {
    try {
      await tick();
    } catch (e) {
      log('error', 'erreur de boucle', { error: e.message });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('info', 'arret demande', { signal: sig });
    stopping = true;
    pool.end().finally(() => process.exit(0));
  });
}

log('info', 'worker d annotation demarre', { poll_ms: POLL_MS, batch: BATCH, model: MODEL });
loop();
