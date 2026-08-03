'use strict';

/**
 * Notation d'une ressemblance de compte.
 *
 * Une alerte d'usurpation est adressée à quelqu'un qui va peut-être signaler
 * un innocent : le score doit rester exigeant sur le bruit (homonymes,
 * avatars vides) et franc sur les vraies imitations (le `1` mis à la place du
 * `l`, la photo recopiée).
 */

jest.mock('../../models', () => ({
  User: {
    count: jest.fn(),
    findAll: jest.fn(),
  },
  ImpersonationAlert: {},
  Notification: {},
}));
jest.mock('../../database/index', () => ({ sequelize: { query: jest.fn() } }));

const {
  evaluate,
  findSuspects,
  similarity,
  normalizeLookalike,
} = require('../impersonationWatchService');
const { User } = require('../../models');
const {
  IMPERSONATION_SIMILARITY_THRESHOLD,
} = require('../../constants/premiumMarket');

const target = {
  username: 'gaslebossop',
  full_name: 'Gas',
  avatar: '/storage/avatars/gas.jpg',
  bio: 'Créateur de twitninf, tous les jours en ligne.',
};

describe('normalizeLookalike', () => {
  test('ramène les substitutions typographiques classiques à la même forme', () => {
    expect(normalizeLookalike('gas1eboss0p')).toBe(normalizeLookalike('gaslebossop'));
    expect(normalizeLookalike('Ga5_le.bossop')).toBe(normalizeLookalike('gaslebossop'));
  });

  test('deux pseudos réellement différents ne se confondent pas', () => {
    expect(normalizeLookalike('marie')).not.toBe(normalizeLookalike('julien'));
  });
});

describe('similarity', () => {
  test('vaut 1 pour deux chaînes identiques, à la casse près', () => {
    expect(similarity('Gas', 'gas')).toBe(1);
  });

  test('tombe à 0 quand une des deux est vide', () => {
    expect(similarity('gas', '')).toBe(0);
  });
});

describe('evaluate', () => {
  test('le `1` à la place du `l` déclenche au maximum', () => {
    const { score, reasons } = evaluate(target, {
      username: 'gas1ebossop',
      full_name: null,
      avatar: null,
      bio: null,
    });
    expect(reasons).toContain('username_lookalike');
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  test('un pseudo sans rapport ne déclenche rien', () => {
    const { score, reasons } = evaluate(target, {
      username: 'julienmartin',
      full_name: null,
      avatar: null,
      bio: null,
    });
    expect(reasons).toHaveLength(0);
    expect(score).toBe(0);
  });

  test('un pseudo qui reprend toute l\'identité avec un suffixe est détecté', () => {
    const { score, reasons } = evaluate(
      { ...target, username: 'policiercongo' },
      { username: 'policiercongolevrai', full_name: null, avatar: null, bio: null },
    );
    expect(reasons).toContain('username_similar');
    expect(score).toBeGreaterThanOrEqual(IMPERSONATION_SIMILARITY_THRESHOLD);
  });

  test('deux comptes sans photo ne se ressemblent pas — ils sont vides', () => {
    const { reasons } = evaluate(
      { ...target, avatar: null },
      { username: 'julienmartin', full_name: null, avatar: null, bio: null },
    );
    expect(reasons).not.toContain('same_avatar');
  });

  test('la même photo renforce un pseudo déjà proche', () => {
    const withoutAvatar = evaluate(target, {
      username: 'gaslebossup',
      full_name: null,
      avatar: null,
      bio: null,
    });
    const withAvatar = evaluate(target, {
      username: 'gaslebossup',
      full_name: null,
      avatar: target.avatar,
      bio: null,
    });
    expect(withAvatar.score).toBeGreaterThan(withoutAvatar.score);
    expect(withAvatar.reasons).toContain('same_avatar');
  });

  test('le nom affiché identique SEUL ne suffit pas à accuser un homonyme', () => {
    const { score, reasons } = evaluate(target, {
      username: 'julienmartin',
      full_name: 'Gas',
      avatar: null,
      bio: null,
    });
    expect(reasons).not.toContain('same_display_name');
    expect(score).toBeLessThan(IMPERSONATION_SIMILARITY_THRESHOLD);
  });

  test('une bio trop courte ne compte pas, même recopiée à l\'identique', () => {
    const { reasons } = evaluate(
      { ...target, bio: 'Salut' },
      { username: 'gaslebossup', full_name: null, avatar: null, bio: 'Salut' },
    );
    expect(reasons).not.toContain('same_bio');
  });

  test('le score ne dépasse jamais 1, même avec tous les signaux', () => {
    const { score, reasons } = evaluate(target, {
      username: 'gas1eboss0p',
      full_name: 'Gas',
      avatar: target.avatar,
      bio: target.bio,
    });
    expect(reasons).toEqual(expect.arrayContaining([
      'username_lookalike', 'same_avatar', 'same_bio', 'same_display_name',
    ]));
    expect(score).toBe(1);
  });
});

describe('findSuspects', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('un avatar de masse ne remplit plus le lot avant les pseudos proches', async () => {
    User.count.mockResolvedValue(3300);
    User.findAll
      .mockResolvedValueOnce([{ id: 'copy', username: 'gasleboss0p' }])
      .mockResolvedValueOnce([{ id: 'recent', username: 'autrecompte' }])
      .mockResolvedValueOnce([{ id: 'copy', username: 'gasleboss0p' }]);

    const rows = await findSuspects({ id: 'target', ...target });

    expect(rows.map((row) => row.id)).toEqual(['copy', 'recent']);
    expect(User.findAll).toHaveBeenCalledTimes(3);
    expect(User.findAll.mock.calls.some(([options]) => options.where.avatar === target.avatar)).toBe(false);
    User.findAll.mock.calls.forEach(([options]) => {
      expect(options.where.is_data_test).toBe(false);
    });
  });

  test('un avatar rare garde sa recherche dédiée', async () => {
    User.count.mockResolvedValue(2);
    User.findAll.mockResolvedValue([]);

    await findSuspects({ id: 'target', ...target });

    expect(User.findAll.mock.calls.some(([options]) => options.where.avatar === target.avatar)).toBe(true);
  });
});
