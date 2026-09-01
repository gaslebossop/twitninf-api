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
  sequelize: { QueryTypes: { SELECT: 'SELECT' } },
}));
jest.mock('../../database/readReplica', () => ({
  queryRead: mockQuery,
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

/* ══════════════════════════════════════════════════════════════════════════
   Les trois trous qui laissaient passer des comptes usurpés
   ══════════════════════════════════════════════════════════════════════════ */

describe('photo comparée au CONTENU, plus à l\'URL', () => {
  // Une empreinte : 16 caractères hexadécimaux.
  const print = (hex, color) => ({ dhash: hex, ahash: hex, color });
  const IDENTIQUE = 'a1b2c3d4e5f60718';
  // Un seul bit change : c'est l'ordre de grandeur mesuré sur de vrais
  // avatars après un redimensionnement en 96 px et une recompression JPEG 55.
  const RETAILLE  = 'a1b2c3d4e5f60719';
  const AUTRE     = '0f0f0f0f0f0f0f0f';

  test('la même photo réuploadée est détectée, malgré des URL différentes', () => {
    // LE bug d'origine : un upload nomme le fichier
    // `<uuid-de-l-uploadeur>-<horodatage>-<aléa>.jpg`, donc deux comptes ont
    // TOUJOURS des URL différentes pour une image identique. L'égalité d'URL
    // ne pouvait structurellement jamais se déclencher.
    const withPrint = evaluate(
      { ...target, _fingerprint: print(IDENTIQUE) },
      {
        username: 'compte-sans-rapport-2026',
        full_name: 'Autre Personne',
        avatar: '/storage/avatars/AUTRE-URL-1785.jpg',
        bio: null,
        _fingerprint: print(IDENTIQUE),
      },
    );
    expect(withPrint.reasons).toContain('same_avatar');
    expect(withPrint.metrics.same_avatar_by).toBe('pixels');
  });

  test('un redimensionnement + recompression reste la même photo', () => {
    const result = evaluate(
      { ...target, _fingerprint: print(IDENTIQUE) },
      {
        username: 'gasIebossop',
        full_name: 'Gas',
        avatar: '/storage/avatars/autre.jpg',
        bio: null,
        _fingerprint: print(RETAILLE),
      },
    );
    expect(result.reasons).toContain('same_avatar');
  });

  test('deux photos différentes ne déclenchent rien', () => {
    const result = evaluate(
      { ...target, _fingerprint: print(IDENTIQUE) },
      {
        username: 'quelquun-dautre',
        full_name: 'Quelqu un D autre',
        avatar: '/storage/avatars/x.jpg',
        bio: null,
        _fingerprint: print(AUTRE),
      },
    );
    expect(result.reasons).not.toContain('same_avatar');
  });

  test('le recadrage ne suffit JAMAIS seul à accuser', () => {
    // La signature couleur tolère le recadrage mais sépare mal : deux avatars
    // sans rapport atteignent 0,943 de similarité. Employée seule, elle
    // désignerait des inconnus.
    const color = new Array(64).fill(1 / 64);
    const result = evaluate(
      { ...target, _fingerprint: print(IDENTIQUE, color) },
      {
        username: 'aucun-rapport-du-tout',
        full_name: 'Sans Rapport Aucun',
        avatar: '/storage/avatars/y.jpg',
        bio: null,
        _fingerprint: print(AUTRE, color),
      },
    );
    // Le nom affiché distinctif ouvre une raison, donc le recadrage peut la
    // renforcer — mais il ne doit jamais porter l'accusation à lui seul.
    expect(result.score).toBeLessThan(0.72);
  });
});

describe('contenu publié recopié', () => {
  test('recopier les tweets est un signal fort, mais pas une usurpation à lui seul', () => {
    // Aucun signal ne regardait ce qui est PUBLIÉ : un compte pouvait
    // republier mot pour mot et rester invisible.
    //
    // Mais recopier des textes sous un autre nom, une autre photo et un autre
    // pseudo, c'est du vol de contenu — pas une usurpation d'IDENTITÉ, et
    // cette veille-ci accuse quelqu'un de se faire passer pour vous. Le signal
    // pèse donc lourd sans franchir le seuil seul.
    const result = evaluate(target, {
      username: 'un-pseudo-sans-lien',
      full_name: 'Nom Different Ici',
      avatar: null,
      bio: null,
      _contentSimilarity: 0.92,
    });
    expect(result.reasons).toContain('copied_tweets');
    expect(result.score).toBeLessThan(IMPERSONATION_SIMILARITY_THRESHOLD);
  });

  test('tweets recopiés + nom repris franchissent le seuil', () => {
    // Le couple est ce qui distingue l'usurpation du plagiat : reprendre
    // l'identité ET la parole.
    const result = evaluate(
      { ...target, full_name: 'Kospor et Caramel' },
      {
        username: 'un-pseudo-sans-lien',
        full_name: 'Kospor et Caramel',
        avatar: null,
        bio: null,
        _contentSimilarity: 0.92,
      },
    );
    expect(result.reasons).toEqual(expect.arrayContaining(['copied_tweets', 'same_display_name']));
    expect(result.score).toBeGreaterThanOrEqual(IMPERSONATION_SIMILARITY_THRESHOLD);
  });

  test('quelques phrases banales en commun ne suffisent pas', () => {
    const result = evaluate(target, {
      username: 'un-pseudo-sans-lien',
      full_name: 'Nom Different Ici',
      avatar: null,
      bio: null,
      _contentSimilarity: 0.3,
    });
    expect(result.reasons).not.toContain('copied_tweets');
  });

  test('photo reprise ET tweets recopiés ne laissent aucune lecture innocente', () => {
    const p = { dhash: 'a1b2c3d4e5f60718', ahash: 'a1b2c3d4e5f60718' };
    const result = evaluate(
      { ...target, _fingerprint: p },
      {
        username: 'nimporte-quoi',
        full_name: 'Nom Different',
        avatar: '/storage/avatars/z.jpg',
        bio: null,
        _fingerprint: p,
        _contentSimilarity: 0.9,
      },
    );
    expect(result.score).toBeGreaterThanOrEqual(0.95);
  });
});

describe('nom affiché seul', () => {
  test('un nom distinctif copié compte, même sans autre signal', () => {
    // Le nom affiché ne pesait QUE s'il accompagnait déjà autre chose. Un
    // compte reprenant « Kospor et Caramel » sous un pseudo sans ressemblance
    // marquait donc zéro — alors que c'est le nom, pas le pseudo, que lisent
    // les gens dans le fil.
    const result = evaluate(
      { ...target, full_name: 'Kospor et Caramel' },
      {
        username: 'aucun-rapport-2026',
        full_name: 'Kospor et Caramel',
        avatar: null,
        bio: null,
      },
    );
    expect(result.reasons).toContain('same_display_name');
  });

  test('un nom court reste partagé par des milliers de gens', () => {
    const result = evaluate(
      { ...target, full_name: 'Leo' },
      { username: 'aucun-rapport-2026', full_name: 'Leo', avatar: null, bio: null },
    );
    expect(result.reasons).not.toContain('same_display_name');
  });
});

describe('croisement des champs', () => {
  // Le cas reel qui passait a travers : un compte nomme `fanfanpolicier`
  // portait « policiercong » comme NOM AFFICHE — a une lettre du PSEUDO de sa
  // cible, `policiercongo`. Tout etait compare champ a champ, donc rien ne
  // pouvait le voir : son pseudo ne ressemble pas au pseudo, son nom ne
  // ressemble pas au nom.
  const officiel = {
    username: 'policiercongo',
    full_name: 'Congo',
    avatar: null,
    bio: 'Je traîne ici surtout la nuit.',
  };

  test('un nom affiché qui copie le PSEUDO de la cible est détecté', () => {
    const result = evaluate(officiel, {
      username: 'fanfanpolicier',
      full_name: 'policiercong',
      avatar: null,
      bio: null,
    });
    expect(result.reasons).toContain('cross_field_copy');
    expect(result.score).toBeGreaterThanOrEqual(IMPERSONATION_SIMILARITY_THRESHOLD);
  });

  test('contenir le pseudo ne suffit pas — un fan-club n\'usurpe personne', () => {
    // « policiercongo fan club » contient le pseudo sans se faire passer pour
    // lui. La contenance seule doit rester un indice, jamais une accusation.
    const result = evaluate(officiel, {
      username: 'clubdesfans2026',
      full_name: 'policiercongo fan club',
      avatar: null,
      bio: null,
    });
    expect(result.score).toBeLessThan(IMPERSONATION_SIMILARITY_THRESHOLD);
  });

  test('deux pseudos courts qui se ressemblent ne croisent rien', () => {
    // Sous 6 caractères, le squelette de trop de mots se confond.
    const result = evaluate(
      { username: 'leo', full_name: 'Leo', avatar: null, bio: null },
      { username: 'leon', full_name: 'leo', avatar: null, bio: null },
    );
    expect(result.reasons).not.toContain('cross_field_copy');
  });
});

describe('bio qui revendique l\'identité', () => {
  test('« officiel compte de <cible> » est une revendication explicite', () => {
    // Le seul signal du lot où l'auteur écrit noir sur blanc ce qu'il fait —
    // et il ne coûtait rien à lire.
    const result = evaluate(
      { username: 'policiercongo', full_name: 'Congo', avatar: null, bio: 'La nuit.' },
      {
        username: 'compte-neutre-2026',
        full_name: 'Un Nom Quelconque',
        avatar: null,
        bio: 'officiel compte de policiercongo',
      },
    );
    expect(result.reasons).toContain('bio_claims_identity');
  });

  test('citer quelqu\'un sans revendiquer son identité ne déclenche rien', () => {
    const result = evaluate(
      { username: 'policiercongo', full_name: 'Congo', avatar: null, bio: 'La nuit.' },
      {
        username: 'compte-neutre-2026',
        full_name: 'Un Nom Quelconque',
        avatar: null,
        bio: 'je discute souvent avec policiercongo, sympa',
      },
    );
    expect(result.reasons).not.toContain('bio_claims_identity');
  });
});
