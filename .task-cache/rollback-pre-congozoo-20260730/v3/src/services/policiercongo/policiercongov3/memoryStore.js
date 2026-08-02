'use strict';

const { hash, newId, clip } = require('./utils');
const { MEMORY_KINDS, MEMORY_SCOPES, MEMORY_STATUS } = require('./constants');
const { rankMemories, entityKey, extractEntityKeys } = require('./memoryRanker');
const { MemoryEmbedder, scoreSemantic, findClosest, EMBEDDING_MODEL } = require('./memorySemantics');

function safePrefix(value) {
  if (!/^[a-z][a-z0-9_]{2,48}$/.test(value)) throw new Error('Préfixe SQL V3 invalide');
  return value;
}

function rowsOf(result) {
  return Array.isArray(result?.[0]) ? result[0] : [];
}

/**
 * Littéral tableau Postgres sûr.
 *
 * `recall` est une méthode publique : ses clés d'entité ne sont pas
 * nécessairement passées par `entityKey`. Sequelize interpole les
 * remplacements dans le texte de la requête, donc un guillemet non échappé ici
 * serait une injection SQL.
 */
function toPgTextArray(values) {
  const escaped = (values || [])
    .map(value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
    .map(value => `"${value}"`);
  return `{${escaped.join(',')}}`;
}

/** Texte réellement vectorisé : le contenu enrichi de son type et de ses tags. */
function embeddableText(item) {
  const tags = Array.isArray(item.tags) ? item.tags.join(' ') : '';
  return [item.kind, item.content, tags].filter(Boolean).join(' — ');
}

class PostgresMemoryStore {
  constructor({ sequelize, config, logger = console, embedder } = {}) {
    this.db = sequelize;
    this.config = config;
    this.logger = logger;
    this.p = safePrefix(config.schemaPrefix);
    this.embedder = embedder || new MemoryEmbedder({ config, logger });
    this.ready = false;
    this.schemaPromise = null;
  }

  /**
   * Création idempotente du schéma. Mémoïse la promesse : plusieurs appels
   * concurrents (recall + saveThread lancés en parallèle) ne doivent pas
   * exécuter le DDL simultanément.
   */
  async ensureSchema() {
    if (this.ready) return;
    this.schemaPromise ||= this._createSchema().then(
      () => { this.ready = true; this.schemaPromise = null; },
      error => { this.schemaPromise = null; throw error; }
    );
    return this.schemaPromise;
  }

  async _createSchema() {
    const p = this.p;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${p}_threads (
        thread_id TEXT PRIMARY KEY, user_id TEXT NULL, summary TEXT NOT NULL DEFAULT '',
        messages JSONB NOT NULL DEFAULT '[]'::jsonb, working_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS ${p}_memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, subject_id TEXT NULL, kind TEXT NOT NULL,
        content TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        importance REAL NOT NULL DEFAULT .5, confidence REAL NOT NULL DEFAULT .75,
        fingerprint TEXT NOT NULL UNIQUE, access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TIMESTAMPTZ NULL, expires_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ${p}_memories_subject_idx ON ${p}_memories(scope, subject_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS ${p}_runs (
        run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, user_id TEXT NULL, trigger TEXT NOT NULL,
        status TEXT NOT NULL, iterations INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
        provider TEXT NULL, model TEXT NULL, final_text TEXT NULL, error TEXT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ NULL
      );
      CREATE INDEX IF NOT EXISTS ${p}_runs_thread_idx ON ${p}_runs(thread_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS ${p}_checkpoints (
        run_id TEXT NOT NULL, iteration INTEGER NOT NULL, state JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(run_id, iteration)
      );
      CREATE TABLE IF NOT EXISTS ${p}_tool_audit (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        risk TEXT NOT NULL, args JSONB NOT NULL DEFAULT '{}'::jsonb, result JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ${p}_tool_audit_run_idx ON ${p}_tool_audit(run_id, created_at);
      CREATE TABLE IF NOT EXISTS ${p}_wakes (
        wake_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, user_id TEXT NULL, run_after TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', event JSONB NOT NULL, reason TEXT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        claimed_until TIMESTAMPTZ NULL, last_error TEXT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ${p}_wakes_due_idx ON ${p}_wakes(status, run_after);
    `);

    // Colonnes de la mémoire sémantique. Séparées du CREATE pour migrer sans
    // casse les bases V3 déjà déployées.
    await this.db.query(`
      ALTER TABLE ${p}_memories ADD COLUMN IF NOT EXISTS embedding JSONB NULL;
      ALTER TABLE ${p}_memories ADD COLUMN IF NOT EXISTS embedding_model TEXT NULL;
      ALTER TABLE ${p}_memories ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE ${p}_memories ADD COLUMN IF NOT EXISTS superseded_by TEXT NULL;
      ALTER TABLE ${p}_memories ADD COLUMN IF NOT EXISTS entity_key TEXT NULL;
      ALTER TABLE ${p}_memories ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE INDEX IF NOT EXISTS ${p}_memories_status_idx ON ${p}_memories(status, scope, updated_at DESC);
      CREATE INDEX IF NOT EXISTS ${p}_memories_entity_idx ON ${p}_memories(entity_key) WHERE entity_key IS NOT NULL;
    `);

    // Journal épisodique : ce que l'agent a vécu pendant ses passages
    // autonomes. Séparé de la conversation pour ne pas faire croire au modèle
    // qu'un humain lui a écrit « Effectue le passage agentique maintenant ».
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${p}_episodes (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NULL, trigger TEXT NULL,
        summary TEXT NOT NULL, outcome TEXT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ${p}_episodes_thread_idx ON ${p}_episodes(thread_id, created_at DESC);
    `);
  }

  // ---------------------------------------------------------------- threads

  async loadThread(threadId, userId = null) {
    await this.ensureSchema();
    const [rows] = await this.db.query(`SELECT * FROM ${this.p}_threads WHERE thread_id = :threadId`, { replacements: { threadId } });
    return rows[0] || { thread_id: threadId, user_id: userId, summary: '', messages: [], working_state: {}, version: 0 };
  }

  async saveThread(thread) {
    await this.ensureSchema();
    await this.db.query(`
      INSERT INTO ${this.p}_threads(thread_id,user_id,summary,messages,working_state,version)
      VALUES(:threadId,:userId,:summary,CAST(:messages AS jsonb),CAST(:workingState AS jsonb),1)
      ON CONFLICT(thread_id) DO UPDATE SET user_id=COALESCE(EXCLUDED.user_id,${this.p}_threads.user_id),
        summary=EXCLUDED.summary,messages=EXCLUDED.messages,working_state=EXCLUDED.working_state,
        version=${this.p}_threads.version+1,updated_at=NOW()
    `, { replacements: {
      threadId: thread.thread_id, userId: thread.user_id || null, summary: thread.summary || '',
      messages: JSON.stringify(thread.messages || []), workingState: JSON.stringify(thread.working_state || {})
    }});
  }

  // --------------------------------------------------------------- épisodes

  /** Enregistre ce que l'agent a fait pendant un passage autonome. */
  async recordEpisode({ threadId, runId, trigger, summary, outcome, details }) {
    if (!summary) return null;
    await this.ensureSchema();
    const id = newId('ep');
    await this.db.query(`
      INSERT INTO ${this.p}_episodes(id,thread_id,run_id,trigger,summary,outcome,details)
      VALUES(:id,:threadId,:runId,:trigger,:summary,:outcome,CAST(:details AS jsonb))
    `, { replacements: {
      id, threadId, runId: runId || null, trigger: trigger || null,
      summary: clip(summary, 4000), outcome: outcome || null, details: JSON.stringify(details || {})
    }}).catch(error => this.logger.warn?.(`[pc3.memory] épisode non enregistré: ${error.message}`));
    return id;
  }

  async loadEpisodes(threadId, limit = 12) {
    await this.ensureSchema();
    const [rows] = await this.db.query(`
      SELECT summary,outcome,trigger,created_at FROM ${this.p}_episodes
      WHERE thread_id=:threadId ORDER BY created_at DESC LIMIT :limit
    `, { replacements: { threadId, limit: Math.max(1, Math.min(50, Number(limit) || 12)) } });
    return rows.reverse();
  }

  // ---------------------------------------------------------------- mémoire

  /**
   * Rappel hybride : présélection SQL bornée, puis classement combinant
   * similarité sémantique (embeddings), similarité lexicale, type, importance,
   * récence et correspondance d'entité.
   *
   * Les souvenirs `superseded` / `forgotten` ne sont jamais rappelés : c'est ce
   * qui rend une correction réellement effective, au lieu de laisser coexister
   * l'ancienne et la nouvelle version d'un même fait.
   */
  async recall({ userId, threadId, query, limit, entityKeys = [] } = {}) {
    await this.ensureSchema();
    const recallLimit = limit || this.config.recallLimit;
    const wantedEntities = [...new Set([...entityKeys, ...extractEntityKeys(query)])];

    const [rows] = await this.db.query(`
      SELECT * FROM ${this.p}_memories
      WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW()) AND (
        scope IN ('global','self')
        OR (scope='user' AND subject_id IS NOT NULL AND subject_id = :userId)
        OR (scope='thread' AND subject_id = :threadId)
        OR (:hasEntities AND entity_key = ANY(CAST(:entityKeys AS text[])))
      ) ORDER BY pinned DESC, updated_at DESC LIMIT :candidateLimit
    `, { replacements: {
      userId: userId || null,
      threadId,
      hasEntities: wantedEntities.length > 0,
      entityKeys: toPgTextArray(wantedEntities),
      candidateLimit: this.config.recallCandidates
    }});

    const semanticScores = await this._semanticScores(query, rows);
    const rankOptions = { halfLifeDays: this.config.memoryHalfLifeDays, semanticScores, entityKeys: wantedEntities };
    const selected = this._selectWithIdentityCore(rows, query, recallLimit, rankOptions);

    if (selected.length) {
      await this.db.query(
        `UPDATE ${this.p}_memories SET access_count=access_count+1,last_accessed_at=NOW() WHERE id IN (:ids)`,
        { replacements: { ids: selected.map(item => item.id) } }
      ).catch(() => {});
    }
    // L'appelant n'a aucun usage des vecteurs : les retirer évite d'envoyer
    // 768 flottants par souvenir dans le prompt du modèle.
    return selected.map(({ embedding, ...memory }) => memory);
  }

  /**
   * Sélection finale : pertinence d'abord, identité garantie ensuite.
   *
   * Ce que PolicierCongo est et à quoi il s'est engagé doit rester accessible
   * même quand la question porte sur autre chose. Mais réserver la tête du
   * classement au noyau d'identité, comme le faisait la version précédente,
   * plaçait « @gas est mon frère de commentaire » en premier résultat de
   * n'importe quelle question, y compris « quelle est la limite de
   * caractères ». L'identité complète donc la sélection au lieu de la
   * dominer : elle occupe au plus quelques places, en fin de liste.
   */
  _selectWithIdentityCore(rows, query, recallLimit, rankOptions) {
    const identityQuota = Math.max(1, Math.min(3, Math.floor(recallLimit / 4)));
    const byRelevance = rankMemories(rows, query, { ...rankOptions, limit: recallLimit });

    const selected = byRelevance.slice(0, Math.max(1, recallLimit - identityQuota));
    const seen = new Set(selected.map(memory => memory.id));

    const identityCore = rankMemories(
      rows.filter(memory => memory.scope === MEMORY_SCOPES.SELF && Number(memory.importance ?? 0) >= 0.55),
      'identité profil relations engagements corrections policiercongo',
      { ...rankOptions, limit: identityQuota, halfLifeDays: Math.max(365, this.config.memoryHalfLifeDays) }
    );
    for (const memory of identityCore) {
      if (selected.length >= recallLimit) break;
      if (seen.has(memory.id)) continue;
      seen.add(memory.id);
      selected.push(memory);
    }

    // Places restantes rendues à la pertinence pure.
    for (const memory of byRelevance) {
      if (selected.length >= recallLimit) break;
      if (seen.has(memory.id)) continue;
      seen.add(memory.id);
      selected.push(memory);
    }
    return selected;
  }

  async _semanticScores(query, rows) {
    if (!String(query || '').trim() || !rows.length) return new Map();
    const vector = await this.embedder.embed(query, 'query');
    return vector ? scoreSemantic(vector, rows) : new Map();
  }

  /**
   * Écrit des souvenirs atomiques.
   *
   * Un souvenir de type `correction` (ou portant `supersedes`) ne s'ajoute pas
   * à côté du fait qu'il corrige : il le remplace. La cible est retrouvée par
   * identifiant explicite, ou à défaut par le souvenir actif sémantiquement le
   * plus proche dans le même périmètre.
   */
  async writeMemories(items, defaults = {}) {
    await this.ensureSchema();
    const saved = [];
    for (const item of items || []) {
      if (!item?.content) continue;
      if (Number(item.importance ?? 0.5) < this.config.memoryMinImportance) continue;
      try {
        const row = await this._writeOne(item, defaults);
        if (row) saved.push(row);
      } catch (error) {
        // Un souvenir non écrit ne doit jamais interrompre un run.
        this.logger.warn?.(`[pc3.memory] écriture ignorée: ${error.message}`);
      }
    }
    return saved;
  }

  async _writeOne(item, defaults) {
    const scope = Object.values(MEMORY_SCOPES).includes(item.scope) ? item.scope : MEMORY_SCOPES.USER;
    const kind = Object.values(MEMORY_KINDS).includes(item.kind) ? item.kind : MEMORY_KINDS.FACT;
    const subjectId = item.subject_id
      || (scope === MEMORY_SCOPES.THREAD ? defaults.threadId : scope === MEMORY_SCOPES.USER ? defaults.userId : null)
      || null;
    const content = String(item.content).trim();

    // Une entité explicite prime ; sinon on retient la première personne
    // mentionnée dans le contenu, ce qui rend « @gas est mon frère de
    // commentaire » retrouvable depuis n'importe quelle conversation.
    const explicitEntity = item.entity || item.entity_key;
    const resolvedEntity = explicitEntity ? entityKey(explicitEntity) : (extractEntityKeys(content)[0] || null);

    const fingerprint = hash(`${scope}|${subjectId || ''}|${kind}|${content.toLowerCase()}`);
    const embedding = await this.embedder.embed(embeddableText({ ...item, kind, content }), 'document');
    const id = newId('mem');

    const [rows] = await this.db.query(`
      INSERT INTO ${this.p}_memories(
        id,scope,subject_id,kind,content,metadata,importance,confidence,fingerprint,expires_at,
        embedding,embedding_model,entity_key,pinned,status)
      VALUES(:id,:scope,:subjectId,:kind,:content,CAST(:metadata AS jsonb),:importance,:confidence,:fingerprint,:expiresAt,
        CAST(:embedding AS jsonb),:embeddingModel,:entityKey,:pinned,'active')
      ON CONFLICT(fingerprint) DO UPDATE SET
        importance=GREATEST(${this.p}_memories.importance,EXCLUDED.importance),
        confidence=GREATEST(${this.p}_memories.confidence,EXCLUDED.confidence),
        metadata=EXCLUDED.metadata,
        entity_key=COALESCE(EXCLUDED.entity_key,${this.p}_memories.entity_key),
        embedding=COALESCE(EXCLUDED.embedding,${this.p}_memories.embedding),
        embedding_model=COALESCE(EXCLUDED.embedding_model,${this.p}_memories.embedding_model),
        pinned=${this.p}_memories.pinned OR EXCLUDED.pinned,
        status='active', superseded_by=NULL,
        updated_at=NOW()
      RETURNING *
    `, { replacements: {
      id, scope, subjectId, kind, content,
      metadata: JSON.stringify({ tags: item.tags || [], source: item.source || defaults.source || 'agent' }),
      importance: Number(item.importance ?? 0.5), confidence: Number(item.confidence ?? 0.75), fingerprint,
      expiresAt: item.expires_at || null,
      embedding: embedding ? JSON.stringify(embedding) : null,
      embeddingModel: embedding ? EMBEDDING_MODEL : null,
      entityKey: resolvedEntity,
      pinned: item.pinned === true
    }});

    const stored = rows[0];
    if (!stored) return null;

    const supersededIds = await this._applySupersession(item, stored, { scope, subjectId, kind, embedding });
    const { embedding: _vector, ...clean } = stored;
    return supersededIds.length ? { ...clean, superseded: supersededIds } : clean;
  }

  /**
   * Marque comme dépassés les souvenirs que celui-ci remplace.
   * @returns {Promise<string[]>} identifiants réellement supersédés
   */
  async _applySupersession(item, stored, { scope, subjectId, kind, embedding }) {
    const declared = Array.isArray(item.supersedes) ? item.supersedes : item.supersedes ? [item.supersedes] : [];
    const targets = new Set(declared.map(String));

    // Une correction sans cible explicite : on cherche le souvenir actif le
    // plus proche du même périmètre. Le seuil est volontairement élevé pour ne
    // jamais effacer un fait simplement voisin.
    if (!targets.size && kind === MEMORY_KINDS.CORRECTION && embedding) {
      const [candidates] = await this.db.query(`
        SELECT id,embedding FROM ${this.p}_memories
        WHERE status='active' AND id <> :id AND scope=:scope
          AND (subject_id IS NOT DISTINCT FROM :subjectId) AND kind <> 'correction'
          AND embedding IS NOT NULL
        ORDER BY updated_at DESC LIMIT 200
      `, { replacements: { id: stored.id, scope, subjectId } });
      const closest = findClosest(embedding, candidates, { minScore: this.config.memoryContradictionThreshold });
      if (closest) targets.add(String(closest.row.id));
    }

    if (!targets.size) return [];
    const [updated] = await this.db.query(`
      UPDATE ${this.p}_memories SET status='superseded',superseded_by=:newId,updated_at=NOW()
      WHERE id IN (:ids) AND id <> :newId AND status='active' RETURNING id
    `, { replacements: { newId: stored.id, ids: [...targets] } }).catch(() => [[]]);
    return (updated || []).map(row => row.id);
  }

  /**
   * Vectorise les souvenirs actifs qui n'ont pas encore d'embedding.
   *
   * Les souvenirs écrits avant l'arrivée de la mémoire sémantique restent
   * sinon classés au lexical seul, et une reformulation ne les retrouve
   * jamais. Traitement par lots, interruptible, sans transaction longue.
   *
   * @param {{batchSize?:number, maxBatches?:number}} [options]
   */
  async backfillEmbeddings({ batchSize = 50, maxBatches = 100 } = {}) {
    await this.ensureSchema();
    if (!this.embedder.available()) return { skipped: true, reason: 'embeddings_disabled' };

    let processed = 0;
    let failed = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const [rows] = await this.db.query(`
        SELECT id,kind,content,metadata FROM ${this.p}_memories
        WHERE embedding IS NULL AND status='active'
        ORDER BY importance DESC, updated_at DESC LIMIT :limit
      `, { replacements: { limit: Math.max(1, Math.min(200, batchSize)) } });
      if (!rows.length) break;

      for (const row of rows) {
        const vector = await this.embedder.embed(
          embeddableText({ kind: row.kind, content: row.content, tags: row.metadata?.tags }),
          'document'
        );
        if (!vector) { failed += 1; continue; }
        await this.db.query(
          `UPDATE ${this.p}_memories SET embedding=CAST(:embedding AS jsonb),embedding_model=:model WHERE id=:id`,
          { replacements: { id: row.id, embedding: JSON.stringify(vector), model: EMBEDDING_MODEL } }
        );
        processed += 1;
      }
      // Toutes les lignes du lot ont échoué : le modèle est indisponible,
      // insister ferait tourner la boucle pour rien.
      if (failed >= rows.length) break;
    }
    return { processed, failed };
  }

  /** Oubli explicite : le souvenir reste auditable mais n'est plus rappelé. */
  async forgetMemory(memoryId, reason = null) {
    await this.ensureSchema();
    const [rows] = await this.db.query(`
      UPDATE ${this.p}_memories
      SET status='forgotten', metadata=metadata||CAST(:patch AS jsonb), updated_at=NOW()
      WHERE id=:memoryId AND status <> 'forgotten' RETURNING id,content,kind,scope
    `, { replacements: { memoryId: String(memoryId), patch: JSON.stringify({ forgotten_reason: reason || null }) } });
    return rows[0] || null;
  }

  /** Épingle un souvenir pour qu'il soit rappelé quoi qu'il arrive. */
  async pinMemory(memoryId, pinned = true) {
    await this.ensureSchema();
    const [rows] = await this.db.query(
      `UPDATE ${this.p}_memories SET pinned=:pinned,updated_at=NOW() WHERE id=:memoryId RETURNING id,content,pinned`,
      { replacements: { memoryId: String(memoryId), pinned: pinned === true } }
    );
    return rows[0] || null;
  }

  /**
   * Purge les souvenirs sans valeur durable : expirés, et épisodes anciens de
   * faible importance. Empêche la table de croître indéfiniment et le rappel
   * de se diluer.
   */
  async consolidate({ maxAgeDays = 120 } = {}) {
    await this.ensureSchema();
    const [rows] = await this.db.query(`
      UPDATE ${this.p}_memories SET status='forgotten', updated_at=NOW()
      WHERE status='active' AND pinned IS FALSE AND (
        (expires_at IS NOT NULL AND expires_at <= NOW())
        OR (kind='episode' AND importance < 0.4 AND updated_at < NOW() - CAST(:maxAge AS interval))
      ) RETURNING id
    `, { replacements: { maxAge: `${Math.max(1, Number(maxAgeDays) || 120)} days` } }).catch(() => [[]]);
    return { forgotten: (rows || []).length };
  }

  // -------------------------------------------------------------------- runs

  async recordRunStart(run) {
    await this.ensureSchema();
    await this.db.query(`INSERT INTO ${this.p}_runs(run_id,thread_id,user_id,trigger,status,metadata) VALUES(:runId,:threadId,:userId,:trigger,'running',CAST(:metadata AS jsonb))`, {
      replacements: { runId: run.runId, threadId: run.threadId, userId: run.userId || null, trigger: run.trigger, metadata: JSON.stringify(run.metadata || {}) }
    });
  }

  async finishRun(runId, patch = {}) {
    await this.ensureSchema();
    await this.db.query(`UPDATE ${this.p}_runs SET status=:status,iterations=:iterations,tool_calls=:toolCalls,provider=:provider,model=:model,final_text=:finalText,error=:error,metadata=metadata||CAST(:metadata AS jsonb),finished_at=NOW() WHERE run_id=:runId`, {
      replacements: { runId, status: patch.status || 'completed', iterations: patch.iterations || 0, toolCalls: patch.toolCalls || 0,
        provider: patch.provider || null, model: patch.model || null, finalText: patch.finalText || null, error: patch.error || null,
        metadata: JSON.stringify(patch.metadata || {}) }
    });
  }

  async saveCheckpoint(runId, iteration, state) {
    await this.ensureSchema();
    await this.db.query(`INSERT INTO ${this.p}_checkpoints(run_id,iteration,state) VALUES(:runId,:iteration,CAST(:state AS jsonb)) ON CONFLICT(run_id,iteration) DO UPDATE SET state=EXCLUDED.state,created_at=NOW()`, {
      replacements: { runId, iteration, state: JSON.stringify(state || {}) }
    });
  }

  async auditTool(row) {
    await this.ensureSchema();
    await this.db.query(`INSERT INTO ${this.p}_tool_audit(id,run_id,thread_id,tool_name,risk,args,result,status,duration_ms) VALUES(:id,:runId,:threadId,:toolName,:risk,CAST(:args AS jsonb),CAST(:result AS jsonb),:status,:durationMs)`, {
      replacements: { ...row, id: row.id || newId('audit'), args: JSON.stringify(row.args || {}), result: JSON.stringify(row.result || {}) }
    });
  }

  // ------------------------------------------------------------------ wakes

  /**
   * Remplace le réveil en attente du thread par un nouveau.
   * Les deux ordres tiennent dans une transaction : sans elle, un crash entre
   * les deux laissait le thread sans aucun réveil programmé, donc un agent
   * autonome définitivement endormi.
   */
  async scheduleWake({ threadId, userId, runAfter, event, reason }) {
    await this.ensureSchema();
    const wakeId = newId('wake');
    await this.db.transaction(async transaction => {
      await this.db.query(
        `UPDATE ${this.p}_wakes SET status='superseded',updated_at=NOW() WHERE thread_id=:threadId AND status='pending'`,
        { replacements: { threadId }, transaction }
      );
      await this.db.query(
        `INSERT INTO ${this.p}_wakes(wake_id,thread_id,user_id,run_after,event,reason) VALUES(:wakeId,:threadId,:userId,:runAfter,CAST(:event AS jsonb),:reason)`,
        { replacements: { wakeId, threadId, userId: userId || null, runAfter, event: JSON.stringify(event), reason: reason || null }, transaction }
      );
    });
    return { wakeId, runAfter };
  }

  /**
   * Programme plusieurs réveils d'un coup pour le même thread (ex: 3 passages
   * espacés dans la journée). Un seul supersede des réveils en attente est
   * fait avant l'insertion du lot entier — sinon chaque insertion successive
   * écraserait la précédente et il n'en resterait qu'un seul (comportement de
   * `scheduleWake` ci-dessus, voulu pour l'usage single-wake).
   */
  async scheduleWakes(threadId, userId, wakes) {
    await this.ensureSchema();
    const results = [];
    await this.db.transaction(async transaction => {
      await this.db.query(
        `UPDATE ${this.p}_wakes SET status='superseded',updated_at=NOW() WHERE thread_id=:threadId AND status='pending'`,
        { replacements: { threadId }, transaction }
      );
      for (const wake of wakes) {
        const wakeId = newId('wake');
        await this.db.query(
          `INSERT INTO ${this.p}_wakes(wake_id,thread_id,user_id,run_after,event,reason) VALUES(:wakeId,:threadId,:userId,:runAfter,CAST(:event AS jsonb),:reason)`,
          { replacements: { wakeId, threadId, userId: userId || null, runAfter: wake.runAfter, event: JSON.stringify(wake.event), reason: wake.reason || null }, transaction }
        );
        results.push({ wakeId, runAfter: wake.runAfter });
      }
    });
    return results;
  }

  async getNextWake(threadId = null) {
    await this.ensureSchema();
    const [rows] = await this.db.query(`
      SELECT wake_id,thread_id,user_id,run_after,status,reason FROM ${this.p}_wakes
      WHERE status IN ('pending','running') ${threadId ? 'AND thread_id=:threadId' : ''}
      ORDER BY run_after ASC LIMIT 1
    `, { replacements: { threadId } });
    return rows[0] || null;
  }

  async claimDueWakes(limit, claimSeconds) {
    await this.ensureSchema();
    const claimedUntil = new Date(Date.now() + Number(claimSeconds) * 1000).toISOString();
    const [rows] = await this.db.query(`
      WITH due AS (
        SELECT wake_id FROM ${this.p}_wakes WHERE run_after <= NOW()
          AND (status='pending' OR (status='running' AND claimed_until < NOW()))
        ORDER BY run_after ASC FOR UPDATE SKIP LOCKED LIMIT :limit
      ) UPDATE ${this.p}_wakes w SET status='running',attempts=attempts+1,
        claimed_until=:claimedUntil,updated_at=NOW()
      FROM due WHERE w.wake_id=due.wake_id RETURNING w.*
    `, { replacements: { limit, claimedUntil } });
    return rows;
  }

  async finishWake(wakeId, status, error = null) {
    await this.ensureSchema();
    await this.db.query(`UPDATE ${this.p}_wakes SET status=:status,last_error=:error,claimed_until=NULL,updated_at=NOW() WHERE wake_id=:wakeId`, {
      replacements: { wakeId, status, error }
    });
  }

  async listMemories({ userId, threadId, limit = 100 }) {
    return this.recall({ userId, threadId, query: '', limit });
  }
}

/** Équivalent en mémoire vive, pour les tests et les environnements sans base. */
class InMemoryMemoryStore {
  constructor({ config, embedder, logger = console } = {}) {
    this.config = config;
    this.logger = logger;
    this.embedder = embedder || new MemoryEmbedder({ config, logger });
    this.threads = new Map();
    this.memories = [];
    this.runs = new Map();
    this.wakes = new Map();
    this.episodes = [];
  }

  async ensureSchema() {}

  async loadThread(id, userId) {
    return this.threads.get(id) || { thread_id: id, user_id: userId, summary: '', messages: [], working_state: {}, version: 0 };
  }

  async saveThread(thread) {
    this.threads.set(thread.thread_id, { ...thread, version: (thread.version || 0) + 1 });
  }

  async recordEpisode({ threadId, runId, trigger, summary, outcome, details }) {
    if (!summary) return null;
    const id = newId('ep');
    this.episodes.push({ id, thread_id: threadId, run_id: runId, trigger, summary, outcome, details, created_at: new Date() });
    return id;
  }

  async loadEpisodes(threadId, limit = 12) {
    return this.episodes.filter(item => item.thread_id === threadId).slice(-limit);
  }

  async recall({ userId, threadId, query, limit, entityKeys = [] } = {}) {
    const wantedEntities = [...new Set([...entityKeys, ...extractEntityKeys(query)])];
    const candidates = this.memories.filter(memory => memory.status !== MEMORY_STATUS.SUPERSEDED
      && memory.status !== MEMORY_STATUS.FORGOTTEN
      && ([MEMORY_SCOPES.GLOBAL, MEMORY_SCOPES.SELF].includes(memory.scope)
        || (memory.subject_id && memory.subject_id === userId)
        || memory.subject_id === threadId
        || (memory.entity_key && wantedEntities.includes(memory.entity_key))));
    const vector = String(query || '').trim() ? await this.embedder.embed(query, 'query') : null;
    const semanticScores = vector ? scoreSemantic(vector, candidates) : new Map();
    // Même sélection que le store Postgres, pour que les tests reflètent la
    // production plutôt qu'un classement simplifié.
    return PostgresMemoryStore.prototype._selectWithIdentityCore.call(
      this, candidates, query, limit || this.config.recallLimit,
      { halfLifeDays: this.config.memoryHalfLifeDays, semanticScores, entityKeys: wantedEntities }
    ).map(({ embedding, ...memory }) => memory);
  }

  async writeMemories(items, defaults = {}) {
    const saved = [];
    for (const item of items || []) {
      if (!item?.content) continue;
      if (Number(item.importance ?? 0.5) < this.config.memoryMinImportance) continue;
      const scope = item.scope || MEMORY_SCOPES.USER;
      const kind = item.kind || MEMORY_KINDS.FACT;
      const content = String(item.content).trim();
      const explicitEntity = item.entity || item.entity_key;
      const record = {
        ...item,
        id: newId('mem'),
        scope,
        kind,
        content,
        status: MEMORY_STATUS.ACTIVE,
        entity_key: explicitEntity ? entityKey(explicitEntity) : (extractEntityKeys(content)[0] || null),
        subject_id: item.subject_id
          || (scope === MEMORY_SCOPES.THREAD ? defaults.threadId : scope === MEMORY_SCOPES.USER ? defaults.userId : null)
          || null,
        embedding: await this.embedder.embed(embeddableText({ ...item, kind, content }), 'document'),
        metadata: { tags: item.tags || [], source: item.source || defaults.source || 'agent' },
        created_at: new Date(),
        updated_at: new Date()
      };

      const declared = Array.isArray(item.supersedes) ? item.supersedes : item.supersedes ? [item.supersedes] : [];
      const targets = new Set(declared.map(String));
      if (!targets.size && kind === MEMORY_KINDS.CORRECTION && record.embedding) {
        const closest = findClosest(
          record.embedding,
          this.memories.filter(m => m.status === MEMORY_STATUS.ACTIVE && m.scope === scope && m.kind !== MEMORY_KINDS.CORRECTION),
          { minScore: this.config.memoryContradictionThreshold }
        );
        if (closest) targets.add(String(closest.row.id));
      }
      const superseded = [];
      for (const memory of this.memories) {
        if (targets.has(String(memory.id)) && memory.status === MEMORY_STATUS.ACTIVE) {
          memory.status = MEMORY_STATUS.SUPERSEDED;
          memory.superseded_by = record.id;
          superseded.push(memory.id);
        }
      }
      this.memories.push(record);
      const { embedding, ...clean } = record;
      saved.push(superseded.length ? { ...clean, superseded } : clean);
    }
    return saved;
  }

  async forgetMemory(memoryId, reason = null) {
    const memory = this.memories.find(item => item.id === memoryId);
    if (!memory) return null;
    memory.status = MEMORY_STATUS.FORGOTTEN;
    memory.metadata = { ...(memory.metadata || {}), forgotten_reason: reason };
    return { id: memory.id, content: memory.content, kind: memory.kind, scope: memory.scope };
  }

  async pinMemory(memoryId, pinned = true) {
    const memory = this.memories.find(item => item.id === memoryId);
    if (!memory) return null;
    memory.pinned = pinned === true;
    return { id: memory.id, content: memory.content, pinned: memory.pinned };
  }

  async consolidate() { return { forgotten: 0 }; }
  async backfillEmbeddings() { return { processed: 0, failed: 0 }; }
  async recordRunStart(run) { this.runs.set(run.runId, { ...run, status: 'running' }); }
  async finishRun(id, patch) { this.runs.set(id, { ...(this.runs.get(id) || {}), ...patch }); }
  async saveCheckpoint() {}
  async auditTool() {}

  async scheduleWake(wake) {
    for (const [id, existing] of this.wakes) {
      if (existing.threadId === wake.threadId && existing.status === 'pending') this.wakes.set(id, { ...existing, status: 'superseded' });
    }
    const wakeId = newId('wake');
    this.wakes.set(wakeId, { wake_id: wakeId, ...wake, status: 'pending' });
    return { wakeId, runAfter: wake.runAfter };
  }

  async scheduleWakes(threadId, userId, wakes) {
    for (const [id, existing] of this.wakes) {
      if (existing.threadId === threadId && existing.status === 'pending') this.wakes.set(id, { ...existing, status: 'superseded' });
    }
    const results = [];
    for (const wake of wakes) {
      const wakeId = newId('wake');
      this.wakes.set(wakeId, { wake_id: wakeId, threadId, userId, ...wake, status: 'pending' });
      results.push({ wakeId, runAfter: wake.runAfter });
    }
    return results;
  }

  async getNextWake(threadId = null) {
    return [...this.wakes.values()]
      .filter(w => ['pending', 'running'].includes(w.status) && (!threadId || w.threadId === threadId))
      .sort((a, b) => new Date(a.runAfter) - new Date(b.runAfter))[0] || null;
  }

  async claimDueWakes(limit) {
    return [...this.wakes.values()]
      .filter(w => w.status === 'pending' && new Date(w.runAfter) <= new Date())
      .slice(0, limit)
      .map(w => ({ ...w, thread_id: w.threadId, user_id: w.userId, status: 'running' }));
  }

  async finishWake(id, status, error) {
    const wake = this.wakes.get(id);
    if (wake) this.wakes.set(id, { ...wake, status, last_error: error });
  }

  async listMemories(args) { return this.recall({ ...args, query: '' }); }
}

module.exports = { PostgresMemoryStore, InMemoryMemoryStore, safePrefix, rowsOf, embeddableText };
