'use strict';

/**
 * Notation d'une ressemblance de compte.
 *
 * Une alerte d'usurpation est adressée à quelqu'un qui va peut-être signaler
 * un innocent : le score doit rester exigeant sur le bruit (homonymes,
 * avatars vides) et franc sur les vraies imitations (le `1` mis à la place du
 * `l`, la photo recopiée).
 */

const mockQuery = jest.fn();

jest.mock('../../models', () => ({
  User: {
    count: jest.fn(),
  },
  ImpersonationAlert: {},
  Notification: {},
}));
jest.mock('../../database/index', () => ({
  sequelize: { query: mockQuery, QueryTypes: { SELECT: 'SELECT' } },
}));

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

  test('neutralise les homoglyphes Unicode cyrilliques et pleine largeur', () => {
    expect(normalizeLookalike('pоliciercоngо')).toBe(normalizeLookalike('policiercongo'));
    expect(normalizeLookalike('Ｐｏｌｉｃｉｅｒ')).toBe(normalizeLookalike('policier'));
  });

  test('retire les caractères invisibles utilisés pour masquer une copie', () => {
    expect(normalizeLookalike('poli\u200bciercongo')).toBe(normalizeLookalike('policiercongo'));
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

  test('un préfixe support ou officiel autour du pseudo est détecté', () => {
    const result = evaluate(
      { ...target, username: 'policiercongo' },
      { username: 'supportpoliciercongo', full_name: null, avatar: null, bio: null },
    );
    expect(result.reasons).toContain('username_similar');
    expect(result.score).toBeGreaterThanOrEqual(0.85);
  });

  test('un affixe d\'usurpation plus une faute locale reste détecté', () => {
    const result = evaluate(
      { ...target, username: 'policiercongo' },
      {
        username: 'le_vrai_policier__kOngO',
        full_name: 'le_vrai_policier__kOngO',
        avatar: 'https://cdn.test/default-avatar.png',
        bio: 'le vrai policier c\'est moi je suis le compte officiel',
        _sharedAvatarDistinctive: false,
      },
    );
    expect(result.reasons).toContain('username_similar');
    expect(result.score).toBeGreaterThanOrEqual(0.9);
  });

  test('une transposition adjacente reste une imitation forte', () => {
    const result = evaluate(
      { ...target, username: 'policiercongo' },
      { username: 'polciercongo', full_name: null, avatar: null, bio: null },
    );
    expect(result.reasons).toContain('username_similar');
    expect(result.score).toBeGreaterThanOrEqual(IMPERSONATION_SIMILARITY_THRESHOLD);
  });

  test('un homoglyphe cyrillique déclenche comme un lookalike', () => {
    const result = evaluate(
      { ...target, username: 'policiercongo' },
      { username: 'pоliciercongo', full_name: null, avatar: null, bio: null },
    );
    expect(result.reasons).toContain('username_lookalike');
    expect(result.score).toBeGreaterThanOrEqual(0.9);
  });

  test('une simple inclusion lexicale sans affixe d\'usurpation reste sous le seuil', () => {
    const result = evaluate(
      { ...target, username: 'marion', full_name: null, avatar: null, bio: null },
      { username: 'marionnette', full_name: null, avatar: null, bio: null },
    );
    expect(result.score).toBeLessThan(IMPERSONATION_SIMILARITY_THRESHOLD);
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

  test('photo distinctive, nom et bio copiés détectent un clone au pseudo différent', () => {
    const result = evaluate(target, {
      username: 'serviceclient2026',
      full_name: target.full_name,
      avatar: target.avatar,
      bio: target.bio,
      _sharedAvatarDistinctive: true,
    });
    expect(result.reasons).toEqual(expect.arrayContaining([
      'same_avatar', 'same_bio', 'same_display_name',
    ]));
    expect(result.score).toBeGreaterThanOrEqual(0.9);
  });

  test('un avatar par défaut partagé ne renforce jamais le score', () => {
    const avatar = 'https://cdn.test/default-avatar.png';
    const result = evaluate(
      { ...target, avatar },
      {
        username: 'julienmartin', full_name: null, avatar, bio: null,
        _sharedAvatarDistinctive: false,
      },
    );
    expect(result.reasons).not.toContain('same_avatar');
    expect(result.score).toBe(0);
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
    mockQuery.mockResolvedValue([]);
  });

  test('un avatar de masse ne participe pas à la présélection', async () => {
    User.count.mockResolvedValue(3300);
    mockQuery.mockResolvedValue([{ id: 'copy', username: 'gasleboss0p' }]);

    const rows = await findSuspects({ id: 'target', ...target });
    const [sql, options] = mockQuery.mock.calls[0];

    expect(rows.map((row) => row.id)).toEqual(['copy']);
    expect(sql).toContain('COALESCE(is_data_test, false) = false');
    expect(sql).toContain('username_skeleton');
    expect(options.replacements.avatarDistinctive).toBe(false);
    expect(rows[0]._sharedAvatarDistinctive).toBe(false);
  });

  test('un avatar rare garde sa recherche dédiée', async () => {
    User.count.mockResolvedValue(2);

    await findSuspects({ id: 'target', ...target });

    expect(mockQuery.mock.calls[0][1].replacements.avatarDistinctive).toBe(true);
  });

  test('la requête cherche des fragments répartis et les homoglyphes sans fallback LIMIT 200', async () => {
    User.count.mockResolvedValue(1);

    await findSuspects({ id: 'target', ...target });
    const [sql, options] = mockQuery.mock.calls[0];

    expect(sql).toContain('translate(lower');
    expect(sql).toContain('(username_skeleton LIKE :fragmentA)::int');
    expect(sql).toContain('LIMIT 400');
    expect(options.replacements.confusableFrom).toContain('о');
    expect(options.replacements.targetSkeleton).toBe('gaslebossop');
  });
});
