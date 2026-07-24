'use strict';

const express = require('express');
const { authenticateToken, requireAdminRole } = require('../../../middleware/authMiddleware');
const { getPolicierCongoV3 } = require('./orchestrator');

function eventFromRequest(req) {
  const admin = ['admin', 'superadmin'].includes(req.user?.role);
  const wanted = req.body?.permissions || {};
  return {
    ...(req.body?.event || req.body || {}),
    userId: req.body?.event?.userId || req.body?.userId || req.user?.id,
    username: req.body?.event?.username || req.body?.username || req.user?.username,
    permissions: {
      allowRead: true,
      allowWrite: admin && wanted.allowWrite === true,
      allowSensitive: admin && wanted.allowSensitive === true,
      allowDestructive: admin && wanted.allowDestructive === true,
      approvalToken: admin ? wanted.approvalToken : null,
      actorRole: req.user?.role || 'user'
    }
  };
}

function createPolicierCongoV3Router(runtime = getPolicierCongoV3()) {
  const router = express.Router();
  router.get('/status', authenticateToken, (_req, res) => res.json({ success: true, ...runtime.status() }));

  router.post('/turn', authenticateToken, async (req, res) => {
    try {
      const result = await runtime.run(eventFromRequest(req));
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(error.code === 'PC3_DISABLED' ? 503 : 500).json({ success: false, error: error.message, code: error.code || 'PC3_RUN_FAILED' });
    }
  });

  router.post('/turn/stream', authenticateToken, async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      const result = await runtime.run(eventFromRequest(req), { signal: controller.signal, onEvent: update => send(update.type || 'update', update) });
      send('done', result); res.end();
    } catch (error) {
      send('error', { error: error.message, code: error.code || 'PC3_RUN_FAILED' }); res.end();
    }
  });

  router.post('/scheduler/tick', authenticateToken, requireAdminRole, async (_req, res) => {
    try { res.json({ success: true, ...(await runtime.scheduler.runDueOnce()) }); }
    catch (error) { res.status(500).json({ success: false, error: error.message }); }
  });
  // Maintenance mémoire : vectorisation des souvenirs antérieurs à la mémoire
  // sémantique, puis purge des souvenirs sans valeur durable.
  router.post('/memory/maintenance', authenticateToken, requireAdminRole, async (req, res) => {
    try {
      await runtime.initialize();
      const backfill = await runtime.memory.backfillEmbeddings({
        batchSize: Math.min(Number(req.body?.batch_size) || 50, 200),
        maxBatches: Math.min(Number(req.body?.max_batches) || 100, 1000)
      });
      const consolidation = await runtime.memory.consolidate({ maxAgeDays: Number(req.body?.max_age_days) || 120 });
      res.json({ success: true, backfill, consolidation });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
  });

  router.delete('/memories/:memoryId', authenticateToken, requireAdminRole, async (req, res) => {
    try {
      await runtime.initialize();
      const forgotten = await runtime.memory.forgetMemory(req.params.memoryId, req.body?.reason || 'admin');
      if (!forgotten) return res.status(404).json({ success: false, error: 'Souvenir introuvable ou déjà oublié' });
      res.json({ success: true, memory: forgotten });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
  });

  router.get('/threads/:threadId/memories', authenticateToken, requireAdminRole, async (req, res) => {
    try {
      await runtime.initialize();
      const memories = await runtime.memory.listMemories({ userId: req.query.user_id || null, threadId: req.params.threadId, limit: Math.min(Number(req.query.limit || 100), 500) });
      res.json({ success: true, memories });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
  });
  return router;
}

module.exports = createPolicierCongoV3Router();
module.exports.createPolicierCongoV3Router = createPolicierCongoV3Router;
module.exports.eventFromRequest = eventFromRequest;
