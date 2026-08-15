const assert = require('node:assert');

/**
 * La Forge — ce qui doit rester vrai quoi qu'il arrive au reste du fichier.
 *
 * Le service est en grande partie du CRUD, et le CRUD n'a pas besoin d'être
 * garde. Une seule chose ici peut coûter de l'argent réel : **le versement de
 * la récompense**. Ces tests portent donc sur lui, et sur les deux façons de
 * payer deux fois — rejouer une décision déjà payée, et laisser le versement
 * survivre à l'échec de l'enregistrement.
 */

jest.mock('../../economy/ledger', () => ({
  rewardFromTreasury: jest.fn(async () => ({ success: true })),
}));
jest.mock('../../economy/platformCurrency', () => ({
  getPlatformCurrency: jest.fn(async () => ({ id: 'devise-nf' })),
}));
jest.mock('../../utils/logger', () => ({ info: () => {}, warn: () => {}, error: () => {} }));

const EconomyLedger = require('../../economy/ledger');
const forge = require('../featureProposalService');

/** Une ligne de proposition qui se comporte comme une instance Sequelize. */
function fakeRow(overrides = {}) {
  return {
    id: 'idee-1',
    author_id: 'user-1',
    title: 'Des sondages dans les tweets',
    status: 'accepted',
    reward_nf: 500,
    reward_paid_at: null,
    staff_note: null,
    decided_by: null,
    decided_at: null,
    created_at: new Date(),
    saved: false,
    async save() {
      this.saved = true;
    },
    ...overrides,
  };
}

/** Faux modèles + faux `sequelize`. On n'observe que ce qui est demandé. */
function fakeWorld(row) {
  const calls = { findByPk: [], transaction: 0 };
  const models = {
    FeatureProposal: {
      findByPk: async (id, options) => {
        calls.findByPk.push({ id, options });
        return row;
      },
      count: async () => 0,
      create: async (values) => fakeRow(values),
      findAll: async () => [],
    },
    User: {},
  };
  const sequelize = {
    LOCK: { UPDATE: 'UPDATE' },
    transaction: async (fn) => {
      calls.transaction += 1;
      return fn({ LOCK: { UPDATE: 'UPDATE' }, id: 'tx-1' });
    },
  };
  return { models, sequelize, calls };
}

beforeEach(() => {
  EconomyLedger.rewardFromTreasury.mockClear();
  EconomyLedger.rewardFromTreasury.mockImplementation(async () => ({ success: true }));
});

test('une idée construite verse la récompense, une fois', async () => {
  const row = fakeRow();
  const { models, sequelize } = fakeWorld(row);

  const result = await forge.decide(models, sequelize, 'staff-1', 'idee-1', {
    status: 'built',
    rewardNf: 500,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(EconomyLedger.rewardFromTreasury.mock.calls.length, 1);

  const [userId, currencyId, amount, , tx] = EconomyLedger.rewardFromTreasury.mock.calls[0];
  assert.strictEqual(userId, 'user-1');
  assert.strictEqual(currencyId, 'devise-nf');
  assert.strictEqual(amount, 500);
  // Le mouvement doit porter la MÊME transaction que l'enregistrement : c'est
  // ce qui garantit qu'un plantage annule les deux ensemble. Un versement hors
  // transaction survivrait a un echec de `save`, et l'idée redeviendrait
  // payable.
  assert.ok(tx && tx.id === 'tx-1', 'le versement doit porter la transaction ouverte');
  assert.ok(row.reward_paid_at, 'la date de versement doit être posée');
  assert.strictEqual(row.saved, true);
});

test('une idée déjà payée n est JAMAIS repayée', async () => {
  const row = fakeRow({ reward_paid_at: new Date('2026-08-01') });
  const { models, sequelize } = fakeWorld(row);

  const result = await forge.decide(models, sequelize, 'staff-1', 'idee-1', {
    status: 'built',
    rewardNf: 500,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(
    EconomyLedger.rewardFromTreasury.mock.calls.length,
    0,
    'aucun mouvement ne doit partir pour une idée déjà horodatée'
  );
});

test('la ligne est relue avec un verrou : deux validations simultanées se sérialisent', async () => {
  const row = fakeRow();
  const { models, sequelize, calls } = fakeWorld(row);

  await forge.decide(models, sequelize, 'staff-1', 'idee-1', { status: 'built', rewardNf: 10 });

  assert.strictEqual(calls.transaction, 1);
  const [{ options }] = calls.findByPk;
  assert.strictEqual(options.lock, 'UPDATE', 'la relecture doit verrouiller la ligne');
  assert.ok(options.transaction, 'la relecture doit se faire dans la transaction');
});

test('un versement refusé par le grand livre ne pose pas la date de paiement', async () => {
  EconomyLedger.rewardFromTreasury.mockImplementation(async () => ({
    success: false,
    reason: 'Montant trop faible',
  }));
  const row = fakeRow({ reward_nf: 1 });
  const { models, sequelize } = fakeWorld(row);

  const result = await forge.decide(models, sequelize, 'staff-1', 'idee-1', {
    status: 'built',
    rewardNf: 1,
  });

  assert.strictEqual(result.success, false);
  // Sans ça on marquerait « payé » une idée que personne n'a payée, et plus
  // aucun rattrapage ne la retrouverait.
  assert.strictEqual(row.reward_paid_at, null);
});

test('un refus doit être motivé', async () => {
  const { models, sequelize } = fakeWorld(fakeRow());

  const result = await forge.decide(models, sequelize, 'staff-1', 'idee-1', {
    status: 'declined',
    note: '   ',
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'note_required');
  assert.strictEqual(EconomyLedger.rewardFromTreasury.mock.calls.length, 0);
});

test('les idées en cours sont plafonnées par auteur', async () => {
  const { models, sequelize } = fakeWorld(fakeRow());
  models.FeatureProposal.count = async () => forge.MAX_OPEN_PER_AUTHOR;

  const result = await forge.create(models, 'user-1', {
    title: 'Un titre assez long pour passer',
    body: 'Une description qui depasse largement les quarante caracteres exiges par le modele.',
    area: 'feed',
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'too_many_open');
  void sequelize;
});
