const assert = require('node:assert');

/**
 * Le staff qui retient une idée doit déclencher UNE issue GitHub, pas zéro
 * ni plusieurs. Zéro: la routine n'apprend jamais qu'une idée est prête (le
 * cron de secours rattrape, mais avec jusqu'à une heure de retard). Plusieurs:
 * un simple ré-enregistrement d'une idée déjà "accepted" (note corrigée,
 * etc.) ouvrirait une nouvelle issue à chaque fois.
 */

jest.mock('../../middleware/authMiddleware', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 'staff-1' };
    next();
  },
}));
jest.mock('../../utils/logger', () => ({ info: () => {}, warn: () => {}, error: () => {} }));
jest.mock('../../economy/platformCurrency', () => ({
  getPlatformCurrency: jest.fn(async () => ({ currentPrice: 1 })),
}));
jest.mock('../../services/forgeGithubIssue', () => ({
  createAgentTaskIssue: jest.fn(async () => ({ number: 42 })),
}));
jest.mock('../../models', () => ({
  sequelize: {},
  User: { findByPk: jest.fn(async () => ({ id: 'staff-1', role: 'admin' })) },
  FeatureProposal: { findByPk: jest.fn() },
}));
jest.mock('../../services/featureProposalService', () => ({
  MAX_OPEN_PER_AUTHOR: 3,
  listQueue: jest.fn(async () => []),
  decide: jest.fn(async (models, sequelize, staffId, id, { status, rewardNf, note }) => ({
    success: true,
    proposal: { id, title: 'Des sondages', body: 'x'.repeat(40), area: 'feed', status, reward_nf: rewardNf, staff_note: note },
  })),
}));

const request = require('supertest');
const express = require('express');

function app() {
  jest.resetModules();
  const routes = require('../featureProposalRoutes');
  const a = express();
  a.use(express.json());
  a.use('/api/forge', routes);
  return a;
}

test('passage à "accepted" déclenche la création de l’issue', async () => {
  const a = app();
  const { FeatureProposal } = require('../../models');
  const { createAgentTaskIssue } = require('../../services/forgeGithubIssue');
  FeatureProposal.findByPk.mockResolvedValueOnce({ status: 'reviewing' });

  await request(a).patch('/api/forge/proposals/idee-1').send({ status: 'accepted' });

  await new Promise((r) => setImmediate(r));
  assert.strictEqual(createAgentTaskIssue.mock.calls.length, 1);
});

test('déjà "accepted" -> ré-enregistrer ne recrée pas d’issue', async () => {
  const a = app();
  const { FeatureProposal } = require('../../models');
  const { createAgentTaskIssue } = require('../../services/forgeGithubIssue');
  FeatureProposal.findByPk.mockResolvedValueOnce({ status: 'accepted' });

  await request(a).patch('/api/forge/proposals/idee-1').send({ status: 'accepted', note: 'précision' });

  await new Promise((r) => setImmediate(r));
  assert.strictEqual(createAgentTaskIssue.mock.calls.length, 0);
});

test('décision "declined" ne crée pas d’issue', async () => {
  const a = app();
  const { FeatureProposal } = require('../../models');
  const { createAgentTaskIssue } = require('../../services/forgeGithubIssue');
  FeatureProposal.findByPk.mockResolvedValueOnce({ status: 'received' });

  await request(a).patch('/api/forge/proposals/idee-1').send({ status: 'declined', note: 'non retenue' });

  await new Promise((r) => setImmediate(r));
  assert.strictEqual(createAgentTaskIssue.mock.calls.length, 0);
});
