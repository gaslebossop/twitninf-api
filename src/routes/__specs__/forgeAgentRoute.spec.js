const assert = require('node:assert');

/**
 * L'accès agent en lecture seule.
 *
 * Cette route existe pour qu'une routine planifiée n'ait PAS besoin d'un
 * jeton staff — lequel ouvre le versement de NF. Tout son intérêt tient donc
 * à trois propriétés, et ce fichier ne teste qu'elles :
 *
 *   1. sans secret configuré, la route n'existe pas (fermée par défaut) ;
 *   2. un mauvais jeton n'entre pas ;
 *   3. ce qui sort ne contient RIEN d'exploitable au-delà d'une liste d'idées.
 */

const SECRET = 'x'.repeat(48);

jest.mock('../../models', () => ({
  sequelize: {},
  User: {},
  FeatureProposal: { findByPk: jest.fn() },
}));
jest.mock('../../middleware/authMiddleware', () => ({
  authenticateToken: (req, res, next) => next(),
}));
jest.mock('../../utils/logger', () => ({ info: () => {}, warn: () => {}, error: () => {} }));
jest.mock('../../economy/platformCurrency', () => ({
  getPlatformCurrency: jest.fn(async () => ({ currentPrice: 1.5 })),
}));
jest.mock('../../services/featureProposalService', () => ({
  MAX_OPEN_PER_AUTHOR: 3,
  listQueue: jest.fn(async () => [
    {
      id: 'idee-1',
      title: 'Des sondages',
      body: 'pour augmenter les interactions',
      area: 'feed',
      status: 'accepted',
      reward_nf: 500,
      staff_note: 'note interne du staff',
      created_at: '2026-08-15T00:00:00Z',
      author: { id: 'user-secret-id', username: 'gas', avatar: null },
    },
  ]),
  decide: jest.fn(async (models, sequelize, staffId, id, { status, rewardNf, note }) => ({
    success: true,
    proposal: { id, status, reward_nf: rewardNf, staff_note: note },
  })),
}));

const request = require('supertest');
const express = require('express');

function appWith(secret) {
  if (secret === null) delete process.env.FORGE_AGENT_TOKEN;
  else process.env.FORGE_AGENT_TOKEN = secret;
  jest.resetModules();
  const routes = require('../featureProposalRoutes');
  const app = express();
  app.use('/api/forge', routes);
  return app;
}

test('sans secret configuré, la route n existe pas', async () => {
  const res = await request(appWith(null)).get('/api/forge/agent/accepted');
  // 404 et non 401 : une route fermée ne doit pas confirmer qu'elle existe.
  assert.strictEqual(res.status, 404);
});

test('un secret trop court est traité comme absent', async () => {
  const res = await request(appWith('trop-court')).get('/api/forge/agent/accepted');
  assert.strictEqual(res.status, 404);
});

test('un mauvais jeton est refusé', async () => {
  const res = await request(appWith(SECRET))
    .get('/api/forge/agent/accepted')
    .set('Authorization', `Bearer ${'y'.repeat(48)}`);
  assert.strictEqual(res.status, 401);
});

test('sans en-tête, refusé', async () => {
  const res = await request(appWith(SECRET)).get('/api/forge/agent/accepted');
  assert.strictEqual(res.status, 401);
});

test('le bon jeton lit les idées, et RIEN d autre', async () => {
  const res = await request(appWith(SECRET))
    .get('/api/forge/agent/accepted')
    .set('Authorization', `Bearer ${SECRET}`);

  assert.strictEqual(res.status, 200);
  const [p] = res.body.proposals;
  assert.strictEqual(p.title, 'Des sondages');
  assert.strictEqual(p.author, 'gas');

  /*
   * Le coeur du test : la surface exposée.
   *
   * Le service rend bien plus que ça (identifiant d'auteur, note interne du
   * staff, montant décidé). Si quelqu'un « simplifie » un jour en renvoyant
   * la ligne entière, ce test tombe — et c'est exactement le but, parce que
   * ce secret vit en clair dans la configuration d'une tâche planifiée.
   */
  assert.strictEqual(p.staff_note, undefined, 'la note du staff ne sort pas');
  assert.strictEqual(p.reward_nf, undefined, 'le montant ne sort pas');
  assert.strictEqual(p.status, undefined, 'le statut interne ne sort pas');
  assert.strictEqual(typeof p.author, 'string', 'seul le pseudo sort, pas l objet auteur');
});

/*
 * ── Clôture par l'agent : le plafond est réellement appliqué ─────────────
 *
 * Le test qui compte ici n'est pas « ça répond 200 » mais « quoi que l'agent
 * envoie, le serveur ne transmet jamais plus que le plafond à `forge.decide`
 * ». Un test qui n'enverrait pas un montant au-dessus du plafond ne
 * prouverait rien.
 */
describe('POST /agent/proposals/:id/complete', () => {
  test('sans jeton, refusé', async () => {
    const res = await request(appWith(SECRET)).post('/api/forge/agent/proposals/idee-1/complete');
    assert.strictEqual(res.status, 401);
  });

  test('idée introuvable -> 404', async () => {
    const app = appWith(SECRET);
    const { FeatureProposal } = require('../../models');
    FeatureProposal.findByPk.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/forge/agent/proposals/absente/complete')
      .set('Authorization', `Bearer ${SECRET}`);
    assert.strictEqual(res.status, 404);
  });

  test("idée pas en 'accepted' -> 409, aucun versement", async () => {
    const app = appWith(SECRET);
    const { FeatureProposal } = require('../../models');
    const forgeService = require('../../services/featureProposalService');
    FeatureProposal.findByPk.mockResolvedValueOnce({ id: 'idee-1', status: 'received' });

    const res = await request(app)
      .post('/api/forge/agent/proposals/idee-1/complete')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ reward_nf: 30 });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(forgeService.decide.mock.calls.length, 0);
  });

  test('un montant au-dessus du plafond est écrasé, pas juste refusé', async () => {
    const app = appWith(SECRET);
    const { FeatureProposal } = require('../../models');
    const forgeService = require('../../services/featureProposalService');
    FeatureProposal.findByPk.mockResolvedValueOnce({ id: 'idee-1', status: 'accepted' });

    const res = await request(app)
      .post('/api/forge/agent/proposals/idee-1/complete')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ reward_nf: 999999, note: 'Construit, cf branche feature/x' });

    assert.strictEqual(res.status, 200);
    const [, , staffId, id, decision] = forgeService.decide.mock.calls[0];
    assert.strictEqual(staffId, null, 'pas de staff derrière une décision agent');
    assert.strictEqual(id, 'idee-1');
    assert.strictEqual(decision.status, 'built');
    assert.ok(decision.rewardNf <= 50, `plafond dépassé: ${decision.rewardNf}`);
  });
});
