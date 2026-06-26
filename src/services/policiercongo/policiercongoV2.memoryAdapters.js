/**
 * Adaptateurs mémoire production pour PolicierCongo V2 — PostgreSQL uniquement.
 *
 * Contrat : identique à `createDefaultMemoryAdapters()` dans policiercongoV2.js
 * (getShortTermSession, getLongTermProfile, getLongTermActionHistory,
 * getSocialRelations, getTopics, vectorSearch, persistAfterTurn).
 *
 * Dépendance : `pg` Pool (déjà utilisé par l’API / Sequelize).
 * Vectoriel : par défaut PostgreSQL + embeddings JSONB + similarité cosinus (Cohere via `embedQuery`).
 * Optionnel : Pinecone + même `embedQuery` si `pineconeIndex` est fourni.
 */

'use strict';

const logger = require('../../utils/logger');
const { SHORT_TERM_MAX_MESSAGES } = require('./policiercongoV2');
const { rankByCosine } = require('./policiercongoV2Embeddings');
const { POLICE_ACCOUNT_ID } = require('./config');

const DEFAULT_KEY_PREFIX = 'pc2:';

/** @typedef {import('./policiercongoV2').MemoryAdapters} MemoryAdapters */

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pgPool Pool PostgreSQL (ex. celui de Sequelize ou un Pool dédié).
 * @param {object} [deps.pineconeIndex] Index Pinecone (SDK) ou objet { query(opts) }
 * @param {(text: string, inputType?: string) => Promise<number[]>} [deps.embedQuery] Cohere / embeddings (search_query vs search_document)
 * @param {string} [deps.keyPrefix='pc2:'] Préfixe des clés de session (évite les collisions)
 * @param {boolean} [deps.ensureSchema=true] CREATE TABLE IF NOT EXISTS au premier appel
 * @param {number} [deps.vectorCandidateLimit=400] Lignes max scannées pour la recherche cosinus
 * @returns {MemoryAdapters}
 */
function createPostgresAdapters(deps) {
  const {
    pgPool,
    pineconeIndex = null,
    embedQuery = null,
    keyPrefix = DEFAULT_KEY_PREFIX,
    ensureSchema = true,
    vectorCandidateLimit = 400
  } = deps || {};

  async function embedSearch(text) {
    if (typeof embedQuery !== 'function') return [];
    try {
      if (embedQuery.length >= 2) return await embedQuery(text, 'search_query');
      return await embedQuery(text);
    } catch (e) {
      logger.warn(`[pc2.memory] embedSearch: ${e.message}`);
      return [];
    }
  }

  async function embedDoc(text) {
    if (typeof embedQuery !== 'function') return [];
    try {
      if (embedQuery.length >= 2) return await embedQuery(text, 'search_document');
      return await embedQuery(text);
    } catch (e) {
      logger.warn(`[pc2.memory] embedDoc: ${e.message}`);
      return [];
    }
  }

  if (!pgPool) {
    throw new Error('[pc2.memory] pgPool est requis (PostgreSQL uniquement, pas de Redis).');
  }

  let _schemaReady = !ensureSchema;

  async function _ensurePgSchema() {
    if (_schemaReady) return;
    const ddl = `
      CREATE TABLE IF NOT EXISTS policiercongo_v2_session (
        session_key VARCHAR(512) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{"messages":[],"sessionState":{}}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pc2_session_updated ON policiercongo_v2_session (updated_at DESC);

      CREATE TABLE IF NOT EXISTS policiercongo_v2_user_profile (
        user_id VARCHAR(255) PRIMARY KEY,
        profile JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS policiercongo_v2_action_log (
        id BIGSERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        ts BIGINT NOT NULL,
        actions JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pc2_action_user_ts ON policiercongo_v2_action_log (user_id, ts DESC);
      CREATE TABLE IF NOT EXISTS policiercongo_v2_social (
        user_id VARCHAR(255) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{"friends":[],"followers":[],"commonGroups":[]}'
      );
      CREATE TABLE IF NOT EXISTS policiercongo_v2_topics (
        user_id VARCHAR(255) PRIMARY KEY,
        topics JSONB NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS policiercongo_v2_embeddings (
        id BIGSERIAL PRIMARY KEY,
        user_id VARCHAR(255),
        source_text TEXT NOT NULL,
        embedding JSONB NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pc2_emb_user_created ON policiercongo_v2_embeddings (user_id, created_at DESC);
    `;
    await pgPool.query(ddl);
    _schemaReady = true;
    logger.info('[pc2.memory] Schéma PostgreSQL policiercongo_v2_* vérifié/créé.');
  }

  function _sessionKey(event) {
    const k = event.threadId || event.id;
    return `${keyPrefix}${k}`;
  }

  async function _loadSessionRow(sessionKey) {
    const { rows } = await pgPool.query(
      'SELECT data FROM policiercongo_v2_session WHERE session_key = $1',
      [sessionKey]
    );
    if (!rows.length) {
      return { messages: [], sessionState: {} };
    }
    const data = rows[0].data || {};
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      sessionState: data.sessionState && typeof data.sessionState === 'object' ? data.sessionState : {}
    };
  }

  async function _saveSessionRow(sessionKey, session) {
    await pgPool.query(
      `INSERT INTO policiercongo_v2_session (session_key, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (session_key) DO UPDATE SET
         data = EXCLUDED.data,
         updated_at = NOW()`,
      [sessionKey, JSON.stringify(session)]
    );
  }

  async function _pineconeVectorSearch(queryText, opts = {}) {
    if (!pineconeIndex || typeof embedQuery !== 'function') {
      if (pineconeIndex && !embedQuery) {
        logger.warn('[pc2.memory] pineconeIndex fourni sans embedQuery — vectorSearch retourne [].');
      }
      return [];
    }
    try {
      const limit = opts.limit ?? 8;
      const vector = await embedSearch(queryText);
      if (!vector || !vector.length) return [];

      const q = pineconeIndex.query?.bind(pineconeIndex)
        ? await pineconeIndex.query({
            vector,
            topK: limit,
            includeMetadata: true,
            filter: opts.userId ? { user_id: { $eq: opts.userId } } : undefined
          })
        : await pineconeIndex.query({ vector, topK: limit, includeMetadata: true });

      const matches = q?.matches || q?.Matches || [];
      return matches.map((m) => ({
        id: m.id,
        score: m.score,
        metadata: m.metadata || {}
      }));
    } catch (e) {
      logger.warn(`[pc2.memory] vectorSearch Pinecone: ${e.message}`);
      return [];
    }
  }

  async function _pgVectorSearch(queryText, opts = {}) {
    if (typeof embedQuery !== 'function') return [];
    const qVec = await embedSearch(queryText);
    const limit = opts.limit ?? 20;
        const cand = opts.vectorCandidateLimit ?? (opts.global ? 320 : 200);
    const uid = opts.global ? null : (opts.userId || null);

    try {
      await _ensurePgSchema();
      
      // 1. Recherche Vectorielle (Sémantique)
      let vectorRows = [];
      if (qVec.length) {
        const { rows } = await pgPool.query(
          `SELECT id, source_text, metadata, embedding FROM policiercongo_v2_embeddings
           WHERE ($1::text IS NULL OR user_id::text = $1::text)
           ORDER BY created_at DESC
           LIMIT $2`,
          [uid, cand]
        );
        vectorRows = rows;
      }

      // 2. Recherche par Mot-Clé (Exacte/Floue) - Hybride
      // On extrait des termes importants (mots > 3 lettres ou commençant par @)
      const terms = (queryText || '')
        .split(/[\s,?!.']+/)
        .filter(t => t.length > 3 || t.startsWith('@'))
        .sort((a, b) => b.length - a.length)
        .slice(0, 10);
      let keywordRows = [];
      if (terms.length > 0) {
        // On cherche le terme dans le TEXTE ou dans le USERNAME stocké en métadonnées
        const keywordQuery = terms.map(t => {
          const cleanT = t.replace(/'/g, "''").replace(/^@/, '');
          return `(source_text ILIKE '%${t.replace(/'/g, "''")}%' OR metadata->>'user_username' ILIKE '%${cleanT}%' OR metadata->>'username' ILIKE '%${cleanT}%')`;
        }).join(' OR ');


        const { rows } = await pgPool.query(
          `SELECT id, source_text, metadata, embedding FROM policiercongo_v2_embeddings
           WHERE (${keywordQuery})
           AND ($1::text IS NULL OR user_id::text = $1::text)
           ORDER BY created_at DESC
           LIMIT 200`,
          [uid]
        );
        keywordRows = rows;
      }

      // 3. Fusion et Ranking
      const allRows = [...vectorRows];
      const seenIds = new Set(allRows.map(r => r.id));
      
      for (const r of keywordRows) {
        if (!seenIds.has(r.id)) {
          allRows.push(r);
          seenIds.add(r.id);
        }
      }

      const parsed = [];
      for (const r of allRows) {
        let emb = r.embedding;
        if (typeof emb === 'string') {
          try { emb = JSON.parse(emb); } catch (_) { emb = null; }
        }
        if (emb && Array.isArray(emb) && emb.length) {
          parsed.push({
            id: r.id,
            source_text: r.source_text,
            metadata: r.metadata,
            embedding: emb
          });
        }
      }

      return rankByCosine(qVec, parsed, limit);
    } catch (e) {
      logger.warn(`[pc2.memory] vectorSearch PG: ${e.message}`);
      return [];
    }
  }

  async function _indexTurnEmbeddings(event, structured) {
    if (typeof embedQuery !== 'function') return;

    const pieces = [];
    const genericTriggers = [
      'Analyse automatique de la plateforme.',
      'Automatisation complète PolicierCongo.',
      'Analyse automatique.'
    ];

    // 1. Déterminer le texte "utilisateur" à indexer
    // On privilégie le texte d'un commentaire réel si on y a répondu
    let userText = null;
    if (!genericTriggers.includes(event.rawText)) {
      userText = event.rawText;
    } else if (event.metadata?.latest_comment?.text || event.metadata?.latest_comment?.content) {
      userText = event.metadata.latest_comment.text || event.metadata.latest_comment.content;
    }

    if (userText && String(userText).trim()) {
      pieces.push({ role: 'user', text: String(userText).trim() });
    }

    if (structured) {
      // Cas Multi-Actions : on indexe chaque contenu individuel
      if (Array.isArray(structured)) {
        for (const act of structured) {
          const content = act.content || act.details?.content || act.details?.response_content;
          const target = act.target_user || act.details?.target_user || act.username || act.details?.username;
          if (content && String(content).trim()) {
            pieces.push({ 
              role: 'assistant', 
              text: String(content).trim(),
              target: target ? String(target).replace('@', '') : null
            });
          }
        }
      } else if (structured.action === 'MULTIPLE_ACTIONS' && Array.isArray(structured.actions)) {
        for (const act of structured.actions) {
          const content = act.details?.content || act.details?.response_content;
          const target = act.target_user || act.details?.target_user || act.username || act.details?.username;
          if (content && String(content).trim()) {
            pieces.push({ 
              role: 'assistant', 
              text: String(content).trim(),
              target: target ? String(target).replace('@', '') : null
            });
          }
        }
      } 
      // Cas Action Simple
      else if (structured.content && String(structured.content).trim()) {
        const target = structured.target_user || structured.details?.target_user || structured.username;
        pieces.push({ 
          role: 'assistant', 
          text: String(structured.content).trim(),
          target: target ? String(target).replace('@', '') : null
        });
      }
    }

    if (!pieces.length) return;
    try {
      await _ensurePgSchema();
      const vectors = await Promise.all(pieces.map((p) => embedDoc(p.text)));
      for (let i = 0; i < pieces.length; i++) {
        const vec = vectors[i];
        if (!vec || !vec.length) continue;
        const p = pieces[i];
        await pgPool.query(
          `INSERT INTO policiercongo_v2_embeddings (user_id, source_text, embedding, metadata)
           VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
          [
            event.userId || null,
            p.text.slice(0, 8000),
            JSON.stringify(vec),
            JSON.stringify({
              role: p.role,
              event_id: event.id,
              trigger: event.trigger,
              user_username: p.target || event.username || (event.metadata ? event.metadata.username : null),
              username: p.target || event.username || (event.metadata ? event.metadata.username : null)
            })
          ]
        );
      }
    } catch (e) {
      logger.warn(`[pc2.memory] _indexTurnEmbeddings: ${e.message}`);
    }
  }

  return {
    async getShortTermSession(event) {
      try {
        await _ensurePgSchema();
        const sessionKey = _sessionKey(event);
        return await _loadSessionRow(sessionKey);
      } catch (e) {
        logger.warn(`[pc2.memory] getShortTermSession: ${e.message}`);
        return { messages: [], sessionState: {} };
      }
    },

    async getLongTermProfile(userId) {
      try {
        await _ensurePgSchema();
        const { rows } = await pgPool.query(
          'SELECT profile FROM policiercongo_v2_user_profile WHERE user_id = $1',
          [userId]
        );
        if (!rows.length) {
          return { preferences: {}, style: null, themes: [], tone: null };
        }
        const p = rows[0].profile || {};
        return {
          ...p,
          preferences: p.preferences && typeof p.preferences === 'object' ? p.preferences : {},
          style: p.style ?? null,
          themes: Array.isArray(p.themes) ? p.themes : [],
          tone: p.tone ?? null
        };
      } catch (e) {
        logger.warn(`[pc2.memory] getLongTermProfile: ${e.message}`);
        return { preferences: {}, style: null, themes: [], tone: null };
      }
    },

    async getLongTermActionHistory(userId, limit = 20) {
      try {
        await _ensurePgSchema();
        const { rows } = await pgPool.query(
          `SELECT ts, actions FROM policiercongo_v2_action_log
           WHERE user_id = $1 ORDER BY ts DESC LIMIT $2`,
          [userId, limit]
        );
        return rows.reverse().map((r) => ({ ts: Number(r.ts), actions: r.actions }));
      } catch (e) {
        logger.warn(`[pc2.memory] getLongTermActionHistory: ${e.message}`);
        return [];
      }
    },

    async getSocialRelations(userId) {
      try {
        await _ensurePgSchema();
        const { rows } = await pgPool.query(
          'SELECT data FROM policiercongo_v2_social WHERE user_id = $1',
          [userId]
        );
        if (!rows.length) {
          return { friends: [], followers: [], commonGroups: [] };
        }
        const d = rows[0].data || {};
        return {
          friends: Array.isArray(d.friends) ? d.friends : [],
          followers: Array.isArray(d.followers) ? d.followers : [],
          commonGroups: Array.isArray(d.commonGroups) ? d.commonGroups : []
        };
      } catch (e) {
        logger.warn(`[pc2.memory] getSocialRelations: ${e.message}`);
        return { friends: [], followers: [], commonGroups: [] };
      }
    },

    async getTopics(userId) {
      try {
        await _ensurePgSchema();
        const { rows } = await pgPool.query(
          'SELECT topics FROM policiercongo_v2_topics WHERE user_id = $1',
          [userId]
        );
        if (!rows.length) return [];
        const t = rows[0].topics;
        return Array.isArray(t) ? t : [];
      } catch (e) {
        logger.warn(`[pc2.memory] getTopics: ${e.message}`);
        return [];
      }
    },

    async vectorSearch(queryText, opts = {}) {
      if (pineconeIndex && typeof embedQuery === 'function') {
        return _pineconeVectorSearch(queryText, opts);
      }
      return _pgVectorSearch(queryText, opts);
    },

    async persistAfterTurn(payload) {
      try {
        await _ensurePgSchema();
        const { event, structured, actions, store_memory } = payload;
        const sessionKey = _sessionKey(event);
        let session = await _loadSessionRow(sessionKey);
        if (!session.messages) session.messages = [];
        if (!session.sessionState) session.sessionState = {};

        if (event.rawText) {
          session.messages.push({ role: 'user', content: event.rawText });
        }
        if (structured?.content) {
          session.messages.push({ role: 'assistant', content: structured.content });
        }
        if (session.messages.length > SHORT_TERM_MAX_MESSAGES) {
          session.messages = session.messages.slice(-SHORT_TERM_MAX_MESSAGES);
        }
        await _saveSessionRow(sessionKey, session);

        if (store_memory && (event.userId || store_memory.self) && typeof store_memory === 'object') {
          // Si store_memory.self est true, on met à jour le profil du BOT, pas celui de l'utilisateur
          const targetUserId = store_memory.self ? POLICE_ACCOUNT_ID : event.userId;
          const { self: _self, ...profileUpdate } = store_memory;

          // Mise à jour du profil (User ou Bot)
          await pgPool.query(
            `INSERT INTO policiercongo_v2_user_profile (user_id, profile, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (user_id) DO UPDATE SET
               profile = policiercongo_v2_user_profile.profile || EXCLUDED.profile,
               updated_at = NOW()`,
            [targetUserId, profileUpdate]
          );

          // MISE À JOUR DES TOPICS
          if (profileUpdate.topics && Array.isArray(profileUpdate.topics)) {
            await pgPool.query(
              `INSERT INTO policiercongo_v2_topics (user_id, topics, updated_at)
               VALUES ($1, $2::jsonb, NOW())
               ON CONFLICT (user_id) DO UPDATE SET
                 topics = EXCLUDED.topics,
                 updated_at = NOW()`,
              [targetUserId, JSON.stringify(profileUpdate.topics)]
            );
          }
        }

        if (event.userId && actions && actions.length) {
          await pgPool.query(
            `INSERT INTO policiercongo_v2_action_log (user_id, ts, actions) VALUES ($1, $2, $3::jsonb)`,
            [event.userId, Date.now(), JSON.stringify(actions)]
          );
        }

        await _indexTurnEmbeddings(event, structured);

        return { ok: true };
      } catch (err) {
        logger.error(`[pc2.memory] persistAfterTurn: ${err.message}`);
        return { ok: false };
      }
    }
  };
}

/**
 * @deprecated Utiliser `createPostgresAdapters({ pgPool })` — Redis n’est plus utilisé.
 * Si `redisClient` est passé, il est ignoré (compatibilité anciens appels).
 */
function createRedisPostgresAdapters(deps) {
  if (deps && deps.redisClient) {
    logger.warn('[pc2.memory] createRedisPostgresAdapters : redisClient ignoré (mémoire 100 % PostgreSQL).');
  }
  const { redisClient: _r, ...rest } = deps || {};
  return createPostgresAdapters(rest);
}

module.exports = {
  createPostgresAdapters,
  createRedisPostgresAdapters,
  DEFAULT_KEY_PREFIX
};
