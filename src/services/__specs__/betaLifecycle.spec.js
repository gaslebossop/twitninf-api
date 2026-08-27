const assert = require('node:assert');

/**
 * Cycle de vie d'une candidature beta.
 *
 * Cinq statuts, et surtout : quelles transitions sont refusées. Une
 * transition manquante ne casse rien visiblement — elle laisse juste un
 * compte dans un état d'où il ne peut plus sortir, ce qui ne se voit qu'au
 * moment où quelqu'un s'en plaint.
 *
 * On y fixe aussi les deux règles que le libellé des routes ne dit pas :
 *   - la capacité borne l'APPROBATION, jamais la candidature ;
 *   - re-candidater renvoie en FIN de file, pas à sa place d'origine.
 */

jest.mock('../../utils/logger', () => ({ info: () => {}, warn: () => {}, error: () => {} }));
jest.mock('../featureFlagService', () => ({ invalidateUserContext: async () => {} }));

const mockMembers = new Map();
const mockSettings = { id: 1, is_open: true, capacity: null, headline: 'x', pitch: null };

function mockRow(userId, status, appliedAt) {
  const row = {
    user_id: userId,
    status,
    applied_at: appliedAt || new Date('2026-08-01T00:00:00Z'),
    approved_at: null,
    revoked_at: null,
    reviewed_at: null,
    reviewed_by: null,
    review_note: null,
    motivation: null,
    source: null,
    platform: null,
    app_version: null,
    async update(fields) {
      Object.assign(this, fields);
      return this;
    },
  };
  mockMembers.set(userId, row);
  return row;
}

jest.mock('../../models', () => ({
  sequelize: { query: async () => [] },
  User: {
    findByPk: async (id) => (id === 'connu' ? { id: 'connu' } : null),
    findOne: async ({ where }) => (where.username === 'gas' ? { id: 'connu' } : null),
  },
  BetaMember: {
    findByPk: async (id) => mockMembers.get(id) || null,
    findOne: async ({ where }) => {
      const row = mockMembers.get(where.user_id);
      return row && row.status === where.status ? row : null;
    },
    count: async ({ where }) => {
      let rows = [...mockMembers.values()].filter((m) => m.status === where.status);
      // Le seul opérateur utilisé par le service : `applied_at < X`. La borne
      // est sous une clé Symbol (`Op.lt`), qu'`Object.values` ne voit PAS —
      // s'en remettre à lui rendrait ce filtre silencieusement inopérant.
      if (where.applied_at) {
        const [op] = Object.getOwnPropertySymbols(where.applied_at);
        const bound = op ? where.applied_at[op] : null;
        if (bound) rows = rows.filter((m) => m.applied_at < bound);
      }
      return rows.length;
    },
    create: async (fields) => mockRow(fields.user_id, fields.status, fields.applied_at),
    findAndCountAll: async () => ({ rows: [], count: 0 }),
    findAll: async () => [],
  },
  BetaSettings: {
    load: async () => ({
      ...mockSettings,
      async update(fields) {
        Object.assign(mockSettings, fields);
        Object.assign(this, fields);
        return this;
      },
    }),
  },
}));

let beta;
beforeEach(() => {
  jest.resetModules();
  mockMembers.clear();
  mockSettings.is_open = true;
  mockSettings.capacity = null;
  beta = require('../betaService');
});

// ───────────────────────── Transitions ─────────────────────────

describe('transitions', () => {
  test('candidater depuis rien crée une ligne en attente', async () => {
    const member = await beta.apply('u1', { source: 'mobile' });
    assert.strictEqual(member.status, 'pending');
  });

  test('candidater deux fois de suite ne perd pas la place dans la file', async () => {
    const first = await beta.apply('u1', {});
    const appliedAt = first.applied_at;
    const second = await beta.apply('u1', {});
    assert.strictEqual(second.status, 'pending');
    assert.strictEqual(second.applied_at, appliedAt);
  });

  test('un membre qui recandidate est refusé', async () => {
    mockRow('u1', 'approved');
    await assert.rejects(() => beta.apply('u1', {}), /déjà membre/);
  });

  test.each(['rejected', 'revoked', 'left'])('on peut recandidater depuis %s', async (from) => {
    mockRow('u1', from);
    const member = await beta.apply('u1', {});
    assert.strictEqual(member.status, 'pending');
    // Les traces de la décision précédente sont effacées : sinon la console
    // afficherait « refusé le 12 août » à côté d'une candidature en attente.
    assert.strictEqual(member.reviewed_at, null);
    assert.strictEqual(member.approved_at, null);
  });

  test('approuver depuis pending donne un membre', async () => {
    mockRow('u1', 'pending');
    const member = await beta.approve('u1', 'admin-1');
    assert.strictEqual(member.status, 'approved');
    assert.ok(member.approved_at);
    assert.strictEqual(member.reviewed_by, 'admin-1');
  });

  test('approuver un membre déjà admis est sans effet, pas une erreur', async () => {
    mockRow('u1', 'approved');
    const member = await beta.approve('u1', 'admin-1');
    assert.strictEqual(member.status, 'approved');
  });

  test('refuser n’est possible que depuis pending', async () => {
    mockRow('u1', 'approved');
    await assert.rejects(() => beta.reject('u1', 'admin-1'), /en attente/);
  });

  test('révoquer n’est possible que sur un membre', async () => {
    mockRow('u1', 'pending');
    await assert.rejects(() => beta.revoke('u1', 'admin-1'), /pas membre/);
  });

  test('quitter n’est possible que pour un membre', async () => {
    mockRow('u1', 'pending');
    await assert.rejects(() => beta.leave('u1'), /pas membre/);
  });

  test('agir sur un compte sans candidature renvoie 404', async () => {
    await assert.rejects(
      () => beta.approve('fantome', 'admin-1'),
      (error) => error.status === 404
    );
  });
});

// ───────────────────────── Programme fermé ─────────────────────────

describe('programme fermé', () => {
  test('candidater est refusé', async () => {
    mockSettings.is_open = false;
    await assert.rejects(() => beta.apply('u1', {}), /fermées/);
  });

  test("mais les membres existants ne sont pas touchés", async () => {
    mockSettings.is_open = false;
    mockRow('u1', 'approved');
    const status = await beta.statusFor('u1');
    assert.strictEqual(status.is_member, true);
    assert.strictEqual(status.can_apply, false);
  });
});

// ───────────────────────── Capacité ─────────────────────────

describe('capacité', () => {
  test('approuver est refusé quand les places sont prises', async () => {
    mockSettings.capacity = 1;
    mockRow('deja', 'approved');
    mockRow('u1', 'pending');
    await assert.rejects(() => beta.approve('u1', 'admin-1'), /Capacité atteinte/);
  });

  test('« forcer » passe outre', async () => {
    mockSettings.capacity = 1;
    mockRow('deja', 'approved');
    mockRow('u1', 'pending');
    const member = await beta.approve('u1', 'admin-1', { force: true });
    assert.strictEqual(member.status, 'approved');
  });

  test('la capacité ne bloque PAS la candidature', async () => {
    mockSettings.capacity = 1;
    mockRow('deja', 'approved');
    const member = await beta.apply('u1', {});
    assert.strictEqual(member.status, 'pending');
  });

  test('la vitrine annonce les places restantes, jamais un nombre négatif', async () => {
    mockSettings.capacity = 1;
    mockRow('a', 'approved');
    mockRow('b', 'approved');
    const program = await beta.publicProgram();
    assert.strictEqual(program.seats_left, 0);
  });
});

// ───────────────────────── File d'attente ─────────────────────────

describe('file d’attente', () => {
  test('la position suit l’ordre des candidatures', async () => {
    mockRow('a', 'pending', new Date('2026-08-01T00:00:00Z'));
    mockRow('b', 'pending', new Date('2026-08-02T00:00:00Z'));
    mockRow('c', 'pending', new Date('2026-08-03T00:00:00Z'));

    assert.strictEqual((await beta.statusFor('a')).position, 1);
    assert.strictEqual((await beta.statusFor('b')).position, 2);
    assert.strictEqual((await beta.statusFor('c')).position, 3);
  });

  test('approuver le premier fait remonter les suivants', async () => {
    mockRow('a', 'pending', new Date('2026-08-01T00:00:00Z'));
    mockRow('b', 'pending', new Date('2026-08-02T00:00:00Z'));

    await beta.approve('a', 'admin-1');
    assert.strictEqual((await beta.statusFor('b')).position, 1);
  });

  test('un membre n’a pas de position', async () => {
    mockRow('a', 'approved');
    assert.strictEqual((await beta.statusFor('a')).position, null);
  });

  test('recandidater renvoie en fin de file', async () => {
    mockRow('a', 'pending', new Date('2026-08-01T00:00:00Z'));
    mockRow('b', 'rejected', new Date('2026-07-01T00:00:00Z'));

    await beta.apply('b', {});
    // `b` avait candidaté avant `a`, mais sa candidature COURANTE est postérieure.
    assert.strictEqual((await beta.statusFor('b')).position, 2);
  });
});

// ───────────────────────── Invitation directe ─────────────────────────

describe('invitation', () => {
  test('par pseudo, sans passer par la file', async () => {
    const member = await beta.invite({ username: 'gas' }, 'admin-1');
    assert.strictEqual(member.status, 'approved');
  });

  test('le @ initial est toléré', async () => {
    const member = await beta.invite({ username: '@gas' }, 'admin-1');
    assert.strictEqual(member.status, 'approved');
  });

  test('un compte inconnu renvoie 404', async () => {
    await assert.rejects(
      () => beta.invite({ username: 'personne' }, 'admin-1'),
      (error) => error.status === 404
    );
  });

  test('inviter un candidat en attente l’approuve, hors capacité', async () => {
    mockSettings.capacity = 0;
    mockRow('connu', 'pending');
    const member = await beta.invite({ user_id: 'connu' }, 'admin-1');
    assert.strictEqual(member.status, 'approved');
  });
});

// ───────────────────────── Vitrine publique ─────────────────────────

describe('vitrine publique', () => {
  test('ne contient aucune donnée nominative', async () => {
    mockRow('a', 'approved');
    mockRow('b', 'pending');
    const program = await beta.publicProgram();

    const keys = Object.keys(program).sort();
    assert.deepStrictEqual(keys, [
      'capacity',
      'headline',
      'is_open',
      'members',
      'pitch',
      'seats_left',
    ]);
    // Le décompte porte sur les membres, pas sur la file : annoncer la
    // taille de la file d'attente inviterait à la course.
    assert.strictEqual(program.members, 1);
  });

  test('sans capacité, seats_left vaut null et non zéro', async () => {
    const program = await beta.publicProgram();
    assert.strictEqual(program.capacity, null);
    assert.strictEqual(program.seats_left, null);
  });
});
