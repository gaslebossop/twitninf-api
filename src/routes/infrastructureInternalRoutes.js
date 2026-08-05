'use strict';

const crypto = require('crypto');
const express = require('express');
const { collectNodeMetrics } = require('../services/infrastructureMetricsService');

const router = express.Router();

function secretMatches(received) {
  const expected = String(process.env.INTERNAL_SECRET || '');
  const candidate = String(received || '');
  if (!expected || expected.length !== candidate.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

router.use((req, res, next) => {
  if (!secretMatches(req.get('x-internal-secret'))) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  next();
});

router.get('/node', async (_req, res) => {
  try {
    return res.json({ success: true, node: await collectNodeMetrics() });
  } catch (error) {
    return res.status(503).json({ success: false, message: 'Metriques indisponibles', detail: error.message });
  }
});

module.exports = router;
